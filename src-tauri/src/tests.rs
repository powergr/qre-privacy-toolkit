#[cfg(test)]
mod tests {
    use crate::crypto;
    use crate::crypto_stream;
    use crate::keychain::MasterKey;
    use std::fs;
    use std::io::Write;

    // -------------------------------------------------------------------------
    // SHARED HELPERS
    // No external crates needed — all I/O uses std::env::temp_dir().
    // Each test gets its own uniquely named subdirectory so parallel test runs
    // (cargo test) never collide with each other.
    // -------------------------------------------------------------------------

    pub fn mk(seed: u8) -> MasterKey {
        MasterKey([seed; 32])
    }

    fn entropy(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    /// Creates a fresh, empty temp directory for one test.
    /// The caller is responsible for removing it at the end.
    fn make_test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Writes `content` into `dir/filename` and returns the full path string.
    fn write_file(dir: &std::path::Path, filename: &str, content: &[u8]) -> String {
        let path = dir.join(filename);
        fs::File::create(&path).unwrap().write_all(content).unwrap();
        path.to_str().unwrap().to_owned()
    }

    /// Simulates a real vault JSON payload the way the Tauri backend serializes it.
    /// Matches the `VaultEntry` shape used by useVault.ts / vault.rs.
    fn vault_json_payload() -> Vec<u8> {
        serde_json::json!({
            "entries": [
                {
                    "id": "a1b2c3d4-0000-4000-8000-000000000001",
                    "service": "GitHub",
                    "username": "alice@example.com",
                    "password": "correct-horse-battery-staple",
                    "url": "https://github.com",
                    "notes": "Work account",
                    "color": "#1DA1F2",
                    "is_pinned": true,
                    "created_at": 1_700_000_000_u64,
                    "updated_at": 1_700_000_000_u64
                },
                {
                    "id": "a1b2c3d4-0000-4000-8000-000000000002",
                    "service": "Proton Mail",
                    "username": "alice@proton.me",
                    "password": "Tr0ub4dor&3",
                    "url": "https://proton.me",
                    "notes": "",
                    "color": "#8e44ad",
                    "is_pinned": false,
                    "created_at": 1_700_000_001_u64,
                    "updated_at": 1_700_000_001_u64
                }
            ]
        })
        .to_string()
        .into_bytes()
    }

    // =========================================================================
    // SECTION 1 — V5 STREAMING ENGINE (original tests, unchanged)
    // =========================================================================

    #[test]
    fn test_v5_streaming_roundtrip_standard() {
        let test_dir = std::env::temp_dir().join("qre_v5_standard");
        let _ = fs::remove_dir_all(&test_dir);
        fs::create_dir_all(&test_dir).unwrap();

        let input_path = test_dir.join("secret.txt");
        let encrypted_path = test_dir.join("secret.txt.qre");
        let output_dir = test_dir.join("output");
        fs::create_dir_all(&output_dir).unwrap();

        let original_data = b"Streaming Encryption Test Data! Standard Mode.";
        fs::File::create(&input_path)
            .unwrap()
            .write_all(original_data)
            .unwrap();

        let mk = MasterKey([42u8; 32]);
        let progress_cb = |_, _| {};

        crypto_stream::encrypt_file_stream(
            input_path.to_str().unwrap(),
            encrypted_path.to_str().unwrap(),
            &mk,
            "local", // <--- ADDED VAULT ID
            None,
            None,
            1,
            progress_cb,
        )
        .expect("V5 Encryption failed");

        let result_filename = crypto_stream::decrypt_file_stream(
            encrypted_path.to_str().unwrap(),
            output_dir.to_str().unwrap(),
            &mk,
            None,
            progress_cb,
        )
        .expect("V5 Decryption failed");

        let final_path = output_dir.join(result_filename);
        let decrypted_data = fs::read(&final_path).unwrap();
        assert_eq!(decrypted_data, original_data, "V5 Decrypted data mismatch");

        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn test_v5_streaming_paranoid_and_keyfile() {
        let test_dir = std::env::temp_dir().join("qre_v5_paranoid");
        let _ = fs::remove_dir_all(&test_dir);
        fs::create_dir_all(&test_dir).unwrap();

        let input_path = test_dir.join("paranoid.txt");
        let encrypted_path = test_dir.join("paranoid.txt.qre");
        let output_dir = test_dir.join("output");
        fs::create_dir_all(&output_dir).unwrap();

        let original_data = b"Testing Paranoid Mode and Keyfile mixing.";
        fs::File::create(&input_path)
            .unwrap()
            .write_all(original_data)
            .unwrap();

        let mk = MasterKey([77u8; 32]);
        let keyfile_data = b"My Super Secret Keyfile Data";
        let entropy_seed = [99u8; 32];
        let progress_cb = |_, _| {};

        crypto_stream::encrypt_file_stream(
            input_path.to_str().unwrap(),
            encrypted_path.to_str().unwrap(),
            &mk,
            "local", // <--- ADDED VAULT ID
            Some(keyfile_data),
            Some(entropy_seed), // <--- REMOVED REFERENCE '&'
            3,
            progress_cb,
        )
        .expect("V5 Paranoid Encryption failed");

        let result_filename = crypto_stream::decrypt_file_stream(
            encrypted_path.to_str().unwrap(),
            output_dir.to_str().unwrap(),
            &mk,
            Some(keyfile_data),
            progress_cb,
        )
        .expect("V5 Paranoid Decryption failed");

        let final_path = output_dir.join(result_filename);
        let decrypted_data = fs::read(&final_path).unwrap();
        assert_eq!(decrypted_data, original_data);

        let _ = fs::remove_dir_all(test_dir);
    }

    #[test]
    fn test_v5_streaming_wrong_password_fails() {
        let test_dir = std::env::temp_dir().join("qre_v5_fail");
        let _ = fs::remove_dir_all(&test_dir);
        fs::create_dir_all(&test_dir).unwrap();

        let input_path = test_dir.join("fail.txt");
        let encrypted_path = test_dir.join("fail.txt.qre");
        let output_dir = test_dir.join("output");
        fs::create_dir_all(&output_dir).unwrap();

        fs::File::create(&input_path)
            .unwrap()
            .write_all(b"Secret")
            .unwrap();

        let correct_mk = MasterKey([1u8; 32]);
        let wrong_mk = MasterKey([2u8; 32]);

        crypto_stream::encrypt_file_stream(
            input_path.to_str().unwrap(),
            encrypted_path.to_str().unwrap(),
            &correct_mk,
            "local", // <--- ADDED VAULT ID
            None,
            None,
            1,
            |_, _| {},
        )
        .unwrap();

        let result = crypto_stream::decrypt_file_stream(
            encrypted_path.to_str().unwrap(),
            output_dir.to_str().unwrap(),
            &wrong_mk,
            None,
            |_, _| {},
        );

        assert!(
            result.is_err(),
            "Decryption should have failed with wrong key!"
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Decryption Denied"));

        let _ = fs::remove_dir_all(test_dir);
    }
    // =========================================================================
    // SECTION 2 — V4 IN-MEMORY ENGINE (original tests, unchanged)
    // =========================================================================

    #[test]
    fn test_v4_memory_roundtrip() {
        let original_data = b"This is a JSON payload for the Password Vault.";
        let filename = "passwords.json";
        let mk = MasterKey([123u8; 32]);

        let container =
            crypto::encrypt_file_with_master_key(&mk, None, filename, original_data, None, 3)
                .expect("V4 Encryption failed");

        assert_eq!(container.version, 4);
        assert!(!container.ciphertext.is_empty());

        let decrypted_payload = crypto::decrypt_file_with_master_key(&mk, None, &container)
            .expect("V4 Decryption failed");

        assert_eq!(decrypted_payload.filename, filename);
        assert_eq!(decrypted_payload.content, original_data);
    }

    #[test]
    fn test_v4_memory_wrong_keyfile_fails() {
        let original_data = b"Vault Data";
        let mk = MasterKey([50u8; 32]);
        let correct_keyfile = b"ValidKeyfile";
        let wrong_keyfile = b"InvalidKeyfile";

        let container = crypto::encrypt_file_with_master_key(
            &mk,
            Some(correct_keyfile),
            "test.json",
            original_data,
            None,
            3,
        )
        .unwrap();

        let result = crypto::decrypt_file_with_master_key(&mk, Some(wrong_keyfile), &container);

        assert!(
            result.is_err(),
            "V4 Decryption should fail with wrong keyfile"
        );
    }

    // =========================================================================
    // SECTION 3 — PASSWORD VAULT (V4 real-world JSON payloads)
    // Tests the exact data path used by vault.rs / useVault.ts
    // =========================================================================

    /// The vault is a real JSON blob — verify it survives a full encrypt/decrypt
    /// cycle and parses back to valid JSON with all entries intact.
    #[test]
    fn test_vault_json_roundtrip() {
        let payload = vault_json_payload();
        let mk = mk(10);

        let container =
            crypto::encrypt_file_with_master_key(&mk, None, "vault.json", &payload, None, 3)
                .expect("Vault encryption failed");

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container)
            .expect("Vault decryption failed");

        assert_eq!(
            result.content, payload,
            "Vault JSON payload must be identical after roundtrip"
        );

        let parsed: serde_json::Value =
            serde_json::from_slice(&result.content).expect("Decrypted vault must be valid JSON");

        let entries = parsed["entries"]
            .as_array()
            .expect("entries must be an array");
        assert_eq!(entries.len(), 2, "Both vault entries must survive");
        assert_eq!(entries[0]["service"], "GitHub");
        assert_eq!(entries[1]["service"], "Proton Mail");
        assert_eq!(
            entries[0]["password"], "correct-horse-battery-staple",
            "Password must not be altered"
        );
    }

    /// The filename stored inside the V4 container must always be "vault.json"
    /// regardless of what path was passed in — this is what vault.rs relies on
    /// to route the decrypted bytes to the right handler.
    #[test]
    fn test_vault_filename_preserved_in_container() {
        let mk = mk(11);
        let container = crypto::encrypt_file_with_master_key(
            &mk,
            None,
            "vault.json",
            &vault_json_payload(),
            None,
            3,
        )
        .unwrap();

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container).unwrap();

        assert_eq!(
            result.filename, "vault.json",
            "Vault filename must be preserved so the backend can identify the payload type"
        );
    }

    /// A vault encrypted with a keyfile must be completely unreadable without it —
    /// even if the correct master key is supplied.
    #[test]
    fn test_vault_with_keyfile_unreadable_without_it() {
        let mk = mk(12);
        let keyfile = b"hardware-token-bytes-32bytes!!!!";

        let container = crypto::encrypt_file_with_master_key(
            &mk,
            Some(keyfile),
            "vault.json",
            &vault_json_payload(),
            None,
            3,
        )
        .unwrap();

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container);
        assert!(
            result.is_err(),
            "Vault must not open without its required keyfile"
        );
    }

    /// Two consecutive encryptions of the same vault must produce different
    /// ciphertexts — prevents an attacker comparing snapshots to detect changes.
    #[test]
    fn test_vault_ciphertexts_differ_across_saves() {
        let mk = mk(13);
        let payload = vault_json_payload();

        let c1 = crypto::encrypt_file_with_master_key(&mk, None, "vault.json", &payload, None, 3)
            .unwrap();
        let c2 = crypto::encrypt_file_with_master_key(&mk, None, "vault.json", &payload, None, 3)
            .unwrap();

        assert_ne!(
            c1.ciphertext, c2.ciphertext,
            "Each vault save must produce a unique ciphertext (OsRng nonce)"
        );
    }

    /// Flipping one byte of the encrypted vault ciphertext must cause decryption
    /// to fail — AES-GCM authentication tag catches any tampering.
    #[test]
    fn test_vault_tamper_detected() {
        let mk = mk(14);
        let mut container = crypto::encrypt_file_with_master_key(
            &mk,
            None,
            "vault.json",
            &vault_json_payload(),
            None,
            3,
        )
        .unwrap();

        let mid = container.ciphertext.len() / 2;
        container.ciphertext[mid] ^= 0xFF;

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container);
        assert!(
            result.is_err(),
            "Tampered vault ciphertext must be rejected"
        );
    }

    /// Corrupting the stored SHA-256 hash in the container header must fail at
    /// the integrity check step — independently of the AES-GCM auth tag.
    #[test]
    fn test_vault_integrity_hash_detects_corruption() {
        let mk = mk(15);
        let mut container = crypto::encrypt_file_with_master_key(
            &mk,
            None,
            "vault.json",
            &vault_json_payload(),
            None,
            3,
        )
        .unwrap();

        if let Some(ref mut h) = container.header.original_hash {
            h[0] ^= 0xFF;
        }

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container);
        assert!(result.is_err(), "Corrupted integrity hash must be caught");
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("INTEGRITY") || msg.contains("hash") || msg.contains("corrupt"),
            "Error must describe an integrity failure, got: {msg}"
        );
    }

    /// Paranoid mode vault: the combined OsRng + user entropy seed must still
    /// decrypt cleanly, and a zero seed must not weaken the output.
    #[test]
    fn test_vault_paranoid_mode_roundtrip() {
        let mk = mk(16);
        let payload = vault_json_payload();
        let user_seed = entropy(0xCA);

        let container = crypto::encrypt_file_with_master_key(
            &mk,
            None,
            "vault.json",
            &payload,
            Some(user_seed),
            3,
        )
        .unwrap();

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container)
            .expect("Paranoid vault decryption must succeed");

        assert_eq!(result.content, payload);
    }

    /// With a zero entropy seed (worst-case mouse wiggle), the OsRng baseline
    /// must still guarantee a different ciphertext on each run.
    #[test]
    fn test_vault_paranoid_zero_seed_still_unique() {
        let mk = mk(17);
        let payload = vault_json_payload();
        let zero_seed = [0u8; 32];

        let c1 = crypto::encrypt_file_with_master_key(
            &mk,
            None,
            "vault.json",
            &payload,
            Some(zero_seed),
            3,
        )
        .unwrap();
        let c2 = crypto::encrypt_file_with_master_key(
            &mk,
            None,
            "vault.json",
            &payload,
            Some(zero_seed),
            3,
        )
        .unwrap();

        assert_ne!(
            c1.ciphertext, c2.ciphertext,
            "Even an all-zero entropy seed must not produce identical ciphertexts (OsRng must run)"
        );
    }

    /// An empty vault (no entries) must encrypt and decrypt without errors.
    #[test]
    fn test_vault_empty_entries_array() {
        let payload = serde_json::json!({ "entries": [] })
            .to_string()
            .into_bytes();
        let mk = mk(18);

        let container =
            crypto::encrypt_file_with_master_key(&mk, None, "vault.json", &payload, None, 3)
                .unwrap();

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container)
            .expect("Empty vault must decrypt cleanly");

        let parsed: serde_json::Value = serde_json::from_slice(&result.content).unwrap();
        assert_eq!(
            parsed["entries"].as_array().unwrap().len(),
            0,
            "Empty entries array must round-trip correctly"
        );
    }

    /// A large vault (500 entries) must survive without data loss or truncation.
    #[test]
    fn test_vault_large_payload_roundtrip() {
        let entries: Vec<serde_json::Value> = (0..500)
            .map(|i| {
                serde_json::json!({
                    "id": format!("entry-{:04}", i),
                    "service": format!("Service {}", i),
                    "username": format!("user{}@example.com", i),
                    "password": format!("P@ssw0rd-{}-secure!", i),
                    "url": format!("https://service{}.example.com", i),
                    "notes": format!("Auto-generated test entry #{}", i),
                    "color": "#555555",
                    "is_pinned": false,
                    "created_at": 1_700_000_000_u64 + i as u64,
                    "updated_at": 1_700_000_000_u64 + i as u64
                })
            })
            .collect();

        let payload = serde_json::json!({ "entries": entries })
            .to_string()
            .into_bytes();
        let mk = mk(19);

        let container =
            crypto::encrypt_file_with_master_key(&mk, None, "vault.json", &payload, None, 3)
                .unwrap();

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container)
            .expect("Large vault must decrypt successfully");

        let parsed: serde_json::Value = serde_json::from_slice(&result.content).unwrap();
        assert_eq!(
            parsed["entries"].as_array().unwrap().len(),
            500,
            "All 500 entries must survive the roundtrip"
        );
    }

    /// Passwords containing special characters, Unicode, and maximum-length strings
    /// must survive encryption without mangling.
    #[test]
    fn test_vault_special_characters_in_passwords() {
        let long_password = "a".repeat(512);
        let tricky_passwords: Vec<&str> = vec![
            r#"p@$$w0rd"with"quotes"#,
            "日本語パスワード",
            "пароль-на-русском",
            "emoji🔐passphrase🛡️",
            &long_password,
            "back\\slash and /forward/slash",
        ];

        for password in &tricky_passwords {
            let payload = serde_json::json!({
                "entries": [{
                    "id": "test-id",
                    "service": "Test",
                    "username": "user",
                    "password": password,
                    "url": "",
                    "notes": "",
                    "color": "#555",
                    "is_pinned": false,
                    "created_at": 0_u64,
                    "updated_at": 0_u64
                }]
            })
            .to_string()
            .into_bytes();

            let mk = mk(20);
            let container =
                crypto::encrypt_file_with_master_key(&mk, None, "vault.json", &payload, None, 3)
                    .unwrap();

            let result = crypto::decrypt_file_with_master_key(&mk, None, &container)
                .expect("Special character password vault must decrypt");

            let parsed: serde_json::Value = serde_json::from_slice(&result.content).unwrap();
            assert_eq!(
                parsed["entries"][0]["password"], *password,
                "Password must survive roundtrip unaltered"
            );
        }
    }

    // =========================================================================
    // SECTION 4 — V4 SECURITY (crypto.rs hardening)
    // =========================================================================

    /// Changing one bit of the master key must completely prevent decryption.
    #[test]
    fn test_v4_wrong_master_key_fails() {
        let correct = mk(30);
        let wrong = mk(31);

        let container =
            crypto::encrypt_file_with_master_key(&correct, None, "a.txt", b"secret data", None, 3)
                .unwrap();

        assert!(
            crypto::decrypt_file_with_master_key(&wrong, None, &container).is_err(),
            "Wrong master key must be rejected"
        );
    }

    /// Removing the keyfile from a keyfile-protected vault must fail with a clear
    /// error — not silently fall back to master-key-only decryption.
    #[test]
    fn test_v4_keyfile_required_guard() {
        let mk = mk(32);
        let kf = b"required-keyfile";

        let container = crypto::encrypt_file_with_master_key(
            &mk,
            Some(kf),
            "vault.json",
            &vault_json_payload(),
            None,
            3,
        )
        .unwrap();

        let result = crypto::decrypt_file_with_master_key(&mk, None, &container);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Keyfile") || msg.contains("keyfile"),
            "Error must mention the missing keyfile, got: {msg}"
        );
    }

    /// Encrypting the same content twice must never produce the same ciphertext.
    #[test]
    fn test_v4_nonce_uniqueness() {
        let mk = mk(33);
        let data = b"repeated vault content";

        let c1 = crypto::encrypt_file_with_master_key(&mk, None, "v.json", data, None, 3).unwrap();
        let c2 = crypto::encrypt_file_with_master_key(&mk, None, "v.json", data, None, 3).unwrap();

        assert_ne!(
            c1.ciphertext, c2.ciphertext,
            "Every encryption must use a unique nonce"
        );
    }

    /// All compression levels (store → extreme) must produce correctly decryptable output.
    #[test]
    fn test_v4_all_compression_levels() {
        let mk = mk(34);
        let data = vault_json_payload();

        for level in [0i32, 1, 3, 9, 19] {
            let container =
                crypto::encrypt_file_with_master_key(&mk, None, "vault.json", &data, None, level)
                    .unwrap_or_else(|e| panic!("Encryption at level {level} failed: {e}"));

            let result = crypto::decrypt_file_with_master_key(&mk, None, &container)
                .unwrap_or_else(|e| panic!("Decryption at level {level} failed: {e}"));

            assert_eq!(
                result.content, data,
                "Compression level {level}: content must match after roundtrip"
            );
        }
    }

    // =========================================================================
    // SECTION 5 — V5 STREAMING SECURITY (crypto_stream.rs hardening)
    // =========================================================================

    /// An attacker who truncates the last chunk of a multi-chunk encrypted file
    /// must be detected by the whole-file SHA-256 hash in the stream header.
    /// Per-chunk AES-GCM tags alone would not catch this.
    #[test]
    fn test_v5_truncation_attack_detected() {
        let dir = make_test_dir("qre_v5_truncation");
        // Input and output live in separate subdirs so dir/output/big.bin is
        // unambiguously the decryptor's file, not the original input.
        let input = write_file(&dir, "big.bin", &vec![0x42u8; 2 * 1024 * 1024]); // 2 MB
        let encrypted = dir.join("big.bin.qre").to_str().unwrap().to_owned();
        let out_dir = dir.join("output");
        fs::create_dir_all(&out_dir).unwrap();
        let out_dir_str = out_dir.to_str().unwrap().to_owned();
        let mk = mk(40);

        crypto_stream::encrypt_file_stream(
            &input,
            &encrypted,
            &mk,
            "local",
            None,
            None,
            3,
            |_, _| {},
        )
        .unwrap();

        // Remove the last 64 KB to simulate a truncation attack
        let mut bytes = fs::read(&encrypted).unwrap();
        let new_len = bytes.len().saturating_sub(64_000);
        bytes.truncate(new_len);
        fs::write(&encrypted, &bytes).unwrap();

        let result =
            crypto_stream::decrypt_file_stream(&encrypted, &out_dir_str, &mk, None, |_, _| {});

        assert!(result.is_err(), "Truncated file must be rejected");
        // Check the output subdir — the original input big.bin must not
        // cause a false positive here.
        assert!(
            !out_dir.join("big.bin").exists(),
            "Decryptor must delete the partial output file after a truncation failure"
        );

        let _ = fs::remove_dir_all(dir);
    }

    /// The AAD field binds each chunk to its exact filename and index. Flipping a
    /// byte inside any chunk must invalidate that chunk's GCM tag.
    #[test]
    fn test_v5_chunk_tampering_detected() {
        let dir = make_test_dir("qre_v5_tamper");
        let input = write_file(
            &dir,
            "data.bin",
            b"This content will be tampered with after encryption",
        );
        let encrypted = dir.join("data.bin.qre").to_str().unwrap().to_owned();
        let out_dir = dir.to_str().unwrap().to_owned();
        let mk = mk(41);

        crypto_stream::encrypt_file_stream(
            &input,
            &encrypted,
            &mk,
            "local",
            None,
            None,
            3,
            |_, _| {},
        )
        .unwrap();

        // Flip a byte in the second half of the file (inside the chunk body, past the header)
        let mut bytes = fs::read(&encrypted).unwrap();
        let pos = bytes.len() * 3 / 4;
        bytes[pos] ^= 0xFF;
        fs::write(&encrypted, &bytes).unwrap();

        let result = crypto_stream::decrypt_file_stream(&encrypted, &out_dir, &mk, None, |_, _| {});

        assert!(
            result.is_err(),
            "Tampered chunk must fail the AES-GCM authentication tag check"
        );

        let _ = fs::remove_dir_all(dir);
    }

    /// Two encryptions of the same file must produce entirely different byte streams
    /// because OsRng picks a new base_nonce each time.
    #[test]
    fn test_v5_nonce_uniqueness_across_runs() {
        let dir = make_test_dir("qre_v5_nonce");
        let content = b"identical content encrypted twice";
        let mk = mk(42);

        let input_a = write_file(&dir, "a.txt", content);
        let enc_a = dir.join("a.txt.qre").to_str().unwrap().to_owned();
        crypto_stream::encrypt_file_stream(
            &input_a,
            &enc_a,
            &mk,
            "local",
            None,
            None,
            3,
            |_, _| {},
        )
        .unwrap();

        let input_b = write_file(&dir, "b.txt", content);
        let enc_b = dir.join("b.txt.qre").to_str().unwrap().to_owned();
        crypto_stream::encrypt_file_stream(
            &input_b,
            &enc_b,
            &mk,
            "local",
            None,
            None,
            3,
            |_, _| {},
        )
        .unwrap();

        assert_ne!(
            fs::read(&enc_a).unwrap(),
            fs::read(&enc_b).unwrap(),
            "Identical content encrypted twice must produce different ciphertexts"
        );

        let _ = fs::remove_dir_all(dir);
    }

    /// The original filename is stored in the V5 header and must be restored exactly
    /// on decryption — including the extension.
    #[test]
    fn test_v5_original_filename_preserved() {
        let dir = make_test_dir("qre_v5_filename");
        // Decrypt into a separate output subdir so get_unique_path never
        // appends " (1)" due to colliding with the original input file.
        let input = write_file(&dir, "my_vault_backup.json", b"{}");
        let encrypted = dir
            .join("my_vault_backup.json.qre")
            .to_str()
            .unwrap()
            .to_owned();
        let out_dir = dir.join("output");
        fs::create_dir_all(&out_dir).unwrap();
        let out_dir_str = out_dir.to_str().unwrap().to_owned();
        let mk = mk(43);

        crypto_stream::encrypt_file_stream(
            &input,
            &encrypted,
            &mk,
            "local",
            None,
            None,
            3,
            |_, _| {},
        )
        .unwrap();

        let out_name =
            crypto_stream::decrypt_file_stream(&encrypted, &out_dir_str, &mk, None, |_, _| {})
                .unwrap();

        assert_eq!(
            out_name, "my_vault_backup.json",
            "Original filename must be recovered exactly, got: {out_name}"
        );

        let _ = fs::remove_dir_all(dir);
    }

    /// With a zero user entropy seed the OsRng baseline must still produce
    /// non-deterministic output in the V5 engine.
    #[test]
    fn test_v5_paranoid_zero_seed_nondeterministic() {
        let dir = make_test_dir("qre_v5_zero_seed");
        let content = b"paranoid zero seed content";
        let mk = mk(44);
        let zero_seed = [0u8; 32];

        let input_a = write_file(&dir, "c.txt", content);
        let enc_a = dir.join("c.txt.qre").to_str().unwrap().to_owned();
        crypto_stream::encrypt_file_stream(
            &input_a,
            &enc_a,
            &mk,
            "local",
            None,
            Some(zero_seed),
            3,
            |_, _| {},
        )
        .unwrap();

        let input_b = write_file(&dir, "d.txt", content);
        let enc_b = dir.join("d.txt.qre").to_str().unwrap().to_owned();
        crypto_stream::encrypt_file_stream(
            &input_b,
            &enc_b,
            &mk,
            "local",
            None,
            Some(zero_seed),
            3,
            |_, _| {},
        )
        .unwrap();

        assert_ne!(
            fs::read(&enc_a).unwrap(),
            fs::read(&enc_b).unwrap(),
            "OsRng must prevent identical ciphertexts even when the entropy seed is all zeros"
        );

        let _ = fs::remove_dir_all(dir);
    }

    /// V5 output must begin with the version byte 5, not 4.
    /// The unlock router in files.rs uses this byte to choose the right decryptor.
    #[test]
    fn test_v5_version_byte_is_5() {
        let dir = make_test_dir("qre_v5_version");
        let input = write_file(&dir, "v.txt", b"version test");
        let encrypted = dir.join("v.txt.qre").to_str().unwrap().to_owned();
        let mk = mk(45);

        crypto_stream::encrypt_file_stream(
            &input,
            &encrypted,
            &mk,
            "local",
            None,
            None,
            3,
            |_, _| {},
        )
        .unwrap();

        let bytes = fs::read(&encrypted).unwrap();
        assert!(bytes.len() >= 4);
        let version = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        assert_eq!(version, 5, "V5 streaming engine must write version byte 5");

        let _ = fs::remove_dir_all(dir);
    }
    // ── Path Security tests call pub(crate) helpers in commands/files.rs ────────

    use crate::commands::files::{
        is_already_compressed, is_system_critical, reject_critical_path, reject_path_traversal,
    };
    use std::path::Path;

    // ── Path Traversal ────────────────────────────────────────────────────────

    #[test]
    fn test_path_traversal_dotdot_rejected() {
        assert!(
            reject_path_traversal(Path::new("/home/user/../etc/passwd")).is_err(),
            "Single '..' must be rejected"
        );
    }

    #[test]
    fn test_path_traversal_nested_rejected() {
        assert!(
            reject_path_traversal(Path::new("docs/../../secret")).is_err(),
            "Nested '..' must be rejected"
        );
    }

    #[test]
    fn test_path_traversal_normal_path_allowed() {
        assert!(
            reject_path_traversal(Path::new("/home/alice/documents/vault.json")).is_ok(),
            "Normal absolute path must pass"
        );
    }

    #[test]
    fn test_path_traversal_relative_path_allowed() {
        assert!(
            reject_path_traversal(Path::new("exports/backup.csv")).is_ok(),
            "Relative path without '..' must pass"
        );
    }

    // ── System Critical Path Guard ────────────────────────────────────────────

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_critical_path_etc_blocked() {
        assert!(is_system_critical(Path::new("/etc/passwd")));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_critical_path_root_blocked() {
        assert!(is_system_critical(Path::new("/")));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_critical_path_usr_bin_blocked() {
        assert!(is_system_critical(Path::new("/usr/bin/sh")));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_critical_path_boot_blocked() {
        assert!(is_system_critical(Path::new("/boot/grub/grub.cfg")));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_critical_path_proc_blocked() {
        assert!(is_system_critical(Path::new("/proc/1/mem")));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_critical_path_home_allowed() {
        assert!(!is_system_critical(Path::new("/home/alice/vault.json")));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_critical_path_tmp_allowed() {
        assert!(!is_system_critical(Path::new("/tmp/export.csv")));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_critical_path_windows_system32_blocked() {
        assert!(is_system_critical(Path::new("C:\\Windows\\System32")));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_critical_path_windows_root_blocked() {
        assert!(is_system_critical(Path::new("C:\\")));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_critical_path_windows_user_allowed() {
        assert!(!is_system_critical(Path::new(
            "C:\\Users\\Alice\\Documents"
        )));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_critical_path_d_drive_allowed() {
        assert!(!is_system_critical(Path::new("D:\\Backups\\vault.qre")));
    }

    /// reject_critical_path combines traversal and system-critical checks.
    /// A traversal toward a system path must fail on the first check alone.
    #[test]
    fn test_reject_critical_path_traversal_caught_first() {
        assert!(
            reject_critical_path(Path::new("/home/user/../../etc/shadow")).is_err(),
            "Traversal toward a system path must be rejected"
        );
    }

    // ── Compression Heuristic ─────────────────────────────────────────────────

    #[test]
    fn test_compression_skipped_for_jpg() {
        assert!(is_already_compressed("photo.jpg"));
        assert!(is_already_compressed("photo.JPEG")); // Case-insensitive
    }

    #[test]
    fn test_compression_skipped_for_video() {
        assert!(is_already_compressed("clip.mp4"));
        assert!(is_already_compressed("film.MKV"));
        assert!(is_already_compressed("video.webm"));
        assert!(is_already_compressed("old.avi"));
    }

    #[test]
    fn test_compression_skipped_for_archives() {
        assert!(is_already_compressed("backup.zip"));
        assert!(is_already_compressed("data.7z"));
        assert!(is_already_compressed("src.tar.gz")); // extension resolved as "gz"
    }

    #[test]
    fn test_compression_skipped_for_audio() {
        assert!(is_already_compressed("track.mp3"));
        assert!(is_already_compressed("voice.aac"));
        assert!(is_already_compressed("lossless.flac"));
    }

    #[test]
    fn test_compression_skipped_for_pdf() {
        assert!(is_already_compressed("report.pdf"));
    }

    #[test]
    fn test_compression_applied_to_text() {
        assert!(!is_already_compressed("notes.txt"));
        assert!(!is_already_compressed("data.csv"));
        assert!(!is_already_compressed("config.json"));
        assert!(!is_already_compressed("source.rs"));
    }

    #[test]
    fn test_compression_applied_to_office_docs() {
        // .docx/.xlsx are zip-based internally, but absent from the skip list
        assert!(!is_already_compressed("report.docx"));
        assert!(!is_already_compressed("sheet.xlsx"));
    }

    #[test]
    fn test_compression_applied_to_no_extension() {
        assert!(!is_already_compressed("Makefile"));
        assert!(!is_already_compressed(""));
    }

    // ── rename_item Input Validation ──────────────────────────────────────────

    #[test]
    fn test_rename_rejects_empty_name() {
        let r = crate::commands::files::rename_item("/tmp/file.txt".into(), "".into());
        assert!(r.is_err(), "Empty rename must be rejected");
    }

    #[test]
    fn test_rename_rejects_dot() {
        let r = crate::commands::files::rename_item("/tmp/file.txt".into(), ".".into());
        assert!(r.is_err(), "'.' as new name must be rejected");
    }

    #[test]
    fn test_rename_rejects_dotdot() {
        let r = crate::commands::files::rename_item("/tmp/file.txt".into(), "..".into());
        assert!(r.is_err(), "'..' as new name must be rejected");
    }

    #[test]
    fn test_rename_rejects_slash_in_name() {
        let r = crate::commands::files::rename_item("/tmp/file.txt".into(), "sub/dir.txt".into());
        assert!(r.is_err(), "Name containing '/' must be rejected");
    }

    #[test]
    fn test_rename_rejects_backslash_in_name() {
        let r = crate::commands::files::rename_item("/tmp/file.txt".into(), "sub\\dir.txt".into());
        assert!(r.is_err(), "Name containing '\\' must be rejected");
    }

    // =========================================================================
    // SECTION 6 — VAULTS (Passwords, Notes, Bookmarks)
    // =========================================================================

    #[test]
    fn test_password_vault_validation() {
        use crate::passwords::{PasswordVault, VaultEntry};
        let mut vault = PasswordVault::new();
        assert!(vault.validate().is_ok());

        // Test Empty ID Rejection
        let mut bad_entry = VaultEntry {
            id: "".to_string(),
            service: "Test".to_string(),
            username: "user".to_string(),
            password: "pwd".to_string(),
            notes: "".to_string(),
            created_at: 0,
            updated_at: 0,
            url: "".to_string(),
            color: "".to_string(),
            is_pinned: false,
        };
        vault.entries.push(bad_entry.clone());
        assert!(vault.validate().is_err(), "Empty ID must fail");

        // Test Duplicate ID Rejection
        bad_entry.id = "duplicate-123".to_string();
        vault.entries.clear();
        vault.entries.push(bad_entry.clone());
        vault.entries.push(bad_entry);
        assert!(vault.validate().is_err(), "Duplicate IDs must fail");
    }

    #[test]
    fn test_notes_vault_validation() {
        use crate::notes::{NoteEntry, NotesVault};
        let mut vault = NotesVault::new();

        let mut note = NoteEntry {
            id: "note-1".to_string(),
            title: "T".to_string(),
            content: "C".to_string(),
            created_at: 0,
            updated_at: 0,
            is_pinned: false,
            tags: vec![],
        };

        // Exceeding 10 tags must fail
        note.tags = (0..15).map(|i| format!("tag{}", i)).collect();
        vault.entries.push(note);
        assert!(vault.validate().is_err(), "Too many tags must fail");
    }

    // =========================================================================
    // SECTION 7 — CLIPBOARD STORE (Heuristics & Redaction)
    // =========================================================================

    #[test]
    fn test_clipboard_heuristics() {
        use crate::clipboard_store::{analyze_content, create_entry};

        // Test Categorization
        assert_eq!(
            analyze_content("4111 2222 3333 4444").unwrap(),
            "Credit Card"
        );
        assert_eq!(
            analyze_content("sk-live-1234567890abcdef").unwrap(),
            "API Key"
        );
        assert_eq!(analyze_content("P@ssw0rd123!").unwrap(), "Password");
        assert_eq!(analyze_content("admin@example.com").unwrap(), "Email");

        // Test UI Redaction (Safety)
        let cc_entry = create_entry("4111 2222 3333 4444");
        assert_eq!(
            cc_entry.preview, "4111 **** **** **** 4444",
            "Credit cards must be masked"
        );

        let pwd_entry = create_entry("SuperSecretPassword1");
        assert_eq!(
            pwd_entry.preview, "SuperS...",
            "Passwords must be truncated/masked"
        );
    }

    // =========================================================================
    // SECTION 8 — HASHER & QR GENERATOR
    // =========================================================================

    #[test]
    fn test_hasher_text_vectors() {
        use crate::hasher::calculate_text_hashes;
        let result = calculate_text_hashes("hello world");
        assert_eq!(
            result.sha256,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        assert_eq!(result.md5, "5eb63bbbe01eeed093cb22bb8f5acdc3");
    }

    #[test]
    fn test_qr_generator_validation() {
        use crate::qr::validate_qr_input;

        let ok_res = validate_qr_input("https://projectqre.com");
        assert!(ok_res.valid);
        assert!(ok_res.warnings.is_empty());

        let empty_res = validate_qr_input("");
        assert!(!empty_res.valid, "Empty QR input must fail");

        let http_res = validate_qr_input("http://insecure.com");
        assert!(http_res.valid); // Valid string...
        assert!(!http_res.warnings.is_empty(), "...but must warn about HTTP"); // ...but warns
    }

    // =========================================================================
    // SECTION 9 — SYSTEM SECURITY (Cleaner & Shredder Guards)
    // =========================================================================

    #[test]
    fn test_shredder_dry_run_blocks_system_paths() {
        use crate::shredder::dry_run;

        // Test providing highly dangerous paths to the shredder
        let paths = vec!["C:\\Windows\\System32".to_string(), "/bin/sh".to_string()];

        let result = dry_run(paths).unwrap();

        // The Dry Run should place these in the 'blocked' array, refusing to touch them
        assert!(
            !result.blocked.is_empty(),
            "Shredder must block system paths"
        );
    }

    #[test]
    fn test_system_cleaner_blocks_outside_whitelist() {
        use crate::system_cleaner::dry_run;

        // Try to pass a dangerous path to the system cleaner
        let paths = vec!["C:\\Windows".to_string(), "/etc".to_string()];

        let result = dry_run(paths).unwrap();
        // Should emit a warning/error and skip them, NOT add them to file_list
        assert!(
            result.file_list.is_empty(),
            "System cleaner must ignore non-whitelisted paths"
        );
    }

    // =========================================================================
    // SECTION 10 — BREACH CHECKER
    // =========================================================================

    #[test]
    fn test_breach_api_input_validation() {
        use crate::breach::check_pwned_by_prefix;

        tauri::async_runtime::block_on(async {
            // Prefix must be exactly 5 hex characters
            let res1 = check_pwned_by_prefix("1234", "1E4C9B93F3F0682250B6CF8331B7EE68FD8").await;
            assert!(res1.is_err(), "Short prefix must fail");

            // Suffix must be exactly 35 hex characters
            let res2 = check_pwned_by_prefix("5BAA6", "SHORT").await;
            assert!(res2.is_err(), "Short suffix must fail");

            // Must contain only Hex
            let res3 = check_pwned_by_prefix("ZZZZZ", "1E4C9B93F3F0682250B6CF8331B7EE68FD8").await;
            assert!(res3.is_err(), "Non-hex characters must fail");
        });
    }
}

// =========================================================================
// SECTION 11 — SESSION STATE & MULTI-VAULT ROUTING (Phase 1)
// =========================================================================
#[test]
fn test_session_state_multi_vault() {
    use crate::keychain::MasterKey;
    use crate::state::SessionState;

    // Use SessionState::new() rather than a struct literal so adding fields
    // to SessionState (e.g. portable_mounts in Phase 3) never breaks this test.
    let state = SessionState::new();

    // 1. Simulate logging into the Local Vault
    {
        let mut guard = state.vaults.lock().unwrap();
        // Create the MasterKey directly inline
        guard.insert("local".to_string(), MasterKey([1u8; 32]));
    }

    // 2. Simulate logging into a Portable USB Vault
    let usb_path = "D:\\".to_string();
    {
        let mut guard = state.vaults.lock().unwrap();
        // Create the MasterKey directly inline
        guard.insert(usb_path.clone(), MasterKey([2u8; 32]));
    }

    // 3. Verify both exist simultaneously and are distinct
    {
        let guard = state.vaults.lock().unwrap();
        assert!(guard.contains_key("local"));
        assert!(guard.contains_key(&usb_path));

        let local_key = guard.get("local").unwrap();
        let usb_key = guard.get(&usb_path).unwrap();

        assert_ne!(local_key.0, usb_key.0, "Vaults must have distinct keys");
    }

    // 4. Simulate USB Ejection (Locking only one vault)
    {
        let mut guard = state.vaults.lock().unwrap();
        let removed = guard.remove(&usb_path);
        assert!(removed.is_some());
    }

    // Verify Local is still unlocked
    {
        let guard = state.vaults.lock().unwrap();
        assert!(guard.contains_key("local"));
        assert!(!guard.contains_key(&usb_path));
    }

    // 5. Simulate App Logout (Locks all vaults)
    {
        let mut guard = state.vaults.lock().unwrap();
        guard.clear();
    }

    // Verify everything is locked
    {
        let guard = state.vaults.lock().unwrap();
        assert!(guard.is_empty());
    }
}

// =========================================================================
// SECTION 12 — PORTABLE USB VAULT (Phase 2 Integration Tests)
//
// These tests exercise the full init → unlock → lock lifecycle directly
// through the pub(crate) inner functions (unlock_vault_from_drive,
// lock_vault_by_id) rather than the Tauri command wrappers, because
// tauri::State<T> cannot be constructed outside a live Tauri application.
//
// All tests use KdfTier::Test (8 MB / 1 iter / 1 thread) to keep the suite
// fast. The KDF parameter values themselves are verified in a dedicated test.
//
// Tests that involve the ejection watcher thread are marked with a comment
// explaining the intentional sleep — the watcher polls every 2 seconds, so
// 3 seconds is the minimum reliable observation window.
// =========================================================================

#[test]
fn test_portable_init_creates_scaffold() {
    use crate::commands::portable::{init_portable_vault, KdfTier, PortableKeychainStore};
    use std::fs;

    let drive = std::env::temp_dir().join("qre_p2_scaffold");
    let _ = fs::remove_dir_all(&drive);
    fs::create_dir_all(&drive).unwrap();

    let result = init_portable_vault(
        drive.to_str().unwrap().to_string(),
        "CorrectHorseBatteryStaple1!".to_string(),
        KdfTier::Test,
    );
    assert!(result.is_ok(), "init should succeed: {:?}", result);

    // Verify directory scaffold
    assert!(
        drive.join(".qre_portable").exists(),
        ".qre_portable directory must be created"
    );
    assert!(
        drive.join(".qre_portable").join("keychain.qre").exists(),
        "keychain.qre must be written"
    );
    assert!(
        drive.join("Secure_Locker").exists(),
        "Secure_Locker directory must be created"
    );

    // Verify keychain.qre is valid JSON with the expected structure
    let raw = fs::read_to_string(drive.join(".qre_portable").join("keychain.qre")).unwrap();
    let store: Result<PortableKeychainStore, _> = serde_json::from_str(&raw);
    assert!(
        store.is_ok(),
        "keychain.qre must deserialize as PortableKeychainStore"
    );

    let _ = fs::remove_dir_all(&drive);
}

#[test]
fn test_portable_init_recovery_code_format() {
    use crate::commands::portable::{init_portable_vault, KdfTier};
    use std::fs;

    let drive = std::env::temp_dir().join("qre_p2_recovery_fmt");
    let _ = fs::remove_dir_all(&drive);
    fs::create_dir_all(&drive).unwrap();

    let (recovery_code, _vault_id) = init_portable_vault(
        drive.to_str().unwrap().to_string(),
        "CorrectHorseBatteryStaple1!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    // Format: "QRE-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
    // "QRE-" (4) + 4 groups of 8 hex chars joined by "-" (8*4 + 3) = 4 + 35 = 39
    assert!(
        recovery_code.starts_with("QRE-"),
        "recovery code must start with QRE-"
    );
    assert_eq!(
        recovery_code.len(),
        39,
        "recovery code must be 39 chars (128-bit: 4 + 4×8 + 3 separators)"
    );

    // Verify every non-prefix character is valid uppercase hex or a hyphen
    let after_prefix = &recovery_code[4..]; // strip "QRE-"
    for (i, ch) in after_prefix.chars().enumerate() {
        // Positions 8, 17, 26 within after_prefix are the three hyphens
        if i == 8 || i == 17 || i == 26 {
            assert_eq!(ch, '-', "separator must be '-' at position {}", i);
        } else {
            assert!(
                ch.is_ascii_digit() || ('A'..='F').contains(&ch),
                "non-separator chars must be uppercase hex (0-9 or A-F), got '{}' at position {}",
                ch,
                i
            );
        }
    }

    let _ = fs::remove_dir_all(&drive);
}

#[test]
fn test_portable_init_returns_unique_vault_ids() {
    use crate::commands::portable::{init_portable_vault, KdfTier};
    use std::fs;

    let drive_a = std::env::temp_dir().join("qre_p2_uuid_a");
    let drive_b = std::env::temp_dir().join("qre_p2_uuid_b");
    for d in [&drive_a, &drive_b] {
        let _ = fs::remove_dir_all(d);
        fs::create_dir_all(d).unwrap();
    }

    let (_rc_a, vault_id_a) = init_portable_vault(
        drive_a.to_str().unwrap().to_string(),
        "Pass1234!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    let (_rc_b, vault_id_b) = init_portable_vault(
        drive_b.to_str().unwrap().to_string(),
        "Pass1234!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    assert_ne!(
        vault_id_a, vault_id_b,
        "each vault must receive a unique UUID regardless of password"
    );

    for d in [&drive_a, &drive_b] {
        let _ = fs::remove_dir_all(d);
    }
}

#[test]
fn test_portable_init_rejects_already_formatted_drive() {
    use crate::commands::portable::{init_portable_vault, KdfTier};
    use std::fs;

    let drive = std::env::temp_dir().join("qre_p2_dup_init");
    let _ = fs::remove_dir_all(&drive);
    fs::create_dir_all(&drive).unwrap();

    // First init — must succeed
    init_portable_vault(
        drive.to_str().unwrap().to_string(),
        "Pass1234!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    // Second init on the same drive — must fail
    let result = init_portable_vault(
        drive.to_str().unwrap().to_string(),
        "DifferentPass!".to_string(),
        KdfTier::Test,
    );
    assert!(result.is_err(), "second init must return an error");
    assert!(
        result.unwrap_err().contains("already formatted"),
        "error must mention 'already formatted'"
    );

    let _ = fs::remove_dir_all(&drive);
}

#[test]
fn test_portable_init_rejects_nonexistent_drive() {
    use crate::commands::portable::{init_portable_vault, KdfTier};

    let result = init_portable_vault(
        "/this/path/does/not/exist/qre_test_xyz".to_string(),
        "Pass1234!".to_string(),
        KdfTier::Test,
    );

    assert!(result.is_err(), "nonexistent path must return an error");
    assert!(
        result.unwrap_err().contains("Drive not found"),
        "error must mention 'Drive not found'"
    );
}

#[test]
fn test_portable_init_keychain_stores_correct_kdf_params() {
    use crate::commands::portable::{init_portable_vault, KdfTier, PortableKeychainStore};
    use std::fs;

    let drive = std::env::temp_dir().join("qre_p2_kdf_params");
    let _ = fs::remove_dir_all(&drive);
    fs::create_dir_all(&drive).unwrap();

    init_portable_vault(
        drive.to_str().unwrap().to_string(),
        "Pass1234!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    let raw = fs::read_to_string(drive.join(".qre_portable").join("keychain.qre")).unwrap();
    let store: PortableKeychainStore = serde_json::from_str(&raw).unwrap();

    // KdfTier::Test params are (8_192, 1, 1)
    assert_eq!(store.kdf_memory, 8_192, "kdf_memory must match Test tier");
    assert_eq!(
        store.kdf_iterations, 1,
        "kdf_iterations must match Test tier"
    );
    assert_eq!(
        store.kdf_parallelism, 1,
        "kdf_parallelism must match Test tier"
    );

    // Slots must not be empty
    assert!(
        !store.encrypted_master_key_pass.is_empty(),
        "password slot must be non-empty"
    );
    assert!(
        !store.encrypted_master_key_recovery.is_empty(),
        "recovery slot must be non-empty"
    );
    assert_eq!(
        store.password_nonce.len(),
        12,
        "password nonce must be 12 bytes (96-bit AES-GCM)"
    );
    assert_eq!(
        store.recovery_nonce.len(),
        12,
        "recovery nonce must be 12 bytes"
    );

    let _ = fs::remove_dir_all(&drive);
}

#[test]
fn test_portable_kdf_tier_production_parameters() {
    use crate::commands::portable::KdfTier;

    // Verify production tiers meet the minimums defined in the security plan.
    // Standard: ≥ 256 MB, ≥ 5 iter
    // High:     ≥ 512 MB, ≥ 8 iter
    // Paranoid: ≥ 1 GB,   ≥ 10 iter
    assert_eq!(KdfTier::Standard.get_params(), (262_144, 5, 4));
    assert_eq!(KdfTier::High.get_params(), (524_288, 8, 4));
    assert_eq!(KdfTier::Paranoid.get_params(), (1_048_576, 10, 4));

    // Standard must be strictly stronger than any desktop local vault default
    // (desktop uses 65_536 / 3 iter per keychain.rs).
    let (std_mem, std_iter, _) = KdfTier::Standard.get_params();
    assert!(
        std_mem >= 262_144,
        "Standard portable tier must be ≥ 256 MB (offline attack mitigation)"
    );
    assert!(
        std_iter >= 5,
        "Standard portable tier must be ≥ 5 iterations"
    );
}

#[test]
fn test_portable_full_init_unlock_lock_cycle() {
    use crate::commands::portable::{
        init_portable_vault, lock_vault_by_id, unlock_vault_from_drive, KdfTier,
    };
    use crate::state::VaultId;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{Arc, Mutex};

    let drive = std::env::temp_dir().join("qre_p2_full_cycle");
    let _ = fs::remove_dir_all(&drive);
    fs::create_dir_all(&drive).unwrap();

    let vaults: Arc<Mutex<HashMap<VaultId, _>>> = Arc::new(Mutex::new(HashMap::new()));
    let mounts: Arc<Mutex<HashMap<String, VaultId>>> = Arc::new(Mutex::new(HashMap::new()));

    // ── INIT ────────────────────────────────────────────────────────────────
    let (_recovery_code, vault_id) = init_portable_vault(
        drive.to_str().unwrap().to_string(),
        "PortablePass99!".to_string(),
        KdfTier::Test,
    )
    .expect("init must succeed");

    // Vault must not be in RAM yet — init does not auto-unlock.
    assert!(
        !vaults.lock().unwrap().contains_key(&vault_id),
        "vault must not be in RAM before unlock"
    );

    // ── UNLOCK ───────────────────────────────────────────────────────────────
    let returned_id = unlock_vault_from_drive(
        None,
        drive.to_str().unwrap(),
        "PortablePass99!",
        &vaults,
        &mounts,
    )
    .expect("unlock must succeed with correct password");

    assert_eq!(
        returned_id, vault_id,
        "unlock must return the same vault_id written by init"
    );
    assert!(
        vaults.lock().unwrap().contains_key(&vault_id),
        "vault must be present in RAM after unlock"
    );

    // ── LOCK ─────────────────────────────────────────────────────────────────
    lock_vault_by_id(&vault_id, &vaults, &mounts).expect("lock must succeed");

    assert!(
        !vaults.lock().unwrap().contains_key(&vault_id),
        "vault must be absent from RAM after lock"
    );

    // Local vault (or any other vault) must be unaffected by locking the portable one.
    // Insert a dummy local key and verify it survives.
    {
        use crate::keychain::MasterKey;
        let mut guard = vaults.lock().unwrap();
        guard.insert("local".to_string(), MasterKey([1u8; 32]));
    }
    lock_vault_by_id(&vault_id, &vaults, &mounts).unwrap(); // already gone — must be a no-op
    assert!(
        vaults.lock().unwrap().contains_key("local"),
        "locking portable vault must not affect local vault"
    );

    let _ = fs::remove_dir_all(&drive);
}

#[test]
fn test_portable_unlock_wrong_password_fails() {
    use crate::commands::portable::{init_portable_vault, unlock_vault_from_drive, KdfTier};
    use crate::state::VaultId;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{Arc, Mutex};

    let drive = std::env::temp_dir().join("qre_p2_wrong_pass");
    let _ = fs::remove_dir_all(&drive);
    fs::create_dir_all(&drive).unwrap();

    let vaults: Arc<Mutex<HashMap<VaultId, _>>> = Arc::new(Mutex::new(HashMap::new()));
    let mounts: Arc<Mutex<HashMap<String, VaultId>>> = Arc::new(Mutex::new(HashMap::new()));

    let (_rc, vault_id) = init_portable_vault(
        drive.to_str().unwrap().to_string(),
        "CorrectPassword99!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    let result = unlock_vault_from_drive(
        None,
        drive.to_str().unwrap(),
        "WrongPassword!!",
        &vaults,
        &mounts,
    );

    assert!(result.is_err(), "wrong password must return an error");
    assert!(
        result.unwrap_err().contains("Incorrect Password"),
        "error must say 'Incorrect Password'"
    );
    assert!(
        !vaults.lock().unwrap().contains_key(&vault_id),
        "failed unlock must not insert any key into the vault map"
    );

    let _ = fs::remove_dir_all(&drive);
}

#[test]
fn test_portable_unlock_missing_vault_fails() {
    use crate::commands::portable::unlock_vault_from_drive;
    use crate::state::VaultId;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{Arc, Mutex};

    // A real directory that exists but has no .qre_portable inside it.
    let drive = std::env::temp_dir().join("qre_p2_no_vault");
    let _ = fs::remove_dir_all(&drive);
    fs::create_dir_all(&drive).unwrap();

    let vaults: Arc<Mutex<HashMap<VaultId, _>>> = Arc::new(Mutex::new(HashMap::new()));
    let mounts: Arc<Mutex<HashMap<String, VaultId>>> = Arc::new(Mutex::new(HashMap::new()));

    let result = unlock_vault_from_drive(
        None,
        drive.to_str().unwrap(),
        "AnyPassword!",
        &vaults,
        &mounts,
    );

    assert!(result.is_err(), "unlock on unformatted drive must fail");
    assert!(
        result.unwrap_err().contains("Portable vault not found"),
        "error must say 'Portable vault not found'"
    );

    let _ = fs::remove_dir_all(&drive);
}

#[test]
fn test_portable_lock_already_locked_is_noop() {
    // Locking a vault_id that does not exist must succeed silently —
    // HashMap::remove(missing_key) returns None without panicking.
    use crate::commands::portable::lock_vault_by_id;
    use crate::state::VaultId;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    let vaults: Arc<Mutex<HashMap<VaultId, _>>> = Arc::new(Mutex::new(HashMap::<
        VaultId,
        crate::keychain::MasterKey,
    >::new()));
    let mounts: Arc<Mutex<HashMap<String, VaultId>>> = Arc::new(Mutex::new(HashMap::new()));

    let result = lock_vault_by_id("ghost-vault-id-that-never-existed", &vaults, &mounts);
    assert!(
        result.is_ok(),
        "locking a non-existent vault must be a silent no-op"
    );
}

#[test]
fn test_portable_two_vaults_coexist_and_lock_independently() {
    use crate::commands::portable::{
        init_portable_vault, lock_vault_by_id, unlock_vault_from_drive, KdfTier,
    };
    use crate::keychain::MasterKey;
    use crate::state::VaultId;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{Arc, Mutex};

    let drive_a = std::env::temp_dir().join("qre_p2_two_a");
    let drive_b = std::env::temp_dir().join("qre_p2_two_b");
    for d in [&drive_a, &drive_b] {
        let _ = fs::remove_dir_all(d);
        fs::create_dir_all(d).unwrap();
    }

    let vaults: Arc<Mutex<HashMap<VaultId, MasterKey>>> = Arc::new(Mutex::new(HashMap::new()));
    let mounts: Arc<Mutex<HashMap<String, VaultId>>> = Arc::new(Mutex::new(HashMap::new()));

    let (_rc_a, vault_id_a) = init_portable_vault(
        drive_a.to_str().unwrap().to_string(),
        "PassA_99!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    let (_rc_b, vault_id_b) = init_portable_vault(
        drive_b.to_str().unwrap().to_string(),
        "PassB_99!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    unlock_vault_from_drive(
        None,
        drive_a.to_str().unwrap(),
        "PassA_99!",
        &vaults,
        &mounts,
    )
    .unwrap();
    unlock_vault_from_drive(
        None,
        drive_b.to_str().unwrap(),
        "PassB_99!",
        &vaults,
        &mounts,
    )
    .unwrap();

    // Both must be in RAM simultaneously
    {
        let guard = vaults.lock().unwrap();
        assert!(guard.contains_key(&vault_id_a), "vault A must be unlocked");
        assert!(guard.contains_key(&vault_id_b), "vault B must be unlocked");

        // The two master keys must be distinct (different random keys)
        let key_a = &guard[&vault_id_a];
        let key_b = &guard[&vault_id_b];
        assert_ne!(
            key_a.0, key_b.0,
            "two independent vaults must have distinct master keys"
        );
    }

    // Locking vault A must not affect vault B
    lock_vault_by_id(&vault_id_a, &vaults, &mounts).unwrap();

    {
        let guard = vaults.lock().unwrap();
        assert!(!guard.contains_key(&vault_id_a), "vault A must be locked");
        assert!(
            guard.contains_key(&vault_id_b),
            "vault B must still be unlocked"
        );
    }

    for d in [&drive_a, &drive_b] {
        let _ = fs::remove_dir_all(d);
    }
}

/// Verifies the S-03 ejection watcher: removing keychain.qre simulates a
/// drive being physically pulled while unlocked. The watcher polls every 2 s,
/// so we sleep 3 s to guarantee at least one poll has fired.
///
/// This test is intentionally slow (~3 s). It is not marked `#[ignore]`
/// because it verifies a critical security property (RAM zeroization on
/// unexpected drive removal).
#[test]
fn test_portable_ejection_watcher_zeroizes_key() {
    use crate::commands::portable::{init_portable_vault, unlock_vault_from_drive, KdfTier};
    use crate::keychain::MasterKey;
    use crate::state::VaultId;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{Arc, Mutex};

    let drive = std::env::temp_dir().join("qre_p2_ejection");
    let _ = fs::remove_dir_all(&drive);
    fs::create_dir_all(&drive).unwrap();

    let vaults: Arc<Mutex<HashMap<VaultId, MasterKey>>> = Arc::new(Mutex::new(HashMap::new()));
    let mounts: Arc<Mutex<HashMap<String, VaultId>>> = Arc::new(Mutex::new(HashMap::new()));

    let (_rc, vault_id) = init_portable_vault(
        drive.to_str().unwrap().to_string(),
        "EjectionTest99!".to_string(),
        KdfTier::Test,
    )
    .unwrap();

    unlock_vault_from_drive(
        None,
        drive.to_str().unwrap(),
        "EjectionTest99!",
        &vaults,
        &mounts,
    )
    .unwrap();
    assert!(
        vaults.lock().unwrap().contains_key(&vault_id),
        "vault must be unlocked before simulating ejection"
    );

    // Simulate physical ejection: delete the file the watcher watches.
    let keychain_path = drive.join(".qre_portable").join("keychain.qre");
    fs::remove_file(&keychain_path).expect("must be able to remove keychain.qre");

    // Give the watcher thread time to wake (polls every 2 s), detect the
    // missing file, and remove the key from the map.
    std::thread::sleep(std::time::Duration::from_secs(3));

    assert!(
        !vaults.lock().unwrap().contains_key(&vault_id),
        "watcher must have zeroized the key after keychain.qre was deleted (S-03)"
    );

    let _ = fs::remove_dir_all(&drive);
}
