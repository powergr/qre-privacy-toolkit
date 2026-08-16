#![no_main]

use libfuzzer_sys::fuzz_target;
use qre_core::cleaner::analyze_zip_reader;
use std::io::Cursor;

fuzz_target!(|data: &[u8]| {
    // GOAL: Feed arbitrary bytes as if they were a user-selected .zip file (or
    // a .docx/.xlsx/.pptx, which are ZIP containers) into the Metadata Cleaner's
    // ZIP analyzer. Must never panic — only return Ok or Err.
    //
    // This is exactly the code path that a fuzzer-found bug already hit once:
    // a malformed per-entry DOS timestamp made `ZipFile::last_modified()`
    // return `None`, and the analyzer used to `.expect()` on it.

    let cursor = Cursor::new(data);
    let _ = analyze_zip_reader(cursor, data.len() as u64);
});
