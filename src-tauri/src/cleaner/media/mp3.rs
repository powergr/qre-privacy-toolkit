// --- START OF FILE cleaner/media/mp3.rs ---
//
// MP3 metadata handler: ID3v1/ID3v2 tags plus APEv2 — a second, separate
// tag container some tools append after the audio stream alongside ID3v2.

use super::super::documents::strip_embedded_image_bytes;
use super::super::{CleaningOptions, MetadataEntry, MetadataReport};
use anyhow::{anyhow, Result};
use std::fs;
use std::path::Path;

// ═══════════════════════════════════════════════════════════════════════════
// MP3 / ID3 AUDIO METADATA HANDLER
// ═══════════════════════════════════════════════════════════════════════════
use id3::TagLike;

pub(in crate::cleaner) fn analyze_mp3(path: &Path) -> Result<MetadataReport> {
    let file_size = fs::metadata(path)?.len();

    let mut report = MetadataReport {
        has_gps: false,
        has_author: false,
        camera_info: None,
        software_info: None,
        creation_date: None,
        gps_info: None,
        file_type: "MP3 Audio".to_string(),
        file_size,
        raw_tags: Vec::new(),
        app_info: None,
    };

    // ID3v2 — variable-length tag, usually at the start of the file.
    if let Ok(tag) = id3::Tag::read_from_path(path) {
        if let Some(title) = tag.title() {
            report.raw_tags.push(MetadataEntry {
                key: "Title".into(),
                value: title.to_string(),
            });
        }
        if let Some(artist) = tag.artist() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Artist".into(),
                value: artist.to_string(),
            });
        }
        if let Some(album_artist) = tag.album_artist() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Album Artist".into(),
                value: album_artist.to_string(),
            });
        }
        if let Some(album) = tag.album() {
            report.raw_tags.push(MetadataEntry {
                key: "Album".into(),
                value: album.to_string(),
            });
        }
        if let Some(year) = tag.year() {
            let year_str = year.to_string();
            report.creation_date = Some(year_str.clone());
            report.raw_tags.push(MetadataEntry {
                key: "Year".into(),
                value: year_str,
            });
        }
        if let Some(date) = tag.date_recorded() {
            let date_str = date.to_string();
            report.creation_date.get_or_insert_with(|| date_str.clone());
            report.raw_tags.push(MetadataEntry {
                key: "Date Recorded".into(),
                value: date_str,
            });
        }
        for comment in tag.comments() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: format!("Comment ({})", comment.description),
                value: comment.text.clone(),
            });
        }
        // Encoder/device signatures and free-form tags often reveal what
        // software or hardware recorded/ripped the file.
        if tag.get("TENC").is_some() || tag.get("TXXX").is_some() || tag.get("PRIV").is_some() {
            report.has_author = true;
        }
        let picture_count = tag.pictures().count();
        if picture_count > 0 {
            report.raw_tags.push(MetadataEntry {
                key: "Embedded Cover Art".into(),
                value: format!(
                    "{} image(s) — may carry its own EXIF/GPS data",
                    picture_count
                ),
            });
        }
    }

    // ID3v1 — legacy fixed-width tag in the last 128 bytes. Some tools that
    // only clean ID3v2 leave this behind, so it's checked independently.
    if let Ok(v1) = id3::v1::Tag::read_from_path(path) {
        if !v1.artist.trim().is_empty() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Artist (ID3v1)".into(),
                value: v1.artist.clone(),
            });
        }
        if !v1.comment.trim().is_empty() {
            report.has_author = true;
            report.raw_tags.push(MetadataEntry {
                key: "Comment (ID3v1)".into(),
                value: v1.comment.clone(),
            });
        }
        if !v1.year.trim().is_empty() {
            report.creation_date.get_or_insert_with(|| v1.year.clone());
            report.raw_tags.push(MetadataEntry {
                key: "Year (ID3v1)".into(),
                value: v1.year.clone(),
            });
        }
    }

    // APEv2 — a completely separate tag container some tools (notably scene
    // "release group" taggers) append after the audio stream, alongside
    // ID3v2. Its fields are entirely free-form, similar to Vorbis comments,
    // and this is invisible to ID3-only tools — including this one, until
    // this block was added — which is why fields like ENCODERSETTINGS or
    // WWWAUDIOFILE could survive an "author" clean untouched.
    if let Ok(ape_tag) = ape::read_from_path(path) {
        for item in ape_tag.iter() {
            let upper = item.key.to_ascii_uppercase();
            if !APE_SAFE_KEYS.contains(&upper.as_str()) {
                report.has_author = true;
            }
            let value: String = match <&str>::try_from(item) {
                Ok(s) => s.to_string(),
                Err(_) => match <Vec<&str>>::try_from(item) {
                    Ok(values) => values.join(", "),
                    Err(_) => "(binary data)".to_string(),
                },
            };
            report.raw_tags.push(MetadataEntry {
                key: format!("{} (APEv2)", item.key),
                value,
            });
        }
    }

    Ok(report)
}

// APEv2 item keys that carry no personal/identifying information, kept
// as-is when `options.author` strips everything else. Comparison is
// case-insensitive since APEv2 keys aren't case-normalized by convention.
// "Media" (storage media type, e.g. CD/Vinyl) was deliberately left off this
// list: real-world taggers abuse it to carry branding text instead of an
// actual media type (MediaInfo surfaces it under the label "Type"), so it
// isn't safe to assume it's harmless the way track/disc/genre/title/album are.
const APE_SAFE_KEYS: &[&str] = &["TRACK", "DISC", "GENRE", "TITLE", "ALBUM"];

/// Selectively strips ID3 metadata from an MP3. ID3v2 frames are removed one
/// by one so unrelated fields (track number, genre, cover art) survive; the
/// ID3v1 trailer's fixed-width fields can't be edited piecemeal through this
/// crate, so it's removed outright whenever *any* personal-data option is on.
pub(in crate::cleaner) fn strip_mp3(input: &Path, output: &Path, options: &CleaningOptions) -> Result<()> {
    fs::copy(input, output)?;

    if let Ok(mut tag) = id3::Tag::read_from_path(output) {
        if options.author {
            for id in [
                "TPE1", "TPE2", "TPE3", "TPE4", "TCOM", "TEXT", "TPUB", "TCOP", "TENC", "COMM",
                "USLT", "WXXX", "WOAR", "TXXX", "PRIV",
                // TIT1 (Grouping) and TCMP (iTunes Compilation flag) are
                // sometimes abused by taggers to carry branding text rather
                // than their nominal meaning. TSRC (ISRC) and the WOAF/WOAS
                // URL frames (distinct from WOAR, the artist-webpage frame
                // already above) were an outright gap — a real file with an
                // "Official audio file webpage" / "Official audio source
                // webpage" pair survived cleaning entirely until this fix.
                // TMED (Media type) is the ID3v2 sibling of the APEv2 "Media"
                // field handled below — same abuse pattern, same fix.
                "TIT1", "TCMP", "TSRC", "WOAF", "WOAS", "TMED",
                // TIPL (Involved People List, IPLS pre-2.4) names specific
                // people/roles and was an outright gap.
                "TIPL", "IPLS",
            ] {
                tag.remove(id);
            }
        }
        if options.date {
            for id in [
                "TDRC", "TYER", "TDAT", "TIME", "TDEN", "TDTG", "TORY", "TDOR",
            ] {
                tag.remove(id);
            }
        }

        if options.remove_cover_art {
            // Cleaning a picture's EXIF only removes metadata *inside* it —
            // it can't remove the picture's own visual content (a face, a
            // location in the shot). If the user wants cover art gone, drop
            // it outright rather than just scrubbing its metadata.
            tag.remove_all_pictures();
        } else if options.gps || options.author || options.date {
            // Otherwise, still clean any EXIF/GPS embedded *in* the cover art
            // (e.g. a phone photo used as album art), keeping any picture
            // this tool can't clean as-is rather than dropping it.
            let updated_pictures: Vec<id3::frame::Picture> = tag
                .pictures()
                .map(
                    |pic| match strip_embedded_image_bytes(pic.data.clone(), &pic.mime_type) {
                        Some(cleaned_data) => id3::frame::Picture {
                            mime_type: pic.mime_type.clone(),
                            picture_type: pic.picture_type,
                            description: pic.description.clone(),
                            data: cleaned_data,
                        },
                        None => pic.clone(),
                    },
                )
                .collect();
            if !updated_pictures.is_empty() {
                tag.remove_all_pictures();
                for pic in updated_pictures {
                    tag.add_frame(pic);
                }
            }
        }

        tag.write_to_path(output, id3::Version::Id3v24)
            .map_err(|e| anyhow!("Failed to write ID3v2 tag: {}", e))?;
    }

    // ID3v1 and APEv2 trailers can appear in either order depending on the
    // tool that wrote them (`[audio][APEv2][ID3v1]` is conventional, but
    // some taggers write `[audio][ID3v1][APEv2]` instead). Each library can
    // only find its own tag when it's genuinely the last bytes in the file,
    // so a single pass can strip the outer one and leave the inner one
    // stranded mid-file. Two passes catch that: whatever became the new
    // trailing tag after the first pass gets caught on the second.
    //
    // The APEv2 header is added as a separate step *after* this loop, not
    // inside `strip_ape_tag` itself: `ape::remove_from_path` only looks at
    // the footer's own declared size (which by spec excludes the header),
    // so on a second pass it would strip the items+footer written by the
    // first pass but strand the header behind — corrupting exactly the
    // structure this is trying to fix.
    for _ in 0..2 {
        if options.author || options.date {
            let _ = id3::v1::Tag::remove_from_path(output);
        }
        strip_ape_tag(output, options)?;
    }
    add_ape_header(output)?;

    Ok(())
}

/// Cleans (or removes outright) an APEv2 tag block appended after the MP3
/// audio stream. See the comment on the APE-reading block in `analyze_mp3`
/// for why this exists as a separate step from ID3 cleaning above.
fn strip_ape_tag(output: &Path, options: &CleaningOptions) -> Result<()> {
    let mut ape_tag = match ape::read_from_path(output) {
        Ok(tag) => tag,
        // No APE tag on this file, or it's malformed in a way this crate
        // can't parse — either way, there's nothing to clean here, and it
        // shouldn't fail the clean when the ID3 side already succeeded.
        Err(_) => return Ok(()),
    };

    if options.author {
        let keys_to_remove: std::collections::HashSet<String> = ape_tag
            .iter()
            .map(|item| item.key.clone())
            .filter(|k| !APE_SAFE_KEYS.contains(&k.to_ascii_uppercase().as_str()))
            .collect();
        for key in keys_to_remove {
            ape_tag.remove_items(&key);
        }
    }
    if options.date {
        ape_tag.remove_items("Year");
        ape_tag.remove_items("Date");
    }
    if options.remove_cover_art {
        ape_tag.remove_items("Cover Art (Front)");
        ape_tag.remove_items("Cover Art (Back)");
    }

    let has_remaining_items = ape_tag.iter().count() > 0;

    // Always remove the on-disk tag first, whether or not we're about to
    // write a smaller replacement, so any subsequent write always lands on
    // a tag-free file rather than shrinking an existing block in place.
    let _ = ape::remove_from_path(output);

    if has_remaining_items {
        ape::write_to_path(&ape_tag, output)
            .map_err(|e| anyhow!("Failed to write APE tag: {}", e))?;
    }

    Ok(())
}

/// Adds an APEv2 header mirroring the footer `ape::write_to_path` just
/// wrote. See the comment above the call site in `strip_ape_tag`.
fn add_ape_header(output: &Path) -> Result<()> {
    const HAS_HEADER: u32 = 1 << 31;
    const IS_HEADER: u32 = 1 << 29;

    let mut bytes = fs::read(output)?;
    let len = bytes.len();
    if len < 32 || &bytes[len - 32..len - 24] != b"APETAGEX" {
        return Ok(());
    }

    let footer_start = len - 32;
    let version = bytes[footer_start + 8..footer_start + 12].to_vec();
    let tag_size_bytes = bytes[footer_start + 12..footer_start + 16].to_vec();
    let item_count = bytes[footer_start + 16..footer_start + 20].to_vec();
    let tag_size = u32::from_le_bytes(tag_size_bytes.clone().try_into().unwrap());

    // `tag_size` covers items + footer, excluding the header — so the item
    // data (what we need to insert the header *before*) starts here.
    let items_start = footer_start
        .checked_sub((tag_size as usize).saturating_sub(32))
        .ok_or_else(|| anyhow!("APE tag size larger than the file itself"))?;

    let mut header = Vec::with_capacity(32);
    header.extend_from_slice(b"APETAGEX");
    header.extend_from_slice(&version);
    header.extend_from_slice(&tag_size_bytes);
    header.extend_from_slice(&item_count);
    header.extend_from_slice(&(HAS_HEADER | IS_HEADER).to_le_bytes());
    header.extend_from_slice(&[0u8; 8]);

    // The footer must also advertise that a header now precedes it.
    let footer_flags_offset = footer_start + 20;
    bytes[footer_flags_offset..footer_flags_offset + 4].copy_from_slice(&HAS_HEADER.to_le_bytes());

    bytes.splice(items_start..items_start, header);
    fs::write(output, bytes)?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleaner::remove_metadata;
    use std::io::Seek;
    use std::path::PathBuf;

    // Helper: returns (and creates if needed) a dedicated temp dir for a given test
    fn temp_dir(sub: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("qre_cleaner_tests").join(sub);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ─── MP3 / ID3 ─────────────────────────────────────────────────────────

    /// Builds a fake MP3 file (placeholder "audio" bytes, no real MPEG frames —
    /// the id3 crate only cares about the tag region) with an ID3v2 tag set.
    fn write_tagged_mp3(path: &PathBuf, artist: &str, year: i32) {
        fs::write(path, b"FAKE_MPEG_AUDIO_STREAM_PLACEHOLDER_BYTES").unwrap();
        let mut tag = id3::Tag::new();
        tag.set_artist(artist);
        tag.set_year(year);
        tag.add_frame(id3::frame::Comment {
            lang: "eng".to_string(),
            description: "".to_string(),
            text: "ripped on my personal laptop".to_string(),
        });
        tag.write_to_path(path, id3::Version::Id3v24).unwrap();
    }

    #[test]
    fn test_analyze_mp3_reads_id3_tags() {
        let dir = temp_dir("mp3_tagged");
        let path = dir.join("song.mp3");
        write_tagged_mp3(&path, "Test Artist", 2020);

        let report = analyze_mp3(&path).unwrap();
        assert!(
            report.has_author,
            "has_author must be true when an artist/comment frame is present"
        );
        assert!(
            report
                .raw_tags
                .iter()
                .any(|t| t.key == "Artist" && t.value == "Test Artist"),
            "artist must appear in raw_tags, got: {:?}",
            report.raw_tags
        );
        assert_eq!(report.creation_date.as_deref(), Some("2020"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_analyze_mp3_no_tag_has_no_author() {
        let dir = temp_dir("mp3_untagged");
        let path = dir.join("plain.mp3");
        fs::write(&path, b"FAKE_MPEG_AUDIO_STREAM_PLACEHOLDER_BYTES").unwrap();

        let report = analyze_mp3(&path).unwrap();
        assert!(
            !report.has_author,
            "has_author should be false with no ID3 tag present"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_strip_mp3_removes_author_and_date() {
        let dir = temp_dir("mp3_strip");
        let input = dir.join("in.mp3");
        let output = dir.join("out.mp3");
        write_tagged_mp3(&input, "Secret Artist", 2021);

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: true,
            remove_cover_art: false,
        };
        strip_mp3(&input, &output, &options).unwrap();

        let report = analyze_mp3(&output).unwrap();
        assert!(
            !report.has_author,
            "artist/comment frames must be gone after stripping, got: {:?}",
            report.raw_tags
        );
        assert!(
            report.creation_date.is_none(),
            "year frame must be gone after stripping date"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    /// A minimal but structurally valid JPEG (SOI + an APP1 "EXIF-like"
    /// segment + EOI, no real image data) — enough for `img_parts` to parse
    /// segment framing, which is all `strip_jpeg_bytes` needs.
    fn minimal_jpeg_with_app1() -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8]; // SOI
        let app1_payload = b"Exif\0\0fake-exif-payload-marker";
        bytes.extend_from_slice(&[0xFF, 0xE1]);
        bytes.extend_from_slice(&((app1_payload.len() + 2) as u16).to_be_bytes());
        bytes.extend_from_slice(app1_payload);
        bytes.extend_from_slice(&[0xFF, 0xD9]); // EOI
        bytes
    }

    #[test]
    fn test_strip_mp3_recursively_cleans_cover_art() {
        let dir = temp_dir("mp3_cover_art");
        let input = dir.join("in.mp3");
        let output = dir.join("out.mp3");

        fs::write(&input, b"FAKE_MPEG_AUDIO_STREAM_PLACEHOLDER_BYTES").unwrap();
        let mut tag = id3::Tag::new();
        tag.add_frame(id3::frame::Picture {
            mime_type: "image/jpeg".to_string(),
            picture_type: id3::frame::PictureType::CoverFront,
            description: "cover".to_string(),
            data: minimal_jpeg_with_app1(),
        });
        tag.write_to_path(&input, id3::Version::Id3v24).unwrap();

        // Sanity check: the fixture really does carry the APP1 marker before stripping.
        let before = id3::Tag::read_from_path(&input).unwrap();
        let before_pic = before.pictures().next().unwrap();
        assert!(
            before_pic.data.windows(6).any(|w| w == b"Exif\0\0"),
            "fixture must contain the APP1 marker before stripping"
        );

        let options = CleaningOptions {
            gps: true,
            author: false,
            date: false,
            remove_cover_art: false,
        };
        strip_mp3(&input, &output, &options).unwrap();

        let after = id3::Tag::read_from_path(&output).unwrap();
        let after_pic = after
            .pictures()
            .next()
            .expect("cover art must survive stripping");
        assert!(
            !after_pic.data.windows(6).any(|w| w == b"Exif\0\0"),
            "embedded cover art's own APP1/EXIF segment must be gone after strip_mp3"
        );
        assert_eq!(
            after_pic.description, "cover",
            "picture metadata unrelated to the image bytes must be preserved"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_mp3_remove_cover_art_deletes_picture_entirely() {
        let dir = temp_dir("mp3_delete_cover");
        let input = dir.join("in.mp3");
        let output = dir.join("out.mp3");

        fs::write(&input, b"FAKE_MPEG_AUDIO_STREAM_PLACEHOLDER_BYTES").unwrap();
        let mut tag = id3::Tag::new();
        tag.add_frame(id3::frame::Picture {
            mime_type: "image/jpeg".to_string(),
            picture_type: id3::frame::PictureType::CoverFront,
            description: "cover".to_string(),
            data: minimal_jpeg_with_app1(),
        });
        tag.write_to_path(&input, id3::Version::Id3v24).unwrap();

        let options = CleaningOptions {
            gps: false,
            author: false,
            date: false,
            remove_cover_art: true,
        };
        strip_mp3(&input, &output, &options).unwrap();

        let after = id3::Tag::read_from_path(&output).unwrap();
        assert_eq!(
            after.pictures().count(),
            0,
            "cover art must be deleted entirely, not just EXIF-cleaned"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_mp3_removing_large_cover_art_leaves_no_stale_bytes() {
        // Real cover art is commonly 50-500KB, far bigger than the tiny
        // synthetic picture the other tests use — removing it shrinks the
        // ID3v2 tag drastically, which requires shifting everything after
        // it. This isolates that specific path (no APE/ID3v1 involved: only
        // remove_cover_art is set) and checks byte-for-byte that nothing
        // stale is left behind, mirroring the same class of truncation bug
        // already found and fixed on the APE side.
        let dir = temp_dir("mp3_large_cover");
        let input = dir.join("in.mp3");
        let output = dir.join("out.mp3");

        let audio = vec![0xABu8; 8192];
        fs::write(&input, &audio).unwrap();

        let mut tag = id3::Tag::new();
        tag.set_title("Back In Black");
        tag.add_frame(id3::frame::Picture {
            mime_type: "image/jpeg".to_string(),
            picture_type: id3::frame::PictureType::CoverFront,
            description: "cover".to_string(),
            data: vec![0xCDu8; 250_000],
        });
        tag.write_to_path(&input, id3::Version::Id3v24).unwrap();
        let tagged_size = fs::metadata(&input).unwrap().len();
        assert!(
            tagged_size > 250_000,
            "fixture sanity check: tag with large picture should dominate file size"
        );

        let options = CleaningOptions {
            gps: false,
            author: false,
            date: false,
            remove_cover_art: true,
        };
        strip_mp3(&input, &output, &options).unwrap();

        // Read back the (now pictureless) ID3v2 tag to get its exact
        // on-disk byte length, then verify total file size is *exactly*
        // tag length + audio length — no leftover bytes from the old,
        // much larger tag.
        let mut raw = fs::File::open(&output).unwrap();
        use std::io::Read;
        let mut header = [0u8; 10];
        raw.read_exact(&mut header).unwrap();
        assert_eq!(
            &header[0..3],
            b"ID3",
            "output must still start with a valid ID3v2 header"
        );
        let declared_tag_size = ((header[6] as u32 & 0x7F) << 21)
            | ((header[7] as u32 & 0x7F) << 14)
            | ((header[8] as u32 & 0x7F) << 7)
            | (header[9] as u32 & 0x7F);
        let expected_total = 10u64 + declared_tag_size as u64 + audio.len() as u64;

        assert_eq!(
            fs::metadata(&output).unwrap().len(),
            expected_total,
            "file size must exactly match header(10) + declared tag size + audio bytes \
             — any excess means stale bytes from the old (larger) tag were left behind"
        );

        // And the audio bytes themselves must be untouched and immediately
        // follow the (now much smaller) tag.
        let mut after_tag = vec![0u8; audio.len()];
        raw.seek(std::io::SeekFrom::Start(10 + declared_tag_size as u64))
            .unwrap();
        raw.read_exact(&mut after_tag).unwrap();
        assert_eq!(
            after_tag, audio,
            "audio bytes must be byte-identical and correctly positioned"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_remove_metadata_cover_art_only_still_cleans() {
        // Regression test: `remove_metadata`'s "nothing to do" fast path used
        // to check only gps/author/date, so a user who unchecked those three
        // and checked *only* Cover Art got a silent, unmodified byte-copy —
        // the cover art (and everything else) stayed exactly as it was.
        let dir = temp_dir("remove_metadata_cover_only");
        let input = dir.join("in.mp3");

        fs::write(&input, b"FAKE_MPEG_AUDIO_STREAM_PLACEHOLDER_BYTES").unwrap();
        let mut tag = id3::Tag::new();
        tag.add_frame(id3::frame::Picture {
            mime_type: "image/jpeg".to_string(),
            picture_type: id3::frame::PictureType::CoverFront,
            description: "cover".to_string(),
            data: minimal_jpeg_with_app1(),
        });
        tag.write_to_path(&input, id3::Version::Id3v24).unwrap();

        let options = CleaningOptions {
            gps: false,
            author: false,
            date: false,
            remove_cover_art: true,
        };
        let output_path = remove_metadata(input.to_str().unwrap(), None, options).unwrap();

        let after = id3::Tag::read_from_path(&output_path).unwrap();
        assert_eq!(
            after.pictures().count(),
            0,
            "cover-art-only cleaning must not silently no-op as a plain file copy"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn test_strip_mp3_author_removes_every_custom_txxx_frame() {
        // Mirrors a real-world "scene release" style tagging pattern (multiple
        // TXXX frames with arbitrary custom descriptions), the exact shape
        // that motivated hardening this removal.
        let dir = temp_dir("mp3_custom_txxx");
        let input = dir.join("in.mp3");
        let output = dir.join("out.mp3");

        fs::write(&input, b"FAKE_MPEG_AUDIO_STREAM_PLACEHOLDER_BYTES").unwrap();
        let mut tag = id3::Tag::new();
        for (description, value) in [
            ("ALBUMARTIST", "AC/DC"),
            ("ENCODERSETTINGS", "PMEDIA"),
            ("SOURCEMEDIA", "PMEDIA"),
            ("WWWAUDIOFILE", "www.t.me/pmedia_music"),
        ] {
            tag.add_frame(id3::frame::ExtendedText {
                description: description.to_string(),
                value: value.to_string(),
            });
        }
        tag.write_to_path(&input, id3::Version::Id3v24).unwrap();

        // Sanity check the fixture actually carries all 4 before stripping.
        let before = id3::Tag::read_from_path(&input).unwrap();
        assert_eq!(before.extended_texts().count(), 4);

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
            remove_cover_art: false,
        };
        strip_mp3(&input, &output, &options).unwrap();

        let after = id3::Tag::read_from_path(&output).unwrap();
        assert_eq!(
            after.extended_texts().count(),
            0,
            "every custom TXXX frame must be removed, regardless of its description"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_mp3_author_removes_ape_tag_custom_fields() {
        // Some scene-release tagging tools (the "PMEDIA" pattern that
        // prompted this) append a completely separate APEv2 tag block after
        // the MP3 audio stream, alongside ID3v2. Its fields are free-form
        // and were previously invisible to this (ID3-only) cleaner.
        let dir = temp_dir("mp3_ape_custom_fields");
        let input = dir.join("in.mp3");
        let output = dir.join("out.mp3");

        // ape::write_to_path seeks relative to a minimum assumed size, so a
        // tiny placeholder (as used by the other MP3 fixtures) isn't enough
        // here — pad it out to something closer to real audio-frame data.
        fs::write(&input, vec![0u8; 4096]).unwrap();

        let mut ape_tag = ape::Tag::new();
        for (key, value) in [
            ("Artist", "AC/DC"),
            ("ENCODERSETTINGS", "PMEDIA"),
            ("SOURCEMEDIA", "PMEDIA"),
            ("WWWAUDIOFILE", "www.t.me/pmedia_music"),
        ] {
            ape_tag.set_item(ape::Item::new(key, ape::ItemType::Text, value.to_string()).unwrap());
        }
        ape::write_to_path(&ape_tag, &input).unwrap();

        let before = analyze_mp3(&input).unwrap();
        assert!(before.has_author, "raw_tags: {:?}", before.raw_tags);
        assert!(before
            .raw_tags
            .iter()
            .any(|t| t.key == "ENCODERSETTINGS (APEv2)" && t.value == "PMEDIA"));

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
            remove_cover_art: false,
        };
        strip_mp3(&input, &output, &options).unwrap();

        let after = analyze_mp3(&output).unwrap();
        assert!(
            !after.raw_tags.iter().any(|t| t.key.ends_with("(APEv2)")),
            "every custom APEv2 field must be gone, got: {:?}",
            after.raw_tags
        );
        assert!(!after.has_author);

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_mp3_author_removes_grouping_isrc_url_and_ape_media_fields() {
        // Regression test for a second round of leftover PMEDIA-branded
        // fields found on a real file after the TXXX/APE fixes: TIT1
        // (Grouping), TCMP (Compilation), TSRC (ISRC), and the WOAF/WOAS URL
        // frames (distinct from WOAR, the artist-webpage frame already
        // covered) weren't on the removal list at all. Separately, the APE
        // tag's "Media" field was on the safe-list and survived, even though
        // real-world taggers abuse it for branding rather than an actual
        // media type.
        let dir = temp_dir("mp3_grouping_isrc_urls");
        let input = dir.join("in.mp3");
        let output = dir.join("out.mp3");

        fs::write(&input, vec![0u8; 4096]).unwrap();

        let mut tag = id3::Tag::new();
        tag.set_text("TIT1", "PMEDIA"); // Grouping
        tag.set_text("TCMP", "PMEDIA"); // Compilation
        tag.set_text("TSRC", "PMEDIA"); // ISRC
        tag.add_frame(id3::Frame::with_content(
            "WOAF",
            id3::Content::Link("https://t.me/pmedia_music".to_string()),
        ));
        tag.add_frame(id3::Frame::with_content(
            "WOAS",
            id3::Content::Link("https://t.me/pmedia_music".to_string()),
        ));
        tag.add_frame(id3::Frame::with_content(
            "TIPL",
            id3::Content::InvolvedPeopleList(id3::frame::InvolvedPeopleList {
                items: vec![id3::frame::InvolvedPeopleListItem {
                    involvement: "author".to_string(),
                    involvee: String::new(),
                }],
            }),
        ));
        tag.write_to_path(&input, id3::Version::Id3v24).unwrap();

        let mut ape_tag = ape::Tag::new();
        ape_tag
            .set_item(ape::Item::new("Media", ape::ItemType::Text, "PMEDIA".to_string()).unwrap());
        ape::write_to_path(&ape_tag, &input).unwrap();

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
            remove_cover_art: false,
        };
        strip_mp3(&input, &output, &options).unwrap();

        let after_id3 = id3::Tag::read_from_path(&output).unwrap();
        for id in ["TIT1", "TCMP", "TSRC", "WOAF", "WOAS", "TIPL"] {
            assert!(
                after_id3.get(id).is_none(),
                "{} must be removed by author cleaning",
                id
            );
        }

        let after = analyze_mp3(&output).unwrap();
        assert!(
            !after.raw_tags.iter().any(|t| t.value == "PMEDIA"),
            "no PMEDIA-branded field should survive, got: {:?}",
            after.raw_tags
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_ape_remove_from_path_semantics() {
        // Diagnostic: does ape::remove_from_path fully eliminate the tag
        // block (file shrinks back to pre-tag size, later read returns
        // TagNotFound), or does it clear items but leave an empty
        // header/footer shell behind? strip_ape_tag's logic assumes the
        // former; a real cleaned file was found to still have a bare
        // 32-byte APE footer after cleaning, which only makes sense if
        // it's actually the latter.
        let dir = temp_dir("ape_remove_semantics");
        let path = dir.join("in.mp3");
        let base_size = 4096usize;
        fs::write(&path, vec![0u8; base_size]).unwrap();

        let mut ape_tag = ape::Tag::new();
        ape_tag.set_item(
            ape::Item::new("ENCODERSETTINGS", ape::ItemType::Text, "PMEDIA".to_string()).unwrap(),
        );
        ape::write_to_path(&ape_tag, &path).unwrap();
        assert!(fs::metadata(&path).unwrap().len() as usize > base_size);

        ape::remove_from_path(&path).unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().len() as usize,
            base_size,
            "remove_from_path must fully truncate the tag block, not just clear items"
        );
        assert!(
            matches!(ape::read_from_path(&path), Err(ape::Error::TagNotFound)),
            "a removed tag must read back as TagNotFound, not an empty tag"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_ape_remove_from_path_handles_preexisting_header() {
        // Same question as test_ape_remove_from_path_semantics, but for a
        // tag that already has a header — like a real-world file tagged by
        // a full-featured tagger (Mp3tag, foobar2000), before our code
        // ever touches it. If remove_from_path only accounts for the
        // footer's declared size (which excludes the header by spec), the
        // *original* header would be stranded on the very first pass,
        // regardless of anything strip_ape_tag itself does afterward.
        let dir = temp_dir("ape_remove_semantics_with_header");
        let path = dir.join("in.mp3");
        let base_size = 4096usize;
        fs::write(&path, vec![0u8; base_size]).unwrap();

        let mut ape_tag = ape::Tag::new();
        ape_tag.set_item(
            ape::Item::new("ENCODERSETTINGS", ape::ItemType::Text, "PMEDIA".to_string()).unwrap(),
        );
        ape::write_to_path(&ape_tag, &path).unwrap();
        add_ape_header(&path).unwrap();
        let tagged_size = fs::metadata(&path).unwrap().len() as usize;
        assert!(
            tagged_size > base_size + 32,
            "fixture must genuinely include a header"
        );

        ape::remove_from_path(&path).unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().len() as usize,
            base_size,
            "remove_from_path must account for a pre-existing header too, not just the footer's own declared size"
        );
        assert!(matches!(
            ape::read_from_path(&path),
            Err(ape::Error::TagNotFound)
        ));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_strip_mp3_removes_ape_tag_without_leaving_stale_trailing_bytes() {
        // Regression test: a real cleaned file showed a MediaInfo
        // "conformance error" (actual file size didn't match what the MPEG
        // audio stream declared) that only started appearing once APE
        // handling was added. `ape::write_to_path` overwrites an existing
        // tag block in place and doesn't reliably shrink the file when
        // writing a smaller tag over a larger one, so `strip_ape_tag` now
        // always removes the on-disk tag before writing any replacement —
        // this proves that actually produces the correct, fully-truncated
        // file length in both the "tag fully removed" and "tag shrunk, some
        // safe items kept" cases.
        let dir = temp_dir("mp3_ape_no_stale_bytes");
        let base_size = 8192usize;

        // Case 1: every APE item gets removed (none are on the safe list) —
        // the output must be exactly the pre-tag audio size, byte for byte.
        {
            let input = dir.join("in_full_removal.mp3");
            let output = dir.join("out_full_removal.mp3");
            fs::write(&input, vec![0u8; base_size]).unwrap();

            let mut ape_tag = ape::Tag::new();
            for (key, value) in [
                ("Artist", "AC/DC"),
                ("ENCODERSETTINGS", "PMEDIA"),
                ("SOURCEMEDIA", "PMEDIA"),
                ("RELEASECOUNTRY", "PMEDIA"),
                ("WWWAUDIOFILE", "www.t.me/pmedia_music"),
            ] {
                ape_tag
                    .set_item(ape::Item::new(key, ape::ItemType::Text, value.to_string()).unwrap());
            }
            ape::write_to_path(&ape_tag, &input).unwrap();
            assert!(fs::metadata(&input).unwrap().len() as usize > base_size);

            let options = CleaningOptions {
                gps: false,
                author: true,
                date: false,
                remove_cover_art: false,
            };
            strip_mp3(&input, &output, &options).unwrap();

            assert_eq!(
                fs::metadata(&output).unwrap().len() as usize,
                base_size,
                "removing every APE item must truncate back to the exact pre-tag audio size"
            );
            assert!(matches!(
                ape::read_from_path(&output),
                Err(ape::Error::TagNotFound)
            ));

            let _ = fs::remove_file(input);
            let _ = fs::remove_file(output);
        }

        // Case 2: one safe item survives (Genre) alongside removed unsafe
        // ones — the output must match a tag written fresh onto a clean
        // file with only that one item, not the old (larger) tag shrunk
        // in place.
        {
            let input = dir.join("in_partial.mp3");
            let output = dir.join("out_partial.mp3");
            fs::write(&input, vec![0u8; base_size]).unwrap();

            let mut ape_tag = ape::Tag::new();
            ape_tag.set_item(
                ape::Item::new("Genre", ape::ItemType::Text, "Rock".to_string()).unwrap(),
            );
            for (key, value) in [
                ("ENCODERSETTINGS", "PMEDIA"),
                ("SOURCEMEDIA", "PMEDIA"),
                ("RELEASECOUNTRY", "PMEDIA"),
            ] {
                ape_tag
                    .set_item(ape::Item::new(key, ape::ItemType::Text, value.to_string()).unwrap());
            }
            ape::write_to_path(&ape_tag, &input).unwrap();

            let options = CleaningOptions {
                gps: false,
                author: true,
                date: false,
                remove_cover_art: false,
            };
            strip_mp3(&input, &output, &options).unwrap();

            // Reference: what a fresh single-item tag (plus the header
            // `strip_ape_tag` adds after writing) looks like on a pristine,
            // untagged file of the same size.
            let reference = dir.join("reference_partial.mp3");
            fs::write(&reference, vec![0u8; base_size]).unwrap();
            let mut fresh_tag = ape::Tag::new();
            fresh_tag.set_item(
                ape::Item::new("Genre", ape::ItemType::Text, "Rock".to_string()).unwrap(),
            );
            ape::write_to_path(&fresh_tag, &reference).unwrap();
            add_ape_header(&reference).unwrap();

            assert_eq!(
                fs::metadata(&output).unwrap().len(),
                fs::metadata(&reference).unwrap().len(),
                "shrinking the APE tag must match a tag written fresh, not a larger tag overwritten in place"
            );

            let after = ape::read_from_path(&output).unwrap();
            assert_eq!(after.iter().count(), 1);
            assert_eq!(
                <&str>::try_from(after.item("Genre").unwrap()).unwrap(),
                "Rock"
            );

            let _ = fs::remove_file(input);
            let _ = fs::remove_file(output);
            let _ = fs::remove_file(reference);
        }
    }

    #[test]
    fn test_strip_mp3_writes_ape_header_matching_footer() {
        // Regression test for a real file that was fully cleaned (no
        // survivable PMEDIA fields left) yet MediaInfo still flagged a
        // size-conformance error. Ground truth pulled directly from the
        // cleaned file's own APE footer proved why: `ape::write_to_path`
        // only ever writes a footer (its Flags field was 0 — no header
        // bit), and MediaInfo apparently can't recognize a footer-only
        // APEv2 tag when computing where the audio stream should end, so
        // the tag's own size reads as unaccounted-for trailing bytes. The
        // original PMEDIA-tagged file (written by a full-featured tagger
        // that includes both) had no such issue. This checks the header
        // `add_ape_header` inserts is byte-correct and round-trips.
        let dir = temp_dir("mp3_ape_header");
        let input = dir.join("in.mp3");
        let output = dir.join("out.mp3");
        fs::write(&input, vec![0u8; 4096]).unwrap();

        let mut ape_tag = ape::Tag::new();
        ape_tag.set_item(ape::Item::new("Genre", ape::ItemType::Text, "Rock".to_string()).unwrap());
        ape_tag.set_item(
            ape::Item::new("Title", ape::ItemType::Text, "Back In Black".to_string()).unwrap(),
        );
        ape::write_to_path(&ape_tag, &input).unwrap();

        let options = CleaningOptions {
            gps: false,
            author: true,
            date: false,
            remove_cover_art: false,
        };
        strip_mp3(&input, &output, &options).unwrap();

        let bytes = fs::read(&output).unwrap();
        let len = bytes.len();
        let footer_start = len - 32;
        let footer_flags = u32::from_le_bytes(
            bytes[footer_start + 20..footer_start + 24]
                .try_into()
                .unwrap(),
        );
        let tag_size = u32::from_le_bytes(
            bytes[footer_start + 12..footer_start + 16]
                .try_into()
                .unwrap(),
        );
        let item_count = u32::from_le_bytes(
            bytes[footer_start + 16..footer_start + 20]
                .try_into()
                .unwrap(),
        );

        assert_eq!(
            footer_flags & (1 << 31),
            1 << 31,
            "footer must declare HAS_HEADER"
        );
        assert_eq!(
            footer_flags & (1 << 29),
            0,
            "footer's own IS_HEADER bit must stay clear"
        );

        // `tag_size` (items + footer) already spans back to exactly where
        // the header sits once the header itself has been inserted — no
        // extra header-length adjustment needed here (that adjustment is
        // only for locating the *pre-insertion* items start).
        let header_start = footer_start - tag_size as usize;
        let header = &bytes[header_start..header_start + 32];
        assert_eq!(
            &header[0..8],
            b"APETAGEX",
            "header must start with the APE magic"
        );
        let header_flags = u32::from_le_bytes(header[20..24].try_into().unwrap());
        assert_eq!(
            header_flags & ((1 << 31) | (1 << 29)),
            (1 << 31) | (1 << 29),
            "header must declare both HAS_HEADER and IS_HEADER"
        );
        let header_tag_size = u32::from_le_bytes(header[12..16].try_into().unwrap());
        let header_item_count = u32::from_le_bytes(header[16..20].try_into().unwrap());
        assert_eq!(
            header_tag_size, tag_size,
            "header's tag size must mirror the footer's"
        );
        assert_eq!(
            header_item_count, item_count,
            "header's item count must mirror the footer's"
        );

        // And the crate must still read everything back correctly with
        // the header in place.
        let after = ape::read_from_path(&output).unwrap();
        assert_eq!(after.iter().count(), 2);
        assert_eq!(
            <&str>::try_from(after.item("Genre").unwrap()).unwrap(),
            "Rock"
        );
        assert_eq!(
            <&str>::try_from(after.item("Title").unwrap()).unwrap(),
            "Back In Black"
        );

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn test_strip_mp3_removes_trailing_tags_regardless_of_order() {
        // ID3v1 and APEv2 trailers can appear in either order depending on
        // the tagging tool: `[audio][APEv2][ID3v1]` is conventional, but
        // some write `[audio][ID3v1][APEv2]` instead. Each library can only
        // find its own tag when it's genuinely the last bytes in the file,
        // so a single removal pass leaves one tag stranded mid-file
        // whenever the order doesn't match what that pass assumes — which
        // shows up as leftover/misplaced bytes a tool like MediaInfo flags
        // as a file-size conformance error, even though nothing is
        // reported as visible metadata anymore.
        fn id3v1_block(artist: &str) -> Vec<u8> {
            let mut b = vec![0u8; 128];
            b[0..3].copy_from_slice(b"TAG");
            let artist_bytes = artist.as_bytes();
            let len = artist_bytes.len().min(30);
            b[33..33 + len].copy_from_slice(&artist_bytes[..len]);
            b
        }

        let dir = temp_dir("mp3_trailer_order");
        let base_size = 4096usize;
        let base = vec![0u8; base_size];

        // Extract a standalone APEv2 tag fragment by writing it onto a
        // throwaway file and slicing off everything past the base audio.
        let ape_frag = {
            let tmp = dir.join("ape_fragment.bin");
            fs::write(&tmp, &base).unwrap();
            let mut ape_tag = ape::Tag::new();
            ape_tag.set_item(
                ape::Item::new("ENCODERSETTINGS", ape::ItemType::Text, "PMEDIA".to_string())
                    .unwrap(),
            );
            ape::write_to_path(&ape_tag, &tmp).unwrap();
            let full = fs::read(&tmp).unwrap();
            let frag = full[base_size..].to_vec();
            let _ = fs::remove_file(&tmp);
            frag
        };
        let id3v1_frag = id3v1_block("AC/DC");

        for reversed in [false, true] {
            let input = dir.join(if reversed {
                "in_reversed.mp3"
            } else {
                "in_normal.mp3"
            });
            let output = dir.join(if reversed {
                "out_reversed.mp3"
            } else {
                "out_normal.mp3"
            });

            let mut bytes = base.clone();
            if reversed {
                bytes.extend_from_slice(&id3v1_frag);
                bytes.extend_from_slice(&ape_frag);
            } else {
                bytes.extend_from_slice(&ape_frag);
                bytes.extend_from_slice(&id3v1_frag);
            }
            fs::write(&input, &bytes).unwrap();

            let options = CleaningOptions {
                gps: false,
                author: true,
                date: false,
                remove_cover_art: false,
            };
            strip_mp3(&input, &output, &options).unwrap();

            assert_eq!(
                fs::metadata(&output).unwrap().len() as usize,
                base_size,
                "trailing tags in {} order must be fully removed with no stranded bytes",
                if reversed { "reversed" } else { "normal" }
            );

            let _ = fs::remove_file(&input);
            let _ = fs::remove_file(&output);
        }
    }

    #[test]
    fn test_analyze_mp3_garbage_bytes_no_panic() {
        let dir = temp_dir("mp3_garbage");
        let path = dir.join("garbage.mp3");
        fs::write(&path, vec![0xFFu8; 128]).unwrap();

        // Must not panic regardless of whether it finds a usable tag.
        let _ = analyze_mp3(&path);

        let _ = fs::remove_file(path);
    }

}

// --- END OF FILE cleaner/media/mp3.rs ---
