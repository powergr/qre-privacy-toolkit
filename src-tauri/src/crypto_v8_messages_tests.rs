//! Format 8 tells a wrong key from a damaged header. The key check is not tied to the header, so
//! it fails only for a wrong key; every later failure then means the header was damaged or changed.
//! Helpers come from crypto_v8_tests.rs and crypto_failure_tests.rs.

use crate::crypto_failure_tests::{fresh_dir, key, unlock, write};
use crate::crypto_stream::{self, FileFormat};
use crate::crypto_v8_tests::{chunks_at, locked8, verify, with_header_rewritten, FAR_FUTURE, HEADER_AT};
use std::fs;

const WRONG_KEY: &str = "Decryption Denied. Password or Keyfile is incorrect.";
const DAMAGED: &str = "The file header is damaged or was changed";

/// Where the validation nonce and tag sit inside the header of a file locked in the local vault:
/// after the vault id (flag 1, length 8, "local" 5), a nonce (length 8, bytes 12) and a tag
/// (length 8, bytes 25). Damage inside this window is indistinguishable from a wrong key.
const KEY_CHECK_WINDOW: std::ops::Range<usize> = 14..14 + (8 + 12) + (8 + 25);

#[test]
fn test_a_wrong_password_says_only_that_the_password_is_wrong() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8msg_wrong_password", 5000, None);
    let err = unlock(&encrypted, &out_dir, &key(99)).unwrap_err().to_string();
    assert_eq!(err, WRONG_KEY);
    assert!(!err.contains("header"));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_wrong_key_file_says_only_that_it_is_wrong() {
    let base = fresh_dir("qre_v8msg_wrong_keyfile");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let input = write(&base, "doc.txt", b"under a key file");
    let encrypted = format!("{}.qre", input);
    crypto_stream::encrypt_file_stream_as(FileFormat::V8, &input, &encrypted, &key(5), "local", Some(&[0xAB_u8; 32]), None, None, 1, |_, _| {}).unwrap();

    let out = out_dir.to_str().unwrap();
    let none = crypto_stream::decrypt_file_stream(&encrypted, out, &key(5), None, |_, _| {}).unwrap_err().to_string();
    let wrong = crypto_stream::decrypt_file_stream(&encrypted, out, &key(5), Some(&[0xCD_u8; 32]), |_, _| {}).unwrap_err().to_string();
    assert_eq!(none, WRONG_KEY);
    assert_eq!(wrong, WRONG_KEY);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_damage_to_the_header_is_not_reported_as_a_wrong_password() {
    // Flip each header byte in turn. A wrong-key message may appear only for the bytes of the key
    // check itself, which no program can tell from a wrong key. Every other byte of the header
    // must give a message about the header, or a parse error.
    let (base, out_dir, encrypted, _) = locked8("qre_v8msg_every_byte", 100_000, None);
    let original = fs::read(&encrypted).unwrap();
    let damaged = format!("{}.damaged.qre", encrypted);

    let mut wrong_key_at = Vec::new();
    let mut about_header = 0;
    for at in HEADER_AT..chunks_at(&original) {
        let mut bytes = original.clone();
        bytes[at] ^= 0x01;
        fs::write(&damaged, &bytes).unwrap();
        let message = unlock(&damaged, &out_dir, &key(7)).unwrap_err().to_string();
        if message == WRONG_KEY {
            wrong_key_at.push(at - HEADER_AT);
        } else if message.starts_with(DAMAGED) {
            about_header += 1;
        } else {
            assert!(message.contains("parse") || message.contains("header"), "byte {}: unexpected message: {}", at - HEADER_AT, message);
        }
    }
    assert!(
        wrong_key_at.iter().all(|i| KEY_CHECK_WINDOW.contains(i)),
        "damage outside the key check said 'wrong password': {:?}",
        wrong_key_at
    );
    assert!(about_header > 100, "only {} bytes gave the header message", about_header);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_changed_vault_id_says_the_header_was_changed_not_that_the_password_is_wrong() {
    let (base, out_dir, encrypted, _) = locked8("qre_v8msg_vault", 5000, None);
    with_header_rewritten(&encrypted, |h| h.vault_id = Some("usb-other".to_string()));
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.starts_with(DAMAGED), "{}", err);
    assert!(err.contains("The password may be right"));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_damage_to_the_key_check_of_a_time_locked_file_is_reported_as_header_damage() {
    // The binding key has already shown that the master key is right, so a failure of the key
    // check afterwards cannot be a wrong password. Checked without the clock.
    let (base, _, encrypted, _) = locked8("qre_v8msg_timed_tag", 5000, Some(FAR_FUTURE));
    let mut bytes = fs::read(&encrypted).unwrap();
    bytes[HEADER_AT + KEY_CHECK_WINDOW.end - 1] ^= 0x01; // the last byte of the tag
    fs::write(&encrypted, bytes).unwrap();
    let err = verify(&encrypted, &key(7)).unwrap_err().to_string();
    assert!(err.starts_with(DAMAGED), "{}", err);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_wrong_password_on_a_time_locked_file_keeps_the_combined_message() {
    // Here a wrong password and a changed date fail at the same step, so the message says both.
    let (base, _, encrypted, _) = locked8("qre_v8msg_timed_wrong", 5000, Some(FAR_FUTURE));
    let err = verify(&encrypted, &key(99)).unwrap_err().to_string();
    assert_eq!(err, "Decryption Denied. Password or Keyfile is incorrect, or the file header was changed.");
    let _ = fs::remove_dir_all(base);
}
