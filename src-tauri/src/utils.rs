use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

// --- EVENT HELPERS ---

/// Sends a progress update event to the Frontend (React).
/// This allows the UI to show a progress bar during long operations like encryption or shredding.
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

/// Reads a Keyfile from disk and computes its SHA-256 hash.
///
/// This is used primarily on Desktop where the app has direct file access.
/// On Android, the frontend reads the bytes and passes them directly to the command
/// to avoid permission issues with Content URIs.
///
/// Returns: The SHA-256 hash of the file content (used as part of the encryption key).
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

            // Read the file in small chunks to avoid loading large keyfiles into RAM.
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

/// Generates a unique filename to prevent overwriting existing files.
///
/// Example: If `file.txt` exists, it returns `file (1).txt`.
/// If `file (1).txt` exists, it returns `file (2).txt`, and so on.
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
///
/// - **Desktop:** Uses the `trash` crate to interact with the OS Recycle Bin.
/// - **Android:** Returns an error because Android does not have a standardized Trash API for external files.
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

/// Compresses a directory into a ZIP file stored on the disk.
///
/// This uses a **temporary file** strategy instead of zipping to memory.
/// This ensures that archiving large folders (e.g., 10GB) does not crash the application due to RAM exhaustion.
///
/// Note: The ZIP itself is stored without compression (`CompressionMethod::Stored`) because
/// the QRE engine applies Zstd compression to the entire stream later.
pub fn zip_directory_to_file(dir_path: &Path, output_zip_path: &Path) -> Result<(), String> {
    let file = fs::File::create(output_zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);

    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored) 
        .unix_permissions(0o755);

    let prefix = dir_path.parent().unwrap_or(Path::new(""));

    // Walk through the directory recursively
    for entry in WalkDir::new(dir_path) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // Calculate relative path for the zip structure
        let name = path
            .strip_prefix(prefix)
            .map_err(|_| "Path error")?
            .to_str()
            .ok_or("Non-UTF8 path")?
            .replace("\\", "/"); // Normalize Windows paths

        if path.is_file() {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            // Stream file content directly to the zip file
            let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
        } else if path.is_dir() && !name.is_empty() {
            zip.add_directory(name, options).map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// --- SHREDDING LOGIC ---

/// Securely deletes a single file by overwriting it with random data.
///
/// **WARNING:** On Flash storage (SSDs, USB drives, Mobile phones), hardware "wear leveling"
/// may prevent the data from being physically overwritten in the same location.
/// This feature is disabled on Android to prevent unnecessary battery/chip wear.
#[allow(dead_code)]
fn shred_file_internal(app: &AppHandle, path: &Path) -> std::io::Result<()> {
    // 1. Remove Read-Only attribute (if present) to allow writing
    let mut perms = fs::metadata(path)?.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        fs::set_permissions(path, perms)?;
    }

    let metadata = fs::metadata(path)?;
    let len = metadata.len();

    // 2. Overwrite the file content with random garbage data
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
            rng.fill_bytes(slice); // Generate random noise
            file.write_all(slice)?;
            written += bytes_to_write;

            // Report progress to UI
            let percent = ((written as f64 / len as f64) * 100.0) as u8;
            if percent >= last_percent + 5 {
                let filename = path.file_name().unwrap_or_default().to_string_lossy();
                emit_progress(app, &format!("Shredding {}", filename), percent);
                last_percent = percent;
            }
        }
        file.sync_all()?; // Force OS to flush changes to disk
    }

    // 3. Rename the file to a random UUID to obscure the original filename/metadata
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
/// Walks the tree, shreds files individually, then removes the directory structure.
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