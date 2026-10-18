//! Verify after locking: opening a new locked file once, the way unlocking would, before the
//! lock is called done. These tests share their helpers with crypto_failure_tests.rs.

use crate::crypto_failure_tests::{chunk_ends, chunks_start, fresh_dir, function_body, key, lock, locked_file, names, noise, unlock, write};
use crate::crypto_stream;
use crate::keychain::MasterKey;
use std::fs;
use std::path::Path;

fn verify(path: &str, mk: &MasterKey) -> anyhow::Result<()> {
    crypto_stream::verify_locked_file(path, mk, None, |_, _| {})
}

#[test]
fn test_a_good_locked_file_verifies() {
    let (base, _, encrypted, _) = locked_file("qre_verify_good", 3 * 1024 * 1024);
    verify(&encrypted, &key(7)).unwrap();
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_verifying_writes_nothing_and_does_not_change_the_file() {
    let (base, out_dir, encrypted, _) = locked_file("qre_verify_readonly", 3 * 1024 * 1024);
    let before = fs::read(&encrypted).unwrap();
    let listing_before = (names(&base.join("in")), names(&out_dir));

    verify(&encrypted, &key(7)).unwrap();

    assert_eq!(fs::read(&encrypted).unwrap(), before);
    assert_eq!((names(&base.join("in")), names(&out_dir)), listing_before);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_empty_locked_file_verifies() {
    let base = fresh_dir("qre_verify_empty");
    let empty = write(&base, "empty.txt", b"");
    let encrypted = format!("{}.qre", empty);
    lock(&empty, &encrypted, &key(7)).unwrap();
    verify(&encrypted, &key(7)).unwrap();
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_damaged_chunk_fails_verification() {
    let (base, _, encrypted, _) = locked_file("qre_verify_damaged", 3 * 1024 * 1024);
    let mut bytes = fs::read(&encrypted).unwrap();
    let at = bytes.len() / 2;
    bytes[at] ^= 0x01;
    fs::write(&encrypted, bytes).unwrap();
    let err = verify(&encrypted, &key(7)).unwrap_err().to_string();
    assert!(err.contains("integrity"), "unexpected message: {}", err);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_off_between_chunks_fails_verification_by_its_hash() {
    let (base, _, encrypted, _) = locked_file("qre_verify_cut_between", 3 * 1024 * 1024);
    let bytes = fs::read(&encrypted).unwrap();
    let ends = chunk_ends(&bytes);
    fs::write(&encrypted, &bytes[..ends[ends.len() - 2]]).unwrap();
    let err = verify(&encrypted, &key(7)).unwrap_err().to_string();
    assert!(err.contains("INTEGRITY"), "unexpected message: {}", err);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_off_inside_a_chunk_fails_verification() {
    let (base, _, encrypted, _) = locked_file("qre_verify_cut_inside", 3 * 1024 * 1024);
    let bytes = fs::read(&encrypted).unwrap();
    fs::write(&encrypted, &bytes[..bytes.len() - 100]).unwrap();
    let err = verify(&encrypted, &key(7)).unwrap_err().to_string();
    assert!(err.contains("incomplete"), "unexpected message: {}", err);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_with_a_header_and_no_data_fails_verification() {
    // What a write that stopped right after the header leaves: a file that shows up in a
    // listing, looks the right kind, and holds nothing.
    let (base, _, encrypted, _) = locked_file("qre_verify_header_only", 3 * 1024 * 1024);
    let bytes = fs::read(&encrypted).unwrap();
    fs::write(&encrypted, &bytes[..chunks_start(&bytes)]).unwrap();

    let err = verify(&encrypted, &key(7)).unwrap_err().to_string();
    assert!(err.contains("INTEGRITY"), "unexpected message: {}", err);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_wrong_key_fails_verification() {
    let (base, _, encrypted, _) = locked_file("qre_verify_wrong_key", 5000);
    assert!(verify(&encrypted, &key(99)).is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_locked_with_a_keyfile_verifies_only_with_it() {
    let base = fresh_dir("qre_verify_keyfile");
    let input = write(&base, "doc.txt", b"under a key file");
    let encrypted = format!("{}.qre", input);
    let keyfile_hash = [0xAB_u8; 32];
    crypto_stream::encrypt_file_stream(&input, &encrypted, &key(5), "local", Some(&keyfile_hash), None, None, 1, |_, _| {}).unwrap();

    crypto_stream::verify_locked_file(&encrypted, &key(5), Some(&keyfile_hash), |_, _| {}).unwrap();
    assert!(crypto_stream::verify_locked_file(&encrypted, &key(5), None, |_, _| {}).is_err());
    assert!(crypto_stream::verify_locked_file(&encrypted, &key(5), Some(&[0xCD_u8; 32]), |_, _| {}).is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_time_locked_file_verifies_at_once_and_stays_unchanged() {
    let base = fresh_dir("qre_verify_timelock");
    let input = write(&base, "later.txt", &noise(2 * 1024 * 1024));
    let encrypted = format!("{}.qre", input);
    crypto_stream::encrypt_file_stream(&input, &encrypted, &key(6), "local", None, Some(4_000_000_000), None, 1, |_, _| {}).unwrap();
    let before = fs::read(&encrypted).unwrap();

    // The lock is far in the future, yet checking does not wait for it, and so does not need the
    // network. It must also leave the header, including the ratchet, exactly as it was.
    crypto_stream::verify_locked_file(&encrypted, &key(6), None, |_, _| {}).unwrap();
    assert_eq!(fs::read(&encrypted).unwrap(), before);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_verifying_a_time_locked_file_does_not_unlock_it() {
    let base = fresh_dir("qre_verify_timelock_stays");
    let input = write(&base, "later.txt", b"locked for a long time");
    let encrypted = format!("{}.qre", input);
    crypto_stream::encrypt_file_stream(&input, &encrypted, &key(6), "local", None, Some(4_000_000_000), None, 1, |_, _| {}).unwrap();

    crypto_stream::verify_locked_file(&encrypted, &key(6), None, |_, _| {}).unwrap();

    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let refused = unlock(&encrypted, &out_dir, &key(6)).unwrap_err().to_string();
    assert!(refused.starts_with("TIME_LOCKED:"), "unexpected message: {}", refused);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_damaged_time_locked_file_fails_verification() {
    let base = fresh_dir("qre_verify_timelock_damaged");
    let input = write(&base, "later.txt", &noise(2 * 1024 * 1024));
    let encrypted = format!("{}.qre", input);
    crypto_stream::encrypt_file_stream(&input, &encrypted, &key(6), "local", None, Some(4_000_000_000), None, 1, |_, _| {}).unwrap();
    let mut bytes = fs::read(&encrypted).unwrap();
    let at = bytes.len() - 50;
    bytes[at] ^= 0xFF;
    fs::write(&encrypted, bytes).unwrap();
    assert!(crypto_stream::verify_locked_file(&encrypted, &key(6), None, |_, _| {}).is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_verification_reports_progress_on_a_large_file() {
    let (base, _, encrypted, _) = locked_file("qre_verify_progress", 6 * 1024 * 1024);
    let calls = std::cell::Cell::new(0);
    let last = std::cell::Cell::new((0u64, 0u64));
    crypto_stream::verify_locked_file(&encrypted, &key(7), None, |done, total| {
        calls.set(calls.get() + 1);
        last.set((done, total));
    })
    .unwrap();
    assert!(calls.get() > 0, "no progress was reported");
    assert!(last.get().0 <= last.get().1, "progress went past the end: {:?}", last.get());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_that_fails_verification_is_removed_with_a_clear_message() {
    let (base, _, encrypted, _) = locked_file("qre_verify_removes_bad", 3 * 1024 * 1024);
    let mut bytes = fs::read(&encrypted).unwrap();
    let at = bytes.len() / 2;
    bytes[at] ^= 0xFF;
    fs::write(&encrypted, bytes).unwrap();

    let message = crypto_stream::verify_or_remove(&encrypted, &key(7), None, |_, _| {}).unwrap_err();

    assert!(message.starts_with("Verification failed:"), "unexpected message: {}", message);
    assert!(message.contains("The locked file was removed."));
    assert!(message.contains("Your original file has not been touched."));
    assert!(!Path::new(&encrypted).exists(), "the bad locked file was left in place");
    assert_eq!(names(&base.join("in")), ["data.bin"], "the original must still be there, alone");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_that_passes_verification_is_kept() {
    let (base, _, encrypted, _) = locked_file("qre_verify_keeps_good", 3 * 1024 * 1024);
    crypto_stream::verify_or_remove(&encrypted, &key(7), None, |_, _| {}).unwrap();
    assert!(Path::new(&encrypted).exists());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_verify_or_remove_on_a_missing_file_fails_without_panicking() {
    let base = fresh_dir("qre_verify_missing");
    let missing = base.join("nope.qre").to_str().unwrap().to_owned();
    let message = crypto_stream::verify_or_remove(&missing, &key(7), None, |_, _| {}).unwrap_err();
    assert!(message.starts_with("Verification failed:"));
    let _ = fs::remove_dir_all(base);
}

// ─── The commands really use it ──────────────────────────────────────────────
//
// The lock commands need a running app to call, so the places where they open the new file are
// checked in the source. If one of these fails, a lock path stopped checking its result.

#[test]
fn test_the_lock_command_checks_the_new_file_before_reporting_success() {
    let source = include_str!("commands/files.rs");
    let body = function_body(source, "pub(crate) fn lock_files_blocking(");
    assert!(body.contains("Ok(_) if verify =>"), "the check is no longer run when the request asks for it");
    let check = body.find("crypto_stream::verify_or_remove(").expect("lock_file no longer verifies");
    let success = body.find("\"Locked\".into()").expect("the plain success message is missing");
    assert!(check < success, "the check must come before any success is reported");
    assert!(body.contains("\"Locked and verified\""), "a checked lock should say it was checked");
}

#[test]
fn test_the_lock_command_removes_nothing_but_the_bad_locked_file_when_the_check_fails() {
    let source = include_str!("commands/files.rs");
    let body = function_body(source, "pub(crate) fn lock_files_blocking(");
    // The original (input) is never removed by this command, except the temporary zip of a folder.
    let removals: Vec<&str> = body.lines().filter(|l| l.contains("remove_file")).collect();
    assert!(removals.iter().all(|l| l.contains("input_path_str") || l.contains("final_path")), "unexpected removal: {:?}", removals);
}

#[test]
fn test_the_time_lock_command_checks_the_new_file_too() {
    let source = include_str!("commands/timelock.rs");
    let body = function_body(source, "pub(crate) fn lock_with_timelock_blocking(");
    assert!(body.contains("crypto_stream::verify_or_remove("));
    let when = body.find("if verify {").expect("the check no longer depends on the request");
    assert!(when < body.find("verify_or_remove(").unwrap(), "the check is not inside the 'if verify' block");
    // It reports a failure from the check before it reports the lock as done.
    let check = body.find("verify_or_remove(").unwrap();
    let done = body.find("\"Time-locked for").unwrap();
    assert!(check < done);
}

#[test]
fn test_the_check_never_applies_the_time_lock() {
    let stream = include_str!("crypto_stream.rs");
    let body = function_body(stream, "pub fn verify_locked_file(");
    assert!(body.contains("open_stream(input_path, master_key, keyfile_bytes, false)"));
    let unlock = function_body(stream, "pub fn decrypt_file_stream(");
    assert!(unlock.contains("open_stream(input_path, master_key, keyfile_bytes, true)"), "unlocking must still enforce the time-lock");
}
