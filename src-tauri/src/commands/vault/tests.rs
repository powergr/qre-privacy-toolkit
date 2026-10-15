use super::*;
use crate::clipboard_store::ClipboardEntry;
use crate::keychain::MasterKey;

fn key(seed: u8) -> MasterKey {
    MasterKey([seed; 32])
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qre_vault_cmd_{}_{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn poison(state: &SessionState) {
    let vaults = state.vaults.clone();
    let _ = std::thread::spawn(move || {
        let _guard = vaults.lock().unwrap();
        panic!("deliberate panic to poison the session mutex");
    })
    .join();
    assert!(state.vaults.is_poisoned());
}

// ── Lockout ──────────────────────────────────────────────────────────────

#[test]
fn test_lockout_duration_doubles_then_caps() {
    assert_eq!(lockout_duration_secs(5), 30);
    assert_eq!(lockout_duration_secs(6), 60);
    assert_eq!(lockout_duration_secs(7), 120);
    assert_eq!(lockout_duration_secs(8), 240);
    assert_eq!(lockout_duration_secs(9), 480);
    assert_eq!(lockout_duration_secs(10), 480, "must cap at 480 seconds");
    assert_eq!(lockout_duration_secs(u32::MAX), 480);
}

#[test]
fn test_no_lockout_below_the_attempt_limit() {
    for fails in 0..MAX_ATTEMPTS_BEFORE_LOCKOUT {
        assert_eq!(lockout_remaining_secs(fails, 1_000, 1_000), None);
    }
}

#[test]
fn test_lockout_counts_down_and_then_expires() {
    let fails = MAX_ATTEMPTS_BEFORE_LOCKOUT;
    assert_eq!(lockout_remaining_secs(fails, 1_000, 1_000), Some(30));
    assert_eq!(lockout_remaining_secs(fails, 1_000, 1_015), Some(15));
    assert_eq!(lockout_remaining_secs(fails, 1_000, 1_029), Some(1));
    assert_eq!(lockout_remaining_secs(fails, 1_000, 1_030), None);
    assert_eq!(lockout_remaining_secs(fails, 1_000, 99_999), None);
}

#[test]
fn test_lockout_survives_the_clock_moving_backwards() {
    // now < last_fail must not underflow or unlock early.
    assert_eq!(
        lockout_remaining_secs(MAX_ATTEMPTS_BEFORE_LOCKOUT, 5_000, 100),
        Some(30)
    );
}

// ── Session state ────────────────────────────────────────────────────────

#[test]
fn test_session_key_returns_key_only_for_unlocked_vault() {
    let state = SessionState::new();
    assert_eq!(session_key(&state, "local").unwrap_err(), "Vault is locked");

    state.vaults.lock().unwrap().insert("local".into(), key(7));
    assert_eq!(session_key(&state, "local").unwrap().0, [7u8; 32]);
    assert!(session_key(&state, "other").is_err());
}

#[test]
fn test_session_key_on_poisoned_state_errors_and_wipes_all_keys() {
    let state = SessionState::new();
    state.vaults.lock().unwrap().insert("local".into(), key(1));
    poison(&state);

    let err = session_key(&state, "local").unwrap_err();
    assert!(err.contains("corrupted"), "got: {err}");
    let remaining = state.vaults.lock().unwrap_or_else(|e| e.into_inner()).len();
    assert_eq!(remaining, 0, "a poisoned session must not keep any key");
}

#[test]
fn test_clear_all_sessions_locks_every_vault() {
    let state = SessionState::new();
    {
        let mut v = state.vaults.lock().unwrap();
        v.insert("local".into(), key(1));
        v.insert("usb-uuid".into(), key(2));
    }
    clear_all_sessions(&state);
    assert!(state.vaults.lock().unwrap().is_empty());
}

#[test]
fn test_clear_all_sessions_works_on_a_poisoned_mutex() {
    let state = SessionState::new();
    state.vaults.lock().unwrap().insert("local".into(), key(1));
    poison(&state);

    clear_all_sessions(&state);
    let remaining = state.vaults.lock().unwrap_or_else(|e| e.into_inner()).len();
    assert_eq!(remaining, 0);
}

#[test]
fn test_auth_status_covers_all_four_states() {
    let dir = temp_dir("auth_status");
    let keychain = dir.join("keychain.json");
    let state = SessionState::new();

    assert_eq!(auth_status(&state, None), "setup_needed");
    assert_eq!(auth_status(&state, Some(&keychain)), "setup_needed");

    fs::write(&keychain, b"{}").unwrap();
    assert_eq!(auth_status(&state, Some(&keychain)), "locked");

    state.vaults.lock().unwrap().insert("local".into(), key(1));
    assert_eq!(auth_status(&state, Some(&keychain)), "unlocked");
    // Unlocked wins even if the keychain path could not be resolved.
    assert_eq!(auth_status(&state, None), "unlocked");

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_auth_status_reports_locked_when_state_is_poisoned() {
    let state = SessionState::new();
    poison(&state);
    assert_eq!(auth_status(&state, None), "locked");
}

// ── Encrypted vault files ────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
struct Sample {
    title: String,
    count: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
struct OtherShape {
    unrelated: Vec<String>,
}

#[test]
fn test_vault_file_roundtrip() {
    let dir = temp_dir("roundtrip");
    let path = dir.join("sample.qre");
    let value = Sample { title: "héllo".into(), count: 3 };

    write_vault_file(&path, &key(5), "sample.json", &value).unwrap();
    let loaded: Option<Sample> = read_vault_file(&path, &key(5), "bad").unwrap();
    assert_eq!(loaded, Some(value));

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_vault_file_missing_is_none_not_an_error() {
    let dir = temp_dir("missing");
    let loaded: Option<Sample> = read_vault_file(&dir.join("nope.qre"), &key(5), "bad").unwrap();
    assert!(loaded.is_none());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_vault_file_is_not_readable_in_plaintext_or_with_the_wrong_key() {
    let dir = temp_dir("wrong_key");
    let path = dir.join("sample.qre");
    let marker = "TOP-SECRET-MARKER";
    let value = Sample { title: marker.into(), count: 1 };
    write_vault_file(&path, &key(5), "sample.json", &value).unwrap();

    let raw = fs::read(&path).unwrap();
    assert!(
        !raw.windows(marker.len()).any(|w| w == marker.as_bytes()),
        "vault file must not contain the plaintext"
    );
    assert!(read_vault_file::<Sample>(&path, &key(6), "bad").is_err());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_vault_file_with_unexpected_shape_returns_the_parse_error_message() {
    let dir = temp_dir("wrong_shape");
    let path = dir.join("sample.qre");
    write_vault_file(&path, &key(5), "x.json", &OtherShape { unrelated: vec![] }).unwrap();

    let err = read_vault_file::<Sample>(&path, &key(5), "Failed to parse sample").unwrap_err();
    assert_eq!(err, "Failed to parse sample");

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn test_vault_file_garbage_content_is_an_error_not_a_panic() {
    let dir = temp_dir("garbage");
    let path = dir.join("sample.qre");
    fs::write(&path, b"this is definitely not an encrypted container").unwrap();
    assert!(read_vault_file::<Sample>(&path, &key(5), "bad").is_err());

    fs::write(&path, b"").unwrap();
    assert!(read_vault_file::<Sample>(&path, &key(5), "bad").is_err());

    let _ = fs::remove_dir_all(dir);
}

// ── Clipboard expiry ─────────────────────────────────────────────────────

const NOW_MS: i64 = 1_700_000_000_000;
const NOW_SEC: i64 = 1_700_000_000;

fn clip(id: &str, created_at: i64, is_pinned: bool) -> ClipboardEntry {
    ClipboardEntry {
        id: id.into(),
        content: "c".into(),
        preview: "p".into(),
        category: "Text".into(),
        created_at,
        is_pinned,
    }
}

fn vault_with(entries: Vec<ClipboardEntry>) -> ClipboardVault {
    let mut v = ClipboardVault::new();
    v.entries = entries;
    v
}

fn ids(v: &ClipboardVault) -> Vec<&str> {
    v.entries.iter().map(|e| e.id.as_str()).collect()
}

#[test]
fn test_clipboard_expiry_removes_only_old_entries() {
    let mut v = vault_with(vec![
        clip("fresh", NOW_SEC - 60, false),
        clip("old", NOW_SEC - 2 * 3600 - 1, false),
    ]);
    assert!(drop_expired_clipboard_entries(&mut v, NOW_MS, 2));
    assert_eq!(ids(&v), vec!["fresh"]);
}

#[test]
fn test_clipboard_expiry_boundary_is_exclusive() {
    // Exactly ttl old is expired; one second younger survives.
    let mut v = vault_with(vec![
        clip("exact", NOW_SEC - 3600, false),
        clip("just_inside", NOW_SEC - 3599, false),
    ]);
    drop_expired_clipboard_entries(&mut v, NOW_MS, 1);
    assert_eq!(ids(&v), vec!["just_inside"]);
}

#[test]
fn test_clipboard_expiry_understands_millisecond_timestamps() {
    let mut v = vault_with(vec![
        clip("fresh_ms", NOW_MS - 60_000, false),
        clip("old_ms", NOW_MS - 3 * 3_600_000, false),
    ]);
    drop_expired_clipboard_entries(&mut v, NOW_MS, 1);
    assert_eq!(ids(&v), vec!["fresh_ms"]);
}

#[test]
fn test_clipboard_expiry_never_deletes_pinned_entries() {
    let mut v = vault_with(vec![
        clip("pinned_old", NOW_SEC - 90 * 24 * 3600, true),
        clip("unpinned_old", NOW_SEC - 90 * 24 * 3600, false),
    ]);
    assert!(drop_expired_clipboard_entries(&mut v, NOW_MS, 1));
    assert_eq!(ids(&v), vec!["pinned_old"]);
}

#[test]
fn test_clipboard_expiry_reports_no_change_when_nothing_expires() {
    let mut v = vault_with(vec![clip("a", NOW_SEC - 10, false)]);
    assert!(!drop_expired_clipboard_entries(&mut v, NOW_MS, 24));
    assert_eq!(v.entries.len(), 1);
}

#[test]
fn test_clipboard_expiry_zero_retention_drops_unpinned_only() {
    let mut v = vault_with(vec![clip("a", NOW_SEC, false), clip("b", NOW_SEC, true)]);
    drop_expired_clipboard_entries(&mut v, NOW_MS, 0);
    assert_eq!(ids(&v), vec!["b"]);
}

#[test]
fn test_clipboard_expiry_huge_retention_keeps_everything() {
    // Must not overflow or wrap to a negative TTL that expires every entry.
    let mut v = vault_with(vec![clip("a", NOW_SEC - 1_000_000, false)]);
    assert!(!drop_expired_clipboard_entries(&mut v, NOW_MS, u64::MAX));
    assert_eq!(v.entries.len(), 1);
}

// ── TOTP ─────────────────────────────────────────────────────────────────

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890".
const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

#[test]
fn test_totp_matches_rfc_6238_vectors() {
    for (time, code) in [
        (59u64, "287082"),
        (1_111_111_109, "081804"),
        (1_111_111_111, "050471"),
        (1_234_567_890, "005924"),
        (2_000_000_000, "279037"),
        (20_000_000_000, "353130"),
    ] {
        let (got, _) = totp_code_at(RFC_SECRET, time).unwrap();
        assert_eq!(got, code, "wrong code at t={time}");
    }
}

#[test]
fn test_totp_reports_seconds_left_in_the_30_second_window() {
    assert_eq!(totp_code_at(RFC_SECRET, 60).unwrap().1, 30);
    assert_eq!(totp_code_at(RFC_SECRET, 59).unwrap().1, 1);
    assert_eq!(totp_code_at(RFC_SECRET, 75).unwrap().1, 15);
}

#[test]
fn test_totp_accepts_spaces_dashes_lowercase_and_padding() {
    let expected = totp_code_at(RFC_SECRET, 59).unwrap().0;
    for variant in [
        "gezd gnbv gy3t qojq gezd gnbv gy3t qojq",
        "GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ",
        "gezdgnbvgy3tqojqgezdgnbvgy3tqojq====",
        "  GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ  ",
    ] {
        assert_eq!(totp_code_at(variant, 59).unwrap().0, expected, "variant: {variant}");
    }
}

#[test]
fn test_totp_rejects_invalid_base32_without_echoing_the_secret() {
    let secret = "not-base32-1890!!";
    let err = totp_code_at(secret, 59).unwrap_err();
    assert!(err.contains("Base32"), "got: {err}");
    assert!(!err.contains("1890"), "error must not echo the secret");
}

#[test]
fn test_totp_rejects_empty_secret() {
    assert!(totp_code_at("", 59).is_err());
    assert!(totp_code_at("   ", 59).is_err());
}
