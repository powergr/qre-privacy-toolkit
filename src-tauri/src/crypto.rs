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
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing}; // Added Zeroizing

const AES_NONCE_LEN: usize = 12;
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

// --- Data Structures ---

#[derive(Serialize, Deserialize, Debug, Zeroize, ZeroizeOnDrop)]
pub struct InnerPayload {
    #[zeroize(skip)]
    pub filename: String,
    pub content: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileHeader {
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,
    pub key_wrapping_nonce: Vec<u8>,
    pub encrypted_file_key: Vec<u8>,
    pub body_nonce: Vec<u8>,
    pub uses_keyfile: bool,
    pub original_hash: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileContainer {
    pub version: u32,
    pub header: EncryptedFileHeader,
    pub ciphertext: Vec<u8>,
}

impl EncryptedFileContainer {
    pub fn save(&self, path: &str) -> Result<()> {
        let file = std::fs::File::create(path).context("Failed to create output file")?;
        let writer = std::io::BufWriter::new(file);
        bincode::serialize_into(writer, self).context("Failed to write encrypted file")?;
        Ok(())
    }

    pub fn load(path: &str) -> Result<Self> {
        let mut file = std::fs::File::open(path).context("Failed to open encrypted file")?;

        let mut ver_buf = [0u8; 4];
        file.read_exact(&mut ver_buf)
            .context("Failed to read version")?;
        let version = u32::from_le_bytes(ver_buf);

        file.seek(SeekFrom::Start(0))?;
        let reader = std::io::BufReader::new(file);

        if version == 4 {
            let container: Self =
                bincode::deserialize_from(reader).context("Failed to parse V4 file")?;
            Ok(container)
        } else {
            Err(anyhow!("Unsupported or legacy file version: {}.", version))
        }
    }
}

// --- Helper Functions ---

// Returns a Zeroizing wrapper to ensure the key is wiped from RAM
fn derive_wrapping_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
) -> Zeroizing<[u8; 32]> {
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
    Zeroizing::new(key)
}

fn compress_data(data: &[u8], level: i32) -> Result<Vec<u8>> {
    zstd::stream::encode_all(Cursor::new(data), level)
        .map_err(|e| anyhow!("Compression failed: {}", e))
}

fn decompress_data(data: &[u8]) -> Result<Vec<u8>> {
    zstd::stream::decode_all(Cursor::new(data)).map_err(|e| anyhow!("Decompression failed: {}", e))
}

// Secure constant-time comparison to prevent timing attacks
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

// --- ENCRYPTION ---

pub fn encrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    filename: &str,
    file_bytes: &[u8],
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32,
) -> Result<EncryptedFileContainer> {
    // 1. Calculate Integrity Hash
    let original_hash = Sha256::digest(file_bytes).to_vec();

    // 2. Compress Data
    let compressed_bytes = compress_data(file_bytes, compression_level)?;
    let payload = InnerPayload {
        filename: filename.to_string(),
        content: compressed_bytes,
    };
    let plaintext_blob = bincode::serialize(&payload)?;

    // 3. Setup RNG
    let mut rng: Box<dyn RngCore> = match entropy_seed {
        Some(seed) => Box::new(ChaCha20Rng::from_seed(seed)),
        None => Box::new(OsRng),
    };

    // 4. Generate File Key (Automatically Zeroized)
    let mut file_key = Zeroizing::new([0u8; 32]);
    rng.fill_bytes(&mut *file_key);
    let cipher_file =
        Aes256Gcm::new_from_slice(&*file_key).map_err(|e| anyhow!("Cipher error: {}", e))?;

    // 5. Encrypt Body
    let mut body_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut body_nonce);
    let encrypted_body = cipher_file
        .encrypt(Nonce::from_slice(&body_nonce), plaintext_blob.as_ref())
        .map_err(|_| anyhow!("Body encryption failed"))?;

    // 6. Wrap File Key (Automatically Zeroized)
    let wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap =
        Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!("Cipher error: {}", e))?;

    let mut key_wrapping_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut key_wrapping_nonce);
    let encrypted_file_key = cipher_wrap
        .encrypt(Nonce::from_slice(&key_wrapping_nonce), file_key.as_ref())
        .map_err(|_| anyhow!("Failed to encrypt file key"))?;

    // 7. Validation Tag
    let mut validation_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut validation_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&validation_nonce), VALIDATION_MAGIC)
        .map_err(|_| anyhow!("Validation creation failed"))?;

    // No need to manually zeroize file_key or wrapping_key! They drop automatically.

    Ok(EncryptedFileContainer {
        version: 4,
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

// --- DECRYPTION ---

pub fn decrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    container: &EncryptedFileContainer,
) -> Result<InnerPayload> {
    let h = &container.header;

    if h.uses_keyfile && keyfile_bytes.is_none() {
        return Err(anyhow!("This file requires a Keyfile. Please select it."));
    }

    let wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap =
        Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!("Cipher error: {}", e))?;

    let val_nonce = Nonce::from_slice(&h.validation_nonce);
    match cipher_wrap.decrypt(val_nonce, h.encrypted_validation_tag.as_ref()) {
        Ok(bytes) => {
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

    let file_key_vec = cipher_wrap
        .decrypt(
            Nonce::from_slice(&h.key_wrapping_nonce),
            h.encrypted_file_key.as_ref(),
        )
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;

    // Wrap the file key immediately
    let file_key = Zeroizing::new(file_key_vec);

    let cipher_file =
        Aes256Gcm::new_from_slice(&*file_key).map_err(|_| anyhow!("Invalid file key length"))?;
    let decrypted_blob = cipher_file
        .decrypt(
            Nonce::from_slice(&h.body_nonce),
            container.ciphertext.as_ref(),
        )
        .map_err(|_| anyhow!("Body decryption failed."))?;

    let mut payload: InnerPayload = bincode::deserialize(&decrypted_blob)?;
    payload.content = decompress_data(&payload.content)?;

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
