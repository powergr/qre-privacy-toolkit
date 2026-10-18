//! The key derivation settings stored in a keychain file are plain JSON that anyone with write
//! access to the folder can edit. These tests cover the limits that stop an edited value from
//! making the app try to allocate gigabytes. The shared helpers come from crypto_failure_tests.rs.

use crate::crypto_failure_tests::{fresh_dir, function_body};
use crate::keychain::{
    check_kdf_limits, init_keychain, recover_with_code, unlock_keychain, MAX_KDF_ITERATIONS, MAX_KDF_MEMORY_KIB,
    MAX_KDF_PARALLELISM,
};
use std::fs;
use std::path::PathBuf;

const PASSWORD: &str = "a long test password 123!";

#[test]
fn test_the_kdf_limits_allow_everything_the_app_writes() {
    // The desktop default, an older small vault, and the three portable USB tiers.
    for (mem, iter, par) in [(65_536, 3, 4), (19_456, 2, 1), (262_144, 5, 4), (524_288, 8, 4), (1_048_576, 10, 4)] {
        assert!(check_kdf_limits(mem, iter, par).is_ok(), "{} {} {}", mem, iter, par);
    }
}

#[test]
fn test_the_kdf_limits_refuse_one_step_above_each_cap() {
    assert!(check_kdf_limits(MAX_KDF_MEMORY_KIB, MAX_KDF_ITERATIONS, MAX_KDF_PARALLELISM).is_ok());
    assert!(check_kdf_limits(MAX_KDF_MEMORY_KIB + 1, 3, 4).is_err());
    assert!(check_kdf_limits(65_536, MAX_KDF_ITERATIONS + 1, 4).is_err());
    assert!(check_kdf_limits(65_536, 3, MAX_KDF_PARALLELISM + 1).is_err());
    assert!(check_kdf_limits(u32::MAX, u32::MAX, u32::MAX).is_err());
}

/// A real keychain with one setting changed in its JSON, the way anyone with write access could.
fn keychain_with(test: &str, field: &str, value: u64) -> (PathBuf, PathBuf, String) {
    let base = fresh_dir(test);
    let path = base.join("keychain.json");
    let (recovery_code, _) = init_keychain(&path, PASSWORD).unwrap();
    let mut json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    json[field] = serde_json::json!(value);
    fs::write(&path, serde_json::to_string_pretty(&json).unwrap()).unwrap();
    (base, path, recovery_code)
}

#[test]
fn test_a_keychain_asking_for_huge_memory_is_refused_at_once() {
    let (base, path, recovery_code) = keychain_with("qre_kdf_memory", "kdf_memory", 4_000_000_000);
    let started = std::time::Instant::now();

    let err = unlock_keychain(&path, PASSWORD).unwrap_err().to_string();
    assert!(err.contains("Invalid KDF parameters"), "unexpected message: {}", err);
    let err = recover_with_code(&path, &recovery_code, "another password 456!").unwrap_err().to_string();
    assert!(err.contains("Invalid KDF parameters"), "unexpected message: {}", err);

    assert!(started.elapsed() < std::time::Duration::from_secs(5), "the app tried to do the work");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_keychain_asking_for_too_many_passes_or_lanes_is_refused() {
    for (test, field) in [("qre_kdf_passes", "kdf_iterations"), ("qre_kdf_lanes", "kdf_parallelism")] {
        let (base, path, _) = keychain_with(test, field, 4_000_000_000);
        let err = unlock_keychain(&path, PASSWORD).unwrap_err().to_string();
        assert!(err.contains("Invalid KDF parameters"), "{}: {}", field, err);
        let _ = fs::remove_dir_all(base);
    }
}

#[test]
fn test_a_keychain_with_the_normal_settings_still_unlocks() {
    let base = fresh_dir("qre_kdf_normal");
    let path = base.join("keychain.json");
    let (_, created) = init_keychain(&path, PASSWORD).unwrap();
    let opened = unlock_keychain(&path, PASSWORD).unwrap();
    assert_eq!(opened.0, created.0);
    assert!(unlock_keychain(&path, "not the password").is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_both_key_derivations_use_the_same_limits() {
    let keychain = include_str!("keychain.rs");
    assert!(function_body(keychain, "fn derive_kek(").contains("check_kdf_limits("));
    let portable = include_str!("commands/portable.rs");
    assert!(function_body(portable, "fn derive_kek(").contains("check_kdf_limits("), "the USB vault no longer checks its settings");
}
