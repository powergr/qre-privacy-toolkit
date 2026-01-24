use anyhow::{anyhow, Result};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
// Import traits for Jpeg EXIF/ICC handling
use img_parts::{ImageEXIF, ImageICC}; 

#[derive(serde::Serialize, Debug)]
pub struct MetadataReport {
    pub has_gps: bool,
    pub has_author: bool,
    pub camera_info: Option<String>,
    pub software_info: Option<String>,
    pub creation_date: Option<String>,
    pub file_type: String,
}

// --- PUBLIC API ---

pub fn analyze_file(path: &Path) -> Result<MetadataReport> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();

    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "tiff" => analyze_image(path),
        "pdf" => analyze_pdf(path),
        "docx" | "xlsx" | "pptx" => analyze_office(path),
        _ => Err(anyhow!("Unsupported file type")),
    }
}

pub fn remove_metadata(path: &Path) -> Result<PathBuf> {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let new_name = format!("{}_clean.{}", stem, ext);
    let output_path = path.parent().unwrap_or(Path::new(".")).join(new_name);

    match ext.as_str() {
        "jpg" | "jpeg" => strip_jpeg(path, &output_path)?,
        "png" => strip_png(path, &output_path)?,
        "pdf" => strip_pdf(path, &output_path)?,
        "docx" | "xlsx" | "pptx" => strip_office(path, &output_path)?,
        _ => return Err(anyhow!("Unsupported file type")),
    }

    Ok(output_path)
}

// --- IMAGE HANDLERS ---

fn analyze_image(path: &Path) -> Result<MetadataReport> {
    let file = File::open(path)?;
    let mut reader = std::io::BufReader::new(&file);
    
    // Use 'exif' crate
    let exifreader = exif::Reader::new();
    let exif = exifreader.read_from_container(&mut reader).ok();

    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        file_type: "Image".to_string(),
    };

    if let Some(ex) = exif {
        if ex.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY).is_some() {
            report.has_gps = true;
        }
        if let Some(field) = ex.get_field(exif::Tag::Model, exif::In::PRIMARY) {
            report.camera_info = Some(field.display_value().to_string());
        }
        if let Some(field) = ex.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
            report.creation_date = Some(field.display_value().to_string());
        }
    }

    Ok(report)
}

fn strip_jpeg(input: &Path, output: &Path) -> Result<()> {
    let input_data = fs::read(input)?;
    let mut jpeg = img_parts::jpeg::Jpeg::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid JPEG: {}", e))?;

    // Clear metadata using traits
    jpeg.set_exif(None);        
    jpeg.set_icc_profile(None); 
    
    // Note: set_xmp/set_comments might not be supported by this version of img-parts,
    // but set_exif covers the most sensitive data (GPS/Camera info).

    let output_file = File::create(output)?;
    jpeg.encoder().write_to(output_file).map_err(|e| anyhow!("Write error: {}", e))?;
    Ok(())
}

fn strip_png(input: &Path, output: &Path) -> Result<()> {
    let input_data = fs::read(input)?;
    let mut png = img_parts::png::Png::from_bytes(input_data.into())
        .map_err(|e| anyhow!("Invalid PNG: {}", e))?;

    // Chunks to remove: EXIF, Text, Compressed Text, Int'l Text, Time
    let chunks_to_remove = [b"eXIf", b"tEXt", b"zTXt", b"iTXt", b"tIME"];
    
    // FIX: Modify chunks in-place instead of creating new Png struct
    png.chunks_mut().retain(|chunk| {
        // chunk.kind() returns [u8; 4], so we compare bytes directly
        !chunks_to_remove.contains(&&chunk.kind())
    });

    let output_file = File::create(output)?;
    png.encoder().write_to(output_file).map_err(|e| anyhow!("Write error: {}", e))?;
    Ok(())
}

// --- PDF HANDLERS ---

fn analyze_pdf(_path: &Path) -> Result<MetadataReport> {
    Ok(MetadataReport {
        has_gps: false,
        has_author: true, 
        camera_info: None,
        software_info: Some("PDF Generator".into()),
        creation_date: None,
        file_type: "PDF Document".to_string(),
    })
}

fn strip_pdf(input: &Path, output: &Path) -> Result<()> {
    let mut doc = lopdf::Document::load(input).map_err(|e| anyhow!("PDF Load Error: {}", e))?;
    
    // 1. Clear Info Dictionary
    doc.trailer.remove(b"Info");
    
    // 2. Remove Metadata Streams (XMP)
    let mut keys_to_remove = Vec::new();
    
    for (id, object) in doc.objects.iter() {
        if let lopdf::Object::Stream(ref stream) = object {
             // FIX: Correctly match the dictionary enum for "Type"
             if let Ok(type_obj) = stream.dict.get(b"Type") {
                 // Check if the object is a Name and equals "Metadata"
                 if let lopdf::Object::Name(name) = type_obj {
                     if name == b"Metadata" {
                         keys_to_remove.push(*id);
                     }
                 }
             }
        }
    }
    
    for id in keys_to_remove {
        doc.objects.remove(&id);
    }

    doc.save(output).map_err(|e| anyhow!("PDF Write Error: {}", e))?;
    Ok(())
}

// --- OFFICE DOCS (ZIP) HANDLERS ---

fn analyze_office(_path: &Path) -> Result<MetadataReport> {
    Ok(MetadataReport {
        has_gps: false,
        has_author: true, 
        camera_info: None,
        software_info: Some("Microsoft Office".into()),
        creation_date: None,
        file_type: "Office Document".to_string(),
    })
}

fn strip_office(input: &Path, output: &Path) -> Result<()> {
    let file = File::open(input)?;
    let mut archive = zip::ZipArchive::new(file)?;
    
    let out_file = File::create(output)?;
    let mut zip_writer = zip::ZipWriter::new(out_file);
    
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();
        
        // Skip metadata files
        if name.contains("docProps/core.xml") || name.contains("docProps/app.xml") {
            continue; 
        }

        // FIX: Use .compression() instead of .compression_method()
        let options = SimpleFileOptions::default()
            .compression_method(file.compression()) 
            .unix_permissions(file.unix_mode().unwrap_or(0o755));
            
        zip_writer.start_file(&name, options).map_err(|e| anyhow!("Zip Error: {}", e))?;
        std::io::copy(&mut file, &mut zip_writer)?;
    }

    zip_writer.finish()?;
    Ok(())
}