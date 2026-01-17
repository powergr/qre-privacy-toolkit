#[cfg(test)]
mod tests {
    use crate::crypto_stream;
    use crate::keychain;
    use std::fs;
    use std::io::Write;
    
    #[test]
    fn test_streaming_roundtrip() {
        // 1. Setup Temporary Paths
        let test_dir = std::env::temp_dir().join("qre_tests");
        // Ensure clean state
        let _ = fs::remove_dir_all(&test_dir);
        fs::create_dir_all(&test_dir).unwrap();
        
        let input_path = test_dir.join("secret.txt");
        let encrypted_path = test_dir.join("secret.txt.qre");
        let output_dir = test_dir.join("output");
        fs::create_dir_all(&output_dir).unwrap();

        // 2. Create Dummy Data
        let original_data = b"Streaming Encryption Test Data 123! This is a test.";
        {
            let mut f = fs::File::create(&input_path).unwrap();
            f.write_all(original_data).unwrap();
        }

        // 3. Mock Master Key
        let mk = keychain::MasterKey([42u8; 32]); // Arbitrary key

        // 4. Encrypt (V5 Stream)
        let progress_cb = |_, _| {}; // Ignore progress for test
        
        crypto_stream::encrypt_file_stream(
            input_path.to_str().unwrap(),
            encrypted_path.to_str().unwrap(),
            &mk,
            None, // No keyfile
            None, // No extra entropy
            1,    // <--- ADDED: Compression Level (1 = Fast)
            progress_cb
        ).expect("Encryption failed");

        // 5. Decrypt (V5 Stream)
        let result_filename = crypto_stream::decrypt_file_stream(
            encrypted_path.to_str().unwrap(),
            output_dir.to_str().unwrap(),
            &mk,
            None, // No keyfile
            progress_cb
        ).expect("Decryption failed");

        // 6. Verify Content
        let final_path = output_dir.join(result_filename);
        let decrypted_data = fs::read(&final_path).expect("Failed to read decrypted file");
        
        assert_eq!(decrypted_data, original_data, "Decrypted data does not match original");

        // 7. Cleanup
        let _ = fs::remove_dir_all(test_dir);
    }
}