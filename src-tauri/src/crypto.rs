// --- START OF FILE crypto.rs ---

use crate::keychain::MasterKey;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use rand::{rngs::OsRng, RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Seek, SeekFrom};
// Zeroize is critical here for memory safety: it securely zeroes out cryptographic keys
// and plaintext payloads from RAM the moment they go out of scope.
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

// AES-GCM standard nonce size is 12 bytes (96 bits)
const AES_NONCE_LEN: usize = 12;
// A known plaintext string used to quickly verify if the provided password is correct
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

// ==========================================
// --- DATA STRUCTURES ---
// ==========================================

/// The plaintext structure that gets encrypted.
/// `ZeroizeOnDrop` ensures that once the file is decrypted and used, the plaintext
/// contents are safely wiped from system memory to prevent RAM scraping attacks.
#[derive(Serialize, Deserialize, Debug, Zeroize, ZeroizeOnDrop)]
pub struct InnerPayload {
    #[zeroize(skip)]
    // Filenames are generally not considered highly sensitive enough to require zeroization
    pub filename: String,
    pub content: Vec<u8>,
}

/// The unencrypted header containing all the cryptographic metadata needed to decrypt the file.
#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileHeader {
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>, // Encrypted VALIDATION_MAGIC
    pub key_wrapping_nonce: Vec<u8>,
    pub encrypted_file_key: Vec<u8>, // The symmetric key used for the payload, encrypted by the Master Key
    pub body_nonce: Vec<u8>,
    pub uses_keyfile: bool, // Flag indicating if the user MUST provide a keyfile
    pub original_hash: Option<Vec<u8>>, // SHA-256 hash of the original file for integrity checking
}

/// The outer shell that is actually written to the disk (`.qre` file).
#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileContainer {
    pub version: u32, // Allows for future upgrades (e.g., this handles V4)
    pub header: EncryptedFileHeader,
    pub ciphertext: Vec<u8>, // The actual AES-256-GCM encrypted payload
}

impl EncryptedFileContainer {
    /// Serializes the container and writes it to disk using fast binary encoding (bincode).
    pub fn save(&self, path: &str) -> Result<()> {
        let file = std::fs::File::create(path).context("Failed to create output file")?;
        let writer = std::io::BufWriter::new(file);
        bincode::serialize_into(writer, self).context("Failed to write encrypted file")?;
        Ok(())
    }

    /// Loads and parses the unencrypted outer container from disk.
    pub fn load(path: &str) -> Result<Self> {
        let mut file = std::fs::File::open(path).context("Failed to open encrypted file")?;

        // Read the first 4 bytes to check the magic version number
        let mut ver_buf = [0u8; 4];
        file.read_exact(&mut ver_buf)
            .context("Failed to read version")?;
        let version = u32::from_le_bytes(ver_buf);

        // Reset the file cursor to the beginning so bincode can parse the whole struct
        file.seek(SeekFrom::Start(0))?;
        let reader = std::io::BufReader::new(file);

        // This specific module handles Version 4 (Legacy In-Memory Encryption)
        if version == 4 {
            let container: Self =
                bincode::deserialize_from(reader).context("Failed to parse V4 file")?;
            Ok(container)
        } else {
            Err(anyhow!("Unsupported or legacy file version: {}.", version))
        }
    }
}

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

/// Derives the "Wrapping Key" by combining the Vault's Master Key and an optional Keyfile.
/// Returns a `Zeroizing` wrapper to ensure this ephemeral key is wiped from RAM immediately.
fn derive_wrapping_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
) -> Zeroizing<[u8; 32]> {
    let mut hasher = Sha256::new();
    hasher.update(&master_key.0); // Mix in the primary master key

    // Mix in the keyfile data if provided
    if let Some(kb) = keyfile_bytes {
        hasher.update(b"KEYFILE_MIX");
        hasher.update(kb);
    } else {
        hasher.update(b"NO_KEYFILE");
    }

    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);

    // Wrap it securely
    Zeroizing::new(key)
}

/// Compresses data using Zstd before encryption to reduce output size and increase entropy.
fn compress_data(data: &[u8], level: i32) -> Result<Vec<u8>> {
    zstd::stream::encode_all(Cursor::new(data), level)
        .map_err(|e| anyhow!("Compression failed: {}", e))
}

/// Decompresses data post-decryption.
fn decompress_data(data: &[u8]) -> Result<Vec<u8>> {
    zstd::stream::decode_all(Cursor::new(data)).map_err(|e| anyhow!("Decompression failed: {}", e))
}

/// SECURITY: Secure constant-time comparison to prevent Timing Attacks.
/// Normal `==` operators fail fast (stopping at the first mismatched byte). An attacker
/// could measure the microsecond difference in response times to guess the validation tag.
/// This XOR-based loop always takes the exact same amount of time regardless of match status.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y; // XORing identical bytes results in 0.
    }
    result == 0 // If any byte mismatched, `result` will be > 0.
}

// ==========================================
// --- ENCRYPTION LOGIC ---
// ==========================================

/// Encrypts an entire file/payload entirely in RAM.
pub fn encrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    filename: &str,
    file_bytes: &[u8],
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32,
) -> Result<EncryptedFileContainer> {
    // 1. Calculate Integrity Hash of the original plaintext
    let original_hash = Sha256::digest(file_bytes).to_vec();

    // 2. Compress Data before encrypting
    let compressed_bytes = compress_data(file_bytes, compression_level)?;
    let payload = InnerPayload {
        filename: filename.to_string(),
        content: compressed_bytes,
    };
    // Serialize the inner payload into bytes
    let plaintext_blob = bincode::serialize(&payload)?;

    // 3. Setup Random Number Generator
    // If an entropy seed is provided (usually for deterministic batch processing), use ChaCha20.
    // Otherwise, use the standard OS-level Cryptographically Secure PRNG.
    let mut rng: Box<dyn RngCore> = match entropy_seed {
        Some(seed) => Box::new(ChaCha20Rng::from_seed(seed)),
        None => Box::new(OsRng),
    };

    // 4. Generate a random "File Key" (Envelope Encryption Pattern)
    // We encrypt the file with this unique random key, NOT the master key directly.
    let mut file_key = Zeroizing::new([0u8; 32]);
    rng.fill_bytes(&mut *file_key);
    let cipher_file =
        Aes256Gcm::new_from_slice(&*file_key).map_err(|e| anyhow!("Cipher error: {}", e))?;

    // 5. Encrypt the actual payload body using the File Key
    let mut body_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut body_nonce);
    let encrypted_body = cipher_file
        .encrypt(Nonce::from_slice(&body_nonce), plaintext_blob.as_ref())
        .map_err(|_| anyhow!("Body encryption failed"))?;

    // 6. Wrap (Encrypt) the File Key using the Master Wrapping Key
    // This allows the user to change their master password later without having to decrypt
    // and re-encrypt the massive payload. We only have to re-encrypt this tiny File Key.
    let wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap =
        Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!("Cipher error: {}", e))?;

    let mut key_wrapping_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut key_wrapping_nonce);
    let encrypted_file_key = cipher_wrap
        .encrypt(Nonce::from_slice(&key_wrapping_nonce), file_key.as_ref())
        .map_err(|_| anyhow!("Failed to encrypt file key"))?;

    // 7. Create the Validation Tag
    // Encrypt the known string "QRE_VALID" with the Wrapping Key.
    let mut validation_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut validation_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&validation_nonce), VALIDATION_MAGIC)
        .map_err(|_| anyhow!("Validation creation failed"))?;

    // NOTE: No need to manually zeroize `file_key` or `wrapping_key` here!
    // They drop out of scope automatically and zero themselves out safely.

    Ok(EncryptedFileContainer {
        version: 4, // Tag as a legacy/small-vault V4 file
        header: EncryptedFileHeader {
            validation_nonce: validation_nonce.to_vec(),
            encrypted_validation_tag: encrypted_validation,
            key_wrapping_nonce: key_wrapping_nonce.to_vec(),
            encrypted_file_key,
            body_nonce: body_nonce.to_vec(),
            uses_keyfile: keyfile_bytes.is_some(),
            original_hash: Some(original_hash),
        },
        ciphertext: encrypted_body,
    })
}

// ==========================================
// --- DECRYPTION LOGIC ---
// ==========================================

/// Decrypts a V4 EncryptedFileContainer in RAM.
pub fn decrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    container: &EncryptedFileContainer,
) -> Result<InnerPayload> {
    let h = &container.header;

    // 1. Prevent decrypting without a keyfile if one was originally used
    if h.uses_keyfile && keyfile_bytes.is_none() {
        return Err(anyhow!("This file requires a Keyfile. Please select it."));
    }

    // 2. Re-derive the wrapping key
    let wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap =
        Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!("Cipher error: {}", e))?;

    // 3. Early Failure Verification (Validation Tag)
    // We decrypt the validation tag first. If it doesn't match "QRE_VALID", the user
    // provided the wrong password/keyfile. We abort immediately before trying to decrypt
    // the heavy payload or risking memory corruption.
    let val_nonce = Nonce::from_slice(&h.validation_nonce);
    match cipher_wrap.decrypt(val_nonce, h.encrypted_validation_tag.as_ref()) {
        Ok(bytes) => {
            // Use constant-time comparison to prevent timing side-channel attacks
            if !constant_time_eq(&bytes, VALIDATION_MAGIC) {
                return Err(anyhow!("Validation tag mismatch."));
            }
        }
        Err(_) => {
            return Err(anyhow!(
                "Decryption Denied. Password or Keyfile is incorrect."
            ));
        }
    }

    // 4. Unwrap the File Key
    let file_key_vec = cipher_wrap
        .decrypt(
            Nonce::from_slice(&h.key_wrapping_nonce),
            h.encrypted_file_key.as_ref(),
        )
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;

    // Wrap the newly exposed file key in a Zeroizing struct immediately for safety
    let file_key = Zeroizing::new(file_key_vec);

    // 5. Decrypt the main payload
    let cipher_file =
        Aes256Gcm::new_from_slice(&*file_key).map_err(|_| anyhow!("Invalid file key length"))?;
    let decrypted_blob = cipher_file
        .decrypt(
            Nonce::from_slice(&h.body_nonce),
            container.ciphertext.as_ref(),
        )
        .map_err(|_| anyhow!("Body decryption failed."))?;

    // 6. Deserialize and Decompress
    let mut payload: InnerPayload = bincode::deserialize(&decrypted_blob)?;
    payload.content = decompress_data(&payload.content)?;

    // 7. Verify Integrity
    // Check the final decompressed output against the original pre-encryption SHA-256 hash.
    // If they don't match, the file was corrupted on disk.
    if let Some(expected_hash) = &h.original_hash {
        let actual_hash = Sha256::digest(&payload.content).to_vec();
        if &actual_hash != expected_hash {
            return Err(anyhow!(
                "INTEGRITY ERROR: Hash mismatch. File is corrupted."
            ));
        }
    }

    Ok(payload)
}

// --- END OF FILE crypto.rs ---
