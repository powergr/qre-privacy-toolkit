// --- START OF FILE crypto_stream.rs ---

use crate::keychain::MasterKey;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use rand::{rngs::OsRng, RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use zeroize::{Zeroize, Zeroizing};

// ==========================================
// --- CONSTANTS ---
// ==========================================

// Process large files in 1 Megabyte chunks. This ensures the app uses < 50MB of RAM
// even when encrypting a 10GB video file.
const CHUNK_SIZE: usize = 1024 * 1024;
const AES_NONCE_LEN: usize = 12; // 96-bit nonce standard for GCM
const FILE_KEY_LEN: usize = 32; // 256-bit AES key
const CURRENT_VERSION: u32 = 5; // Marks files encrypted using the chunked streaming engine
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID"; // Quick password verification string

// ==========================================
// --- HEADER STRUCTURE ---
// ==========================================

/// The unencrypted V5 file header. This sits at the very beginning of the `.qre` file.
#[derive(Serialize, Deserialize, Debug)]
pub struct StreamHeader {
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>, // Encrypted version of VALIDATION_MAGIC
    pub key_wrapping_nonce: Vec<u8>,
    pub encrypted_file_key: Vec<u8>, // The chunk encryption key, encrypted by the Master Key
    pub base_nonce: Vec<u8>,         // The starting nonce that gets incremented for every chunk
    pub original_filename: String,   // The original name (e.g., "video.mp4")
    pub original_hash: Option<Vec<u8>>, // Full file SHA-256 hash to detect malicious truncation
}

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

/// Derives the "Wrapping Key" (KEK - Key Encrypting Key) from the Vault's Master Key and Keyfile.
/// Returns a `Zeroizing` wrapper to ensure this key is wiped from RAM automatically when dropped.
fn derive_wrapping_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
) -> Zeroizing<[u8; 32]> {
    let mut hasher = Sha256::new();
    hasher.update(master_key.0);

    if let Some(kb) = keyfile_bytes {
        hasher.update(b"KEYFILE_MIX");
        hasher.update(kb);
    } else {
        hasher.update(b"NO_KEYFILE");
    }

    let res = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&res);
    Zeroizing::new(key)
}

/// Compresses a 1MB chunk of data before encrypting it.
fn compress_chunk(data: &[u8], level: i32) -> Result<Vec<u8>> {
    let mut encoder = zstd::Encoder::new(Vec::new(), level)?;
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
}

/// Decompresses a decrypted chunk back into its original plaintext.
fn decompress_chunk(data: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = zstd::Decoder::new(std::io::Cursor::new(data))?;
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)?;
    Ok(out)
}

/// SECURITY: Secure constant-time comparison to prevent Timing Attacks.
/// Used for verifying the Validation Tag and the final SHA-256 integrity hash.
/// Prevents attackers from guessing MACs by measuring CPU response times.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}

// ==========================================
// --- STREAM ENCRYPTOR ---
// ==========================================

/// Encrypts a file of any size by streaming it in 1MB chunks.
pub fn encrypt_file_stream(
    input_path: &str,
    output_path: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32,
    callback: impl Fn(u64, u64), // Progress callback for the UI
) -> Result<()> {
    let total_size = std::fs::metadata(input_path)?.len();
    let original_filename = std::path::Path::new(input_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // SECURITY FIX: Truncation Attack Defense
    // When encrypting in chunks, AES-GCM guarantees the integrity of *each chunk individually*.
    // However, an attacker could simply delete the last 5 chunks of the file. The decryptor would
    // process the remaining chunks perfectly, completely unaware the file was truncated.
    // By pre-computing a SHA-256 hash of the *entire* plaintext file and storing it in the header,
    // we can verify the total file integrity after reassembly.
    let original_hash = {
        let mut pre_reader = BufReader::new(
            File::open(input_path).context("Failed to open input file for pre-hash")?,
        );
        let mut hasher = Sha256::new();
        let mut hash_buf = vec![0u8; CHUNK_SIZE];
        loop {
            let n = pre_reader.read(&mut hash_buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&hash_buf[..n]);
        }
        hasher.finalize().to_vec()
    };

    // Open read/write streams
    let mut input_file = BufReader::new(File::open(input_path)?);
    let mut output_file = BufWriter::new(File::create(output_path)?);

    // 1. Write the magic version number (4 bytes)
    output_file.write_all(&CURRENT_VERSION.to_le_bytes())?;

    // ---------------------------------------------------------
    // 2. SECURITY UPGRADE: Entropy Mixing (Paranoid Mode Fix)
    // ---------------------------------------------------------
    // Previously, if `entropy_seed` (mouse wiggle data) was provided, we completely ignored
    // the OS random generator (`OsRng`). If the user wiggled the mouse poorly, the key was weak.
    // Now, we *always* pull 32 bytes of high-entropy cryptographic randomness from the OS.
    // If Paranoid Mode is ON, we XOR (mix) the user's mouse data into the OS data.
    // This guarantees maximum security: Immune to bad mouse wiggles, AND immune to OS backdoors.

    let mut combined_seed = [0u8; 32];
    OsRng.fill_bytes(&mut combined_seed); // Always start with OS-level Cryptographic RNG

    if let Some(user_seed) = entropy_seed {
        // Mix the user's entropy into the OS entropy using XOR.
        for i in 0..32 {
            combined_seed[i] ^= user_seed[i];
        }
    }

    // Initialize our stream cipher RNG with the perfectly mixed seed
    let mut rng = ChaCha20Rng::from_seed(combined_seed);
    // ---------------------------------------------------------

    // 3. Generate the File Encryption Key (FEK) - Zeroized on drop
    let mut file_key = Zeroizing::new([0u8; FILE_KEY_LEN]);
    rng.fill_bytes(&mut *file_key);
    let cipher_file = Aes256Gcm::new_from_slice(&*file_key).map_err(|e| anyhow!(e))?;

    // 4. Derive Wrapping Key (KEK) - Zeroized on drop
    let wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    // 5. Build and Encrypt the Header metadata

    // A. Validation Tag
    let mut val_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut val_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&val_nonce), VALIDATION_MAGIC)
        .map_err(|e| anyhow!("Validation encrypt failed: {}", e))?;

    // B. Encrypt File Key (Envelope Encryption)
    let mut key_wrap_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut key_wrap_nonce);
    let encrypted_file_key = cipher_wrap
        .encrypt(Nonce::from_slice(&key_wrap_nonce), file_key.as_ref())
        .map_err(|e| anyhow!("File key wrap failed: {}", e))?;

    // C. Base Nonce for chunking
    let mut base_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut base_nonce);

    let header = StreamHeader {
        validation_nonce: val_nonce.to_vec(),
        encrypted_validation_tag: encrypted_validation,
        key_wrapping_nonce: key_wrap_nonce.to_vec(),
        encrypted_file_key,
        base_nonce: base_nonce.to_vec(),
        original_filename: original_filename.clone(),
        original_hash: Some(original_hash),
    };

    // Serialize and write the header struct
    bincode::serialize_into(&mut output_file, &header)?;

    // 6. Streaming Loop (The heavy lifting)
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut chunk_index: u64 = 0;
    let mut processed_bytes: u64 = 0;

    loop {
        // Read up to 1MB
        let bytes_read = input_file.read(&mut buffer)?;
        if bytes_read == 0 {
            break; // EOF
        }

        let chunk_data = &buffer[..bytes_read];

        // Compress the chunk
        let compressed = compress_chunk(chunk_data, compression_level)?;

        // SECURITY FIX: Calculate Rolling Nonce
        // In AES-GCM, reusing a nonce with the same key destroys the security of the encryption.
        // We take the random `base_nonce` and XOR the current `chunk_index` into its last 8 bytes.
        // This guarantees a perfectly unique nonce for every single chunk in the file.
        let mut chunk_nonce = base_nonce;
        let index_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce[4 + i] ^= index_bytes[i];
        }

        // SECURITY FIX: Block Reordering Defense (AAD)
        // If an attacker swaps chunk #2 and chunk #5 using a hex editor, AES-GCM won't notice
        // because both chunks are valid ciphertexts.
        // By adding Associated Data (AAD) containing the exact filename and chunk index
        // ("video.mp4:2"), we cryptographically bind the ciphertext to its exact position.
        // If the chunk is moved, the index in the AAD changes, the GCM auth tag fails, and decryption stops.
        let aad_tag = format!("{}:{}", original_filename, chunk_index);
        let payload = Payload {
            msg: &compressed,
            aad: aad_tag.as_bytes(),
        };

        // Encrypt the chunk
        let ciphertext = cipher_file
            .encrypt(Nonce::from_slice(&chunk_nonce), payload)
            .map_err(|_| anyhow!("Chunk encryption failed"))?;

        // Write to disk: [Size of ciphertext (4 bytes)] + [Ciphertext payload]
        let size = (ciphertext.len() as u32).to_le_bytes();
        output_file.write_all(&size)?;
        output_file.write_all(&ciphertext)?;

        // Update progress UI
        processed_bytes += bytes_read as u64;
        chunk_index += 1;
        callback(processed_bytes, total_size);
    }

    output_file.flush()?;

    // Ensure memory is wiped (Zeroizing wrapper handles it, but explicit drop clears combined_seed)
    combined_seed.zeroize();

    Ok(())
}

// ==========================================
// --- STREAM DECRYPTOR ---
// ==========================================

/// Decrypts a V5 streamed `.qre` file back to disk.
pub fn decrypt_file_stream(
    input_path: &str,
    output_dir: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    callback: impl Fn(u64, u64),
) -> Result<String> {
    let mut input_file = BufReader::new(File::open(input_path)?);
    let file_size = std::fs::metadata(input_path)?.len();

    // 1. Read and skip the Version marker (already checked in the router)
    let mut ver_buf = [0u8; 4];
    input_file.read_exact(&mut ver_buf)?;

    // 2. Read the V5 Header metadata
    let header: StreamHeader =
        bincode::deserialize_from(&mut input_file).context("Failed to read header")?;

    // 3. Unwrap Keys
    let wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    // Verify Password/Keyfile via Validation Tag
    let val_nonce = Nonce::from_slice(&header.validation_nonce);
    match cipher_wrap.decrypt(val_nonce, header.encrypted_validation_tag.as_ref()) {
        Ok(bytes) => {
            // Constant-time check prevents timing attacks during password guessing
            if !constant_time_eq(&bytes, VALIDATION_MAGIC) {
                return Err(anyhow!(
                    "Decryption Denied. Password or Keyfile is incorrect."
                ));
            }
        }
        Err(_) => {
            return Err(anyhow!(
                "Decryption Denied. Password or Keyfile is incorrect."
            ))
        }
    }

    // Unwrap File Encryption Key
    let file_key_vec = cipher_wrap
        .decrypt(
            Nonce::from_slice(&header.key_wrapping_nonce),
            header.encrypted_file_key.as_ref(),
        )
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;

    // Wrap the File Key in Zeroizing immediately
    let file_key = Zeroizing::new(file_key_vec);
    let cipher_file =
        Aes256Gcm::new_from_slice(&file_key).map_err(|_| anyhow!("Invalid file key length"))?;

    // 4. Prepare Output File
    let output_filename = header.original_filename.clone();
    let raw_output_path = std::path::Path::new(output_dir).join(&output_filename);

    // Ensure we don't accidentally overwrite an existing file with the same name
    let final_output_path = crate::utils::get_unique_path(&raw_output_path);
    let final_filename = final_output_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut output_file = BufWriter::new(File::create(&final_output_path)?);

    // Setup running SHA-256 hasher to accumulate plaintext output for the truncation check
    let mut output_hasher = Sha256::new();

    // 5. Decrypt Loop
    let mut chunk_index: u64 = 0;
    let mut size_buf = [0u8; 4];
    let mut processed = 0;

    loop {
        // Read the 4-byte size header for the next chunk
        match input_file.read_exact(&mut size_buf) {
            Ok(_) => {}
            Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break, // Reached end of file normally
            Err(e) => return Err(anyhow!("Read error: {}", e)),
        };

        let chunk_len = u32::from_le_bytes(size_buf) as usize;

        // Sanity check: Ensure a corrupted size marker doesn't cause us to try allocating 4GB of RAM
        if chunk_len > CHUNK_SIZE + 4096 {
            return Err(anyhow!("Chunk size anomaly"));
        }

        // Read the exact ciphertext chunk
        let mut ciphertext = vec![0u8; chunk_len];
        input_file.read_exact(&mut ciphertext)?;

        // Reconstruct the exact nonce used for this specific chunk
        let mut chunk_nonce = [0u8; AES_NONCE_LEN];
        chunk_nonce.copy_from_slice(&header.base_nonce);
        let index_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce[4 + i] ^= index_bytes[i];
        }

        // Reconstruct the AAD string ("filename:index")
        let aad_tag = format!("{}:{}", header.original_filename, chunk_index);
        let payload = Payload {
            msg: &ciphertext,
            aad: aad_tag.as_bytes(),
        };

        // Decrypt the chunk.
        // This will FAIL immediately if the chunk was modified, moved (bad AAD index),
        // or swapped from another file (bad AAD filename).
        let compressed = cipher_file
            .decrypt(Nonce::from_slice(&chunk_nonce), payload)
            .map_err(|_| anyhow!("Chunk {} integrity check failed", chunk_index))?;

        let plaintext = decompress_chunk(&compressed)?;

        // Accumulate running hash
        output_hasher.update(&plaintext);

        // Write recovered plaintext to disk
        output_file.write_all(&plaintext)?;

        // Update progress UI ( throttled to every 5 chunks for performance )
        processed += chunk_len as u64;
        chunk_index += 1;
        if chunk_index.is_multiple_of(5) {
            callback(processed, file_size);
        }
    }

    output_file.flush()?;

    // 6. Verify Whole-File Hash
    // If an attacker truncated the file (deleted the last few chunks), the AES-GCM tags
    // for the remaining chunks will pass perfectly. But the accumulated plaintext hash
    // will NOT match the original hash stored in the header.
    if let Some(expected_hash) = &header.original_hash {
        let actual_hash = output_hasher.finalize().to_vec();

        if !constant_time_eq(&actual_hash, expected_hash) {
            // Delete the partially recovered file to prevent the user from opening corrupt data.
            let _ = fs::remove_file(&final_output_path);
            return Err(anyhow!(
                "INTEGRITY ERROR: File hash mismatch. The output has been removed. \
                 The encrypted file may be truncated or corrupt."
            ));
        }
    }

    Ok(final_filename)
}

// --- END OF FILE crypto_stream.rs ---