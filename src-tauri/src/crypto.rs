use crate::keychain::MasterKey;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Seek, SeekFrom};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// A magic string encrypted inside the header.
/// If we can successfully decrypt this string, we know the user's password is correct.
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

// --- Data Structures ---

/// Represents the decrypted content of a file inside the application memory.
///
/// **Security Note:** This struct derives `Zeroize` and `ZeroizeOnDrop`.
/// This means that as soon as this variable goes out of scope (is no longer needed),
/// the memory containing the file data is physically overwritten with zeros.
/// This protects against RAM scraping or Cold Boot attacks.
#[derive(Serialize, Deserialize, Debug, Zeroize, ZeroizeOnDrop)]
pub struct InnerPayload {
    #[zeroize(skip)]
    pub filename: String, // The original filename (e.g., "photo.jpg")
    pub content: Vec<u8>, // The decrypted file bytes
}

/// The V4 Header structure.
/// This format was used in QRE Locker v2.3 and below.
/// It creates a "Wrapped Key" architecture where the File Key is encrypted by the Master Key.
#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileHeader {
    // Random nonce used to encrypt the Validation Tag
    pub validation_nonce: Vec<u8>,
    // Encrypted version of "QRE_VALID". Used to check password correctness quickly.
    pub encrypted_validation_tag: Vec<u8>,

    // Random nonce used to encrypt the File Key
    pub key_wrapping_nonce: Vec<u8>,
    // The actual AES-256 key used to encrypt the body, itself encrypted by the Master Key.
    pub encrypted_file_key: Vec<u8>,

    // Nonce used for the main file body
    pub body_nonce: Vec<u8>,

    // Metadata
    pub uses_keyfile: bool,
    // SHA-256 hash of the original plaintext. Verified after decryption to detect tampering.
    pub original_hash: Option<Vec<u8>>,
}

/// The container format stored on disk for V4 files.
/// It contains the version number, the header (metadata), and the encrypted body.
#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileContainer {
    pub version: u32,
    pub header: EncryptedFileHeader,
    pub ciphertext: Vec<u8>,
}

impl EncryptedFileContainer {
    /// Loads a `.qre` file from disk into memory and parses the header.
    ///
    /// **Compatibility Note:** This function specifically checks for Version 4.
    /// V5 files (Streaming) are handled by `crypto_stream.rs`.
    pub fn load(path: &str) -> Result<Self> {
        let mut file = std::fs::File::open(path).context("Failed to open encrypted file")?;

        // Read the first 4 bytes to check the file version
        let mut ver_buf = [0u8; 4];
        file.read_exact(&mut ver_buf).context("Failed to read version")?;
        let version = u32::from_le_bytes(ver_buf);

        // Rewind to the start so the deserializer can read the whole structure
        file.seek(SeekFrom::Start(0))?;
        let reader = std::io::BufReader::new(file);

        if version == 4 {
            let container: Self = bincode::deserialize_from(reader).context("Failed to parse V4 file")?;
            Ok(container)
        } else {
            Err(anyhow!("Unsupported or legacy file version: {}.", version))
        }
    }
}

// --- Helper Functions ---

/// Derives the "Wrapping Key" (Key Encryption Key).
///
/// It combines the **Master Key** (derived from the password) and the **Keyfile** (if used).
/// This key is used *only* to unlock the File Key stored in the header.
fn derive_wrapping_key(master_key: &MasterKey, keyfile_bytes: Option<&[u8]>) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(&master_key.0);

    if let Some(kb) = keyfile_bytes {
        hasher.update(b"KEYFILE_MIX");
        hasher.update(kb);
    } else {
        hasher.update(b"NO_KEYFILE");
    }

    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

/// Decompresses the decrypted data using the Zstd algorithm.
fn decompress_data(data: &[u8]) -> Result<Vec<u8>> {
    zstd::stream::decode_all(Cursor::new(data)).map_err(|e| anyhow!("Decompression failed: {}", e))
}

// --- DECRYPTION ONLY (V4 Support) ---

/// Decrypts a file using the Legacy V4 (Memory-Bound) Engine.
///
/// This workflow works as follows:
/// 1.  **Validate:** Checks if the password/keyfile can decrypt the validation tag.
/// 2.  **Unwrap:** Decrypts the specific File Key using the User's Master Key.
/// 3.  **Decrypt:** Uses the File Key to decrypt the actual file content.
/// 4.  **Integrity:** Hashes the result and compares it to the original hash to ensure no corruption.
pub fn decrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    container: &EncryptedFileContainer,
) -> Result<InnerPayload> {
    let h = &container.header;

    // Security Check: If the file was locked with a Keyfile, ensure one is provided.
    if h.uses_keyfile && keyfile_bytes.is_none() {
        return Err(anyhow!("This file requires a Keyfile. Please select it."));
    }

    // 1. Derive Wrapping Key
    let mut wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();

    // 2. Validate Password
    // Attempts to decrypt the "Validation Tag". If this fails, the password is wrong.
    let val_nonce = Nonce::from_slice(&h.validation_nonce);
    match cipher_wrap.decrypt(val_nonce, h.encrypted_validation_tag.as_ref()) {
        Ok(bytes) => {
            if bytes != VALIDATION_MAGIC {
                wrapping_key.zeroize();
                return Err(anyhow!("Validation tag mismatch."));
            }
        }
        Err(_) => {
            wrapping_key.zeroize();
            return Err(anyhow!("Decryption Denied. Password or Keyfile is incorrect."));
        }
    }

    // 3. Decrypt the File Key
    // This key is unique to the file.
    let file_key_vec = cipher_wrap
        .decrypt(Nonce::from_slice(&h.key_wrapping_nonce), h.encrypted_file_key.as_ref())
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;
    
    // Wipe the wrapping key from memory now that we have the file key.
    wrapping_key.zeroize();

    // 4. Decrypt the Body
    let cipher_file = Aes256Gcm::new_from_slice(&file_key_vec).map_err(|_| anyhow!("Invalid file key length"))?;
    let decrypted_blob = cipher_file
        .decrypt(Nonce::from_slice(&h.body_nonce), container.ciphertext.as_ref())
        .map_err(|_| anyhow!("Body decryption failed."))?;

    // 5. Decode & Decompress
    let mut payload: InnerPayload = bincode::deserialize(&decrypted_blob)?;
    payload.content = decompress_data(&payload.content)?;

    // 6. Integrity Check
    // Calculates the hash of the decrypted data and compares it to the hash stored in the header.
    // This detects bit-rot, corruption, or malicious tampering.
    if let Some(expected_hash) = &h.original_hash {
        let actual_hash = Sha256::digest(&payload.content).to_vec();
        if &actual_hash != expected_hash {
            return Err(anyhow!("INTEGRITY ERROR: Hash mismatch. File is corrupted."));
        }
    }

    Ok(payload)
}