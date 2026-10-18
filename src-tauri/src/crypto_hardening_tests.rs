//! Smaller defences around the stream format: how much one chunk may expand when it is
//! decompressed, and how a file name from a header becomes the name of the unlocked file.

use crate::crypto_stream::{compress_chunk, decompress_chunk, safe_output_name, CHUNK_SIZE};

// ─── Decompression limit ─────────────────────────────────────────────────────

#[test]
fn test_a_chunk_of_the_largest_allowed_size_comes_back_whole() {
    let data = vec![b'a'; CHUNK_SIZE];
    let packed = compress_chunk(&data, 3).unwrap();
    assert!(packed.len() < 1000, "the test needs data that compresses well");
    assert_eq!(decompress_chunk(&packed).unwrap(), data);
}

#[test]
fn test_a_chunk_that_expands_past_the_limit_is_refused() {
    // Two megabytes of one letter fit in a few dozen bytes. A reader that trusted the writer would
    // allocate all of it; this one stops one byte past the limit.
    let packed = compress_chunk(&vec![b'a'; CHUNK_SIZE + 1], 3).unwrap();
    let err = decompress_chunk(&packed).unwrap_err().to_string();
    assert!(err.contains("Chunk expands to more than"), "{}", err);

    let bomb = compress_chunk(&vec![0u8; 64 * 1024 * 1024], 1).unwrap();
    assert!(bomb.len() < 100_000, "the test needs a real bomb ({} bytes)", bomb.len());
    assert!(decompress_chunk(&bomb).is_err());
}

#[test]
fn test_an_empty_chunk_and_a_short_one_still_work() {
    assert_eq!(decompress_chunk(&compress_chunk(b"", 3).unwrap()).unwrap(), b"");
    assert_eq!(decompress_chunk(&compress_chunk(b"hello", 3).unwrap()).unwrap(), b"hello");
}

#[test]
fn test_bytes_that_are_not_zstd_are_refused() {
    assert!(decompress_chunk(b"this is not a zstd frame at all").is_err());
}

// ─── File names ──────────────────────────────────────────────────────────────

#[test]
fn test_direction_controls_in_a_name_are_replaced_so_it_reads_as_it_is_spelled() {
    // U+202E makes what follows read right to left: "report<RLO>cod.exe" is drawn "reportexe.doc".
    assert_eq!(safe_output_name("report\u{202E}cod.exe").unwrap(), "report_cod.exe");
}

#[test]
fn test_every_direction_control_is_replaced() {
    let controls = [
        '\u{061C}', '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}',
        '\u{2067}', '\u{2068}', '\u{2069}',
    ];
    for c in controls {
        let name = safe_output_name(&format!("a{}b.txt", c)).unwrap();
        assert_eq!(name, "a_b.txt", "U+{:04X} was kept", c as u32);
    }
}

#[test]
fn test_ordinary_names_in_any_script_are_left_alone() {
    for name in ["Café résumé.txt", "日本語のファイル.pdf", "ملف عربي.docx", "файл.txt", "photo 😀.jpg", "name with spaces.txt"] {
        assert_eq!(safe_output_name(name).unwrap(), name);
    }
}

#[test]
fn test_a_name_made_only_of_direction_controls_becomes_a_plain_name() {
    assert_eq!(safe_output_name("\u{202E}\u{202E}").unwrap(), "__");
}

#[test]
fn test_trailing_dots_and_spaces_are_dropped_where_windows_would_drop_them() {
    if cfg!(windows) {
        assert_eq!(safe_output_name("report.txt. .").unwrap(), "report.txt");
        assert_eq!(safe_output_name("notes   ").unwrap(), "notes");
    } else {
        // Elsewhere a trailing dot or space is an ordinary character and must survive.
        assert_eq!(safe_output_name("report.txt. .").unwrap(), "report.txt. .");
        assert_eq!(safe_output_name("notes   ").unwrap(), "notes   ");
    }
}

#[test]
fn test_a_device_name_with_a_trailing_space_or_dot_is_still_refused_on_windows() {
    // Windows drops the trailing space or dot, so "CON " opens the console.
    if cfg!(windows) {
        for bad in ["CON ", "CON.", "nul . ", "COM1 ", "lpt9.", "AUX .txt ", "PRN.  "] {
            assert!(safe_output_name(bad).is_err(), "{:?} was accepted", bad);
        }
    }
}

#[test]
fn test_a_name_of_only_dots_or_spaces_is_refused_on_windows() {
    if cfg!(windows) {
        for bad in ["...", " ", ". .", "   "] {
            assert!(safe_output_name(bad).is_err(), "{:?} was accepted", bad);
        }
    }
}

#[test]
fn test_a_name_with_a_folder_part_keeps_only_the_cleaned_last_part() {
    assert_eq!(safe_output_name("../../x/report\u{202E}cod.exe").unwrap(), "report_cod.exe");
}
