//! Cancelling a long job. The window's Cancel button (or the Escape key) raises a flag, and the
//! job stops at its next step. These tests raise the flag at chosen moments and check the three
//! things that matter: the job really stops, nothing half-made is left behind, and the user's
//! original files are untouched. Helpers are shared with crypto_failure_tests.rs.

use crate::cancel::{self, CancelFlag};
use crate::commands::files::{
    lock_files_blocking, relock_files_blocking, unlock_files_blocking, BatchItemResult, LockRequest, Mounts, Progress, Vaults,
};
use crate::commands::timelock::lock_with_timelock_blocking;
use crate::crypto_failure_tests::{fresh_dir, function_body, key, names, noise, write};
use crate::crypto_stream::{self, FileFormat};
use crate::keychain::MasterKey;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn vaults() -> Vaults {
    let map: HashMap<String, MasterKey> = HashMap::from([("local".to_string(), key(7))]);
    Arc::new(Mutex::new(map))
}

fn no_mounts() -> Mounts {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Progress that raises `flag` the first time a label starting with `prefix` is reported, which
/// is how a test presses Cancel at a precise moment.
fn cancel_when(flag: &CancelFlag, prefix: &'static str) -> Progress {
    let flag = flag.clone();
    Arc::new(move |label: &str, _pct: u8| {
        if label.starts_with(prefix) {
            cancel::request(&flag);
        }
    })
}

fn quiet() -> Progress {
    Arc::new(|_: &str, _: u8| {})
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

fn lock(paths: &[&str], verify: bool, flag: &CancelFlag, progress: &Progress) -> Vec<BatchItemResult> {
    cancel::run_with(flag, || lock_files_blocking(request(paths, verify), &vaults(), &no_mounts(), progress)).unwrap()
}

fn unlock(paths: &[&str], out: &PathBuf, flag: &CancelFlag, progress: &Progress) -> Vec<BatchItemResult> {
    cancel::run_with(flag, || {
        unlock_files_blocking(paths.iter().map(|p| p.to_string()).collect(), None, Some(out.to_str().unwrap().to_string()), &vaults(), progress)
    })
    .unwrap()
}

fn relock(paths: &[&str], flag: &CancelFlag, progress: &Progress) -> Vec<BatchItemResult> {
    cancel::run_with(flag, || relock_files_blocking(paths.iter().map(|p| p.to_string()).collect(), None, &vaults(), progress)).unwrap()
}

/// A folder holding `data.bin` (`size` bytes of noise) and an empty `out` folder.
fn workspace(test: &str, size: usize) -> (PathBuf, PathBuf, String) {
    let base = fresh_dir(test);
    let out = base.join("out");
    fs::create_dir_all(&out).unwrap();
    let input = write(&base, "data.bin", &noise(size));
    (base, out, input)
}

fn is_cancelled(r: &BatchItemResult) -> bool {
    !r.success && r.message.starts_with("Cancelled")
}

const BIG: usize = 6 * 1024 * 1024;

// ─── The flag ────────────────────────────────────────────────────────────────

#[test]
fn test_a_thread_that_was_never_given_a_flag_is_never_cancelled() {
    assert!(!cancel::is_cancelled());
    assert!(cancel::check().is_ok());
}

#[test]
fn test_a_raised_flag_stops_the_job_it_belongs_to() {
    let flag = cancel::new_flag();
    cancel::run_with(&flag, || {
        assert!(!cancel::is_cancelled());
        cancel::request(&flag);
        assert!(cancel::is_cancelled());
        let err = cancel::check().unwrap_err();
        assert!(cancel::is_cancel_error(&err));
        assert_eq!(err.to_string(), "Cancelled.");
    });
}

#[test]
fn test_the_flag_no_longer_applies_once_the_job_has_ended() {
    let flag = cancel::new_flag();
    cancel::request(&flag);
    cancel::run_with(&flag, || assert!(cancel::is_cancelled()));
    assert!(!cancel::is_cancelled(), "the job's flag leaked out of its scope");
}

#[test]
fn test_the_flag_is_put_back_even_if_the_job_panics() {
    let flag = cancel::new_flag();
    cancel::request(&flag);
    let result = std::panic::catch_unwind(|| cancel::run_with(&flag, || panic!("the job failed")));
    assert!(result.is_err());
    assert!(!cancel::is_cancelled());
}

#[test]
fn test_a_job_inside_a_job_has_its_own_flag_and_the_outer_one_comes_back() {
    let outer = cancel::new_flag();
    let inner = cancel::new_flag();
    cancel::run_with(&outer, || {
        cancel::request(&inner);
        cancel::run_with(&inner, || assert!(cancel::is_cancelled()));
        assert!(!cancel::is_cancelled(), "the outer job was cancelled by the inner flag");
        cancel::request(&outer);
        assert!(cancel::is_cancelled());
    });
}

#[test]
fn test_the_flag_of_one_job_does_not_stop_a_job_on_another_thread() {
    let flag = cancel::new_flag();
    cancel::request(&flag);
    cancel::run_with(&flag, || {
        let other = std::thread::spawn(|| cancel::is_cancelled()).join().unwrap();
        assert!(!other, "a job on another thread was cancelled");
        assert!(cancel::is_cancelled());
    });
}

#[test]
fn test_reset_clears_a_request_that_was_meant_for_the_last_job() {
    let flag = cancel::new_flag();
    cancel::request(&flag);
    cancel::reset(&flag);
    cancel::run_with(&flag, || assert!(!cancel::is_cancelled()));
}

#[test]
fn test_two_jobs_at_once_are_cancelled_separately() {
    let (base_a, _, input_a) = workspace("qre_cancel_two_a", BIG);
    let (base_b, _, input_b) = workspace("qre_cancel_two_b", BIG);
    let flag_a = cancel::new_flag();
    let flag_b = cancel::new_flag();
    cancel::request(&flag_a); // only job A is cancelled

    let a = std::thread::spawn(move || lock(&[&input_a], true, &flag_a, &quiet()));
    let b = std::thread::spawn(move || lock(&[&input_b], true, &flag_b, &quiet()));
    let (a, b) = (a.join().unwrap(), b.join().unwrap());

    assert!(a.iter().all(is_cancelled), "job A should have been cancelled: {:?}", a.iter().map(|r| &r.message).collect::<Vec<_>>());
    assert!(b[0].success, "job B was stopped by job A's flag: {}", b[0].message);
    let _ = fs::remove_dir_all(base_a);
    let _ = fs::remove_dir_all(base_b);
}

// ─── Locking ─────────────────────────────────────────────────────────────────

#[test]
fn test_a_job_that_is_cancelled_before_it_starts_does_nothing() {
    let (base, _, input) = workspace("qre_cancel_before", 5000);
    let flag = cancel::new_flag();
    cancel::request(&flag);
    let before = names(&base);

    let results = lock(&[&input], true, &flag, &quiet());

    assert_eq!(results.len(), 1);
    assert!(is_cancelled(&results[0]));
    assert_eq!(results[0].name, "1 more file");
    assert!(results[0].message.contains("Not started"));
    assert_eq!(names(&base), before);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_cancelling_while_a_file_is_being_locked_stops_it_and_leaves_nothing() {
    let (base, _, input) = workspace("qre_cancel_lock", BIG);
    let original = fs::read(&input).unwrap();
    let flag = cancel::new_flag();

    let results = lock(&[&input], true, &flag, &cancel_when(&flag, "Encrypting"));

    assert_eq!(results.len(), 1);
    assert!(is_cancelled(&results[0]), "{}", results[0].message);
    assert_eq!(results[0].message, "Cancelled.");
    assert_eq!(names(&base), vec!["data.bin", "out"], "something was left behind");
    assert_eq!(fs::read(&input).unwrap(), original);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_cancelling_while_the_new_file_is_checked_removes_it_and_keeps_the_original() {
    let (base, _, input) = workspace("qre_cancel_verify", BIG);
    let original = fs::read(&input).unwrap();
    let flag = cancel::new_flag();

    let results = lock(&[&input], true, &flag, &cancel_when(&flag, "Verifying"));

    assert!(is_cancelled(&results[0]), "{}", results[0].message);
    assert!(results[0].message.contains("removed"), "{}", results[0].message);
    assert!(results[0].message.contains("original file has not been touched"), "{}", results[0].message);
    assert_eq!(names(&base), vec!["data.bin", "out"], "the unchecked file was kept");
    assert_eq!(fs::read(&input).unwrap(), original);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_files_finished_before_the_stop_stay_and_the_rest_are_not_started() {
    let base = fresh_dir("qre_cancel_batch");
    let out = base.join("out");
    fs::create_dir_all(&out).unwrap();
    let small = write(&base, "a-small.txt", b"finished before the stop");
    let big = write(&base, "b-big.bin", &noise(BIG));
    let after = write(&base, "c-after.txt", b"never reached");
    let flag = cancel::new_flag();

    let results = lock(&[&small, &big, &after], true, &flag, &cancel_when(&flag, "Encrypting: b-big"));

    let outcome: Vec<(bool, bool)> = results.iter().map(|r| (r.success, is_cancelled(r))).collect();
    assert_eq!(outcome, vec![(true, false), (false, true), (false, true)], "{:?}", results.iter().map(|r| &r.message).collect::<Vec<_>>());
    assert_eq!(results[2].name, "1 more file");

    assert!(fs::metadata(format!("{}.qre", small)).is_ok(), "the finished file is gone");
    assert!(fs::metadata(format!("{}.qre", big)).is_err());
    assert!(fs::metadata(format!("{}.qre", after)).is_err());
    assert!(fs::metadata(&after).is_ok());
    // The one that finished really is whole.
    let again = unlock(&[&format!("{}.qre", small)], &out, &cancel::new_flag(), &quiet());
    assert!(again[0].success, "{}", again[0].message);
    assert_eq!(fs::read(out.join("a-small.txt")).unwrap(), b"finished before the stop");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_several_files_not_started_are_reported_in_one_line() {
    let base = fresh_dir("qre_cancel_many");
    let a = write(&base, "a.txt", b"a");
    let b = write(&base, "b.txt", b"b");
    let c = write(&base, "c.txt", b"c");
    let flag = cancel::new_flag();
    cancel::request(&flag);

    let results = lock(&[&a, &b, &c], true, &flag, &quiet());

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "3 more files");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_cancelling_a_folder_while_it_is_zipped_leaves_no_zip_and_no_locked_file() {
    let base = fresh_dir("qre_cancel_zip");
    let folder = base.join("docs");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("big.bin"), noise(BIG)).unwrap();
    let folder_str = folder.to_str().unwrap().to_string();
    let flag = cancel::new_flag();

    let results = lock(&[&folder_str], true, &flag, &cancel_when(&flag, "Zipping Folder"));

    assert_eq!(results[0].message, "Cancelled.", "the stop was reported as a zip failure");
    assert_eq!(names(&base), vec!["docs"], "a zip or a locked file was left behind");
    assert_eq!(fs::read(folder.join("big.bin")).unwrap().len(), BIG);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_cancelling_a_folder_after_it_was_zipped_removes_the_temporary_zip() {
    let base = fresh_dir("qre_cancel_zip_after");
    let folder = base.join("docs");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("big.bin"), noise(BIG)).unwrap();
    let folder_str = folder.to_str().unwrap().to_string();
    let flag = cancel::new_flag();

    let results = lock(&[&folder_str], true, &flag, &cancel_when(&flag, "Encrypting"));

    assert!(is_cancelled(&results[0]), "{}", results[0].message);
    assert_eq!(names(&base), vec!["docs"], "the plaintext zip was left behind");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_zip_function_stops_by_itself_and_leaves_no_file() {
    let base = fresh_dir("qre_cancel_zip_fn");
    let folder = base.join("docs");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("a.bin"), noise(2 * 1024 * 1024)).unwrap();
    let out = base.join("docs.zip");
    let flag = cancel::new_flag();
    cancel::request(&flag);

    let result = cancel::run_with(&flag, || crate::utils::zip_directory_to_file(&folder, &out));

    assert_eq!(result.unwrap_err(), "Cancelled.");
    assert!(!out.exists());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_folder_zips_normally_when_nobody_cancels() {
    let base = fresh_dir("qre_cancel_zip_normal");
    let folder = base.join("docs");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("a.bin"), noise(2 * 1024 * 1024 + 17)).unwrap();
    let out = base.join("docs.zip");
    crate::utils::zip_directory_to_file(&folder, &out).unwrap();
    let archive = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
    assert!(archive.file_names().any(|n| n.map(|n| n.ends_with("a.bin")).unwrap_or(false)));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_job_can_run_again_after_a_cancel() {
    let (base, _, input) = workspace("qre_cancel_again", BIG);
    let flag = cancel::new_flag();
    let first = lock(&[&input], true, &flag, &cancel_when(&flag, "Encrypting"));
    assert!(is_cancelled(&first[0]));

    cancel::reset(&flag); // what the command does when it starts
    let second = lock(&[&input], true, &flag, &quiet());

    assert!(second[0].success, "{}", second[0].message);
    assert!(fs::metadata(format!("{}.qre", input)).is_ok());
    let _ = fs::remove_dir_all(base);
}

// ─── Unlocking ───────────────────────────────────────────────────────────────

fn locked_big(test: &str) -> (PathBuf, PathBuf, String, Vec<u8>) {
    let (base, out, input) = workspace(test, 8 * 1024 * 1024);
    let data = fs::read(&input).unwrap();
    let results = lock(&[&input], false, &cancel::new_flag(), &quiet());
    assert!(results[0].success, "{}", results[0].message);
    (base, out, format!("{}.qre", input), data)
}

#[test]
fn test_cancelling_an_unlock_leaves_no_plaintext_and_keeps_the_locked_file() {
    let (base, out, locked, _) = locked_big("qre_cancel_unlock");
    let before = fs::read(&locked).unwrap();
    let flag = cancel::new_flag();

    let results = unlock(&[&locked], &out, &flag, &cancel_when(&flag, "Decrypting"));

    assert!(is_cancelled(&results[0]), "{}", results[0].message);
    assert!(names(&out).is_empty(), "left behind: {:?}", names(&out));
    assert_eq!(fs::read(&locked).unwrap(), before);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_locked_file_still_unlocks_after_a_cancelled_unlock() {
    let (base, out, locked, data) = locked_big("qre_cancel_unlock_again");
    let flag = cancel::new_flag();
    let first = unlock(&[&locked], &out, &flag, &cancel_when(&flag, "Decrypting"));
    assert!(is_cancelled(&first[0]));

    let second = unlock(&[&locked], &out, &cancel::new_flag(), &quiet());

    assert!(second[0].success, "{}", second[0].message);
    assert_eq!(fs::read(out.join("data.bin")).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_unlock_cancelled_before_it_starts_writes_nothing() {
    let (base, out, locked, _) = locked_big("qre_cancel_unlock_before");
    let flag = cancel::new_flag();
    cancel::request(&flag);
    let results = unlock(&[&locked], &out, &flag, &quiet());
    assert_eq!(results.len(), 1);
    assert!(is_cancelled(&results[0]));
    assert!(names(&out).is_empty());
    let _ = fs::remove_dir_all(base);
}

// ─── Upgrading old files ─────────────────────────────────────────────────────

fn old_locked(test: &str) -> (PathBuf, String, Vec<u8>) {
    let (base, _, input) = workspace(test, BIG);
    let locked = format!("{}.qre", input);
    crypto_stream::encrypt_file_stream_as(FileFormat::Classic, &input, &locked, &key(7), "local", None, None, None, 1, |_, _| {}).unwrap();
    let bytes = fs::read(&locked).unwrap();
    (base, locked, bytes)
}

#[test]
fn test_cancelling_an_upgrade_while_the_new_file_is_written_changes_nothing() {
    let (base, locked, before) = old_locked("qre_cancel_relock_write");
    let listing = names(&base);
    let flag = cancel::new_flag();

    let results = relock(&[&locked], &flag, &cancel_when(&flag, "Upgrading"));

    assert!(is_cancelled(&results[0]), "{}", results[0].message);
    assert!(results[0].message.contains("old file was not changed"), "{}", results[0].message);
    assert_eq!(fs::read(&locked).unwrap(), before);
    assert_eq!(names(&base), listing);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_cancelling_an_upgrade_while_the_new_file_is_checked_changes_nothing() {
    let (base, locked, before) = old_locked("qre_cancel_relock_check");
    let listing = names(&base);
    let flag = cancel::new_flag();

    let results = relock(&[&locked], &flag, &cancel_when(&flag, "Checking"));

    assert!(is_cancelled(&results[0]), "{}", results[0].message);
    assert_eq!(fs::read(&locked).unwrap(), before, "the old file was replaced by an unchecked one");
    assert_eq!(names(&base), listing);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_an_upgrade_cancelled_before_it_starts_changes_nothing() {
    let (base, locked, before) = old_locked("qre_cancel_relock_before");
    let flag = cancel::new_flag();
    cancel::request(&flag);
    let results = relock(&[&locked], &flag, &quiet());
    assert!(is_cancelled(&results[0]));
    assert_eq!(fs::read(&locked).unwrap(), before);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_old_file_can_still_be_upgraded_after_a_cancelled_upgrade() {
    let (base, locked, _) = old_locked("qre_cancel_relock_again");
    let flag = cancel::new_flag();
    let first = relock(&[&locked], &flag, &cancel_when(&flag, "Upgrading"));
    assert!(is_cancelled(&first[0]));

    let second = relock(&[&locked], &cancel::new_flag(), &quiet());

    assert!(second[0].success, "{}", second[0].message);
    assert_eq!(crypto_stream::stream_version(&locked), Some(8));
    let _ = fs::remove_dir_all(base);
}

// ─── Time-lock ───────────────────────────────────────────────────────────────

fn timelock(path: &str, verify: bool, flag: &CancelFlag, progress: &Progress) -> BatchItemResult {
    let until = crate::timelock::now_secs() + 100_000;
    cancel::run_with(flag, || lock_with_timelock_blocking(path, until, None, verify, &vaults(), &no_mounts(), progress)).unwrap()
}

#[test]
fn test_cancelling_a_time_lock_while_writing_leaves_nothing() {
    let (base, _, input) = workspace("qre_cancel_tl_write", BIG);
    let flag = cancel::new_flag();
    let result = timelock(&input, true, &flag, &cancel_when(&flag, "Encrypting"));
    assert_eq!(result.message, "Cancelled.");
    assert!(!result.success);
    assert_eq!(names(&base), vec!["data.bin", "out"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_cancelling_a_time_lock_while_checking_removes_the_unchecked_file() {
    let (base, _, input) = workspace("qre_cancel_tl_check", BIG);
    let flag = cancel::new_flag();
    let result = timelock(&input, true, &flag, &cancel_when(&flag, "Verifying"));
    assert!(is_cancelled(&result), "{}", result.message);
    assert_eq!(names(&base), vec!["data.bin", "out"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_time_lock_nobody_cancels_still_works() {
    let (base, _, input) = workspace("qre_cancel_tl_normal", BIG);
    let result = timelock(&input, true, &cancel::new_flag(), &quiet());
    assert!(result.success, "{}", result.message);
    let _ = fs::remove_dir_all(base);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

#[test]
fn test_every_long_command_clears_the_flag_when_it_starts_and_runs_inside_it() {
    let files = include_str!("commands/files.rs");
    for name in ["pub async fn lock_file(", "pub async fn unlock_file(", "pub async fn relock_file("] {
        let body = function_body(files, name);
        assert!(body.contains("cancel::reset(&stop)"), "{} does not clear an old cancel", name);
        assert!(body.contains("cancel::run_with(&stop"), "{} does not run inside its flag", name);
    }
    let timelock = include_str!("commands/timelock.rs");
    let body = function_body(timelock, "pub async fn lock_file_with_timelock(");
    assert!(body.contains("cancel::reset(&stop)") && body.contains("cancel::run_with(&stop"));
}

#[test]
fn test_the_cancel_command_raises_the_flag_of_the_session() {
    let files = include_str!("commands/files.rs");
    let body = function_body(files, "pub fn cancel_operation(");
    assert!(body.contains("cancel::request(&state.cancel)"));
    let lib = include_str!("lib.rs");
    assert!(lib.contains("commands::files::cancel_operation"), "the command is not registered");
}

#[test]
fn test_each_long_step_looks_at_the_flag() {
    let stream = include_str!("crypto_stream.rs");
    assert!(function_body(stream, "fn push(&mut self").contains("cancel::check()"), "sealing a chunk cannot be stopped");
    assert!(function_body(stream, "fn read_all_chunks(").contains("cancel::check()"), "opening a chunk cannot be stopped");
    let utils = include_str!("utils.rs");
    assert!(function_body(utils, "fn write_directory_zip(").contains("cancel::check()"), "zipping cannot be stopped");
    let files = include_str!("commands/files.rs");
    for name in ["pub(crate) fn lock_files_blocking(", "pub(crate) fn unlock_files_blocking(", "pub(crate) fn relock_files_blocking("] {
        assert!(function_body(files, name).contains("cancel::is_cancelled()"), "{} does not stop between files", name);
    }
}

#[test]
fn test_the_session_has_one_flag_for_the_running_job() {
    let state = crate::state::SessionState::new();
    assert!(!state.cancel.load(std::sync::atomic::Ordering::SeqCst));
    cancel::request(&state.cancel);
    assert!(state.cancel.load(std::sync::atomic::Ordering::SeqCst));
}

// ─── The steps that other checks also cover ──────────────────────────────────
//
// Each of these steps has a neighbour that would catch a cancel a moment later, so a test that
// only checks the end result cannot tell them apart. These check what only the step itself does.

#[test]
fn test_a_folder_of_only_empty_folders_still_stops_between_entries() {
    // Nothing here reaches the check inside the file copy, so only the check between entries can stop it.
    let base = fresh_dir("qre_cancel_zip_empty");
    let folder = base.join("docs");
    for name in ["a", "b", "c"] {
        fs::create_dir_all(folder.join(name)).unwrap();
    }
    let out = base.join("docs.zip");
    let flag = cancel::new_flag();
    cancel::request(&flag);

    let result = cancel::run_with(&flag, || crate::utils::zip_directory_to_file(&folder, &out));

    assert_eq!(result.unwrap_err(), "Cancelled.");
    assert!(!out.exists());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_one_huge_file_inside_a_folder_is_stopped_while_it_is_copied_not_after() {
    // The flag is raised from another thread once the zip has started to grow, so the stop has to
    // come from inside the copy of this one file: no entry boundary is left to catch it.
    let base = fresh_dir("qre_cancel_zip_mid_file");
    let folder = base.join("docs");
    fs::create_dir_all(&folder).unwrap();
    let big: u64 = 384 * 1024 * 1024;
    fs::File::create(folder.join("huge.bin")).unwrap().set_len(big).unwrap();
    let out = base.join("docs.zip");
    let flag = cancel::new_flag();

    let watcher = {
        let (flag, out) = (flag.clone(), out.clone());
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < std::time::Duration::from_secs(60) {
                if fs::metadata(&out).map(|m| m.len()).unwrap_or(0) > 2 * 1024 * 1024 {
                    cancel::request(&flag);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            cancel::request(&flag);
        })
    };
    let result = cancel::run_with(&flag, || crate::utils::zip_directory_to_file(&folder, &out));
    watcher.join().unwrap();

    assert_eq!(result.unwrap_err(), "Cancelled.", "the whole huge file was copied before the stop");
    assert!(!out.exists());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_hashing_a_big_file_before_locking_is_stopped_while_it_hashes() {
    // The check before the first chunk is written is a later neighbour; this one must act at once.
    // A stop that comes a moment after the start has to return in much less time than the hash
    // alone takes.
    let base = fresh_dir("qre_cancel_prehash");
    let input = base.join("huge.bin");
    let big: u64 = 512 * 1024 * 1024;
    fs::File::create(&input).unwrap().set_len(big).unwrap();
    let locked = base.join("huge.bin.qre");

    // How long hashing this file takes, the same way the lock reads it.
    let baseline = {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let started = std::time::Instant::now();
        let mut reader = std::io::BufReader::new(fs::File::open(&input).unwrap());
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let n = reader.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let _ = hasher.finalize();
        started.elapsed()
    };

    let flag = cancel::new_flag();
    let watcher = {
        let flag = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(baseline / 10);
            cancel::request(&flag);
        })
    };
    let started = std::time::Instant::now();
    let result = cancel::run_with(&flag, || {
        crypto_stream::encrypt_file_stream_as(
            FileFormat::V8,
            input.to_str().unwrap(),
            locked.to_str().unwrap(),
            &key(7),
            "local",
            None,
            None,
            None,
            1,
            |_, _| {},
        )
    });
    let took = started.elapsed();
    watcher.join().unwrap();

    assert!(result.is_err() && crate::cancel::is_cancel_error(&result.unwrap_err()));
    assert!(!locked.exists());
    assert!(took < baseline / 2, "the lock kept hashing after the stop: {:?} against {:?} for the whole hash", took, baseline);
    let _ = fs::remove_dir_all(base);
}
