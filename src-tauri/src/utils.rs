use crate::state::MAX_FILE_SIZE;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read, Write}; // "Read" is required for hashing the keyfile
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

// --- EVENT HELPERS ---

/// Sends a progress update event to the Frontend (React).
/// This allows the UI to show a progress bar during long operations.
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

/// Recursively calculates the total size of a directory.
/// Used to check if a folder exceeds the 4GB processing limit.
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

/// Verifies that a file or directory is small enough to be processed in RAM.
/// Currently, the app loads files into memory for encryption, so we limit it to 4GB.
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

/// Reads a Keyfile from disk and hashes it.
/// - Used on **Desktop** where we have direct file access.
/// - On Android, the frontend sends raw bytes instead, skipping this function.
/// 
/// Returns the SHA-256 hash of the file content, which is then used as part of the encryption key.
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

            // Read file in chunks to handle large keyfiles efficiently
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

/// Generates a unique filename if the target file already exists.
/// Example: "photo.jpg" -> "photo (1).jpg" -> "photo (2).jpg"
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

/// Moves a file to the System Trash / Recycle Bin.
/// - Desktop: Supported via the `trash` crate.
/// - Android: Not supported (returns error).
#[allow(dead_code)]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = path;
        Err("Trash is not supported on Android".to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        trash::delete(path).map_err(|e| e.to_string())
    }
}

// --- ZIP LOGIC ---

/// Compresses a directory into a ZIP archive in memory.
/// This is necessary because QRE encryption works on a single blob of data.
/// Folders are first zipped, then the resulting ZIP blob is encrypted.
pub fn zip_directory_to_memory(dir_path: &Path) -> Result<Vec<u8>, String> {
    let buffer = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buffer);

    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored) // No compression here (Zstd handles it later)
        .unix_permissions(0o755);

    let prefix = dir_path.parent().unwrap_or(Path::new(""));

    for entry in WalkDir::new(dir_path) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // Create relative path inside the zip
        let name = path
            .strip_prefix(prefix)
            .map_err(|_| "Path error")?
            .to_str()
            .ok_or("Non-UTF8 path")?
            .replace("\\", "/"); // Normalize for Windows

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

/// Securely deletes a single file by overwriting it with random data.
/// WARNING: Flash memory (SSDs/Phones) makes this unreliable due to wear leveling.
#[allow(dead_code)]
fn shred_file_internal(app: &AppHandle, path: &Path) -> std::io::Result<()> {
    // 1. Force removal of Read-Only attribute so we can write to it
    let mut perms = fs::metadata(path)?.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        fs::set_permissions(path, perms)?;
    }

    let metadata = fs::metadata(path)?;
    let len = metadata.len();

    // 2. Overwrite file content with random garbage
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
            rng.fill_bytes(slice); // Fill buffer with random noise
            file.write_all(slice)?;
            written += bytes_to_write;

            let percent = ((written as f64 / len as f64) * 100.0) as u8;
            if percent >= last_percent + 5 {
                let filename = path.file_name().unwrap_or_default().to_string_lossy();
                emit_progress(app, &format!("Shredding {}", filename), percent);
                last_percent = percent;
            }
        }
        file.sync_all()?; // Ensure data is flushed to disk
    }

    // 3. Rename file to random UUID to hide original filename
    let parent = path.parent().unwrap_or(Path::new("/"));
    let new_name = Uuid::new_v4().to_string();
    let new_path = parent.join(new_name);

    if fs::rename(path, &new_path).is_ok() {
        let _ = fs::remove_file(new_path);
    } else {
        // Fallback if rename fails
        let _ = fs::remove_file(path);
    }

    Ok(())
}

/// Recursively shreds a directory and its contents.
#[allow(dead_code)]
pub fn shred_recursive(app: &AppHandle, path: &Path) -> Result<(), String> {
    if path.is_dir() {
        // Delete all children first
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            shred_recursive(app, &entry.path())?;
        }
        // Remove the empty directory
        fs::remove_dir(path).map_err(|e| e.to_string())?;
    } else {
        shred_file_internal(app, path)
            .map_err(|e| format!("Failed to shred {}: {}", path.display(), e))?;
    }
    Ok(())
}