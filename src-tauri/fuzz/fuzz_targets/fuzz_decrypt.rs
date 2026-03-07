#![no_main]

use libfuzzer_sys::fuzz_target;
use qre_gui::crypto::{decrypt_file_with_master_key, EncryptedFileContainer};
use qre_gui::keychain::MasterKey;

fuzz_target!(|data: &[u8]| {
    // GOAL: Feed arbitrary bytes into the deserialization and decryption
    // pipeline. The function must NEVER panic — it must only return Ok or Err.
    //
    // This covers three attack surfaces in one:
    //   1. Malformed bincode — corrupted or adversarially crafted container bytes
    //   2. Invalid ciphertext — AES-GCM tag verification with random data
    //   3. Decompression bomb — oversized zstd payload that could exhaust memory

    if let Ok(container) = bincode::deserialize::<EncryptedFileContainer>(data) {
        // Use a fixed all-zero master key — we're testing robustness, not correctness.
        // A real attacker can't control the master key, but they can control the file bytes.
        let mk = MasterKey([0u8; 32]);

        // Must never panic regardless of what garbage is inside the container.
        let _ = decrypt_file_with_master_key(&mk, None, &container);
    }
});
