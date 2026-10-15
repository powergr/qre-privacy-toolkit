// --- START OF FILE vault.rs ---

use crate::bookmarks::BookmarksVault;
use crate::clipboard_store::ClipboardVault;
use crate::crypto;
use crate::keychain;
use crate::notes::NotesVault;
use crate::passwords::PasswordVault;
use crate::state::SessionState;
use data_encoding::BASE32_NOPAD;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use totp_rs::{Algorithm, Builder};

pub type CommandResult<T> = Result<T, String>;

// ==========================================
// --- LOGIN RATE LIMITING ---
// ==========================================

static LOGIN_FAIL_COUNT: AtomicU32 = AtomicU32::new(0);
static LOGIN_LAST_FAIL_SECS: AtomicU64 = AtomicU64::new(0);
static RECOVERY_FAIL_COUNT: AtomicU32 = AtomicU32::new(0);
static RECOVERY_LAST_FAIL_SECS: AtomicU64 = AtomicU64::new(0);
const MAX_ATTEMPTS_BEFORE_LOCKOUT: u32 = 5;

fn lockout_duration_secs(fail_count: u32) -> u64 {
    let extra = fail_count.saturating_sub(MAX_ATTEMPTS_BEFORE_LOCKOUT);
    30u64 * (1u64 << extra.min(4))
}

/// Seconds left on the lockout, or `None` if another attempt is allowed.
fn lockout_remaining_secs(fail_count: u32, last_fail_secs: u64, now: u64) -> Option<u64> {
    if fail_count < MAX_ATTEMPTS_BEFORE_LOCKOUT {
        return None;
    }
    let wait = lockout_duration_secs(fail_count);
    let elapsed = now.saturating_sub(last_fail_secs);
    (elapsed < wait).then(|| wait - elapsed)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ==========================================
// --- HELPER: Resolve Keychain Path ---
// ==========================================

/// Resolves the keychain path.
/// Currently only supports "local" until Phase 2 (USB) is implemented.
fn resolve_keychain_path(app: &AppHandle, vault_id: &str) -> Result<PathBuf, String> {
    if vault_id == "local" {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Could not resolve app data dir: {}", e))?;

        if !data_dir.exists() {
            fs::create_dir_all(&data_dir)
                .map_err(|e| format!("Failed to create data directory at {:?}: {}", data_dir, e))?;
        }
        Ok(data_dir.join("keychain.json"))
    } else {
        // Phase 2 Preparation: If vault_id is a drive path, look for .qre_portable/keychain.qre
        let path = PathBuf::from(vault_id)
            .join(".qre_portable")
            .join("keychain.qre");
        Ok(path)
    }
}

/// Converts a `Path` to `&str`, returning a recoverable error instead of
/// panicking. Every vault save/load path is normally an OS-resolved
/// app-data directory, but a `.to_str().unwrap()` would still panic on the
/// rare non-UTF-8 path (e.g. a legacy-encoded username or corrupted
/// filesystem metadata) instead of surfacing a normal command error.
fn path_to_str(path: &Path) -> CommandResult<&str> {
    path.to_str()
        .ok_or_else(|| format!("Path contains invalid (non-UTF-8) characters: {:?}", path))
}

// ==========================================
// --- SAFE MUTEX ACCESSOR ---
// ==========================================
// SECURITY FIX S-04: If the Mutex is poisoned, we clear the entire HashMap
// before returning an error to prevent exposing other active vaults.
macro_rules! lock_session {
    ($state:expr) => {
        match $state.vaults.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                guard.clear(); // Zeroizes all MasterKeys in the map
                Err("Session state is corrupted. All vaults locked.".to_string())
            }
        }
    };
}

// ==========================================
// --- VAULT FILE HELPERS ---
// ==========================================

/// The unlocked key for `vault_id`, or an error if that vault is locked.
fn session_key(state: &SessionState, vault_id: &str) -> CommandResult<keychain::MasterKey> {
    let guard = lock_session!(state)?;
    guard
        .get(vault_id)
        .cloned()
        .ok_or_else(|| "Vault is locked".to_string())
}

/// Path of a data file (e.g. `notes.qre`) that sits next to the keychain.
fn vault_file_path(app: &AppHandle, vault_id: &str, file_name: &str) -> CommandResult<PathBuf> {
    let keychain_path = resolve_keychain_path(app, vault_id)?;
    let dir = keychain_path
        .parent()
        .ok_or_else(|| "Keychain path has no parent directory".to_string())?;
    Ok(dir.join(file_name))
}

/// Decrypts and parses a vault file. `Ok(None)` means the file doesn't exist yet.
fn read_vault_file<T: serde::de::DeserializeOwned>(
    path: &Path,
    key: &keychain::MasterKey,
    parse_error: &str,
) -> CommandResult<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let container =
        crypto::EncryptedFileContainer::load(path_to_str(path)?).map_err(|e| e.to_string())?;
    let payload =
        crypto::decrypt_file_with_master_key(key, None, &container).map_err(|e| e.to_string())?;
    serde_json::from_slice(&payload.content)
        .map(Some)
        .map_err(|_| parse_error.to_string())
}

/// Serializes, encrypts and writes a vault file. `inner_name` is the name stored inside it.
fn write_vault_file<T: serde::Serialize>(
    path: &Path,
    key: &keychain::MasterKey,
    inner_name: &str,
    value: &T,
) -> CommandResult<()> {
    let json_data = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let container =
        crypto::encrypt_file_with_master_key(key, None, inner_name, &json_data, None, 3)
            .map_err(|e| e.to_string())?;
    container
        .save(path_to_str(path)?)
        .map_err(|e| e.to_string())
}

/// Drops clipboard entries older than the retention window. Returns true if any were removed.
/// `created_at` may be in seconds or milliseconds; values above 9999999999 are treated as ms.
fn drop_expired_clipboard_entries(
    vault: &mut ClipboardVault,
    now_ms: i64,
    retention_hours: u64,
) -> bool {
    // Clamped so an absurd value can't wrap to a negative i64 and expire everything.
    let ttl_seconds = retention_hours
        .saturating_mul(60 * 60)
        .min(i64::MAX as u64) as i64;
    let initial_count = vault.entries.len();
    let now_sec = now_ms / 1000;

    vault.entries.retain(|e| {
        // Pinned entries are exempt from auto-deletion (see ClipboardEntry::is_pinned).
        if e.is_pinned {
            return true;
        }
        let entry_time_sec = if e.created_at > 9999999999 {
            e.created_at / 1000
        } else {
            e.created_at
        };
        (now_sec - entry_time_sec) < ttl_seconds
    });

    vault.entries.len() != initial_count
}

// ==========================================
// --- UTILS ---
// ==========================================

#[tauri::command]
pub fn get_keychain_data(app: AppHandle) -> CommandResult<Vec<u8>> {
    let path = resolve_keychain_path(&app, "local")?;
    if !path.exists() {
        return Err("Keychain not found on disk.".to_string());
    }
    fs::read(path).map_err(|e| format!("Failed to read keychain: {}", e))
}

#[tauri::command]
pub fn export_keychain(app: AppHandle, save_path: String) -> CommandResult<()> {
    let src = resolve_keychain_path(&app, "local")?;
    if !src.exists() {
        return Err("Keychain not found on disk.".to_string());
    }
    fs::copy(src, &save_path).map_err(|e| format!("Failed to export: {}", e))?;
    Ok(())
}

/// Restores a previously exported `keychain.json` backup into place, for a fresh install
/// (or one where the vault was otherwise removed) with no vault set up yet. The Master
/// Password/Recovery Code themselves are unaffected either way — they only ever have to
/// unlock whichever slot data is currently on disk, and this just puts the backed-up slot
/// data back.
///
/// Deliberately refuses to run if a keychain already exists here: overwriting an active
/// vault with a restored one would silently discard whatever is currently in it. If someone
/// genuinely wants to replace an existing vault, that has to be an explicit, separate step,
/// not a side effect of "restore my backup."
///
/// The file's structure is validated (as a real `KeychainStore`) before it's ever written
/// to the real path, so a corrupt or unrelated file is rejected with a clear message up
/// front instead of silently landing in place and only failing cryptically at the next
/// login attempt.
/// Core restore logic, independent of `AppHandle` so it's directly unit-testable (this
/// codebase doesn't have Tauri's mock-app test harness wired up, so commands taking an
/// `AppHandle` directly generally aren't unit-tested here — extracting the real logic into a
/// plain-path function is how the rest of this file's commands stay testable too).
pub(crate) fn restore_keychain_to(dest: &Path, backup_path: &Path) -> Result<(), String> {
    if keychain::keychain_exists(dest) {
        return Err(
            "A vault already exists on this device. Restoring a backup would overwrite it — \
             remove the existing vault first if you really want to replace it."
                .to_string(),
        );
    }

    let bytes = fs::read(backup_path).map_err(|e| format!("Failed to read backup file: {e}"))?;

    serde_json::from_slice::<keychain::KeychainStore>(&bytes)
        .map_err(|_| "This file doesn't look like a valid QRE keychain backup.".to_string())?;

    fs::write(dest, &bytes).map_err(|e| format!("Failed to write keychain: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn restore_keychain(app: AppHandle, backup_path: String) -> CommandResult<()> {
    let dest = resolve_keychain_path(&app, "local")?;
    restore_keychain_to(&dest, Path::new(&backup_path))
}

#[tauri::command]
pub fn get_backup_done(app: AppHandle) -> bool {
    resolve_keychain_path(&app, "local")
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("backup_done")))
        .map(|p| p.exists())
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_backup_done(app: AppHandle) -> CommandResult<()> {
    let path = resolve_keychain_path(&app, "local")?
        .parent()
        .ok_or("Keychain path has no parent directory".to_string())?
        .join("backup_done");
    fs::write(&path, b"1").map_err(|e| format!("Failed to write backup flag: {}", e))?;
    Ok(())
}

// Any previously saved keychain backup is encrypted under the old password/recovery
// code. Once either slot is rotated, that backup is stale, so we clear the "done"
// marker (best-effort — a failure here shouldn't fail the password/recovery change
// that triggered it) and let the reminder prompt the user to make a fresh one.
fn clear_backup_done(app: &AppHandle) {
    if let Ok(keychain_path) = resolve_keychain_path(app, "local") {
        if let Some(dir) = keychain_path.parent() {
            let marker = dir.join("backup_done");
            if marker.exists() {
                let _ = fs::remove_file(marker);
            }
        }
    }
}

// ==========================================
// --- AUTH & SYSTEM ---
// ==========================================

#[tauri::command]
pub fn check_auth_status(app: AppHandle, state: tauri::State<SessionState>) -> String {
    // Boot auth check is always for the local vault
    let keychain_path = resolve_keychain_path(&app, "local").ok();
    auth_status(&state, keychain_path.as_deref())
}

/// "unlocked", "locked" or "setup_needed". `keychain_path` is `None` if it couldn't be resolved.
fn auth_status(state: &SessionState, keychain_path: Option<&Path>) -> String {
    let guard = match state.vaults.lock() {
        Ok(g) => g,
        Err(_) => return "locked".to_string(),
    };

    if guard.contains_key("local") {
        return "unlocked".to_string();
    }

    match keychain_path {
        Some(path) if keychain::keychain_exists(path) => "locked".to_string(),
        _ => "setup_needed".to_string(),
    }
}

#[tauri::command]
pub fn init_vault(
    app: AppHandle,
    password: String,
    vault_id: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let path = resolve_keychain_path(&app, &vault_id)?;
    let (recovery_code, master_key) =
        keychain::init_keychain(&path, &password).map_err(|e| e.to_string())?;

    let mut guard = lock_session!(state)?;
    guard.insert(vault_id, master_key);

    Ok(recovery_code)
}

#[tauri::command]
pub fn login(
    app: AppHandle,
    password: String,
    vault_id: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    if let Some(wait) = lockout_remaining_secs(
        LOGIN_FAIL_COUNT.load(Ordering::SeqCst),
        LOGIN_LAST_FAIL_SECS.load(Ordering::SeqCst),
        now_secs(),
    ) {
        return Err(format!(
            "Too many failed attempts. Please wait {} more second(s).",
            wait
        ));
    }

    let path = resolve_keychain_path(&app, &vault_id)?;
    match keychain::unlock_keychain(&path, &password) {
        Ok(master_key) => {
            LOGIN_FAIL_COUNT.store(0, Ordering::SeqCst);
            let mut guard = lock_session!(state)?;
            guard.insert(vault_id, master_key);
            Ok("Logged in".to_string())
        }
        Err(e) => {
            LOGIN_FAIL_COUNT.fetch_add(1, Ordering::SeqCst);
            LOGIN_LAST_FAIL_SECS.store(now_secs(), Ordering::SeqCst);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn logout(state: tauri::State<SessionState>) {
    clear_all_sessions(&state);
}

/// Locks ALL vaults, even if the mutex was poisoned.
fn clear_all_sessions(state: &SessionState) {
    match state.vaults.lock() {
        Ok(mut guard) => guard.clear(),
        Err(poisoned) => poisoned.into_inner().clear(),
    }
}

#[tauri::command]
pub fn change_user_password(
    app: AppHandle,
    current_password: String,
    new_password: String,
    vault_id: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let path = resolve_keychain_path(&app, &vault_id)?;

    keychain::unlock_keychain(&path, &current_password)
        .map_err(|_| "Current password is incorrect.".to_string())?;

    let guard = lock_session!(state)?;
    let master_key = guard
        .get(&vault_id)
        .ok_or_else(|| "Vault is locked.".to_string())?;

    keychain::change_password(&path, master_key, &new_password).map_err(|e| e.to_string())?;
    clear_backup_done(&app);
    Ok("Password changed successfully.".to_string())
}

#[tauri::command]
pub fn recover_vault(
    app: AppHandle,
    recovery_code: String,
    new_password: String,
    vault_id: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    if let Some(wait) = lockout_remaining_secs(
        RECOVERY_FAIL_COUNT.load(Ordering::SeqCst),
        RECOVERY_LAST_FAIL_SECS.load(Ordering::SeqCst),
        now_secs(),
    ) {
        return Err(format!(
            "Too many failed recovery attempts. Please wait {} more second(s).",
            wait
        ));
    }

    let path = resolve_keychain_path(&app, &vault_id)?;

    match keychain::recover_with_code(&path, &recovery_code, &new_password) {
        Ok(master_key) => {
            RECOVERY_FAIL_COUNT.store(0, Ordering::SeqCst);
            LOGIN_FAIL_COUNT.store(0, Ordering::SeqCst);

            let mut guard = lock_session!(state)?;
            guard.insert(vault_id, master_key);
            Ok("Recovery successful. Password updated.".to_string())
        }
        Err(e) => {
            RECOVERY_FAIL_COUNT.fetch_add(1, Ordering::SeqCst);
            RECOVERY_LAST_FAIL_SECS.store(now_secs(), Ordering::SeqCst);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn regenerate_recovery_code(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let guard = lock_session!(state)?;
    let master_key = guard
        .get(&vault_id)
        .ok_or_else(|| "Vault is locked. Cannot reset code.".to_string())?;

    let path = resolve_keychain_path(&app, &vault_id)?;
    let new_code = keychain::reset_recovery_code(&path, master_key).map_err(|e| e.to_string())?;
    clear_backup_done(&app);
    Ok(new_code)
}

// ==========================================
// --- PASSWORD VAULT COMMANDS ---
// ==========================================

#[tauri::command]
pub fn load_password_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
) -> CommandResult<PasswordVault> {
    let master_key = session_key(&state, &vault_id)?;
    let path = vault_file_path(&app, &vault_id, "passwords.qre")?;
    Ok(read_vault_file(&path, &master_key, "Failed to parse vault")?
        .unwrap_or_else(PasswordVault::new))
}

#[tauri::command]
pub fn save_password_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    vault: PasswordVault,
) -> CommandResult<()> {
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = session_key(&state, &vault_id)?;
    let path = vault_file_path(&app, &vault_id, "passwords.qre")?;
    write_vault_file(&path, &master_key, "passwords.json", &vault)
}

// ==========================================
// --- NOTES VAULT COMMANDS ---
// ==========================================

#[tauri::command]
pub fn load_notes_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
) -> CommandResult<NotesVault> {
    let master_key = session_key(&state, &vault_id)?;
    let path = vault_file_path(&app, &vault_id, "notes.qre")?;
    Ok(read_vault_file(&path, &master_key, "Failed to parse notes")?
        .unwrap_or_else(NotesVault::new))
}

#[tauri::command]
pub fn save_notes_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    vault: NotesVault,
) -> CommandResult<()> {
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = session_key(&state, &vault_id)?;
    let path = vault_file_path(&app, &vault_id, "notes.qre")?;
    write_vault_file(&path, &master_key, "notes.json", &vault)
}

// ==========================================
// --- BOOKMARKS COMMANDS ---
// ==========================================

#[tauri::command]
pub fn load_bookmarks_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
) -> CommandResult<BookmarksVault> {
    let master_key = session_key(&state, &vault_id)?;
    let path = vault_file_path(&app, &vault_id, "bookmarks.qre")?;
    Ok(
        read_vault_file(&path, &master_key, "Failed to parse bookmarks data")?
            .unwrap_or_else(BookmarksVault::new),
    )
}

#[tauri::command]
pub fn save_bookmarks_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    vault: BookmarksVault,
) -> CommandResult<()> {
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = session_key(&state, &vault_id)?;
    let path = vault_file_path(&app, &vault_id, "bookmarks.qre")?;
    write_vault_file(&path, &master_key, "bookmarks.json", &vault)
}

#[tauri::command]
pub fn import_browser_bookmarks(
    app: AppHandle,
    state: tauri::State<SessionState>,
) -> CommandResult<usize> {
    let new_bookmarks = crate::bookmarks::import_chrome_bookmarks()?;
    let count = new_bookmarks.len();
    if count == 0 {
        return Err("No bookmarks found.".to_string());
    }

    let vault_id = "local".to_string(); // Import only makes sense locally
    let mut vault = load_bookmarks_vault(app.clone(), vault_id.clone(), state.clone())?;
    vault.entries.extend(new_bookmarks);
    save_bookmarks_vault(app, vault_id, state, vault)?;

    Ok(count)
}

// ==========================================
// --- CLIPBOARD COMMANDS ---
// ==========================================

#[tauri::command]
pub fn load_clipboard_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    retention_hours: u64,
) -> CommandResult<ClipboardVault> {
    let master_key = session_key(&state, &vault_id)?;
    let path = vault_file_path(&app, &vault_id, "clipboard.qre")?;
    let Some(mut vault) =
        read_vault_file::<ClipboardVault>(&path, &master_key, "Failed to parse clipboard data")?
    else {
        return Ok(ClipboardVault::new());
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    if drop_expired_clipboard_entries(&mut vault, now_ms, retention_hours) {
        write_vault_file(&path, &master_key, "clipboard.json", &vault)?;
    }

    Ok(vault)
}

#[tauri::command]
pub fn save_clipboard_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    vault: ClipboardVault,
) -> CommandResult<()> {
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = session_key(&state, &vault_id)?;
    let path = vault_file_path(&app, &vault_id, "clipboard.qre")?;
    write_vault_file(&path, &master_key, "clipboard.json", &vault)
}

#[tauri::command]
pub fn add_clipboard_entry(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    text: String,
    retention_hours: u64,
) -> CommandResult<()> {
    let entry = crate::clipboard_store::create_entry(&text);
    let mut vault = load_clipboard_vault(
        app.clone(),
        vault_id.clone(),
        state.clone(),
        retention_hours,
    )?;
    vault.add_entry(entry).map_err(|e| e.to_string())?;
    save_clipboard_vault(app, vault_id, state, vault)?;
    Ok(())
}

/// Generates a Time-Based One-Time Password (TOTP) from a provided secret key.
/// Returns the 6-digit code and the number of seconds remaining until it expires.
#[tauri::command]
pub fn generate_totp_code(secret: String) -> CommandResult<(String, u64)> {
    totp_code_at(&secret, now_secs())
}

/// Same as `generate_totp_code`, but for an explicit Unix time so it can be tested.
fn totp_code_at(secret: &str, now: u64) -> CommandResult<(String, u64)> {
    // 1. Clean up the secret: Remove spaces, dashes, make uppercase
    let clean_secret = secret
        .split_whitespace()
        .collect::<String>()
        .replace("-", "")
        .to_uppercase();

    // Some keys come with padding (=), some don't. We strip padding and use the NOPAD decoder.
    let stripped_secret = clean_secret.trim_end_matches('=');

    // 2. Parse the Base32 secret robustly into raw bytes
    let secret_bytes = match BASE32_NOPAD.decode(stripped_secret.as_bytes()) {
        Ok(b) => b,
        Err(_) => {
            // Never log the secret itself.
            return Err("Invalid 2FA Secret Key (Must be valid Base32)".to_string());
        }
    };

    // 3. Standard TOTP configuration: SHA-1, 6 digits, 30-second steps
    let totp = Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(30)
        .with_secret(secret_bytes)
        .build()
        .map_err(|e| format!("Invalid TOTP configuration: {}", e))?;

    // 4. Generate the code for the given Unix timestamp
    let code = totp.generate(now).to_string();

    // Calculate remaining seconds in the current 30-second window
    let remaining_seconds = 30 - (now % 30);

    Ok((code, remaining_seconds))
}

#[cfg(test)]
mod tests;
