//! The lock, unlock and time-lock commands, run the way the app runs them but without a window.
//!
//! Each command hands its work to a plain function that takes the unlocked vaults and a progress
//! sink (`lock_files_blocking`, `unlock_files_blocking`, `lock_with_timelock_blocking`). These
//! tests call those, so they cover the real command path: which vault key is used, how progress
//! is reported, what is written and what is refused. The files are written in the default format,
//! which is format 8. Helpers are shared with crypto_failure_tests.rs.

use crate::commands::files::{
    lock_files_blocking, unlock_files_blocking, BatchItemResult, LockRequest, Mounts, Progress, Vaults,
};
use crate::commands::timelock::lock_with_timelock_blocking;
use crate::crypto_failure_tests::{fresh_dir, function_body, key, names, noise, write};
use crate::crypto_stream::{self, FileFormat};
use crate::keychain::MasterKey;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const FAR_FUTURE: u64 = 4_000_000_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn vaults_with(entries: &[(&str, u8)]) -> Vaults {
    let map: HashMap<String, MasterKey> = entries.iter().map(|(id, seed)| (id.to_string(), key(*seed))).collect();
    Arc::new(Mutex::new(map))
}

fn local_vault() -> Vaults {
    vaults_with(&[("local", 7)])
}

fn no_mounts() -> Mounts {
    Arc::new(Mutex::new(HashMap::new()))
}

type Events = Arc<Mutex<Vec<(String, u8)>>>;

fn recorder() -> (Progress, Events) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let progress: Progress = Arc::new(move |label: &str, pct: u8| sink.lock().unwrap().push((label.to_string(), pct)));
    (progress, events)
}

fn request(paths: &[&str], verify: bool) -> LockRequest {
    LockRequest {
        file_paths: paths.iter().map(|p| p.to_string()).collect(),
        keyfile_hash: None,
        raw_entropy: None,
        mode: "auto".to_string(),
        verify,
    }
}

fn lock_cmd(req: LockRequest, vaults: &Vaults) -> (Vec<BatchItemResult>, Events) {
    let (progress, events) = recorder();
    let results = lock_files_blocking(req, vaults, &no_mounts(), &progress).unwrap();
    (results, events)
}

fn unlock_cmd(paths: &[&str], out: Option<&PathBuf>, vaults: &Vaults) -> Vec<BatchItemResult> {
    unlock_cmd_with_key(paths, None, out, vaults)
}

fn unlock_cmd_with_key(paths: &[&str], keyfile_hash: Option<Vec<u8>>, out: Option<&PathBuf>, vaults: &Vaults) -> Vec<BatchItemResult> {
    let (progress, _) = recorder();
    unlock_files_blocking(
        paths.iter().map(|p| p.to_string()).collect(),
        keyfile_hash,
        out.map(|p| p.to_str().unwrap().to_string()),
        vaults,
        &progress,
    )
    .unwrap()
}

/// A folder with one data file in it, and an empty folder to unlock into.
fn workspace(test: &str, size: usize) -> (PathBuf, PathBuf, String, Vec<u8>) {
    let base = fresh_dir(test);
    let out = base.join("out");
    fs::create_dir_all(&out).unwrap();
    let data = noise(size);
    let input = write(&base, "data.bin", &data);
    (base, out, input, data)
}

fn version_of(path: &str) -> u32 {
    u32::from_le_bytes(fs::read(path).unwrap()[..4].try_into().unwrap())
}

fn now() -> u64 {
    crate::timelock::now_secs()
}

// ─── Locking ─────────────────────────────────────────────────────────────────

#[test]
fn test_the_lock_command_writes_a_format_8_file_and_says_it_was_checked() {
    let (base, _, input, _) = workspace("qre_cmd_lock", 5000);
    let (results, _) = lock_cmd(request(&[&input], true), &local_vault());

    assert_eq!(results.len(), 1);
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(results[0].message, "Locked and verified");
    assert_eq!(results[0].name, "data.bin");
    assert_eq!(version_of(&format!("{}.qre", input)), 8);
    assert!(fs::metadata(&input).is_ok(), "the original must stay");
    assert_eq!(names(&base).into_iter().filter(|n| n.ends_with(".part")).count(), 0);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_lock_command_without_the_check_says_only_locked() {
    let (base, _, input, _) = workspace("qre_cmd_lock_nocheck", 5000);
    let (results, events) = lock_cmd(request(&[&input], false), &local_vault());

    assert!(results[0].success);
    assert_eq!(results[0].message, "Locked");
    assert!(events.lock().unwrap().iter().all(|(label, _)| !label.starts_with("Verifying")), "a check ran that was not asked for");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_lock_progress_bar_runs_once_and_never_goes_back() {
    // Progress is reported every five chunks, so the file needs more than that to move the bar.
    let (base, _, input, _) = workspace("qre_cmd_progress", 6 * 1024 * 1024);
    let (_, events) = lock_cmd(request(&[&input], true), &local_vault());
    let events = events.lock().unwrap();

    let encrypting: Vec<u8> = events.iter().filter(|(l, _)| l.starts_with("Encrypting")).map(|(_, p)| *p).collect();
    let verifying: Vec<u8> = events.iter().filter(|(l, _)| l.starts_with("Verifying")).map(|(_, p)| *p).collect();
    assert!(!encrypting.is_empty() && !verifying.is_empty());
    assert!(encrypting.iter().all(|p| *p <= 50), "locking must fill the first half: {:?}", encrypting);
    assert!(verifying.iter().all(|p| *p >= 50), "the check must fill the second half: {:?}", verifying);
    assert!(*verifying.last().unwrap() > 50, "the check never moved the bar: {:?}", verifying);
    let all: Vec<u8> = events.iter().filter(|(l, _)| l.starts_with("Encrypting") || l.starts_with("Verifying")).map(|(_, p)| *p).collect();
    assert!(all.windows(2).all(|w| w[0] <= w[1]), "the bar went backwards: {:?}", all);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_without_the_check_the_bar_uses_the_whole_range() {
    let (base, _, input, _) = workspace("qre_cmd_progress_full", 3 * 1024 * 1024);
    let (_, events) = lock_cmd(request(&[&input], false), &local_vault());
    let top = events.lock().unwrap().iter().filter(|(l, _)| l.starts_with("Encrypting")).map(|(_, p)| *p).max().unwrap();
    assert_eq!(top, 100);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_locking_with_the_vault_locked_is_refused_and_writes_nothing() {
    let (base, _, input, _) = workspace("qre_cmd_vault_locked", 5000);
    let (results, _) = lock_cmd(request(&[&input], true), &vaults_with(&[]));

    assert!(!results[0].success);
    assert!(results[0].message.contains("locked"), "{}", results[0].message);
    assert_eq!(names(&base), vec!["data.bin", "out"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_locking_a_file_that_is_not_there_fails_and_leaves_nothing() {
    let base = fresh_dir("qre_cmd_missing");
    let missing = base.join("nope.txt").to_str().unwrap().to_string();
    let (results, _) = lock_cmd(request(&[&missing], true), &local_vault());

    assert!(!results[0].success);
    assert!(names(&base).is_empty(), "left behind: {:?}", names(&base));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_one_bad_file_in_a_batch_does_not_stop_the_others() {
    let (base, _, input, _) = workspace("qre_cmd_batch", 5000);
    let missing = base.join("nope.txt").to_str().unwrap().to_string();
    let second = write(&base, "second.txt", b"second file");
    let (results, _) = lock_cmd(request(&[&missing, &input, &second], true), &local_vault());

    let outcome: Vec<bool> = results.iter().map(|r| r.success).collect();
    assert_eq!(outcome, vec![false, true, true]);
    assert!(fs::metadata(format!("{}.qre", input)).is_ok());
    assert!(fs::metadata(format!("{}.qre", second)).is_ok());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_locking_never_overwrites_a_file_already_at_the_name() {
    let (base, _, input, _) = workspace("qre_cmd_no_overwrite", 5000);
    let taken = format!("{}.qre", input);
    fs::write(&taken, b"precious").unwrap();
    let (results, _) = lock_cmd(request(&[&input], true), &local_vault());

    assert!(results[0].success);
    assert_eq!(fs::read(&taken).unwrap(), b"precious");
    assert_eq!(version_of(&format!("{}/data.bin (1).qre", base.to_str().unwrap())), 8);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_protected_system_path_is_refused() {
    let path = if cfg!(windows) { "C:\\Windows\\System32\\config\\x.txt" } else { "/etc/qre-test-file.txt" };
    let (results, _) = lock_cmd(request(&[path], true), &local_vault());
    assert!(!results[0].success);
    assert!(results[0].message.contains("protected system path"), "{}", results[0].message);
}

#[test]
fn test_a_path_with_dots_that_climb_out_is_refused() {
    let base = fresh_dir("qre_cmd_dotdot");
    let sneaky = format!("{}/sub/../x.txt", base.to_str().unwrap());
    let (results, _) = lock_cmd(request(&[&sneaky], true), &local_vault());
    assert!(!results[0].success);
    assert!(results[0].message.contains("Path traversal"), "{}", results[0].message);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_on_an_unlocked_usb_vault_is_not_locked_in_place() {
    let (base, _, input, _) = workspace("qre_cmd_ghost", 5000);
    let mounts: Mounts = Arc::new(Mutex::new(HashMap::from([(base.to_str().unwrap().to_string(), "usb-1".to_string())])));
    let (progress, _) = recorder();
    let results = lock_files_blocking(request(&[&input], true), &local_vault(), &mounts, &progress).unwrap();

    assert!(!results[0].success);
    assert!(results[0].message.contains("Ghost-file protection"), "{}", results[0].message);
    assert!(fs::metadata(format!("{}.qre", input)).is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_folder_is_zipped_locked_and_its_temporary_zip_removed() {
    let base = fresh_dir("qre_cmd_folder");
    let out = base.join("out");
    fs::create_dir_all(&out).unwrap();
    let docs = base.join("docs");
    fs::create_dir_all(docs.join("inner")).unwrap();
    fs::write(docs.join("a.txt"), b"alpha").unwrap();
    fs::write(docs.join("inner").join("b.txt"), b"beta").unwrap();
    let docs_str = docs.to_str().unwrap().to_string();

    let (results, _) = lock_cmd(request(&[&docs_str], true), &local_vault());
    assert!(results[0].success, "{}", results[0].message);
    assert!(fs::metadata(base.join("docs.zip")).is_err(), "the temporary zip was left behind");
    let locked = format!("{}.qre", docs_str);
    assert_eq!(version_of(&locked), 8);

    let unlocked = unlock_cmd(&[&locked], Some(&out), &local_vault());
    assert!(unlocked[0].success, "{}", unlocked[0].message);
    let zip_file = fs::File::open(out.join("docs.zip")).unwrap();
    let archive = zip::ZipArchive::new(zip_file).unwrap();
    let mut inside: Vec<String> = archive.file_names().map(|n| n.expect("a readable name").to_string()).collect();
    inside.sort();
    assert!(inside.iter().any(|n| n.ends_with("a.txt")) && inside.iter().any(|n| n.ends_with("b.txt")), "{:?}", inside);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_key_file_is_needed_to_unlock_what_was_locked_with_one() {
    let (base, out, input, data) = workspace("qre_cmd_keyfile", 5000);
    let mut req = request(&[&input], true);
    req.keyfile_hash = Some(vec![0xAB; 32]);
    let (results, _) = lock_cmd(req, &local_vault());
    assert!(results[0].success, "{}", results[0].message);
    let locked = format!("{}.qre", input);

    let without = unlock_cmd(&[&locked], Some(&out), &local_vault());
    assert!(!without[0].success);
    assert!(without[0].message.starts_with("Decryption Denied"), "{}", without[0].message);
    assert!(names(&out).is_empty());

    let wrong = unlock_cmd_with_key(&[&locked], Some(vec![0xCD; 32]), Some(&out), &local_vault());
    assert!(!wrong[0].success);

    let right = unlock_cmd_with_key(&[&locked], Some(vec![0xAB; 32]), Some(&out), &local_vault());
    assert!(right[0].success, "{}", right[0].message);
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

// ─── Unlocking ───────────────────────────────────────────────────────────────

#[test]
fn test_what_the_lock_command_makes_the_unlock_command_opens() {
    let (base, out, input, data) = workspace("qre_cmd_roundtrip", 2 * 1024 * 1024 + 99);
    lock_cmd(request(&[&input], true), &local_vault());
    let locked = format!("{}.qre", input);

    let results = unlock_cmd(&[&locked], Some(&out), &local_vault());
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(results[0].message, "Unlocked: data.bin");
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_unlocking_without_an_output_folder_writes_next_to_the_locked_file() {
    let (base, _, input, data) = workspace("qre_cmd_next_to", 5000);
    lock_cmd(request(&[&input], true), &local_vault());
    let locked = format!("{}.qre", input);
    fs::remove_file(&input).unwrap();

    let results = unlock_cmd(&[&locked], None, &local_vault());
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(fs::read(&input).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_unlocking_never_overwrites_a_file_with_the_same_name() {
    let (base, out, input, data) = workspace("qre_cmd_unlock_taken", 5000);
    lock_cmd(request(&[&input], true), &local_vault());
    fs::write(out.join("data.bin"), b"keep me").unwrap();

    let results = unlock_cmd(&[&format!("{}.qre", input)], Some(&out), &local_vault());
    assert!(results[0].success);
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), b"keep me");
    assert_eq!(fs::read(out.join("data (1).bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_unlocking_with_the_wrong_vault_key_fails_and_writes_nothing() {
    let (base, out, input, _) = workspace("qre_cmd_wrong_key", 5000);
    lock_cmd(request(&[&input], true), &local_vault());

    let results = unlock_cmd(&[&format!("{}.qre", input)], Some(&out), &vaults_with(&[("local", 99)]));
    assert!(!results[0].success);
    assert!(results[0].message.starts_with("Decryption Denied"), "{}", results[0].message);
    assert!(names(&out).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_unlocking_with_the_vault_locked_says_so() {
    let (base, out, input, _) = workspace("qre_cmd_unlock_vault_locked", 5000);
    lock_cmd(request(&[&input], true), &local_vault());

    let results = unlock_cmd(&[&format!("{}.qre", input)], Some(&out), &vaults_with(&[]));
    assert!(!results[0].success);
    assert_eq!(results[0].message, "Local Vault is locked.");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_of_a_usb_vault_uses_that_vaults_key_in_every_format() {
    // The command finds the vault from the header, without any key. For format 8 that must work
    // too, which the old code (it read a version 6 header from the open file) could not do.
    let (base, out, input, data) = workspace("qre_cmd_usb", 5000);
    for (format, until, tag) in [
        (FileFormat::Classic, None, "six"),
        (FileFormat::Classic, Some(FAR_FUTURE), "seven"),
        (FileFormat::V8, None, "eight"),
    ] {
        let locked = format!("{}.{}.qre", input, tag);
        crypto_stream::encrypt_file_stream_as(format, &input, &locked, &key(42), "usb-1", None, until, None, 1, |_, _| {}).unwrap();
        // Format 7 is time-locked far ahead, so only check which vault it asks for.
        let without = unlock_cmd(&[&locked], Some(&out), &local_vault());
        assert!(!without[0].success);
        assert!(without[0].message.contains("Portable USB Vault"), "{}: {}", tag, without[0].message);
        if until.is_none() {
            let with = unlock_cmd(&[&locked], Some(&out), &vaults_with(&[("local", 7), ("usb-1", 42)]));
            assert!(with[0].success, "{}: {}", tag, with[0].message);
            assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
            fs::remove_file(out.join("data.bin")).unwrap();
        }
    }
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_that_is_not_a_locked_file_is_refused_cleanly() {
    let base = fresh_dir("qre_cmd_garbage");
    let out = base.join("out");
    fs::create_dir_all(&out).unwrap();
    let junk = write(&base, "junk.qre", b"this is plain text, not a locked file");
    let tiny = write(&base, "tiny.qre", b"ab");
    let missing = base.join("missing.qre").to_str().unwrap().to_string();

    let results = unlock_cmd(&[&junk, &tiny, &missing], Some(&out), &local_vault());
    assert!(results.iter().all(|r| !r.success));
    assert!(results[0].message.contains("Unsupported Version"), "{}", results[0].message);
    assert_eq!(results[1].message, "Invalid file");
    assert!(names(&out).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_damaged_locked_file_is_reported_and_leaves_nothing() {
    let (base, out, input, _) = workspace("qre_cmd_damaged", 3 * 1024 * 1024);
    lock_cmd(request(&[&input], true), &local_vault());
    let locked = format!("{}.qre", input);
    let mut bytes = fs::read(&locked).unwrap();
    let at = bytes.len() * 3 / 4;
    bytes[at] ^= 0x01;
    fs::write(&locked, bytes).unwrap();

    let results = unlock_cmd(&[&locked], Some(&out), &local_vault());
    assert!(!results[0].success);
    assert!(results[0].message.contains("integrity"), "{}", results[0].message);
    assert!(names(&out).is_empty());
    let _ = fs::remove_dir_all(base);
}

// ─── Time-lock ───────────────────────────────────────────────────────────────

fn timelock_cmd(path: &str, until: u64, verify: bool, vaults: &Vaults) -> (BatchItemResult, Events) {
    let (progress, events) = recorder();
    let result = lock_with_timelock_blocking(path, until, None, verify, vaults, &no_mounts(), &progress).unwrap();
    (result, events)
}

#[test]
fn test_the_time_lock_command_writes_a_format_8_file_and_says_it_was_checked() {
    let (base, _, input, _) = workspace("qre_cmd_tl", 5000);
    let (result, _) = timelock_cmd(&input, now() + 100_000, true, &local_vault());

    assert!(result.success, "{}", result.message);
    assert!(result.message.starts_with("Time-locked for "), "{}", result.message);
    assert!(result.message.ends_with(" and verified"), "{}", result.message);
    assert_eq!(version_of(&format!("{}.qre", input)), 8);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_time_lock_command_without_the_check_does_not_claim_one() {
    let (base, _, input, _) = workspace("qre_cmd_tl_nocheck", 5000);
    let (result, events) = timelock_cmd(&input, now() + 100_000, false, &local_vault());

    assert!(result.success);
    assert!(!result.message.contains("verified"), "{}", result.message);
    assert!(events.lock().unwrap().iter().all(|(l, _)| !l.starts_with("Verifying")));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_running_time_lock_stops_the_unlock_command_and_writes_nothing() {
    let (base, out, input, _) = workspace("qre_cmd_tl_running", 5000);
    timelock_cmd(&input, now() + 100_000, true, &local_vault());

    let results = unlock_cmd(&[&format!("{}.qre", input)], Some(&out), &local_vault());
    assert!(!results[0].success);
    assert!(results[0].message.starts_with("TIME_LOCKED:"), "{}", results[0].message);
    assert!(names(&out).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_time_lock_that_has_passed_lets_the_unlock_command_through() {
    let (base, out, input, data) = workspace("qre_cmd_tl_passed", 5000);
    timelock_cmd(&input, now() - 1000, true, &local_vault());

    let results = unlock_cmd(&[&format!("{}.qre", input)], Some(&out), &local_vault());
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_time_lock_command_with_the_vault_locked_writes_nothing() {
    let (base, _, input, _) = workspace("qre_cmd_tl_vault_locked", 5000);
    let (result, _) = timelock_cmd(&input, now() + 100_000, true, &vaults_with(&[]));

    assert!(!result.success);
    assert!(result.message.contains("locked"));
    assert_eq!(names(&base), vec!["data.bin", "out"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_time_lock_command_on_a_missing_file_fails_and_leaves_nothing() {
    let base = fresh_dir("qre_cmd_tl_missing");
    let missing = base.join("nope.txt").to_str().unwrap().to_string();
    let (result, _) = timelock_cmd(&missing, now() + 100_000, true, &local_vault());

    assert!(!result.success);
    assert!(result.message.starts_with("Encryption failed"), "{}", result.message);
    assert!(names(&base).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_time_lock_command_refuses_a_file_on_a_usb_vault() {
    let (base, _, input, _) = workspace("qre_cmd_tl_ghost", 5000);
    let mounts: Mounts = Arc::new(Mutex::new(HashMap::from([(base.to_str().unwrap().to_string(), "usb-1".to_string())])));
    let (progress, _) = recorder();
    let result = lock_with_timelock_blocking(&input, now() + 100_000, None, true, &local_vault(), &mounts, &progress).unwrap();

    assert!(!result.success);
    assert!(result.message.contains("Ghost-file protection"));
    assert!(fs::metadata(format!("{}.qre", input)).is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_time_lock_progress_stays_in_range_and_ends_at_100() {
    let (base, _, input, _) = workspace("qre_cmd_tl_progress", 3 * 1024 * 1024);
    let (_, events) = timelock_cmd(&input, now() + 100_000, true, &local_vault());
    let events = events.lock().unwrap();

    assert_eq!(events.last().unwrap(), &("Locked: data.bin".to_string(), 100));
    let encrypting: Vec<u8> = events.iter().filter(|(l, _)| l.starts_with("Encrypting")).map(|(_, p)| *p).collect();
    assert!(!encrypting.is_empty() && encrypting.iter().all(|p| *p <= 50), "{:?}", encrypting);
    let _ = fs::remove_dir_all(base);
}

// ─── The commands themselves ─────────────────────────────────────────────────

#[test]
fn test_each_command_hands_its_work_to_the_function_the_tests_call() {
    let files = include_str!("commands/files.rs");
    let lock = function_body(files, "pub async fn lock_file(");
    assert!(lock.contains("should_verify(verify_after)"), "the request's choice is no longer read");
    assert!(lock.contains("lock_files_blocking("));
    assert!(function_body(files, "pub async fn unlock_file(").contains("unlock_files_blocking("));

    let timelock = include_str!("commands/timelock.rs");
    let tl = function_body(timelock, "pub async fn lock_file_with_timelock(");
    assert!(tl.contains("should_verify(verify_after)"));
    assert!(tl.contains("lock_with_timelock_blocking("));
    assert!(tl.contains("validate_unlock_at(unlock_at)"), "the date is no longer validated");
    assert!(tl.contains("validate_timelock_source_path(&file_path)"));
}

#[test]
fn test_the_commands_send_progress_to_the_window_and_nowhere_else() {
    let files = include_str!("commands/files.rs");
    assert!(function_body(files, "pub(crate) fn window_progress(").contains("utils::emit_progress(&app,"));
    for name in ["pub(crate) fn lock_files_blocking(", "pub(crate) fn unlock_files_blocking("] {
        assert!(!function_body(files, name).contains("emit_progress"), "{} talks to the window directly", name);
    }
    let timelock = include_str!("commands/timelock.rs");
    assert!(!function_body(timelock, "pub(crate) fn lock_with_timelock_blocking(").contains("emit_progress"));
}
