use tauri::{AppHandle, Manager};
use std::fs;
use std::path::{Path, PathBuf};
use sha2::{Sha256, Digest};
use std::io::Read; // Needed for reading version headers

// --- PLATFORM SPECIFIC IMPORTS ---
// Android does not support standard system commands (like opening Explorer) 
// or standard drive letters (like C:\). We restrict these imports to Desktop only.

#[cfg(not(target_os = "android"))]
use std::process::Command;

#[cfg(not(target_os = "android"))]
use sysinfo::Disks;

// --- INTERNAL MODULES ---
use crate::state::SessionState;
use crate::utils;
use crate::keychain;
use crate::crypto;        // V4 Engine: Memory-based (Legacy support & Folders)
use crate::crypto_stream; // V5 Engine: Stream-based (Current standard for Files)

type CommandResult<T> = Result<T, String>;

#[derive(serde::Serialize)]
pub struct BatchItemResult {
    pub name: String,
    pub success: bool,
    pub message: String,
}

// --- HELPER FUNCTIONS ---

/// Determines the correct location to store the password database (`keychain.json`).
/// - **Desktop:** Uses the standard AppData/Config directory.
/// - **Android:** Uses the application's internal data directory (Sandboxed).
fn resolve_keychain_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    
    // Create the directory if it doesn't exist (First run)
    if !data_dir.exists() {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    
    Ok(data_dir.join("keychain.json"))
}

/// Checks if a file extension represents an already compressed format.
/// Used by the "Smart Compression" logic to avoid wasting CPU time re-compressing
/// images or videos.
fn is_already_compressed(filename: &str) -> bool {
    let ext = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    matches!(
        ext.as_str(), 
        "jpg" | "jpeg" | "png" | "gif" | "webp" | 
        "zip" | "7z" | "rar" | "gz" | "bz2" | "xz" | 
        "mp4" | "mkv" | "mov" | "avi" | "webm" | 
        "mp3" | "aac" | "flac" | "wav" | "pdf"
    )
}

/// Reads the raw bytes of the keychain file.
/// **Purpose:** On Android, saving files to specific locations often requires 
/// the Frontend to handle the write operation. This command hands the data to the UI.
#[tauri::command]
pub fn get_keychain_data(app: AppHandle) -> CommandResult<Vec<u8>> {
    let path = resolve_keychain_path(&app)?;
    if !path.exists() {
        return Err("Keychain not found on disk.".to_string());
    }
    fs::read(path).map_err(|e| format!("Failed to read keychain: {}", e))
}

// --- AUTHENTICATION & SYSTEM COMMANDS ---

/// Lists available storage roots.
/// - **Desktop:** Returns drive letters (e.g., "C:\", "D:\").
/// - **Android:** Returns the standard internal storage path.
#[tauri::command]
pub fn get_drives() -> Vec<String> {
    #[cfg(not(target_os = "android"))]
    {
        let disks = Disks::new_with_refreshed_list();
        disks.list().iter()
            .map(|disk| disk.mount_point().to_string_lossy().to_string())
            .collect()
    }
    #[cfg(target_os = "android")]
    {
        vec!["/storage/emulated/0".to_string()]
    }
}

/// Determines the current state of the application:
/// 1. **unlocked:** User is logged in (Key is in RAM).
/// 2. **locked:** User is logged out, but a vault exists on disk.
/// 3. **setup_needed:** No vault found (New user).
#[tauri::command]
pub fn check_auth_status(app: AppHandle, state: tauri::State<SessionState>) -> String {
    let guard = state.master_key.lock().unwrap();
    if guard.is_some() { 
        return "unlocked".to_string();
    }
    
    match resolve_keychain_path(&app) {
        Ok(path) => {
            if keychain::keychain_exists(&path) { "locked".to_string() } 
            else { "setup_needed".to_string() }
        },
        Err(_) => "setup_needed".to_string()
    }
}

/// Creates a new vault with the provided password.
/// Automatically logs the user in upon success.
#[tauri::command]
pub fn init_vault(app: AppHandle, password: String, state: tauri::State<SessionState>) -> CommandResult<String> {
    let path = resolve_keychain_path(&app)?;
    let (recovery_code, master_key) = keychain::init_keychain(&path, &password).map_err(|e| e.to_string())?;
    
    // Auto-login: Store key in memory immediately
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);

    Ok(recovery_code)
}

/// Decrypts the Master Key using the password and stores it in RAM (SessionState).
#[tauri::command]
pub fn login(app: AppHandle, password: String, state: tauri::State<SessionState>) -> CommandResult<String> {
    let path = resolve_keychain_path(&app)?;
    let master_key = keychain::unlock_keychain(&path, &password).map_err(|e| e.to_string())?;
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);
    Ok("Logged in".to_string())
}

/// Wipes the Master Key from RAM, locking the application.
#[tauri::command]
pub fn logout(state: tauri::State<SessionState>) {
    let mut guard = state.master_key.lock().unwrap();
    *guard = None;
}

#[tauri::command]
pub fn change_user_password(app: AppHandle, new_password: String, state: tauri::State<SessionState>) -> CommandResult<String> {
    let guard = state.master_key.lock().unwrap();
    let master_key = match &*guard {
        Some(mk) => mk,
        None => return Err("Vault is locked.".to_string()),
    };
    
    let path = resolve_keychain_path(&app)?;
    keychain::change_password(&path, master_key, &new_password).map_err(|e| e.to_string())?;
    Ok("Password changed successfully.".to_string())
}

/// Uses the Recovery Code (QRE-XXXX) to unlock the vault and set a new password.
#[tauri::command]
pub fn recover_vault(app: AppHandle, recovery_code: String, new_password: String, state: tauri::State<SessionState>) -> CommandResult<String> {
    let path = resolve_keychain_path(&app)?;
    let master_key = keychain::recover_with_code(&path, &recovery_code, &new_password).map_err(|e| e.to_string())?;
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);
    Ok("Recovery successful. Password updated.".to_string())
}

#[tauri::command]
pub fn regenerate_recovery_code(app: AppHandle, state: tauri::State<SessionState>) -> CommandResult<String> {
    let guard = state.master_key.lock().unwrap();
    let master_key = match &*guard {
        Some(mk) => mk,
        None => return Err("Vault is locked. Cannot reset code.".to_string()),
    };
    
    let path = resolve_keychain_path(&app)?;
    let new_code = keychain::reset_recovery_code(&path, master_key).map_err(|e| e.to_string())?;
    Ok(new_code)
}

/// Used for "Open With..." context menu integration on Desktop.
#[tauri::command]
pub fn get_startup_file() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        let path = args[1].clone();
        if !path.starts_with("--") { return Some(path); }
    }
    None
}

/// Copies the keychain.json file to a user-specified location.
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

/// Permanently deletes files.
/// - **Desktop:** Uses "Secure Shredding" (Overwriting data).
/// - **Android:** Uses standard deletion (Shredding damages Flash memory/SD cards).
#[tauri::command]
pub async fn delete_items(app: AppHandle, paths: Vec<String>) -> CommandResult<Vec<BatchItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        
        for path in paths {
            let p = Path::new(&path);
            let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            
            // ANDROID: Standard Delete
            #[cfg(target_os = "android")]
            {
                utils::emit_progress(&app, &format!("Deleting {}", filename), 50);
                // Handle folders vs files
                let res = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
                match res {
                     Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Deleted".into() }),
                     Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            }

            // DESKTOP: Secure Shredding
            #[cfg(not(target_os = "android"))]
            {
                utils::emit_progress(&app, &format!("Preparing to shred {}", filename), 0);
                match utils::shred_recursive(&app, p) {
                    Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Deleted".into() }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e }),
                }
            }
        }
        Ok(results)
    }).await.map_err(|e| e.to_string())?
}

/// Moves files to the Trash/Recycle Bin.
/// - **Desktop:** Moves to OS Trash.
/// - **Android:** Permanently Deletes (Android has no unified Trash).
#[tauri::command]
pub async fn trash_items(app: AppHandle, paths: Vec<String>) -> CommandResult<Vec<BatchItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        
        for path in paths {
            let p = Path::new(&path);
            let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();

            // ANDROID LOGIC
            #[cfg(target_os = "android")]
            {
                utils::emit_progress(&app, &format!("Deleting {}", filename), 50);
                let res = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
                match res {
                     Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Deleted (No Trash on Mobile)".into() }),
                     Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            }

            // DESKTOP LOGIC
            #[cfg(not(target_os = "android"))]
            {
                utils::emit_progress(&app, &format!("Trashing {}", filename), 50);
                match utils::move_to_trash(p) {
                    Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Moved to Trash".into() }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e }),
                }
            }
        }
        Ok(results)
    }).await.map_err(|e| e.to_string())?
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

/// Opens the OS File Explorer and highlights the file.
#[tauri::command]
pub fn show_in_folder(path: String) -> CommandResult<()> {
    // ANDROID: Return Error (Not supported)
    #[cfg(target_os = "android")]
    {
        let _ = path; 
        Err("Reveal in Explorer is not supported on Android".to_string())
    }

    // DESKTOP: Execute OS-specific command
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

/// ENCRYPTS files or folders using the QRE Engine.
/// - **Files:** Uses V5 Streaming Engine (Unlimited Size, Low RAM).
/// - **Folders:** Zips to a temp file, then uses V5 Streaming Engine.
#[tauri::command]
pub async fn lock_file(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>, 
    keyfile_path: Option<String>, 
    keyfile_bytes: Option<Vec<u8>>, 
    extra_entropy: Option<Vec<u8>>,
    compression_mode: Option<String> 
) -> CommandResult<Vec<BatchItemResult>> {
    
    // Retrieve Master Key from RAM
    let master_key = {
        let guard = state.master_key.lock().unwrap();
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked.".to_string()),
        }
    };

    // Hybrid Keyfile Logic:
    // Android sends raw bytes. Desktop sends a file path (for efficiency).
    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
         let mut hasher = Sha256::new();
         hasher.update(&bytes);
         Some(hasher.finalize().to_vec())
    } else {
         utils::process_keyfile(keyfile_path)?
    };

    // Entropy Injection (Mouse movements/Touch data)
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
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            
            utils::emit_progress(&app, &format!("Preparing: {}", filename), 5);

            // --- SMART COMPRESSION LOGIC ---
            // "store" -> Level 0 (No compression)
            // "extreme" -> Level 19 (Max compression, slow)
            // "auto" -> Level 1 (if already compressed media) or Level 3 (if doc/text)
            let level = match mode_str.as_str() {
                "store" => 0,
                "extreme" => 19,
                "auto" | _ => {
                    if is_already_compressed(&filename) {
                        1 // Minimal/Fast for media
                    } else {
                        3 // Balanced for documents
                    }
                }
            };

            // --- INPUT DETERMINATION (File vs Folder) ---
            
            let (input_path_str, is_temp) = if path.is_dir() {
                // FOLDER: Zip it to a temporary file on disk first.
                // This prevents loading the whole folder into RAM.
                let parent = path.parent().unwrap_or(Path::new("."));
                let temp_zip_name = format!("{}.zip", filename);
                let temp_zip_path = utils::get_unique_path(&parent.join(&temp_zip_name));
                
                utils::emit_progress(&app, &format!("Zipping Folder: {}", filename), 10);
                
                if let Err(e) = utils::zip_directory_to_file(path, &temp_zip_path) {
                    results.push(BatchItemResult { name: filename.to_string(), success: false, message: format!("Zip failed: {}", e) });
                    continue;
                }
                
                (temp_zip_path.to_string_lossy().to_string(), true)
            } else {
                // FILE: Encrypt directly.
                (file_path.clone(), false)
            };

            // --- OUTPUT PATH SETUP ---
            let raw_output = format!("{}.qre", file_path);
            let final_path = utils::get_unique_path(Path::new(&raw_output));
            let final_path_str = final_path.to_string_lossy().to_string();

            let app_handle = app.clone();
            let f_name_clone = filename.to_string();
            
            // Progress Callback
            let progress_cb = move |processed: u64, total: u64| {
                if total > 0 {
                    let pct = (processed as f64 / total as f64 * 100.0) as u8;
                    // If using a temp zip, scale progress to 20-100% (0-20% was zipping time)
                    let display_pct = if is_temp { 20 + (pct as f64 * 0.8) as u8 } else { pct };
                    utils::emit_progress(&app_handle, &format!("Encrypting: {}", f_name_clone), display_pct);
                }
            };

            // --- V5 STREAMING ENCRYPTION ---
            let encryption_result = crypto_stream::encrypt_file_stream(
                &input_path_str,
                &final_path_str,
                &master_key,
                keyfile_hash.as_deref(),
                entropy_seed,
                level,
                progress_cb
            );

            // Cleanup Temp Zip if used
            if is_temp {
                let _ = fs::remove_file(&input_path_str);
            }

            match encryption_result {
                Ok(_) => {
                    results.push(BatchItemResult { 
                        name: filename.to_string(), 
                        success: true, 
                        message: "Locked".into() 
                    });
                },
                Err(e) => {
                    let _ = fs::remove_file(&final_path); // Cleanup partial file
                    results.push(BatchItemResult { 
                        name: filename.to_string(), 
                        success: false, 
                        message: e.to_string() 
                    });
                }
            }
        }
        Ok(results)
    }).await.map_err(|e| e.to_string())?
}

/// DECRYPTS files. Automatically detects version (V4 or V5).
#[tauri::command]
pub async fn unlock_file(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>, 
    keyfile_path: Option<String>, 
    keyfile_bytes: Option<Vec<u8>>
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
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            utils::emit_progress(&app, &format!("Checking: {}", filename), 5);

            // --- VERSION DETECTION ---
            let mut file = match fs::File::open(path) {
                Ok(f) => f,
                Err(e) => {
                    results.push(BatchItemResult { name: filename, success: false, message: e.to_string() });
                    continue;
                }
            };
            
            let mut ver_buf = [0u8; 4];
            if let Err(_) = file.read_exact(&mut ver_buf) {
                results.push(BatchItemResult { name: filename, success: false, message: "Invalid file".into() });
                continue;
            }
            let version = u32::from_le_bytes(ver_buf);

            if version == 4 {
                // V4 (Legacy Memory Engine - Backward Compatibility)
                match crypto::EncryptedFileContainer::load(&file_path) {
                    Ok(container) => {
                        utils::emit_progress(&app, &format!("Decrypting (Legacy V4): {}", filename), 50);
                        match crypto::decrypt_file_with_master_key(&master_key, keyfile_hash.as_deref(), &container) {
                            Ok(payload) => {
                                utils::emit_progress(&app, &format!("Writing: {}", payload.filename), 80);
                                let parent = Path::new(&file_path).parent().unwrap_or(Path::new("."));
                                let original_path = parent.join(&payload.filename);
                                let final_path = utils::get_unique_path(&original_path);
                                if let Err(e) = fs::write(&final_path, &payload.content) {
                                    let _ = fs::remove_file(&final_path);
                                    results.push(BatchItemResult { name: filename, success: false, message: e.to_string() });
                                } else {
                                    results.push(BatchItemResult { name: filename, success: true, message: "Unlocked".into() });
                                }
                            },
                            Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                        }
                    },
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            } else if version == 5 {
                // V5 (Streaming Engine - Standard)
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
                    progress_cb
                ) {
                    Ok(out_name) => results.push(BatchItemResult { name: filename, success: true, message: format!("Unlocked: {}", out_name) }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            } else {
                results.push(BatchItemResult { name: filename, success: false, message: format!("Unsupported Version: {}", version) });
            }
        }
        Ok(results)
    }).await.map_err(|e| e.to_string())?
}