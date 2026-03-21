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
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use totp_rs::{Algorithm, TOTP};

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

// ==========================================
// --- AUTH & SYSTEM ---
// ==========================================

#[tauri::command]
pub fn check_auth_status(app: AppHandle, state: tauri::State<SessionState>) -> String {
    let vault_id = "local"; // Boot auth check is always for the local vault

    let guard = match state.vaults.lock() {
        Ok(g) => g,
        Err(_) => return "locked".to_string(),
    };

    if guard.contains_key(vault_id) {
        return "unlocked".to_string();
    }

    match resolve_keychain_path(&app, vault_id) {
        Ok(path) => {
            if keychain::keychain_exists(&path) {
                "locked".to_string()
            } else {
                "setup_needed".to_string()
            }
        }
        Err(_) => "setup_needed".to_string(),
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
    let fail_count = LOGIN_FAIL_COUNT.load(Ordering::SeqCst);
    if fail_count >= MAX_ATTEMPTS_BEFORE_LOCKOUT {
        let last_fail = LOGIN_LAST_FAIL_SECS.load(Ordering::SeqCst);
        let wait = lockout_duration_secs(fail_count);
        let elapsed = now_secs().saturating_sub(last_fail);

        if elapsed < wait {
            return Err(format!(
                "Too many failed attempts. Please wait {} more second(s).",
                wait - elapsed
            ));
        }
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
    match state.vaults.lock() {
        Ok(mut guard) => {
            guard.clear(); // Lock ALL vaults
        }
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            guard.clear();
        }
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
    let fail_count = RECOVERY_FAIL_COUNT.load(Ordering::SeqCst);
    if fail_count >= MAX_ATTEMPTS_BEFORE_LOCKOUT {
        let last_fail = RECOVERY_LAST_FAIL_SECS.load(Ordering::SeqCst);
        let wait = lockout_duration_secs(fail_count);
        let elapsed = now_secs().saturating_sub(last_fail);

        if elapsed < wait {
            return Err(format!(
                "Too many failed recovery attempts. Please wait {} more second(s).",
                wait - elapsed
            ));
        }
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
    let master_key = {
        let guard = lock_session!(state)?;
        guard.get(&vault_id).ok_or("Vault is locked")?.clone()
    };

    let path = resolve_keychain_path(&app, &vault_id)?
        .parent()
        .unwrap()
        .join("passwords.qre");

    if !path.exists() {
        return Ok(PasswordVault::new());
    }

    let container =
        crypto::EncryptedFileContainer::load(path.to_str().unwrap()).map_err(|e| e.to_string())?;
    let payload = crypto::decrypt_file_with_master_key(&master_key, None, &container)
        .map_err(|e| e.to_string())?;

    let vault: PasswordVault = serde_json::from_slice(&payload.content)
        .map_err(|_| "Failed to parse vault".to_string())?;
    Ok(vault)
}

#[tauri::command]
pub fn save_password_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    vault: PasswordVault,
) -> CommandResult<()> {
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = {
        let guard = lock_session!(state)?;
        guard.get(&vault_id).ok_or("Vault is locked")?.clone()
    };

    let path = resolve_keychain_path(&app, &vault_id)?
        .parent()
        .unwrap()
        .join("passwords.qre");
    let json_data = serde_json::to_vec(&vault).map_err(|e| e.to_string())?;

    let container = crypto::encrypt_file_with_master_key(
        &master_key,
        None,
        "passwords.json",
        &json_data,
        None,
        3,
    )
    .map_err(|e| e.to_string())?;
    container
        .save(path.to_str().unwrap())
        .map_err(|e| e.to_string())?;
    Ok(())
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
    let master_key = {
        let guard = lock_session!(state)?;
        guard.get(&vault_id).ok_or("Vault is locked")?.clone()
    };
    let path = resolve_keychain_path(&app, &vault_id)?
        .parent()
        .unwrap()
        .join("notes.qre");

    if !path.exists() {
        return Ok(NotesVault::new());
    }

    let container =
        crypto::EncryptedFileContainer::load(path.to_str().unwrap()).map_err(|e| e.to_string())?;
    let payload = crypto::decrypt_file_with_master_key(&master_key, None, &container)
        .map_err(|e| e.to_string())?;
    let vault: NotesVault = serde_json::from_slice(&payload.content)
        .map_err(|_| "Failed to parse notes".to_string())?;
    Ok(vault)
}

#[tauri::command]
pub fn save_notes_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    vault: NotesVault,
) -> CommandResult<()> {
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = {
        let guard = lock_session!(state)?;
        guard.get(&vault_id).ok_or("Vault is locked")?.clone()
    };

    let path = resolve_keychain_path(&app, &vault_id)?
        .parent()
        .unwrap()
        .join("notes.qre");
    let json_data = serde_json::to_vec(&vault).map_err(|e| e.to_string())?;

    let container =
        crypto::encrypt_file_with_master_key(&master_key, None, "notes.json", &json_data, None, 3)
            .map_err(|e| e.to_string())?;
    container
        .save(path.to_str().unwrap())
        .map_err(|e| e.to_string())?;
    Ok(())
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
    let master_key = {
        let guard = lock_session!(state)?;
        guard.get(&vault_id).ok_or("Vault is locked")?.clone()
    };

    let path = resolve_keychain_path(&app, &vault_id)?
        .parent()
        .unwrap()
        .join("bookmarks.qre");
    if !path.exists() {
        return Ok(BookmarksVault::new());
    }

    let container =
        crypto::EncryptedFileContainer::load(path.to_str().unwrap()).map_err(|e| e.to_string())?;
    let payload = crypto::decrypt_file_with_master_key(&master_key, None, &container)
        .map_err(|e| e.to_string())?;
    let vault: BookmarksVault = serde_json::from_slice(&payload.content)
        .map_err(|_| "Failed to parse bookmarks data".to_string())?;
    Ok(vault)
}

#[tauri::command]
pub fn save_bookmarks_vault(
    app: AppHandle,
    vault_id: String,
    state: tauri::State<SessionState>,
    vault: BookmarksVault,
) -> CommandResult<()> {
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = {
        let guard = lock_session!(state)?;
        guard.get(&vault_id).ok_or("Vault is locked")?.clone()
    };

    let path = resolve_keychain_path(&app, &vault_id)?
        .parent()
        .unwrap()
        .join("bookmarks.qre");
    let json_data = serde_json::to_vec(&vault).map_err(|e| e.to_string())?;

    let container = crypto::encrypt_file_with_master_key(
        &master_key,
        None,
        "bookmarks.json",
        &json_data,
        None,
        3,
    )
    .map_err(|e| e.to_string())?;
    container
        .save(path.to_str().unwrap())
        .map_err(|e| e.to_string())?;
    Ok(())
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
    let master_key = {
        let guard = lock_session!(state)?;
        guard.get(&vault_id).ok_or("Vault is locked")?.clone()
    };

    let path = resolve_keychain_path(&app, &vault_id)?
        .parent()
        .unwrap()
        .join("clipboard.qre");
    if !path.exists() {
        return Ok(ClipboardVault::new());
    }

    let container =
        crypto::EncryptedFileContainer::load(path.to_str().unwrap()).map_err(|e| e.to_string())?;
    let payload = crypto::decrypt_file_with_master_key(&master_key, None, &container)
        .map_err(|e| e.to_string())?;
    let mut vault: ClipboardVault = serde_json::from_slice(&payload.content)
        .map_err(|_| "Failed to parse clipboard data".to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let ttl_seconds = retention_hours * 60 * 60;
    let initial_count = vault.entries.len();

    vault.entries.retain(|e| {
        let entry_time_sec = if e.created_at > 9999999999 {
            e.created_at / 1000
        } else {
            e.created_at
        };
        let now_sec = now / 1000;
        (now_sec - entry_time_sec) < (ttl_seconds as i64)
    });

    if vault.entries.len() != initial_count {
        let json_data = serde_json::to_vec(&vault).map_err(|e| e.to_string())?;
        let container = crypto::encrypt_file_with_master_key(
            &master_key,
            None,
            "clipboard.json",
            &json_data,
            None,
            3,
        )
        .map_err(|e| e.to_string())?;
        container
            .save(path.to_str().unwrap())
            .map_err(|e| e.to_string())?;
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

    let master_key = {
        let guard = lock_session!(state)?;
        guard.get(&vault_id).ok_or("Vault is locked")?.clone()
    };

    let path = resolve_keychain_path(&app, &vault_id)?
        .parent()
        .unwrap()
        .join("clipboard.qre");
    let json_data = serde_json::to_vec(&vault).map_err(|e| e.to_string())?;

    let container = crypto::encrypt_file_with_master_key(
        &master_key,
        None,
        "clipboard.json",
        &json_data,
        None,
        3,
    )
    .map_err(|e| e.to_string())?;
    container
        .save(path.to_str().unwrap())
        .map_err(|e| e.to_string())?;
    Ok(())
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
        Err(e) => {
            println!(
                "Base32 Decode Error: {} for string '{}'",
                e, stripped_secret
            );
            return Err("Invalid 2FA Secret Key (Must be valid Base32)".to_string());
        }
    };

    // 3. Standard TOTP configuration: SHA-1, 6 digits, 30-second steps
    let totp = TOTP::new_unchecked(Algorithm::SHA1, 6, 1, 30, secret_bytes);

    // 4. Generate the code based on the current Unix timestamp
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let code = totp
        .generate_current()
        .map_err(|e| format!("Failed to generate code: {}", e))?;

    // Calculate remaining seconds in the current 30-second window
    let remaining_seconds = 30 - (now % 30);

    Ok((code, remaining_seconds))
}
