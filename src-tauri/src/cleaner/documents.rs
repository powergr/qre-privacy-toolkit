// --- START OF FILE cleaner/documents.rs ---
//
// Image (JPEG/PNG/WebP/TIFF), RAW camera format (analysis-only), PDF,
// Office document (.docx/.xlsx/.pptx), and ZIP metadata handlers.

use super::{CleaningOptions, MetadataEntry, MetadataReport, MAX_ZIP_FILES, MAX_ZIP_SIZE};
use anyhow::{anyhow, Result};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/// Extracts EXIF metadata from standard image formats.
pub(super) fn analyze_image(path: &Path) -> Result<MetadataReport> {
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

/// RAW camera formats (CR2/NEF/ARW) are all TIFF-structured containers, so
/// the same EXIF reader that handles TIFF/JPEG already parses them correctly
/// — this just relabels the report with the specific camera format.
pub(super) fn analyze_raw(path: &Path, file_type_label: &str) -> Result<MetadataReport> {
    let mut report = analyze_image(path)?;
    report.file_type = file_type_label.to_string();
    Ok(report)
}

/// Rebuilds a JPEG file, omitting EXIF Application segments.
///
/// NOTE: JPEG EXIF is stored as a single APP1 segment containing a binary IFD structure.
/// Granular tag-level stripping (e.g. GPS only) requires a write-capable EXIF library such as
/// `little-exif`. With the current `img_parts` approach, all APP segments are stripped when
/// any cleaning option is active — this is the safest choice for a privacy tool and is standard
/// practice (e.g. ExifTool's `-all=` flag does the same).
fn strip_jpeg_bytes(input_data: Vec<u8>) -> Result<Vec<u8>> {
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

    let mut out = Vec::new();
    jpeg.encoder()
        .write_to(&mut out)
        .map_err(|e| anyhow!("Write error: {}", e))?;
    Ok(out)
}

pub(super) fn strip_jpeg(input: &Path, output: &Path, _options: &CleaningOptions) -> Result<()> {
    let cleaned = strip_jpeg_bytes(fs::read(input)?)?;
    fs::write(output, cleaned)?;
    Ok(())
}

fn strip_png_bytes(input_data: Vec<u8>) -> Result<Vec<u8>> {
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

    let mut out = Vec::new();
    png.encoder()
        .write_to(&mut out)
        .map_err(|e| anyhow!("Write error: {}", e))?;
    Ok(out)
}

/// Rebuilds a PNG file, omitting known metadata chunks.
/// See `strip_jpeg` note — full chunk removal is used for the same reasons.
pub(super) fn strip_png(input: &Path, output: &Path, _options: &CleaningOptions) -> Result<()> {
    let cleaned = strip_png_bytes(fs::read(input)?)?;
    fs::write(output, cleaned)?;
    Ok(())
}

fn strip_webp_bytes(input_data: Vec<u8>) -> Result<Vec<u8>> {
    let mut webp = img_parts::webp::WebP::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid WebP: {}", e))?;

    // Remove EXIF and XMP metadata chunks by their 4-byte RIFF identifiers.
    // Note: the XMP chunk identifier includes a trailing space: b"XMP ".
    webp.chunks_mut().retain(|chunk| {
        let id = chunk.id();
        id != *b"EXIF" && id != *b"XMP "
    });

    let mut out = Vec::new();
    webp.encoder()
        .write_to(&mut out)
        .map_err(|e| anyhow!("Write error: {}", e))?;
    Ok(out)
}

/// FIX (NEW): Rebuilds a WebP file, omitting EXIF and XMP metadata chunks.
/// WebP uses a RIFF container where metadata is stored in discrete named chunks.
pub(super) fn strip_webp(input: &Path, output: &Path, _options: &CleaningOptions) -> Result<()> {
    let cleaned = strip_webp_bytes(fs::read(input)?)?;
    fs::write(output, cleaned)?;
    Ok(())
}

/// Cleans an embedded image's raw bytes using whichever stripper matches its
/// format, based on a file extension or MIME type hint. Used to recursively
/// scrub EXIF/GPS from images embedded *inside* another container — MP3/FLAC
/// cover art, Office document media — which the outer file's own metadata
/// cleaning doesn't reach on its own. Returns `None` (leave untouched) for
/// formats this tool doesn't have a byte-level stripper for.
pub(super) fn strip_embedded_image_bytes(data: Vec<u8>, hint: &str) -> Option<Vec<u8>> {
    let hint = hint.to_lowercase();
    if hint.contains("jpeg") || hint.contains("jpg") {
        strip_jpeg_bytes(data).ok()
    } else if hint.contains("png") {
        strip_png_bytes(data).ok()
    } else if hint.contains("webp") {
        strip_webp_bytes(data).ok()
    } else {
        None
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

pub(super) fn analyze_pdf(path: &Path) -> Result<MetadataReport> {
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
pub(super) fn strip_pdf(input: &Path, output: &Path, options: &CleaningOptions) -> Result<()> {
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

        if !metadata_ids.is_empty() {
            // The document catalog references the XMP metadata stream by
            // object ID (/Root -> /Metadata <ref>). Deleting the stream
            // without also clearing that reference leaves it dangling —
            // nothing visibly breaks, but spec-conformant readers flag it
            // (exiftool: "Bad Metadata reference").
            if let Ok(catalog) = doc.catalog_mut() {
                catalog.remove(b"Metadata");
            }
            for id in metadata_ids {
                doc.objects.remove(&id);
            }
        }
    }

    // Re-compress remaining streams. lopdf's save() fully re-serializes the
    // document from its in-memory object model rather than doing an
    // incremental update, and without this the result can come out
    // significantly larger than the input for big real-world documents —
    // the original writer's stream compression isn't preserved otherwise.
    doc.compress();

    // save_modern() writes compressed cross-reference/object streams
    // (PDF 1.5+) instead of save()'s classic flat xref table — for a
    // document with thousands of objects (every page, font, image,
    // annotation...) that's real overhead compress() alone doesn't touch.
    let mut out_file =
        fs::File::create(output).map_err(|e| anyhow!("PDF Write Error: {}", e))?;
    doc.save_modern(&mut out_file)
        .map_err(|e| anyhow!("PDF Write Error: {}", e))?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// OFFICE DOCUMENT HANDLERS (With XML Parser)
// ═══════════════════════════════════════════════════════════════════════════

pub(super) fn analyze_office(path: &Path) -> Result<MetadataReport> {
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

    if let Some(total_time) = extract_xml_element_content(xml, "TotalTime") {
        if !total_time.is_empty() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Total Edit Time (minutes)".into(),
                value: total_time,
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
    for field in &["Application", "Company", "Manager", "Template", "TotalTime"] {
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
pub(super) fn strip_office(input: &Path, output: &Path, options: &CleaningOptions) -> Result<()> {
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

        // Embedded pictures (a photo pasted into the document) can carry
        // their own EXIF/GPS that the docProps XML rewriting below never
        // touches — clean them in place, keeping the original bytes if this
        // tool can't clean that particular format.
        let is_embedded_media_image = entry.name.contains("/media/")
            && matches!(
                entry
                    .name
                    .rsplit('.')
                    .next()
                    .map(str::to_lowercase)
                    .as_deref(),
                Some("jpg") | Some("jpeg") | Some("png") | Some("webp")
            );

        // Rewrite known metadata XML rather than deleting the files.
        let final_content: Vec<u8> =
            if is_embedded_media_image && (options.gps || options.author || options.date) {
                let hint = entry.name.clone();
                strip_embedded_image_bytes(entry.content.clone(), &hint).unwrap_or(entry.content)
            } else {
                match entry.name.as_str() {
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
                }
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
pub(super) fn analyze_zip(path: &Path) -> Result<MetadataReport> {
    let file_size = fs::metadata(path)?.len();
    let file = File::open(path)?;
    analyze_zip_reader(file, file_size)
}

/// Core ZIP-metadata analysis, generic over the reader so a real file
/// (production, via `analyze_zip`) and an in-memory byte buffer (the
/// `fuzz_zip_metadata` fuzz target, via `Cursor`) exercise the identical
/// parsing path. `pub` so the separate `qre-gui-fuzz` crate can call it
/// directly with arbitrary bytes instead of writing a temp file per input.
pub fn analyze_zip_reader<R: Read + std::io::Seek>(
    reader: R,
    file_size: u64,
) -> Result<MetadataReport> {
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| anyhow!("Invalid ZIP archive: {}", e))?;

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
            // Malformed/unusual DOS timestamps can make this None — skip the
            // entry rather than crash on a file that isn't ours to control.
            let Some(dt) = entry.last_modified() else {
                continue;
            };
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
pub(super) fn clean_zip_metadata(input: &Path, output: &Path) -> Result<()> {
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


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // Helper: returns (and creates if needed) a dedicated temp dir for a given test
    fn temp_dir(sub: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("qre_cleaner_tests").join(sub);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

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

    // ─── PDF ────────────────────────────────────────────────────────────────

    /// Builds a minimal but structurally valid PDF: one page, an Info
    /// dictionary (Author), and an XMP Metadata stream referenced from the
    /// document catalog — the piece `write_minimal_mp4`-style fixtures
    /// elsewhere in this codebase don't need, but which is exactly what
    /// exposed a real dangling-reference bug in a real Word-exported file.
    fn write_pdf_with_xmp_metadata(path: &PathBuf) -> lopdf::ObjectId {
        use lopdf::{dictionary, Document, Object, Stream};

        let mut doc = Document::with_version("1.5");

        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));

        let metadata_id = doc.add_object(Stream::new(
            dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
            b"<x:xmpmeta>fake xmp</x:xmpmeta>".to_vec(),
        ));

        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
            "Metadata" => metadata_id,
        });

        let info_id = doc.add_object(dictionary! {
            "Author" => Object::string_literal("Jane Doe"),
        });

        doc.trailer.set("Root", catalog_id);
        doc.trailer.set("Info", info_id);
        doc.save(path).unwrap();

        metadata_id
    }

    #[test]
    fn test_strip_pdf_removes_xmp_metadata_without_leaving_dangling_catalog_reference() {
        let dir = temp_dir("pdf_xmp_dangling_ref");
        let input = dir.join("in.pdf");
        let output = dir.join("out.pdf");
        let metadata_id = write_pdf_with_xmp_metadata(&input);

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
            remove_cover_art: false,
        };
        strip_pdf(&input, &output, &options).unwrap();

        // Re-load the cleaned file and confirm the catalog no longer
        // references the (now-deleted) metadata stream at all — a real
        // Word-exported PDF hit exactly this ("Bad Metadata reference" in
        // exiftool) when the stream was deleted without also clearing the
        // catalog's pointer to it.
        let cleaned = lopdf::Document::load(&output).unwrap();
        let catalog = cleaned.catalog().unwrap();
        assert!(
            catalog.get(b"Metadata").is_err(),
            "catalog must not reference the removed Metadata stream"
        );
        assert!(
            !cleaned.objects.contains_key(&metadata_id),
            "the Metadata stream object itself must be gone"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_pdf_removes_author_from_info_dict() {
        let dir = temp_dir("pdf_author");
        let input = dir.join("in.pdf");
        let output = dir.join("out.pdf");
        write_pdf_with_xmp_metadata(&input);

        let before = analyze_pdf(&input).unwrap();
        assert!(before.has_author, "raw_tags: {:?}", before.raw_tags);

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
            remove_cover_art: false,
        };
        strip_pdf(&input, &output, &options).unwrap();

        let after = analyze_pdf(&output).unwrap();
        assert!(!after.has_author, "raw_tags: {:?}", after.raw_tags);

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
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
                <TotalTime>102</TotalTime>
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

        let total_time_tag = report
            .raw_tags
            .iter()
            .find(|t| t.key == "Total Edit Time (minutes)")
            .unwrap();
        assert_eq!(total_time_tag.value, "102");
    }

    #[test]
    fn test_clean_app_xml_removes_total_edit_time() {
        // Regression test for a real Word-exported .docx where "Total Edit
        // Time" (minutes spent editing — a real behavioral detail, not just
        // an identity field) survived cleaning: it wasn't in clean_app_xml's
        // removal list at all, unlike Application/Company/Manager/Template.
        let xml = r#"<Properties>
            <Application>Microsoft Office Word</Application>
            <TotalTime>102</TotalTime>
            <Pages>7</Pages>
        </Properties>"#;

        let result = clean_app_xml(xml);

        assert!(
            !result.contains("102"),
            "Total Edit Time value must be cleared: {}",
            result
        );
        assert!(
            result.contains("<TotalTime></TotalTime>") || result.contains("<TotalTime/>"),
            "the TotalTime element itself must survive (empty), not be deleted: {}",
            result
        );
        // Pages is not privacy-relevant and must survive untouched.
        assert!(result.contains("<Pages>7</Pages>"));
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
            remove_cover_art: false,
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
            remove_cover_art: false,
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

    // ─── RAW (CR2 / NEF / ARW / DNG) ─────────────────────────────────────────

    #[test]
    fn test_analyze_raw_garbage_bytes_no_panic() {
        for (ext, label) in [
            ("cr2", "Canon RAW (CR2)"),
            ("nef", "Nikon RAW (NEF)"),
            ("arw", "Sony RAW (ARW)"),
            ("dng", "Adobe DNG"),
        ] {
            let dir = temp_dir("raw_garbage");
            let path = dir.join(format!("garbage.{ext}"));
            fs::write(&path, vec![0xFFu8; 128]).unwrap();

            let report = analyze_raw(&path, label).unwrap();
            assert_eq!(report.file_type, label);

            let _ = fs::remove_file(path);
        }
    }

}

// --- END OF FILE cleaner/documents.rs ---
