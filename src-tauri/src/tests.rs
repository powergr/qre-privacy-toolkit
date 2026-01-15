#[cfg(test)]
mod tests {
    use crate::crypto;
    use crate::keychain;
    use crate::utils;
    use std::fs;

    // 1. Test Encryption/Decryption Roundtrip
    #[test]
    fn test_crypto_roundtrip() {
        // Setup dummy data
        let original_data = b"Quantum-Resistant Encryption Test Data 123!";
        let filename = "secret_plans.txt";

        // Create a Mock Master Key (32 bytes of zeros)
        let mk = keychain::MasterKey([0u8; 32]);

        // Encrypt (Compression Level 1 for speed)
        let container = crypto::encrypt_file_with_master_key(
            &mk,
            None, // No keyfile
            filename,
            original_data,
            None, // No entropy
            1,
        )
        .expect("Encryption failed");

        // Decrypt
        let result =
            crypto::decrypt_file_with_master_key(&mk, None, &container).expect("Decryption failed");

        // Validate
        assert_eq!(result.filename, filename);
        assert_eq!(result.content, original_data);
    }

    // 2. Test Unique Naming (collision avoidance)
    #[test]
    fn test_unique_naming() {
        // Setup temp directory
        let temp_dir = std::env::temp_dir().join("qre_test_collision");
        let _ = fs::remove_dir_all(&temp_dir); // Cleanup previous runs
        fs::create_dir_all(&temp_dir).unwrap();

        // Create "file.txt"
        let file1 = temp_dir.join("file.txt");
        fs::write(&file1, "content").unwrap();

        // Ask for unique path for "file.txt" -> Should be "file.txt" (if we passed the target, but get_unique checks existence)
        // Actually, get_unique_path checks if the *result* exists.

        // Case A: Path doesn't exist yet
        let target_a = temp_dir.join("new.txt");
        let unique_a = utils::get_unique_path(&target_a);
        assert_eq!(unique_a, target_a); // Should return same path

        // Case B: Path exists
        let unique_b = utils::get_unique_path(&file1);
        let expected_b = temp_dir.join("file (1).txt");
        assert_eq!(unique_b, expected_b);

        // Case C: Path and (1) exist
        fs::write(&expected_b, "content").unwrap(); // Create file (1).txt
        let unique_c = utils::get_unique_path(&file1);
        let expected_c = temp_dir.join("file (2).txt");
        assert_eq!(unique_c, expected_c);

        // Cleanup
        let _ = fs::remove_dir_all(temp_dir);
    }
}
