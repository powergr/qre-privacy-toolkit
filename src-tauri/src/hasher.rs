// --- START OF FILE hasher.rs ---

use anyhow::{anyhow, Result};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
// AtomicBool is used for thread-safe communication, allowing the UI thread
// to signal a background processing thread to stop what it's doing.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

use crate::utils::CancelSlot;

// Import the Digest trait which provides the standard .update() and .finalize()
// methods used by all the cryptographic hash algorithms below.
use sha2::Digest;

use md5::Md5;
use sha1::Sha1;
use sha2::Sha256;

/// Formats a digest's raw output bytes as a lowercase hex string.
/// `digest` 0.11's `finalize()` output type no longer implements `LowerHex`
/// directly (unlike 0.10's `GenericArray`), so `format!("{:x}", ...)` no
/// longer works on it - this is the replacement.
fn to_hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

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
#[derive(serde::Serialize, Debug)]
pub struct HashResult {
    pub sha256: String,
    pub sha1: String,
    pub md5: String,
}

/// Basic file properties retrieved before the heavy hashing begins.
#[derive(serde::Serialize, Debug)]
pub struct FileMetadata {
    pub size: u64,
    pub is_file: bool,
    pub is_symlink: bool,
}

/// The progress payload emitted continuously during a long file hash.
#[derive(Clone, serde::Serialize, Debug)]
pub struct ProgressPayload {
    pub bytes_processed: u64,
    pub total_bytes: u64,
    pub percentage: u8,
}

// Hands each hash operation its own cancel flag, and cancels the newest one on request.
// A single shared flag that every run resets would let a new run un-cancel an older one.
static CANCEL_SLOT: CancelSlot = CancelSlot::new();

// ─────────────────────────────────────────────────────────────────────────────
// FILE METADATA VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

pub fn get_file_metadata(path_str: &str) -> Result<FileMetadata> {
    let path = Path::new(path_str);

    if !path.exists() {
        return Err(anyhow!("File not found: {}", path_str));
    }

    let metadata = std::fs::symlink_metadata(path)?;

    let is_file = metadata.is_file();
    let is_symlink = metadata.file_type().is_symlink();

    Ok(FileMetadata {
        size: metadata.len(),
        is_file,
        is_symlink,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// HASH CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/// Core hashing logic decoupled from Tauri and Global State so it can be Unit Tested easily.
/// It takes a cancellation flag and a callback function to report progress.
pub fn calculate_hashes_core<F>(
    path_str: &str,
    cancel_flag: &AtomicBool,
    mut progress_callback: F,
) -> Result<HashResult>
where
    F: FnMut(ProgressPayload),
{
    let path = Path::new(path_str);

    // ─── SECURITY VALIDATION ───
    if !path.exists() {
        return Err(anyhow!("File not found: {}", path_str));
    }

    let metadata = std::fs::symlink_metadata(path)?;

    if !metadata.is_file() {
        return Err(anyhow!(
            "Path is not a regular file. Directories and special files are not supported."
        ));
    }

    if metadata.file_type().is_symlink() {
        return Err(anyhow!("Symlinks are not supported for security reasons."));
    }

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

    // ─── HASH CALCULATION ───
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);

    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut md5_hasher = Md5::new();

    let mut buffer = [0u8; BUFFER_SIZE];
    let mut bytes_processed = 0u64;
    let mut last_progress_report = 0u64;

    loop {
        // Check the provided cancellation flag
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(anyhow!("Hashing cancelled by user"));
        }

        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }

        let slice = &buffer[..count];

        sha256.update(slice);
        sha1.update(slice);
        md5_hasher.update(slice);

        bytes_processed += count as u64;

        if bytes_processed - last_progress_report >= PROGRESS_REPORT_INTERVAL
            || bytes_processed == file_size
        {
            last_progress_report = bytes_processed;

            let percentage = if file_size > 0 {
                ((bytes_processed as f64 / file_size as f64) * 100.0) as u8
            } else {
                100
            };

            progress_callback(ProgressPayload {
                bytes_processed,
                total_bytes: file_size,
                percentage,
            });
        }
    }

    // Final 100% progress update
    progress_callback(ProgressPayload {
        bytes_processed: file_size,
        total_bytes: file_size,
        percentage: 100,
    });

    Ok(HashResult {
        sha256: to_hex(sha256.finalize()),
        sha1: to_hex(sha1.finalize()),
        md5: to_hex(md5_hasher.finalize()),
    })
}

/// The Tauri Command wrapper that the frontend actually calls.
pub fn calculate_hashes<R: tauri::Runtime>(
    path_str: &str,
    app_handle: &tauri::AppHandle<R>,
) -> Result<HashResult> {
    calculate_hashes_with(path_str, &CANCEL_SLOT, |progress| {
        let _ = app_handle.emit("hash-progress", progress);
    })
}

/// Starts a new hash operation on `slot`, so a cancel request reaches this run only.
fn calculate_hashes_with<F>(path_str: &str, slot: &CancelSlot, on_progress: F) -> Result<HashResult>
where
    F: FnMut(ProgressPayload),
{
    let cancel = slot.begin();
    calculate_hashes_core(path_str, &cancel, on_progress)
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION SUPPORT
// ─────────────────────────────────────────────────────────────────────────────

pub fn cancel_hashing() {
    CANCEL_SLOT.cancel();
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT/STRING HASHING
// ─────────────────────────────────────────────────────────────────────────────

pub fn calculate_text_hashes(text: &str) -> HashResult {
    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut md5_hasher = Md5::new();

    let bytes = text.as_bytes();

    sha256.update(bytes);
    sha1.update(bytes);
    md5_hasher.update(bytes);

    HashResult {
        sha256: to_hex(sha256.finalize()),
        sha1: to_hex(sha1.finalize()),
        md5: to_hex(md5_hasher.finalize()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE RESULTS TO FILE
// ─────────────────────────────────────────────────────────────────────────────

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
    use std::fs;
    use std::io::Write;

    // Helper to create a temp file with known text
    fn create_temp_file(name: &str, content: &str) -> std::path::PathBuf {
        let test_dir = std::env::temp_dir().join("qre_hasher_tests");
        fs::create_dir_all(&test_dir).unwrap();

        let path = test_dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn test_text_hashing() {
        let result = calculate_text_hashes("hello world");
        assert_eq!(
            result.sha256,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        assert_eq!(result.md5, "5eb63bbbe01eeed093cb22bb8f5acdc3");
    }

    #[test]
    fn test_empty_string() {
        let result = calculate_text_hashes("");
        assert_eq!(
            result.sha256,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_get_file_metadata() {
        let path = create_temp_file("meta_test.txt", "12345"); // 5 bytes

        let metadata = get_file_metadata(path.to_str().unwrap()).unwrap();
        assert_eq!(metadata.size, 5);
        assert!(metadata.is_file);
        assert!(!metadata.is_symlink);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_file_metadata_not_found() {
        let result = get_file_metadata("/path/does/not/exist.txt");
        assert!(result.is_err());
    }

    #[test]
    fn test_calculate_hashes_core() {
        let path = create_temp_file("hash_target.txt", "hello world");
        let cancel_flag = AtomicBool::new(false); // Isolated test flag

        let result =
            calculate_hashes_core(path.to_str().unwrap(), &cancel_flag, |_progress| {}).unwrap();

        assert_eq!(
            result.sha256,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        assert_eq!(result.md5, "5eb63bbbe01eeed093cb22bb8f5acdc3");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_cancel_hashing() {
        let data = vec![0u8; 10000];
        let path = create_temp_file(
            "cancel_target.txt",
            std::str::from_utf8(&data).unwrap_or(""),
        );

        let cancel_flag = AtomicBool::new(false); // Isolated test flag

        let result = calculate_hashes_core(path.to_str().unwrap(), &cancel_flag, |_progress| {
            // Simulate UI Cancel Button click by mutating the isolated flag
            cancel_flag.store(true, Ordering::Relaxed);
        });

        assert!(
            result.is_err(),
            "Hashing should have been interrupted and returned an Error"
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("cancelled by user"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_cancelled_hash_stays_cancelled_when_another_hash_starts() {
        // Cancel run A, then start run B while A is still going. Starting B must not
        // un-cancel A, which is what a single shared flag that B resets would do.
        let slot = CancelSlot::new();
        let a = create_temp_file("race_a.txt", "contents of file a");
        let b = create_temp_file("race_b.txt", "contents of file b");
        let b_result = std::cell::RefCell::new(None);
        let started_b = std::cell::Cell::new(false);

        let a_result = calculate_hashes_with(a.to_str().unwrap(), &slot, |_progress| {
            if !started_b.replace(true) {
                slot.cancel();
                *b_result.borrow_mut() =
                    Some(calculate_hashes_with(b.to_str().unwrap(), &slot, |_| {}));
            }
        });

        let err = a_result.expect_err("run A was cancelled and must not complete");
        assert!(err.to_string().contains("cancelled by user"), "got: {err}");
        let b_ok = b_result.borrow_mut().take().unwrap();
        assert!(b_ok.is_ok(), "run B was never cancelled and must complete");

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    #[test]
    fn test_cancel_hashing_cancels_the_running_hash() {
        let flag = CANCEL_SLOT.begin();
        assert!(!flag.load(Ordering::SeqCst));
        cancel_hashing();
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn test_cancel_request_only_affects_the_newest_hash() {
        let slot = CancelSlot::new();
        let path = create_temp_file("newest_only.txt", "some data");

        // A cancel sent before any run starts must not leak into the next run.
        slot.cancel();
        let result = calculate_hashes_with(path.to_str().unwrap(), &slot, |_| {});
        assert!(result.is_ok(), "a stale cancel must not stop a fresh run");

        let _ = fs::remove_file(path);
    }
}
// --- END OF FILE hasher.rs ---
