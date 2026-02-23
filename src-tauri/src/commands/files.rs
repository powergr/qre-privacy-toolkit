use crate::crypto;
use crate::crypto_stream;
use crate::shredder;
use crate::state::SessionState;
use crate::utils;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path};
use tauri::AppHandle;

#[cfg(not(target_os = "android"))]
use std::process::Command;

#[cfg(not(target_os = "android"))]
use sysinfo::Disks;

pub type CommandResult<T> = Result<T, String>;

#[derive(serde::Serialize)]
pub struct BatchItemResult {
    pub name: String,
    pub success: bool,
    pub message: String,
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

// --- HELPER: Path Traversal Check ---
/// Returns an error if the path contains any `..` (parent directory) components.
/// Used to prevent directory traversal in commands that accept user-supplied paths.
fn reject_path_traversal(path: &Path) -> Result<(), String> {
    if path.components().any(|c| c == Component::ParentDir) {
        return Err("Path traversal not allowed: path must not contain '..'".to_string());
    }
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

    // FIX: Keep the raw entropy bytes here. We will derive a *unique* seed per
    // file inside the loop by mixing in the file index. Previously, the same
    // hashed seed was passed to every file in the batch, causing every file to
    // receive the same file-encryption key and nonces — a critical reuse bug.
    let raw_entropy: Option<Vec<u8>> = extra_entropy;

    let mode_str = compression_mode.unwrap_or("auto".to_string());

    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for (file_index, file_path) in file_paths.into_iter().enumerate() {
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

            // FIX: Derive a unique per-file entropy seed by hashing the raw
            // entropy together with the file's index in the batch. This ensures
            // every file gets a distinct RNG state even in paranoid-mode batch
            // operations, preventing file-key and nonce reuse across the batch.
            let entropy_seed: Option<[u8; 32]> = raw_entropy.as_ref().map(|bytes| {
                let mut hasher = Sha256::new();
                hasher.update(bytes);
                hasher.update(&(file_index as u64).to_le_bytes());
                hasher.finalize().into()
            });

            let app_handle = app.clone();
            let f_name_clone = filename.to_string();

            let progress_cb = move |processed: u64, total: u64| {
                if total > 0 {
                    let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                    let display_pct = if is_temp {
                        20u8.saturating_add((pct as f64 * 0.8) as u8).min(100)
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
                        let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
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

/// Renames a file or directory to a new name within the same parent directory.
///
/// FIX: `new_name` is validated to reject path separators and parent-directory
/// references. Without this check a caller could supply e.g. `../../etc/passwd`
/// as the new name and rename the target outside the intended directory.
#[tauri::command]
pub fn rename_item(path: String, new_name: String) -> CommandResult<()> {
    // FIX: Reject names that contain path separators or are parent-directory references.
    if new_name.is_empty()
        || new_name == "."
        || new_name == ".."
        || new_name.contains('/')
        || new_name.contains('\\')
    {
        return Err(
            "Invalid name: must not be empty, '.', '..', or contain path separators".to_string(),
        );
    }

    let old_path = Path::new(&path);
    let parent = old_path.parent().ok_or("Invalid path")?;
    let new_path = parent.join(&new_name);
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

// --- HELPER COMMANDS FOR IMPORT/EXPORT ---

/// Reads the full text content of a file at the given path.
///
/// FIX: Rejects paths containing `..` (parent-directory) components to prevent
/// a malicious or buggy caller from reading arbitrary files on the system
/// (e.g. `../../etc/passwd` or sensitive app-data files outside the vault).
#[tauri::command]
pub fn read_text_file_content(path: String) -> CommandResult<String> {
    reject_path_traversal(Path::new(&path))?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes text content to a file at the given path.
///
/// FIX: Rejects paths containing `..` (parent-directory) components to prevent
/// a malicious or buggy caller from overwriting arbitrary files outside the
/// intended directory (e.g. overwriting a system config file).
#[tauri::command]
pub fn write_text_file_content(path: String, content: String) -> CommandResult<()> {
    reject_path_traversal(Path::new(&path))?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// --- SHREDDER COMMANDS ---

#[tauri::command]
pub async fn dry_run_shred(paths: Vec<String>) -> CommandResult<shredder::DryRunResult> {
    shredder::dry_run(paths).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn batch_shred_files(
    paths: Vec<String>,
    method: shredder::ShredMethod,
    app_handle: tauri::AppHandle,
) -> CommandResult<shredder::ShredResult> {
    shredder::batch_shred(paths, method, &app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_shred() -> CommandResult<()> {
    shredder::cancel_shred();
    Ok(())
}

// --- SYSTEM UTILS ---

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
