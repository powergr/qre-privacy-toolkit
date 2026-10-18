//! Vault files (passwords, notes, bookmarks, clipboard history) in file format 8. They are the
//! same format as a locked file, so the name and the hash are sealed, the header is covered by the
//! header digest, and a damaged or swapped file is refused. Old vault files, in the container
//! format of version 4, are still read and are rewritten in format 8 at once.

use crate::commands::vault::{read_vault_file, write_vault_file};
use crate::crypto::{self, EncryptedFileContainer};
use crate::crypto_failure_tests::{fresh_dir, function_body, key, names, noise};
use crate::crypto_stream::{self, open_vault_file, seal_vault_file, MAX_VAULT_BYTES};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
struct Sample {
    title: String,
    items: Vec<String>,
}

fn sample() -> Sample {
    Sample { title: "My passwords".to_string(), items: vec!["bank".to_string(), "mail".to_string(), "café".to_string()] }
}

fn json(value: &Sample) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn open(path: &Path, k: u8, name: &str) -> anyhow::Result<Vec<u8>> {
    open_vault_file(path, &key(k), name).map(|c| c.to_vec())
}

fn version_of(path: &Path) -> Option<u32> {
    crypto_stream::stream_version(path.to_str().unwrap())
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// A vault file as the app writes it, with the content and the path.
fn saved(test: &str, name: &str, content: &[u8]) -> (std::path::PathBuf, std::path::PathBuf) {
    let base = fresh_dir(test);
    let path = base.join(format!("{}.qre", name.trim_end_matches(".json")));
    seal_vault_file(&path, "local", &key(5), name, content).unwrap();
    (base, path)
}

// ─── Writing and reading ─────────────────────────────────────────────────────

#[test]
fn test_a_vault_file_is_written_in_format_8_and_reads_back() {
    let (base, path) = saved("qre_vault8_roundtrip", "passwords.json", &json(&sample()));
    assert_eq!(version_of(&path), Some(8));
    assert_eq!(open(&path, 5, "passwords.json").unwrap(), json(&sample()));
    assert_eq!(names(&base), ["passwords.qre"], "nothing but the vault file may be left in the folder");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_content_of_every_size_survives_including_several_chunks_and_nothing_at_all() {
    for (label, size) in [("empty", 0usize), ("one", 1), ("small", 500), ("one_chunk", 1024 * 1024), ("over_a_chunk", 1024 * 1024 + 1), ("three_chunks", 3 * 1024 * 1024 + 17)] {
        let content = noise(size);
        let (base, path) = saved(&format!("qre_vault8_size_{}", label), "notes.json", &content);
        assert_eq!(open(&path, 5, "notes.json").unwrap(), content, "size {} came back different", size);
        let _ = fs::remove_dir_all(base);
    }
}

#[test]
fn test_a_vault_file_shows_nothing_about_its_content_name_or_hash() {
    let marker = "TOP-SECRET-MARKER";
    let content = json(&Sample { title: marker.to_string(), items: vec![] });
    let (base, path) = saved("qre_vault8_hidden", "passwords.json", &content);
    let raw = fs::read(&path).unwrap();

    assert!(!contains(&raw, marker.as_bytes()), "the content is readable");
    assert!(!contains(&raw, b"passwords"), "the inner name is readable");
    assert!(!contains(&raw, b"json"), "the inner name is readable");
    use sha2::{Digest, Sha256};
    assert!(!contains(&raw, &Sha256::digest(&content)), "the hash of the content is readable");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_vault_id_is_stored_in_the_header_as_for_a_locked_file() {
    let base = fresh_dir("qre_vault8_id");
    let path = base.join("notes.qre");
    seal_vault_file(&path, "usb-vault-7", &key(5), "notes.json", b"{}").unwrap();
    assert_eq!(crypto_stream::read_vault_id(path.to_str().unwrap()).as_deref(), Some("usb-vault-7"));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_two_saves_of_the_same_content_differ_in_every_part() {
    let base = fresh_dir("qre_vault8_fresh");
    let a = base.join("a.qre");
    let b = base.join("b.qre");
    let content = json(&sample());
    seal_vault_file(&a, "local", &key(5), "notes.json", &content).unwrap();
    seal_vault_file(&b, "local", &key(5), "notes.json", &content).unwrap();
    let (ra, rb) = (fs::read(&a).unwrap(), fs::read(&b).unwrap());
    assert_eq!(ra.len(), rb.len());
    assert_ne!(ra, rb);
    // Keys and nonces are fresh, so no long stretch of the two files may be the same.
    let same = ra.iter().zip(&rb).filter(|(x, y)| x == y).count();
    assert!(same < ra.len() / 4, "{} of {} bytes are equal", same, ra.len());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_saving_again_replaces_the_whole_old_file() {
    let base = fresh_dir("qre_vault8_resave");
    let path = base.join("notes.qre");
    seal_vault_file(&path, "local", &key(5), "notes.json", &noise(3 * 1024 * 1024)).unwrap();
    seal_vault_file(&path, "local", &key(5), "notes.json", b"{\"entries\":[]}").unwrap();
    assert_eq!(open(&path, 5, "notes.json").unwrap(), b"{\"entries\":[]}");
    assert!(fs::metadata(&path).unwrap().len() < 1000, "a tail of the old file remains");
    assert_eq!(names(&base), ["notes.qre"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_save_that_cannot_complete_keeps_the_old_vault_and_leaves_nothing() {
    let base = fresh_dir("qre_vault8_failed_save");
    let path = base.join("notes.qre");
    seal_vault_file(&path, "local", &key(5), "notes.json", b"{\"old\":true}").unwrap();
    let before = fs::read(&path).unwrap();

    // The folder for the new file does not exist, so nothing can be written.
    let impossible = base.join("no-such-folder").join("notes.qre");
    assert!(seal_vault_file(&impossible, "local", &key(5), "notes.json", b"{}").is_err());

    // A directory stands where the file should go, so the final replacement fails.
    let blocked = base.join("blocked.qre");
    fs::create_dir_all(blocked.join("inside")).unwrap();
    assert!(seal_vault_file(&blocked, "local", &key(5), "notes.json", b"{}").is_err());

    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(names(&base), ["blocked.qre", "notes.qre"], "a temporary file was left behind");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_stale_part_file_from_a_crash_is_cleared_by_the_next_save() {
    let base = fresh_dir("qre_vault8_stale");
    let path = base.join("notes.qre");
    fs::write(base.join("notes.qre.part"), b"cut off by a crash").unwrap();
    seal_vault_file(&path, "local", &key(5), "notes.json", b"{}").unwrap();
    assert_eq!(names(&base), ["notes.qre"]);
    let _ = fs::remove_dir_all(base);
}

// ─── Refusing what is not right ──────────────────────────────────────────────

#[test]
fn test_a_wrong_key_is_refused_with_the_wrong_password_message() {
    let (base, path) = saved("qre_vault8_wrong_key", "notes.json", &json(&sample()));
    let err = open(&path, 6, "notes.json").unwrap_err().to_string();
    assert!(err.contains("Password or Keyfile is incorrect"), "{}", err);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_every_single_changed_byte_is_refused() {
    let (base, path) = saved("qre_vault8_flip_all", "notes.json", &json(&sample()));
    let original = fs::read(&path).unwrap();
    for i in 0..original.len() {
        let mut bytes = original.clone();
        bytes[i] ^= 0x01;
        fs::write(&path, &bytes).unwrap();
        assert!(open(&path, 5, "notes.json").is_err(), "a change at byte {} of {} was not noticed", i, original.len());
    }
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_short_at_any_length_is_refused() {
    let (base, path) = saved("qre_vault8_cut", "notes.json", &noise(100));
    let original = fs::read(&path).unwrap();
    for len in 0..original.len() {
        fs::write(&path, &original[..len]).unwrap();
        assert!(open(&path, 5, "notes.json").is_err(), "a file cut to {} of {} bytes was accepted", len, original.len());
    }
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_at_a_chunk_boundary_is_refused() {
    // Two chunks, the second removed whole: the length and hash in the header catch it.
    let (base, path) = saved("qre_vault8_boundary", "notes.json", &noise(1024 * 1024 + 100));
    let original = fs::read(&path).unwrap();
    let header_len = u32::from_le_bytes(original[4..8].try_into().unwrap()) as usize;
    let first_chunk = 8 + header_len;
    let first_len = u32::from_le_bytes(original[first_chunk..first_chunk + 4].try_into().unwrap()) as usize;
    fs::write(&path, &original[..first_chunk + 4 + first_len]).unwrap();
    assert!(open(&path, 5, "notes.json").is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_bytes_added_to_the_end_are_refused() {
    let (base, path) = saved("qre_vault8_extended", "notes.json", &json(&sample()));
    let mut bytes = fs::read(&path).unwrap();
    bytes.extend_from_slice(&[0u8; 40]);
    fs::write(&path, &bytes).unwrap();
    assert!(open(&path, 5, "notes.json").is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_vault_file_copied_over_another_is_refused() {
    let base = fresh_dir("qre_vault8_swap");
    let notes = base.join("notes.qre");
    let passwords = base.join("passwords.qre");
    seal_vault_file(&notes, "local", &key(5), "notes.json", b"{\"notes\":true}").unwrap();
    fs::copy(&notes, &passwords).unwrap();

    let err = open(&passwords, 5, "passwords.json").unwrap_err().to_string();
    assert!(err.contains("passwords.json") && err.contains("copied over"), "{}", err);
    assert_eq!(open(&notes, 5, "notes.json").unwrap(), b"{\"notes\":true}");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_time_locked_file_is_not_accepted_as_a_vault_file() {
    let base = fresh_dir("qre_vault8_timelock");
    let input = base.join("notes.json");
    fs::write(&input, b"{}").unwrap();
    let locked = base.join("notes.qre");
    // Locked until a date in the past, so only the refusal of the kind of file is being tested.
    crypto_stream::encrypt_file_stream(input.to_str().unwrap(), locked.to_str().unwrap(), &key(5), "local", None, Some(1), None, 3, |_, _| {}).unwrap();
    let err = open(&locked, 5, "notes.json").unwrap_err().to_string();
    assert!(err.contains("time-locked"), "{}", err);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_files_of_other_versions_are_not_accepted_as_vault_files() {
    // A version 6 file, as an older app wrote it.
    let base = fresh_dir("qre_vault8_version_v6");
    let input = base.join("notes.json");
    fs::write(&input, b"{}").unwrap();
    let locked = base.join("notes.qre");
    crypto_stream::encrypt_file_stream_as(crypto_stream::FileFormat::Classic, input.to_str().unwrap(), locked.to_str().unwrap(), &key(5), "local", None, None, None, 3, |_, _| {}).unwrap();
    let err = open(&locked, 5, "notes.json").unwrap_err().to_string();
    assert!(err.contains("unknown format"), "{}", err);
    let _ = fs::remove_dir_all(base);
    let base = fresh_dir("qre_vault8_version_garbage");
    let junk = base.join("notes.qre");
    fs::write(&junk, b"definitely not a vault").unwrap();
    assert!(open(&junk, 5, "notes.json").is_err());
    fs::write(&junk, b"").unwrap();
    assert!(open(&junk, 5, "notes.json").is_err());
    assert!(open(&base.join("missing.qre"), 5, "notes.json").is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_limit_on_how_much_a_vault_file_may_hold() {
    assert_eq!(MAX_VAULT_BYTES, 512 * 1024 * 1024);
    let stream = include_str!("crypto_stream.rs");
    let body = function_body(stream, "pub fn open_vault_file(");
    assert!(body.contains("MAX_VAULT_BYTES"), "opening no longer limits the size");
    assert!(body.contains("Zeroizing"), "the opened content is no longer wiped when dropped");
}

// ─── The commands: both formats, and the move to format 8 ────────────────────

#[test]
fn test_the_commands_write_format_8_and_read_it_back() {
    let base = fresh_dir("qre_vault8_commands");
    let path = base.join("passwords.qre");
    write_vault_file(&path, "local", &key(5), "passwords.json", &sample()).unwrap();
    assert_eq!(version_of(&path), Some(8));
    let loaded: Option<Sample> = read_vault_file(&path, "local", &key(5), "passwords.json", "bad").unwrap();
    assert_eq!(loaded, Some(sample()));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_vault_file_swapped_for_another_one_is_refused_by_the_commands() {
    let base = fresh_dir("qre_vault8_commands_swap");
    let notes = base.join("notes.qre");
    let passwords = base.join("passwords.qre");
    write_vault_file(&notes, "local", &key(5), "notes.json", &sample()).unwrap();
    fs::copy(&notes, &passwords).unwrap();
    assert!(read_vault_file::<Sample>(&passwords, "local", &key(5), "passwords.json", "bad").is_err());
    let _ = fs::remove_dir_all(base);
}

fn legacy_vault(path: &Path, name: &str, content: &[u8]) {
    crypto::encrypt_file_with_master_key(&key(5), None, name, content, None, 3).unwrap().save(path.to_str().unwrap()).unwrap();
}

#[test]
fn test_an_old_vault_file_is_read_and_rewritten_in_format_8() {
    let base = fresh_dir("qre_vault8_migrate");
    let path = base.join("passwords.qre");
    legacy_vault(&path, "passwords.json", &json(&sample()));
    assert_eq!(version_of(&path), Some(4));

    let loaded: Option<Sample> = read_vault_file(&path, "local", &key(5), "passwords.json", "bad").unwrap();

    assert_eq!(loaded, Some(sample()), "the old vault was read wrongly");
    assert_eq!(version_of(&path), Some(8), "the old vault was not rewritten");
    assert_eq!(open(&path, 5, "passwords.json").unwrap(), json(&sample()), "the rewritten vault differs from the old one");
    assert_eq!(names(&base), ["passwords.qre"], "a temporary file was left behind");
    // And it reads again, now as format 8.
    let again: Option<Sample> = read_vault_file(&path, "local", &key(5), "passwords.json", "bad").unwrap();
    assert_eq!(again, Some(sample()));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_rewritten_vault_keeps_every_byte_of_the_content() {
    // The raw JSON is carried over as it was, not parsed and written again.
    let base = fresh_dir("qre_vault8_migrate_exact");
    let path = base.join("notes.qre");
    let odd_json = b"{ \"title\" :  \"spaced   out\",\n  \"items\": [ \"b\", \"a\" ] }".to_vec();
    legacy_vault(&path, "notes.json", &odd_json);
    let _: Option<Sample> = read_vault_file(&path, "local", &key(5), "notes.json", "bad").unwrap();
    assert_eq!(open(&path, 5, "notes.json").unwrap(), odd_json);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_old_vault_with_the_wrong_key_is_refused_and_left_as_it_was() {
    let base = fresh_dir("qre_vault8_migrate_wrong_key");
    let path = base.join("passwords.qre");
    legacy_vault(&path, "passwords.json", &json(&sample()));
    let before = fs::read(&path).unwrap();

    assert!(read_vault_file::<Sample>(&path, "local", &key(6), "passwords.json", "bad").is_err());

    assert_eq!(fs::read(&path).unwrap(), before, "a vault that could not be read was changed");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_old_vault_that_does_not_parse_is_refused_and_left_as_it_was() {
    let base = fresh_dir("qre_vault8_migrate_bad_shape");
    let path = base.join("passwords.qre");
    legacy_vault(&path, "passwords.json", b"{\"unrelated\": 5}");
    let before = fs::read(&path).unwrap();

    let err = read_vault_file::<Sample>(&path, "local", &key(5), "passwords.json", "Failed to parse vault").unwrap_err();

    assert_eq!(err, "Failed to parse vault");
    assert_eq!(fs::read(&path).unwrap(), before, "a vault that did not parse was rewritten");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_damaged_old_vault_is_refused_and_left_as_it_was() {
    let base = fresh_dir("qre_vault8_migrate_damaged");
    let path = base.join("passwords.qre");
    legacy_vault(&path, "passwords.json", &json(&sample()));
    let mut bytes = fs::read(&path).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xFF;
    fs::write(&path, &bytes).unwrap();

    assert!(read_vault_file::<Sample>(&path, "local", &key(5), "passwords.json", "bad").is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_old_vault_that_cannot_be_rewritten_is_still_read_and_kept() {
    // A directory takes the name of the temporary file, which cannot be a file at the same time.
    // The vault must open as before, and the old file must stay.
    let base = fresh_dir("qre_vault8_migrate_blocked");
    let path = base.join("passwords.qre");
    legacy_vault(&path, "passwords.json", &json(&sample()));
    let before = fs::read(&path).unwrap();
    fs::create_dir_all(base.join("passwords.qre.part").join("inside")).unwrap();

    let loaded: Option<Sample> = read_vault_file(&path, "local", &key(5), "passwords.json", "bad").unwrap();

    assert_eq!(loaded, Some(sample()));
    assert_eq!(fs::read(&path).unwrap(), before, "the old vault was lost when the rewrite failed");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_unknown_version_is_not_taken_for_an_old_vault() {
    let base = fresh_dir("qre_vault8_unknown_version");
    let path = base.join("notes.qre");
    let mut bytes = 9u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&[0u8; 64]);
    fs::write(&path, &bytes).unwrap();
    assert!(read_vault_file::<Sample>(&path, "local", &key(5), "notes.json", "bad").is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let _ = fs::remove_dir_all(base);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

#[test]
fn test_nothing_in_the_app_writes_the_old_container_format() {
    let vault = include_str!("commands/vault.rs");
    assert!(!vault.contains("encrypt_file_with_master_key"), "vault files are written in the old format again");
    assert!(!vault.contains(".save("), "vault files are saved through the old container again");
    let crypto_source = include_str!("crypto.rs");
    // The writer exists for tests only, so no release build can use it.
    for marker in ["pub fn encrypt_file_with_master_key(", "pub fn save(&self"] {
        let at = crypto_source.find(marker).expect(marker);
        let before = &crypto_source[..at];
        let tail: Vec<&str> = before.lines().rev().take(8).collect();
        assert!(tail.iter().any(|l| l.trim() == "#[cfg(test)]"), "{} is not limited to tests", marker);
    }
}

#[test]
fn test_saving_checks_the_new_file_before_it_takes_the_place_of_the_old_one() {
    let stream = include_str!("crypto_stream.rs");
    let body = function_body(stream, "pub fn seal_vault_file(");
    let verify = body.find("verify_locked_file(").expect("the new vault file is no longer checked");
    let rename = body.find("fs::rename(").expect("no rename");
    assert!(verify < rename, "the file replaces the old one before it is checked");
    assert!(body.contains("FileFormat::V8"));
}

#[test]
fn test_reading_checks_the_name_and_the_move_to_format_8_is_only_tried_after_a_good_read() {
    let vault = include_str!("commands/vault.rs");
    let body = function_body(vault, "pub(crate) fn read_vault_file<");
    assert!(body.contains("open_vault_file(path, key, inner_name)"), "the name inside the file is no longer checked");
    let parse = body.find("serde_json::from_slice").expect("no parse");
    let seal = body.find("seal_vault_file(").expect("no rewrite");
    assert!(parse < seal, "the vault is rewritten before it is known to parse");
    assert!(body.contains("let _ = crypto_stream::seal_vault_file("), "a failed rewrite must not fail the read");
}

#[test]
fn test_every_vault_command_passes_its_own_file_name() {
    let vault = include_str!("commands/vault.rs");
    for (file, inner) in [("passwords.qre", "passwords.json"), ("notes.qre", "notes.json"), ("bookmarks.qre", "bookmarks.json"), ("clipboard.qre", "clipboard.json")] {
        assert!(vault.contains(&format!("\"{}\"", file)), "{} is missing", file);
        assert!(vault.matches(&format!("\"{}\"", inner)).count() >= 2, "{} is not used for both reading and writing", inner);
    }
}

#[test]
fn test_a_legacy_container_can_still_be_made_and_read_in_tests() {
    // Guards the helper used by the migration tests: it must make a real version 4 file.
    let base = fresh_dir("qre_vault8_legacy_helper");
    let path = base.join("old.qre");
    legacy_vault(&path, "old.json", b"{}");
    assert_eq!(version_of(&path), Some(4));
    let container = EncryptedFileContainer::load(path.to_str().unwrap()).unwrap();
    assert_eq!(crypto::decrypt_file_with_master_key(&key(5), None, &container).unwrap().content, b"{}");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_commands_store_the_vault_id_they_were_given() {
    let base = fresh_dir("qre_vault8_commands_id");
    let path = base.join("notes.qre");
    write_vault_file(&path, "usb-vault-9", &key(5), "notes.json", &sample()).unwrap();
    assert_eq!(crypto_stream::read_vault_id(path.to_str().unwrap()).as_deref(), Some("usb-vault-9"));

    // The same holds for a file moved to format 8 by reading it.
    let old = base.join("passwords.qre");
    legacy_vault(&old, "passwords.json", &json(&sample()));
    let _: Option<Sample> = read_vault_file(&old, "usb-vault-9", &key(5), "passwords.json", "bad").unwrap();
    assert_eq!(crypto_stream::read_vault_id(old.to_str().unwrap()).as_deref(), Some("usb-vault-9"));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_random_seed_of_a_file_is_wiped_on_every_exit() {
    let stream = include_str!("crypto_stream.rs");
    let body = function_body(stream, "fn encrypt_pieces(");
    assert!(body.contains("let mut combined_seed = Zeroizing::new([0u8; 32]);"), "the seed is no longer wiped when a lock fails part way");
    assert!(!body.contains("combined_seed.zeroize()"), "the seed is wiped only at the end again");
}
