mod crypto;
mod entropy;
mod secure_rng;

use std::fs;
use std::path::{Path, PathBuf};

type CommandResult<T> = Result<T, String>;

const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024; 

fn check_file_size(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|_| "File not found".to_string())?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!("File '{}' too large (>500MB).", path.display()));
    }
    Ok(())
}

fn read_keyfile(path_opt: Option<String>) -> Result<Option<Vec<u8>>, String> {
    match path_opt {
        Some(p) => {
            if p.trim().is_empty() { return Ok(None); }
            let path = Path::new(&p);
            check_file_size(path)?; 
            let bytes = fs::read(path).map_err(|e| format!("Failed to read keyfile: {}", e))?;
            Ok(Some(bytes))
        },
        None => Ok(None),
    }
}

fn get_unique_path(original_path: &Path) -> PathBuf {
    if !original_path.exists() {
        return original_path.to_path_buf();
    }
    let file_stem = original_path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = original_path.extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = original_path.parent().unwrap_or(Path::new("."));

    let mut counter = 1;
    loop {
        let new_name = format!("{} ({}){}", file_stem, counter, extension);
        let new_path = parent.join(new_name);
        if !new_path.exists() {
            return new_path;
        }
        counter += 1;
    }
}

// --- BATCH COMMANDS ---

#[tauri::command]
async fn lock_file(
    file_paths: Vec<String>, // <--- CHANGED: List of files
    password: String, 
    keyfile_path: Option<String>, 
    extra_entropy: Option<Vec<u8>>
) -> CommandResult<String> {
    
    // 1. Prepare Keyfile & Entropy (Once for all files)
    let keyfile_bytes = read_keyfile(keyfile_path)?;

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

    // 2. Loop through files
    for file_path in file_paths {
        let path = Path::new(&file_path);
        
        // Basic validation
        if let Err(e) = check_file_size(path) {
            errors.push(format!("{}: {}", path.file_name().unwrap_or_default().to_string_lossy(), e));
            continue;
        }

        let filename = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => { errors.push("Invalid path".to_string()); continue; }
        };

        match fs::read(path) {
            Ok(file_bytes) => {
                // Encrypt
                match crypto::encrypt_file_with_password(
                    &password, 
                    keyfile_bytes.as_deref(), 
                    &filename, 
                    &file_bytes, 
                    entropy_seed // Use same seed seed logic for batch is acceptable for UX, keys are still unique per file due to internal salts
                ) {
                    Ok(container) => {
                        let output_path = format!("{}.qre", file_path);
                        if let Err(e) = container.save(&output_path) {
                            errors.push(format!("Save failed for {}: {}", filename, e));
                        } else {
                            successes += 1;
                        }
                    },
                    Err(e) => errors.push(format!("Encrypt failed for {}: {}", filename, e)),
                }
            },
            Err(e) => errors.push(format!("Read failed for {}: {}", filename, e)),
        }
    }

    if errors.is_empty() {
        Ok(format!("Successfully locked {} files.", successes))
    } else {
        // Return summary error
        Err(format!("Processed {}. Errors:\n{}", successes, errors.join("\n")))
    }
}

#[tauri::command]
async fn unlock_file(
    file_paths: Vec<String>, // <--- CHANGED
    password: String,
    keyfile_path: Option<String>
) -> CommandResult<String> {
    
    let keyfile_bytes = read_keyfile(keyfile_path)?;
    let mut successes = 0;
    let mut errors = Vec::new();

    for file_path in file_paths {
        let path = Path::new(&file_path);
        let filename_display = path.file_name().unwrap_or_default().to_string_lossy();

        match crypto::EncryptedFileContainer::load(&file_path) {
            Ok(container) => {
                match crypto::decrypt_file_with_password(&password, keyfile_bytes.as_deref(), &container) {
                    Ok(payload) => {
                        let parent = path.parent().unwrap_or(Path::new("."));
                        let original_path = parent.join(&payload.filename);
                        let final_path = get_unique_path(&original_path);

                        if let Err(e) = fs::write(&final_path, &payload.content) {
                            errors.push(format!("Write failed for {}: {}", filename_display, e));
                        } else {
                            successes += 1;
                        }
                    },
                    Err(e) => errors.push(format!("Decrypt failed for {}: {}", filename_display, e)),
                }
            },
            Err(e) => errors.push(format!("Load failed for {}: {}", filename_display, e)),
        }
    }

    if errors.is_empty() {
        Ok(format!("Successfully unlocked {} files.", successes))
    } else {
        Err(format!("Processed {}. Errors:\n{}", successes, errors.join("\n")))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![lock_file, unlock_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}