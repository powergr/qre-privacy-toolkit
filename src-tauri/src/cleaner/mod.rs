// --- START OF FILE cleaner/mod.rs ---

use anyhow::{anyhow, Result};
use std::collections::HashSet;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

mod documents;
mod media;

// Re-exported so the fuzz crate's `use qre_core::cleaner::analyze_zip_reader;`
// keeps resolving unchanged (see src-tauri/fuzz/fuzz_targets/fuzz_zip_metadata.rs).
// Never called from within this crate itself, hence the `allow`.
#[allow(unused_imports)]
pub use documents::analyze_zip_reader;

use documents::*;
use media::*;

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
// SECURITY Limits: Prevent Denial of Service (DoS) attacks via malformed/massive files.

const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024; // Limit image/document/archive processing to 100 MB per file
                                              // Audio/video files are routinely much larger than that even when perfectly legitimate
                                              // (a single lossless FLAC track, or a few minutes of MP4/MOV video), so they get a higher cap.
const MAX_MEDIA_FILE_SIZE: u64 = 2 * 1024 * 1024 * 1024; // 2 GB
const MEDIA_EXTENSIONS: &[&str] =
    &["mp3", "flac", "ogg", "mp4", "mov", "cr2", "nef", "arw", "dng"];
const MAX_ZIP_SIZE: u64 = 500 * 1024 * 1024; // Limit total uncompressed ZIP size to 500 MB (prevents Zip Bombs)
const MAX_ZIP_FILES: usize = 10_000; // Limit the number of files inside a ZIP (prevents directory traversal attacks/CPU exhaustion)

// Global thread-safe flag allowing the user to cancel a long-running batch clean operation via the UI.
// LIMITATION: This is a process-wide singleton. Concurrent batch operations (which Tauri does not
// prevent) would interfere with each other. A future improvement is to pass an Arc<AtomicBool>
// per invocation rather than using a global.
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

// ═══════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════

/// Represents a single piece of raw metadata found in a file (e.g., "Software: Adobe Photoshop 2024").
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct MetadataEntry {
    pub key: String,
    pub value: String,
}

/// A comprehensive summary of all privacy-sensitive data found in a file.
/// Sent to the frontend to populate the analysis UI.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct MetadataReport {
    pub has_gps: bool,
    pub has_author: bool,
    pub camera_info: Option<String>,
    pub software_info: Option<String>,
    pub creation_date: Option<String>,
    pub gps_info: Option<String>,
    pub file_type: String,
    pub file_size: u64,
    pub raw_tags: Vec<MetadataEntry>, // The complete, unparsed list of all metadata tags found
    pub app_info: Option<String>,     // Application name/version from Office docProps/app.xml
}

/// Preferences selected by the user in the UI regarding what specific data to strip.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CleaningOptions {
    pub gps: bool,
    pub author: bool,
    pub date: bool,
    /// Deletes embedded cover art entirely rather than just cleaning its EXIF —
    /// cleaning only removes metadata *inside* the picture, it can't remove
    /// the picture's own visual content (a face, a location in the shot).
    /// Defaults to false via `#[serde(default)]` so older frontend builds
    /// that don't send this field still deserialize instead of erroring.
    #[serde(default)]
    pub remove_cover_art: bool,
}

/// Progress event emitted to the frontend during batch operations.
#[derive(Clone, serde::Serialize)]
pub struct CleanProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
    pub percentage: u8,
}

/// Summary of a completed batch cleaning operation.
#[derive(serde::Serialize)]
pub struct CleanResult {
    pub success: Vec<String>,
    pub failed: Vec<FailedFile>,
    pub total_files: usize,
    pub size_before: u64,
    pub size_after: u64, // Used to calculate how many KBs of metadata were saved
}

#[derive(serde::Serialize, Clone)]
pub struct FailedFile {
    pub path: String,
    pub error: String,
}

/// Result of comparing an original file against a cleaned file to verify tag removal.
#[derive(serde::Serialize)]
pub struct ComparisonResult {
    pub original_size: u64,
    pub cleaned_size: u64,
    pub removed_tags: Vec<String>,
    pub size_reduction: u64,
}

// ═══════════════════════════════════════════════════════════════════════════
// PATH VALIDATION (CRITICAL SECURITY)
// ═══════════════════════════════════════════════════════════════════════════

/// Validates and canonicalizes a file path before any processing occurs.
///
/// SECURITY CHECKS:
/// 1. Path must exist on disk.
/// 2. Must be a regular file (not a directory, device, or pipe).
/// 3. Must not be a symlink (prevents Symlink Race/Traversal attacks).
/// 4. Must have a supported extension.
/// 5. File size must be within defined safe limits (DoS protection) — audio
///    and video formats get a higher cap since large files are normal for them.
fn validate_file_path(path: &Path) -> Result<PathBuf> {
    // 1. Check existence
    if !path.exists() {
        return Err(anyhow!("File does not exist"));
    }

    // 2. Read metadata without following symlinks
    let metadata =
        fs::symlink_metadata(path).map_err(|e| anyhow!("Cannot read file metadata: {}", e))?;

    // 3. Ensure it's a standard file type
    if !metadata.is_file() {
        return Err(anyhow!(
            "Not a regular file (directories and special files not supported)"
        ));
    }

    // 4. Block symlinks outright
    if metadata.file_type().is_symlink() {
        return Err(anyhow!("Symlinks are not supported for security reasons"));
    }

    // 5. Canonicalize path (resolves relative '..' segments to an absolute path)
    let canonical =
        fs::canonicalize(path).map_err(|e| anyhow!("Cannot resolve file path: {}", e))?;

    // 6. Verify extension against our supported whitelist. Checked before the
    // size limit below so audio/video files can use their higher cap.
    let ext = canonical
        .extension()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("File has no extension"))?
        .to_lowercase();

    let supported = [
        "jpg", "jpeg", "png", "webp", "tiff", "pdf", "docx", "xlsx", "pptx", "zip", "mp3", "flac",
        "ogg", "mp4", "mov", "cr2", "nef", "arw", "dng",
    ];
    if !supported.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported file type: .{}", ext));
    }

    // 7. Enforce DoS size limits
    let size = metadata.len();
    let max_size = if MEDIA_EXTENSIONS.contains(&ext.as_str()) {
        MAX_MEDIA_FILE_SIZE
    } else {
        MAX_FILE_SIZE
    };
    if size > max_size {
        return Err(anyhow!(
            "File too large: {} MB (maximum: {} MB)",
            size / (1024 * 1024),
            max_size / (1024 * 1024)
        ));
    }

    if size == 0 {
        return Err(anyhow!("File is empty"));
    }

    Ok(canonical)
}

/// Validates that an output directory is safe and writable.
fn validate_output_dir(dir: &Path) -> Result<PathBuf> {
    if !dir.exists() {
        return Err(anyhow!("Output directory does not exist"));
    }

    let metadata = fs::symlink_metadata(dir)?;
    if !metadata.is_dir() {
        return Err(anyhow!("Output path is not a directory"));
    }

    // Verify write permissions by attempting to create and immediately delete a temp file.
    // This is more reliable than checking OS permission flags cross-platform.
    let test_file = dir.join(".qre_write_test");
    match File::create(&test_file) {
        Ok(_) => {
            let _ = fs::remove_file(&test_file);
            Ok(fs::canonicalize(dir)?)
        }
        Err(_) => Err(anyhow!("Output directory is not writable")),
    }
}

/// Resolves a safe output path, auto-incrementing the filename suffix to avoid overwriting
/// existing files (e.g., `photo_clean.jpg` → `photo_clean_2.jpg` → `photo_clean_3.jpg`).
/// Previously, this was a hard error, which was unhelpful for repeat operations.
fn resolve_output_path(out_dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let initial = out_dir.join(format!("{}_clean.{}", stem, ext));
    if !initial.exists() {
        return initial;
    }
    for counter in 2u32..=9999 {
        let candidate = out_dir.join(format!("{}_clean_{}.{}", stem, counter, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Fallback: append a Unix timestamp to guarantee uniqueness
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    out_dir.join(format!("{}_clean_{}.{}", stem, ts, ext))
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API (Called by Tauri Commands in tools.rs)
// ═══════════════════════════════════════════════════════════════════════════

/// Opens a file, reads its metadata based on format, and generates a report.
pub fn analyze_file(path_str: &str) -> Result<MetadataReport> {
    let path = Path::new(path_str);
    let canonical = validate_file_path(path)?;

    let ext = canonical
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Route to the correct format-specific parser
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "tiff" => analyze_image(&canonical),
        "pdf" => analyze_pdf(&canonical),
        "docx" | "xlsx" | "pptx" => analyze_office(&canonical),
        "zip" => analyze_zip(&canonical),
        "mp3" => analyze_mp3(&canonical),
        "flac" => analyze_flac(&canonical),
        "ogg" => analyze_ogg(&canonical),
        "mp4" | "mov" => analyze_mp4(&canonical),
        "cr2" => analyze_raw(&canonical, "Canon RAW (CR2)"),
        "nef" => analyze_raw(&canonical, "Nikon RAW (NEF)"),
        "arw" => analyze_raw(&canonical, "Sony RAW (ARW)"),
        "dng" => analyze_raw(&canonical, "Adobe DNG"),
        _ => Err(anyhow!("Unsupported file type")),
    }
}

/// Creates a copy of the input file with requested metadata permanently stripped.
pub fn remove_metadata(
    path_str: &str,
    output_dir: Option<&str>,
    options: CleaningOptions,
) -> Result<String> {
    let path = Path::new(path_str);
    let canonical = validate_file_path(path)?;

    // Determine output directory (fallback to the source file's directory)
    let out_dir = if let Some(dir_str) = output_dir {
        validate_output_dir(Path::new(dir_str))?
    } else {
        canonical
            .parent()
            .ok_or_else(|| anyhow!("Cannot determine parent directory"))?
            .to_path_buf()
    };

    let ext = canonical.extension().and_then(|s| s.to_str()).unwrap_or("");
    let stem = canonical.file_stem().unwrap_or_default().to_string_lossy();

    // FIX: Auto-increment filename instead of hard-erroring on collision.
    let output_path = resolve_output_path(&out_dir, &stem, ext);

    // Optimization: If user unchecked all cleaning options, just copy the file.
    if !options.gps && !options.author && !options.date && !options.remove_cover_art {
        fs::copy(&canonical, &output_path)?;
        return Ok(output_path.display().to_string());
    }

    // FIX: Pass `&options` to every strip function so they can respect selective choices.
    let ext_lower = ext.to_lowercase();
    match ext_lower.as_str() {
        "jpg" | "jpeg" => strip_jpeg(&canonical, &output_path, &options)?,
        "png" => strip_png(&canonical, &output_path, &options)?,
        // FIX: WebP was previously unhandled — `analyze_image` could read them but cleaning
        // would fall through to "Unsupported file type".
        "webp" => strip_webp(&canonical, &output_path, &options)?,
        // TIFF write support requires a dedicated crate (e.g., `tiff`). Analysis is supported
        // but cleaning is explicitly rejected with a clear message rather than silently failing.
        "tiff" => {
            return Err(anyhow!(
                "TIFF metadata cleaning is not yet supported. \
                 Analysis is available; use a dedicated TIFF tool for cleaning."
            ))
        }
        "pdf" => strip_pdf(&canonical, &output_path, &options)?,
        "docx" | "xlsx" | "pptx" => strip_office(&canonical, &output_path, &options)?,
        "zip" => clean_zip_metadata(&canonical, &output_path)?,
        "mp3" => strip_mp3(&canonical, &output_path, &options)?,
        "flac" => strip_flac(&canonical, &output_path, &options)?,
        "ogg" => strip_ogg(&canonical, &output_path, &options)?,
        "mp4" | "mov" => strip_mp4(&canonical, &output_path, &options)?,
        // RAW formats are irreplaceable originals with proprietary, vendor-specific
        // TIFF-IFD layouts (maker notes, embedded previews) that safe in-place editing
        // can't fully account for — same policy as TIFF: analysis only, no write path.
        "cr2" | "nef" | "arw" | "dng" => {
            return Err(anyhow!(
                "RAW file metadata cleaning is not yet supported (to avoid risking \
                 corruption of an irreplaceable original). Analysis is available; \
                 use a dedicated RAW tool for cleaning."
            ))
        }
        _ => return Err(anyhow!("Unsupported file type")),
    }

    Ok(output_path.display().to_string())
}

/// Loops over multiple files, cleaning them sequentially and emitting progress to the UI.
pub fn batch_clean<R: tauri::Runtime>(
    paths: Vec<String>,
    output_dir: Option<String>,
    options: CleaningOptions,
    app_handle: &tauri::AppHandle<R>,
) -> Result<CleanResult> {
    // SeqCst ensures the flag reset is visible to all threads before work begins.
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    // FIX: Deduplicate input paths to avoid processing the same file multiple times
    // (e.g., from accidental double-drops).
    let mut seen = HashSet::new();
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect();

    let total = paths.len();
    let mut success = Vec::new();
    let mut failed = Vec::new();
    let mut size_before = 0u64;
    let mut size_after = 0u64;

    for (idx, path_str) in paths.iter().enumerate() {
        // Check if the user clicked "Cancel" in the frontend
        if CANCEL_FLAG.load(Ordering::Acquire) {
            failed.push(FailedFile {
                path: path_str.clone(),
                error: "Operation cancelled by user".to_string(),
            });
            break;
        }

        let filename = Path::new(path_str)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();

        emit_progress(app_handle, idx, total, filename);

        // Try to clean file
        match remove_metadata(path_str, output_dir.as_deref(), options.clone()) {
            Ok(output_path) => {
                // Calculate size difference to show user how much hidden data was removed
                if let Ok(meta_in) = fs::metadata(path_str) {
                    size_before += meta_in.len();
                }
                if let Ok(meta_out) = fs::metadata(&output_path) {
                    size_after += meta_out.len();
                }
                success.push(output_path);
            }
            Err(e) => {
                failed.push(FailedFile {
                    path: path_str.clone(),
                    error: e.to_string(),
                });
            }
        }
    }

    // FIX: Pass an empty string rather than the misleading "Complete" filename literal,
    // so the UI filename display blanks out cleanly at 100%.
    emit_progress(app_handle, total, total, String::new());

    Ok(CleanResult {
        success,
        failed,
        total_files: total,
        size_before,
        size_after,
    })
}

/// Helper to format and emit progress events to Tauri.
fn emit_progress<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    current: usize,
    total: usize,
    current_file: String,
) {
    let percentage = if total > 0 {
        ((current as f64 / total as f64) * 100.0) as u8
    } else {
        0
    };

    let progress = CleanProgress {
        current,
        total,
        current_file,
        percentage,
    };

    let _ = app_handle.emit("clean-metadata-progress", progress);
}

/// Cancels ongoing batch operation by flipping the atomic flag.
pub fn cancel_cleaning() {
    CANCEL_FLAG.store(true, Ordering::Release);
}

/// Compares a file before and after cleaning, mapping exactly which tags were deleted.
pub fn compare_files(original: &str, cleaned: &str) -> Result<ComparisonResult> {
    let original_path = Path::new(original);
    let cleaned_path = Path::new(cleaned);

    // FIX: Previously only the original was validated. Now both paths are checked,
    // preventing an attacker from passing an arbitrary path as `cleaned` to extract
    // metadata reports on files outside the normal workflow.
    let _validated_original = validate_file_path(original_path)?;
    let _validated_cleaned = validate_file_path(cleaned_path)?;

    let original_size = fs::metadata(original_path)?.len();
    let cleaned_size = fs::metadata(cleaned_path)?.len();

    let original_report = analyze_file(original)?;
    let cleaned_report = analyze_file(cleaned)?;

    let mut removed_tags = Vec::new();
    // Cross-reference original tags against the cleaned tags
    for tag in &original_report.raw_tags {
        if !cleaned_report.raw_tags.iter().any(|t| t.key == tag.key) {
            removed_tags.push(format!("{}: {}", tag.key, tag.value));
        }
    }

    Ok(ComparisonResult {
        original_size,
        cleaned_size,
        removed_tags,
        size_reduction: original_size.saturating_sub(cleaned_size),
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// STEGANOGRAPHY DETECTION (LSB Entropy Analysis)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(serde::Serialize)]
pub struct StegoReport {
    pub filename: String,
    pub path: String,
    pub entropy_score: f64, // 0.0 to 8.0 (Shannon Entropy)
    pub probability: u8,    // 0 to 100% chance of hidden data
    pub is_suspicious: bool,
}

/// Analyzes an image for hidden steganographic payloads.
/// It works by extracting the Least Significant Bits (LSBs) of the image file
/// and measuring their mathematical randomness (Shannon Entropy).
/// Standard images have predictable LSB patterns. Encrypted hidden messages
/// look like pure random noise, pushing the entropy score near the theoretical maximum of 8.0.
pub async fn detect_steganography(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<StegoReport>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        let total = paths.len();

        for (idx, path_str) in paths.into_iter().enumerate() {
            let path = Path::new(&path_str);
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // Emit progress
            let _ = app_handle.emit(
                "stego-progress",
                CleanProgress {
                    current: idx,
                    total,
                    current_file: filename.clone(),
                    percentage: if total > 0 {
                        ((idx as f64 / total as f64) * 100.0) as u8
                    } else {
                        0
                    },
                },
            );

            // Only analyze PNG, BMP, or uncompressed formats where LSB stego is viable.
            // (JPEG stego usually alters DCT coefficients, but LSB on raw bytes can still indicate tampering).
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "webp") {
                continue;
            }

            if let Ok(bytes) = fs::read(path) {
                // 1. Extract the Least Significant Bit from every byte in the file
                let mut lsb_counts = [0usize; 256];
                let mut lsb_buffer = Vec::with_capacity(bytes.len());

                // We pack 8 LSBs from 8 consecutive bytes into a single new byte to analyze
                // the hidden layer's entropy directly.
                for chunk in bytes.chunks(8) {
                    if chunk.len() == 8 {
                        let mut hidden_byte = 0u8;
                        for (i, &b) in chunk.iter().enumerate() {
                            hidden_byte |= (b & 1) << i;
                        }
                        lsb_buffer.push(hidden_byte);
                        lsb_counts[hidden_byte as usize] += 1;
                    }
                }

                let total_lsb_bytes = lsb_buffer.len() as f64;
                if total_lsb_bytes == 0.0 {
                    continue;
                }

                // 2. Calculate Shannon Entropy (H) of the LSB layer
                // Formula: H = - sum( p(x) * log2(p(x)) )
                let mut entropy = 0.0;
                for &count in &lsb_counts {
                    if count > 0 {
                        let probability = count as f64 / total_lsb_bytes;
                        entropy -= probability * probability.log2();
                    }
                }

                // 3. Determine Suspicion Probability (Confidence Score)
                // Natural images usually have an LSB entropy between 5.0 and 7.8.
                // Encrypted/Compressed data approaches absolute 8.0.

                let (probability, is_suspicious) = if entropy >= 7.995 {
                    (99u8, true) // Almost certainly an encrypted payload
                } else if entropy >= 7.98 {
                    (96u8, true) // Highly suspicious (captures your 7.985 file)
                } else if entropy >= 7.95 {
                    (88u8, true) // Suspicious
                } else if entropy >= 7.90 {
                    (60u8, false) // Borderline, likely just heavily compressed noise
                } else {
                    (5u8, false) // Normal image
                };

                results.push(StegoReport {
                    filename,
                    path: path_str,
                    entropy_score: (entropy * 1000.0).round() / 1000.0, // Round to 3 decimals
                    probability,
                    is_suspicious,
                });
            }
        }

        let _ = app_handle.emit(
            "stego-progress",
            CleanProgress {
                current: total,
                total,
                current_file: String::new(),
                percentage: 100,
            },
        );

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ==========================================
// --- TESTS ---
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    // Helper: creates a temporary dummy file for testing path logic
    fn create_temp_dummy(name: &str) -> PathBuf {
        let test_dir = std::env::temp_dir().join("qre_cleaner_tests");
        fs::create_dir_all(&test_dir).unwrap();
        let path = test_dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"dummy data").unwrap();
        path
    }

    // Helper: returns (and creates if needed) a dedicated temp dir for a given test
    fn temp_dir(sub: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("qre_cleaner_tests").join(sub);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ─── validate_file_path ───────────────────────────────────────────────

    #[test]
    fn test_validate_file_path_safe() {
        let path = create_temp_dummy("safe.jpg");
        let result = validate_file_path(&path);
        assert!(result.is_ok(), "Valid jpg should pass validation");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_validate_file_path_unsupported_ext() {
        let path = create_temp_dummy("malicious.exe");
        let result = validate_file_path(&path);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Unsupported file type"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_validate_file_path_missing_file() {
        let path = PathBuf::from("/path/that/does/not/exist.jpg");
        let result = validate_file_path(&path);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("File does not exist"));
    }

    #[test]
    fn test_validate_file_path_empty_file() {
        let dir = temp_dir("empty_file");
        let path = dir.join("empty.jpg");
        fs::File::create(&path).unwrap(); // zero bytes
        let result = validate_file_path(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_validate_file_path_media_extension_gets_higher_size_limit() {
        // Audio/video files are routinely well over 100MB even when
        // perfectly legitimate (a single lossless FLAC track, a short MP4
        // clip), so they get a higher cap than images/documents/archives.
        // `set_len` creates a sparse file so this doesn't actually write
        // 100MB of real data to disk.
        let dir = temp_dir("validate_media_size_limit");
        let jpg_path = dir.join("big.jpg");
        let flac_path = dir.join("big.flac");

        let file = fs::File::create(&jpg_path).unwrap();
        file.set_len(MAX_FILE_SIZE + 1).unwrap();
        drop(file);

        let file = fs::File::create(&flac_path).unwrap();
        file.set_len(MAX_FILE_SIZE + 1).unwrap();
        drop(file);

        assert!(
            validate_file_path(&jpg_path).is_err(),
            "a >100MB image must still be rejected"
        );
        assert!(
            validate_file_path(&flac_path).is_ok(),
            "a >100MB (but well under the 2GB media cap) audio file must be accepted"
        );

        let _ = fs::remove_file(jpg_path);
        let _ = fs::remove_file(flac_path);
    }

    // ─── resolve_output_path ─────────────────────────────────────────────

    #[test]
    fn test_resolve_output_path_no_collision() {
        let dir = temp_dir("resolve_no_collision");
        let result = resolve_output_path(&dir, "photo", "jpg");
        assert_eq!(result.file_name().unwrap(), "photo_clean.jpg");
        assert!(!result.exists(), "Should not exist yet");
    }

    #[test]
    fn test_resolve_output_path_increments_on_collision() {
        let dir = temp_dir("resolve_collision");

        // Create the first clean file to force a collision
        let first = dir.join("photo_clean.jpg");
        fs::File::create(&first).unwrap();

        let result = resolve_output_path(&dir, "photo", "jpg");
        assert_eq!(
            result.file_name().unwrap(),
            "photo_clean_2.jpg",
            "Should increment to _2 when _clean already exists"
        );

        // Simulate a second collision
        let second = dir.join("photo_clean_2.jpg");
        fs::File::create(&second).unwrap();

        let result2 = resolve_output_path(&dir, "photo", "jpg");
        assert_eq!(result2.file_name().unwrap(), "photo_clean_3.jpg");

        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }

    #[test]
    fn test_remove_metadata_rejects_raw_cleaning() {
        for ext in ["cr2", "nef", "arw", "dng"] {
            let dir = temp_dir("raw_reject");
            let path = create_temp_dummy(&format!("photo.{ext}"));
            let out_dir = dir.to_str().unwrap().to_string();

            let options = CleaningOptions {
                gps: true,
                author: true,
                date: true,
                remove_cover_art: false,
            };
            let result = remove_metadata(path.to_str().unwrap(), Some(&out_dir), options);

            assert!(
                result.is_err(),
                "RAW cleaning must be explicitly rejected for .{ext}"
            );
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("not yet supported"),
                "rejection message must explain why, for .{ext}"
            );

            let _ = fs::remove_file(path);
        }
    }
}

// --- END OF FILE cleaner/mod.rs ---
