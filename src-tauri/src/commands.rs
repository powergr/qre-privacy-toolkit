use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// Fix: Only import Command on Desktop
#[cfg(not(target_os = "android"))]
use std::process::Command;

#[cfg(not(target_os = "android"))]
use sysinfo::Disks;

use crate::crypto;
use crate::keychain;
use crate::state::SessionState;
use crate::utils;

type CommandResult<T> = Result<T, String>;

#[derive(serde::Serialize)]
pub struct BatchItemResult {
    pub name: String,
    pub success: bool,
    pub message: String,
}

// --- HELPER: Resolve Keychain Path ---
fn resolve_keychain_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    if !data_dir.exists() {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }

    Ok(data_dir.join("keychain.json"))
}

// --- NEW COMMAND: Get Keychain Data (For Android Backup) ---
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

    // Auto-login
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
                // FIX: Check if directory or file
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
                // FIX: Check if directory or file (Mapped Trash -> Delete for Android)
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
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    {
        let p = Path::new(&path);
        let parent = p.parent().unwrap_or(p);
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    // FIX: Return explicit error on Android instead of silent failure
    #[cfg(target_os = "android")]
    {
        // Use the path variable to suppress unused warning
        let _ = path;
        return Err("Reveal in Explorer is not supported on Android".to_string());
    }

    #[cfg(not(target_os = "android"))]
    Ok(())
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

    let compression_level = match compression_mode.as_deref() {
        Some("fast") => 1,
        Some("best") => 15,
        _ => 3,
    };

    let entropy_seed = if let Some(bytes) = extra_entropy {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().into())
    } else {
        None
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

            utils::emit_progress(&app, &format!("Processing: {}", filename), 10);

            if let Err(e) = utils::check_size_limit(path) {
                results.push(BatchItemResult {
                    name: filename,
                    success: false,
                    message: e,
                });
                continue;
            }

            utils::emit_progress(&app, &format!("Loading: {}", filename), 30);

            let original_name = filename.to_string();
            let stored_filename = if path.is_dir() {
                format!("{}.zip", original_name)
            } else {
                original_name.clone()
            };

            let data_result = if path.is_dir() {
                utils::zip_directory_to_memory(path)
            } else {
                fs::read(path).map_err(|e| e.to_string())
            };

            match data_result {
                Ok(file_bytes) => {
                    utils::emit_progress(&app, &format!("Encrypting: {}", filename), 60);

                    match crypto::encrypt_file_with_master_key(
                        &master_key,
                        keyfile_hash.as_deref(),
                        &stored_filename,
                        &file_bytes,
                        entropy_seed,
                        compression_level,
                    ) {
                        Ok(container) => {
                            utils::emit_progress(&app, &format!("Saving: {}", filename), 90);

                            let raw_output = format!("{}.qre", file_path);
                            let final_path = utils::get_unique_path(Path::new(&raw_output));
                            let final_str = final_path.to_string_lossy().to_string();

                            if let Err(e) = container.save(&final_str) {
                                let _ = fs::remove_file(&final_str);
                                results.push(BatchItemResult {
                                    name: filename,
                                    success: false,
                                    message: format!("Failed to write encrypted file: {}", e),
                                });
                            } else {
                                results.push(BatchItemResult {
                                    name: filename,
                                    success: true,
                                    message: "Locked".into(),
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
            utils::emit_progress(&app, &format!("Unlocking: {}", filename), 20);

            match crypto::EncryptedFileContainer::load(&file_path) {
                Ok(container) => {
                    utils::emit_progress(&app, &format!("Decrypting: {}", filename), 50);

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

                            let parent = Path::new(&file_path).parent().unwrap_or(Path::new("."));
                            let original_path = parent.join(&payload.filename);
                            let final_path = utils::get_unique_path(&original_path);
                            if let Err(e) = fs::write(&final_path, &payload.content) {
                                let _ = fs::remove_file(&final_path);
                                results.push(BatchItemResult {
                                    name: filename,
                                    success: false,
                                    message: format!("Failed to write decrypted file: {}", e),
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
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}