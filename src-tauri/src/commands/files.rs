// --- START OF FILE files.rs ---

use crate::crypto;
use crate::crypto_stream;
use crate::shredder;
use crate::state::SessionState;
use crate::utils;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
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

pub(crate) fn is_system_critical(path: &Path) -> bool {
    let path_str = path.to_string_lossy().to_lowercase();

    if cfg!(target_os = "windows") {
        if path_str.starts_with("c:\\windows")
            || path_str.starts_with("c:\\program files")
            || path_str.starts_with("c:\\program files (x86)")
            || path_str == "c:\\"
        {
            return true;
        }
    } else {
        let critical = [
            "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/etc", "/var", "/boot", "/proc", "/sys", "/dev",
        ];
        if critical.iter().any(|c| path_str.starts_with(c)) || path_str == "/" {
            return true;
        }
    }
    false
}

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

pub(crate) fn reject_path_traversal(path: &Path) -> Result<(), String> {
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
    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    let raw_entropy: Option<Vec<u8>> = extra_entropy;
    let mode_str = compression_mode.unwrap_or("auto".to_string());

    let vaults_arc = state.vaults.clone();
    let portable_mounts_arc = state.portable_mounts.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for (file_index, file_path) in file_paths.into_iter().enumerate() {
            let path = Path::new(&file_path);

            if let Err(e) = reject_critical_path(path) {
                results.push(BatchItemResult { name: path.to_string_lossy().to_string(), success: false, message: e });
                continue;
            }

            {
                let mounts = portable_mounts_arc.lock().unwrap_or_else(|e| e.into_inner());
                let path_lower = path.to_string_lossy().to_lowercase();
                if mounts.keys().any(|m| path_lower.starts_with(&m.to_lowercase())) {
                    results.push(BatchItemResult {
                        name: path.to_string_lossy().to_string(),
                        success: false,
                        message: "Ghost-file protection: files on a portable USB drive cannot be encrypted directly. Copy the file to your PC first, encrypt it there, then move the .qre file to the USB drive.".to_string(),
                    });
                    continue;
                }
            }

            let vault_id = "local".to_string();

            let master_key = {
                let guard = match vaults_arc.lock() {
                    Ok(g) => g,
                    Err(poisoned) => {
                        let mut p = poisoned.into_inner();
                        p.clear();
                        return Err("Session state corrupted.".to_string());
                    }
                };
                match guard.get(&vault_id) {
                    Some(mk) => mk.clone(),
                    None => {
                        results.push(BatchItemResult { name: path.to_string_lossy().to_string(), success: false, message: format!("Vault '{}' is locked.", vault_id) });
                        continue;
                    }
                }
            };

            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            utils::emit_progress(&app, &format!("Preparing: {}", filename), 5);

            let level = match mode_str.as_str() {
                "store" => 0,
                "extreme" => 19,
                _ => { if is_already_compressed(&filename) { 1 } else { 3 } }
            };

            let (input_path_str, is_temp) = if path.is_dir() {
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
                (file_path.clone(), false)
            };

            let raw_output = format!("{}.qre", file_path);
            let final_path = utils::get_unique_path(Path::new(&raw_output));
            let final_path_str = final_path.to_string_lossy().to_string();

            let entropy_seed: Option<[u8; 32]> = raw_entropy.as_ref().map(|bytes| {
                let mut hasher = Sha256::new();
                hasher.update(bytes);
                hasher.update((file_index as u64).to_le_bytes());
                hasher.finalize().into()
            });

            let app_handle = app.clone();
            let f_name_clone = filename.to_string();

            let progress_cb = move |processed: u64, total: u64| {
                if total > 0 {
                    let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                    let display_pct = if is_temp { 20u8.saturating_add((pct as f64 * 0.8) as u8).min(100) } else { pct };
                    utils::emit_progress(&app_handle, &format!("Encrypting: {}", f_name_clone), display_pct);
                }
            };

            let encryption_result = crypto_stream::encrypt_file_stream(
                &input_path_str, &final_path_str, &master_key, &vault_id, keyfile_hash.as_deref(), entropy_seed, level, progress_cb,
            );

            if is_temp { let _ = fs::remove_file(&input_path_str); }

            match encryption_result {
                Ok(_) => results.push(BatchItemResult { name: filename.to_string(), success: true, message: "Locked".into() }),
                Err(e) => {
                    let _ = fs::remove_file(&final_path);
                    results.push(BatchItemResult { name: filename.to_string(), success: false, message: e.to_string() });
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
    output_dir: Option<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    let vaults_arc = state.vaults.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for file_path in file_paths {
            let path = Path::new(&file_path);
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();

            utils::emit_progress(&app, &format!("Checking: {}", filename), 5);

            let mut file = match fs::File::open(path) {
                Ok(f) => f,
                Err(e) => { results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }); continue; }
            };

            let mut ver_buf = [0u8; 4];
            if file.read_exact(&mut ver_buf).is_err() {
                results.push(BatchItemResult { name: filename, success: false, message: "Invalid file".into() });
                continue;
            }
            let version = u32::from_le_bytes(ver_buf);

            let target_dir_path = match &output_dir {
                Some(dir) => std::path::PathBuf::from(dir),
                None => path.parent().unwrap_or(Path::new(".")).to_path_buf(),
            };
            let target_dir_str = target_dir_path.to_string_lossy().to_string();

            if version == 4 {
                let master_key = {
                    let guard = vaults_arc.lock().unwrap();
                    match guard.get("local") {
                        Some(mk) => mk.clone(),
                        None => {
                            results.push(BatchItemResult { name: filename.clone(), success: false, message: "Local Vault is locked.".to_string() });
                            continue;
                        }
                    }
                };

                match crypto::EncryptedFileContainer::load(&file_path) {
                    Ok(container) => {
                        utils::emit_progress(&app, &format!("Decrypting: {}", filename), 50);
                        match crypto::decrypt_file_with_master_key(&master_key, keyfile_hash.as_deref(), &container) {
                            Ok(payload) => {
                                utils::emit_progress(&app, &format!("Writing: {}", payload.filename), 80);
                                let final_path = utils::get_unique_path(&target_dir_path.join(&payload.filename));

                                if let Err(e) = fs::write(&final_path, &payload.content) {
                                    let _ = fs::remove_file(&final_path);
                                    results.push(BatchItemResult { name: filename, success: false, message: e.to_string() });
                                } else {
                                    results.push(BatchItemResult { name: filename, success: true, message: "Unlocked".into() });
                                }
                            }
                            Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                        }
                    }
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            } else if version == 5 {
                let header: Result<crypto_stream::StreamHeader, _> = bincode::deserialize_from(&mut file);
                let vault_id = match header {
                    Ok(h) => h.vault_id.unwrap_or_else(|| "local".to_string()),
                    Err(_) => "local".to_string(), 
                };

                let master_key = {
                    let guard = vaults_arc.lock().unwrap();
                    match guard.get(&vault_id) {
                        Some(mk) => mk.clone(),
                        None => {
                            results.push(BatchItemResult { 
                                name: filename.clone(), 
                                success: false, 
                                message: if vault_id == "local" { "Local Vault is locked.".to_string() } else { "This file belongs to a Portable USB Vault. Please unlock the USB drive first.".to_string() }
                            });
                            continue;
                        }
                    }
                };

                let app_handle = app.clone();
                let f_name = filename.clone();

                let progress_cb = move |processed: u64, total: u64| {
                    if total > 0 {
                        let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                        utils::emit_progress(&app_handle, &format!("Decrypting: {}", f_name), pct);
                    }
                };

                match crypto_stream::decrypt_file_stream(&file_path, &target_dir_str, &master_key, keyfile_hash.as_deref(), progress_cb) {
                    Ok(out_name) => results.push(BatchItemResult { name: filename, success: true, message: format!("Unlocked: {}", out_name) }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            } else {
                results.push(BatchItemResult { name: filename, success: false, message: format!("Unsupported Version: {}", version) });
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

            if let Err(e) = reject_critical_path(p) {
                results.push(BatchItemResult { name: p.to_string_lossy().to_string(), success: false, message: e });
                continue;
            }

            let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();

            #[cfg(target_os = "android")]
            {
                utils::emit_progress(&app, &format!("Deleting {}", filename), 50);
                let res = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
                match res {
                    Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Deleted".into() }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            }

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

            if let Err(e) = reject_critical_path(p) {
                results.push(BatchItemResult { name: p.to_string_lossy().to_string(), success: false, message: e });
                continue;
            }

            let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();

            #[cfg(target_os = "android")]
            {
                utils::emit_progress(&app, &format!("Deleting {}", filename), 50);
                let res = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
                match res {
                    Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Deleted (No Trash)".into() }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            }

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
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn paste_items(
    app: AppHandle,
    sources: Vec<String>,
    dest_dir: String,
    is_cut: bool,
) -> CommandResult<Vec<BatchItemResult>> {
    
    // FIX: Clone dest_dir into a PathBuf so it can be moved into the thread
    let dest_base = PathBuf::from(dest_dir);

    // Initial sanity check before thread
    reject_critical_path(&dest_base)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        
        for src_str in sources {
            let src = Path::new(&src_str);
            
            if let Err(e) = reject_critical_path(src) {
                results.push(BatchItemResult { name: src.to_string_lossy().to_string(), success: false, message: e });
                continue;
            }
            
            let filename = src.file_name().unwrap_or_default();
            let dest = utils::get_unique_path(&dest_base.join(filename));

            utils::emit_progress(&app, &format!("Pasting: {}", filename.to_string_lossy()), 50);

            if is_cut {
                if fs::rename(src, &dest).is_ok() {
                    results.push(BatchItemResult { name: filename.to_string_lossy().to_string(), success: true, message: "Moved".into() });
                    continue;
                }
            }

            let res = if src.is_dir() {
                copy_dir_recursive(src, &dest)
            } else {
                fs::copy(src, &dest).map(|_| ())
            };

            match res {
                Ok(_) => {
                    if is_cut {
                        let _ = if src.is_dir() { fs::remove_dir_all(src) } else { fs::remove_file(src) };
                    }
                    results.push(BatchItemResult { name: filename.to_string_lossy().to_string(), success: true, message: "Copied".into() });
                }
                Err(e) => results.push(BatchItemResult { name: filename.to_string_lossy().to_string(), success: false, message: e.to_string() }),
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
    if new_name.is_empty() || new_name == "." || new_name == ".." || new_name.contains('/') || new_name.contains('\\') {
        return Err("Invalid name".to_string());
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
        Command::new("explorer").args(["/select,", &path]).spawn().map_err(|e| e.to_string())?;

        #[cfg(target_os = "linux")]
        {
            let p = Path::new(&path);
            let parent = p.parent().unwrap_or(p);
            Command::new("xdg-open").arg(parent).spawn().map_err(|e| e.to_string())?;
        }

        #[cfg(target_os = "macos")]
        Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;

        Ok(())
    }
}

// --- HELPER COMMANDS FOR IMPORT/EXPORT ---

#[tauri::command]
pub fn read_text_file_content(path: String) -> CommandResult<String> {
    reject_path_traversal(Path::new(&path))?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

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
    for path in &paths {
        reject_critical_path(Path::new(path))?;
    }
    shredder::batch_shred(paths, method, &app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_shred() -> CommandResult<()> {
    shredder::cancel_shred();
    Ok(())
}

#[tauri::command]
pub async fn wipe_free_space(
    drive_path: String,
    app_handle: tauri::AppHandle,
) -> CommandResult<shredder::WipeFreeSpaceResult> {
    #[cfg(target_os = "android")]
    {
        let _ = drive_path;
        let _ = app_handle;
        Err("Free space wiping is not supported on Android.".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        reject_critical_path(Path::new(&drive_path))?;
        shredder::wipe_free_space(drive_path, &app_handle).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn trim_drive(drive_path: String) -> CommandResult<shredder::TrimResult> {
    #[cfg(target_os = "android")]
    {
        let _ = drive_path;
        Err("TRIM is managed automatically by the Android OS.".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        reject_critical_path(Path::new(&drive_path))?;
        shredder::trim_drive(drive_path).map_err(|e| e.to_string())
    }
}

// --- SYSTEM UTILS ---

#[tauri::command]
pub fn get_drives(_app: AppHandle) -> Vec<String> {
    let mut drives = Vec::new();
    
    #[cfg(not(target_os = "android"))]
    {
        let disks = Disks::new_with_refreshed_list();
        for disk in disks.list() {
            // SECURITY: Do NOT call app.fs_scope().allow_directory() here.
            // We only return the strings for the UI. The user cannot browse
            // C:\ or D:\ unless those paths are specifically allowed in default.json.
            // Only USB drives unlocked via portable.rs will inject into fs:scope.
            drives.push(disk.mount_point().to_string_lossy().to_string());
        }
    }
    
    #[cfg(target_os = "android")]
    {
        drives.push("/storage/emulated/0".to_string());
    }
    
    drives
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