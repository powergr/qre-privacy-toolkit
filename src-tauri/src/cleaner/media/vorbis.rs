// --- START OF FILE cleaner/media/vorbis.rs ---
//
// FLAC / OGG (Vorbis comment) audio metadata handler. lofty's Tag/Accessor
// API is format-agnostic (it auto-detects FLAC vs OGG Vorbis/Opus/Speex from
// the file), so one implementation covers all of them — unlike MP3, which
// needs ID3-specific frame IDs via the `id3` crate.

use super::super::documents::strip_embedded_image_bytes;
use super::super::{CleaningOptions, MetadataEntry, MetadataReport};
use anyhow::{anyhow, Result};
use std::fs;
use std::path::Path;

// ═══════════════════════════════════════════════════════════════════════════
// FLAC / OGG (VORBIS COMMENT) AUDIO METADATA HANDLER
// ═══════════════════════════════════════════════════════════════════════════
// `lofty`'s Tag/Accessor API is format-agnostic (it auto-detects FLAC vs OGG
// Vorbis/Opus from the file), so one implementation covers both — unlike MP3,
// which needs ID3-specific frame IDs via the `id3` crate.

// Vorbis comment field names that carry no personal/identifying information,
// kept as-is when `options.author` strips everything else.
const VORBIS_SAFE_KEYS: &[&str] = &[
    "TRACKNUMBER",
    "TRACKTOTAL",
    "DISCNUMBER",
    "DISCTOTAL",
    "GENRE",
    "TITLE",
];

/// Builds a MetadataReport straight from a native Vorbis-comments block.
///
/// This deliberately reads the *native* `VorbisComments` struct rather than
/// lofty's generic `Tag` abstraction: `Tag` silently drops any field that
/// doesn't map to one of its ~100 known `ItemKey` variants, which throws away
/// exactly the arbitrary custom fields (ENCODERSETTINGS, SOURCEMEDIA, WORK,
/// WWWAUDIOFILE, ...) that batch-tagging tools commonly stuff into files —
/// so both detection and stripping have to happen at this level to see them.
fn build_vorbis_report(
    vc: Option<&lofty::ogg::tag::VorbisComments>,
    // FLAC stores cover art in its own native PICTURE metadata block, kept
    // entirely separate from VorbisComments — see the comment on
    // `strip_flac` for why. Callers pass that count in here; it's 0 for the
    // Ogg-family formats, which have no such separate storage.
    extra_picture_count: usize,
    file_type_label: &str,
    file_size: u64,
) -> MetadataReport {
    use lofty::ogg::OggPictureStorage;

    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: file_type_label.to_string(),
        file_size,
        raw_tags: Vec::new(),
        app_info: None,
    };

    let mut picture_count = extra_picture_count;

    if let Some(vc) = vc {
        for (key, value) in vc.items() {
            let upper = key.to_ascii_uppercase();
            if !VORBIS_SAFE_KEYS.contains(&upper.as_str()) {
                report.has_author = true;
            }
            if upper == "DATE" || upper == "YEAR" {
                report.creation_date = Some(value.to_string());
            }
            report.raw_tags.push(MetadataEntry {
                key: key.to_string(),
                value: value.to_string(),
            });
        }
        picture_count += vc.pictures().len();
    }

    if picture_count > 0 {
        report.raw_tags.push(MetadataEntry {
            key: "Embedded Cover Art".into(),
            value: format!(
                "{} image(s) — may carry its own EXIF/GPS data",
                picture_count
            ),
        });
    }

    report
}

/// Strips pictures from any Vorbis-style picture storage. Shared between
/// the VorbisComments-level storage (used by FLAC/OGG/Opus/Speex alike) and,
/// for FLAC specifically, its separate native PICTURE block storage — see
/// the comment on `strip_flac`.
fn strip_pictures<T: lofty::ogg::OggPictureStorage>(storage: &mut T, options: &CleaningOptions) {
    if options.remove_cover_art {
        // Cleaning a picture's EXIF only removes metadata *inside* it — it
        // can't remove the picture's own visual content.
        storage.remove_pictures();
    } else if options.gps || options.author || options.date {
        // Cover art can itself carry EXIF/GPS the field-level removal above
        // never touches — clean each one, keeping any picture this tool
        // can't clean (unrecognized format) as-is. Draining and re-inserting
        // is simpler than in-place mutation and only reorders pictures,
        // which isn't semantically meaningful here.
        for (pic, info) in storage.remove_pictures() {
            let hint = pic
                .mime_type()
                .map(|m| format!("{:?}", m))
                .unwrap_or_default();
            let cleaned = strip_embedded_image_bytes(pic.data().to_vec(), &hint);
            let final_pic = match cleaned {
                Some(bytes) => lofty::picture::Picture::unchecked(bytes)
                    .pic_type(pic.pic_type())
                    .description(pic.description().unwrap_or_default().to_string())
                    .build(),
                None => pic,
            };
            let _ = storage.insert_picture(final_pic, Some(info));
        }
    }
}

/// Strips selected fields from a native Vorbis-comments block in place. See
/// [`build_vorbis_report`] for why this operates on `VorbisComments` and not
/// lofty's generic `Tag`.
fn strip_vorbis_comments_fields(
    vc: &mut lofty::ogg::tag::VorbisComments,
    options: &CleaningOptions,
) {
    if options.author {
        let keys_to_remove: std::collections::HashSet<String> = vc
            .items()
            .map(|(k, _)| k.to_string())
            .filter(|k| !VORBIS_SAFE_KEYS.contains(&k.to_ascii_uppercase().as_str()))
            .collect();
        for key in keys_to_remove {
            let _ = vc.remove(&key).count();
        }
    }
    if options.date {
        let _ = vc.remove("DATE").count();
        let _ = vc.remove("YEAR").count();
    }

    strip_pictures(vc, options);
}

fn detect_ogg_codec(path: &Path) -> Result<lofty::file::FileType> {
    lofty::probe::Probe::open(path)
        .map_err(|e| anyhow!("Failed to open Ogg file: {}", e))?
        .guess_file_type()
        .map_err(|e| anyhow!("Failed to detect Ogg codec: {}", e))?
        .file_type()
        .ok_or_else(|| anyhow!("Unrecognized Ogg codec"))
}

pub(in crate::cleaner) fn analyze_flac(path: &Path) -> Result<MetadataReport> {
    use lofty::file::AudioFile;

    use lofty::ogg::OggPictureStorage;

    let file_size = fs::metadata(path)?.len();
    let mut file = fs::File::open(path)?;
    let flac = lofty::flac::FlacFile::read_from(&mut file, lofty::config::ParseOptions::new())
        .map_err(|e| anyhow!("Failed to parse FLAC: {}", e))?;
    Ok(build_vorbis_report(
        flac.vorbis_comments(),
        flac.pictures().len(),
        "FLAC Audio",
        file_size,
    ))
}

pub(in crate::cleaner) fn strip_flac(input: &Path, output: &Path, options: &CleaningOptions) -> Result<()> {
    use lofty::file::AudioFile;

    let mut file = fs::File::open(input)?;
    let mut flac = lofty::flac::FlacFile::read_from(&mut file, lofty::config::ParseOptions::new())
        .map_err(|e| anyhow!("Failed to parse FLAC: {}", e))?;
    if let Some(vc) = flac.vorbis_comments_mut() {
        strip_vorbis_comments_fields(vc, options);
    }
    // save_to_path opens the destination with read+write but never creates
    // it, so the output file must already exist.
    fs::copy(input, output)?;
    flac.save_to_path(output, lofty::config::WriteOptions::default())
        .map_err(|e| anyhow!("Failed to write FLAC tag: {}", e))?;

    // Real FLAC files (unlike OGG/Opus/Speex) almost always store cover art
    // as a native FLAC PICTURE metadata block rather than embedding it in
    // the VORBIS_COMMENT block. lofty exposes that as FlacFile's own,
    // separate OggPictureStorage implementation, but empirically its writer
    // doesn't actually persist a removed native picture block to disk — the
    // old block survives a save_to_path round-trip even after
    // remove_pictures(). Handled directly instead, bypassing that path.
    strip_flac_native_picture_blocks(output, options)?;

    Ok(())
}

/// Removes or cleans FLAC PICTURE metadata blocks (block type 6) by reading
/// and rewriting the block chain directly. See the comment in `strip_flac`
/// for why this exists instead of going through lofty's picture API.
fn strip_flac_native_picture_blocks(path: &Path, options: &CleaningOptions) -> Result<()> {
    if !(options.remove_cover_art || options.gps || options.author || options.date) {
        return Ok(());
    }

    let bytes = fs::read(path)?;
    if bytes.len() < 4 || &bytes[0..4] != b"fLaC" {
        return Ok(());
    }

    let mut kept_blocks: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut modified = false;
    let mut pos = 4usize;

    loop {
        if pos + 4 > bytes.len() {
            // Malformed/truncated metadata chain — leave the file as-is
            // rather than risk corrupting it.
            return Ok(());
        }
        let header = bytes[pos];
        let is_last = header & 0x80 != 0;
        let block_type = header & 0x7F;
        let len = ((bytes[pos + 1] as usize) << 16)
            | ((bytes[pos + 2] as usize) << 8)
            | (bytes[pos + 3] as usize);
        let data_start = pos + 4;
        let data_end = data_start + len;
        if data_end > bytes.len() {
            return Ok(());
        }
        let data = &bytes[data_start..data_end];

        if block_type == 6 {
            if options.remove_cover_art {
                modified = true; // dropped entirely
            } else if options.gps || options.author || options.date {
                match clean_flac_picture_block(data) {
                    Some(cleaned) => {
                        modified = true;
                        kept_blocks.push((block_type, cleaned));
                    }
                    None => kept_blocks.push((block_type, data.to_vec())),
                }
            } else {
                kept_blocks.push((block_type, data.to_vec()));
            }
        } else {
            kept_blocks.push((block_type, data.to_vec()));
        }

        pos = data_end;
        if is_last {
            break;
        }
    }

    if !modified {
        return Ok(());
    }

    let mut new_bytes = Vec::with_capacity(bytes.len());
    new_bytes.extend_from_slice(b"fLaC");
    let last_index = kept_blocks.len().saturating_sub(1);
    for (i, (block_type, data)) in kept_blocks.iter().enumerate() {
        let mut header_byte = block_type & 0x7F;
        if i == last_index {
            header_byte |= 0x80;
        }
        new_bytes.push(header_byte);
        let len = data.len();
        new_bytes.push(((len >> 16) & 0xFF) as u8);
        new_bytes.push(((len >> 8) & 0xFF) as u8);
        new_bytes.push((len & 0xFF) as u8);
        new_bytes.extend_from_slice(data);
    }
    // Everything after the metadata block chain is the audio stream itself.
    new_bytes.extend_from_slice(&bytes[pos..]);

    fs::write(path, new_bytes)?;
    Ok(())
}

/// Parses a FLAC PICTURE block's fixed layout, cleans the embedded image's
/// own EXIF/GPS data, and re-serializes with the (likely different) new
/// image size. Returns `None` if the block can't be parsed or nothing
/// changed, in which case the original block should be kept as-is.
fn clean_flac_picture_block(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 32 {
        return None;
    }
    let picture_type = u32::from_be_bytes(data[0..4].try_into().ok()?);
    let mime_len = u32::from_be_bytes(data[4..8].try_into().ok()?) as usize;
    let mime_start = 8usize;
    let mime_end = mime_start.checked_add(mime_len)?;
    if data.len() < mime_end + 4 {
        return None;
    }
    let mime = std::str::from_utf8(&data[mime_start..mime_end]).ok()?;

    let desc_len_start = mime_end;
    let desc_len =
        u32::from_be_bytes(data[desc_len_start..desc_len_start + 4].try_into().ok()?) as usize;
    let desc_start = desc_len_start + 4;
    let desc_end = desc_start.checked_add(desc_len)?;
    if data.len() < desc_end + 20 {
        return None;
    }
    let description = &data[desc_start..desc_end];

    // width(4) + height(4) + color depth(4) + indexed-palette colors(4).
    let fixed_fields_start = desc_end;
    let fixed_fields_end = fixed_fields_start + 16;
    let fixed_fields = &data[fixed_fields_start..fixed_fields_end];
    let data_len_start = fixed_fields_end;
    let img_data_len =
        u32::from_be_bytes(data[data_len_start..data_len_start + 4].try_into().ok()?) as usize;
    let img_start = data_len_start + 4;
    let img_end = img_start.checked_add(img_data_len)?;
    if data.len() < img_end {
        return None;
    }
    let image_data = data[img_start..img_end].to_vec();

    let cleaned_image = strip_embedded_image_bytes(image_data, mime)?;

    let mut result = Vec::with_capacity(data.len());
    result.extend_from_slice(&picture_type.to_be_bytes());
    result.extend_from_slice(&(mime_len as u32).to_be_bytes());
    result.extend_from_slice(mime.as_bytes());
    result.extend_from_slice(&(desc_len as u32).to_be_bytes());
    result.extend_from_slice(description);
    result.extend_from_slice(fixed_fields);
    result.extend_from_slice(&(cleaned_image.len() as u32).to_be_bytes());
    result.extend_from_slice(&cleaned_image);

    Some(result)
}

pub(in crate::cleaner) fn analyze_ogg(path: &Path) -> Result<MetadataReport> {
    use lofty::file::AudioFile;

    let file_size = fs::metadata(path)?.len();
    let file_type = detect_ogg_codec(path)?;
    let mut file = fs::File::open(path)?;
    let parse_options = lofty::config::ParseOptions::new();

    let report = match file_type {
        lofty::file::FileType::Vorbis => {
            let f = lofty::ogg::VorbisFile::read_from(&mut file, parse_options)
                .map_err(|e| anyhow!("Failed to parse Ogg Vorbis: {}", e))?;
            build_vorbis_report(Some(f.vorbis_comments()), 0, "OGG Vorbis Audio", file_size)
        }
        lofty::file::FileType::Opus => {
            let f = lofty::ogg::OpusFile::read_from(&mut file, parse_options)
                .map_err(|e| anyhow!("Failed to parse Opus: {}", e))?;
            build_vorbis_report(Some(f.vorbis_comments()), 0, "OGG Opus Audio", file_size)
        }
        lofty::file::FileType::Speex => {
            let f = lofty::ogg::SpeexFile::read_from(&mut file, parse_options)
                .map_err(|e| anyhow!("Failed to parse Speex: {}", e))?;
            build_vorbis_report(Some(f.vorbis_comments()), 0, "OGG Speex Audio", file_size)
        }
        other => return Err(anyhow!("Unsupported Ogg codec: {:?}", other)),
    };
    Ok(report)
}

pub(in crate::cleaner) fn strip_ogg(input: &Path, output: &Path, options: &CleaningOptions) -> Result<()> {
    use lofty::file::AudioFile;

    let file_type = detect_ogg_codec(input)?;
    let mut file = fs::File::open(input)?;
    let parse_options = lofty::config::ParseOptions::new();
    // save_to_path opens the destination with read+write but never creates
    // it, so the output file must already exist.
    fs::copy(input, output)?;

    match file_type {
        lofty::file::FileType::Vorbis => {
            let mut f = lofty::ogg::VorbisFile::read_from(&mut file, parse_options)
                .map_err(|e| anyhow!("Failed to parse Ogg Vorbis: {}", e))?;
            strip_vorbis_comments_fields(f.vorbis_comments_mut(), options);
            f.save_to_path(output, lofty::config::WriteOptions::default())
                .map_err(|e| anyhow!("Failed to write Ogg Vorbis tag: {}", e))?;
        }
        lofty::file::FileType::Opus => {
            let mut f = lofty::ogg::OpusFile::read_from(&mut file, parse_options)
                .map_err(|e| anyhow!("Failed to parse Opus: {}", e))?;
            strip_vorbis_comments_fields(f.vorbis_comments_mut(), options);
            f.save_to_path(output, lofty::config::WriteOptions::default())
                .map_err(|e| anyhow!("Failed to write Opus tag: {}", e))?;
        }
        lofty::file::FileType::Speex => {
            let mut f = lofty::ogg::SpeexFile::read_from(&mut file, parse_options)
                .map_err(|e| anyhow!("Failed to parse Speex: {}", e))?;
            strip_vorbis_comments_fields(f.vorbis_comments_mut(), options);
            f.save_to_path(output, lofty::config::WriteOptions::default())
                .map_err(|e| anyhow!("Failed to write Speex tag: {}", e))?;
        }
        other => return Err(anyhow!("Unsupported Ogg codec: {:?}", other)),
    }
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

    /// Builds a minimal fake JPEG (SOI + one APP1/Exif marker + EOI) for
    /// embedded-cover-art-cleaning tests.
    fn minimal_jpeg_with_app1() -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8]; // SOI
        let app1_payload = b"Exif\0\0fake-exif-payload-marker";
        bytes.extend_from_slice(&[0xFF, 0xE1]);
        bytes.extend_from_slice(&((app1_payload.len() + 2) as u16).to_be_bytes());
        bytes.extend_from_slice(app1_payload);
        bytes.extend_from_slice(&[0xFF, 0xD9]); // EOI
        bytes
    }

    // ─── FLAC / OGG ────────────────────────────────────────────────────────

    /// Builds the minimal valid FLAC container lofty needs to parse and write
    /// tags: the "fLaC" magic plus a single mandatory STREAMINFO metadata
    /// block (no actual audio frames — lofty only needs the container
    /// structure to inject a VORBIS_COMMENT block).
    fn write_minimal_flac(path: &PathBuf) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"fLaC");

        // STREAMINFO block header: last-block flag set (0x80) | type 0.
        bytes.push(0x80);
        // 24-bit big-endian block length (STREAMINFO is always 34 bytes).
        bytes.extend_from_slice(&34u32.to_be_bytes()[1..]);

        let min_blocksize: u16 = 4096;
        let max_blocksize: u16 = 4096;
        let min_framesize: u32 = 0;
        let max_framesize: u32 = 0;
        let sample_rate: u64 = 44100;
        let channels_minus_one: u64 = 1; // stereo
        let bits_per_sample_minus_one: u64 = 15; // 16-bit
        let total_samples: u64 = 0;

        bytes.extend_from_slice(&min_blocksize.to_be_bytes());
        bytes.extend_from_slice(&max_blocksize.to_be_bytes());
        bytes.extend_from_slice(&min_framesize.to_be_bytes()[1..]);
        bytes.extend_from_slice(&max_framesize.to_be_bytes()[1..]);

        // Packed 64-bit field: sample_rate(20) | channels-1(3) | bits-1(5) | total_samples(36).
        let packed: u64 = (sample_rate << 44)
            | (channels_minus_one << 41)
            | (bits_per_sample_minus_one << 36)
            | total_samples;
        bytes.extend_from_slice(&packed.to_be_bytes());

        bytes.extend_from_slice(&[0u8; 16]); // MD5 signature (unused, all zero)

        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn test_flac_tag_roundtrip() {
        use lofty::file::TaggedFileExt;
        use lofty::tag::{Accessor, TagExt};

        let dir = temp_dir("flac_roundtrip");
        let path = dir.join("song.flac");
        write_minimal_flac(&path);

        // Write tags onto the minimal container via lofty directly.
        {
            let mut tagged = lofty::probe::Probe::open(&path)
                .unwrap()
                .read()
                .expect("lofty must parse the minimal STREAMINFO-only FLAC");
            let tag_type = tagged.primary_tag_type();
            if tagged.primary_tag().is_none() {
                tagged.insert_tag(lofty::tag::Tag::new(tag_type));
            }
            let tag = tagged.primary_tag_mut().unwrap();
            tag.set_artist("Secret Artist".to_string());
            tag.set_comment("ripped on my personal laptop".to_string());
            tag.save_to_path(&path, lofty::config::WriteOptions::default())
                .unwrap();
        }

        let report = analyze_flac(&path).unwrap();
        assert!(
            report.has_author,
            "has_author must be true once artist/comment are set, got: {:?}",
            report.raw_tags
        );
        assert!(
            report
                .raw_tags
                .iter()
                .any(|t| t.key.eq_ignore_ascii_case("artist") && t.value == "Secret Artist"),
            "raw_tags: {:?}",
            report.raw_tags
        );

        let output = dir.join("out.flac");
        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
            remove_cover_art: false,
        };
        strip_flac(&path, &output, &options).unwrap();

        let cleaned = analyze_flac(&output).unwrap();
        assert!(
            !cleaned.has_author,
            "artist/comment must be gone after stripping, got: {:?}",
            cleaned.raw_tags
        );

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_flac_author_removes_arbitrary_custom_fields() {
        // Vorbis comments allow completely open-ended field names — mirrors
        // a real "scene release" style FLAC (dbPoweramp/EAC-tagged) with a
        // pile of custom fields beyond the standard artist/comment. These are
        // written directly against the native VorbisComments struct because
        // lofty's generic Tag can't represent (or preserve) a key it doesn't
        // already know about — see build_vorbis_report's doc comment.
        use lofty::file::AudioFile;
        use lofty::ogg::tag::VorbisComments;

        let dir = temp_dir("flac_custom_fields");
        let path = dir.join("song.flac");
        write_minimal_flac(&path);

        {
            let mut file = fs::File::open(&path).unwrap();
            let mut flac =
                lofty::flac::FlacFile::read_from(&mut file, lofty::config::ParseOptions::new())
                    .unwrap();
            let mut vc = VorbisComments::new();
            vc.push("ARTIST".to_string(), "AC/DC".to_string());
            for (key, value) in [
                ("ENCODERSETTINGS", "PMEDIA"),
                ("SOURCEMEDIA", "PMEDIA"),
                ("RELEASECOUNTRY", "PMEDIA"),
                ("WWWAUDIOFILE", "www.t.me/pmedia_music"),
            ] {
                vc.push(key.to_string(), value.to_string());
            }
            flac.set_vorbis_comments(vc);
            flac.save_to_path(&path, lofty::config::WriteOptions::default())
                .unwrap();
        }

        // Sanity check: all 5 custom/author items present before stripping
        // (artist + 4 arbitrary custom fields), and analyze_flac can see them.
        let before = analyze_flac(&path).unwrap();
        assert_eq!(before.raw_tags.len(), 5, "raw_tags: {:?}", before.raw_tags);
        assert!(before.has_author);

        let output = dir.join("out.flac");
        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
            remove_cover_art: false,
        };
        strip_flac(&path, &output, &options).unwrap();

        let after = analyze_flac(&output).unwrap();
        assert_eq!(
            after.raw_tags.len(),
            0,
            "every custom Vorbis comment field must be gone, not just artist/comment, got: {:?}",
            after.raw_tags
        );
        assert!(!after.has_author);

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_flac_remove_cover_art_deletes_picture_entirely() {
        use lofty::file::AudioFile;
        use lofty::ogg::tag::VorbisComments;
        use lofty::ogg::OggPictureStorage;

        let dir = temp_dir("flac_delete_cover");
        let path = dir.join("song.flac");
        write_minimal_flac(&path);

        {
            let mut file = fs::File::open(&path).unwrap();
            let mut flac =
                lofty::flac::FlacFile::read_from(&mut file, lofty::config::ParseOptions::new())
                    .unwrap();
            let mut vc = VorbisComments::new();
            let picture = lofty::picture::Picture::unchecked(minimal_jpeg_with_app1())
                .pic_type(lofty::picture::PictureType::CoverFront)
                .build();
            vc.insert_picture(picture, Some(lofty::picture::PictureInformation::default()))
                .unwrap();
            flac.set_vorbis_comments(vc);
            flac.save_to_path(&path, lofty::config::WriteOptions::default())
                .unwrap();
        }

        let output = dir.join("out.flac");
        let options = CleaningOptions {
            gps: false,
            author: false,
            date: false,
            remove_cover_art: true,
        };
        strip_flac(&path, &output, &options).unwrap();

        let mut out_file = fs::File::open(&output).unwrap();
        let after =
            lofty::flac::FlacFile::read_from(&mut out_file, lofty::config::ParseOptions::new())
                .unwrap();
        assert_eq!(
            after
                .vorbis_comments()
                .map(|vc| vc.pictures().len())
                .unwrap_or(0),
            0,
            "cover art must be deleted entirely, not just EXIF-cleaned"
        );

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_flac_removes_native_picture_block_cover_art() {
        // Regression test for a real Mutagen-tagged FLAC where cover art
        // survived "Cover Art" cleaning. lofty's own docs say pictures are
        // "stored in the FlacFile itself, rather than the tag" — real FLAC
        // files (unlike the OGG/Opus/Speex family) use a native FLAC
        // PICTURE metadata block, exposed as FlacFile's OWN separate
        // OggPictureStorage implementation, not VorbisComments'. The other
        // cover-art test above only exercised the VorbisComments-level
        // storage (unrealistic for FLAC), which is why it passed while the
        // real bug went undetected.
        use lofty::file::AudioFile;
        use lofty::ogg::OggPictureStorage;

        let dir = temp_dir("flac_delete_native_cover");
        let path = dir.join("song.flac");
        write_minimal_flac(&path);

        {
            let mut file = fs::File::open(&path).unwrap();
            let mut flac =
                lofty::flac::FlacFile::read_from(&mut file, lofty::config::ParseOptions::new())
                    .unwrap();
            let picture = lofty::picture::Picture::unchecked(minimal_jpeg_with_app1())
                .pic_type(lofty::picture::PictureType::CoverFront)
                .build();
            flac.insert_picture(picture, Some(lofty::picture::PictureInformation::default()))
                .unwrap();
            flac.save_to_path(&path, lofty::config::WriteOptions::default())
                .unwrap();
        }

        // Sanity check: the fixture really does carry a native picture, and
        // analyze_flac must see it.
        let before = analyze_flac(&path).unwrap();
        assert!(
            before
                .raw_tags
                .iter()
                .any(|t| t.key == "Embedded Cover Art"),
            "raw_tags: {:?}",
            before.raw_tags
        );

        let output = dir.join("out.flac");
        let options = CleaningOptions {
            gps: false,
            author: false,
            date: false,
            remove_cover_art: true,
        };
        strip_flac(&path, &output, &options).unwrap();

        let mut out_file = fs::File::open(&output).unwrap();
        let after =
            lofty::flac::FlacFile::read_from(&mut out_file, lofty::config::ParseOptions::new())
                .unwrap();
        assert_eq!(
            after.pictures().len(),
            0,
            "cover art in FLAC's native PICTURE block must be deleted entirely"
        );

        let after_report = analyze_flac(&output).unwrap();
        assert!(
            !after_report
                .raw_tags
                .iter()
                .any(|t| t.key == "Embedded Cover Art"),
            "raw_tags: {:?}",
            after_report.raw_tags
        );

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_clean_flac_picture_block_strips_embedded_exif_but_keeps_picture() {
        // Unit-level test for the other branch of strip_flac_native_picture_blocks:
        // cleaning a picture's own EXIF in place (GPS/Author/Date, without
        // Cover Art checked) must still work, not just full deletion.
        let jpeg = minimal_jpeg_with_app1();
        let mime = b"image/jpeg";
        let description = b"cover";

        let mut block = Vec::new();
        block.extend_from_slice(&3u32.to_be_bytes()); // picture_type = 3 (Cover Front)
        block.extend_from_slice(&(mime.len() as u32).to_be_bytes());
        block.extend_from_slice(mime);
        block.extend_from_slice(&(description.len() as u32).to_be_bytes());
        block.extend_from_slice(description);
        block.extend_from_slice(&0u32.to_be_bytes()); // width
        block.extend_from_slice(&0u32.to_be_bytes()); // height
        block.extend_from_slice(&0u32.to_be_bytes()); // color depth
        block.extend_from_slice(&0u32.to_be_bytes()); // indexed colors
        block.extend_from_slice(&(jpeg.len() as u32).to_be_bytes());
        block.extend_from_slice(&jpeg);

        let cleaned = clean_flac_picture_block(&block)
            .expect("must successfully clean a valid JPEG picture block");

        // Re-parse the cleaned block to pull out just the image bytes.
        let mime_len = u32::from_be_bytes(cleaned[4..8].try_into().unwrap()) as usize;
        let desc_len_start = 8 + mime_len;
        let desc_len = u32::from_be_bytes(
            cleaned[desc_len_start..desc_len_start + 4]
                .try_into()
                .unwrap(),
        ) as usize;
        let data_len_start = desc_len_start + 4 + desc_len + 16;
        let img_data_len = u32::from_be_bytes(
            cleaned[data_len_start..data_len_start + 4]
                .try_into()
                .unwrap(),
        ) as usize;
        let img_start = data_len_start + 4;
        let cleaned_image = &cleaned[img_start..img_start + img_data_len];

        assert_ne!(
            cleaned_image,
            jpeg.as_slice(),
            "the embedded image bytes must actually change (EXIF removed)"
        );
        assert_eq!(
            &cleaned_image[0..2],
            &[0xFFu8, 0xD8],
            "the cleaned picture must still be a valid-looking JPEG (SOI marker)"
        );
    }

    #[test]
    fn test_analyze_flac_garbage_bytes_no_panic() {
        let dir = temp_dir("flac_garbage");
        let path = dir.join("garbage.flac");
        fs::write(&path, vec![0xFFu8; 128]).unwrap();

        let _ = analyze_flac(&path);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_analyze_ogg_garbage_bytes_no_panic() {
        let dir = temp_dir("ogg_garbage");
        let path = dir.join("garbage.ogg");
        fs::write(&path, vec![0xFFu8; 128]).unwrap();

        // Hand-constructing a valid Ogg page (with correct CRC32 framing) for a
        // full round-trip test isn't worth the complexity here — analyze_ogg and
        // strip_ogg share the exact same lofty-backed implementation as FLAC
        // (test_flac_tag_roundtrip above), so the untested surface is narrowly
        // just Ogg's own container parsing, not this file's logic.
        let _ = analyze_ogg(&path);

        let _ = fs::remove_file(path);
    }
}

// --- END OF FILE cleaner/media/vorbis.rs ---
