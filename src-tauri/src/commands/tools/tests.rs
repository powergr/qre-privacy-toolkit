use super::*;
use std::fs;
use std::path::{Path, PathBuf};

// Not real keys. They only have the shape the scanner looks for. They are put together
// when a test runs, because a complete key written out in the source is flagged by secret
// scanners (GitHub's push protection blocks the push), even when it is made up.
fn stripe_key() -> String {
    ["sk", "live", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("_")
}
fn github_token() -> String {
    ["ghp", "0123456789abcdefghijklmnopqrstuvwxyz"].join("_")
}
fn aws_key() -> String {
    ["AKIA", "IOSFODNN7ABCDEFG"].concat()
}

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qre_secret_scan_{}_{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    // The command resolves the folder before scanning. A Mac's temp folder is a link
    // (/var points to /private/var), so the tests must scan the resolved path too.
    fs::canonicalize(&dir).unwrap()
}

/// A folder where every scannable file holds a secret.
fn folder_with_secrets(name: &str, count: usize) -> PathBuf {
    let dir = workdir(name);
    let secrets = [stripe_key(), github_token(), aws_key()];
    for i in 0..count {
        fs::write(dir.join(format!("notes{i}.txt")), format!("key = {}\n", secrets[i % 3])).unwrap();
    }
    dir
}

fn scan(dir: &Path) -> Vec<SecretFinding> {
    let cancel = AtomicBool::new(false);
    scan_for_secrets(dir, &cancel, |_| {}).unwrap()
}

fn names(findings: &[SecretFinding]) -> Vec<String> {
    let mut n: Vec<String> = findings.iter().map(|f| f.filename.clone()).collect();
    n.sort();
    n
}

// ── what the scan finds ─────────────────────────────────────────────────

#[test]
fn test_scan_finds_secrets_and_skips_clean_files() {
    let dir = workdir("finds");
    fs::write(dir.join("stripe.txt"), format!("STRIPE={}\n", stripe_key())).unwrap();
    fs::write(dir.join("github.csv"), format!("token,{}\n", github_token())).unwrap();
    fs::write(dir.join("aws.env"), format!("AWS_KEY={}\n", aws_key())).unwrap();
    fs::write(dir.join("clean.txt"), "just a shopping list\n").unwrap();

    let found = scan(&dir);

    assert_eq!(names(&found), vec!["aws.env", "github.csv", "stripe.txt"]);
    assert!(found.iter().all(|f| f.category == "API Key"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_scan_skips_dependency_folders() {
    let dir = workdir("skipdirs");
    fs::create_dir_all(dir.join("node_modules")).unwrap();
    fs::write(dir.join("node_modules").join("leak.txt"), stripe_key()).unwrap();
    fs::write(dir.join("real.txt"), stripe_key()).unwrap();

    assert_eq!(names(&scan(&dir)), vec!["real.txt"]);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_scan_ignores_example_files_and_comments() {
    let dir = workdir("examples");
    fs::write(dir.join("config.example.txt"), stripe_key()).unwrap();
    fs::write(dir.join("commented.txt"), format!("# {}\n", stripe_key())).unwrap();
    assert!(scan(&dir).is_empty());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_scan_rejects_a_path_that_is_not_a_folder() {
    let cancel = AtomicBool::new(false);
    let result = scan_for_secrets(Path::new("Z:\\no\\such\\folder"), &cancel, |_| {});
    assert_eq!(result.err().as_deref(), Some("Invalid directory"));
}

#[test]
fn test_scan_reports_each_file_it_reads() {
    let dir = folder_with_secrets("progress", 2);
    let seen = std::cell::RefCell::new(Vec::new());
    let cancel = AtomicBool::new(false);

    scan_for_secrets(&dir, &cancel, |p| seen.borrow_mut().push(p.to_string())).unwrap();

    let seen = seen.into_inner();
    assert_eq!(seen.len(), 2);
    assert!(seen.iter().all(|p| p.contains("notes")));
    let _ = fs::remove_dir_all(dir);
}

// ── cancelling ──────────────────────────────────────────────────────────

#[test]
fn test_cancel_stops_the_scan_and_keeps_partial_results() {
    let dir = folder_with_secrets("cancel", 3);
    let slot = CancelSlot::new();
    let first = std::cell::Cell::new(true);

    let found = run_secret_scan(&dir, &slot, |_| {
        if first.replace(false) {
            slot.cancel();
        }
    })
    .unwrap();

    assert_eq!(found.len(), 1, "the file being read is kept, the rest are skipped");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_cancelled_scan_stays_cancelled_when_another_scan_starts() {
    // Cancel scan A, then start scan B while A is still going. Starting B must not
    // un-cancel A, which a single shared flag that B resets would do.
    let dir_a = folder_with_secrets("race_a", 3);
    let dir_b = folder_with_secrets("race_b", 2);
    let slot = CancelSlot::new();
    let started_b = std::cell::Cell::new(false);
    let b_result = std::cell::RefCell::new(None);

    let a = run_secret_scan(&dir_a, &slot, |_| {
        if !started_b.replace(true) {
            slot.cancel();
            *b_result.borrow_mut() = Some(run_secret_scan(&dir_b, &slot, |_| {}));
        }
    })
    .unwrap();

    assert_eq!(a.len(), 1, "scan A must still stop after its first file");
    let b = b_result.borrow_mut().take().unwrap().unwrap();
    assert_eq!(b.len(), 2, "scan B was never cancelled and must read both files");

    let _ = fs::remove_dir_all(dir_a);
    let _ = fs::remove_dir_all(dir_b);
}

#[test]
fn test_cancel_secret_scan_command_cancels_the_running_scan() {
    let flag = SCAN_CANCEL.begin();
    assert!(!flag.load(Ordering::SeqCst));
    tauri::async_runtime::block_on(cancel_secret_scan()).unwrap();
    assert!(flag.load(Ordering::SeqCst));
}

#[test]
fn test_a_cancel_sent_before_a_scan_does_not_stop_it() {
    let dir = folder_with_secrets("stale", 3);
    let slot = CancelSlot::new();
    slot.cancel();

    let found = run_secret_scan(&dir, &slot, |_| {}).unwrap();

    assert_eq!(found.len(), 3);
    let _ = fs::remove_dir_all(dir);
}

// ── Linux and macOS folders the secret scan must not enter ───────────────
// These test the path text only, so they run on every platform.

#[test]
fn test_unix_system_folders_are_blocked() {
    for p in [
        "/etc",
        "/etc/passwd",
        "/dev/null",
        "/var/log/syslog",
        "/bin/sh",
        "/sbin/init",
        "/usr/bin/env",
        "/usr/sbin/cron",
        "/usr/lib/python3",
        "/proc/1/environ",
        "/sys/class",
        "/boot/grub/grub.cfg",
    ] {
        assert!(is_blocked_unix_path(p), "{p} must be blocked");
    }
}

#[test]
fn test_unix_credential_folders_are_blocked_anywhere() {
    for p in [
        "/home/alice/.ssh",
        "/home/alice/.ssh/id_ed25519",
        "/home/alice/.aws/credentials",
        "/home/alice/.gnupg/private-keys-v1.d",
        "/home/alice/.mozilla/firefox/profile",
        "/home/alice/.config/google-chrome/Default",
        "/Users/bob/Library/Keychains/login.keychain-db",
        "/mnt/backup/alice/.ssh/config",
    ] {
        assert!(is_blocked_unix_path(p), "{p} must be blocked");
    }
}

#[test]
fn test_unix_blocking_ignores_letter_case() {
    assert!(is_blocked_unix_path("/ETC/passwd"));
    assert!(is_blocked_unix_path("/Users/bob/library/KEYCHAINS"));
}

#[test]
fn test_unix_user_folders_that_only_look_like_system_names_are_allowed() {
    // A developer's own `dev` folder, or a name that merely starts like a system folder.
    for p in [
        "/home/alice/dev",
        "/home/alice/dev/project/notes.txt",
        "/home/alice/variables",
        "/home/alice/etc-notes",
        "/home/alice/system",
        "/home/alice/boot",
        "/home/alice/binaries",
        "/home/alice/ssh-notes",
        "/home/alice/Documents/.sshnotes",
        "/devices/inventory",
        "/variable-data",
        "/binary",
    ] {
        assert!(!is_blocked_unix_path(p), "{p} must be scannable");
    }
}

#[test]
fn test_unix_system_names_deeper_in_the_tree_are_allowed() {
    // System folders only count at the root. Backups keep copies of them elsewhere.
    assert!(!is_blocked_unix_path("/mnt/backup/etc/hosts.txt"));
    assert!(!is_blocked_unix_path("/home/alice/projects/var/notes.txt"));
}

#[test]
fn test_unix_ordinary_locations_are_allowed() {
    for p in [
        "/home/alice",
        "/home/alice/Documents",
        "/home/alice/.config/other-app",
        "/tmp/work",
        "/mnt/data",
        "/usr/local/share/docs",
        "/Users/bob/Documents",
        "/",
        "",
    ] {
        assert!(!is_blocked_unix_path(p), "{p:?} must be scannable");
    }
}

#[test]
fn test_unix_paths_with_repeated_slashes_are_still_checked() {
    assert!(is_blocked_unix_path("//etc//passwd"));
    assert!(is_blocked_unix_path("/home//alice//.ssh"));
}

#[test]
fn test_unix_macos_system_folders_are_blocked() {
    for p in [
        "/System/Library/CoreServices",
        "/Library/Preferences",
        "/private/etc/hosts",
        "/private/var/db/dslocal",
        "/private/var/log/system.log",
        "/private/var/root",
    ] {
        assert!(is_blocked_unix_path(p), "{p} must be blocked");
    }
}

#[test]
fn test_unix_macos_user_temp_folder_is_scannable() {
    // A Mac's per-user temporary folder lives inside /private/var.
    assert!(!is_blocked_unix_path("/private/var/folders/zz/abc123/T/notes.txt"));
    assert!(!is_blocked_unix_path("/Users/bob/Library/Application Support/App"));
}
