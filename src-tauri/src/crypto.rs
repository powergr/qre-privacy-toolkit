use crate::keychain::MasterKey;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use pqcrypto_kyber::kyber1024;
use pqcrypto_traits::kem::{Ciphertext as _, SecretKey as _, SharedSecret as _};
use rand::rngs::OsRng;
use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Seek, SeekFrom};
use zeroize::{Zeroize, ZeroizeOnDrop}; // Added Read/Seek

const AES_NONCE_LEN: usize = 12;
const CURRENT_VERSION: u32 = 3; // Version Bump
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

// --- Structs ---

#[derive(Serialize, Deserialize, Debug, Zeroize, ZeroizeOnDrop)]
pub struct InnerPayload {
    #[zeroize(skip)]
    pub filename: String,
    pub content: Vec<u8>,
}

// --- V3 Header (Current) ---
#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileHeader {
    pub wrapping_nonce: Vec<u8>,
    pub encrypted_private_key: Vec<u8>,
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,
    pub hybrid_nonce: Vec<u8>,
    pub kyber_encapped_session_key: Vec<u8>,
    pub uses_keyfile: bool,
    // NEW: Integrity Check
    pub original_hash: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileContainer {
    pub version: u32,
    pub header: EncryptedFileHeader,
    pub ciphertext: Vec<u8>,
}

// --- V2 Header (Legacy Support) ---
#[derive(Serialize, Deserialize, Debug)]
struct LegacyEncryptedFileHeader {
    pub wrapping_nonce: Vec<u8>,
    pub encrypted_private_key: Vec<u8>,
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,
    pub hybrid_nonce: Vec<u8>,
    pub kyber_encapped_session_key: Vec<u8>,
    pub uses_keyfile: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct LegacyEncryptedFileContainer {
    pub version: u32,
    pub header: LegacyEncryptedFileHeader,
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

        // 1. Peek at the Version (first 4 bytes u32 little-endian usually)
        let mut ver_buf = [0u8; 4];
        file.read_exact(&mut ver_buf)
            .context("Failed to read version")?;
        let version = u32::from_le_bytes(ver_buf);

        // Rewind to start
        file.seek(SeekFrom::Start(0))?;
        let reader = std::io::BufReader::new(file);

        if version == 2 {
            // LOAD LEGACY (V2) AND UPGRADE
            let legacy: LegacyEncryptedFileContainer =
                bincode::deserialize_from(reader).context("Failed to parse Legacy V2 file")?;

            Ok(EncryptedFileContainer {
                version: 3, // Upgrade to current
                header: EncryptedFileHeader {
                    wrapping_nonce: legacy.header.wrapping_nonce,
                    encrypted_private_key: legacy.header.encrypted_private_key,
                    validation_nonce: legacy.header.validation_nonce,
                    encrypted_validation_tag: legacy.header.encrypted_validation_tag,
                    hybrid_nonce: legacy.header.hybrid_nonce,
                    kyber_encapped_session_key: legacy.header.kyber_encapped_session_key,
                    uses_keyfile: legacy.header.uses_keyfile,
                    original_hash: None, // V2 didn't have hash
                },
                ciphertext: legacy.ciphertext,
            })
        } else if version == 3 {
            // LOAD CURRENT (V3)
            let container: Self =
                bincode::deserialize_from(reader).context("Failed to parse V3 file")?;
            Ok(container)
        } else {
            Err(anyhow!(
                "Unsupported version: {}. Update QRE Locker.",
                version
            ))
        }
    }
}

// --- Helper: Combine MasterKey + Optional Keyfile ---
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

fn compress_data(data: &[u8], level: i32) -> Result<Vec<u8>> {
    zstd::stream::encode_all(Cursor::new(data), level)
        .map_err(|e| anyhow!("Compression failed: {}", e))
}

fn decompress_data(data: &[u8]) -> Result<Vec<u8>> {
    zstd::stream::decode_all(Cursor::new(data)).map_err(|e| anyhow!("Decompression failed: {}", e))
}

// --- Main Logic ---

pub fn encrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    filename: &str,
    file_bytes: &[u8],
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32,
) -> Result<EncryptedFileContainer> {
    // NEW: Calculate Integrity Hash of the ORIGINAL data
    let original_hash = Sha256::digest(file_bytes).to_vec();

    // Payload & RNG
    let compressed_bytes = compress_data(file_bytes, compression_level)?;

    let payload = InnerPayload {
        filename: filename.to_string(),
        content: compressed_bytes,
    };
    let plaintext_blob = bincode::serialize(&payload)?;

    let mut rng: Box<dyn RngCore> = match entropy_seed {
        Some(seed) => Box::new(ChaCha20Rng::from_seed(seed)),
        None => Box::new(OsRng),
    };

    // Kyber & Session Encryption
    let (pk, sk) = kyber1024::keypair();
    let (ss, kyber_ct) = kyber1024::encapsulate(&pk);

    let mut session_key_bytes = ss.as_bytes().to_vec();
    let session_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&session_key_bytes);
    let cipher_session = Aes256Gcm::new(session_key);
    session_key_bytes.zeroize();

    let mut hybrid_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut hybrid_nonce);

    let encrypted_body = cipher_session
        .encrypt(Nonce::from_slice(&hybrid_nonce), plaintext_blob.as_ref())
        .map_err(|_| anyhow!("Body encryption failed"))?;

    // Prepare Wrapping Key
    let mut wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();

    // Encrypt Kyber Private Key
    let mut wrapping_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut wrapping_nonce);
    let encrypted_priv_key = cipher_wrap
        .encrypt(Nonce::from_slice(&wrapping_nonce), sk.as_bytes())
        .map_err(|_| anyhow!("Key wrapping failed"))?;

    // Validation Tag
    let mut validation_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut validation_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&validation_nonce), VALIDATION_MAGIC)
        .map_err(|_| anyhow!("Validation creation failed"))?;

    wrapping_key.zeroize();

    // Build
    Ok(EncryptedFileContainer {
        version: CURRENT_VERSION,
        header: EncryptedFileHeader {
            wrapping_nonce: wrapping_nonce.to_vec(),
            encrypted_private_key: encrypted_priv_key,
            validation_nonce: validation_nonce.to_vec(),
            encrypted_validation_tag: encrypted_validation,
            hybrid_nonce: hybrid_nonce.to_vec(),
            kyber_encapped_session_key: kyber_ct.as_bytes().to_vec(),
            uses_keyfile: keyfile_bytes.is_some(),
            original_hash: Some(original_hash), // STORE HASH
        },
        ciphertext: encrypted_body,
    })
}

pub fn decrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    container: &EncryptedFileContainer,
) -> Result<InnerPayload> {
    let h = &container.header;

    if h.uses_keyfile && keyfile_bytes.is_none() {
        return Err(anyhow!("This file requires a Keyfile. Please select it."));
    }

    let mut wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();

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
            return Err(anyhow!(
                "Decryption Denied. Master Key or Keyfile is incorrect."
            ));
        }
    }

    let sk_bytes = cipher_wrap
        .decrypt(
            Nonce::from_slice(&h.wrapping_nonce),
            h.encrypted_private_key.as_ref(),
        )
        .map_err(|_| anyhow!("Failed to decrypt private key"))?;
    wrapping_key.zeroize();

    let sk =
        kyber1024::SecretKey::from_bytes(&sk_bytes).map_err(|_| anyhow!("Invalid SK struct"))?;

    let ct = kyber1024::Ciphertext::from_bytes(&h.kyber_encapped_session_key)
        .map_err(|_| anyhow!("Invalid Kyber CT"))?;
    let ss = kyber1024::decapsulate(&ct, &sk);

    let mut session_key_bytes = ss.as_bytes().to_vec();
    let session_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&session_key_bytes);
    let cipher_session = Aes256Gcm::new(session_key);
    session_key_bytes.zeroize();

    let decrypted_blob = cipher_session
        .decrypt(
            Nonce::from_slice(&h.hybrid_nonce),
            container.ciphertext.as_ref(),
        )
        .map_err(|_| anyhow!("Body decryption failed."))?;

    let mut payload: InnerPayload = bincode::deserialize(&decrypted_blob)?;
    payload.content = decompress_data(&payload.content)?;

    // NEW: Integrity Check
    if let Some(expected_hash) = &h.original_hash {
        let actual_hash = Sha256::digest(&payload.content).to_vec();
        if &actual_hash != expected_hash {
            return Err(anyhow!("INTEGRITY ERROR: The decrypted file does not match the original hash. It may be corrupted or tampered with."));
        }
    }

    Ok(payload)
}
