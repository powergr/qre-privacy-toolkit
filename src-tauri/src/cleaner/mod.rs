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
    pub extracted_text: Option<String>, // e.g. "G channel: \"lsb_is_the_key\"" when directly recovered
    pub error: Option<String>, // set when this file couldn't be analyzed at all (unsupported format, failed to decode, ...)
}

/// Packs the LSB of every 8 consecutive pixel bytes into one "hidden" byte, then computes
/// the Shannon Entropy (H = -sum(p(x) * log2(p(x)))) of that hidden byte stream.
/// Returns `None` if there weren't enough bytes to form a single 8-byte chunk.
fn lsb_entropy(pixel_bytes: &[u8]) -> Option<f64> {
    let mut lsb_counts = [0usize; 256];
    let mut total_lsb_bytes = 0usize;

    for chunk in pixel_bytes.chunks_exact(8) {
        let mut hidden_byte = 0u8;
        for (i, &b) in chunk.iter().enumerate() {
            hidden_byte |= (b & 1) << i;
        }
        lsb_counts[hidden_byte as usize] += 1;
        total_lsb_bytes += 1;
    }

    if total_lsb_bytes == 0 {
        return None;
    }

    let total = total_lsb_bytes as f64;
    let mut entropy = 0.0;
    for &count in &lsb_counts {
        if count > 0 {
            let probability = count as f64 / total;
            entropy -= probability * probability.log2();
        }
    }
    Some(entropy)
}

/// Window size (in bytes-per-channel, i.e. pixels) used by [`max_channel_anomaly`].
/// Calibrated by observation against a single real-world test image (see the tests below);
/// this is a starting point, not a value validated across a broad corpus of real photos.
const STEGO_WINDOW_SIZE: usize = 2048;

/// Extracts one color channel's bytes from an interleaved multi-channel pixel buffer —
/// e.g. every 3rd byte for RGB8 (`channel_count = 3`), every 4th for RGBA8 (`channel_count = 4`).
fn extract_channel(pixel_bytes: &[u8], channel_count: usize, channel_offset: usize) -> Vec<u8> {
    pixel_bytes
        .iter()
        .skip(channel_offset)
        .step_by(channel_count)
        .copied()
        .collect()
}

/// Finds the single most statistically anomalous window across all color channels.
///
/// A whole-image entropy average (the original approach) is blind to small, localized
/// payloads — they get diluted into insignificance by the rest of the image. A single global
/// "highest entropy window anywhere" fixes that, but *loses* against ordinary detailed photo
/// content: a genuinely busy, non-tampered region (foliage, text, fine texture) can easily be
/// higher entropy in absolute terms than a small tampered one — false negatives *and* false
/// positives, depending on the image.
///
/// The fix here is to compare each channel only against *its own* image-wide window-entropy
/// distribution (a z-score), instead of an absolute threshold. LSB steganography tools
/// typically write to one channel at a time (this app was tested against exactly that: a
/// message hidden only in the green channel). Real photo detail affects all channels
/// similarly — sensor/compression noise doesn't pick favorites — so it raises every channel's
/// baseline together and washes out in the comparison. A single tampered channel, on the
/// other hand, decorrelates from its own history and from its sibling channels, which is what
/// actually stands out.
///
/// Returns `(entropy_of_the_most_anomalous_window, its_z_score)`, or `None` if no channel had
/// enough windows to build a baseline (tiny images) or had zero variance to compare against
/// (e.g. a single solid color).
fn max_channel_anomaly(
    pixel_bytes: &[u8],
    channel_count: usize,
    window_size: usize,
) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64)> = None;

    for channel_offset in 0..channel_count {
        let channel = extract_channel(pixel_bytes, channel_count, channel_offset);
        let windows: Vec<f64> = channel
            .chunks(window_size)
            .filter_map(lsb_entropy)
            .collect();
        if windows.len() < 2 {
            continue; // not enough windows in this channel to build a baseline
        }

        let mean: f64 = windows.iter().sum::<f64>() / windows.len() as f64;
        let variance: f64 =
            windows.iter().map(|w| (w - mean).powi(2)).sum::<f64>() / windows.len() as f64;
        let std = variance.sqrt();
        if std < 1e-9 {
            continue; // this channel has zero variance (e.g. a solid color) - nothing to compare against
        }

        for &entropy in &windows {
            let z = (entropy - mean) / std;
            if best.is_none_or(|(_, best_z)| z > best_z) {
                best = Some((entropy, z));
            }
        }
    }

    best
}

/// Maps a per-channel windowed anomaly z-score (see [`max_channel_anomaly`]) to a suspicion
/// probability / flag.
///
/// Calibrated against exactly one real-world image: the natural worst-case z-score observed
/// on an untouched photo, at this window size, was ~2.8 — so the cutoffs below sit with a
/// safety margin above that. This has NOT been validated across a broad corpus of real
/// photos and should be treated as a starting point, not a proven threshold. It's also
/// fundamentally blind to very small payloads (well under a hundred bytes) relative to a
/// large image — no entropy-based statistic, windowed or not, can reliably separate a few
/// dozen tampered bytes from the noise floor of a multi-megapixel image.
fn stego_probability(z_score: f64) -> (u8, bool) {
    if z_score >= 6.0 {
        (99, true) // Almost certainly an encrypted payload
    } else if z_score >= 4.5 {
        (92, true) // Highly suspicious
    } else if z_score >= 3.5 {
        (75, true) // Suspicious
    } else if z_score >= 2.8 {
        (40, false) // Borderline - within reach of natural per-channel variance
    } else {
        (5, false) // Normal image
    }
}

/// Number of channel bytes (≈ pixels) scanned per channel when looking for a plaintext LSB
/// message. Capped for speed and scope: naive LSB tools embed sequentially starting at pixel
/// 0, so this comfortably covers any realistically-sized secret (up to ~8 KB) without having
/// to scan an entire multi-megapixel image bit by bit.
const LSB_EXTRACT_SCAN_BYTES: usize = 65_536;

/// Target false-positive rate for the *entire* extraction pass on one image (all channels x
/// both bit orders combined). This is shown to the user as a 99%-confidence "hidden text
/// recovered" result, so it needs to be rare on ordinary images, not just unlikely for any
/// one window in isolation.
const LSB_TEXT_FALSE_POSITIVE_TARGET: f64 = 1e-4; // roughly 1 in 10,000 image scans

/// Probability that a byte packed from 8 random LSBs falls in the printable range (0x20..=0x7E
/// plus \t \n \r) — 98 of 256 possible values, assuming unbiased, independent LSBs.
const PRINTABLE_BYTE_PROBABILITY: f64 = 98.0 / 256.0;

/// How much of a found message to actually show the user.
const LSB_TEXT_PREVIEW_MAX: usize = 120;

/// The minimum printable-byte run length needed to keep the overall false-positive rate for
/// one image scan under [`LSB_TEXT_FALSE_POSITIVE_TARGET`], given how many independent
/// (channel, bit-order) trials are run and how many packed bytes each trial scans.
///
/// This used to be a flat constant (12) picked by computing the odds of one specific run
/// being that long — which is the wrong question. What actually matters is the odds of the
/// *longest* run among thousands of sequential windows, across several channels and bit
/// orders, reaching that length by pure chance — a completely different, far more permissive
/// statistic (a classic extreme-value-statistics mix-up). That gap is exactly why a real
/// false positive appeared on ordinary image content: `wo:q30vapvXe`, a 12-character run,
/// isn't a message, it's what "the longest run among ~8,000 windows tends to reach anyway."
///
/// Derivation: for N independent Bernoulli(p) trials, P(longest run ≥ L) ≈ N × p^L for small
/// probabilities. Solving `N × p^L < per_trial_target` for `L` gives the formula below. This
/// assumes independent, unbiased LSBs — real image data only approximates that — so treat
/// the result as a principled starting point, not a proven guarantee.
fn min_required_run(samples_per_trial: usize, trial_count: usize) -> usize {
    let per_trial_target = LSB_TEXT_FALSE_POSITIVE_TARGET / trial_count as f64;
    let l = (per_trial_target / samples_per_trial as f64).ln() / PRINTABLE_BYTE_PROBABILITY.ln();
    l.ceil().max(1.0) as usize
}

#[derive(Clone, Copy)]
enum BitOrder {
    /// The first extracted bit becomes the output byte's least significant bit.
    LsbFirst,
    /// The first extracted bit becomes the output byte's most significant bit.
    MsbFirst,
}

/// Packs a stream of single bits (each 0 or 1) into bytes using the given convention.
/// Trailing bits that don't fill a complete byte are dropped.
fn pack_bits(bits: &[u8], order: BitOrder) -> Vec<u8> {
    bits.chunks_exact(8)
        .map(|chunk| {
            let mut byte = 0u8;
            for (i, &bit) in chunk.iter().enumerate() {
                let shift = match order {
                    BitOrder::LsbFirst => i,
                    BitOrder::MsbFirst => 7 - i,
                };
                byte |= bit << shift;
            }
            byte
        })
        .collect()
}

/// Printable ASCII, plus common whitespace.
fn is_printable(b: u8) -> bool {
    (0x20..=0x7e).contains(&b) || matches!(b, b'\t' | b'\n' | b'\r')
}

/// Finds the longest run of printable bytes in `bytes`. A non-printable byte (including a NUL
/// terminator, which naive embedding tools commonly use to mark the end of a message) breaks
/// the run. Returns `(start_index, length)`.
fn longest_printable_run(bytes: &[u8]) -> (usize, usize) {
    let mut best = (0, 0);
    let mut run_start = 0;
    let mut run_len = 0;
    for (i, &b) in bytes.iter().enumerate() {
        if is_printable(b) {
            if run_len == 0 {
                run_start = i;
            }
            run_len += 1;
            if run_len > best.1 {
                best = (run_start, run_len);
            }
        } else {
            run_len = 0;
        }
    }
    best
}

fn channel_name(channel_count: usize, offset: usize) -> &'static str {
    match offset {
        0 => "R",
        1 => "G",
        2 => "B",
        3 if channel_count == 4 => "A",
        _ => "?",
    }
}

/// Floor for the minimum number of *distinct* byte values required within a matched run
/// (scaled up further for longer runs — see `extract_lsb_text`). A perfectly periodic LSB
/// pattern - which can occur naturally, e.g. from dithering or certain PNG filter rows - can
/// pack into a long run of a single repeated printable character. That's a pattern, not a
/// message, so it's rejected here rather than reported as a 99%-confidence hit.
const LSB_TEXT_MIN_DISTINCT: usize = 5;

fn distinct_byte_count(bytes: &[u8]) -> usize {
    let mut seen = [false; 256];
    let mut count = 0;
    for &b in bytes {
        if !seen[b as usize] {
            seen[b as usize] = true;
            count += 1;
        }
    }
    count
}

/// A directly recovered plaintext message: which channel it came from, and a preview of it.
struct LsbTextHit {
    channel: &'static str,
    preview: String,
}

/// Tries to directly recover a plaintext message from each channel's LSB plane, trying both
/// bit-packing conventions. Unlike entropy analysis, this isn't blind to message size the
/// same way — it doesn't get diluted by the rest of the image just because the message is
/// short. It has a *different* floor instead: [`min_required_run`] requires a long enough
/// printable run that it can't be mistaken for the longest coincidental run among thousands of
/// scanned windows. In practice that means realistically-sized secrets (20+ characters — most
/// passwords, seed phrases, API keys, notes) are caught reliably, but a very short adversarial
/// test string may not be, the same fundamental limitation as the entropy path just showing up
/// for a different statistical reason.
///
/// It only catches *plaintext* payloads, though: an encrypted or compressed hidden blob
/// extracts as random bytes here, not text. [`max_channel_anomaly`] exists for that case.
fn extract_lsb_text(pixel_bytes: &[u8], channel_count: usize) -> Option<LsbTextHit> {
    let mut best: Option<(usize, LsbTextHit)> = None; // (run length, hit)

    // Computed from the *nominal* scan size (not the image's actual byte count) so the
    // required run length never relaxes just because a particular image happens to be small.
    let samples_per_trial = LSB_EXTRACT_SCAN_BYTES / 8;
    let trial_count = channel_count * 2; // channels x bit orders
    let min_run = min_required_run(samples_per_trial, trial_count);
    // Scale the diversity floor with run length too: a longer required run makes a low-
    // diversity (repeating-pattern) match even less likely to be real text by coincidence.
    let min_distinct = (min_run / 3).max(LSB_TEXT_MIN_DISTINCT);

    for channel_offset in 0..channel_count {
        let bits: Vec<u8> = pixel_bytes
            .iter()
            .skip(channel_offset)
            .step_by(channel_count)
            .take(LSB_EXTRACT_SCAN_BYTES)
            .map(|b| b & 1)
            .collect();

        for order in [BitOrder::LsbFirst, BitOrder::MsbFirst] {
            let bytes = pack_bits(&bits, order);
            let (start, len) = longest_printable_run(&bytes);
            if len < min_run {
                continue;
            }
            let run = &bytes[start..start + len];
            if distinct_byte_count(run) < min_distinct {
                continue; // looks like a repeating pattern, not real text
            }

            let is_better = match &best {
                None => true,
                Some((best_len, _)) => len > *best_len,
            };
            if is_better {
                let preview_len = len.min(LSB_TEXT_PREVIEW_MAX);
                let mut preview: String = run[..preview_len].iter().map(|&b| b as char).collect();
                if preview_len < len {
                    preview.push_str("...");
                }
                best = Some((
                    len,
                    LsbTextHit {
                        channel: channel_name(channel_count, channel_offset),
                        preview,
                    },
                ));
            }
        }
    }

    best.map(|(_, hit)| hit)
}

/// Formats the steganography scan actually supports. Lowercase, no leading dot.
fn is_supported_stego_format(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "bmp" | "webp")
}

/// Analyzes an image for hidden steganographic payloads.
/// It works by extracting the Least Significant Bits (LSBs) of the image's *decoded pixel
/// data*, in windows, and measuring which window (if any) is a statistical outlier relative
/// to its own color channel's baseline. See [`max_channel_anomaly`] for why windowed,
/// per-channel comparison — not a single whole-image score — is what makes this able to
/// catch a payload confined to one channel or one region of the image.
/// This is combined with a direct plaintext-recovery pass ([`extract_lsb_text`]) that catches
/// simple hidden messages the statistical approach structurally can't (see its own doc
/// comment) — together they cover both realistic threats: an obvious hidden note, and a
/// deliberately randomized/encrypted payload.
///
/// IMPORTANT: this must run on decoded pixel bytes, never on the raw on-disk file bytes.
/// PNG/JPEG/WebP are already compressed formats (DEFLATE / DCT+Huffman) — a compressed
/// bitstream is, by design, close to statistically random, so measuring entropy over the
/// raw file would score nearly every efficiently-compressed photo as "suspicious" regardless
/// of whether anything is actually hidden. Decoding first (via the `image` crate) gets us
/// back to the pixel values LSB steganography actually hides inside.
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

            // Every branch below pushes exactly one StegoReport for this file - a scanned
            // file that can't be analyzed must say so, not silently vanish from the results.
            // (Silently dropping unsupported/undecodable files was itself the bug here.)
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !is_supported_stego_format(&ext) {
                results.push(StegoReport {
                    filename,
                    path: path_str,
                    entropy_score: 0.0,
                    probability: 0,
                    is_suspicious: false,
                    extracted_text: None,
                    error: Some(format!(
                        "Unsupported format{} — only PNG, JPG, BMP, and WebP can be analyzed",
                        if ext.is_empty() {
                            String::new()
                        } else {
                            format!(" (.{ext})")
                        }
                    )),
                });
                continue;
            }

            // Decode to raw pixel bytes (not the compressed file bytes). Alpha is included
            // only when the source image actually has one — some LSB tools hide payloads in
            // the alpha channel specifically, since it's the least visually noticeable one.
            // Synthesizing a fake opaque alpha channel for images without one would inject a
            // constant (non-random) byte into the stream, so we only ever use real channels.
            let img = match image::open(path) {
                Ok(img) => img,
                Err(e) => {
                    results.push(StegoReport {
                        filename,
                        path: path_str,
                        entropy_score: 0.0,
                        probability: 0,
                        is_suspicious: false,
                        extracted_text: None,
                        error: Some(format!("Could not decode image: {e}")),
                    });
                    continue;
                }
            };

            let has_alpha = img.color().has_alpha();
            let (pixel_bytes, channel_count) = if has_alpha {
                (img.to_rgba8().into_raw(), 4)
            } else {
                (img.to_rgb8().into_raw(), 3)
            };

            let (entropy, probability, is_suspicious) =
                match max_channel_anomaly(&pixel_bytes, channel_count, STEGO_WINDOW_SIZE) {
                    Some((entropy, z_score)) => {
                        let (probability, is_suspicious) = stego_probability(z_score);
                        (entropy, probability, is_suspicious)
                    }
                    // Image too small to build a per-channel window baseline (or every
                    // channel is perfectly flat) - fall back to a single whole-image
                    // reading with no statistical confidence behind it. Never flagged as
                    // suspicious: there isn't enough data to distinguish tampering from
                    // normal content.
                    None => match lsb_entropy(&pixel_bytes) {
                        Some(entropy) => (entropy, 5, false),
                        None => {
                            results.push(StegoReport {
                                filename,
                                path: path_str,
                                entropy_score: 0.0,
                                probability: 0,
                                is_suspicious: false,
                                extracted_text: None,
                                error: Some("Image too small to analyze".to_string()),
                            });
                            continue;
                        }
                    },
                };

            // A direct plaintext hit is decisive - it overrides the statistical read
            // regardless of what the entropy analysis concluded on its own. entropy_score
            // still reflects the real computed value either way, for transparency.
            let extracted_text = extract_lsb_text(&pixel_bytes, channel_count)
                .map(|hit| format!("{} channel: \"{}\"", hit.channel, hit.preview));
            let (probability, is_suspicious) = if extracted_text.is_some() {
                (99, true)
            } else {
                (probability, is_suspicious)
            };

            results.push(StegoReport {
                filename,
                path: path_str,
                entropy_score: (entropy * 1000.0).round() / 1000.0, // Round to 3 decimals
                probability,
                is_suspicious,
                extracted_text,
                error: None,
            });
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

    // ─── lsb_entropy / stego_probability ──────────────────────────────────

    #[test]
    fn test_lsb_entropy_uniform_bytes_is_zero() {
        let bytes = vec![0u8; 800]; // 100 chunks of 8 identical bytes
        let entropy = lsb_entropy(&bytes).expect("buffer long enough for one chunk");
        assert!(
            entropy.abs() < 1e-9,
            "identical bytes must have zero LSB entropy, got {entropy}"
        );
    }

    #[test]
    fn test_lsb_entropy_too_short_returns_none() {
        let bytes = vec![0u8; 4]; // shorter than one 8-byte chunk
        assert!(lsb_entropy(&bytes).is_none());
    }

    #[test]
    fn test_lsb_entropy_uniform_distribution_is_near_max() {
        // Construct a buffer where every one of the 256 possible "hidden bytes" appears
        // with equal frequency, by directly encoding each value's bits into a chunk's LSBs.
        let mut bytes = Vec::new();
        for h in 0u16..256 {
            for _ in 0..4 {
                for i in 0..8u8 {
                    bytes.push(((h >> i) & 1) as u8);
                }
            }
        }
        let entropy = lsb_entropy(&bytes).expect("buffer long enough");
        assert!(
            (entropy - 8.0).abs() < 1e-9,
            "a uniform distribution over all 256 hidden-byte values must hit the theoretical max, got {entropy}"
        );
    }

    #[test]
    fn test_stego_probability_thresholds() {
        assert_eq!(stego_probability(6.0), (99, true));
        assert_eq!(stego_probability(4.5), (92, true));
        assert_eq!(stego_probability(3.5), (75, true));
        assert_eq!(stego_probability(2.8), (40, false));
        assert_eq!(stego_probability(0.0), (5, false));
        assert_eq!(stego_probability(-1.0), (5, false));
    }

    #[test]
    fn test_stego_analysis_reads_decoded_pixels_not_compressed_file_bytes() {
        // Regression test for the original bug: a solid-color image compresses to a small,
        // highly-structured PNG, but the analysis must run on *decoded pixel* bytes, not
        // the compressed file bytes — so it should score this as low-entropy / not suspicious,
        // never near the 8.0 max a compressed bitstream would misleadingly produce.
        let dir = temp_dir("stego_pixel_decode");
        let path = dir.join("solid.png");

        let img = image::RgbImage::from_pixel(64, 64, image::Rgb([10, 20, 30]));
        img.save(&path).expect("failed to write test PNG");

        let decoded = image::open(&path).expect("failed to decode test PNG");
        let pixel_bytes = decoded.to_rgb8().into_raw();
        let entropy = lsb_entropy(&pixel_bytes).expect("decoded image should yield pixel bytes");

        assert!(
            entropy < 0.01,
            "a solid-color image's pixel LSBs are all identical and must score near-zero entropy, got {entropy}"
        );

        let _ = fs::remove_file(&path);
    }

    // ─── extract_channel ───────────────────────────────────────────────────

    #[test]
    fn test_extract_channel_rgb() {
        // Two RGB pixels: (1,2,3), (4,5,6)
        let rgb = [1u8, 2, 3, 4, 5, 6];
        assert_eq!(extract_channel(&rgb, 3, 0), vec![1, 4]); // R
        assert_eq!(extract_channel(&rgb, 3, 1), vec![2, 5]); // G
        assert_eq!(extract_channel(&rgb, 3, 2), vec![3, 6]); // B
    }

    #[test]
    fn test_extract_channel_rgba() {
        let rgba = [1u8, 2, 3, 255, 4, 5, 6, 255];
        assert_eq!(extract_channel(&rgba, 4, 3), vec![255, 255]); // alpha
    }

    // ─── max_channel_anomaly ───────────────────────────────────────────────

    #[test]
    fn test_max_channel_anomaly_flat_image_returns_none() {
        // A perfectly uniform image: every channel has zero variance across windows,
        // nothing to compare against.
        let pixels = vec![42u8; 3 * STEGO_WINDOW_SIZE * 4]; // several windows' worth, all channels
        assert!(max_channel_anomaly(&pixels, 3, STEGO_WINDOW_SIZE).is_none());
    }

    #[test]
    fn test_max_channel_anomaly_too_small_returns_none() {
        let pixels = vec![1u8, 2, 3, 4, 5, 6]; // two pixels - nowhere near one window
        assert!(max_channel_anomaly(&pixels, 3, STEGO_WINDOW_SIZE).is_none());
    }

    #[test]
    fn test_max_channel_anomaly_isolates_a_single_tampered_channel() {
        // Deterministic LCG standing in for "random noise".
        let mut state: u64 = 0x1234_5678_9abc_def0;
        let mut next_bit = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((state >> 33) & 1) as u8
        };

        // Build a synthetic RGB buffer: a flat, low-entropy baseline (every untouched window
        // has identical LSB structure - e.g. a simple/solid-color source image) with enough
        // windows that a single tampered one stands out with a comfortable statistical margin.
        let window_count = 40;
        let total_pixels = STEGO_WINDOW_SIZE * window_count;
        let mut pixels = vec![0u8; total_pixels * 3];
        for (i, p) in pixels.iter_mut().enumerate() {
            *p = ((i * 37) % 200) as u8; // deterministic, low-entropy base values
        }

        // Fully randomize every LSB of the Green channel in just the first window - this is
        // the "tampered channel, tampered region" case.
        for pixel_idx in 0..STEGO_WINDOW_SIZE {
            let g_offset = pixel_idx * 3 + 1;
            let bit = next_bit();
            pixels[g_offset] = (pixels[g_offset] & !1) | bit;
        }

        let (entropy, z) = max_channel_anomaly(&pixels, 3, STEGO_WINDOW_SIZE)
            .expect("buffer has multiple windows with real variance");

        assert!(
            z > 4.0,
            "a fully-randomized window in one channel must be a clear statistical outlier, got z={z}"
        );
        assert!(entropy > 6.0, "the flagged window's own entropy should be high, got {entropy}");

        let (_, is_suspicious) = stego_probability(z);
        assert!(is_suspicious, "this should clear the suspicion threshold, z={z}");
    }

    #[test]
    fn test_max_channel_anomaly_clean_buffer_is_not_flagged() {
        // Same synthetic baseline as above, but with no tampering at all.
        let window_count = 40;
        let total_pixels = STEGO_WINDOW_SIZE * window_count;
        let mut pixels = vec![0u8; total_pixels * 3];
        for (i, p) in pixels.iter_mut().enumerate() {
            *p = ((i * 37) % 200) as u8;
        }

        // An entirely deterministic, repeating pattern has *zero* variance across identical
        // windows, so this hits the "not enough variance to compare against" path - which is
        // itself never flagged as suspicious.
        match max_channel_anomaly(&pixels, 3, STEGO_WINDOW_SIZE) {
            None => {} // no baseline variance - correctly not flagged
            Some((_, z)) => {
                let (_, is_suspicious) = stego_probability(z);
                assert!(!is_suspicious, "an untampered buffer must not be flagged, z={z}");
            }
        }
    }

    // ─── pack_bits / longest_printable_run / extract_lsb_text ─────────────

    #[test]
    fn test_pack_bits_lsb_first() {
        // 'A' = 0x41 = 0b01000001. LSB-first means the first bit extracted is bit 0.
        let bits = [1, 0, 0, 0, 0, 0, 1, 0]; // bit0..bit7 of 0x41
        assert_eq!(pack_bits(&bits, BitOrder::LsbFirst), vec![0x41]);
    }

    #[test]
    fn test_pack_bits_msb_first() {
        // Same byte, but the first bit extracted lands in the MSB position instead.
        let bits = [0, 1, 0, 0, 0, 0, 0, 1]; // written MSB..LSB order for 0x41
        assert_eq!(pack_bits(&bits, BitOrder::MsbFirst), vec![0x41]);
    }

    #[test]
    fn test_pack_bits_drops_trailing_partial_byte() {
        let bits = [1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1]; // 8 bits + 3 leftover
        assert_eq!(pack_bits(&bits, BitOrder::LsbFirst).len(), 1);
    }

    #[test]
    fn test_longest_printable_run_finds_the_longest_and_stops_at_nul() {
        // "hi" (printable) + NUL + "hello_world!" (printable, longer) + non-ASCII byte.
        let mut bytes = b"hi".to_vec();
        bytes.push(0x00);
        bytes.extend_from_slice(b"hello_world!");
        bytes.push(0xFF);

        let (start, len) = longest_printable_run(&bytes);
        assert_eq!(len, 12); // "hello_world!"
        assert_eq!(&bytes[start..start + len], b"hello_world!");
    }

    #[test]
    fn test_longest_printable_run_all_binary_is_zero() {
        let bytes = [0x00u8, 0xFF, 0x01, 0x02, 0x80];
        assert_eq!(longest_printable_run(&bytes), (0, 0));
    }

    #[test]
    fn test_extract_lsb_text_finds_message_in_correct_channel() {
        // Embed a message in the Blue channel (offset 2 of 3) of an otherwise all-zero RGB
        // buffer, LSB-first, starting at pixel 0. Deliberately long (comfortably above the
        // ~21-character floor min_required_run derives for a 3-channel scan) so this test
        // stays valid regardless of exactly where that derived floor lands.
        let message = b"this_is_a_hidden_secret_message_right_here";
        let pixel_count = message.len() * 8 + 100; // plenty of trailing untouched pixels
        let mut pixels = vec![0u8; pixel_count * 3];

        let mut bit_idx = 0;
        for byte in message {
            for i in 0..8u8 {
                let bit = (byte >> i) & 1;
                let offset = bit_idx * 3 + 2; // Blue channel
                pixels[offset] = (pixels[offset] & !1) | bit;
                bit_idx += 1;
            }
        }

        let hit = extract_lsb_text(&pixels, 3).expect("message should be recovered");
        assert_eq!(hit.channel, "B");
        assert_eq!(hit.preview, "this_is_a_hidden_secret_message_right_here");
    }

    #[test]
    fn test_extract_lsb_text_respects_msb_first_convention() {
        let message = b"the_quick_brown_fox_jumps_over_lazy_dog";
        let pixel_count = message.len() * 8 + 100;
        let mut pixels = vec![0u8; pixel_count * 3];

        let mut bit_idx = 0;
        for byte in message {
            for i in 0..8u8 {
                let bit = (byte >> (7 - i)) & 1; // MSB-first extraction order
                let offset = bit_idx * 3 + 1; // Green channel
                pixels[offset] = (pixels[offset] & !1) | bit;
                bit_idx += 1;
            }
        }

        let hit = extract_lsb_text(&pixels, 3).expect("message should be recovered");
        assert_eq!(hit.channel, "G");
        assert_eq!(hit.preview, "the_quick_brown_fox_jumps_over_lazy_dog");
    }

    #[test]
    fn test_extract_lsb_text_no_message_returns_none() {
        // Alternating-parity pattern: every LSB is deterministically 0/1/0/1..., which packs
        // to a constant non-printable byte in either bit order - no message, no false hit.
        let pixels: Vec<u8> = (0..30_000u32).map(|i| (i % 2) as u8).collect();
        assert!(extract_lsb_text(&pixels, 3).is_none());
    }

    #[test]
    fn test_extract_lsb_text_short_message_below_minimum_is_not_reported() {
        // A message shorter than min_required_run shouldn't be reported - this is the same
        // fundamental floor as the entropy approach, just for a different reason (avoiding
        // spurious short printable runs rather than dilution).
        let message = b"hi"; // 2 bytes, far under the minimum
        let pixel_count = message.len() * 8 + 200;
        let mut pixels = vec![0u8; pixel_count * 3];

        let mut bit_idx = 0;
        for byte in message {
            for i in 0..8u8 {
                let bit = (byte >> i) & 1;
                let offset = bit_idx * 3 + 1;
                pixels[offset] = (pixels[offset] & !1) | bit;
                bit_idx += 1;
            }
        }

        assert!(extract_lsb_text(&pixels, 3).is_none());
    }

    #[test]
    fn test_extract_lsb_text_short_diverse_run_no_longer_false_positives() {
        // Regression test for a real false positive found during manual testing: a 12-
        // character run with plenty of character diversity ("wo:q30vapvXe") was previously
        // accepted as a 99%-confidence hit on an ordinary image. The old fixed threshold (12)
        // was calibrated against the wrong statistic — the odds of *one specific* window
        // being that long, not the odds of the *longest* among thousands of windows scanned
        // across several channels and bit orders. A run this short must not be reported, even
        // though it clears the old diversity bar.
        let message = b"wo:q30vapvXe"; // 12 chars, 11 distinct - passed the old thresholds
        let pixel_count = message.len() * 8 + 200;
        let mut pixels = vec![0u8; pixel_count * 3];

        let mut bit_idx = 0;
        for byte in message {
            for i in 0..8u8 {
                let bit = (byte >> i) & 1;
                let offset = bit_idx * 3 + 1;
                pixels[offset] = (pixels[offset] & !1) | bit;
                bit_idx += 1;
            }
        }

        assert!(
            extract_lsb_text(&pixels, 3).is_none(),
            "a 12-character run must not clear the derived false-positive-safe threshold"
        );
    }

    // ─── min_required_run ──────────────────────────────────────────────────

    #[test]
    fn test_min_required_run_scales_with_trial_and_sample_count() {
        // More trials (more channels/bit orders tried) or more samples per trial (a larger
        // scan window) both raise the chance of a coincidental long run, so both should raise
        // the required run length.
        let base = min_required_run(1000, 2);
        assert!(
            min_required_run(1000, 8) > base,
            "more trials should require a longer run"
        );
        assert!(
            min_required_run(100_000, 2) > base,
            "more samples per trial should require a longer run"
        );
    }

    #[test]
    fn test_min_required_run_for_actual_runtime_parameters_exceeds_the_old_flat_threshold() {
        // Sanity check against the real parameters extract_lsb_text uses, confirming the fix
        // actually raises the bar in practice, not just in isolated unit tests.
        let samples_per_trial = LSB_EXTRACT_SCAN_BYTES / 8;
        let rgb_min_run = min_required_run(samples_per_trial, 3 * 2);
        assert!(
            rgb_min_run > 12,
            "the derived threshold must exceed the old flat constant that caused the false positive, got {rgb_min_run}"
        );
    }

    // ─── is_supported_stego_format ─────────────────────────────────────────

    #[test]
    fn test_is_supported_stego_format() {
        for ext in ["png", "jpg", "jpeg", "bmp", "webp"] {
            assert!(is_supported_stego_format(ext), "{ext} should be supported");
        }
        for ext in ["gif", "tiff", "tif", "heic", "avif", "svg", "", "PNG"] {
            assert!(
                !is_supported_stego_format(ext),
                "{ext} should not be supported (case-sensitive - callers lowercase first)"
            );
        }
    }
}

// --- END OF FILE cleaner/mod.rs ---
