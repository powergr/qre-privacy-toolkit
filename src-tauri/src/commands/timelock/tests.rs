use super::*;

fn abs(name: &str) -> String {
    std::env::temp_dir().join(name).to_string_lossy().to_string()
}

fn critical_example() -> &'static str {
    if cfg!(target_os = "windows") {
        "C:\\Windows\\notepad.exe"
    } else {
        "/etc/passwd"
    }
}

// ── validate_timelock_source_path ────────────────────────────────────────

#[test]
fn test_timelock_accepts_a_normal_absolute_path() {
    assert!(validate_timelock_source_path(&abs("report.txt")).is_ok());
}

#[test]
fn test_timelock_rejects_parent_dir_traversal() {
    let sneaky = std::env::temp_dir().join("..").join("x.txt");
    let err = validate_timelock_source_path(&sneaky.to_string_lossy()).unwrap_err();
    assert!(err.contains("traversal"), "got: {err}");
}

#[test]
fn test_timelock_rejects_relative_paths() {
    let err = validate_timelock_source_path("docs/file.txt").unwrap_err();
    assert!(err.contains("absolute"), "got: {err}");
    assert!(validate_timelock_source_path("file.txt").is_err());
    assert!(validate_timelock_source_path("").is_err());
}

#[test]
fn test_timelock_rejects_already_encrypted_qre_files() {
    let err = validate_timelock_source_path(&abs("secret.txt.qre")).unwrap_err();
    assert!(err.contains(".qre"), "got: {err}");
}

#[test]
fn test_timelock_rejects_protected_system_paths() {
    let err = validate_timelock_source_path(critical_example()).unwrap_err();
    assert!(err.contains("protected"), "got: {err}");
}

// ── timelock_status_at ───────────────────────────────────────────────────

#[test]
fn test_status_for_a_file_that_is_not_time_locked() {
    let s = timelock_status_at(None, 1_000);
    assert!(!s.is_locked);
    assert_eq!(s.locked_until, 0);
    assert!(s.remaining_display.is_empty());
}

#[test]
fn test_status_while_the_lock_is_active() {
    let s = timelock_status_at(Some(1_000 + 3_600), 1_000);
    assert!(s.is_locked);
    assert_eq!(s.locked_until, 4_600);
    assert!(!s.remaining_display.is_empty());
}

#[test]
fn test_status_unlocks_exactly_at_the_deadline() {
    let before = timelock_status_at(Some(5_000), 4_999);
    assert!(before.is_locked);
    let at = timelock_status_at(Some(5_000), 5_000);
    assert!(!at.is_locked, "the file must open the second the deadline arrives");
    assert!(at.remaining_display.is_empty());
    assert_eq!(at.locked_until, 5_000);
}

#[test]
fn test_status_after_the_lock_has_expired() {
    let s = timelock_status_at(Some(5_000), 9_999_999);
    assert!(!s.is_locked);
    assert_eq!(s.locked_until, 5_000);
    assert!(s.remaining_display.is_empty());
}
