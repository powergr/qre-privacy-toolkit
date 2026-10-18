//! Re-locking: rewriting a locked file of format 5, 6 or 7 as format 8 under the same name.
//!
//! The rule that matters most: whatever goes wrong, the old file is left exactly as it was, and no
//! half-made file is left next to it. The plaintext must also never reach the disk on the way.
//! Helpers are shared with crypto_failure_tests.rs.

use crate::commands::files::{
    find_old_format_files_in, relock_files_blocking, BatchItemResult, Progress, Vaults,
};
use crate::crypto_failure_tests::{chunks_start, fresh_dir, function_body, key, names, noise, unlock, write};
use crate::crypto_stream::{self, FileFormat, StreamHeader};
use crate::keychain::MasterKey;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const FAR_FUTURE: u64 = 4_000_000_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn now() -> u64 {
    crate::timelock::now_secs()
}

/// A locked file in an older format, made the way the older app made it.
fn lock_old(
    format: FileFormat,
    input: &str,
    output: &str,
    mk: &MasterKey,
    vault: &str,
    keyfile: Option<&[u8]>,
    until: Option<u64>,
) {
    crypto_stream::encrypt_file_stream_as(format, input, output, mk, vault, keyfile, until, None, 1, |_, _| {}).unwrap();
}

fn relock(path: &str, mk: &MasterKey, keyfile: Option<&[u8]>) -> anyhow::Result<()> {
    crypto_stream::relock_file_stream(path, mk, keyfile, 1, |_, _| {}, |_, _| {})
}

fn version_of(path: &str) -> u32 {
    crypto_stream::stream_version(path).unwrap()
}

/// A folder holding `data.bin` (made of `size` bytes of noise) and an empty `out` folder.
fn workspace(test: &str, size: usize) -> (PathBuf, PathBuf, String, Vec<u8>) {
    let base = fresh_dir(test);
    let out = base.join("out");
    fs::create_dir_all(&out).unwrap();
    let data = noise(size);
    let input = write(&base, "data.bin", &data);
    (base, out, input, data)
}

/// The same V6 file written as a V5 file: the version differs and the header has no time-lock
/// field, which is the one byte at the end of the header.
fn v5_from_v6(v6_path: &str, out_path: &str) {
    let bytes = fs::read(v6_path).unwrap();
    let start = chunks_start(&bytes);
    assert_eq!(bytes[start - 1], 0, "the V6 header should end with 'no time-lock'");
    let mut v5 = 5u32.to_le_bytes().to_vec();
    v5.extend_from_slice(&bytes[4..start - 1]);
    v5.extend_from_slice(&bytes[start..]);
    fs::write(out_path, v5).unwrap();
}

/// The same V6 file with its header changed by `edit` and written again.
fn v6_with_header(path: &str, edit: impl FnOnce(&mut StreamHeader)) {
    let bytes = fs::read(path).unwrap();
    let mut cursor = std::io::Cursor::new(&bytes[..]);
    cursor.set_position(4);
    let mut header: StreamHeader = bincode::deserialize_from(&mut cursor).unwrap();
    let rest = bytes[cursor.position() as usize..].to_vec();
    edit(&mut header);
    let mut out = bytes[..4].to_vec();
    out.extend(bincode::serialize(&header).unwrap());
    out.extend(rest);
    fs::write(path, out).unwrap();
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

// ─── The stream function ─────────────────────────────────────────────────────

#[test]
fn test_a_version_6_file_becomes_a_version_8_file_with_the_same_content() {
    let (base, out, input, data) = workspace("qre_relock_v6", 2 * 1024 * 1024 + 321);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    assert_eq!(version_of(&locked), 6);

    relock(&locked, &key(7), None).unwrap();

    assert_eq!(version_of(&locked), 8);
    assert_eq!(unlock(&locked, &out, &key(7)).unwrap(), "data.bin");
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_file_keeps_its_name_and_leaves_nothing_else_behind() {
    let (base, _, input, _) = workspace("qre_relock_clean", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    let before = names(&base);

    relock(&locked, &key(7), None).unwrap();

    assert_eq!(names(&base), before, "a file appeared or disappeared");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_old_name_is_no_longer_readable_after_the_upgrade() {
    let base = fresh_dir("qre_relock_hidden");
    let input = write(&base, "tax-return-2024.pdf", &noise(30_000));
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    assert!(contains(&fs::read(&locked).unwrap(), b"tax-return-2024.pdf"), "the old file should show its name");

    relock(&locked, &key(7), None).unwrap();

    assert!(!contains(&fs::read(&locked).unwrap(), b"tax-return-2024"), "the name is still readable");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_version_5_file_is_upgraded_too() {
    let (base, out, input, data) = workspace("qre_relock_v5", 300_000);
    let v6 = format!("{}.v6.qre", input);
    let v5 = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &v6, &key(7), "local", None, None);
    v5_from_v6(&v6, &v5);
    assert_eq!(version_of(&v5), 5);
    // The made-up V5 file must itself be readable, or this test proves nothing.
    assert_eq!(unlock(&v5, &out, &key(7)).unwrap(), "data.bin");
    fs::remove_file(out.join("data.bin")).unwrap();

    relock(&v5, &key(7), None).unwrap();

    assert_eq!(version_of(&v5), 8);
    unlock(&v5, &out, &key(7)).unwrap();
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_time_lock_that_has_ended_is_dropped_and_the_file_opens() {
    let (base, out, input, data) = workspace("qre_relock_v7_expired", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, Some(now() - 1000));
    assert_eq!(version_of(&locked), 7);

    relock(&locked, &key(7), None).unwrap();

    assert_eq!(version_of(&locked), 8);
    assert!(crypto_stream::read_timelock_header(&locked).unwrap().is_none(), "an ended lock should not be carried over");
    unlock(&locked, &out, &key(7)).unwrap();
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_that_is_still_time_locked_is_left_alone() {
    let (base, _, input, _) = workspace("qre_relock_v7_locked", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, Some(now() + 100_000));
    let before = fs::read(&locked).unwrap();
    let listing = names(&base);

    let err = relock(&locked, &key(7), None).unwrap_err().to_string();

    assert!(err.starts_with("TIME_LOCKED:"), "{}", err);
    assert_eq!(version_of(&locked), 7);
    // Version 7 rewrites its ratchet on a refusal, so only the data part must be unchanged.
    assert_eq!(fs::read(&locked).unwrap()[4100..], before[4100..]);
    assert_eq!(names(&base), listing);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_vault_of_the_old_file_is_kept() {
    let (base, out, input, data) = workspace("qre_relock_usb", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(42), "usb-1234", None, None);

    relock(&locked, &key(42), None).unwrap();

    assert_eq!(crypto_stream::read_vault_id(&locked).as_deref(), Some("usb-1234"));
    unlock(&locked, &out, &key(42)).unwrap();
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_locked_with_a_key_file_needs_it_before_and_after() {
    let (base, out, input, data) = workspace("qre_relock_keyfile", 5000);
    let locked = format!("{}.qre", input);
    let keyfile = [0xAB_u8; 32];
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", Some(&keyfile), None);
    let before = fs::read(&locked).unwrap();

    // Without the key file the upgrade is refused and the file is untouched.
    let err = relock(&locked, &key(7), None).unwrap_err().to_string();
    assert!(err.starts_with("Decryption Denied"), "{}", err);
    assert_eq!(fs::read(&locked).unwrap(), before);

    relock(&locked, &key(7), Some(&keyfile)).unwrap();
    assert_eq!(version_of(&locked), 8);

    // The key file still protects it.
    assert!(crypto_stream::decrypt_file_stream(&locked, out.to_str().unwrap(), &key(7), None, |_, _| {}).is_err());
    crypto_stream::decrypt_file_stream(&locked, out.to_str().unwrap(), &key(7), Some(&keyfile), |_, _| {}).unwrap();
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_empty_file_is_upgraded() {
    let base = fresh_dir("qre_relock_empty");
    let out = base.join("out");
    fs::create_dir_all(&out).unwrap();
    let input = write(&base, "empty.txt", b"");
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);

    relock(&locked, &key(7), None).unwrap();

    assert_eq!(version_of(&locked), 8);
    unlock(&locked, &out, &key(7)).unwrap();
    assert_eq!(fs::read(out.join("empty.txt")).unwrap(), Vec::<u8>::new());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_name_with_accents_and_spaces_survives() {
    let base = fresh_dir("qre_relock_names");
    let out = base.join("out");
    fs::create_dir_all(&out).unwrap();
    let input = write(&base, "Café résumé 2026 (final).txt", b"content");
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);

    relock(&locked, &key(7), None).unwrap();

    assert_eq!(unlock(&locked, &out, &key(7)).unwrap(), "Café résumé 2026 (final).txt");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_old_file_with_no_hash_in_its_header_still_gets_one() {
    let (base, out, input, data) = workspace("qre_relock_nohash", 2 * 1024 * 1024);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    v6_with_header(&locked, |h| h.original_hash = None);
    // The file without a hash must open on its own first.
    assert_eq!(unlock(&locked, &out, &key(7)).unwrap(), "data.bin");
    fs::remove_file(out.join("data.bin")).unwrap();

    relock(&locked, &key(7), None).unwrap();

    assert_eq!(version_of(&locked), 8);
    unlock(&locked, &out, &key(7)).unwrap();
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);

    // The new file carries a hash, so a cut file is caught: cut it between two chunks.
    let bytes = fs::read(&locked).unwrap();
    let ends = crate::crypto_failure_tests::chunk_ends(&bytes);
    assert!(ends.len() >= 2);
    fs::write(&locked, &bytes[..ends[0]]).unwrap();
    let err = unlock(&locked, &out, &key(7)).unwrap_err().to_string();
    assert!(err.contains("INTEGRITY"), "{}", err);
    let _ = fs::remove_dir_all(base);
}

// ─── When something is wrong, the old file stays as it was ───────────────────

/// Runs the upgrade on a file that cannot be upgraded and checks that it is untouched.
fn assert_refused_and_untouched(path: &str, mk: &MasterKey, dir: &Path, expect: &str) {
    let before = fs::read(path).unwrap();
    let listing = names(dir);
    let err = relock(path, mk, None).unwrap_err().to_string();
    assert!(err.contains(expect), "expected '{}' in: {}", expect, err);
    assert_eq!(fs::read(path).unwrap(), before, "the old file was changed");
    assert_eq!(names(dir), listing, "a file was left behind or removed");
}

#[test]
fn test_a_wrong_password_changes_nothing() {
    let (base, _, input, _) = workspace("qre_relock_wrong_key", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    assert_refused_and_untouched(&locked, &key(99), &base, "Decryption Denied");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_damaged_chunk_changes_nothing() {
    let (base, _, input, _) = workspace("qre_relock_damaged", 3 * 1024 * 1024);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    let mut bytes = fs::read(&locked).unwrap();
    let at = bytes.len() * 3 / 4;
    bytes[at] ^= 0x01;
    fs::write(&locked, bytes).unwrap();
    assert_refused_and_untouched(&locked, &key(7), &base, "integrity");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_inside_a_chunk_changes_nothing() {
    let (base, _, input, _) = workspace("qre_relock_cut_inside", 3 * 1024 * 1024);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    let bytes = fs::read(&locked).unwrap();
    fs::write(&locked, &bytes[..bytes.len() - 100]).unwrap();
    assert_refused_and_untouched(&locked, &key(7), &base, "incomplete");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_between_chunks_is_caught_by_its_old_hash_and_changes_nothing() {
    let (base, _, input, _) = workspace("qre_relock_cut_between", 3 * 1024 * 1024);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    let bytes = fs::read(&locked).unwrap();
    let ends = crate::crypto_failure_tests::chunk_ends(&bytes);
    fs::write(&locked, &bytes[..ends[ends.len() - 2]]).unwrap();
    assert_refused_and_untouched(&locked, &key(7), &base, "INTEGRITY");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_wrong_hash_in_the_old_header_changes_nothing() {
    // The data is whole, but the header's hash does not match it. The new file must not be
    // written with a hash that is not the real one.
    let (base, _, input, _) = workspace("qre_relock_bad_hash", 2 * 1024 * 1024);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    v6_with_header(&locked, |h| h.original_hash = Some(vec![0u8; 32]));
    assert_refused_and_untouched(&locked, &key(7), &base, "INTEGRITY");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_already_in_the_current_format_is_refused_and_unchanged() {
    let (base, _, input, _) = workspace("qre_relock_already", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::V8, &input, &locked, &key(7), "local", None, None);
    assert_refused_and_untouched(&locked, &key(7), &base, "already in the current format");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_something_that_is_not_a_locked_file_is_refused_and_unchanged() {
    let base = fresh_dir("qre_relock_text");
    let text = write(&base, "notes.qre", b"this is plain text, not a locked file");
    assert_refused_and_untouched(&text, &key(7), &base, "not a locked file");
    let tiny = write(&base, "tiny.qre", b"ab");
    assert_refused_and_untouched(&tiny, &key(7), &base, "not a locked file");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_missing_file_is_refused() {
    let base = fresh_dir("qre_relock_missing");
    let missing = base.join("nope.qre").to_str().unwrap().to_string();
    assert!(relock(&missing, &key(7), None).is_err());
    assert!(names(&base).is_empty());
    let _ = fs::remove_dir_all(base);
}

// ─── Progress, and the plaintext never reaching the disk ─────────────────────

#[test]
fn test_both_halves_of_the_work_report_progress() {
    let (base, _, input, _) = workspace("qre_relock_progress", 6 * 1024 * 1024);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    let writes = std::cell::Cell::new(0u32);
    let checks = std::cell::Cell::new(0u32);

    crypto_stream::relock_file_stream(&locked, &key(7), None, 1, |_, _| writes.set(writes.get() + 1), |_, _| checks.set(checks.get() + 1)).unwrap();

    assert!(writes.get() > 0, "writing reported no progress");
    assert!(checks.get() > 0, "the check reported no progress");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_plaintext_is_never_written_to_disk_on_the_way() {
    // While the upgrade runs, the only files in the folder are the old file and its ".part"
    // replacement. Looked at after each progress report, so a plaintext temporary would show.
    let (base, _, input, _) = workspace("qre_relock_no_plaintext", 7 * 1024 * 1024);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    let expected_before = names(&base);
    let seen: std::cell::RefCell<Vec<Vec<String>>> = std::cell::RefCell::new(Vec::new());
    let snapshot = |_: u64, _: u64| seen.borrow_mut().push(names(&base));

    crypto_stream::relock_file_stream(&locked, &key(7), None, 1, snapshot, |_, _| {}).unwrap();

    let seen = seen.borrow();
    assert!(!seen.is_empty());
    for listing in seen.iter() {
        let extra: Vec<&String> = listing.iter().filter(|n| !expected_before.contains(n)).collect();
        assert!(
            extra.iter().all(|n| n.ends_with(".part")),
            "something besides the .part file appeared: {:?}",
            extra
        );
    }
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_function_does_not_use_the_unlock_that_writes_plaintext() {
    // A source check: re-locking decrypts in memory. If it ever went through decrypt_file_stream,
    // the whole file would land on the disk in the clear.
    let stream = include_str!("crypto_stream.rs");
    let body = function_body(stream, "pub fn relock_file_stream(");
    assert!(!body.contains("decrypt_file_stream("), "re-locking writes plaintext to disk");
    assert!(body.contains("encrypt_pieces("));
    assert!(body.contains("verify_locked_file("), "the new file is no longer checked before it replaces the old one");
    let check = body.find("verify_locked_file(").unwrap();
    let swap = body.find("fs::rename(&part, input_path)").expect("the rename is missing");
    assert!(check < swap, "the old file is replaced before the new one is checked");

    // A failed check cannot be provoked on a healthy disk, so the clean-up is checked in the
    // source: between the check and the rename, a failure removes the ".part" file.
    let between = &body[check..swap];
    assert!(between.contains("fs::remove_file(&part)"), "a failed check leaves the .part file behind");
    assert!(between.contains("The old file was not changed."));
}

// ─── The scan ────────────────────────────────────────────────────────────────

fn make_tree(test: &str) -> PathBuf {
    let base = fresh_dir(test);
    let input = write(&base, "a.bin", &noise(3000));
    lock_old(FileFormat::Classic, &input, &format!("{}/six.qre", base.to_str().unwrap()), &key(7), "local", None, None);
    lock_old(FileFormat::Classic, &input, &format!("{}/seven.qre", base.to_str().unwrap()), &key(7), "local", None, Some(FAR_FUTURE));
    lock_old(FileFormat::V8, &input, &format!("{}/eight.qre", base.to_str().unwrap()), &key(7), "local", None, None);
    write(&base, "text.qre", b"not a locked file at all");
    write(&base, "other.txt", b"ignored");
    let sub = base.join("sub").join("deeper");
    fs::create_dir_all(&sub).unwrap();
    lock_old(FileFormat::Classic, &input, &format!("{}/nested.qre", sub.to_str().unwrap()), &key(7), "local", None, None);
    base
}

#[test]
fn test_the_scan_finds_only_old_format_locked_files() {
    let base = make_tree("qre_relock_scan");
    let found = find_old_format_files_in(&base, false);
    let found_names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(found_names, vec!["seven.qre", "six.qre"], "{:?}", found);
    assert_eq!(found.iter().map(|f| f.version).collect::<Vec<_>>(), vec![7, 6]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_scan_reports_the_end_of_a_time_lock() {
    let base = make_tree("qre_relock_scan_lock");
    let found = find_old_format_files_in(&base, false);
    let seven = found.iter().find(|f| f.name == "seven.qre").unwrap();
    let six = found.iter().find(|f| f.name == "six.qre").unwrap();
    assert_eq!(seven.locked_until, Some(FAR_FUTURE));
    assert_eq!(six.locked_until, None);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_scan_goes_into_sub_folders_only_when_asked() {
    let base = make_tree("qre_relock_scan_deep");
    let flat = find_old_format_files_in(&base, false);
    let deep = find_old_format_files_in(&base, true);
    assert!(!flat.iter().any(|f| f.name == "nested.qre"));
    assert!(deep.iter().any(|f| f.name == "nested.qre"));
    assert_eq!(deep.len(), flat.len() + 1);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_scan_result_is_sorted_by_path() {
    let base = make_tree("qre_relock_scan_sorted");
    // Two sibling folders, so that the order the folders are visited in differs from path order.
    let input = base.join("a.bin");
    for folder in ["zz", "aa"] {
        let dir = base.join(folder);
        fs::create_dir_all(&dir).unwrap();
        lock_old(FileFormat::Classic, input.to_str().unwrap(), &format!("{}/f.qre", dir.to_str().unwrap()), &key(7), "local", None, None);
    }
    let found = find_old_format_files_in(&base, true);
    let paths: Vec<&String> = found.iter().map(|f| &f.path).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);
    assert!(paths.len() >= 5);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_scan_includes_a_capital_extension() {
    let base = fresh_dir("qre_relock_scan_caps");
    let input = write(&base, "a.bin", &noise(1000));
    lock_old(FileFormat::Classic, &input, &format!("{}/SHOUT.QRE", base.to_str().unwrap()), &key(7), "local", None, None);
    assert_eq!(find_old_format_files_in(&base, false).len(), 1);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_scan_stops_at_the_depth_limit() {
    let base = fresh_dir("qre_relock_scan_depth");
    let input = write(&base, "a.bin", &noise(1000));
    let mut folder = base.clone();
    for level in 0..16 {
        folder = folder.join(format!("d{}", level));
    }
    fs::create_dir_all(&folder).unwrap();
    lock_old(FileFormat::Classic, &input, &format!("{}/too-deep.qre", folder.to_str().unwrap()), &key(7), "local", None, None);
    assert!(find_old_format_files_in(&base, true).is_empty(), "a file 16 folders down should be out of reach");
    let _ = fs::remove_dir_all(base);
}

#[cfg(unix)]
#[test]
fn test_the_scan_does_not_follow_links() {
    let base = make_tree("qre_relock_scan_links");
    std::os::unix::fs::symlink(base.join("sub"), base.join("link")).unwrap();
    std::os::unix::fs::symlink(base.join("six.qre"), base.join("link.qre")).unwrap();
    let found = find_old_format_files_in(&base, true);
    assert_eq!(found.iter().filter(|f| f.name == "nested.qre").count(), 1);
    assert!(!found.iter().any(|f| f.name == "link.qre"));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_scan_of_a_missing_or_empty_folder_finds_nothing() {
    let base = fresh_dir("qre_relock_scan_empty");
    assert!(find_old_format_files_in(&base, true).is_empty());
    assert!(find_old_format_files_in(&base.join("nope"), true).is_empty());
    let _ = fs::remove_dir_all(base);
}

// ─── The command ─────────────────────────────────────────────────────────────

type Events = Arc<Mutex<Vec<(String, u8)>>>;

fn recorder() -> (Progress, Events) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let progress: Progress = Arc::new(move |label: &str, pct: u8| sink.lock().unwrap().push((label.to_string(), pct)));
    (progress, events)
}

fn vaults_with(entries: &[(&str, u8)]) -> Vaults {
    let map: HashMap<String, MasterKey> = entries.iter().map(|(id, seed)| (id.to_string(), key(*seed))).collect();
    Arc::new(Mutex::new(map))
}

fn relock_cmd(paths: &[&str], keyfile: Option<Vec<u8>>, vaults: &Vaults) -> (Vec<BatchItemResult>, Events) {
    let (progress, events) = recorder();
    let results = relock_files_blocking(paths.iter().map(|p| p.to_string()).collect(), keyfile, vaults, &progress).unwrap();
    (results, events)
}

#[test]
fn test_the_command_upgrades_a_batch_and_reports_each_file() {
    let (base, out, input, data) = workspace("qre_relock_cmd_batch", 5000);
    let six = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &six, &key(7), "local", None, None);
    let eight = format!("{}.eight.qre", input);
    lock_old(FileFormat::V8, &input, &eight, &key(7), "local", None, None);
    let text = write(&base, "text.qre", b"not a locked file");
    let missing = base.join("nope.qre").to_str().unwrap().to_string();
    let plain = write(&base, "plain.txt", b"no extension");

    let (results, _) = relock_cmd(&[&six, &eight, &text, &missing, &plain], None, &vaults_with(&[("local", 7)]));

    let outcome: Vec<(bool, &str)> = results.iter().map(|r| (r.success, r.message.as_str())).collect();
    assert_eq!(outcome[0], (true, "Upgraded to the current format"));
    assert_eq!(outcome[1], (true, "Already in the current format"));
    assert!(!outcome[2].0 && outcome[2].1.contains("not a locked file"), "{:?}", outcome[2]);
    assert!(!outcome[3].0, "{:?}", outcome[3]);
    assert!(!outcome[4].0 && outcome[4].1.contains("not a locked file"), "{:?}", outcome[4]);
    assert_eq!(version_of(&six), 8);
    unlock(&six, &out, &key(7)).unwrap();
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_command_asks_for_the_key_file_when_one_is_needed() {
    let (base, _, input, _) = workspace("qre_relock_cmd_keyfile", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", Some(&[0xAB_u8; 32]), None);
    let before = fs::read(&locked).unwrap();

    let (results, _) = relock_cmd(&[&locked], None, &vaults_with(&[("local", 7)]));
    assert!(!results[0].success);
    assert!(results[0].message.contains("select that key file"), "{}", results[0].message);
    assert_eq!(fs::read(&locked).unwrap(), before);

    let (results, _) = relock_cmd(&[&locked], Some(vec![0xAB; 32]), &vaults_with(&[("local", 7)]));
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(version_of(&locked), 8);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_command_says_what_to_do_about_a_time_lock() {
    let (base, _, input, _) = workspace("qre_relock_cmd_timelock", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, Some(now() + 100_000));

    let (results, _) = relock_cmd(&[&locked], None, &vaults_with(&[("local", 7)]));

    assert!(!results[0].success);
    assert!(results[0].message.contains("time-locked"), "{}", results[0].message);
    assert!(results[0].message.contains("Upgrade it after the lock ends"), "{}", results[0].message);
    assert!(!results[0].message.starts_with("TIME_LOCKED:"), "the raw code leaked: {}", results[0].message);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_command_with_the_vault_locked_changes_nothing() {
    let (base, _, input, _) = workspace("qre_relock_cmd_vault_locked", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    let before = fs::read(&locked).unwrap();

    let (results, _) = relock_cmd(&[&locked], None, &vaults_with(&[]));

    assert_eq!(results[0].message, "Local Vault is locked.");
    assert_eq!(fs::read(&locked).unwrap(), before);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_command_uses_the_usb_vault_key_for_a_usb_file() {
    let (base, out, input, data) = workspace("qre_relock_cmd_usb", 5000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(42), "usb-1", None, None);

    let (without, _) = relock_cmd(&[&locked], None, &vaults_with(&[("local", 7)]));
    assert!(without[0].message.contains("Portable USB Vault"), "{}", without[0].message);
    assert_eq!(version_of(&locked), 6);

    let (with, _) = relock_cmd(&[&locked], None, &vaults_with(&[("local", 7), ("usb-1", 42)]));
    assert!(with[0].success, "{}", with[0].message);
    unlock(&locked, &out, &key(42)).unwrap();
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_command_refuses_a_protected_system_path() {
    let path = if cfg!(windows) { "C:\\Windows\\System32\\x.qre" } else { "/etc/x.qre" };
    let (results, _) = relock_cmd(&[path], None, &vaults_with(&[("local", 7)]));
    assert!(!results[0].success);
    assert!(results[0].message.contains("protected system path"), "{}", results[0].message);
}

#[test]
fn test_the_command_progress_fills_the_first_half_then_the_second() {
    let (base, _, input, _) = workspace("qre_relock_cmd_progress", 6 * 1024 * 1024);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);

    let (_, events) = relock_cmd(&[&locked], None, &vaults_with(&[("local", 7)]));
    let events = events.lock().unwrap();

    let upgrading: Vec<u8> = events.iter().filter(|(l, _)| l.starts_with("Upgrading")).map(|(_, p)| *p).collect();
    let checking: Vec<u8> = events.iter().filter(|(l, _)| l.starts_with("Checking")).map(|(_, p)| *p).collect();
    assert!(!upgrading.is_empty() && !checking.is_empty());
    assert!(upgrading.iter().all(|p| *p <= 50), "{:?}", upgrading);
    assert!(checking.iter().all(|p| *p >= 50), "{:?}", checking);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_commands_hand_their_work_to_the_functions_the_tests_call() {
    let files = include_str!("commands/files.rs");
    let relock = function_body(files, "pub async fn relock_file(");
    assert!(relock.contains("relock_files_blocking("));
    assert!(relock.contains("window_progress("));
    let find = function_body(files, "pub async fn find_old_format_files(");
    assert!(find.contains("reject_path_traversal("), "the scan no longer rejects a path with '..'");
    assert!(find.contains("find_old_format_files_in("));
    let blocking = function_body(files, "pub(crate) fn relock_files_blocking(");
    assert!(!blocking.contains("emit_progress"), "the plain function talks to the window directly");
    assert!(blocking.contains("reject_critical_path("));
}

// ─── The status the Files screen reads ───────────────────────────────────────

use crate::commands::timelock::{file_timelock_status, get_file_timelock_status};

#[test]
fn test_the_status_tells_the_screen_which_format_each_file_is_in() {
    let (base, _, input, _) = workspace("qre_relock_status", 3000);
    let dir = base.to_str().unwrap().to_string();
    let make = |name: &str, format: FileFormat, until: Option<u64>| {
        let out = format!("{}/{}", dir, name);
        lock_old(format, &input, &out, &key(7), "local", None, until);
        out
    };
    let six = make("six.qre", FileFormat::Classic, None);
    let seven_locked = make("seven_locked.qre", FileFormat::Classic, Some(FAR_FUTURE));
    let seven_ended = make("seven_ended.qre", FileFormat::Classic, Some(now() - 1000));
    let eight = make("eight.qre", FileFormat::V8, None);
    let eight_locked = make("eight_locked.qre", FileFormat::V8, Some(FAR_FUTURE));

    let at = now();
    let report: Vec<(u32, bool)> = [&six, &seven_locked, &seven_ended, &eight, &eight_locked]
        .iter()
        .map(|p| {
            let s = file_timelock_status(p, at);
            (s.format_version, s.is_locked)
        })
        .collect();
    assert_eq!(report, vec![(6, false), (7, true), (7, false), (8, false), (8, true)]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_status_of_a_file_that_cannot_be_read_is_version_0_and_not_locked() {
    let base = fresh_dir("qre_relock_status_missing");
    let missing = base.join("nope.qre").to_str().unwrap().to_string();
    let s = file_timelock_status(&missing, now());
    assert_eq!((s.format_version, s.is_locked, s.locked_until), (0, false, 0));
    let tiny = write(&base, "tiny.qre", b"ab");
    assert_eq!(file_timelock_status(&tiny, now()).format_version, 0);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_status_shows_the_new_format_after_an_upgrade() {
    let (base, _, input, _) = workspace("qre_relock_status_after", 3000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    assert_eq!(file_timelock_status(&locked, now()).format_version, 6);
    relock(&locked, &key(7), None).unwrap();
    assert_eq!(file_timelock_status(&locked, now()).format_version, 8);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_status_command_still_refuses_a_path_with_dots_and_reports_the_version() {
    let err = get_file_timelock_status("some/../file.qre".to_string()).unwrap_err();
    assert!(err.contains("Path traversal"), "{}", err);

    let (base, _, input, _) = workspace("qre_relock_status_cmd", 3000);
    let locked = format!("{}.qre", input);
    lock_old(FileFormat::Classic, &input, &locked, &key(7), "local", None, None);
    assert_eq!(get_file_timelock_status(locked).unwrap().format_version, 6);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_status_command_goes_through_the_function_that_reads_the_version() {
    let source = include_str!("commands/timelock.rs");
    assert!(function_body(source, "pub fn get_file_timelock_status(").contains("file_timelock_status("));
    assert!(function_body(source, "pub(crate) fn file_timelock_status(").contains("stream_version("));
}
