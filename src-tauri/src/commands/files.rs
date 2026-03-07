// --- START OF FILE files.rs ---

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

// Platform-specific imports for desktop platforms (Windows, macOS, Linux)
#[cfg(not(target_os = "android"))]
use std::process::Command;

#[cfg(not(target_os = "android"))]
use sysinfo::Disks;

/// Standardized result type for Tauri commands in this module, mapping errors to Strings.
pub type CommandResult<T> = Result<T, String>;

/// Represents the outcome of processing a single file during a batch operation (e.g., lock, unlock, delete).
#[derive(serde::Serialize)]
pub struct BatchItemResult {
    pub name: String,
    pub success: bool,
    pub message: String,
}

// --- HELPER: Smart Compression Detection ---

/// Checks if a file is likely already compressed based on its extension.
/// This prevents wasting CPU cycles trying to compress formats that are already highly compressed
/// (like archives, images, and videos) before encrypting them.
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn is_already_compressed(filename: &str) -> bool {
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

// --- HELPER: Path Security Checks ---

/// Checks if a path is a critical OS directory.
/// Acts as a safety net to prevent users (or malicious payloads) from accidentally
/// encrypting, deleting, or shredding files essential to the operating system.
pub(crate) fn is_system_critical(path: &Path) -> bool {
    let path_str = path.to_string_lossy().to_lowercase();

    // Windows Critical Paths
    if cfg!(target_os = "windows") {
        if path_str.starts_with("c:\\windows")
            || path_str.starts_with("c:\\program files")
            || path_str.starts_with("c:\\program files (x86)")
            || path_str == "c:\\"
        {
            // Block root C: lock to avoid crippling the drive
            return true;
        }
    }
    // Linux/macOS Critical Paths
    else {
        let critical = [
            "/bin",
            "/sbin",
            "/usr/bin",
            "/usr/sbin",
            "/etc",
            "/var",
            "/boot",
            "/proc",
            "/sys",
            "/dev",
        ];
        if critical.iter().any(|c| path_str.starts_with(c)) || path_str == "/" {
            return true;
        }
    }
    false
}

/// Comprehensive path security check: blocks path traversal ('..') and system critical paths.
pub(crate) fn reject_critical_path(path: &Path) -> Result<(), String> {
    if path.components().any(|c| c == Component::ParentDir) {
        return Err("Path traversal not allowed: path must not contain '..'".to_string());
    }
    if is_system_critical(path) {
        return Err(format!(
            "Access Denied: '{}' is a protected system path.",
            path.display()
        ));
    }
    Ok(())
}

/// Basic path traversal check: ensures operations don't escape their intended directory using '..'.
pub(crate) fn reject_path_traversal(path: &Path) -> Result<(), String> {
    if path.components().any(|c| c == Component::ParentDir) {
        return Err("Path traversal not allowed: path must not contain '..'".to_string());
    }
    Ok(())
}

// --- CRYPTO LOGIC ---

/// Tauri command to encrypt a batch of files/directories.
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
    // 1. Retrieve the master key from the active session state.
    let master_key = {
        let guard = state.master_key.lock().unwrap_or_else(|e| e.into_inner());
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked.".to_string()),
        }
    };

    // 2. Process the keyfile (if provided) into a SHA-256 hash to combine with the master key.
    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    let raw_entropy: Option<Vec<u8>> = extra_entropy;
    let mode_str = compression_mode.unwrap_or("auto".to_string());

    // 3. Move the heavy lifting into a background blocking thread to prevent freezing the Tauri UI.
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for (file_index, file_path) in file_paths.into_iter().enumerate() {
            let path = Path::new(&file_path);

            // SECURITY CHECK: Ensure we aren't locking OS files.
            if let Err(e) = reject_critical_path(path) {
                results.push(BatchItemResult {
                    name: path.to_string_lossy().to_string(),
                    success: false,
                    message: e,
                });
                continue;
            }

            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            utils::emit_progress(&app, &format!("Preparing: {}", filename), 5);

            // 4. Determine Zstd compression level.
            let level = match mode_str.as_str() {
                "store" => 0,    // No compression
                "extreme" => 19, // Max compression (slow)
                _ => {
                    if is_already_compressed(&filename) {
                        1 // Minimal compression if the file format is already dense
                    } else {
                        3 // Default Zstd level
                    }
                }
            };

            // 5. If the target is a directory, zip it into a temporary archive first.
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
                    continue; // Skip to the next file if zipping fails
                }

                (temp_zip_path.to_string_lossy().to_string(), true)
            } else {
                (file_path.clone(), false)
            };

            // 6. Define output file path (*.qre)
            let raw_output = format!("{}.qre", file_path);
            let final_path = utils::get_unique_path(Path::new(&raw_output));
            let final_path_str = final_path.to_string_lossy().to_string();

            // 7. Mix extra entropy with the file index to create a unique seed per file.
            let entropy_seed: Option<[u8; 32]> = raw_entropy.as_ref().map(|bytes| {
                let mut hasher = Sha256::new();
                hasher.update(bytes);
                hasher.update((file_index as u64).to_le_bytes()); // Ensure different seed per file in batch
                hasher.finalize().into()
            });

            let app_handle = app.clone();
            let f_name_clone = filename.to_string();

            // 8. Progress callback for the frontend UI
            let progress_cb = move |processed: u64, total: u64| {
                if total > 0 {
                    let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                    // Adjust progress scale if we spent time zipping earlier
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

            // 9. Execute Stream Encryption
            let encryption_result = crypto_stream::encrypt_file_stream(
                &input_path_str,
                &final_path_str,
                &master_key,
                keyfile_hash.as_deref(),
                entropy_seed,
                level,
                progress_cb,
            );

            // Cleanup the temporary zip file if we created one
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
                    // Cleanup the partially written output file if encryption fails
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

/// Tauri command to decrypt a batch of files.
#[tauri::command]
pub async fn unlock_file(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>,
    keyfile_path: Option<String>,
    keyfile_bytes: Option<Vec<u8>>,
) -> CommandResult<Vec<BatchItemResult>> {
    // 1. Retrieve the master key from the active session state.
    let master_key = {
        let guard = state.master_key.lock().unwrap_or_else(|e| e.into_inner());
        match &*guard {
            Some(mk) => mk.clone(),
            None => return Err("Vault is locked.".to_string()),
        }
    };

    // 2. Process the keyfile hash.
    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    // 3. Move the heavy lifting into a background thread.
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

            // 4. Read the file's Magic Version Bytes to figure out how to decrypt it.
            let mut ver_buf = [0u8; 4];
            if file.read_exact(&mut ver_buf).is_err() {
                results.push(BatchItemResult {
                    name: filename,
                    success: false,
                    message: "Invalid file".into(),
                });
                continue;
            }
            let version = u32::from_le_bytes(ver_buf);

            // Handle V4 (Legacy full-in-memory encryption)
            if version == 4 {
                match crypto::EncryptedFileContainer::load(&file_path) {
                    Ok(container) => {
                        utils::emit_progress(
                            &app,
                            &format!("Decrypting (Legacy V4): {}", filename),
                            50,
                        );
                        // Decrypt entirely in memory
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

                                // Write decrypted payload to disk
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
            }
            // Handle V5 (Current stream-based chunked encryption)
            else if version == 5 {
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

                // Decrypt file as a stream directly to disk (memory efficient)
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
                // Unsupported version format
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

/// Irreversibly deletes (or shreds on desktop) a batch of files/folders.
#[tauri::command]
pub async fn delete_items(
    app: AppHandle,
    paths: Vec<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for path in paths {
            let p = Path::new(&path);

            // SECURITY CHECK: Protect against deleting OS files
            if let Err(e) = reject_critical_path(p) {
                results.push(BatchItemResult {
                    name: p.to_string_lossy().to_string(),
                    success: false,
                    message: e,
                });
                continue;
            }

            let filename = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // On Android, we do a standard hard deletion (shredding usually ineffective on Flash storage/Android limitations).
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

            // On Desktop, trigger a recursive shred before deletion.
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

/// Moves a batch of files to the system recycle bin / trash (desktop only).
#[tauri::command]
pub async fn trash_items(
    app: AppHandle,
    paths: Vec<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for path in paths {
            let p = Path::new(&path);

            // SECURITY CHECK
            if let Err(e) = reject_critical_path(p) {
                results.push(BatchItemResult {
                    name: p.to_string_lossy().to_string(),
                    success: false,
                    message: e,
                });
                continue;
            }

            let filename = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // Android lacks a unified "Trash" system accessible via standard API, fallback to standard delete
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

            // Move to system trash using the trash crate (or similar utility)
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

/// Creates a new directory at the specified path (including parent directories).
#[tauri::command]
pub fn create_dir(path: String) -> CommandResult<()> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Renames a file or folder in place, ensuring the new name is valid.
#[tauri::command]
pub fn rename_item(path: String, new_name: String) -> CommandResult<()> {
    // Validate the new name to prevent path traversal or moving files to unintended directories.
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

/// Opens the system's native file explorer and selects the file.
#[tauri::command]
pub fn show_in_folder(path: String) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        let _ = path;
        Err("Reveal in Explorer is not supported on Android".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        // OS-specific commands to open the file explorer and select the item.
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
                .arg(parent) // xdg-open doesn't select files natively, opens the directory instead
                .spawn()
                .map_err(|e| e.to_string())?;
        }

        #[cfg(target_os = "macos")]
        Command::new("open")
            .args(["-R", &path]) // The -R flag in macOS 'open' reveals the file in Finder
            .spawn()
            .map_err(|e| e.to_string())?;

        Ok(())
    }
}

// --- HELPER COMMANDS FOR IMPORT/EXPORT ---

/// Reads the contents of a text file. Used mostly for importing configuration/keys.
#[tauri::command]
pub fn read_text_file_content(path: String) -> CommandResult<String> {
    reject_path_traversal(Path::new(&path))?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes string content to a text file. Used mostly for exporting configuration/keys.
#[tauri::command]
pub fn write_text_file_content(path: String, content: String) -> CommandResult<()> {
    reject_path_traversal(Path::new(&path))?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// --- SHREDDER COMMANDS ---

/// Performs a dry run to calculate how many files/bytes will be shredded without actually altering data.
#[tauri::command]
pub async fn dry_run_shred(paths: Vec<String>) -> CommandResult<shredder::DryRunResult> {
    shredder::dry_run(paths).map_err(|e| e.to_string())
}

/// Securely overwrites (shreds) a batch of files/folders based on a specific algorithm (e.g., DOD 5220.22-M).
#[tauri::command]
pub async fn batch_shred_files(
    paths: Vec<String>,
    method: shredder::ShredMethod,
    app_handle: tauri::AppHandle,
) -> CommandResult<shredder::ShredResult> {
    // SECURITY CHECK: Pre-verify all paths in the batch before starting the shred operation.
    // We don't want to start shredding 3 valid files and accidentally shred C:\Windows on the 4th.
    for path in &paths {
        reject_critical_path(Path::new(path))?;
    }

    shredder::batch_shred(paths, method, &app_handle).map_err(|e| e.to_string())
}

/// Signals the active shredding thread to abort its operation early.
#[tauri::command]
pub async fn cancel_shred() -> CommandResult<()> {
    shredder::cancel_shred();
    Ok(())
}

// --- SYSTEM UTILS ---

/// Retrieves the available mount points/drives on the system to populate a file explorer UI.
#[tauri::command]
pub fn get_drives() -> Vec<String> {
    #[cfg(not(target_os = "android"))]
    {
        // Query system disks dynamically (e.g. C:\, D:\ on Windows, / on Unix)
        let disks = Disks::new_with_refreshed_list();
        disks
            .list()
            .iter()
            .map(|disk| disk.mount_point().to_string_lossy().to_string())
            .collect()
    }
    #[cfg(target_os = "android")]
    {
        // Hardcode standard Android user storage location
        vec!["/storage/emulated/0".to_string()]
    }
}

/// Grabs the file path passed via command-line arguments when the application was opened
/// (e.g., "Open With..." from the OS context menu).
#[tauri::command]
pub fn get_startup_file() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        let path = args[1].clone();
        // Ignore Tauri/Chromium CLI flags
        if !path.starts_with("--") {
            return Some(path);
        }
    }
    None
}
// --- END OF FILE files.rs ---
