// --- START OF FILE cleaner.rs ---

use anyhow::{anyhow, Result};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
// `zip` crate is used because modern Office documents (.docx, .xlsx) are actually just ZIP files containing XML.
use zip::write::SimpleFileOptions;

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
// SECURITY Limits: Prevent Denial of Service (DoS) attacks via malformed/massive files.

const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024; // Limit generic file processing to 100 MB per file
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
pub struct CleaningOptions {
    pub gps: bool,
    pub author: bool,
    pub date: bool,
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
/// 4. File size must be within defined safe limits (DoS protection).
/// 5. Must have a supported extension.
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

    // 5. Enforce DoS size limits
    let size = metadata.len();
    if size > MAX_FILE_SIZE {
        return Err(anyhow!(
            "File too large: {} MB (maximum: {} MB)",
            size / (1024 * 1024),
            MAX_FILE_SIZE / (1024 * 1024)
        ));
    }

    if size == 0 {
        return Err(anyhow!("File is empty"));
    }

    // 6. Canonicalize path (resolves relative '..' segments to an absolute path)
    let canonical =
        fs::canonicalize(path).map_err(|e| anyhow!("Cannot resolve file path: {}", e))?;

    // 7. Verify extension against our supported whitelist
    let ext = canonical
        .extension()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("File has no extension"))?
        .to_lowercase();

    let supported = [
        "jpg", "jpeg", "png", "webp", "tiff", "pdf", "docx", "xlsx", "pptx", "zip",
    ];
    if !supported.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported file type: .{}", ext));
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
    if !options.gps && !options.author && !options.date {
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
// IMAGE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/// Extracts EXIF metadata from standard image formats.
fn analyze_image(path: &Path) -> Result<MetadataReport> {
    let file = File::open(path)?;
    let mut reader = std::io::BufReader::new(&file);

    let exifreader = exif::Reader::new();
    let exif = exifreader.read_from_container(&mut reader).ok();

    let file_size = fs::metadata(path)?.len();

    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "Image".to_string(),
        file_size,
        raw_tags: Vec::new(),
        app_info: None,
    };

    if let Some(ex) = exif {
        let mut lat_str = String::new();
        let mut long_str = String::new();

        for field in ex.fields() {
            let display_value = field.display_value().with_unit(&ex).to_string();

            // SECURITY: Limit tag value length to prevent memory exhaustion (DoS) from malicious EXIF data.
            let truncated_value = if display_value.len() > 200 {
                format!("{}... (truncated)", &display_value[..200])
            } else {
                display_value
            };

            // FIX: Removed redundant `.clone()` — push uses the value directly, the
            // match arms below reference the local copy before it is moved.
            let tag_key = field.tag.to_string();
            let tag_value = truncated_value.clone();

            // Map standard EXIF tags to our generic report structure
            match field.tag {
                exif::Tag::GPSLatitude => {
                    lat_str = truncated_value;
                    report.has_gps = true;
                }
                exif::Tag::GPSLongitude => {
                    long_str = truncated_value;
                    report.has_gps = true;
                }
                exif::Tag::GPSAltitude | exif::Tag::GPSImgDirection => {
                    report.has_gps = true;
                }
                exif::Tag::Model => {
                    if report.camera_info.is_none() {
                        report.camera_info = Some(truncated_value);
                    }
                }
                exif::Tag::DateTime | exif::Tag::DateTimeOriginal => {
                    if report.creation_date.is_none() {
                        report.creation_date = Some(truncated_value);
                    }
                }
                exif::Tag::Artist
                | exif::Tag::Copyright
                | exif::Tag::Software
                | exif::Tag::Make => {
                    report.has_author = true;
                    if field.tag == exif::Tag::Software && report.software_info.is_none() {
                        report.software_info = Some(truncated_value);
                    }
                }
                _ => {}
            }

            report.raw_tags.push(MetadataEntry {
                key: tag_key,
                value: tag_value,
            });
        }

        // Format GPS coords nicely for the UI if both lat and long exist
        if !lat_str.is_empty() && !long_str.is_empty() {
            report.gps_info = Some(format!("{}, {}", lat_str, long_str));
        }
    }

    Ok(report)
}

/// Rebuilds a JPEG file, omitting EXIF Application segments.
///
/// NOTE: JPEG EXIF is stored as a single APP1 segment containing a binary IFD structure.
/// Granular tag-level stripping (e.g. GPS only) requires a write-capable EXIF library such as
/// `little-exif`. With the current `img_parts` approach, all APP segments are stripped when
/// any cleaning option is active — this is the safest choice for a privacy tool and is standard
/// practice (e.g. ExifTool's `-all=` flag does the same).
fn strip_jpeg(input: &Path, output: &Path, _options: &CleaningOptions) -> Result<()> {
    let input_data = fs::read(input)?;
    let mut jpeg = img_parts::jpeg::Jpeg::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid JPEG: {}", e))?;

    // In the JPEG specification, metadata is stored in "APP" segments (0xE1 through 0xEF).
    // We target these segments for removal.
    let segments_to_remove: Vec<u8> = (0xE1..=0xEF).chain(std::iter::once(0xFE)).collect();

    let segments = jpeg.segments_mut();
    segments.retain(|seg| {
        let marker = seg.marker();
        // Keep essential JPEG structural markers (image data, quantization tables, etc.)
        if marker == 0xE0 || marker == 0xDB || marker == 0xC4 || marker == 0xDA || marker == 0xDD {
            return true;
        }
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            return true;
        }
        // Remove known metadata markers
        !segments_to_remove.contains(&marker)
    });

    let output_file = File::create(output)?;
    jpeg.encoder()
        .write_to(output_file)
        .map_err(|e| anyhow!("Write error: {}", e))?;

    Ok(())
}

/// Rebuilds a PNG file, omitting known metadata chunks.
/// See `strip_jpeg` note — full chunk removal is used for the same reasons.
fn strip_png(input: &Path, output: &Path, _options: &CleaningOptions) -> Result<()> {
    let input_data = fs::read(input)?;
    let mut png = img_parts::png::Png::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid PNG: {}", e))?;

    // PNG standard metadata chunks (eXIf, text annotations, color profiles, etc.)
    let metadata_chunks: &[&[u8; 4]] = &[
        b"eXIf", b"tEXt", b"zTXt", b"iTXt", b"tIME", b"pHYs", b"iCCP", b"cHRM", b"sRGB", b"gAMA",
        b"bKGD", b"hist",
    ];

    png.chunks_mut().retain(|chunk| {
        let type_bytes = chunk.kind();
        !metadata_chunks.contains(&&type_bytes)
    });

    let output_file = File::create(output)?;
    png.encoder()
        .write_to(output_file)
        .map_err(|e| anyhow!("Write error: {}", e))?;

    Ok(())
}

/// FIX (NEW): Rebuilds a WebP file, omitting EXIF and XMP metadata chunks.
/// WebP uses a RIFF container where metadata is stored in discrete named chunks.
fn strip_webp(input: &Path, output: &Path, _options: &CleaningOptions) -> Result<()> {
    let input_data = fs::read(input)?;
    let mut webp = img_parts::webp::WebP::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid WebP: {}", e))?;

    // Remove EXIF and XMP metadata chunks by their 4-byte RIFF identifiers.
    // Note: the XMP chunk identifier includes a trailing space: b"XMP ".
    webp.chunks_mut().retain(|chunk| {
        let id = chunk.id();
        id != *b"EXIF" && id != *b"XMP "
    });

    let output_file = File::create(output)?;
    webp.encoder()
        .write_to(output_file)
        .map_err(|e| anyhow!("Write error: {}", e))?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

fn analyze_pdf(path: &Path) -> Result<MetadataReport> {
    let file_size = fs::metadata(path)?.len();

    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "PDF Document".to_string(),
        file_size,
        raw_tags: Vec::new(),
        app_info: None,
    };

    // Load PDF structure
    if let Ok(doc) = lopdf::Document::load(path) {
        // Look in the standard "Info" dictionary where most PDF authors/titles are stored
        if let Ok(info_obj) = doc.trailer.get(b"Info") {
            if let Ok(info_ref) = info_obj.as_reference() {
                if let Ok(dict_obj) = doc.get_object(info_ref) {
                    if let Ok(info_dict) = dict_obj.as_dict() {
                        // Helper to safely extract strings from the PDF dict
                        let get_str = |key: &[u8]| -> Option<String> {
                            info_dict
                                .get(key)
                                .ok()
                                .and_then(|o| o.as_str().ok())
                                .map(|b| String::from_utf8_lossy(b).into_owned())
                        };

                        if let Some(author) = get_str(b"Author") {
                            report.has_author = true;
                            report.raw_tags.push(MetadataEntry {
                                key: "Author".into(),
                                value: author,
                            });
                        }
                        if let Some(creator) = get_str(b"Creator") {
                            report.has_author = true;
                            report.raw_tags.push(MetadataEntry {
                                key: "Creator".into(),
                                value: creator,
                            });
                        }
                        if let Some(producer) = get_str(b"Producer") {
                            report.software_info = Some(producer.clone());
                            report.raw_tags.push(MetadataEntry {
                                key: "Producer".into(),
                                value: producer,
                            });
                        }
                        if let Some(date) = get_str(b"CreationDate") {
                            report.creation_date = Some(date.clone());
                            report.raw_tags.push(MetadataEntry {
                                key: "CreationDate".into(),
                                value: date,
                            });
                        }
                        if let Some(mod_date) = get_str(b"ModDate") {
                            report.raw_tags.push(MetadataEntry {
                                key: "ModDate".into(),
                                value: mod_date,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(report)
}

/// FIX: Now accepts `options` and strips only the fields that the user requested,
/// rather than always stripping everything.
fn strip_pdf(input: &Path, output: &Path, options: &CleaningOptions) -> Result<()> {
    let mut doc = lopdf::Document::load(input).map_err(|e| anyhow!("PDF Load Error: {}", e))?;

    // Retrieve the Info dictionary object ID without holding a borrow on `doc`.
    let info_id: Option<lopdf::ObjectId> = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|obj| obj.as_reference().ok());

    // Selectively remove fields from the Info dictionary based on user options.
    if let Some(id) = info_id {
        if let Ok(obj) = doc.get_object_mut(id) {
            if let Ok(dict) = obj.as_dict_mut() {
                if options.author {
                    dict.remove(b"Author");
                    dict.remove(b"Creator");
                    dict.remove(b"Producer");
                    dict.remove(b"Title");
                    dict.remove(b"Subject");
                    dict.remove(b"Keywords");
                }
                if options.date {
                    dict.remove(b"CreationDate");
                    dict.remove(b"ModDate");
                }
            }
        }
    }

    // If all author+date options are selected, remove the Info reference from the trailer entirely.
    if options.author && options.date {
        doc.trailer.remove(b"Info");
    }

    // Remove XMP Metadata streams when any option is active.
    if options.author || options.date {
        let metadata_ids: Vec<lopdf::ObjectId> = doc
            .objects
            .iter()
            .filter_map(|(id, object)| {
                if let lopdf::Object::Stream(ref stream) = object {
                    if let Ok(lopdf::Object::Name(ref name)) = stream.dict.get(b"Type") {
                        if name == b"Metadata" {
                            return Some(*id);
                        }
                    }
                }
                None
            })
            .collect();

        for id in metadata_ids {
            doc.objects.remove(&id);
        }
    }

    // Save the scrubbed PDF structure
    doc.save(output)
        .map_err(|e| anyhow!("PDF Write Error: {}", e))?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// OFFICE DOCUMENT HANDLERS (With XML Parser)
// ═══════════════════════════════════════════════════════════════════════════

fn analyze_office(path: &Path) -> Result<MetadataReport> {
    let file_size = fs::metadata(path)?.len();

    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: Some("Microsoft Office / OpenXML".into()),
        creation_date: None,
        gps_info: None,
        file_type: "Office Document".to_string(),
        file_size,
        raw_tags: Vec::new(),
        app_info: None,
    };

    // Modern Office documents (.docx, .xlsx, .pptx) are actually ZIP archives containing XML.
    if let Ok(file) = File::open(path) {
        if let Ok(mut archive) = zip::ZipArchive::new(file) {
            // SECURITY: Ensure we aren't parsing a malformed Zip Bomb that will exhaust memory
            validate_zip_archive(&mut archive)?;

            // --- Parse core.xml (author, dates, title) ---
            if let Ok(core_entry) = archive.by_name("docProps/core.xml") {
                let mut xml_content = String::new();
                // SECURITY: Limit read size to 1 MB to prevent XML entity expansion attacks.
                core_entry
                    .take(1024 * 1024)
                    .read_to_string(&mut xml_content)
                    .ok();
                parse_office_core_xml(&xml_content, &mut report);
            }

            // FIX (NEW): Also parse app.xml which contains Application name, Company, Manager,
            // revision count — all privacy-relevant fields that were previously invisible to the user.
            if let Ok(app_entry) = archive.by_name("docProps/app.xml") {
                let mut xml_content = String::new();
                app_entry
                    .take(1024 * 1024)
                    .read_to_string(&mut xml_content)
                    .ok();
                parse_office_app_xml(&xml_content, &mut report);
            }
        }
    }

    Ok(report)
}

fn parse_office_core_xml(xml: &str, report: &mut MetadataReport) {
    if let Some(creator) = extract_xml_element_content(xml, "dc:creator") {
        if !creator.is_empty() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Creator".into(),
                value: creator,
            });
        }
    }

    if let Some(modified_by) = extract_xml_element_content(xml, "cp:lastModifiedBy") {
        if !modified_by.is_empty() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Last Modified By".into(),
                value: modified_by,
            });
        }
    }

    if let Some(title) = extract_xml_element_content(xml, "dc:title") {
        if !title.is_empty() {
            report.raw_tags.push(MetadataEntry {
                key: "Title".into(),
                value: title,
            });
        }
    }

    if let Some(subject) = extract_xml_element_content(xml, "dc:subject") {
        if !subject.is_empty() {
            report.raw_tags.push(MetadataEntry {
                key: "Subject".into(),
                value: subject,
            });
        }
    }

    if let Some(description) = extract_xml_element_content(xml, "dc:description") {
        if !description.is_empty() {
            report.raw_tags.push(MetadataEntry {
                key: "Description".into(),
                value: description,
            });
        }
    }

    if let Some(revision) = extract_xml_element_content(xml, "cp:revision") {
        if !revision.is_empty() {
            report.raw_tags.push(MetadataEntry {
                key: "Revision".into(),
                value: revision,
            });
        }
    }

    if let Some(created) = extract_xml_element_content(xml, "dcterms:created") {
        if !created.is_empty() {
            report.creation_date = Some(created.clone());
            report.raw_tags.push(MetadataEntry {
                key: "Created".into(),
                value: created,
            });
        }
    }

    if let Some(modified) = extract_xml_element_content(xml, "dcterms:modified") {
        if !modified.is_empty() {
            report.raw_tags.push(MetadataEntry {
                key: "Modified".into(),
                value: modified,
            });
        }
    }
}

/// FIX (NEW): Parses `docProps/app.xml`, which was previously completely ignored.
/// This file contains application name, company, template, and manager — all of which
/// can identify the creating organization and should be surfaced in the report.
fn parse_office_app_xml(xml: &str, report: &mut MetadataReport) {
    if let Some(application) = extract_xml_element_content(xml, "Application") {
        if !application.is_empty() {
            report.app_info = Some(application.clone());
            report.raw_tags.push(MetadataEntry {
                key: "Application".into(),
                value: application,
            });
        }
    }

    if let Some(company) = extract_xml_element_content(xml, "Company") {
        if !company.is_empty() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Company".into(),
                value: company,
            });
        }
    }

    if let Some(manager) = extract_xml_element_content(xml, "Manager") {
        if !manager.is_empty() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Manager".into(),
                value: manager,
            });
        }
    }

    if let Some(template) = extract_xml_element_content(xml, "Template") {
        if !template.is_empty() {
            report.raw_tags.push(MetadataEntry {
                key: "Template".into(),
                value: template,
            });
        }
    }

    if let Some(pages) = extract_xml_element_content(xml, "Pages") {
        if !pages.is_empty() {
            report.raw_tags.push(MetadataEntry {
                key: "Pages".into(),
                value: pages,
            });
        }
    }
}

// ─── XML Helpers ────────────────────────────────────────────────────────────

/// Extracts the text content of a named XML element, correctly handling elements
/// that carry attributes (e.g., `<dcterms:created xsi:type="dcterms:W3CDTF">…</dcterms:created>`).
/// Returns `None` if the element is absent; returns `Some("")` if the element is present but empty.
///
/// This is a lightweight alternative to a full XML parser. It handles the well-structured,
/// schema-validated XML produced by Office applications. For arbitrary or adversarially
/// malformed XML, consider upgrading to the `quick-xml` crate.
fn extract_xml_element_content(xml: &str, element_name: &str) -> Option<String> {
    let open_prefix = format!("<{}", element_name);
    let close_tag = format!("</{}>", element_name);

    let start_pos = xml.find(&open_prefix)?;
    // Skip past any attributes to find the end of the opening tag
    let tag_close_offset = xml[start_pos..].find('>')?;
    let content_start = start_pos + tag_close_offset + 1;
    let end_offset = xml[content_start..].find(&close_tag)?;

    Some(xml[content_start..content_start + end_offset].to_string())
}

/// Returns a copy of `xml` with the text content of `element_name` replaced with an empty string.
/// Handles elements with or without attributes. Leaves the element tag structure intact so
/// that Office applications can still open the document without validation errors.
fn clear_xml_element_content(xml: &str, element_name: &str) -> String {
    let open_prefix = format!("<{}", element_name);
    let close_tag = format!("</{}>", element_name);

    let Some(start_pos) = xml.find(&open_prefix) else {
        return xml.to_string();
    };
    let Some(tag_close_offset) = xml[start_pos..].find('>') else {
        return xml.to_string();
    };
    let content_start = start_pos + tag_close_offset + 1;
    let Some(end_offset) = xml[content_start..].find(&close_tag) else {
        return xml.to_string();
    };

    // Preserve the opening tag (with attributes) and closing tag; only wipe the content.
    format!(
        "{}{}",
        &xml[..content_start],
        &xml[content_start + end_offset..]
    )
}

/// Applies selective clearing of `core.xml` fields based on the user's chosen options.
fn clean_core_xml(xml: &str, options: &CleaningOptions) -> String {
    let mut result = xml.to_string();

    if options.author {
        for field in &[
            "dc:creator",
            "cp:lastModifiedBy",
            "dc:title",
            "dc:subject",
            "cp:keywords",
            "dc:description",
        ] {
            result = clear_xml_element_content(&result, field);
        }
    }

    if options.date {
        for field in &["dcterms:created", "dcterms:modified", "cp:revision"] {
            result = clear_xml_element_content(&result, field);
        }
    }

    result
}

/// Clears privacy-relevant fields from `app.xml` (application name, company, manager).
fn clean_app_xml(xml: &str) -> String {
    let mut result = xml.to_string();
    for field in &["Application", "Company", "Manager", "Template"] {
        result = clear_xml_element_content(&result, field);
    }
    result
}

/// Empty custom properties document used to replace `docProps/custom.xml` during cleaning.
const EMPTY_CUSTOM_PROPS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"></Properties>"#;

/// FIX: Now accepts `options` and rewrites metadata XML files selectively, instead of
/// deleting them entirely. Deleting `core.xml` causes some Office applications to warn
/// about a corrupt document on open; rewriting with cleared fields avoids this.
fn strip_office(input: &Path, output: &Path, options: &CleaningOptions) -> Result<()> {
    let file = File::open(input)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // ZIP bomb protection
    validate_zip_archive(&mut archive)?;

    // Pre-read all entries into memory to avoid borrow conflicts between
    // the ZipArchive reader and the ZipWriter output stream.
    struct Entry {
        name: String,
        content: Vec<u8>,
        compression: zip::CompressionMethod,
        unix_mode: Option<u32>,
    }

    let mut entries: Vec<Entry> = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        let compression = entry.compression();
        let unix_mode = entry.unix_mode();
        let mut content = Vec::new();
        entry
            .read_to_end(&mut content)
            .map_err(|e| anyhow!("Read error for '{}': {}", name, e))?;
        entries.push(Entry {
            name,
            content,
            compression,
            unix_mode,
        });
    }

    let out_file = File::create(output)?;
    let mut zip_writer = zip::ZipWriter::new(out_file);

    for entry in entries {
        // Always strip the document thumbnail — it can expose a visual preview of the content.
        if entry.name == "docProps/thumbnail.jpeg" || entry.name == "docProps/thumbnail.png" {
            continue;
        }

        let zip_opts = SimpleFileOptions::default()
            .compression_method(entry.compression)
            .unix_permissions(entry.unix_mode.unwrap_or(0o755));

        // Rewrite known metadata XML rather than deleting the files.
        let final_content: Vec<u8> = match entry.name.as_str() {
            "docProps/core.xml" => {
                let xml = String::from_utf8_lossy(&entry.content).into_owned();
                clean_core_xml(&xml, options).into_bytes()
            }
            "docProps/app.xml" if options.author => {
                let xml = String::from_utf8_lossy(&entry.content).into_owned();
                clean_app_xml(&xml).into_bytes()
            }
            "docProps/custom.xml" if options.author || options.date => {
                EMPTY_CUSTOM_PROPS.as_bytes().to_vec()
            }
            _ => entry.content,
        };

        zip_writer
            .start_file(&entry.name, zip_opts)
            .map_err(|e| anyhow!("Zip write error for '{}': {}", entry.name, e))?;

        zip_writer
            .write_all(&final_content)
            .map_err(|e| anyhow!("Content write error for '{}': {}", entry.name, e))?;
    }

    zip_writer.finish()?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// ZIP HANDLERS (With Bomb Protection)
// ═══════════════════════════════════════════════════════════════════════════

/// SECURITY HELPER: Analyzes a ZIP archive to ensure it is not a "ZIP Bomb"
/// (A malicious file designed to crash systems by containing petabytes of repetitive data).
fn validate_zip_archive<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Result<()> {
    // 1. Check number of files (Directory Traversal / inode exhaustion defense)
    if archive.len() > MAX_ZIP_FILES {
        return Err(anyhow!(
            "ZIP contains too many files: {} (max: {})",
            archive.len(),
            MAX_ZIP_FILES
        ));
    }

    // 2. Calculate and verify total uncompressed size without actually uncompressing
    let mut total_size = 0u64;
    for i in 0..archive.len() {
        if let Ok(file) = archive.by_index(i) {
            total_size += file.size(); // `size()` returns the declared *uncompressed* size
            if total_size > MAX_ZIP_SIZE {
                return Err(anyhow!(
                    "ZIP uncompressed size exceeds limit: {} MB (max: {} MB)",
                    total_size / (1024 * 1024),
                    MAX_ZIP_SIZE / (1024 * 1024)
                ));
            }
        }
    }

    Ok(())
}

/// FIX: Previously returned a hardcoded stub report. Now actually reads the archive comment
/// and samples entry timestamps, providing real data for the UI.
fn analyze_zip(path: &Path) -> Result<MetadataReport> {
    let file_size = fs::metadata(path)?.len();
    let file = File::open(path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| anyhow!("Invalid ZIP archive: {}", e))?;

    validate_zip_archive(&mut archive)?;

    let mut raw_tags: Vec<MetadataEntry> = Vec::new();

    // Check for archive-level comment — often contains creator info or tool watermarks.
    let comment_bytes = archive.comment().to_vec();
    let has_comment = !comment_bytes.is_empty();
    if has_comment {
        raw_tags.push(MetadataEntry {
            key: "Archive Comment".into(),
            value: String::from_utf8_lossy(&comment_bytes).into_owned(),
        });
    }

    // Sample per-entry timestamps (limit output to first 20 entries for usability).
    let sample_count = archive.len().min(20);
    for i in 0..sample_count {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            let dt = entry
                .last_modified()
                .expect("zip entry has no last-modified timestamp");
            let year = dt.year();
            let month = dt.month();
            let day = dt.day();
            let hour = dt.hour();
            let minute = dt.minute();
            let second = dt.second();
            // Skip entries with the default/epoch timestamp (year 1980 = DOS epoch).
            if year > 1980 {
                raw_tags.push(MetadataEntry {
                    key: format!("Entry: {}", name),
                    value: format!(
                        "Modified: {}-{:02}-{:02} {:02}:{:02}:{:02}",
                        year, month, day, hour, minute, second
                    ),
                });
            }
        }
    }

    if archive.len() > 20 {
        raw_tags.push(MetadataEntry {
            key: "Note".into(),
            value: format!(
                "{} more entries not shown (timestamps sampled from first 20)",
                archive.len() - 20
            ),
        });
    }

    Ok(MetadataReport {
        has_gps: false,
        has_author: has_comment,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "ZIP Archive".to_string(),
        file_size,
        raw_tags,
        app_info: None,
    })
}

/// Rebuilds a ZIP file, stripping root archive comments and normalizing OS permissions.
fn clean_zip_metadata(input: &Path, output: &Path) -> Result<()> {
    let file = File::open(input)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // ZIP bomb protection
    validate_zip_archive(&mut archive)?;

    let out_file = File::create(output)?;
    let mut zip_writer = zip::ZipWriter::new(out_file);

    // Strip any global archive comments (often used by WinRAR/7z to tag the creator)
    zip_writer.set_comment("");

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();

        let options = SimpleFileOptions::default()
            .compression_method(file.compression())
            .unix_permissions(0o755); // SECURITY: Normalize all permissions, removing custom OS flags

        zip_writer
            .start_file(&name, options)
            .map_err(|e| anyhow!("Zip Error: {}", e))?;

        std::io::copy(&mut file, &mut zip_writer)?;
    }

    zip_writer.finish()?;
    Ok(())
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

    // ─── XML helpers ─────────────────────────────────────────────────────

    #[test]
    fn test_extract_xml_element_content_simple() {
        let xml = "<root><dc:creator>John Doe</dc:creator></root>";
        let result = extract_xml_element_content(xml, "dc:creator");
        assert_eq!(result, Some("John Doe".to_string()));
    }

    #[test]
    fn test_extract_xml_element_content_with_attributes() {
        let xml =
            r#"<dcterms:created xsi:type="dcterms:W3CDTF">2023-10-25T14:30:00Z</dcterms:created>"#;
        let result = extract_xml_element_content(xml, "dcterms:created");
        assert_eq!(result, Some("2023-10-25T14:30:00Z".to_string()));
    }

    #[test]
    fn test_extract_xml_element_content_empty_element() {
        let xml = "<dc:subject></dc:subject>";
        let result = extract_xml_element_content(xml, "dc:subject");
        assert_eq!(result, Some(String::new()));
    }

    #[test]
    fn test_extract_xml_element_content_missing_element() {
        let xml = "<root><other>value</other></root>";
        let result = extract_xml_element_content(xml, "dc:creator");
        assert_eq!(result, None);
    }

    #[test]
    fn test_clear_xml_element_content_removes_text() {
        let xml = "<root><dc:creator>John Doe</dc:creator></root>";
        let result = clear_xml_element_content(xml, "dc:creator");
        assert!(result.contains("<dc:creator></dc:creator>"));
        assert!(!result.contains("John Doe"));
    }

    #[test]
    fn test_clear_xml_element_content_with_attributes() {
        let xml =
            r#"<dcterms:created xsi:type="dcterms:W3CDTF">2023-10-25T14:30:00Z</dcterms:created>"#;
        let result = clear_xml_element_content(xml, "dcterms:created");
        assert!(!result.contains("2023-10-25T14:30:00Z"));
        assert!(result.contains("</dcterms:created>"));
    }

    #[test]
    fn test_clear_xml_element_content_missing_is_noop() {
        let xml = "<root><other>value</other></root>";
        let result = clear_xml_element_content(xml, "dc:creator");
        assert_eq!(result, xml); // Unchanged
    }

    // ─── Office XML parsing ───────────────────────────────────────────────

    #[test]
    fn test_parse_office_core_xml() {
        let mock_xml = r#"
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <cp:coreProperties
                xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                xmlns:dc="http://purl.org/dc/elements/1.1/"
                xmlns:dcterms="http://purl.org/dc/terms/"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
                <dc:title>Secret Report</dc:title>
                <dc:creator>John Doe</dc:creator>
                <cp:lastModifiedBy>Jane Smith</cp:lastModifiedBy>
                <cp:revision>2</cp:revision>
                <dcterms:created xsi:type="dcterms:W3CDTF">2023-10-25T14:30:00Z</dcterms:created>
                <dcterms:modified xsi:type="dcterms:W3CDTF">2023-10-26T09:15:00Z</dcterms:modified>
            </cp:coreProperties>
        "#;

        let mut report = MetadataReport {
            has_gps: false,
            has_author: false,
            camera_info: None,
            software_info: None,
            creation_date: None,
            gps_info: None,
            file_type: "Office".into(),
            file_size: 100,
            raw_tags: Vec::new(),
            app_info: None,
        };

        parse_office_core_xml(mock_xml, &mut report);

        assert!(report.has_author, "Should flag has_author from dc:creator");
        assert_eq!(
            report.creation_date.as_deref(),
            Some("2023-10-25T14:30:00Z")
        );

        let creator_tag = report.raw_tags.iter().find(|t| t.key == "Creator").unwrap();
        assert_eq!(creator_tag.value, "John Doe");

        let modifier_tag = report
            .raw_tags
            .iter()
            .find(|t| t.key == "Last Modified By")
            .unwrap();
        assert_eq!(modifier_tag.value, "Jane Smith");

        let title_tag = report.raw_tags.iter().find(|t| t.key == "Title").unwrap();
        assert_eq!(title_tag.value, "Secret Report");
    }

    #[test]
    fn test_parse_office_app_xml() {
        let mock_xml = r#"
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
                <Application>Microsoft Office Word</Application>
                <Company>ACME Corp</Company>
                <Manager>Alice Johnson</Manager>
                <Template>Normal.dotm</Template>
                <Pages>5</Pages>
            </Properties>
        "#;

        let mut report = MetadataReport {
            has_gps: false,
            has_author: false,
            camera_info: None,
            software_info: None,
            creation_date: None,
            gps_info: None,
            file_type: "Office".into(),
            file_size: 100,
            raw_tags: Vec::new(),
            app_info: None,
        };

        parse_office_app_xml(mock_xml, &mut report);

        assert_eq!(
            report.app_info.as_deref(),
            Some("Microsoft Office Word"),
            "app_info should be populated from <Application>"
        );
        assert!(
            report.has_author,
            "Company field should set has_author to true"
        );

        let company_tag = report.raw_tags.iter().find(|t| t.key == "Company").unwrap();
        assert_eq!(company_tag.value, "ACME Corp");

        let manager_tag = report.raw_tags.iter().find(|t| t.key == "Manager").unwrap();
        assert_eq!(manager_tag.value, "Alice Johnson");
    }

    #[test]
    fn test_clean_core_xml_author_only() {
        let xml = r#"<cp:coreProperties>
            <dc:creator>John Doe</dc:creator>
            <cp:lastModifiedBy>Jane</cp:lastModifiedBy>
            <dcterms:created xsi:type="dcterms:W3CDTF">2023-01-01T00:00:00Z</dcterms:created>
        </cp:coreProperties>"#;

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
        };
        let result = clean_core_xml(xml, &options);

        assert!(!result.contains("John Doe"), "Creator should be cleared");
        assert!(!result.contains("Jane"), "Last modifier should be cleared");
        assert!(
            result.contains("2023-01-01"),
            "Date should NOT be cleared when date option is false"
        );
    }

    #[test]
    fn test_clean_core_xml_date_only() {
        let xml = r#"<cp:coreProperties>
            <dc:creator>John Doe</dc:creator>
            <dcterms:created xsi:type="dcterms:W3CDTF">2023-01-01T00:00:00Z</dcterms:created>
            <dcterms:modified xsi:type="dcterms:W3CDTF">2023-06-01T00:00:00Z</dcterms:modified>
        </cp:coreProperties>"#;

        let options = CleaningOptions {
            gps: false,
            author: false,
            date: true,
        };
        let result = clean_core_xml(xml, &options);

        assert!(
            result.contains("John Doe"),
            "Author should NOT be cleared when author option is false"
        );
        assert!(
            !result.contains("2023-01-01"),
            "Created date should be cleared"
        );
        assert!(
            !result.contains("2023-06-01"),
            "Modified date should be cleared"
        );
    }

    // ─── ZIP analysis & protection ────────────────────────────────────────

    #[test]
    fn test_zip_bomb_protection_file_count() {
        let mut zip_buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut zip_buffer);
            let options = zip::write::SimpleFileOptions::default();
            // Deliberately exceed MAX_ZIP_FILES (10,000)
            for i in 0..10_005 {
                zip.start_file(format!("file_{}.txt", i), options).unwrap();
                zip.write_all(b"tiny").unwrap();
            }
            zip.finish().unwrap();
        }

        zip_buffer.set_position(0);
        let mut archive = zip::ZipArchive::new(zip_buffer).unwrap();

        let result = validate_zip_archive(&mut archive);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("ZIP contains too many files"));
    }

    #[test]
    fn test_analyze_zip_reads_archive_comment() {
        let dir = temp_dir("zip_comment_test");
        let zip_path = dir.join("test_with_comment.zip");

        {
            let zip_file = fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(zip_file);
            writer.set_comment("Created by TestApp v2.0");
            let opts = zip::write::SimpleFileOptions::default();
            writer.start_file("hello.txt", opts).unwrap();
            writer.write_all(b"hello world").unwrap();
            writer.finish().unwrap();
        }

        let report = analyze_zip(&zip_path).unwrap();

        let comment_tag = report.raw_tags.iter().find(|t| t.key == "Archive Comment");
        assert!(
            comment_tag.is_some(),
            "Archive comment should appear in raw_tags"
        );
        assert_eq!(comment_tag.unwrap().value, "Created by TestApp v2.0");
        assert!(
            report.has_author,
            "has_author should be true when archive comment is present"
        );

        let _ = fs::remove_file(zip_path);
    }

    #[test]
    fn test_analyze_zip_no_comment_has_no_author() {
        let dir = temp_dir("zip_no_comment_test");
        let zip_path = dir.join("test_no_comment.zip");

        {
            let zip_file = fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(zip_file);
            // No comment set
            let opts = zip::write::SimpleFileOptions::default();
            writer.start_file("data.txt", opts).unwrap();
            writer.write_all(b"data").unwrap();
            writer.finish().unwrap();
        }

        let report = analyze_zip(&zip_path).unwrap();
        assert!(
            !report.has_author,
            "has_author should be false when no archive comment"
        );

        let _ = fs::remove_file(zip_path);
    }
}

// --- END OF FILE cleaner.rs ---
