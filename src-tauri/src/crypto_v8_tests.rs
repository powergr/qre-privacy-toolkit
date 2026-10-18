//! File format 8: the file name and the plaintext hash are hidden, every other field of the header
//! is authenticated, and the time-lock date cannot be edited. A V8 file has no ratchet and is
//! never written to after it is made.
//!
//! These tests write V8 files through `encrypt_file_stream_as`. The app does not write V8 by
//! default yet (see `DEFAULT_WRITE_FORMAT`), so the older formats are covered by the other test
//! files and by tests.rs. Helpers are shared with crypto_failure_tests.rs.

use crate::crypto_failure_tests::{fresh_dir, function_body, key, names, noise, unlock, write};
use crate::crypto_stream::{
    self, FileFormat, DEFAULT_WRITE_FORMAT,
};
use crate::keychain::MasterKey;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const FAR_FUTURE: u64 = 4_000_000_000; // the year 2096
const HEADER_LEN_AT: usize = 4;
pub(crate) const HEADER_AT: usize = HEADER_LEN_AT + 4;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn now() -> u64 {
    crate::timelock::now_secs()
}

fn lock8(input: &str, output: &str, mk: &MasterKey, until: Option<u64>) -> anyhow::Result<()> {
    crypto_stream::encrypt_file_stream_as(
        FileFormat::V8,
        input,
        output,
        mk,
        "local",
        None,
        until,
        None,
        1,
        |_, _| {},
    )
}

/// A V8 file made from `size` bytes of noise, with an empty folder to unlock into.
pub(crate) fn locked8(test: &str, size: usize, until: Option<u64>) -> (PathBuf, PathBuf, String, Vec<u8>) {
    let base = fresh_dir(test);
    let input_dir = base.join("in");
    let out_dir = base.join("out");
    fs::create_dir_all(&input_dir).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    let data = noise(size);
    let input = write(&input_dir, "data.bin", &data);
    let encrypted = format!("{}.qre", input);
    lock8(&input, &encrypted, &key(7), until).unwrap();
    (base, out_dir, encrypted, data)
}

pub(crate) fn verify(path: &str, mk: &MasterKey) -> anyhow::Result<()> {
    crypto_stream::verify_locked_file(path, mk, None, |_, _| {})
}

fn header_len(bytes: &[u8]) -> usize {
    u32::from_le_bytes(bytes[HEADER_LEN_AT..HEADER_AT].try_into().unwrap()) as usize
}

pub(crate) fn chunks_at(bytes: &[u8]) -> usize {
    HEADER_AT + header_len(bytes)
}

fn chunk_ends8(bytes: &[u8]) -> Vec<usize> {
    let mut pos = chunks_at(bytes);
    let mut ends = Vec::new();
    while pos + 4 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4 + len;
        ends.push(pos);
    }
    ends
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn unlocked_bytes(out_dir: &Path) -> Vec<u8> {
    fs::read(out_dir.join("data.bin")).unwrap()
}

// ─── The rollout switch ──────────────────────────────────────────────────────

#[test]
fn test_the_app_writes_format_8_by_default() {
    // Older apps cannot open V8, which is accepted: the app now writes it for every new file.
    // Whoever changes DEFAULT_WRITE_FORMAT must change this test on purpose.
    assert_eq!(DEFAULT_WRITE_FORMAT, FileFormat::V8);

    let base = fresh_dir("qre_v8_default");
    let input = write(&base, "a.txt", b"hello");
    let plain = format!("{}.qre", input);
    crypto_stream::encrypt_file_stream(&input, &plain, &key(7), "local", None, None, None, 1, |_, _| {}).unwrap();
    assert_eq!(fs::read(&plain).unwrap()[..4], 8u32.to_le_bytes());

    let timed = format!("{}.timed.qre", input);
    crypto_stream::encrypt_file_stream(&input, &timed, &key(7), "local", None, Some(FAR_FUTURE), None, 1, |_, _| {}).unwrap();
    assert_eq!(fs::read(&timed).unwrap()[..4], 8u32.to_le_bytes());

    let name = String::from_utf8_lossy(&fs::read(&plain).unwrap()).to_string();
    assert!(!name.contains("a.txt"), "the default format shows the file name");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_starts_with_version_8_with_or_without_a_time_lock() {
    let (base, _, plain, _) = locked8("qre_v8_version_plain", 5000, None);
    assert_eq!(fs::read(&plain).unwrap()[..4], 8u32.to_le_bytes());
    let (base2, _, timed, _) = locked8("qre_v8_version_timed", 5000, Some(FAR_FUTURE));
    assert_eq!(fs::read(&timed).unwrap()[..4], 8u32.to_le_bytes());
    let _ = fs::remove_dir_all(base);
    let _ = fs::remove_dir_all(base2);
}

// ─── Round trips ─────────────────────────────────────────────────────────────

#[test]
fn test_a_v8_file_unlocks_to_the_same_bytes_and_name() {
    let (base, out_dir, encrypted, data) = locked8("qre_v8_roundtrip", 5000, None);
    assert_eq!(unlock(&encrypted, &out_dir, &key(7)).unwrap(), "data.bin");
    assert_eq!(unlocked_bytes(&out_dir), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_of_several_chunks_unlocks_to_the_same_bytes() {
    let (base, out_dir, encrypted, data) = locked8("qre_v8_chunks", 2 * 1024 * 1024 + 12345, None);
    unlock(&encrypted, &out_dir, &key(7)).unwrap();
    assert_eq!(unlocked_bytes(&out_dir), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_empty_file_locks_and_unlocks_in_v8() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_empty", 0, None);
    unlock(&encrypted, &out_dir, &key(7)).unwrap();
    assert_eq!(unlocked_bytes(&out_dir), Vec::<u8>::new());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_names_with_spaces_and_accents_come_back_in_v8() {
    let base = fresh_dir("qre_v8_names");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let input = write(&base, "Café résumé 2026 (final).txt", b"content");
    let encrypted = format!("{}.qre", input);
    lock8(&input, &encrypted, &key(7), None).unwrap();
    assert_eq!(unlock(&encrypted, &out_dir, &key(7)).unwrap(), "Café résumé 2026 (final).txt");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_with_a_keyfile_opens_only_with_it() {
    let base = fresh_dir("qre_v8_keyfile");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let input = write(&base, "doc.txt", b"under a key file");
    let encrypted = format!("{}.qre", input);
    let keyfile_hash = [0xAB_u8; 32];
    crypto_stream::encrypt_file_stream_as(FileFormat::V8, &input, &encrypted, &key(5), "local", Some(&keyfile_hash), None, None, 1, |_, _| {}).unwrap();

    let out = out_dir.to_str().unwrap();
    assert!(crypto_stream::decrypt_file_stream(&encrypted, out, &key(5), None, |_, _| {}).is_err());
    assert!(crypto_stream::decrypt_file_stream(&encrypted, out, &key(5), Some(&[0xCD_u8; 32]), |_, _| {}).is_err());
    assert!(names(&out_dir).is_empty());
    assert_eq!(crypto_stream::decrypt_file_stream(&encrypted, out, &key(5), Some(&keyfile_hash), |_, _| {}).unwrap(), "doc.txt");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_time_lock_that_has_passed_opens_a_v8_file() {
    let (base, out_dir, encrypted, data) = locked8("qre_v8_expired", 5000, Some(now() - 1000));
    unlock(&encrypted, &out_dir, &key(7)).unwrap();
    assert_eq!(unlocked_bytes(&out_dir), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_time_lock_still_running_refuses_a_v8_file() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_running", 5000, Some(now() + 100_000));
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.starts_with("TIME_LOCKED:"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_locked_v8_file_does_not_say_whether_the_password_was_right() {
    // The lock is checked before any key, so a wrong password gets the same answer.
    let (base, out_dir, encrypted, _) = locked8("qre_v8_same_answer", 5000, Some(now() + 100_000));
    let right = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    let wrong = unlock(&encrypted, &out_dir, &key(99)).unwrap_err().to_string();
    assert!(right.starts_with("TIME_LOCKED:") && wrong.starts_with("TIME_LOCKED:"));
    let _ = fs::remove_dir_all(base);
}

// ─── What is hidden ──────────────────────────────────────────────────────────

#[test]
fn test_a_v8_file_shows_neither_the_name_nor_the_hash() {
    let base = fresh_dir("qre_v8_hidden");
    let data = noise(30_000);
    let input = write(&base, "secret-plans-2026.docx", &data);
    let hash = Sha256::digest(&data);

    let v8 = format!("{}.v8.qre", input);
    lock8(&input, &v8, &key(7), None).unwrap();
    let v8_bytes = fs::read(&v8).unwrap();
    assert!(!contains(&v8_bytes, b"secret-plans-2026"), "the file name is readable in a V8 file");
    assert!(!contains(&v8_bytes, b"docx"));
    assert!(!contains(&v8_bytes, &hash), "the plaintext hash is readable in a V8 file");

    // Control: the older format does show both, so the checks above can fail.
    let v6 = format!("{}.v6.qre", input);
    crypto_stream::encrypt_file_stream_as(FileFormat::Classic, &input, &v6, &key(7), "local", None, None, None, 1, |_, _| {}).unwrap();
    let v6_bytes = fs::read(&v6).unwrap();
    assert!(contains(&v6_bytes, b"secret-plans-2026.docx"));
    assert!(contains(&v6_bytes, &hash));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_gives_nothing_but_the_vault_and_the_date_without_the_key() {
    let (base, _, encrypted, _) = locked8("qre_v8_public", 5000, Some(FAR_FUTURE));
    let path = encrypted.as_str();
    assert_eq!(crypto_stream::read_vault_id(path).as_deref(), Some("local"));
    assert_eq!(crypto_stream::read_timelock_header(path).unwrap().unwrap().locked_until, FAR_FUTURE);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_without_a_time_lock_has_no_time_lock_header() {
    let (base, _, encrypted, _) = locked8("qre_v8_no_timelock", 5000, None);
    assert!(crypto_stream::read_timelock_header(&encrypted).unwrap().is_none());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_vault_of_every_format_can_be_read_without_a_key() {
    let base = fresh_dir("qre_v8_vault_ids");
    let input = write(&base, "a.txt", b"hello");
    for (format, until, name) in [
        (FileFormat::Classic, None, "six"),
        (FileFormat::Classic, Some(FAR_FUTURE), "seven"),
        (FileFormat::V8, None, "eight"),
        (FileFormat::V8, Some(FAR_FUTURE), "eight_timed"),
    ] {
        let out = format!("{}.{}.qre", input, name);
        crypto_stream::encrypt_file_stream_as(format, &input, &out, &key(7), "usb-1234", None, until, None, 1, |_, _| {}).unwrap();
        assert_eq!(crypto_stream::read_vault_id(&out).as_deref(), Some("usb-1234"), "{}", name);
    }
    assert_eq!(crypto_stream::read_vault_id(&format!("{}.missing", input)), None);
    assert_eq!(crypto_stream::read_vault_id(&input), None, "a text file is not a locked file");
    let _ = fs::remove_dir_all(base);
}

// ─── Wrong keys ──────────────────────────────────────────────────────────────

#[test]
fn test_a_wrong_password_is_refused_and_creates_nothing() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_wrong_password", 5000, None);
    let err = unlock(&encrypted, &out_dir, &key(99)).unwrap_err().to_string();
    assert!(err.starts_with("Decryption Denied"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_wrong_password_is_refused_on_a_time_locked_file_whose_lock_has_passed() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_wrong_password_timed", 5000, Some(now() - 1000));
    let err = unlock(&encrypted, &out_dir, &key(99)).unwrap_err().to_string();
    assert!(err.starts_with("Decryption Denied"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

// ─── The header cannot be changed ────────────────────────────────────────────

#[test]
fn test_no_byte_of_the_header_of_a_v8_file_can_be_changed() {
    // Every byte from the length to the end of the header: flipping any one of them must make
    // the file refuse to open.
    let (base, out_dir, encrypted, _) = locked8("qre_v8_every_byte", 100_000, None);
    let original = fs::read(&encrypted).unwrap();
    let end = chunks_at(&original);
    let damaged = format!("{}.damaged.qre", encrypted);

    let mut survivors = Vec::new();
    for at in HEADER_LEN_AT..end {
        let mut bytes = original.clone();
        bytes[at] ^= 0x01;
        fs::write(&damaged, &bytes).unwrap();
        if unlock(&damaged, &out_dir, &key(7)).is_ok() {
            survivors.push(at - HEADER_AT);
        }
    }
    assert!(survivors.is_empty(), "changing these header bytes did not matter: {:?}", survivors);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_no_byte_of_the_header_of_a_time_locked_v8_file_can_be_changed() {
    // Same, for a time-locked file, which has the date and the sealed binding key in its header.
    // Checked without applying the lock, so no clock or network is involved.
    let (base, _, encrypted, _) = locked8("qre_v8_every_byte_timed", 100_000, Some(FAR_FUTURE));
    let original = fs::read(&encrypted).unwrap();
    verify(&encrypted, &key(7)).unwrap();
    let end = chunks_at(&original);
    let damaged = format!("{}.damaged.qre", encrypted);

    let mut survivors = Vec::new();
    for at in HEADER_LEN_AT..end {
        let mut bytes = original.clone();
        bytes[at] ^= 0x01;
        fs::write(&damaged, &bytes).unwrap();
        if verify(&damaged, &key(7)).is_ok() {
            survivors.push(at - HEADER_AT);
        }
    }
    assert!(survivors.is_empty(), "changing these header bytes did not matter: {:?}", survivors);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_cut_off_anywhere_in_its_header_is_refused_without_a_crash() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_cut_header", 100_000, Some(FAR_FUTURE));
    let original = fs::read(&encrypted).unwrap();
    let cut = format!("{}.cut.qre", encrypted);
    for len in 0..chunks_at(&original) {
        fs::write(&cut, &original[..len]).unwrap();
        assert!(unlock(&cut, &out_dir, &key(7)).is_err(), "a file cut at {} bytes opened", len);
    }
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_padding_added_after_the_header_is_refused() {
    // The header length must match the header exactly. If extra bytes were allowed, two
    // different files would open as the same file, which is a gap in a format that claims every
    // header byte matters.
    let (base, out_dir, encrypted, _) = locked8("qre_v8_padding", 5000, None);
    let bytes = fs::read(&encrypted).unwrap();
    let start = chunks_at(&bytes);
    let mut padded = bytes[..start].to_vec();
    padded.extend_from_slice(&[0u8; 7]);
    let new_len = (header_len(&bytes) + 7) as u32;
    padded[HEADER_LEN_AT..HEADER_AT].copy_from_slice(&new_len.to_le_bytes());
    padded.extend_from_slice(&bytes[start..]);
    fs::write(&encrypted, padded).unwrap();

    assert!(unlock(&encrypted, &out_dir, &key(7)).is_err());
    assert!(verify(&encrypted, &key(7)).is_err());
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_absurd_header_length_is_refused_before_anything_is_allocated() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_huge_header", 5000, None);
    let mut bytes = fs::read(&encrypted).unwrap();
    bytes[HEADER_LEN_AT..HEADER_AT].copy_from_slice(&u32::MAX.to_le_bytes());
    fs::write(&encrypted, bytes).unwrap();
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("invalid header length"), "unexpected message: {}", err);

    let mut zero = fs::read(&encrypted).unwrap();
    zero[HEADER_LEN_AT..HEADER_AT].copy_from_slice(&0u32.to_le_bytes());
    fs::write(&encrypted, zero).unwrap();
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("invalid header length"), "unexpected message: {}", err);
    let _ = fs::remove_dir_all(base);
}

/// The same file with its header changed and written again properly, so the file is well formed
/// and only the content of the header differs. This is what someone with a tool would do, as
/// opposed to a hex editor.
pub(crate) fn with_header_rewritten(encrypted: &str, change: impl FnOnce(&mut crypto_stream::StreamHeaderV8)) {
    let bytes = fs::read(encrypted).unwrap();
    let mut header = crypto_stream::read_v8_header(&mut std::io::Cursor::new(&bytes[4..])).unwrap();
    change(&mut header);
    let new_header = bincode::serialize(&header).unwrap();

    let mut out = bytes[..HEADER_LEN_AT].to_vec();
    out.extend_from_slice(&(new_header.len() as u32).to_le_bytes());
    out.extend_from_slice(&new_header);
    out.extend_from_slice(&bytes[chunks_at(&bytes)..]);
    fs::write(encrypted, out).unwrap();
}

#[test]
fn test_a_rewritten_header_that_is_unchanged_still_opens() {
    // The helper itself must not be what breaks the file, or the tests below prove nothing.
    let (base, out_dir, encrypted, data) = locked8("qre_v8_rewrite_same", 5000, None);
    with_header_rewritten(&encrypted, |_| {});
    unlock(&encrypted, &out_dir, &key(7)).unwrap();
    assert_eq!(unlocked_bytes(&out_dir), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_taking_the_time_lock_out_of_a_v8_header_does_not_open_the_file() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_strip_lock", 5000, Some(FAR_FUTURE));
    with_header_rewritten(&encrypted, |h| h.timelock = None);

    assert!(unlock(&encrypted, &out_dir, &key(7)).is_err());
    assert!(verify(&encrypted, &key(7)).is_err());
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_changing_the_vault_in_a_v8_header_does_not_open_the_file() {
    // The vault id decides which key the app tries. It is in the clear, so it must be bound.
    for (test, vault) in [("qre_v8_vault_other", Some("usb-other".to_string())), ("qre_v8_vault_none", None)] {
        let (base, out_dir, encrypted, _) = locked8(test, 5000, None);
        with_header_rewritten(&encrypted, |h| h.vault_id = vault);
        assert!(unlock(&encrypted, &out_dir, &key(7)).is_err(), "{}", test);
        assert!(names(&out_dir).is_empty());
        let _ = fs::remove_dir_all(base);
    }
}

// ─── The date ────────────────────────────────────────────────────────────────

fn with_date_changed(encrypted: &str, from: u64, to: u64) {
    let mut bytes = fs::read(encrypted).unwrap();
    let at = bytes
        .windows(8)
        .position(|w| w == from.to_le_bytes())
        .expect("the date is stored in the header");
    assert!(at < chunks_at_any(&bytes), "the date was found outside the header");
    bytes[at..at + 8].copy_from_slice(&to.to_le_bytes());
    fs::write(encrypted, bytes).unwrap();
}

/// The end of the header, for V8 and for V7.
fn chunks_at_any(bytes: &[u8]) -> usize {
    if bytes[..4] == 8u32.to_le_bytes() {
        chunks_at(bytes)
    } else {
        4 + 4096
    }
}

#[test]
fn test_a_date_moved_into_the_past_does_not_open_a_v8_file() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_date_past", 5000, Some(FAR_FUTURE));
    with_date_changed(&encrypted, FAR_FUTURE, 1);

    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("header was changed"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty());
    assert!(verify(&encrypted, &key(7)).is_err(), "checking must catch the edit too");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_date_moved_a_little_into_the_past_does_not_open_a_v8_file() {
    // A date that has already passed is the case the clock alone would wave through.
    let until = now() + 100_000;
    let (base, out_dir, encrypted, _) = locked8("qre_v8_date_little", 5000, Some(until));
    with_date_changed(&encrypted, until, now() - 10);

    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("header was changed"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_date_moved_into_the_future_does_not_open_a_v8_file() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_date_future", 5000, Some(now() - 1000));
    let original = fs::read(&encrypted).unwrap();
    let date = crypto_stream::read_timelock_header(&encrypted).unwrap().unwrap().locked_until;
    with_date_changed(&encrypted, date, FAR_FUTURE);
    assert_ne!(fs::read(&encrypted).unwrap(), original);

    assert!(unlock(&encrypted, &out_dir, &key(7)).is_err());
    assert!(verify(&encrypted, &key(7)).is_err());
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_same_edit_does_open_a_version_7_file() {
    // This is why V8 exists. In V7 the date is only a number in the header, so a hex editor is
    // enough. If V7 is ever fixed, this test is the one to delete.
    let base = fresh_dir("qre_v8_control_v7");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let input = write(&base, "data.bin", b"locked for a long time");
    let encrypted = format!("{}.qre", input);
    crypto_stream::encrypt_file_stream_as(FileFormat::Classic, &input, &encrypted, &key(7), "local", None, Some(FAR_FUTURE), None, 1, |_, _| {}).unwrap();
    assert_eq!(fs::read(&encrypted).unwrap()[..4], 7u32.to_le_bytes());

    with_date_changed(&encrypted, FAR_FUTURE, 1);
    assert_eq!(unlock(&encrypted, &out_dir, &key(7)).unwrap(), "data.bin");
    let _ = fs::remove_dir_all(base);
}

// ─── No ratchet: a V8 file is never changed ─────────────────────────────────

#[test]
fn test_a_refused_attempt_changes_nothing_in_a_v8_file() {
    // The ratchet used to be rewritten on every refusal. It could never change the answer, since it
    // was only written while the time was earlier than the date, so V8 does not have one. The
    // file must stay byte for byte as it was made.
    let (base, out_dir, encrypted, _) = locked8("qre_v8_untouched", 100_000, Some(now() + 100_000));
    let before = fs::read(&encrypted).unwrap();

    for _ in 0..2 {
        let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
        assert!(err.starts_with("TIME_LOCKED:"), "{}", err);
    }
    assert_eq!(fs::read(&encrypted).unwrap(), before, "a refused attempt wrote to the file");
    verify(&encrypted, &key(7)).unwrap();
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_unlocking_a_v8_file_does_not_change_it_either() {
    let (base, out_dir, encrypted, data) = locked8("qre_v8_untouched_open", 5000, Some(now() - 1000));
    let before = fs::read(&encrypted).unwrap();
    unlock(&encrypted, &out_dir, &key(7)).unwrap();
    assert_eq!(unlocked_bytes(&out_dir), data);
    assert_eq!(fs::read(&encrypted).unwrap(), before);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_no_version_byte_of_a_v8_file_can_be_changed() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_version_bytes", 5000, None);
    let original = fs::read(&encrypted).unwrap();
    let damaged = format!("{}.damaged.qre", encrypted);
    for at in 0..4 {
        let mut bytes = original.clone();
        bytes[at] ^= 0x01;
        fs::write(&damaged, &bytes).unwrap();
        assert!(unlock(&damaged, &out_dir, &key(7)).is_err(), "version byte {}", at);
    }
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

// ─── The header digest, against an independent calculation ───────────────────

/// A header whose every field is a known fill byte, so that another program can compute the digest
/// from FILE_FORMAT.md alone. The expected values below came from a separate Node.js program that
/// was written from the specification and does not share any code with this one.
fn known_header(vault: Option<&str>, timelock: bool) -> crypto_stream::StreamHeaderV8 {
    crypto_stream::StreamHeaderV8 {
        vault_id: vault.map(|v| v.to_string()),
        validation_nonce: vec![1; 12],
        encrypted_validation_tag: vec![2; 25],
        key_wrapping_nonce: vec![3; 12],
        encrypted_file_key: vec![4; 48],
        base_nonce: vec![5; 12],
        meta_nonce: vec![6; 12],
        encrypted_meta: vec![7; 73],
        timelock: if timelock {
            Some(crypto_stream::SealedTimeLock {
                locked_until: 4_000_000_000,
                encrypted_binding_key: vec![8; 48],
                binding_key_nonce: vec![9; 12],
            })
        } else {
            None
        },
    }
}

fn hex(bytes: [u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[test]
fn test_the_header_digest_matches_the_independent_calculation() {
    let plain = known_header(Some("local"), false);
    assert_eq!(bincode::serialized_size(&plain).unwrap(), 265);
    assert_eq!(hex(crypto_stream::header_binding(&plain)), "f8523be037a8817c62554ef07a2fae57b00b407d399212450ffad9b413eb8bec");

    let timed = known_header(Some("local"), true);
    assert_eq!(bincode::serialized_size(&timed).unwrap(), 349);
    assert_eq!(hex(crypto_stream::header_binding(&timed)), "59f4ee7f8b66376e8ee50f2573cf9780c7ccf4778384d45d3ce8b6c3ef77843f");

    let no_vault = known_header(None, false);
    assert_eq!(bincode::serialized_size(&no_vault).unwrap(), 252);
    assert_eq!(hex(crypto_stream::header_binding(&no_vault)), "fa360d6746e0025656a0d0e33cb20c532cee09f1819ed7939c7ccedbe86f54f9");
}

#[test]
fn test_the_digest_covers_the_stored_length_of_the_header() {
    // Same fields, one more byte in a sealed field: the stored length differs, and so must the digest.
    let a = known_header(Some("local"), false);
    let mut b = known_header(Some("local"), false);
    b.encrypted_meta.push(7);
    assert_ne!(crypto_stream::header_binding(&a), crypto_stream::header_binding(&b));
}

#[test]
fn test_the_digest_does_not_depend_on_the_content_of_the_sealed_fields() {
    // The three sealed fields authenticate themselves and are left out of the digest, only their
    // sizes count. This is what lets the digest be computed before they are made.
    let a = known_header(Some("local"), true);
    let mut b = known_header(Some("local"), true);
    b.encrypted_validation_tag = vec![0xAA; 25];
    b.encrypted_file_key = vec![0xBB; 48];
    b.encrypted_meta = vec![0xCC; 73];
    assert_eq!(crypto_stream::header_binding(&a), crypto_stream::header_binding(&b));
}

#[test]
fn test_the_digest_changes_with_every_field_it_covers() {
    let base = crypto_stream::header_binding(&known_header(Some("local"), true));
    let mut changed = Vec::new();
    let mut each = |name: &str, edit: &dyn Fn(&mut crypto_stream::StreamHeaderV8)| {
        let mut h = known_header(Some("local"), true);
        edit(&mut h);
        if crypto_stream::header_binding(&h) == base {
            changed.push(name.to_string());
        }
    };
    each("vault_id", &|h| h.vault_id = Some("locam".into()));
    each("validation_nonce", &|h| h.validation_nonce[0] ^= 1);
    each("key_wrapping_nonce", &|h| h.key_wrapping_nonce[0] ^= 1);
    each("base_nonce", &|h| h.base_nonce[0] ^= 1);
    each("meta_nonce", &|h| h.meta_nonce[0] ^= 1);
    each("locked_until", &|h| h.timelock.as_mut().unwrap().locked_until += 1);
    each("encrypted_binding_key", &|h| h.timelock.as_mut().unwrap().encrypted_binding_key[0] ^= 1);
    each("binding_key_nonce", &|h| h.timelock.as_mut().unwrap().binding_key_nonce[0] ^= 1);
    each("time-lock removed", &|h| h.timelock = None);
    assert!(changed.is_empty(), "these fields do not change the digest: {:?}", changed);
}

// ─── Damage to the data ──────────────────────────────────────────────────────

#[test]
fn test_a_damaged_chunk_leaves_no_partial_plaintext_in_v8() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_damaged_chunk", 3 * 1024 * 1024, None);
    let mut bytes = fs::read(&encrypted).unwrap();
    let at = bytes.len() * 3 / 4;
    bytes[at] ^= 0x01;
    fs::write(&encrypted, bytes).unwrap();
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("integrity"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_cut_off_between_chunks_is_caught_by_its_hidden_hash() {
    // The hash is inside the encrypted details now, so it cannot be stripped from the header to
    // hide a cut file.
    let (base, out_dir, encrypted, _) = locked8("qre_v8_cut_between", 3 * 1024 * 1024, None);
    let bytes = fs::read(&encrypted).unwrap();
    let ends = chunk_ends8(&bytes);
    assert!(ends.len() >= 3);
    fs::write(&encrypted, &bytes[..ends[ends.len() - 2]]).unwrap();
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("INTEGRITY"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_cut_off_inside_a_chunk_is_refused() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_cut_inside", 3 * 1024 * 1024, None);
    let bytes = fs::read(&encrypted).unwrap();
    fs::write(&encrypted, &bytes[..bytes.len() - 100]).unwrap();
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("incomplete"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_v8_file_with_a_header_and_no_data_is_refused() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_header_only", 3 * 1024 * 1024, None);
    let bytes = fs::read(&encrypted).unwrap();
    fs::write(&encrypted, &bytes[..chunks_at(&bytes)]).unwrap();
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("INTEGRITY"), "unexpected message: {}", err);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_chunks_swapped_inside_a_v8_file_are_refused() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8_swapped", 3 * 1024 * 1024, None);
    let bytes = fs::read(&encrypted).unwrap();
    let ends = chunk_ends8(&bytes);
    let start = chunks_at(&bytes);
    let first = &bytes[start..ends[0]];
    let second = &bytes[ends[0]..ends[1]];
    let mut swapped = bytes[..start].to_vec();
    swapped.extend_from_slice(second);
    swapped.extend_from_slice(first);
    swapped.extend_from_slice(&bytes[ends[1]..]);
    fs::write(&encrypted, swapped).unwrap();
    assert!(unlock(&encrypted, &out_dir, &key(7)).is_err());
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_data_of_one_v8_file_does_not_open_under_the_header_of_another() {
    // Two files from the same data and the same master key. Each has its own file key, so the
    // data of one never opens under the header of the other.
    let base = fresh_dir("qre_v8_transplant");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let input = write(&base, "data.bin", &noise(50_000));
    let a = format!("{}.a.qre", input);
    let b = format!("{}.b.qre", input);
    lock8(&input, &a, &key(7), None).unwrap();
    lock8(&input, &b, &key(7), None).unwrap();

    let a_bytes = fs::read(&a).unwrap();
    let b_bytes = fs::read(&b).unwrap();
    let mut mixed = b_bytes[..chunks_at(&b_bytes)].to_vec();
    mixed.extend_from_slice(&a_bytes[chunks_at(&a_bytes)..]);
    fs::write(&b, mixed).unwrap();
    assert!(unlock(&b, &out_dir, &key(7)).is_err());
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

// ─── Checking after locking ──────────────────────────────────────────────────

#[test]
fn test_a_v8_file_verifies_and_stays_unchanged_even_when_time_locked_for_years() {
    let (base, _, encrypted, _) = locked8("qre_v8_verify", 2 * 1024 * 1024, Some(FAR_FUTURE));
    let before = fs::read(&encrypted).unwrap();
    verify(&encrypted, &key(7)).unwrap();
    assert_eq!(fs::read(&encrypted).unwrap(), before, "checking must not change the file or its ratchet");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_verifying_a_damaged_v8_file_fails() {
    let (base, _, encrypted, _) = locked8("qre_v8_verify_damaged", 2 * 1024 * 1024, None);
    let mut bytes = fs::read(&encrypted).unwrap();
    let at = bytes.len() - 50;
    bytes[at] ^= 0xFF;
    fs::write(&encrypted, bytes).unwrap();
    assert!(verify(&encrypted, &key(7)).is_err());
    let _ = fs::remove_dir_all(base);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

#[test]
fn test_batch_unlock_reads_the_vault_of_every_format_through_one_function() {
    // The old code parsed a V6 header from the open file, which is wrong for V8. The vault must
    // be found with read_vault_id, and version 8 must be accepted at all.
    let source = include_str!("commands/files.rs");
    let body = function_body(source, "pub(crate) fn unlock_files_blocking(");
    assert!(body.contains("crypto_stream::read_vault_id(&file_path)"));
    assert!(body.contains("(5..=8).contains(&version)"));
    assert!(!body.contains("deserialize_from(&mut file)"));
}

#[test]
fn test_a_version_7_file_still_records_its_ratchet_when_refused() {
    // The app no longer writes V7, but files made before are still read, and their ratchet is
    // still kept up to date in the fixed header region.
    let base = fresh_dir("qre_v8_v7_ratchet");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let input = write(&base, "old.txt", b"made by an older version");
    let encrypted = format!("{}.qre", input);
    crypto_stream::encrypt_file_stream_as(FileFormat::Classic, &input, &encrypted, &key(7), "local", None, Some(now() + 100_000), None, 1, |_, _| {}).unwrap();
    let before = fs::read(&encrypted).unwrap();

    assert!(unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string().starts_with("TIME_LOCKED:"));
    let after = fs::read(&encrypted).unwrap();

    assert_eq!(after.len(), before.len());
    assert_ne!(after[4..4100], before[4..4100], "the ratchet was not written");
    assert_eq!(after[..4], before[..4]);
    assert_eq!(after[4100..], before[4100..], "the data changed");
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_older_formats_are_still_read() {
    // Old files are read for as long as the app exists.
    let base = fresh_dir("qre_v8_old_formats");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let input = write(&base, "old.txt", b"made by an older version");
    for (until, version) in [(None, 6u32), (Some(now() - 1000), 7u32)] {
        let encrypted = format!("{}.{}.qre", input, version);
        crypto_stream::encrypt_file_stream_as(FileFormat::Classic, &input, &encrypted, &key(7), "local", None, until, None, 1, |_, _| {}).unwrap();
        assert_eq!(fs::read(&encrypted).unwrap()[..4], version.to_le_bytes());
        assert_eq!(unlock(&encrypted, &out_dir, &key(7)).unwrap(), "old.txt");
        let _ = fs::remove_file(out_dir.join("old.txt"));
    }
    let _ = fs::remove_dir_all(base);
}
