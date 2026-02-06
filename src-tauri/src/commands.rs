use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(not(target_os = "android"))]
use std::process::Command;

#[cfg(not(target_os = "android"))]
use sysinfo::Disks;

use crate::bookmarks::BookmarksVault;
use crate::breach;
use crate::cleaner::{self, MetadataReport};
use crate::clipboard_store::ClipboardVault;
use crate::crypto;
use crate::crypto_stream;
use crate::keychain;
use crate::notes::NotesVault;
use crate::qr;
use crate::state::SessionState;
use crate::utils;
use crate::vault::PasswordVault;
use crate::wordlist::WORDLIST;
use rand::RngCore;
type CommandResult<T> = Result<T, String>;

#[derive(serde::Serialize)]
pub struct BatchItemResult {
    pub name: String,
    pub success: bool,
    pub message: String,
}

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

// --- HELPER: Smart Compression Detection ---
fn is_already_compressed(filename: &str) -> bool {
    let ext = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    matches!(
        ext.as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "zip"
            | "7z"
            | "rar"
            | "gz"
            | "bz2"
            | "xz"
            | "mp4"
            | "mkv"
            | "mov"
            | "avi"
            | "webm"
            | "mp3"
            | "aac"
            | "flac"
            | "wav"
            | "pdf"
    )
}

// --- METADATA CLEANER (RESTORED) ---
#[tauri::command]
pub async fn analyze_file_metadata(path: String) -> CommandResult<MetadataReport> {
    cleaner::analyze_file(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clean_file_metadata(
    path: String,
    options: cleaner::CleaningOptions,
) -> CommandResult<String> {
    let out_path =
        cleaner::remove_metadata(Path::new(&path), options).map_err(|e| e.to_string())?;
    Ok(out_path.to_string_lossy().to_string())
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

// --- QR CODE COMMAND ---
#[tauri::command]
pub fn generate_qr_code(text: String, fg: String, bg: String) -> CommandResult<String> {
    qr::generate_qr(&text, &fg, &bg).map_err(|e| e.to_string())
}

// --- PRIVACY & BREACH CHECK ---

#[tauri::command]
pub async fn check_password_breach(password: String) -> CommandResult<breach::BreachResult> {
    breach::check_pwned(&password)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_public_ip_address() -> CommandResult<breach::IpResult> {
    breach::get_public_ip().await.map_err(|e| e.to_string())
}

// --- PASSWORD GENERATOR (RESTORED) ---
#[tauri::command]
pub fn generate_passphrase() -> String {
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| {
            let idx = (rng.next_u64() as usize) % WORDLIST.len();
            WORDLIST[idx]
        })
        .collect::<Vec<_>>()
        .join("-")
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
    let ttl_ms = retention_hours * 60 * 60 * 1000;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let initial_count = vault.entries.len();
    vault
        .entries
        .retain(|e| (now - e.created_at) < (ttl_ms as i64));

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
    vault.entries.insert(0, entry);
    save_clipboard_vault(app, state, vault)?;

    Ok(())
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

// --- AUTH & SYSTEM ---

#[tauri::command]
pub fn get_drives() -> Vec<String> {
    #[cfg(not(target_os = "android"))]
    {
        let disks = Disks::new_with_refreshed_list();
        disks
            .list()
            .iter()
            .map(|disk| disk.mount_point().to_string_lossy().to_string())
            .collect()
    }
    #[cfg(target_os = "android")]
    {
        vec!["/storage/emulated/0".to_string()]
    }
}

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

#[tauri::command]
pub fn get_startup_file() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        let path = args[1].clone();
        if !path.starts_with("--") {
            return Some(path);
        }
    }
    None
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

// --- FILE OPERATIONS ---

#[tauri::command]
pub async fn delete_items(
    app: AppHandle,
    paths: Vec<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for path in paths {
            let p = Path::new(&path);
            let filename = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            #[cfg(target_os = "android")]
            {
                utils::emit_progress(&app, &format!("Deleting {}", filename), 50);
                let res = if p.is_dir() {
                    fs::remove_dir_all(p)
                } else {
                    fs::remove_file(p)
                };
                match res {
                    Ok(_) => results.push(BatchItemResult {
                        name: filename,
                        success: true,
                        message: "Deleted".into(),
                    }),
                    Err(e) => results.push(BatchItemResult {
                        name: filename,
                        success: false,
                        message: e.to_string(),
                    }),
                }
            }

            #[cfg(not(target_os = "android"))]
            {
                utils::emit_progress(&app, &format!("Preparing to shred {}", filename), 0);
                match utils::shred_recursive(&app, p) {
                    Ok(_) => results.push(BatchItemResult {
                        name: filename,
                        success: true,
                        message: "Deleted".into(),
                    }),
                    Err(e) => results.push(BatchItemResult {
                        name: filename,
                        success: false,
                        message: e,
                    }),
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_items(
    app: AppHandle,
    paths: Vec<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for path in paths {
            let p = Path::new(&path);
            let filename = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            #[cfg(target_os = "android")]
            {
                utils::emit_progress(&app, &format!("Deleting {}", filename), 50);
                let res = if p.is_dir() {
                    fs::remove_dir_all(p)
                } else {
                    fs::remove_file(p)
                };
                match res {
                    Ok(_) => results.push(BatchItemResult {
                        name: filename,
                        success: true,
                        message: "Deleted (No Trash on Mobile)".into(),
                    }),
                    Err(e) => results.push(BatchItemResult {
                        name: filename,
                        success: false,
                        message: e.to_string(),
                    }),
                }
            }

            #[cfg(not(target_os = "android"))]
            {
                utils::emit_progress(&app, &format!("Trashing {}", filename), 50);
                match utils::move_to_trash(p) {
                    Ok(_) => results.push(BatchItemResult {
                        name: filename,
                        success: true,
                        message: "Moved to Trash".into(),
                    }),
                    Err(e) => results.push(BatchItemResult {
                        name: filename,
                        success: false,
                        message: e,
                    }),
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn create_dir(path: String) -> CommandResult<()> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_item(path: String, new_name: String) -> CommandResult<()> {
    let old_path = Path::new(&path);
    let parent = old_path.parent().ok_or("Invalid path")?;
    let new_path = parent.join(new_name);
    fs::rename(old_path, new_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn show_in_folder(path: String) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        let _ = path;
        Err("Reveal in Explorer is not supported on Android".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        #[cfg(target_os = "windows")]
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "linux")]
        {
            let p = Path::new(&path);
            let parent = p.parent().unwrap_or(p);
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// --- CRYPTO LOGIC ---

#[tauri::command]
pub async fn lock_file(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>,
    keyfile_path: Option<String>,
    keyfile_bytes: Option<Vec<u8>>,
    extra_entropy: Option<Vec<u8>>,
    compression_mode: Option<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked.".to_string()),
        }
    };

    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    let entropy_seed = if let Some(bytes) = extra_entropy {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().into())
    } else {
        None
    };

    let mode_str = compression_mode.unwrap_or("auto".to_string());

    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for file_path in file_paths {
            let path = Path::new(&file_path);
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            utils::emit_progress(&app, &format!("Preparing: {}", filename), 5);

            let level = match mode_str.as_str() {
                "store" => 0,
                "extreme" => 19,
                "auto" | _ => {
                    if is_already_compressed(&filename) {
                        1
                    } else {
                        3
                    }
                }
            };

            let (input_path_str, is_temp) = if path.is_dir() {
                let parent = path.parent().unwrap_or(Path::new("."));
                let temp_zip_name = format!("{}.zip", filename);
                let temp_zip_path = utils::get_unique_path(&parent.join(&temp_zip_name));

                utils::emit_progress(&app, &format!("Zipping Folder: {}", filename), 10);

                if let Err(e) = utils::zip_directory_to_file(path, &temp_zip_path) {
                    results.push(BatchItemResult {
                        name: filename.to_string(),
                        success: false,
                        message: format!("Zip failed: {}", e),
                    });
                    continue;
                }

                (temp_zip_path.to_string_lossy().to_string(), true)
            } else {
                (file_path.clone(), false)
            };

            let raw_output = format!("{}.qre", file_path);
            let final_path = utils::get_unique_path(Path::new(&raw_output));
            let final_path_str = final_path.to_string_lossy().to_string();

            let app_handle = app.clone();
            let f_name_clone = filename.to_string();

            let progress_cb = move |processed: u64, total: u64| {
                if total > 0 {
                    let pct = (processed as f64 / total as f64 * 100.0) as u8;
                    let display_pct = if is_temp {
                        20 + (pct as f64 * 0.8) as u8
                    } else {
                        pct
                    };
                    utils::emit_progress(
                        &app_handle,
                        &format!("Encrypting: {}", f_name_clone),
                        display_pct,
                    );
                }
            };

            let encryption_result = crypto_stream::encrypt_file_stream(
                &input_path_str,
                &final_path_str,
                &master_key,
                keyfile_hash.as_deref(),
                entropy_seed,
                level,
                progress_cb,
            );

            if is_temp {
                let _ = fs::remove_file(&input_path_str);
            }

            match encryption_result {
                Ok(_) => {
                    results.push(BatchItemResult {
                        name: filename.to_string(),
                        success: true,
                        message: "Locked".into(),
                    });
                }
                Err(e) => {
                    let _ = fs::remove_file(&final_path);
                    results.push(BatchItemResult {
                        name: filename.to_string(),
                        success: false,
                        message: e.to_string(),
                    });
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn unlock_file(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>,
    keyfile_path: Option<String>,
    keyfile_bytes: Option<Vec<u8>>,
) -> CommandResult<Vec<BatchItemResult>> {
    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked.".to_string()),
        }
    };

    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for file_path in file_paths {
            let path = Path::new(&file_path);
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            utils::emit_progress(&app, &format!("Checking: {}", filename), 5);

            let mut file = match fs::File::open(path) {
                Ok(f) => f,
                Err(e) => {
                    results.push(BatchItemResult {
                        name: filename,
                        success: false,
                        message: e.to_string(),
                    });
                    continue;
                }
            };

            let mut ver_buf = [0u8; 4];
            if let Err(_) = file.read_exact(&mut ver_buf) {
                results.push(BatchItemResult {
                    name: filename,
                    success: false,
                    message: "Invalid file".into(),
                });
                continue;
            }
            let version = u32::from_le_bytes(ver_buf);

            if version == 4 {
                match crypto::EncryptedFileContainer::load(&file_path) {
                    Ok(container) => {
                        utils::emit_progress(
                            &app,
                            &format!("Decrypting (Legacy V4): {}", filename),
                            50,
                        );
                        match crypto::decrypt_file_with_master_key(
                            &master_key,
                            keyfile_hash.as_deref(),
                            &container,
                        ) {
                            Ok(payload) => {
                                utils::emit_progress(
                                    &app,
                                    &format!("Writing: {}", payload.filename),
                                    80,
                                );
                                let parent =
                                    Path::new(&file_path).parent().unwrap_or(Path::new("."));
                                let original_path = parent.join(&payload.filename);
                                let final_path = utils::get_unique_path(&original_path);
                                if let Err(e) = fs::write(&final_path, &payload.content) {
                                    let _ = fs::remove_file(&final_path);
                                    results.push(BatchItemResult {
                                        name: filename,
                                        success: false,
                                        message: e.to_string(),
                                    });
                                } else {
                                    results.push(BatchItemResult {
                                        name: filename,
                                        success: true,
                                        message: "Unlocked".into(),
                                    });
                                }
                            }
                            Err(e) => results.push(BatchItemResult {
                                name: filename,
                                success: false,
                                message: e.to_string(),
                            }),
                        }
                    }
                    Err(e) => results.push(BatchItemResult {
                        name: filename,
                        success: false,
                        message: e.to_string(),
                    }),
                }
            } else if version == 5 {
                let parent = Path::new(&file_path).parent().unwrap_or(Path::new("."));
                let output_dir_str = parent.to_string_lossy().to_string();

                let app_handle = app.clone();
                let f_name = filename.clone();

                let progress_cb = move |processed: u64, total: u64| {
                    if total > 0 {
                        let pct = (processed as f64 / total as f64 * 100.0) as u8;
                        utils::emit_progress(&app_handle, &format!("Decrypting: {}", f_name), pct);
                    }
                };

                match crypto_stream::decrypt_file_stream(
                    &file_path,
                    &output_dir_str,
                    &master_key,
                    keyfile_hash.as_deref(),
                    progress_cb,
                ) {
                    Ok(out_name) => results.push(BatchItemResult {
                        name: filename,
                        success: true,
                        message: format!("Unlocked: {}", out_name),
                    }),
                    Err(e) => results.push(BatchItemResult {
                        name: filename,
                        success: false,
                        message: e.to_string(),
                    }),
                }
            } else {
                results.push(BatchItemResult {
                    name: filename,
                    success: false,
                    message: format!("Unsupported Version: {}", version),
                });
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- VAULT COMMANDS ---
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
