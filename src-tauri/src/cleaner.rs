// --- START OF FILE cleaner.rs ---

use anyhow::{anyhow, Result};
use std::fs::{self, File};
use std::io::Read;
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

    // Generate safe output filename (e.g., "photo_clean.jpg")
    let ext = canonical.extension().and_then(|s| s.to_str()).unwrap_or("");
    let stem = canonical.file_stem().unwrap_or_default().to_string_lossy();
    let new_name = format!("{}_clean.{}", stem, ext);
    let output_path = out_dir.join(new_name);

    // Prevent accidental overwrites
    if output_path.exists() {
        return Err(anyhow!(
            "Output file already exists: {}",
            output_path.display()
        ));
    }

    // Optimization: If user unchecked all cleaning options, just copy the file.
    if !options.gps && !options.author && !options.date {
        fs::copy(&canonical, &output_path)?;
        return Ok(output_path.display().to_string());
    }

    // Route to the correct format-specific scrubber
    let ext_lower = ext.to_lowercase();
    match ext_lower.as_str() {
        "jpg" | "jpeg" => strip_jpeg(&canonical, &output_path)?,
        "png" => strip_png(&canonical, &output_path)?,
        "pdf" => strip_pdf(&canonical, &output_path)?,
        "docx" | "xlsx" | "pptx" => strip_office(&canonical, &output_path)?,
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
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let total = paths.len();
    let mut success = Vec::new();
    let mut failed = Vec::new();
    let mut size_before = 0u64;
    let mut size_after = 0u64;

    for (idx, path_str) in paths.iter().enumerate() {
        // Check if the user clicked "Cancel" in the frontend
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            failed.push(FailedFile {
                path: "Operation cancelled".to_string(),
                error: "User cancelled operation".to_string(),
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

    // Final progress update to ensure UI hits 100%
    emit_progress(app_handle, total, total, "Complete".to_string());

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
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

/// Compares a file before and after cleaning, mapping exactly which tags were deleted.
pub fn compare_files(original: &str, cleaned: &str) -> Result<ComparisonResult> {
    let original_path = Path::new(original);
    let cleaned_path = Path::new(cleaned);

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

            report.raw_tags.push(MetadataEntry {
                key: field.tag.to_string(),
                value: truncated_value.clone(),
            });

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
        }

        // Format GPS coords nicely for the UI if both lat and long exist
        if !lat_str.is_empty() && !long_str.is_empty() {
            report.gps_info = Some(format!("{}, {}", lat_str, long_str));
        }
    }

    Ok(report)
}

/// Rebuilds a JPEG file, omitting EXIF Application segments.
fn strip_jpeg(input: &Path, output: &Path) -> Result<()> {
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
fn strip_png(input: &Path, output: &Path) -> Result<()> {
    let input_data = fs::read(input)?;
    let mut png = img_parts::png::Png::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid PNG: {}", e))?;

    // PNG standard metadata chunks (eXIf, text annotations, color profiles, etc.)
    let metadata_chunks = [
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
                    }
                }
            }
        }
    }

    Ok(report)
}

fn strip_pdf(input: &Path, output: &Path) -> Result<()> {
    let mut doc = lopdf::Document::load(input).map_err(|e| anyhow!("PDF Load Error: {}", e))?;

    // 1. Remove the entire standard "Info" dictionary (Author, Title, etc.)
    doc.trailer.remove(b"Info");

    // 2. Remove advanced Adobe XMP Metadata streams embedded as objects
    let mut keys_to_remove = Vec::new();
    for (id, object) in doc.objects.iter() {
        if let lopdf::Object::Stream(ref stream) = object {
            if let Ok(lopdf::Object::Name(name)) = stream.dict.get(b"Type") {
                if name == b"Metadata" {
                    keys_to_remove.push(*id);
                }
            }
        }
    }

    for id in keys_to_remove {
        doc.objects.remove(&id);
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
    };

    // Modern Office documents (.docx, .xlsx, .pptx) are actually ZIP archives containing XML.
    if let Ok(file) = File::open(path) {
        if let Ok(mut archive) = zip::ZipArchive::new(file) {
            // SECURITY: Ensure we aren't parsing a malformed Zip Bomb that will exhaust memory
            validate_zip_archive(&mut archive)?;

            // Extract the core.xml file which stores standard document properties
            if let Ok(core_xml) = archive.by_name("docProps/core.xml") {
                let mut xml_content = String::new();

                // SECURITY: Limit read size to 1 MB to prevent XML entity expansion attacks or memory exhaustion
                core_xml
                    .take(1024 * 1024)
                    .read_to_string(&mut xml_content)
                    .ok();

                parse_office_core_xml(&xml_content, &mut report);
            }
        }
    }

    Ok(report)
}

fn parse_office_core_xml(xml: &str, report: &mut MetadataReport) {
    // Simple inline string tag extraction (Lightweight alternative to full XML parsers)
    let extract_tag = |xml: &str, start_tag: &str, end_tag: &str| -> Option<String> {
        xml.find(start_tag).and_then(|start_pos| {
            let content_start = start_pos + start_tag.len();
            xml[content_start..]
                .find(end_tag)
                .map(|end_pos| xml[content_start..content_start + end_pos].to_string())
        })
    };

    if let Some(creator) = extract_tag(xml, "<dc:creator>", "</dc:creator>") {
        report.has_author = true;
        report.raw_tags.push(MetadataEntry {
            key: "Creator".into(),
            value: creator,
        });
    }

    if let Some(modified_by) = extract_tag(xml, "<cp:lastModifiedBy>", "</cp:lastModifiedBy>") {
        report.has_author = true;
        report.raw_tags.push(MetadataEntry {
            key: "Last Modified By".into(),
            value: modified_by,
        });
    }

    // Handle created date
    if let Some(start) = xml.find("<dcterms:created") {
        if let Some(tag_end) = xml[start..].find('>') {
            let content_start = start + tag_end + 1;
            if let Some(end) = xml[content_start..].find("</dcterms:created>") {
                let date_value = &xml[content_start..content_start + end];
                report.creation_date = Some(date_value.into());
                report.raw_tags.push(MetadataEntry {
                    key: "Created".into(),
                    value: date_value.into(),
                });
            }
        }
    }
}

/// Creates a new copy of the Office document, omitting the internal metadata XML files.
fn strip_office(input: &Path, output: &Path) -> Result<()> {
    let file = File::open(input)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // ZIP bomb protection
    validate_zip_archive(&mut archive)?;

    let out_file = File::create(output)?;
    let mut zip_writer = zip::ZipWriter::new(out_file);

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();

        // Skip the internal folders/files known to hold metadata and tracked revisions
        if name.contains("docProps/core.xml")
            || name.contains("docProps/app.xml")
            || name.contains("docProps/custom.xml")
            || name.contains("docProps/thumbnail.jpeg")
        {
            continue;
        }

        // Copy remaining valid files into the new sanitized ZIP structure
        let options = SimpleFileOptions::default()
            .compression_method(file.compression())
            .unix_permissions(file.unix_mode().unwrap_or(0o755));

        zip_writer
            .start_file(&name, options)
            .map_err(|e| anyhow!("Zip Error: {}", e))?;

        std::io::copy(&mut file, &mut zip_writer)?;
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

fn analyze_zip(path: &Path) -> Result<MetadataReport> {
    let file_size = fs::metadata(path)?.len();

    // We don't recursively scan inside ZIPs for metadata analysis, we just report that
    // the ZIP wrapper itself may contain metadata (comments, OS timestamps).
    Ok(MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "ZIP Archive".to_string(),
        file_size,
        raw_tags: vec![MetadataEntry {
            key: "Info".into(),
            value: "ZIP archives may contain file timestamps and comments".into(),
        }],
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

// ==========================================
// --- TESTS ---
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    // Helper to create a temporary dummy file for testing path logic
    fn create_temp_dummy(name: &str) -> PathBuf {
        let test_dir = std::env::temp_dir().join("qre_cleaner_tests");
        fs::create_dir_all(&test_dir).unwrap();
        let path = test_dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"dummy data").unwrap();
        path
    }

    #[test]
    fn test_validate_file_path_safe() {
        let path = create_temp_dummy("safe.jpg");
        let result = validate_file_path(&path);
        assert!(result.is_ok(), "Valid jpg should pass validation");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_validate_file_path_unsupported_ext() {
        // .exe is not in the whitelist for the metadata cleaner
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
    fn test_parse_office_core_xml() {
        // Simulate the exact XML found inside a DOCX docProps/core.xml
        let mock_xml = r#"
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
                <dc:title>Secret Report</dc:title>
                <dc:subject></dc:subject>
                <dc:creator>John Doe</dc:creator>
                <cp:keywords></cp:keywords>
                <dc:description></dc:description>
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
        };

        parse_office_core_xml(mock_xml, &mut report);

        // Verify extraction
        assert!(report.has_author);
        assert_eq!(report.creation_date.unwrap(), "2023-10-25T14:30:00Z");

        // Verify raw tags
        let creator_tag = report.raw_tags.iter().find(|t| t.key == "Creator").unwrap();
        assert_eq!(creator_tag.value, "John Doe");

        let modifier_tag = report
            .raw_tags
            .iter()
            .find(|t| t.key == "Last Modified By")
            .unwrap();
        assert_eq!(modifier_tag.value, "Jane Smith");
    }

    #[test]
    fn test_zip_bomb_protection_file_count() {
        // Create a mock ZIP file in memory using the zip crate
        let mut zip_buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut zip_buffer);
            let options = zip::write::SimpleFileOptions::default();

            // Deliberately exceed the MAX_ZIP_FILES limit (10,000)
            for i in 0..10_005 {
                zip.start_file(format!("file_{}.txt", i), options).unwrap();
                zip.write_all(b"tiny").unwrap();
            }
            zip.finish().unwrap();
        }

        // Reset cursor to read
        zip_buffer.set_position(0);
        let mut archive = zip::ZipArchive::new(zip_buffer).unwrap();

        let result = validate_zip_archive(&mut archive);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("ZIP contains too many files"));
    }
}

// --- END OF FILE cleaner.rs ---