#[cfg(test)]
mod tests {
    use crate::crypto;
    use crate::crypto_stream;
    use crate::keychain::MasterKey;
    use std::fs;
    use std::io::Write;

    // =====================================================================
    // V5 STREAMING ENGINE TESTS (Large Files)
    // =====================================================================

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

        let mk = MasterKey([42u8; 32]); // Mock Master Key
        let progress_cb = |_, _| {};

        // Encrypt
        crypto_stream::encrypt_file_stream(
            input_path.to_str().unwrap(),
            encrypted_path.to_str().unwrap(),
            &mk,
            None, // No keyfile
            None, // No extra entropy
            1,    // Fast compression
            progress_cb,
        )
        .expect("V5 Encryption failed");

        // Decrypt
        let result_filename = crypto_stream::decrypt_file_stream(
            encrypted_path.to_str().unwrap(),
            output_dir.to_str().unwrap(),
            &mk,
            None,
            progress_cb,
        )
        .expect("V5 Decryption failed");

        // Verify
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
        let entropy_seed = [99u8; 32]; // Mock mouse wiggle entropy
        let progress_cb = |_, _| {};

        // Encrypt with ALL advanced features active
        crypto_stream::encrypt_file_stream(
            input_path.to_str().unwrap(),
            encrypted_path.to_str().unwrap(),
            &mk,
            Some(keyfile_data),
            Some(entropy_seed),
            3,
            progress_cb,
        )
        .expect("V5 Paranoid Encryption failed");

        // Decrypt
        let result_filename = crypto_stream::decrypt_file_stream(
            encrypted_path.to_str().unwrap(),
            output_dir.to_str().unwrap(),
            &mk,
            Some(keyfile_data), // MUST provide exact same keyfile
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

        // Encrypt with Correct Key
        crypto_stream::encrypt_file_stream(
            input_path.to_str().unwrap(),
            encrypted_path.to_str().unwrap(),
            &correct_mk,
            None,
            None,
            1,
            |_, _| {},
        )
        .unwrap();

        // Attempt Decrypt with Wrong Key
        let result = crypto_stream::decrypt_file_stream(
            encrypted_path.to_str().unwrap(),
            output_dir.to_str().unwrap(),
            &wrong_mk, // <--- WRONG KEY
            None,
            |_, _| {},
        );

        // MUST return an error
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

    // =====================================================================
    // V4 IN-MEMORY ENGINE TESTS (Vaults, Notes, Bookmarks)
    // =====================================================================

    #[test]
    fn test_v4_memory_roundtrip() {
        let original_data = b"This is a JSON payload for the Password Vault.";
        let filename = "passwords.json";
        let mk = MasterKey([123u8; 32]);

        // Encrypt (In RAM)
        let container = crypto::encrypt_file_with_master_key(
            &mk,
            None, // No keyfile
            filename,
            original_data,
            None, // No paranoid entropy
            3,    // Standard compression
        )
        .expect("V4 Encryption failed");

        // Verify container structure
        assert_eq!(container.version, 4);
        assert!(!container.ciphertext.is_empty());

        // Decrypt (In RAM)
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

        // Encrypt with keyfile
        let container = crypto::encrypt_file_with_master_key(
            &mk,
            Some(correct_keyfile),
            "test.json",
            original_data,
            None,
            3,
        )
        .unwrap();

        // Attempt Decrypt with wrong keyfile
        let result = crypto::decrypt_file_with_master_key(
            &mk,
            Some(wrong_keyfile), // <--- WRONG KEYFILE
            &container,
        );

        assert!(
            result.is_err(),
            "V4 Decryption should fail with wrong keyfile"
        );
    }
}
