// --- START OF FILE vault.rs ---

use crate::bookmarks::BookmarksVault;
use crate::clipboard_store::ClipboardVault;
use crate::crypto;
use crate::keychain;
use crate::notes::NotesVault;
use crate::state::SessionState;
use crate::vault::PasswordVault;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Standardized result type for Tauri commands in this module, mapping errors to Strings for the frontend.
pub type CommandResult<T> = Result<T, String>;

// ==========================================
// --- LOGIN RATE LIMITING ---
// ==========================================
// Track failed login attempts in-memory using thread-safe atomics. After
// MAX_ATTEMPTS_BEFORE_LOCKOUT failures, the login command enforces an
// exponentially growing delay, doubling every extra failed attempt up to ~8
// minutes. The counter resets to zero on a successful login.
//
// Note: This is an in-memory guard — it resets when the app restarts. That is
// an intentional tradeoff: a persistent counter could permanently lock out a
// legitimate user who forgot their password without access to the app. The
// primary offline brute-force protection is provided by the Argon2id KDF in
// keychain.rs, which makes each password guess computationally expensive
// regardless of rate limiting.

/// Thread-safe counter for consecutive failed login attempts.
static LOGIN_FAIL_COUNT: AtomicU32 = AtomicU32::new(0);
/// Thread-safe timestamp recording the exact time of the last failed attempt.
static LOGIN_LAST_FAIL_SECS: AtomicU64 = AtomicU64::new(0);

/// The threshold of failed attempts before the exponential time penalty begins.
const MAX_ATTEMPTS_BEFORE_LOCKOUT: u32 = 5;

/// Calculates how many seconds the user must wait after `fail_count` total failures.
/// Formula: 5 failures → 30 s, 6 → 60 s, 7 → 120 s, 8 → 240 s, 9+ → 480 s (capped at 8 mins).
fn lockout_duration_secs(fail_count: u32) -> u64 {
    let extra = fail_count.saturating_sub(MAX_ATTEMPTS_BEFORE_LOCKOUT);
    30u64 * (1u64 << extra.min(4))
}

/// Helper function to get the current system time in seconds since the UNIX Epoch.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ==========================================
// --- HELPER: Resolve Keychain Path ---
// ==========================================

/// Dynamically resolves the OS-specific, safe application data directory.
/// (e.g., `~/Library/Application Support/com.qre.locker/keychain.json` on macOS,
/// `%APPDATA%\com.qre.locker\keychain.json` on Windows).
fn resolve_keychain_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;

    // Ensure the application directory exists before trying to read/write files to it
    if !data_dir.exists() {
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data directory at {:?}: {}", data_dir, e))?;
    }

    Ok(data_dir.join("keychain.json"))
}

// ==========================================
// --- UTILS ---
// ==========================================

/// Retrieves the raw encrypted bytes of the keychain file for backup purposes.
#[tauri::command]
pub fn get_keychain_data(app: AppHandle) -> CommandResult<Vec<u8>> {
    let path = resolve_keychain_path(&app)?;
    if !path.exists() {
        return Err("Keychain not found on disk.".to_string());
    }
    fs::read(path).map_err(|e| format!("Failed to read keychain: {}", e))
}

/// Copies the local keychain file to a user-specified destination (export feature).
#[tauri::command]
pub fn export_keychain(app: AppHandle, save_path: String) -> CommandResult<()> {
    let src = resolve_keychain_path(&app)?;
    if !src.exists() {
        return Err("Keychain not found on disk.".to_string());
    }
    fs::copy(src, &save_path).map_err(|e| format!("Failed to export: {}", e))?;
    Ok(())
}

// ==========================================
// --- AUTH & SYSTEM ---
// ==========================================

/// Checks the current application state to determine the UI flow.
/// Returns:
/// - "unlocked" if a master key is loaded in memory.
/// - "locked" if a keychain exists but the app is not authenticated.
/// - "setup_needed" if no keychain exists (first-time launch).
#[tauri::command]
pub fn check_auth_status(app: AppHandle, state: tauri::State<SessionState>) -> String {
    let guard = state.master_key.lock().unwrap();
    if guard.is_some() {
        return "unlocked".to_string();
    }

    match resolve_keychain_path(&app) {
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

/// Creates a new vault, generating the master key and saving the encrypted keychain.
#[tauri::command]
pub fn init_vault(
    app: AppHandle,
    password: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let path = resolve_keychain_path(&app)?;
    // Derive keys and create the keychain file.
    let (recovery_code, master_key) =
        keychain::init_keychain(&path, &password).map_err(|e| e.to_string())?;

    // Store the decrypted master key securely in the active session memory.
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);

    // Return the generated recovery code to display to the user once.
    Ok(recovery_code)
}

/// Attempts to authenticate with the provided password.
/// Enforces an exponential-backoff lockout after 5 consecutive failures.
#[tauri::command]
pub fn login(
    app: AppHandle,
    password: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    // 1. --- Check Lockout Status ---
    let fail_count = LOGIN_FAIL_COUNT.load(Ordering::SeqCst);
    if fail_count >= MAX_ATTEMPTS_BEFORE_LOCKOUT {
        let last_fail = LOGIN_LAST_FAIL_SECS.load(Ordering::SeqCst);
        let wait = lockout_duration_secs(fail_count);
        let elapsed = now_secs().saturating_sub(last_fail);

        // Block the login attempt if the penalty time has not fully elapsed.
        if elapsed < wait {
            return Err(format!(
                "Too many failed attempts. Please wait {} more second(s) before trying again.",
                wait - elapsed
            ));
        }
    }

    // 2. --- Attempt Authentication ---
    let path = resolve_keychain_path(&app)?;
    match keychain::unlock_keychain(&path, &password) {
        Ok(master_key) => {
            // Success: Reset the failure counter so legitimate users aren't permanently throttled.
            LOGIN_FAIL_COUNT.store(0, Ordering::SeqCst);

            // Store the decrypted master key in the session.
            let mut guard = state.master_key.lock().unwrap();
            *guard = Some(master_key);
            Ok("Logged in".to_string())
        }
        Err(e) => {
            // Failure: Increment the fail counter and record the exact timestamp.
            LOGIN_FAIL_COUNT.fetch_add(1, Ordering::SeqCst);
            LOGIN_LAST_FAIL_SECS.store(now_secs(), Ordering::SeqCst);
            Err(e.to_string())
        }
    }
}

/// Wipes the master key from the application's active session memory, locking the app.
#[tauri::command]
pub fn logout(state: tauri::State<SessionState>) {
    let mut guard = state.master_key.lock().unwrap();
    *guard = None;
}

/// Re-encrypts the keychain with a new password derived key, keeping the internal master key intact.
#[tauri::command]
pub fn change_user_password(
    app: AppHandle,
    new_password: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let guard = state.master_key.lock().unwrap();
    let master_key = match &*guard {
        Some(mk) => mk,
        None => return Err("Vault is locked.".to_string()),
    };

    let path = resolve_keychain_path(&app)?;
    keychain::change_password(&path, master_key, &new_password).map_err(|e| e.to_string())?;
    Ok("Password changed successfully.".to_string())
}

/// Uses a user's emergency recovery code to restore access and set a new password.
#[tauri::command]
pub fn recover_vault(
    app: AppHandle,
    recovery_code: String,
    new_password: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let path = resolve_keychain_path(&app)?;

    // Attempt to unlock the vault using the recovery key instead of the primary password key
    let master_key = keychain::recover_with_code(&path, &recovery_code, &new_password)
        .map_err(|e| e.to_string())?;

    // Reset any outstanding login lockout after a successful recovery.
    LOGIN_FAIL_COUNT.store(0, Ordering::SeqCst);

    // Load the key into the active session
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);
    Ok("Recovery successful. Password updated.".to_string())
}

/// Creates a new emergency recovery code (invalidating the old one).
#[tauri::command]
pub fn regenerate_recovery_code(
    app: AppHandle,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let guard = state.master_key.lock().unwrap();
    let master_key = match &*guard {
        Some(mk) => mk,
        None => return Err("Vault is locked. Cannot reset code.".to_string()),
    };

    let path = resolve_keychain_path(&app)?;
    let new_code = keychain::reset_recovery_code(&path, master_key).map_err(|e| e.to_string())?;
    Ok(new_code)
}

// ==========================================
// --- PASSWORD VAULT COMMANDS ---
// ==========================================

/// Loads and decrypts the user's saved passwords from `passwords.qre`.
#[tauri::command]
pub fn load_password_vault(
    app: AppHandle,
    state: tauri::State<SessionState>,
) -> CommandResult<PasswordVault> {
    // 1. Verify app is unlocked
    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked".to_string()),
        }
    };

    // 2. Resolve path
    let path = resolve_keychain_path(&app)?
        .parent()
        .unwrap()
        .join("passwords.qre");

    // Return an empty vault if the file doesn't exist yet
    if !path.exists() {
        return Ok(PasswordVault::new());
    }

    // 3. Load encrypted container, decrypt, and deserialize JSON
    let container =
        crypto::EncryptedFileContainer::load(path.to_str().unwrap()).map_err(|e| e.to_string())?;
    let payload = crypto::decrypt_file_with_master_key(&master_key, None, &container)
        .map_err(|e| e.to_string())?;
    let vault: PasswordVault = serde_json::from_slice(&payload.content)
        .map_err(|_| "Failed to parse vault".to_string())?;

    Ok(vault)
}

/// Encrypts and saves the user's password data to disk.
#[tauri::command]
pub fn save_password_vault(
    app: AppHandle,
    state: tauri::State<SessionState>,
    vault: PasswordVault,
) -> CommandResult<()> {
    // 1. Validate data structure integrity before saving to prevent corrupting the vault file.
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked".to_string()),
        }
    };

    let path = resolve_keychain_path(&app)?
        .parent()
        .unwrap()
        .join("passwords.qre");

    // 2. Serialize to JSON bytes
    let json_data = serde_json::to_vec(&vault).map_err(|e| e.to_string())?;

    // 3. Encrypt into a QRE container (Zstd level 3 compression)
    let container = crypto::encrypt_file_with_master_key(
        &master_key,
        None,
        "passwords.json",
        &json_data,
        None,
        3,
    )
    .map_err(|e| e.to_string())?;

    // 4. Write to disk
    container
        .save(path.to_str().unwrap())
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ==========================================
// --- NOTES VAULT COMMANDS ---
// ==========================================
// Extremely similar to Password vault, but for encrypted secure notes (`notes.qre`).

#[tauri::command]
pub fn load_notes_vault(
    app: AppHandle,
    state: tauri::State<SessionState>,
) -> CommandResult<NotesVault> {
    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked".to_string()),
        }
    };
    let path = resolve_keychain_path(&app)?
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
    state: tauri::State<SessionState>,
    vault: NotesVault,
) -> CommandResult<()> {
    // 1. VALIDATE BEFORE SAVING
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked".to_string()),
        }
    };

    let path = resolve_keychain_path(&app)?
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

/// Loads and decrypts private web bookmarks (`bookmarks.qre`).
#[tauri::command]
pub fn load_bookmarks_vault(
    app: AppHandle,
    state: tauri::State<SessionState>,
) -> CommandResult<BookmarksVault> {
    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked".to_string()),
        }
    };

    let path = resolve_keychain_path(&app)?
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

/// Saves the current state of private bookmarks to disk.
#[tauri::command]
pub fn save_bookmarks_vault(
    app: AppHandle,
    state: tauri::State<SessionState>,
    vault: BookmarksVault,
) -> CommandResult<()> {
    // 1. VALIDATE BEFORE SAVING
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked".to_string()),
        }
    };

    let path = resolve_keychain_path(&app)?
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

/// Locates and imports bookmarks directly from local Chrome/Edge installations.
#[tauri::command]
pub fn import_browser_bookmarks(
    app: AppHandle,
    state: tauri::State<SessionState>,
) -> CommandResult<usize> {
    // 1. Parse Chrome/Edge file from the local OS
    let new_bookmarks = crate::bookmarks::import_chrome_bookmarks()?;
    let count = new_bookmarks.len();

    if count == 0 {
        return Err("No bookmarks found.".to_string());
    }

    // 2. Load existing Vault
    let mut vault = load_bookmarks_vault(app.clone(), state.clone())?;

    // 3. Append the imported bookmarks
    vault.entries.extend(new_bookmarks);

    // 4. Save the combined vault back to disk
    save_bookmarks_vault(app, state, vault)?;

    Ok(count)
}

// ==========================================
// --- CLIPBOARD COMMANDS ---
// ==========================================

/// Loads the clipboard history vault, enforcing a Time-To-Live (TTL) auto-cleanup on load.
#[tauri::command]
pub fn load_clipboard_vault(
    app: AppHandle,
    state: tauri::State<SessionState>,
    retention_hours: u64,
) -> CommandResult<ClipboardVault> {
    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked".to_string()),
        }
    };

    let path = resolve_keychain_path(&app)?
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

    // --- Auto-Cleanup Logic (TTL) ---
    // Calculates the current time in milliseconds to compare against entry creation times.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let ttl_seconds = retention_hours * 60 * 60;
    let initial_count = vault.entries.len();

    // Retain only entries that are newer than the allowed TTL limit
    vault.entries.retain(|e| {
        // Handle potential inconsistencies where timestamps might be in ms vs seconds
        let entry_time_sec = if e.created_at > 9999999999 {
            e.created_at / 1000 // Convert ms to seconds
        } else {
            e.created_at
        };
        let now_sec = now / 1000;

        // Keep if the age is less than the retention limit
        (now_sec - entry_time_sec) < (ttl_seconds as i64)
    });

    // If any old entries were deleted during this load, immediately save the pruned vault back to disk
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

/// Manually saves the clipboard vault state.
#[tauri::command]
pub fn save_clipboard_vault(
    app: AppHandle,
    state: tauri::State<SessionState>,
    vault: ClipboardVault,
) -> CommandResult<()> {
    vault.validate().map_err(|e| e.to_string())?;

    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked".to_string()),
        }
    };

    let path = resolve_keychain_path(&app)?
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

/// Convenience function to append a new item directly to the clipboard history.
#[tauri::command]
pub fn add_clipboard_entry(
    app: AppHandle,
    state: tauri::State<SessionState>,
    text: String,
    retention_hours: u64,
) -> CommandResult<()> {
    let entry = crate::clipboard_store::create_entry(&text);

    // Load the vault (this automatically cleans out expired items as well)
    let mut vault = load_clipboard_vault(app.clone(), state.clone(), retention_hours)?;

    // Add the new entry to the data structure
    vault.add_entry(entry).map_err(|e| e.to_string())?;

    // Commit changes to disk
    save_clipboard_vault(app, state, vault)?;

    Ok(())
}

// --- END OF FILE vault.rs ---
