use anyhow::{anyhow, Result};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use img_parts::ImageICC; 

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct MetadataEntry {
    pub key: String,
    pub value: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct MetadataReport {
    pub has_gps: bool,
    pub has_author: bool,
    pub camera_info: Option<String>,
    pub software_info: Option<String>,
    pub creation_date: Option<String>,
    pub gps_info: Option<String>,
    pub file_type: String,
    pub raw_tags: Vec<MetadataEntry>,
}

#[derive(serde::Deserialize, Debug)]
pub struct CleaningOptions {
    pub gps: bool,
    pub author: bool, 
    pub date: bool,
}

// --- PUBLIC API ---

pub fn analyze_file(path: &Path) -> Result<MetadataReport> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();

    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "tiff" => analyze_image(path),
        "pdf" => analyze_pdf(path),
        "docx" | "xlsx" | "pptx" => analyze_office(path),
        "zip" => analyze_zip(path),
        _ => Err(anyhow!("Unsupported file type")),
    }
}

pub fn remove_metadata(path: &Path, options: CleaningOptions) -> Result<PathBuf> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let new_name = format!("{}_clean.{}", stem, ext);
    let output_path = path.parent().unwrap_or(Path::new(".")).join(new_name);

    if !options.gps && !options.author && !options.date {
        fs::copy(path, &output_path)?;
        return Ok(output_path);
    }

    match ext.as_str() {
        "jpg" | "jpeg" => strip_jpeg(path, &output_path)?,
        "png" => strip_png(path, &output_path)?,
        "pdf" => strip_pdf(path, &output_path)?,
        "docx" | "xlsx" | "pptx" => strip_office(path, &output_path)?,
        "zip" => clean_zip_metadata(path, &output_path)?,
        
        _ => return Err(anyhow!("Unsupported file type")),
    }

    Ok(output_path)
}

// --- IMAGE HANDLERS ---

fn analyze_image(path: &Path) -> Result<MetadataReport> {
    let file = File::open(path)?;
    let mut reader = std::io::BufReader::new(&file);
    
    let exifreader = exif::Reader::new();
    let exif = exifreader.read_from_container(&mut reader).ok();

    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "Image".to_string(),
        raw_tags: Vec::new(),
    };

    if let Some(ex) = exif {
        let mut lat_str = String::new();
        let mut long_str = String::new();

        for field in ex.fields() {
            report.raw_tags.push(MetadataEntry {
                key: field.tag.to_string(),
                value: field.display_value().with_unit(&ex).to_string(),
            });

            match field.tag {
                exif::Tag::GPSLatitude => {
                    lat_str = field.display_value().with_unit(&ex).to_string();
                    report.has_gps = true;
                },
                exif::Tag::GPSLongitude => {
                    long_str = field.display_value().with_unit(&ex).to_string();
                    report.has_gps = true;
                },
                exif::Tag::GPSAltitude | exif::Tag::GPSImgDirection => {
                    report.has_gps = true;
                },
                exif::Tag::Model => {
                    if report.camera_info.is_none() {
                        report.camera_info = Some(field.display_value().to_string());
                    }
                },
                exif::Tag::DateTime | exif::Tag::DateTimeOriginal => {
                    if report.creation_date.is_none() {
                        report.creation_date = Some(field.display_value().to_string());
                    }
                },
                exif::Tag::Artist | exif::Tag::Copyright | exif::Tag::Software | exif::Tag::Make => {
                    report.has_author = true;
                    if field.tag == exif::Tag::Software && report.software_info.is_none() {
                        report.software_info = Some(field.display_value().to_string());
                    }
                },
                _ => {}
            }
        }

        if !lat_str.is_empty() {
            if !long_str.is_empty() {
                report.gps_info = Some(format!("{}, {}", lat_str, long_str));
            } else {
                report.gps_info = Some(lat_str);
            }
        }
    }

    Ok(report)
}

fn strip_jpeg(input: &Path, output: &Path) -> Result<()> {
    let input_data = fs::read(input)?;
    let mut jpeg = img_parts::jpeg::Jpeg::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid JPEG: {}", e))?;

    let segments_to_remove: Vec<u8> = (0xE1..=0xEF).chain(std::iter::once(0xFE)).collect();

    jpeg.set_icc_profile(None);
    let segments = jpeg.segments_mut();
    
    segments.retain(|seg| {
        let marker = seg.marker();
        if marker == 0xE0 || marker == 0xDB || marker == 0xC4 || marker == 0xDA || marker == 0xDD { return true; }
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC { return true; }
        if segments_to_remove.contains(&marker) { return false; }
        true
    });

    let output_file = File::create(output)?;
    jpeg.encoder().write_to(output_file).map_err(|e| anyhow!("Write error: {}", e))?;
    Ok(())
}

fn strip_png(input: &Path, output: &Path) -> Result<()> {
    let input_data = fs::read(input)?;
    let mut png = img_parts::png::Png::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid PNG: {}", e))?;

    let metadata_chunks = [
        b"eXIf", b"tEXt", b"zTXt", b"iTXt", 
        b"tIME", b"pHYs", b"iCCP", b"cHRM", 
        b"sRGB", b"gAMA", b"bKGD", b"hist"
    ];

    png.chunks_mut().retain(|chunk| {
        let type_bytes = chunk.kind();
        !metadata_chunks.contains(&&type_bytes)
    });

    let output_file = File::create(output)?;
    png.encoder().write_to(output_file).map_err(|e| anyhow!("Write error: {}", e))?;
    Ok(())
}

// --- PDF HANDLERS ---

fn analyze_pdf(path: &Path) -> Result<MetadataReport> {
    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "PDF Document".to_string(),
        raw_tags: Vec::new(),
    };

    if let Ok(doc) = lopdf::Document::load(path) {
        // FIXED: Safe traversal using if let chaining and .ok()
        if let Ok(info_obj) = doc.trailer.get(b"Info") {
            if let Ok(info_ref) = info_obj.as_reference() {
                if let Ok(dict_obj) = doc.get_object(info_ref) {
                    if let Ok(info_dict) = dict_obj.as_dict() {
                        
                        // Helper to safely extract string from dictionary
                        let get_str = |key: &[u8]| -> Option<String> {
                            info_dict.get(key)
                                .ok() // Convert Result to Option
                                .and_then(|o| o.as_str().ok()) // Convert Result to Option
                                .map(|b| String::from_utf8_lossy(b).into_owned())
                        };

                        if let Some(author) = get_str(b"Author") {
                            report.has_author = true;
                            report.raw_tags.push(MetadataEntry { key: "Author".into(), value: author });
                        }
                        if let Some(creator) = get_str(b"Creator") {
                            report.has_author = true;
                            report.raw_tags.push(MetadataEntry { key: "Creator".into(), value: creator });
                        }
                        if let Some(producer) = get_str(b"Producer") {
                            report.software_info = Some(producer.clone());
                            report.raw_tags.push(MetadataEntry { key: "Producer".into(), value: producer });
                        }
                        if let Some(date) = get_str(b"CreationDate") {
                            report.creation_date = Some(date.clone());
                            report.raw_tags.push(MetadataEntry { key: "CreationDate".into(), value: date });
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
    
    // Remove the Info dictionary reference from the trailer
    doc.trailer.remove(b"Info");
    
    // Scan objects for Metadata streams (XMP) and remove them
    let mut keys_to_remove = Vec::new();
    for (id, object) in doc.objects.iter() {
        if let lopdf::Object::Stream(ref stream) = object {
             // Check if it's a Metadata stream
             if let Ok(type_obj) = stream.dict.get(b"Type") {
                 if let lopdf::Object::Name(name) = type_obj {
                     if name == b"Metadata" {
                         keys_to_remove.push(*id);
                     }
                 }
             }
        }
    }
    
    // Perform removal
    for id in keys_to_remove {
        doc.objects.remove(&id);
    }

    doc.save(output).map_err(|e| anyhow!("PDF Write Error: {}", e))?;
    Ok(())
}

// --- OFFICE DOCS HANDLERS (DOCX, XLSX, PPTX) ---

fn analyze_office(path: &Path) -> Result<MetadataReport> {
    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: Some("Microsoft Office / OpenXML".into()),
        creation_date: None,
        gps_info: None,
        file_type: "Office Document".to_string(),
        raw_tags: Vec::new(),
    };

    if let Ok(file) = File::open(path) {
        if let Ok(mut archive) = zip::ZipArchive::new(file) {
            if let Ok(mut core_xml) = archive.by_name("docProps/core.xml") {
                let mut xml_content = String::new();
                if core_xml.read_to_string(&mut xml_content).is_ok() {
                    
                    if let Some(start) = xml_content.find("<dc:creator>") {
                        if let Some(end) = xml_content[start..].find("</dc:creator>") {
                            let val = &xml_content[start+12 .. start+end];
                            report.has_author = true;
                            report.raw_tags.push(MetadataEntry { key: "Creator".into(), value: val.into() });
                        }
                    }

                    if let Some(start) = xml_content.find("<cp:lastModifiedBy>") {
                        if let Some(end) = xml_content[start..].find("</cp:lastModifiedBy>") {
                            let val = &xml_content[start+19 .. start+end];
                            report.has_author = true;
                            report.raw_tags.push(MetadataEntry { key: "Last Modified By".into(), value: val.into() });
                        }
                    }

                    if let Some(start) = xml_content.find("<dcterms:created") {
                        if let Some(tag_end) = xml_content[start..].find('>') {
                            let content_start = start + tag_end + 1;
                            if let Some(end) = xml_content[content_start..].find("</dcterms:created>") {
                                let val = &xml_content[content_start .. content_start+end];
                                report.creation_date = Some(val.into());
                                report.raw_tags.push(MetadataEntry { key: "Created".into(), value: val.into() });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(report)
}

fn strip_office(input: &Path, output: &Path) -> Result<()> {
    let file = File::open(input)?;
    let mut archive = zip::ZipArchive::new(file)?;
    
    let out_file = File::create(output)?;
    let mut zip_writer = zip::ZipWriter::new(out_file);
    
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();
        
        if name.contains("docProps/core.xml") || 
           name.contains("docProps/app.xml") || 
           name.contains("docProps/custom.xml") ||
           name.contains("docProps/thumbnail.jpeg") {
            continue; 
        }

        let options = SimpleFileOptions::default()
            .compression_method(file.compression()) 
            .unix_permissions(file.unix_mode().unwrap_or(0o755));
            
        zip_writer.start_file(&name, options).map_err(|e| anyhow!("Zip Error: {}", e))?;
        std::io::copy(&mut file, &mut zip_writer)?;
    }

    zip_writer.finish()?;
    Ok(())
}

// --- ZIP HANDLERS ---

fn analyze_zip(_path: &Path) -> Result<MetadataReport> {
    Ok(MetadataReport {
        has_gps: false,
        has_author: false, 
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "ZIP Archive".to_string(),
        raw_tags: vec![MetadataEntry { key: "Info".into(), value: "ZIP archives may contain file timestamps and comments".into() }],
    })
}

fn clean_zip_metadata(input: &Path, output: &Path) -> Result<()> {
    let file = File::open(input)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let out_file = File::create(output)?;
    let mut zip_writer = zip::ZipWriter::new(out_file);
    
    zip_writer.set_comment("");

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();
        
        let options = SimpleFileOptions::default()
            .compression_method(file.compression())
            .unix_permissions(0o755);

        zip_writer.start_file(&name, options).map_err(|e| anyhow!("Zip Error: {}", e))?;
        std::io::copy(&mut file, &mut zip_writer)?;
    }

    zip_writer.finish()?;
    Ok(())
}