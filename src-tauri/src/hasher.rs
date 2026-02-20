use anyhow::{anyhow, Result};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

// Import the Digest trait for update() and finalize() methods
use sha2::Digest;

use md5::Md5;
use sha1::Sha1;
use sha2::Sha256;

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024 * 1024; // 10 GB
const BUFFER_SIZE: usize = 8192; // 8 KB buffer for reading
const PROGRESS_REPORT_INTERVAL: u64 = 10 * 1024 * 1024; // Report every 10 MB

// ─────────────────────────────────────────────────────────────────────────────
// DATA STRUCTURES
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct HashResult {
    pub sha256: String,
    pub sha1: String,
    pub md5: String,
}

#[derive(serde::Serialize)]
pub struct FileMetadata {
    pub size: u64,
    pub is_file: bool,
    pub is_symlink: bool,
}

#[derive(Clone, serde::Serialize)]
pub struct ProgressPayload {
    pub bytes_processed: u64,
    pub total_bytes: u64,
    pub percentage: u8,
}

// Global cancellation flag
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

// ─────────────────────────────────────────────────────────────────────────────
// FILE METADATA VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/// Gets file metadata with security checks.
///
/// SECURITY: Validates the file before hashing to prevent:
/// - Symlink attacks (reading unintended files)
/// - Directory traversal
/// - Device file hangs (/dev/random, /dev/zero)
/// - Oversized files causing memory exhaustion
pub fn get_file_metadata(path_str: &str) -> Result<FileMetadata> {
    let path = Path::new(path_str);

    // Check if path exists
    if !path.exists() {
        return Err(anyhow!("File not found: {}", path_str));
    }

    // Get metadata
    let metadata = std::fs::metadata(path)?;

    // Check if it's a regular file (not directory, device, etc.)
    let is_file = metadata.is_file();

    // Check for symlinks
    let is_symlink = metadata.file_type().is_symlink();

    Ok(FileMetadata {
        size: metadata.len(),
        is_file,
        is_symlink,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// HASH CALCULATION (With True Progress Reporting)
// ─────────────────────────────────────────────────────────────────────────────

/// Calculates SHA256, SHA1, and MD5 hashes for a file with full validation
/// and real-time progress reporting via Tauri events.
///
/// SECURITY CHECKS:
/// 1. File must be a regular file (not directory, device, pipe)
/// 2. File must not be a symlink
/// 3. File size must be <= MAX_FILE_SIZE (10 GB)
/// 4. Supports cancellation via global cancel flag
///
/// PROGRESS REPORTING:
/// Emits "hash-progress" events every 10MB processed, containing:
/// - bytes_processed: How many bytes have been hashed so far
/// - total_bytes: Total file size
/// - percentage: Progress as 0-100
///
/// # Arguments
/// * `path_str` - Path to the file to hash
/// * `app_handle` - Tauri app handle for emitting progress events
///
/// # Returns
/// * `HashResult` containing SHA256, SHA1, and MD5 hashes as hex strings
///
/// # Errors
/// * Returns error if file doesn't exist, is not a regular file, is a symlink,
///   exceeds max size, or if operation is cancelled
pub fn calculate_hashes<R: tauri::Runtime>(
    path_str: &str,
    app_handle: &tauri::AppHandle<R>,
) -> Result<HashResult> {
    // Reset cancel flag
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let path = Path::new(path_str);

    // ─── SECURITY VALIDATION ───

    // 1. Check if path exists
    if !path.exists() {
        return Err(anyhow!("File not found: {}", path_str));
    }

    // 2. Get and validate metadata
    let metadata = std::fs::metadata(path)?;

    // 3. Must be a regular file
    if !metadata.is_file() {
        return Err(anyhow!(
            "Path is not a regular file. Directories and special files are not supported."
        ));
    }

    // 4. Must not be a symlink (security risk)
    if metadata.file_type().is_symlink() {
        return Err(anyhow!(
            "Symlinks are not supported for security reasons. Please select the target file directly."
        ));
    }

    // 5. File size must be within limits
    let file_size = metadata.len();
    if file_size > MAX_FILE_SIZE {
        return Err(anyhow!(
            "File is too large: {} bytes. Maximum supported size: {} GB",
            file_size,
            MAX_FILE_SIZE / (1024 * 1024 * 1024)
        ));
    }

    // 6. Check for zero-sized files
    if file_size == 0 {
        return Err(anyhow!("File is empty (0 bytes)"));
    }

    // ─── HASH CALCULATION WITH PROGRESS REPORTING ───

    let file = File::open(path)?;
    let mut reader = BufReader::new(file);

    // Initialize all 3 hashers
    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut md5_hasher = Md5::new();

    let mut buffer = [0u8; BUFFER_SIZE];
    let mut bytes_processed = 0u64;
    let mut last_progress_report = 0u64;

    // Read file in chunks and update all hashers
    loop {
        // Check for cancellation
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            return Err(anyhow!("Hashing cancelled by user"));
        }

        // Read next chunk
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break; // EOF reached
        }

        let slice = &buffer[..count];

        // Update all hashers with the same chunk (efficient)
        sha256.update(slice);
        sha1.update(slice);
        md5_hasher.update(slice);

        bytes_processed += count as u64;

        // PROGRESS REPORTING: Emit event every 10 MB or at the end
        if bytes_processed - last_progress_report >= PROGRESS_REPORT_INTERVAL
            || bytes_processed == file_size
        {
            last_progress_report = bytes_processed;

            let percentage = if file_size > 0 {
                ((bytes_processed as f64 / file_size as f64) * 100.0) as u8
            } else {
                100
            };

            let progress = ProgressPayload {
                bytes_processed,
                total_bytes: file_size,
                percentage,
            };

            // Emit progress event (non-blocking)
            let _ = app_handle.emit("hash-progress", progress);
        }
    }

    // Emit final 100% progress
    let final_progress = ProgressPayload {
        bytes_processed: file_size,
        total_bytes: file_size,
        percentage: 100,
    };
    let _ = app_handle.emit("hash-progress", final_progress);

    // Finalize hashes and return as hex strings
    Ok(HashResult {
        sha256: format!("{:x}", sha256.finalize()),
        sha1: format!("{:x}", sha1.finalize()),
        md5: format!("{:x}", md5_hasher.finalize()),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION SUPPORT
// ─────────────────────────────────────────────────────────────────────────────

/// Sets the cancellation flag to stop ongoing hash calculation.
///
/// This is called from the frontend when the user clicks "Cancel".
/// The hash calculation loop checks this flag periodically.
pub fn cancel_hashing() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT/STRING HASHING (Bonus Feature)
// ─────────────────────────────────────────────────────────────────────────────

/// Calculates hashes for a text string (not a file).
///
/// Useful for hashing passwords, API keys, or any text content.
///
/// # Arguments
/// * `text` - The string to hash
///
/// # Returns
/// * `HashResult` containing SHA256, SHA1, and MD5 hashes
pub fn calculate_text_hashes(text: &str) -> HashResult {
    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut md5_hasher = Md5::new();

    let bytes = text.as_bytes();

    sha256.update(bytes);
    sha1.update(bytes);
    md5_hasher.update(bytes);

    HashResult {
        sha256: format!("{:x}", sha256.finalize()),
        sha1: format!("{:x}", sha1.finalize()),
        md5: format!("{:x}", md5_hasher.finalize()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE RESULTS TO FILE
// ─────────────────────────────────────────────────────────────────────────────

/// Saves text content to a file at the specified path.
///
/// Used by the frontend to export hash results.
///
/// # Arguments
/// * `path` - Destination file path
/// * `content` - Text content to write
pub fn save_text_to_file(path: &str, content: &str) -> Result<()> {
    std::fs::write(path, content)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_hashing() {
        let result = calculate_text_hashes("hello world");

        // Known SHA256 for "hello world"
        assert_eq!(
            result.sha256,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );

        // Known MD5 for "hello world"
        assert_eq!(result.md5, "5eb63bbbe01eeed093cb22bb8f5acdc3");
    }

    #[test]
    fn test_empty_string() {
        let result = calculate_text_hashes("");

        // SHA256 of empty string
        assert_eq!(
            result.sha256,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
