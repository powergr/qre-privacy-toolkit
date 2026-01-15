use crate::state::MAX_FILE_SIZE;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read, Write}; // Added Read back
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

// --- EVENT HELPERS ---

pub fn emit_progress(app: &AppHandle, label: &str, percentage: u8) {
    let _ = app.emit(
        "qre:progress",
        serde_json::json!({
            "status": label,
            "percentage": percentage
        }),
    );
}

// --- FILE HELPERS ---

pub fn get_dir_size(path: &Path) -> Result<u64, String> {
    let mut total_size = 0;
    for entry in WalkDir::new(path) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file() {
            total_size += entry.metadata().map_err(|e| e.to_string())?.len();
        }
    }
    Ok(total_size)
}

pub fn check_size_limit(path: &Path) -> Result<(), String> {
    let total_size = if path.is_dir() {
        get_dir_size(path)?
    } else {
        fs::metadata(path).map_err(|e| e.to_string())?.len()
    };

    if total_size > MAX_FILE_SIZE {
        return Err(format!("Size limit exceeded (>4GB): {}", path.display()));
    }
    Ok(())
}

// RESTORED: Needed for Desktop to read keyfiles without freezing the UI
pub fn process_keyfile(path_opt: Option<String>) -> Result<Option<Vec<u8>>, String> {
    match path_opt {
        Some(p) => {
            if p.trim().is_empty() {
                return Ok(None);
            }
            let path = Path::new(&p);

            if !path.exists() {
                return Err(format!("Keyfile not found: {}", p));
            }

            let mut file =
                fs::File::open(path).map_err(|e| format!("Failed to open keyfile: {}", e))?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 4096];

            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|e| format!("Error reading keyfile: {}", e))?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }

            Ok(Some(hasher.finalize().to_vec()))
        }
        None => Ok(None),
    }
}

pub fn get_unique_path(original_path: &Path) -> PathBuf {
    if !original_path.exists() {
        return original_path.to_path_buf();
    }
    let file_stem = original_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let extension = original_path
        .extension()
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

// --- TRASH LOGIC ---

#[allow(dead_code)]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    // Android: Trash not supported
    #[cfg(target_os = "android")]
    {
        let _ = path;
        Err("Trash is not supported on Android".to_string())
    }

    // Desktop: Use trash crate
    #[cfg(not(target_os = "android"))]
    {
        trash::delete(path).map_err(|e| e.to_string())
    }
}

// --- ZIP LOGIC ---

pub fn zip_directory_to_memory(dir_path: &Path) -> Result<Vec<u8>, String> {
    let buffer = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buffer);

    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o755);

    let prefix = dir_path.parent().unwrap_or(Path::new(""));

    for entry in WalkDir::new(dir_path) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        let name = path
            .strip_prefix(prefix)
            .map_err(|_| "Path error")?
            .to_str()
            .ok_or("Non-UTF8 path")?
            .replace("\\", "/");

        if path.is_file() {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            let file_bytes = fs::read(path).map_err(|e| e.to_string())?;
            zip.write_all(&file_bytes).map_err(|e| e.to_string())?;
        } else if path.is_dir() && !name.is_empty() {
            zip.add_directory(name, options)
                .map_err(|e| e.to_string())?;
        }
    }

    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

// --- SHREDDING LOGIC ---

#[allow(dead_code)]
fn shred_file_internal(app: &AppHandle, path: &Path) -> std::io::Result<()> {
    // FIX: Force removal of Read-Only attribute before shredding
    let mut perms = fs::metadata(path)?.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        fs::set_permissions(path, perms)?;
    }

    let metadata = fs::metadata(path)?;
    let len = metadata.len();

    if len > 0 {
        let mut file = fs::OpenOptions::new().write(true).open(path)?;
        let mut rng = rand::thread_rng();
        let chunk_size = 16 * 1024 * 1024; // 16MB Buffer
        let mut buffer = vec![0u8; chunk_size];
        let mut written = 0u64;
        let mut last_percent = 0;

        while written < len {
            let bytes_to_write = std::cmp::min(chunk_size as u64, len - written);
            let slice = &mut buffer[0..bytes_to_write as usize];
            rng.fill_bytes(slice);
            file.write_all(slice)?;
            written += bytes_to_write;

            let percent = ((written as f64 / len as f64) * 100.0) as u8;
            if percent >= last_percent + 5 {
                let filename = path.file_name().unwrap_or_default().to_string_lossy();
                emit_progress(app, &format!("Shredding {}", filename), percent);
                last_percent = percent;
            }
        }
        file.sync_all()?;
    }

    let parent = path.parent().unwrap_or(Path::new("/"));
    let new_name = Uuid::new_v4().to_string();
    let new_path = parent.join(new_name);

    if fs::rename(path, &new_path).is_ok() {
        let _ = fs::remove_file(new_path);
    } else {
        let _ = fs::remove_file(path);
    }

    Ok(())
}

#[allow(dead_code)]
pub fn shred_recursive(app: &AppHandle, path: &Path) -> Result<(), String> {
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            shred_recursive(app, &entry.path())?;
        }
        fs::remove_dir(path).map_err(|e| e.to_string())?;
    } else {
        shred_file_internal(app, path)
            .map_err(|e| format!("Failed to shred {}: {}", path.display(), e))?;
    }
    Ok(())
}
