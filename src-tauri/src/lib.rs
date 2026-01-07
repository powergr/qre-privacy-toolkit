mod crypto;
mod entropy;
mod secure_rng;
mod keychain;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::io::Write; 
use walkdir::WalkDir; 
use sysinfo::{Disks}; 
use uuid::Uuid;
use std::process::Command;
use zip::write::SimpleFileOptions;

type CommandResult<T> = Result<T, String>;

struct SessionState {
    master_key: Arc<Mutex<Option<keychain::MasterKey>>>,
}

const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024 * 1024; 

fn check_file_size(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|_| "File not found".to_string())?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!("File too large (>4GB)."));
    }
    Ok(())
}

fn read_keyfile(path_opt: Option<String>) -> Result<Option<Vec<u8>>, String> {
    match path_opt {
        Some(p) => {
            if p.trim().is_empty() { return Ok(None); }
            let path = Path::new(&p);
            if fs::metadata(path).map_err(|e| e.to_string())?.len() > 10 * 1024 * 1024 {
                return Err("Keyfile too large (>10MB).".to_string());
            }
            let bytes = fs::read(path).map_err(|e| format!("Failed to read keyfile: {}", e))?;
            Ok(Some(bytes))
        },
        None => Ok(None),
    }
}

fn get_unique_path(original_path: &Path) -> PathBuf {
    if !original_path.exists() { return original_path.to_path_buf(); }
    let file_stem = original_path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = original_path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let parent = original_path.parent().unwrap_or(Path::new("."));
    let mut counter = 1;
    loop {
        let new_name = format!("{} ({}){}", file_stem, counter, extension);
        let new_path = parent.join(new_name);
        if !new_path.exists() { return new_path; }
        counter += 1;
    }
}

fn zip_directory(dir_path: &Path, output_path: &Path) -> Result<(), String> {
    let file = fs::File::create(output_path).map_err(|e| format!("Could not create temp zip: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    let prefix = dir_path.parent().unwrap_or(Path::new(""));

    for entry in WalkDir::new(dir_path) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = path.strip_prefix(prefix)
            .map_err(|_| "Path error")?
            .to_str()
            .ok_or("Non-UTF8 path")?
            .replace("\\", "/"); 

        if path.is_file() {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            let buffer = fs::read(path).map_err(|e| e.to_string())?;
            zip.write_all(&buffer).map_err(|e| e.to_string())?;
        } else if path.is_dir() && !name.is_empty() {
            zip.add_directory(name, options).map_err(|e| e.to_string())?;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// --- Tauri Commands ---

#[tauri::command]
fn get_drives() -> Vec<String> {
    let disks = Disks::new_with_refreshed_list();
    disks.list().iter()
        .map(|disk| disk.mount_point().to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
fn check_auth_status(state: tauri::State<SessionState>) -> String {
    let guard = state.master_key.lock().unwrap();
    if guard.is_some() {
        "unlocked".to_string()
    } else if keychain::keychain_exists() {
        "locked".to_string()
    } else {
        "setup_needed".to_string()
    }
}

#[tauri::command]
fn init_vault(password: String) -> CommandResult<String> {
    let (recovery_code, _mk) = keychain::init_keychain(&password).map_err(|e| e.to_string())?;
    Ok(recovery_code)
}

#[tauri::command]
fn login(password: String, state: tauri::State<SessionState>) -> CommandResult<String> {
    let master_key = keychain::unlock_keychain(&password).map_err(|e| e.to_string())?;
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);
    Ok("Logged in".to_string())
}

#[tauri::command]
fn logout(state: tauri::State<SessionState>) {
    let mut guard = state.master_key.lock().unwrap();
    *guard = None;
}

#[tauri::command]
fn change_user_password(new_password: String, state: tauri::State<SessionState>) -> CommandResult<String> {
    let guard = state.master_key.lock().unwrap();
    let master_key = match &*guard {
        Some(mk) => mk,
        None => return Err("Vault is locked.".to_string()),
    };
    keychain::change_password(master_key, &new_password).map_err(|e| e.to_string())?;
    Ok("Password changed successfully.".to_string())
}

#[tauri::command]
fn recover_vault(
    recovery_code: String, 
    new_password: String, 
    state: tauri::State<SessionState>
) -> CommandResult<String> {
    let master_key = keychain::recover_with_code(&recovery_code, &new_password)
        .map_err(|e| e.to_string())?;
    let mut guard = state.master_key.lock().unwrap();
    *guard = Some(master_key);
    Ok("Recovery successful. Password updated.".to_string())
}

#[tauri::command]
fn regenerate_recovery_code(state: tauri::State<SessionState>) -> CommandResult<String> {
    let guard = state.master_key.lock().unwrap();
    let master_key = match &*guard {
        Some(mk) => mk,
        None => return Err("Vault is locked. Cannot reset code.".to_string()),
    };
    let new_code = keychain::reset_recovery_code(master_key).map_err(|e| e.to_string())?;
    Ok(new_code)
}

#[tauri::command]
fn get_startup_file() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        let path = args[1].clone();
        if !path.starts_with("--") {
            return Some(path);
        }
    }
    None
}

// --- File Operations ---

// UPDATED: Now accepts a Vector of paths to delete multiple items
#[tauri::command]
fn delete_items(paths: Vec<String>) -> CommandResult<()> {
    for path in paths {
        let p = Path::new(&path);
        if p.is_dir() {
            fs::remove_dir_all(p).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn create_dir(path: String) -> CommandResult<()> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_item(path: String, new_name: String) -> CommandResult<()> {
    let old_path = Path::new(&path);
    let parent = old_path.parent().ok_or("Invalid path")?;
    let new_path = parent.join(new_name);
    fs::rename(old_path, new_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_in_folder(path: String) -> CommandResult<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path]) 
            .spawn()
            .map_err(|e| e.to_string())?;
    }

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
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// --- Crypto ---

#[tauri::command]
async fn lock_file(
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>, 
    keyfile_path: Option<String>, 
    extra_entropy: Option<Vec<u8>>,
    compression_mode: Option<String> 
) -> CommandResult<String> {
    
    let guard = state.master_key.lock().unwrap();
    let master_key = match &*guard {
        Some(mk) => mk,
        None => return Err("Vault is locked. Please log in.".to_string()),
    };

    let keyfile_bytes = read_keyfile(keyfile_path)?;

    let compression_level = match compression_mode.as_deref() {
        Some("fast") => 1,
        Some("best") => 15, 
        _ => 3, 
    };

    let entropy_seed = if let Some(bytes) = extra_entropy {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().into())
    } else {
        None
    };

    let mut successes = 0;
    let mut errors = Vec::new();

    for file_path in file_paths {
        let path = Path::new(&file_path);
        
        let mut processing_path = path.to_path_buf();
        let mut is_temp_dir = false;
        
        let original_name = path.file_name().unwrap_or_default().to_string_lossy();
        let stored_filename = if path.is_dir() {
            format!("{}.zip", original_name)
        } else {
            original_name.to_string()
        };
        
        if path.is_dir() {
            let temp_dir = std::env::temp_dir();
            let zip_filename = format!("qre_{}_{}.zip", original_name, Uuid::new_v4());
            let zip_path = temp_dir.join(zip_filename);

            if let Err(e) = zip_directory(path, &zip_path) {
                errors.push(format!("Failed to zip directory {}: {}", original_name, e));
                continue;
            }
            processing_path = zip_path;
            is_temp_dir = true;
        }

        if let Err(e) = check_file_size(&processing_path) {
            errors.push(format!("Size error: {}", e));
            if is_temp_dir { let _ = fs::remove_file(&processing_path); }
            continue;
        }

        match fs::read(&processing_path) {
            Ok(file_bytes) => {
                match crypto::encrypt_file_with_master_key(
                    master_key, 
                    keyfile_bytes.as_deref(), 
                    &stored_filename, 
                    &file_bytes, 
                    entropy_seed,
                    compression_level 
                ) {
                    Ok(container) => {
                        let raw_output = format!("{}.qre", file_path);
                        let final_path = get_unique_path(Path::new(&raw_output));
                        let final_str = final_path.to_string_lossy().to_string();

                        if let Err(e) = container.save(&final_str) {
                            errors.push(format!("Save error: {}", e));
                        } else {
                            successes += 1;
                        }
                    },
                    Err(e) => errors.push(format!("Encrypt error: {}", e)),
                }
            },
            Err(e) => errors.push(format!("Read error: {}", e)),
        }

        if is_temp_dir {
            let _ = fs::remove_file(&processing_path);
        }
    }

    if errors.is_empty() {
        Ok(format!("Locked {} item(s).", successes))
    } else {
        Err(format!("Processed {}. Errors:\n{}", successes, errors.join("\n")))
    }
}

#[tauri::command]
async fn unlock_file(
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>, 
    keyfile_path: Option<String>
) -> CommandResult<String> {
    
    let guard = state.master_key.lock().unwrap();
    let master_key = match &*guard {
        Some(mk) => mk,
        None => return Err("Vault is locked. Please log in.".to_string()),
    };

    let keyfile_bytes = read_keyfile(keyfile_path)?;
    let mut successes = 0;
    let mut errors = Vec::new();

    for file_path in file_paths {
        match crypto::EncryptedFileContainer::load(&file_path) {
            Ok(container) => {
                match crypto::decrypt_file_with_master_key(master_key, keyfile_bytes.as_deref(), &container) {
                    Ok(payload) => {
                        let parent = Path::new(&file_path).parent().unwrap_or(Path::new("."));
                        let original_path = parent.join(&payload.filename);
                        let final_path = get_unique_path(&original_path);
                        if let Err(e) = fs::write(&final_path, &payload.content) {
                            errors.push(format!("Write error: {}", e));
                        } else {
                            successes += 1;
                        }
                    },
                    Err(e) => errors.push(format!("Decrypt error: {}", e)),
                }
            },
            Err(e) => errors.push(format!("Load error: {}", e)),
        }
    }

    if errors.is_empty() {
        Ok(format!("Unlocked {} files.", successes))
    } else {
        Err(format!("Processed {}. Errors:\n{}", successes, errors.join("\n")))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionState { 
            master_key: Arc::new(Mutex::new(None)) 
        })
        .plugin(tauri_plugin_clipboard_manager::init()) 
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            check_auth_status, 
            init_vault, 
            login, 
            logout, 
            lock_file, 
            unlock_file, 
            recover_vault, 
            regenerate_recovery_code,
            change_user_password,
            get_drives,
            delete_items, // CHANGED from delete_item
            create_dir,
            rename_item,
            show_in_folder,
            get_startup_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}