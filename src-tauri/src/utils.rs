// --- START OF FILE utils.rs ---

use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

// ==========================================
// --- EVENT HELPERS ---
// ==========================================

/// Emits a progress update event over the Tauri IPC bridge to the React frontend.
/// This allows the UI to display live progress bars during long I/O bound operations
/// (like encryption, decryption, or shredding) so the app doesn't appear "frozen".
pub fn emit_progress(app: &AppHandle, label: &str, percentage: u8) {
    let _ = app.emit(
        "qre:progress",
        serde_json::json!({
            "status": label,
            "percentage": percentage
        }),
    );
}

// ==========================================
// --- FILE HELPERS ---
// ==========================================

/// Reads a "Keyfile" from disk and computes its SHA-256 hash.
///
/// A Keyfile is an advanced cryptographic feature where a user selects a random file
/// (e.g., an image or mp3) to act as an extension of their password.
///
/// * **Desktop:** The app reads the file path directly from the OS file system.
/// * **Android:** Direct paths don't work due to Scoped Storage (Content URIs).
///   The frontend handles reading the bytes into memory and passes them to the command directly.
///
/// Returns: An optional SHA-256 hash vector that will be mixed with the master key.
pub fn process_keyfile(path_opt: Option<String>) -> Result<Option<Vec<u8>>, String> {
    match path_opt {
        Some(p) => {
            if p.trim().is_empty() {
                return Ok(None); // Empty path string means no keyfile
            }
            let path = Path::new(&p);

            if !path.exists() {
                return Err(format!("Keyfile not found: {}", p));
            }

            let mut file =
                fs::File::open(path).map_err(|e| format!("Failed to open keyfile: {}", e))?;

            // Hash the file contents
            let mut hasher = Sha256::new();
            // Read in 4KB chunks. This is CRITICAL. If a user selects a 4GB movie
            // as their keyfile, reading the whole file at once would crash the app with an OOM error.
            let mut buffer = [0u8; 4096];

            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|e| format!("Error reading keyfile: {}", e))?;
                if count == 0 {
                    break; // End of file
                }
                hasher.update(&buffer[..count]);
            }

            Ok(Some(hasher.finalize().to_vec()))
        }
        None => Ok(None),
    }
}

/// Generates a unique, non-colliding filename to prevent accidentally overwriting existing files.
///
/// Example:
/// If `document.txt` exists, it returns `document (1).txt`.
/// If `document (1).txt` exists, it returns `document (2).txt`, etc.
pub fn get_unique_path(original_path: &Path) -> PathBuf {
    // If the path doesn't exist yet, it's safe to use
    if !original_path.exists() {
        return original_path.to_path_buf();
    }

    // Deconstruct the original path
    let file_stem = original_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let extension = original_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = original_path.parent().unwrap_or(Path::new("."));

    // Loop until we find an unused number suffix
    let mut counter = 1;
    loop {
        let new_name = format!("{} ({}){}", file_stem, counter, extension);
        let new_path = parent.join(new_name);
        if !new_path.exists() {
            return new_path; // Found a safe path!
        }
        counter += 1;
    }
}

// ==========================================
// --- TRASH LOGIC ---
// ==========================================

/// Attempts to move a file/folder to the Operating System's native Trash / Recycle Bin.
/// This acts as a softer alternative to immediate secure shredding.
///
/// - **Desktop:** Uses the `trash` crate to interact with the OS APIs natively.
/// - **Android:** Returns an error because Android lacks a standardized cross-vendor
///   Trash API accessible to standard applications via native code.
#[allow(dead_code)]
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = path; // Suppress unused variable warning on Android
        Err("Trash is not supported on Android".to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        trash::delete(path).map_err(|e| e.to_string())
    }
}

// ==========================================
// --- ZIP LOGIC ---
// ==========================================

/// Packages an entire directory (and its contents) into a `.zip` file stored on disk.
/// This allows the encryption engine to process complex folder structures as a single file.
///
/// PERFORMANCE: We stream the files directly to a temporary `.zip` on the disk rather than
/// building the ZIP in RAM. This prevents the app from crashing if the user tries to lock
/// a massive 50GB folder.
///
/// COMPRESSION: We use `CompressionMethod::Stored` (0% compression) here because the
/// QRE encryption engine applies its own highly efficient Zstd compression later in the pipeline.
/// Zipping first and compressing later is faster and yields smaller encrypted files.
pub fn zip_directory_to_file(dir_path: &Path, output_zip_path: &Path) -> Result<(), String> {
    let file = fs::File::create(output_zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);

    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o755); // Standardize permissions to avoid cross-OS extraction issues

    let prefix = dir_path.parent().unwrap_or(Path::new(""));

    // SECURITY FIX: Explicitly disable following symlinks.
    // If we followed symlinks, a malicious symlink inside the folder pointing to `C:\Windows`
    // or `/etc` could cause the application to ZIP and expose arbitrary system files
    // (a form of Directory Traversal attack).
    for entry in WalkDir::new(dir_path).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // Extra defense-in-depth: Skip symlink objects entirely so they don't even end up in the ZIP metadata
        if path.is_symlink() {
            continue;
        }

        // Calculate the internal relative path for the ZIP structure
        let name = path
            .strip_prefix(prefix)
            .map_err(|_| "Path error")?
            .to_str()
            .ok_or("Non-UTF8 path")?
            .replace("\\", "/"); // ZIP specification requires forward slashes, even on Windows

        if path.is_file() {
            zip.start_file(name, options).map_err(|e| e.to_string())?;

            // Stream the file content directly into the zip archive chunk by chunk
            let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
        } else if path.is_dir() && !name.is_empty() {
            zip.add_directory(name, options)
                .map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// ==========================================
// --- SHREDDING LOGIC (INTERNAL/LEGACY) ---
// ==========================================

/// Securely deletes a single file by overwriting its physical disk sectors with random data.
/// This function is primarily used by the app internally (e.g., when deleting a file normally)
/// rather than the advanced dedicated "File Shredder" tool.
///
/// **WARNING:** On Flash storage (SSDs, USB drives, Mobile phones), hardware "Wear Leveling"
/// algorithms intercept write commands. The SSD controller may write this "random data" to a
/// completely different physical sector, leaving the original data fully intact!
/// Because of this, shredding is completely disabled on Android builds to prevent
/// destroying the phone's NAND chip lifespan for no actual security gain.
#[allow(dead_code)]
fn shred_file_internal(app: &AppHandle, path: &Path) -> std::io::Result<()> {
    // 1. Un-lock the file: Remove the OS Read-Only attribute if it's set
    let mut perms = fs::metadata(path)?.permissions();
    if perms.readonly() {
        // On Unix, set_readonly(false) would make the file world-writable (0o666).
        // We use PermissionsExt to set 0o600 (owner read/write only) instead.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o600);
        }
        // On Windows, set_readonly(false) is safe — no world-writable side-effect.
        #[cfg(not(unix))]
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);

        fs::set_permissions(path, perms)?;
    }

    let metadata = fs::metadata(path)?;
    let len = metadata.len();

    // 2. Overwrite the file content with random garbage data (One pass)
    if len > 0 {
        let mut file = fs::OpenOptions::new().write(true).open(path)?;
        let mut rng = rand::rng();

        // Write in 16MB chunks. This is faster than 1MB chunks on modern NVMe drives.
        let chunk_size = 16 * 1024 * 1024;
        let mut buffer = vec![0u8; chunk_size];
        let mut written = 0u64;
        let mut last_percent: u8 = 0;

        while written < len {
            // Determine how much to write without overshooting the file size
            let bytes_to_write = std::cmp::min(chunk_size as u64, len - written);
            let slice = &mut buffer[0..bytes_to_write as usize];

            // Fill buffer with cryptographically secure noise
            rng.fill_bytes(slice);
            file.write_all(slice)?;
            written += bytes_to_write;

            // Report progress to the UI, clamped at 100% to avoid overflow crashes
            let percent = ((written as f64 / len as f64) * 100.0).min(100.0) as u8;

            // Throttle UI events to only trigger every 5% progress
            if percent >= last_percent.saturating_add(5) {
                let filename = path.file_name().unwrap_or_default().to_string_lossy();
                emit_progress(app, &format!("Shredding {}", filename), percent);
                last_percent = percent;
            }
        }

        // Force the OS to bypass write caches and physically commit the garbage to the drive plates
        file.sync_all()?;
    }

    // 3. Metadata Obfuscation
    // The OS file table (MFT on Windows) stores the filename. Overwriting the file contents
    // doesn't delete the filename. We rename the file to a random UUID before deleting it
    // so forensic recovery tools just see a deleted UUID instead of "Tax_Returns_2023.pdf".
    let parent = path.parent().unwrap_or(Path::new("/"));
    let new_name = Uuid::new_v4().to_string();
    let new_path = parent.join(new_name);

    if fs::rename(path, &new_path).is_ok() {
        let _ = fs::remove_file(new_path);
    } else {
        // Fallback: If renaming fails (e.g., due to permissions/locks), delete the original path
        let _ = fs::remove_file(path);
    }

    Ok(())
}

/// Helper function to walk a directory tree and execute `shred_file_internal` on every nested file.
/// Used when the user clicks "Delete" on a folder within the app UI.
#[allow(dead_code)]
pub fn shred_recursive(app: &AppHandle, path: &Path) -> Result<(), String> {
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            // Recursive call for nested folders
            shred_recursive(app, &entry.path())?;
        }
        // Once all internal files are destroyed, remove the empty folder wrapper
        fs::remove_dir(path).map_err(|e| e.to_string())?;
    } else {
        // Target is a single file, shred it
        shred_file_internal(app, path)
            .map_err(|e| format!("Failed to shred {}: {}", path.display(), e))?;
    }
    Ok(())
}

// ==========================================
// --- TESTS ---
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    // Helper to create a temporary environment
    fn setup_test_dir(name: &str) -> PathBuf {
        let test_dir = std::env::temp_dir().join(format!("qre_utils_tests_{}", name));
        let _ = fs::remove_dir_all(&test_dir); // Ensure clean state
        fs::create_dir_all(&test_dir).unwrap();
        test_dir
    }

    // --- Keyfile Tests ---

    #[test]
    fn test_process_keyfile_valid() {
        let dir = setup_test_dir("keyfile_valid");
        let path = dir.join("my_keyfile.key");

        let mut f = fs::File::create(&path).unwrap();
        f.write_all(b"my super secret key data").unwrap();

        let result = process_keyfile(Some(path.to_string_lossy().to_string()));
        assert!(result.is_ok());
        let hash = result.unwrap();
        assert!(hash.is_some());

        // Should produce a predictable 32-byte SHA-256 hash
        let hash_bytes = hash.unwrap();
        assert_eq!(hash_bytes.len(), 32);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_process_keyfile_empty_or_none() {
        // Passing None should return Ok(None)
        let res1 = process_keyfile(None);
        assert!(res1.is_ok());
        assert!(res1.unwrap().is_none());

        // Passing an empty string should also return Ok(None)
        let res2 = process_keyfile(Some("   ".to_string()));
        assert!(res2.is_ok());
        assert!(res2.unwrap().is_none());
    }

    #[test]
    fn test_process_keyfile_not_found() {
        let result = process_keyfile(Some("/path/does/not/exist.txt".to_string()));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    // --- Unique Path Generation Tests ---

    #[test]
    fn test_get_unique_path() {
        let dir = setup_test_dir("unique_path");
        let original_path = dir.join("document.txt");

        // 1. If the file doesn't exist, it should return the exact same path
        let path1 = get_unique_path(&original_path);
        assert_eq!(path1, original_path);

        // 2. Create the file. Now it should generate "document (1).txt"
        fs::File::create(&original_path).unwrap();
        let path2 = get_unique_path(&original_path);
        assert_eq!(
            path2.file_name().unwrap().to_string_lossy(),
            "document (1).txt"
        );

        // 3. Create the (1) file. Now it should generate "document (2).txt"
        fs::File::create(&path2).unwrap();
        let path3 = get_unique_path(&original_path);
        assert_eq!(
            path3.file_name().unwrap().to_string_lossy(),
            "document (2).txt"
        );

        let _ = fs::remove_dir_all(dir);
    }

    // --- Zip Directory Traversal / Symlink Tests ---

    // --- Helper for OS-specific symlink creation ---
    #[cfg(target_os = "windows")]
    fn create_test_dir_symlink(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(original, link)
    }

    #[cfg(not(target_os = "windows"))]
    fn create_test_dir_symlink(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    // --- Zip Directory Traversal / Symlink Tests ---

    #[test]
    fn test_zip_directory_symlink_defense() {
        let dir = setup_test_dir("zip_defense");

        let source_dir = dir.join("source");
        fs::create_dir_all(&source_dir).unwrap();

        // Create a normal file
        let safe_file = source_dir.join("safe.txt");
        fs::File::create(&safe_file)
            .unwrap()
            .write_all(b"Hello")
            .unwrap();

        // Create a directory outside the source to act as a simulated sensitive area
        let out_of_bounds_dir = dir.join("sensitive_data");
        fs::create_dir_all(&out_of_bounds_dir).unwrap();
        let secret_file = out_of_bounds_dir.join("secret.txt");
        fs::File::create(&secret_file)
            .unwrap()
            .write_all(b"DO NOT LEAK THIS")
            .unwrap();

        // Create a symlink inside the source folder pointing to the sensitive folder
        let symlink_path = source_dir.join("link_to_secrets");

        // Use the clean OS-agnostic helper
        let link_res = create_test_dir_symlink(&out_of_bounds_dir, &symlink_path);

        // If the OS allows symlink creation (Windows requires admin), test the zip
        if link_res.is_ok() {
            let output_zip = dir.join("output.zip");
            let result = zip_directory_to_file(&source_dir, &output_zip);

            assert!(
                result.is_ok(),
                "Zipping should succeed, but silently ignore the symlink"
            );

            // Open the resulting zip to verify contents
            let zip_file = fs::File::open(&output_zip).unwrap();
            let mut archive = zip::ZipArchive::new(zip_file).unwrap();

            // It should only contain the safe folder and safe file.
            // The symlink and the secret file should NOT be inside the zip.
            let mut found_secret = false;
            for i in 0..archive.len() {
                let file = archive.by_index(i).unwrap();
                if file.name().contains("secret") {
                    found_secret = true;
                }
            }

            assert!(
                !found_secret,
                "CRITICAL: The Zip function followed a symlink and leaked external files!"
            );
        }

        let _ = fs::remove_dir_all(dir);
    }
}

// --- END OF FILE utils.rs ---
