// --- START OF FILE cleaner/media/mp4.rs ---
//
// MP4 / MOV (ISO-BMFF / QuickTime) video metadata handler. No maintained
// Rust crate exposes the GPS-bearing QuickTime `©xyz` atom or the iTunes-
// style `ilst` metadata list mainstream encoders (HandBrake, ffmpeg, iTunes)
// actually write, so this is a small, purpose-built box/atom walker rather
// than a general MP4 library.
//
// SAFETY PRINCIPLE: only ever redact payload bytes in place — never resize,
// remove, or reorder a box. That keeps every parent box's declared size and
// the file's overall byte layout self-consistent without needing to rewrite
// (and risk corrupting) the whole container, which matters a lot more here
// than for a JPEG or PDF since a video is much harder to re-shoot.

use super::super::{CleaningOptions, MetadataEntry, MetadataReport};
use anyhow::Result;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

// ═══════════════════════════════════════════════════════════════════════════
// MP4 / MOV (ISO-BMFF / QUICKTIME) VIDEO METADATA HANDLER
// ═══════════════════════════════════════════════════════════════════════════
// No maintained Rust crate exposes the GPS-bearing QuickTime `©xyz` atom (the
// audio-tagging libraries that cover MP4 only see the iTunes `ilst` metadata
// list, not classic `udta` QuickTime string atoms), so this is a small,
// targeted box/atom walker rather than a general MP4 library.
//
// SAFETY PRINCIPLE: only ever redact payload bytes in place — never resize,
// remove, or reorder a box. That keeps every parent box's declared size and
// the file's overall byte layout self-consistent without needing to rewrite
// (and risk corrupting) the whole container, which matters a lot more here
// than for a JPEG or PDF since a video is much harder to re-shoot.
//
// Known limitation: this only covers the classic `moov > udta > ©xxx` atoms
// (used by iPhones and most QuickTime-derived tools), not the newer
// `meta/keys/ilst` metadata scheme some devices use instead.

/// Absolute file-offset location of one box's header/payload.
struct Mp4Box {
    box_type: [u8; 4],
    /// Absolute offset where the box's header (size+type, +largesize if any) starts.
    header_offset: u64,
    /// Absolute offset where the box's payload starts (just after the header).
    payload_offset: u64,
    payload_len: u64,
}

const MP4_CONTAINER_BOXES: &[&[u8; 4]] = &[b"moov", b"trak", b"mdia", b"udta", b"minf", b"stbl"];

/// QuickTime `udta` string atoms that reveal the device/software that shot
/// or exported the file — comment, encoder, writer, artist/author.
const MP4_AUTHOR_ATOMS: &[&[u8; 4]] = &[
    b"\xa9mak", b"\xa9mod", b"\xa9swr", b"\xa9aut", b"\xa9ART", b"\xa9cmt", b"\xa9wrt", b"\xa9enc",
];

/// iTunes-style metadata atoms (children of `udta > meta > ilst`) that
/// reveal people/organizations. This is a completely separate byte format
/// from `MP4_AUTHOR_ATOMS` above — each of these is a container holding one
/// nested `data` box, not a bare length-prefixed string — and is what
/// mainstream encoders (HandBrake, ffmpeg, iTunes) actually write, unlike
/// the classic QuickTime `udta` string atoms most tools no longer use.
/// Title (`©nam`), genre (`©gen`), and the encoding tool (`©too`) are
/// deliberately excluded, matching the "keep non-identifying fields" policy
/// used for audio (Title/Genre/Track survive; only author-ish fields are
/// swept).
const MP4_ILST_AUTHOR_ATOMS: &[&[u8; 4]] = &[
    b"\xa9ART", b"aART", b"\xa9wrt", b"\xa9cmt", b"desc", b"ldes", b"cprt",
];

/// Reads one box header at `offset`, returning its info and the offset just
/// past it (i.e. where the *next* sibling box would start, if this box's
/// declared size is honored — the caller advances by `payload_len` instead
/// to walk correctly).
fn read_mp4_box_header(file: &mut File, offset: u64, range_end: u64) -> Result<Option<Mp4Box>> {
    if offset + 8 > range_end {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut header = [0u8; 8];
    file.read_exact(&mut header)?;
    let mut size = u32::from_be_bytes(header[0..4].try_into().unwrap()) as u64;
    let box_type: [u8; 4] = header[4..8].try_into().unwrap();

    let mut payload_offset = offset + 8;
    if size == 1 {
        if payload_offset + 8 > range_end {
            return Ok(None);
        }
        let mut ext = [0u8; 8];
        file.read_exact(&mut ext)?;
        size = u64::from_be_bytes(ext);
        payload_offset += 8;
    } else if size == 0 {
        size = range_end - offset;
    }

    let header_len = payload_offset - offset;
    if size < header_len || offset + size > range_end {
        // Malformed/truncated box — don't read out of bounds or loop forever.
        return Ok(None);
    }

    Ok(Some(Mp4Box {
        box_type,
        header_offset: offset,
        payload_offset,
        payload_len: size - header_len,
    }))
}

/// Reads a QuickTime string atom's payload (2-byte length + 2-byte language
/// code + UTF-8 text) and returns just the text.
fn read_mp4_qt_string(file: &mut File, b: &Mp4Box) -> Result<Option<String>> {
    if b.payload_len < 4 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(b.payload_offset))?;
    let mut prefix = [0u8; 2];
    file.read_exact(&mut prefix)?;
    let text_len = u16::from_be_bytes(prefix) as u64;
    if text_len == 0 || 4 + text_len > b.payload_len {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(b.payload_offset + 4))?;
    let mut text = vec![0u8; text_len as usize];
    file.read_exact(&mut text)?;
    Ok(Some(String::from_utf8_lossy(&text).into_owned()))
}

/// Zeroes an entire box payload in place (length prefix included, for
/// QuickTime string atoms — a zero length reads back as an empty string,
/// which every reader tolerates).
fn redact_mp4_box_payload(file: &mut File, b: &Mp4Box) -> Result<()> {
    file.seek(SeekFrom::Start(b.payload_offset))?;
    file.write_all(&vec![0u8; b.payload_len as usize])?;
    Ok(())
}

/// Locates the single `data` box nested inside an iTunes-style `ilst` item
/// atom (e.g. `©nam`, `©ART`): 4-byte size + 4-byte type "data" + 4-byte
/// type-indicator + 4-byte locale, followed by the actual value bytes.
fn read_mp4_ilst_data_box(file: &mut File, item: &Mp4Box) -> Result<Option<Mp4Box>> {
    let data_box = read_mp4_box_header(file, item.payload_offset, item.payload_offset + item.payload_len)?;
    match data_box {
        Some(b) if &b.box_type == b"data" && b.payload_len >= 8 => Ok(Some(b)),
        _ => Ok(None),
    }
}

/// Reads an iTunes-style `ilst` item atom's text value out of its nested
/// `data` box (skipping that box's own 8-byte type-indicator+locale header).
fn read_mp4_ilst_text(file: &mut File, item: &Mp4Box) -> Result<Option<String>> {
    let Some(data_box) = read_mp4_ilst_data_box(file, item)? else {
        return Ok(None);
    };
    let value_offset = data_box.payload_offset + 8;
    let value_len = data_box.payload_len - 8;
    file.seek(SeekFrom::Start(value_offset))?;
    let mut buf = vec![0u8; value_len as usize];
    file.read_exact(&mut buf)?;
    if buf.iter().all(|&byte| byte == 0) {
        // Redaction zeroes only the value bytes, not the `data` box's own
        // size field (never resizing a box, matching the redactor's
        // never-resize policy) — an all-zero value is what "already
        // redacted" looks like on re-read, same as a classic QuickTime
        // string atom's zeroed length prefix naturally reading as empty.
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Zeroes just the value bytes of an `ilst` item atom's nested `data` box,
/// leaving the box's own type-indicator/locale header untouched.
fn redact_mp4_ilst_value(file: &mut File, item: &Mp4Box) -> Result<()> {
    let Some(data_box) = read_mp4_ilst_data_box(file, item)? else {
        return Ok(());
    };
    let value_offset = data_box.payload_offset + 8;
    let value_len = data_box.payload_len - 8;
    file.seek(SeekFrom::Start(value_offset))?;
    file.write_all(&vec![0u8; value_len as usize])?;
    Ok(())
}

/// Zeroes just the creation_time/modification_time fields of an `mvhd` or
/// `tkhd` box, leaving the rest (timescale, duration, matrix, etc. — all
/// required for playback) untouched.
fn redact_mp4_header_times(file: &mut File, b: &Mp4Box) -> Result<()> {
    if b.payload_len < 4 {
        return Ok(());
    }
    file.seek(SeekFrom::Start(b.payload_offset))?;
    let mut version = [0u8; 1];
    file.read_exact(&mut version)?;

    let times_len: u64 = if version[0] == 1 { 16 } else { 8 }; // 2×8 bytes vs 2×4 bytes
    if 4 + times_len > b.payload_len {
        return Ok(());
    }
    file.seek(SeekFrom::Start(b.payload_offset + 4))?;
    file.write_all(&vec![0u8; times_len as usize])?;
    Ok(())
}

/// Human-readable label for an `ilst` item atom, or `None` for ones we don't
/// surface (e.g. binary atoms like `covr`/`gnre` aren't text).
fn mp4_ilst_label(box_type: &[u8; 4]) -> Option<&'static str> {
    match box_type {
        b"\xa9nam" => Some("Title"),
        b"\xa9ART" => Some("Performer"),
        b"aART" => Some("Album Artist"),
        b"\xa9alb" => Some("Album"),
        b"\xa9wrt" => Some("Writer/Composer"),
        b"\xa9cmt" => Some("Comment"),
        b"desc" => Some("Description"),
        b"ldes" => Some("Long Description"),
        b"cprt" => Some("Copyright"),
        b"\xa9day" => Some("Recorded Date"),
        b"\xa9gen" => Some("Genre"),
        b"\xa9too" => Some("Writing Application"),
        _ => None,
    }
}

fn scan_mp4_boxes(
    file: &mut File,
    start: u64,
    end: u64,
    in_ilst: bool,
    report: &mut MetadataReport,
) -> Result<()> {
    let mut pos = start;
    while let Some(b) = read_mp4_box_header(file, pos, end)? {
        if in_ilst {
            if let Some(label) = mp4_ilst_label(&b.box_type) {
                if let Some(text) = read_mp4_ilst_text(file, &b)? {
                    if MP4_ILST_AUTHOR_ATOMS.contains(&&b.box_type) {
                        report.has_author = true;
                    }
                    if &b.box_type == b"\xa9day" {
                        report.creation_date.get_or_insert_with(|| text.clone());
                    }
                    report.raw_tags.push(MetadataEntry {
                        key: label.into(),
                        value: text,
                    });
                }
            }
        } else if &b.box_type == b"\xa9xyz" {
            if let Some(loc) = read_mp4_qt_string(file, &b)? {
                report.has_gps = true;
                report.gps_info = Some(loc.clone());
                report.raw_tags.push(MetadataEntry {
                    key: "GPS Location (ISO 6709)".into(),
                    value: loc,
                });
            }
        } else if &b.box_type == b"\xa9day" {
            if let Some(date) = read_mp4_qt_string(file, &b)? {
                report.creation_date.get_or_insert_with(|| date.clone());
                report.raw_tags.push(MetadataEntry {
                    key: "Creation Date".into(),
                    value: date,
                });
            }
        } else if MP4_AUTHOR_ATOMS.contains(&&b.box_type) {
            if let Some(text) = read_mp4_qt_string(file, &b)? {
                report.has_author = true;
                let label = match &b.box_type {
                    b"\xa9mak" => "Camera Make",
                    b"\xa9mod" => "Camera Model",
                    b"\xa9swr" => "Software",
                    b"\xa9enc" => "Encoded By",
                    b"\xa9cmt" => "Comment",
                    b"\xa9wrt" => "Writer",
                    _ => "Artist/Author",
                };
                if label == "Camera Make" || label == "Camera Model" {
                    let existing = report.camera_info.take().unwrap_or_default();
                    let sep = if existing.is_empty() { "" } else { " " };
                    report.camera_info = Some(format!("{existing}{sep}{text}"));
                }
                report.raw_tags.push(MetadataEntry {
                    key: label.into(),
                    value: text,
                });
            }
        }

        if &b.box_type == b"meta" {
            // The `meta` box (ISO 14496-12 full box) has a 4-byte
            // version+flags prefix before its child boxes begin — every
            // mainstream modern encoder (HandBrake, ffmpeg, iTunes) writes
            // this ISO form, unlike QuickTime's older headerless variant.
            if b.payload_len >= 4 {
                scan_mp4_boxes(
                    file,
                    b.payload_offset + 4,
                    b.payload_offset + b.payload_len,
                    false,
                    report,
                )?;
            }
        } else if &b.box_type == b"ilst" {
            scan_mp4_boxes(
                file,
                b.payload_offset,
                b.payload_offset + b.payload_len,
                true,
                report,
            )?;
        } else if MP4_CONTAINER_BOXES.contains(&&b.box_type) {
            scan_mp4_boxes(
                file,
                b.payload_offset,
                b.payload_offset + b.payload_len,
                false,
                report,
            )?;
        }

        pos = b.header_offset + (b.payload_offset - b.header_offset) + b.payload_len;
    }
    Ok(())
}

fn redact_mp4_boxes(
    file: &mut File,
    start: u64,
    end: u64,
    in_ilst: bool,
    options: &CleaningOptions,
) -> Result<()> {
    let mut pos = start;
    while let Some(b) = read_mp4_box_header(file, pos, end)? {
        if in_ilst {
            let should_redact = (options.date && &b.box_type == b"\xa9day")
                || (options.author && MP4_ILST_AUTHOR_ATOMS.contains(&&b.box_type));
            if should_redact {
                redact_mp4_ilst_value(file, &b)?;
            }
        } else {
            let is_targeted_string_atom = (options.gps && &b.box_type == b"\xa9xyz")
                || (options.date && &b.box_type == b"\xa9day")
                || (options.author && MP4_AUTHOR_ATOMS.contains(&&b.box_type));

            if is_targeted_string_atom {
                redact_mp4_box_payload(file, &b)?;
            } else if options.date && (&b.box_type == b"mvhd" || &b.box_type == b"tkhd") {
                redact_mp4_header_times(file, &b)?;
            }
        }

        if &b.box_type == b"meta" {
            if b.payload_len >= 4 {
                redact_mp4_boxes(
                    file,
                    b.payload_offset + 4,
                    b.payload_offset + b.payload_len,
                    false,
                    options,
                )?;
            }
        } else if &b.box_type == b"ilst" {
            redact_mp4_boxes(
                file,
                b.payload_offset,
                b.payload_offset + b.payload_len,
                true,
                options,
            )?;
        } else if MP4_CONTAINER_BOXES.contains(&&b.box_type) {
            redact_mp4_boxes(
                file,
                b.payload_offset,
                b.payload_offset + b.payload_len,
                false,
                options,
            )?;
        }

        pos = b.header_offset + (b.payload_offset - b.header_offset) + b.payload_len;
    }
    Ok(())
}

pub(in crate::cleaner) fn analyze_mp4(path: &Path) -> Result<MetadataReport> {
    let file_size = fs::metadata(path)?.len();

    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "MP4/MOV Video".to_string(),
        file_size,
        raw_tags: Vec::new(),
        app_info: None,
    };

    let mut file = File::open(path)?;
    // Errors here mean "not a box we understand" — same policy as every other
    // analyzer in this file: report what was found, don't fail the whole scan.
    let _ = scan_mp4_boxes(&mut file, 0, file_size, false, &mut report);

    Ok(report)
}

pub(in crate::cleaner) fn strip_mp4(input: &Path, output: &Path, options: &CleaningOptions) -> Result<()> {
    fs::copy(input, output)?;
    let file_size = fs::metadata(output)?.len();

    let mut file = fs::OpenOptions::new().read(true).write(true).open(output)?;
    redact_mp4_boxes(&mut file, 0, file_size, false, options)?;

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

    // ─── MP4 / MOV ─────────────────────────────────────────────────────────

    /// Builds one ISO-BMFF/QuickTime box: 4-byte big-endian size + 4-byte
    /// type + payload.
    fn mp4_box(box_type: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut b = Vec::new();
        let size = (8 + payload.len()) as u32;
        b.extend_from_slice(&size.to_be_bytes());
        b.extend_from_slice(box_type);
        b.extend_from_slice(payload);
        b
    }

    /// Builds a QuickTime string atom payload: 2-byte length + 2-byte
    /// language code (0 = unspecified) + UTF-8 text.
    fn qt_string_payload(text: &str) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&(text.len() as u16).to_be_bytes());
        p.extend_from_slice(&0u16.to_be_bytes());
        p.extend_from_slice(text.as_bytes());
        p
    }

    /// Builds a minimal but structurally valid `moov` tree: an `mvhd` (version
    /// 0, with a marker byte pattern past the timestamp fields so the test can
    /// confirm redaction doesn't touch anything beyond them) plus a `udta`
    /// holding GPS, date, and camera-make atoms.
    fn write_minimal_mp4(path: &PathBuf) {
        let mut mvhd_payload = vec![0xAAu8; 100];
        mvhd_payload[0] = 0; // version 0 -> 32-bit creation/modification time fields
        mvhd_payload[4..8].copy_from_slice(&0x11111111u32.to_be_bytes()); // creation_time
        mvhd_payload[8..12].copy_from_slice(&0x22222222u32.to_be_bytes()); // modification_time
        let mvhd = mp4_box(b"mvhd", &mvhd_payload);

        let xyz = mp4_box(b"\xa9xyz", &qt_string_payload("+37.3319-122.0312+000.000/"));
        let day = mp4_box(b"\xa9day", &qt_string_payload("2024-01-15T10:30:00Z"));
        let mak = mp4_box(b"\xa9mak", &qt_string_payload("Apple"));

        let mut udta_payload = Vec::new();
        udta_payload.extend_from_slice(&xyz);
        udta_payload.extend_from_slice(&day);
        udta_payload.extend_from_slice(&mak);
        let udta = mp4_box(b"udta", &udta_payload);

        let mut moov_payload = Vec::new();
        moov_payload.extend_from_slice(&mvhd);
        moov_payload.extend_from_slice(&udta);
        let moov = mp4_box(b"moov", &moov_payload);

        fs::write(path, moov).unwrap();
    }

    #[test]
    fn test_analyze_mp4_reads_gps_date_and_camera_info() {
        let dir = temp_dir("mp4_analyze");
        let path = dir.join("video.mp4");
        write_minimal_mp4(&path);

        let report = analyze_mp4(&path).unwrap();
        assert!(report.has_gps, "GPS atom must be detected");
        assert_eq!(
            report.gps_info.as_deref(),
            Some("+37.3319-122.0312+000.000/")
        );
        assert!(report.has_author, "camera make must count as author info");
        assert_eq!(report.camera_info.as_deref(), Some("Apple"));
        assert_eq!(
            report.creation_date.as_deref(),
            Some("2024-01-15T10:30:00Z")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_strip_mp4_redacts_gps_but_preserves_box_structure() {
        let dir = temp_dir("mp4_strip");
        let input = dir.join("in.mp4");
        let output = dir.join("out.mp4");
        write_minimal_mp4(&input);
        let original_len = fs::metadata(&input).unwrap().len();

        let options = CleaningOptions {
            gps: true,
            author: false,
            date: false,
            remove_cover_art: false,
        };
        strip_mp4(&input, &output, &options).unwrap();

        // Redaction must never resize the file — same box layout, just
        // zeroed payload bytes.
        assert_eq!(
            fs::metadata(&output).unwrap().len(),
            original_len,
            "redaction must not change the file size"
        );

        let report = analyze_mp4(&output).unwrap();
        assert!(!report.has_gps, "GPS atom must be gone after stripping");
        // Author/date were NOT requested — must survive untouched.
        assert!(
            report.has_author,
            "author info must survive when not requested"
        );
        assert_eq!(
            report.creation_date.as_deref(),
            Some("2024-01-15T10:30:00Z")
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_mp4_date_redacts_mvhd_times_only() {
        let dir = temp_dir("mp4_strip_date");
        let input = dir.join("in.mp4");
        let output = dir.join("out.mp4");
        write_minimal_mp4(&input);

        let options = CleaningOptions {
            gps: false,
            author: false,
            date: true,
            remove_cover_art: false,
        };
        strip_mp4(&input, &output, &options).unwrap();

        let bytes = fs::read(&output).unwrap();
        // mvhd payload starts right after the moov(8) + mvhd(8) headers.
        let mvhd_payload_start = 8 + 8;
        assert_eq!(
            &bytes[mvhd_payload_start + 4..mvhd_payload_start + 12],
            &[0u8; 8],
            "creation_time and modification_time must be zeroed"
        );
        assert_eq!(
            &bytes[mvhd_payload_start + 12..mvhd_payload_start + 100],
            &vec![0xAAu8; 88][..],
            "bytes past the timestamp fields (timescale, duration, matrix...) must be untouched"
        );

        // ©day (date) must be gone; ©xyz (gps) was not requested and must survive.
        let report = analyze_mp4(&output).unwrap();
        assert!(report.creation_date.is_none(), "©day must be redacted");
        assert!(
            report.has_gps,
            "GPS must survive when date-only was requested"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    /// Builds an iTunes-style `ilst` item atom: the box wraps a single
    /// `data` box (4-byte type-indicator + 4-byte locale, both zero here,
    /// then the UTF-8 text) — a completely different layout from the
    /// classic QuickTime string atoms `qt_string_payload` builds above.
    fn ilst_item(box_type: &[u8; 4], text: &str) -> Vec<u8> {
        let mut data_payload = Vec::new();
        data_payload.extend_from_slice(&1u32.to_be_bytes()); // type indicator: UTF-8 text
        data_payload.extend_from_slice(&0u32.to_be_bytes()); // locale
        data_payload.extend_from_slice(text.as_bytes());
        let data_box = mp4_box(b"data", &data_payload);
        mp4_box(box_type, &data_box)
    }

    /// Builds a `moov > udta > meta > ilst` tree matching what mainstream
    /// encoders (HandBrake, ffmpeg, iTunes) actually write — as opposed to
    /// `write_minimal_mp4`'s classic QuickTime `udta` string atoms, which
    /// virtually nothing produces anymore.
    fn write_ilst_mp4(path: &PathBuf) {
        let mut mvhd_payload = vec![0u8; 100];
        mvhd_payload[0] = 0;
        let mvhd = mp4_box(b"mvhd", &mvhd_payload);

        let nam = ilst_item(b"\xa9nam", "Who Is America - S01E01");
        let art = ilst_item(b"\xa9ART", "Sacha Baron Cohen");
        let aart = ilst_item(b"aART", "Sacha Baron Cohen, Payman Benz");
        let day = ilst_item(b"\xa9day", "2018-07-15");
        let gen = ilst_item(b"\xa9gen", "Mockumentary");
        let too = ilst_item(b"\xa9too", "HandBrake 1.1.0 2018042400");
        let ldes = ilst_item(b"ldes", "Featuring Bernie Sanders and others.");

        let mut ilst_payload = Vec::new();
        for item in [&nam, &art, &aart, &day, &gen, &too, &ldes] {
            ilst_payload.extend_from_slice(item);
        }
        let ilst = mp4_box(b"ilst", &ilst_payload);

        // The `meta` full-box has a 4-byte version+flags prefix before its
        // children — this is the part `write_minimal_mp4` never exercises.
        let mut meta_payload = vec![0u8; 4];
        meta_payload.extend_from_slice(&ilst);
        let meta = mp4_box(b"meta", &meta_payload);

        let udta = mp4_box(b"udta", &meta);

        let mut moov_payload = Vec::new();
        moov_payload.extend_from_slice(&mvhd);
        moov_payload.extend_from_slice(&udta);
        let moov = mp4_box(b"moov", &moov_payload);

        fs::write(path, moov).unwrap();
    }

    #[test]
    fn test_analyze_mp4_reads_itunes_style_ilst_metadata() {
        // Regression test for a real HandBrake-encoded file where "nothing"
        // got cleaned: the box walker never recursed into `meta` at all
        // (missing from MP4_CONTAINER_BOXES, plus meta's own +4 version
        // prefix) and had no concept of ilst's data-box-wrapped values —
        // so every field a mainstream encoder actually writes was invisible.
        let dir = temp_dir("mp4_ilst_analyze");
        let path = dir.join("video.mp4");
        write_ilst_mp4(&path);

        let report = analyze_mp4(&path).unwrap();
        assert!(report.has_author, "raw_tags: {:?}", report.raw_tags);
        assert_eq!(report.creation_date.as_deref(), Some("2018-07-15"));

        let expect = |key: &str, value: &str| {
            assert!(
                report.raw_tags.iter().any(|t| t.key == key && t.value == value),
                "missing {key}={value:?} in raw_tags: {:?}",
                report.raw_tags
            );
        };
        expect("Title", "Who Is America - S01E01");
        expect("Performer", "Sacha Baron Cohen");
        expect("Album Artist", "Sacha Baron Cohen, Payman Benz");
        expect("Recorded Date", "2018-07-15");
        expect("Genre", "Mockumentary");
        expect("Writing Application", "HandBrake 1.1.0 2018042400");
        expect("Long Description", "Featuring Bernie Sanders and others.");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_strip_mp4_removes_ilst_author_fields_keeps_title_genre_and_tool() {
        let dir = temp_dir("mp4_ilst_strip");
        let input = dir.join("in.mp4");
        let output = dir.join("out.mp4");
        write_ilst_mp4(&input);

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: true,
            remove_cover_art: false,
        };
        strip_mp4(&input, &output, &options).unwrap();

        let after = analyze_mp4(&output).unwrap();
        assert!(!after.has_author, "raw_tags: {:?}", after.raw_tags);
        assert!(after.creation_date.is_none(), "raw_tags: {:?}", after.raw_tags);
        for key in ["Performer", "Album Artist", "Recorded Date", "Long Description"] {
            assert!(
                !after.raw_tags.iter().any(|t| t.key == key),
                "{} must be cleared, raw_tags: {:?}",
                key,
                after.raw_tags
            );
        }
        // Non-identifying fields must be untouched.
        let title = after.raw_tags.iter().find(|t| t.key == "Title").unwrap();
        assert_eq!(title.value, "Who Is America - S01E01");
        let genre = after.raw_tags.iter().find(|t| t.key == "Genre").unwrap();
        assert_eq!(genre.value, "Mockumentary");
        let tool = after
            .raw_tags
            .iter()
            .find(|t| t.key == "Writing Application")
            .unwrap();
        assert_eq!(tool.value, "HandBrake 1.1.0 2018042400");

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_analyze_mp4_garbage_bytes_no_panic() {
        let dir = temp_dir("mp4_garbage");
        let path = dir.join("garbage.mp4");
        fs::write(&path, vec![0xFFu8; 200]).unwrap();

        let _ = analyze_mp4(&path);
        let _ = fs::create_dir_all(&dir); // no-op if it already exists
        let output = dir.join("garbage_out.mp4");
        let options = CleaningOptions {
            gps: true,
            author: true,
            date: true,
            remove_cover_art: false,
        };
        // Must not panic, hang, or read/write out of bounds on malformed input.
        let _ = strip_mp4(&path, &output, &options);

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(output);
    }
}

// --- END OF FILE cleaner/media/mp4.rs ---
