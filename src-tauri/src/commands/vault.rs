use crate::bookmarks::BookmarksVault;
use crate::clipboard_store::ClipboardVault;
use crate::crypto;
use crate::keychain;
use crate::notes::NotesVault;
use crate::state::SessionState;
use crate::vault::PasswordVault;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub type CommandResult<T> = Result<T, String>;

// --- HELPER: Resolve Keychain Path ---
fn resolve_keychain_path(app: &AppHandle) -> Result<PathBuf, String> {
    // Explicitly use app_data_dir which maps to ~/Library/Application Support/com.qre.locker/
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;

    // Ensure directory exists with detailed error reporting
    if !data_dir.exists() {
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data directory at {:?}: {}", data_dir, e))?;
    }

    Ok(data_dir.join("keychain.json"))
}

// --- UTILS ---

#[tauri::command]
pub fn get_keychain_data(app: AppHandle) -> CommandResult<Vec<u8>> {
    let path = resolve_keychain_path(&app)?;
    if !path.exists() {
        return Err("Keychain not found on disk.".to_string());
    }
    fs::read(path).map_err(|e| format!("Failed to read keychain: {}", e))
}

#[tauri::command]
pub fn export_keychain(app: AppHandle, save_path: String) -> CommandResult<()> {
    let src = resolve_keychain_path(&app)?;
    if !src.exists() {
        return Err("Keychain not found on disk.".to_string());
    }
    fs::copy(src, &save_path).map_err(|e| format!("Failed to export: {}", e))?;
    Ok(())
}

// --- AUTH & SYSTEM ---

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

#[tauri::command]
pub fn init_vault(
    app: AppHandle,
    password: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let path = resolve_keychain_path(&app)?;
    let (recovery_code, master_key) =
        keychain::init_keychain(&path, &password).map_err(|e| e.to_string())?;

    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);

    Ok(recovery_code)
}

#[tauri::command]
pub fn login(
    app: AppHandle,
    password: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let path = resolve_keychain_path(&app)?;
    let master_key = keychain::unlock_keychain(&path, &password).map_err(|e| e.to_string())?;
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);
    Ok("Logged in".to_string())
}

#[tauri::command]
pub fn logout(state: tauri::State<SessionState>) {
    let mut guard = state.master_key.lock().unwrap();
    *guard = None;
}

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

#[tauri::command]
pub fn recover_vault(
    app: AppHandle,
    recovery_code: String,
    new_password: String,
    state: tauri::State<SessionState>,
) -> CommandResult<String> {
    let path = resolve_keychain_path(&app)?;
    let master_key = keychain::recover_with_code(&path, &recovery_code, &new_password)
        .map_err(|e| e.to_string())?;
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);
    Ok("Recovery successful. Password updated.".to_string())
}

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

// --- PASSWORD VAULT COMMANDS ---

#[tauri::command]
pub fn load_password_vault(
    app: AppHandle,
    state: tauri::State<SessionState>,
) -> CommandResult<PasswordVault> {
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
    state: tauri::State<SessionState>,
    vault: PasswordVault,
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

// --- NOTES VAULT COMMANDS ---

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

// --- BOOKMARKS COMMANDS ---

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

#[tauri::command]
pub fn import_browser_bookmarks(
    app: AppHandle,
    state: tauri::State<SessionState>,
) -> CommandResult<usize> {
    // 1. Parse Chrome/Edge file
    let new_bookmarks = crate::bookmarks::import_chrome_bookmarks()?;
    let count = new_bookmarks.len();

    if count == 0 {
        return Err("No bookmarks found.".to_string());
    }

    // 2. Load existing Vault
    let mut vault = load_bookmarks_vault(app.clone(), state.clone())?;

    // 3. Append (avoid duplicates based on URL?)
    // For now, just append.
    vault.entries.extend(new_bookmarks);

    // 4. Save
    save_bookmarks_vault(app, state, vault)?;

    Ok(count)
}

// --- CLIPBOARD COMMANDS ---

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

    // Auto-Cleanup logic
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // FIX: Using seconds for created_at now, so convert ttl to seconds
    let ttl_seconds = retention_hours * 60 * 60;

    let initial_count = vault.entries.len();
    vault.entries.retain(|e| {
        // Detect if entry is old (ms) or new (seconds) and normalize
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
    state: tauri::State<SessionState>,
    vault: ClipboardVault,
) -> CommandResult<()> {
    // FIX: Validate before saving (Fixes unused warning)
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

#[tauri::command]
pub fn add_clipboard_entry(
    app: AppHandle,
    state: tauri::State<SessionState>,
    text: String,
    retention_hours: u64,
) -> CommandResult<()> {
    let entry = crate::clipboard_store::create_entry(&text);

    let mut vault = load_clipboard_vault(app.clone(), state.clone(), retention_hours)?;

    vault.add_entry(entry).map_err(|e| e.to_string())?;

    save_clipboard_vault(app, state, vault)?;

    Ok(())
}
