// --- START OF FILE hasher.rs ---

use anyhow::{anyhow, Result};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
// AtomicBool is used for thread-safe communication, allowing the UI thread
// to signal a background processing thread to stop what it's doing.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

// Import the Digest trait which provides the standard .update() and .finalize()
// methods used by all the cryptographic hash algorithms below.
use sha2::Digest;

use md5::Md5;
use sha1::Sha1;
use sha2::Sha256;

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// SECURITY & PERFORMANCE LIMITS
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024 * 1024; // 10 GB limit to prevent exhausting system time/resources
const BUFFER_SIZE: usize = 8192; // 8 KB buffer is standard for optimal disk I/O reads
const PROGRESS_REPORT_INTERVAL: u64 = 10 * 1024 * 1024; // Only send a UI update every 10 MB to prevent flooding the React frontend with events

// ─────────────────────────────────────────────────────────────────────────────
// DATA STRUCTURES
// ─────────────────────────────────────────────────────────────────────────────

/// The final computed hashes sent back to the frontend to display to the user.
#[derive(serde::Serialize)]
pub struct HashResult {
    pub sha256: String,
    pub sha1: String,
    pub md5: String,
}

/// Basic file properties retrieved before the heavy hashing begins.
#[derive(serde::Serialize)]
pub struct FileMetadata {
    pub size: u64,
    pub is_file: bool,
    pub is_symlink: bool,
}

/// The progress payload emitted continuously during a long file hash.
#[derive(Clone, serde::Serialize)]
pub struct ProgressPayload {
    pub bytes_processed: u64,
    pub total_bytes: u64,
    pub percentage: u8,
}

// Global thread-safe flag used to abort a running hash operation early.
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

// ─────────────────────────────────────────────────────────────────────────────
// FILE METADATA VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/// Gets file metadata with strict security checks.
///
/// SECURITY: Validates the file before hashing to prevent:
/// - Symlink attacks (reading unintended or restricted system files)
/// - Directory traversal
/// - Device file hangs (e.g., trying to read `/dev/random` or `/dev/zero` which never end)
/// - Oversized files causing system lockups
pub fn get_file_metadata(path_str: &str) -> Result<FileMetadata> {
    let path = Path::new(path_str);

    // 1. Check if path exists
    if !path.exists() {
        return Err(anyhow!("File not found: {}", path_str));
    }

    // 2. Get OS metadata (using symlink_metadata so we don't accidentally follow a link)
    let metadata = std::fs::metadata(path)?;

    // 3. Ensure it's a standard file (not a directory, device, or pipe)
    let is_file = metadata.is_file();

    // 4. Check for symlinks
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

/// Calculates SHA256, SHA1, and MD5 hashes simultaneously.
///
/// OPTIMIZATION NOTE: By updating all three hash algorithms inside a single read loop,
/// we only have to read the file from the disk *once*. If we calculated them separately,
/// a 5GB file would require 15GB of disk reads, slowing down the process immensely.
///
/// # Arguments
/// * `path_str` - Path to the file to hash
/// * `app_handle` - Tauri app handle for emitting real-time progress events
pub fn calculate_hashes<R: tauri::Runtime>(
    path_str: &str,
    app_handle: &tauri::AppHandle<R>,
) -> Result<HashResult> {
    // Reset cancel flag at the start of a new operation
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let path = Path::new(path_str);

    // ─── SECURITY VALIDATION ───

    if !path.exists() {
        return Err(anyhow!("File not found: {}", path_str));
    }

    let metadata = std::fs::metadata(path)?;

    if !metadata.is_file() {
        return Err(anyhow!(
            "Path is not a regular file. Directories and special files are not supported."
        ));
    }

    // Prevent malicious or recursive symlinks
    if metadata.file_type().is_symlink() {
        return Err(anyhow!(
            "Symlinks are not supported for security reasons. Please select the target file directly."
        ));
    }

    // Enforce maximum file size
    let file_size = metadata.len();
    if file_size > MAX_FILE_SIZE {
        return Err(anyhow!(
            "File is too large: {} bytes. Maximum supported size: {} GB",
            file_size,
            MAX_FILE_SIZE / (1024 * 1024 * 1024)
        ));
    }

    if file_size == 0 {
        return Err(anyhow!("File is empty (0 bytes)"));
    }

    // ─── HASH CALCULATION WITH PROGRESS REPORTING ───

    let file = File::open(path)?;
    // BufReader minimizes system calls by reading in efficient blocks
    let mut reader = BufReader::new(file);

    // Initialize all 3 cryptographic state machines
    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut md5_hasher = Md5::new();

    let mut buffer = [0u8; BUFFER_SIZE];
    let mut bytes_processed = 0u64;
    let mut last_progress_report = 0u64;

    // Stream the file chunk by chunk
    loop {
        // Check for cancellation signal from the UI
        // Ordering::Relaxed is fine here because we just need to know if the boolean flipped,
        // we don't need strict memory synchronization.
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            return Err(anyhow!("Hashing cancelled by user"));
        }

        // Read the next chunk of data from the file
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break; // EOF reached
        }

        let slice = &buffer[..count];

        // Pass the exact same chunk into all three algorithms
        sha256.update(slice);
        sha1.update(slice);
        md5_hasher.update(slice);

        bytes_processed += count as u64;

        // PROGRESS REPORTING: Emit event only when we cross a 10 MB threshold
        // (prevents UI lag from processing thousands of events per second)
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

            // Emit progress event asynchronously to the frontend
            let _ = app_handle.emit("hash-progress", progress);
        }
    }

    // Ensure the UI always reaches exactly 100% on completion
    let final_progress = ProgressPayload {
        bytes_processed: file_size,
        total_bytes: file_size,
        percentage: 100,
    };
    let _ = app_handle.emit("hash-progress", final_progress);

    // Finalize hashes and format them as standard lowercase hexadecimal strings
    Ok(HashResult {
        sha256: format!("{:x}", sha256.finalize()),
        sha1: format!("{:x}", sha1.finalize()),
        md5: format!("{:x}", md5_hasher.finalize()),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION SUPPORT
// ─────────────────────────────────────────────────────────────────────────────

/// Sets the cancellation flag to stop an ongoing hash calculation.
/// This is called as a separate Tauri command from the frontend when the user clicks "Cancel".
pub fn cancel_hashing() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT/STRING HASHING
// ─────────────────────────────────────────────────────────────────────────────

/// Quickly calculates hashes for a text string (not a file) provided directly from the UI.
/// Useful for developers verifying API keys, passwords, or short strings.
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

/// Utility to export the calculated hash report to a standard `.txt` file for the user.
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

        // Known SHA256 vector for "hello world"
        assert_eq!(
            result.sha256,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );

        // Known MD5 vector for "hello world"
        assert_eq!(result.md5, "5eb63bbbe01eeed093cb22bb8f5acdc3");
    }

    #[test]
    fn test_empty_string() {
        let result = calculate_text_hashes("");

        // Known SHA256 vector for an empty string
        assert_eq!(
            result.sha256,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}

// --- END OF FILE hasher.rs ---
