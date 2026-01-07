use crate::keychain::MasterKey; 
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce
};
use pqcrypto_kyber::kyber1024;
use pqcrypto_traits::kem::{
    Ciphertext as _, SecretKey as _, SharedSecret as _
};
use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use anyhow::{Result, anyhow, Context};
use sha2::{Sha256, Digest};
use zeroize::{Zeroize, ZeroizeOnDrop};
use std::io::Cursor;

const AES_NONCE_LEN: usize = 12;
const CURRENT_VERSION: u32 = 2;
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID"; 

// --- Structs ---

#[derive(Serialize, Deserialize, Debug, Zeroize, ZeroizeOnDrop)]
pub struct InnerPayload {
    #[zeroize(skip)] 
    pub filename: String,
    pub content: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileHeader {
    pub wrapping_nonce: Vec<u8>,
    pub encrypted_private_key: Vec<u8>,
    
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,

    pub hybrid_nonce: Vec<u8>,
    pub kyber_encapped_session_key: Vec<u8>,
    
    pub uses_keyfile: bool,
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
        let file = std::fs::File::open(path).context("Failed to open encrypted file")?;
        let reader = std::io::BufReader::new(file);
        let container: Self = bincode::deserialize_from(reader).context("Failed to parse encrypted file")?;
        if container.version > CURRENT_VERSION {
            return Err(anyhow!("Unsupported version: {}. Update QRE.", container.version));
        }
        Ok(container)
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

// CHANGED: Added level parameter
fn compress_data(data: &[u8], level: i32) -> Result<Vec<u8>> {
    zstd::stream::encode_all(Cursor::new(data), level).map_err(|e| anyhow!("Compression failed: {}", e))
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
    compression_level: i32 // CHANGED: Added parameter
) -> Result<EncryptedFileContainer> {
    
    // 0. Payload & RNG
    // Pass user selected level to Zstd
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

    // A. Kyber & Session Encryption
    let (pk, sk) = kyber1024::keypair();
    let (ss, kyber_ct) = kyber1024::encapsulate(&pk);
    
    let mut session_key_bytes = ss.as_bytes().to_vec();
    let session_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&session_key_bytes);
    let cipher_session = Aes256Gcm::new(session_key);
    session_key_bytes.zeroize();
    
    let mut hybrid_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut hybrid_nonce);
    
    let encrypted_body = cipher_session.encrypt(Nonce::from_slice(&hybrid_nonce), plaintext_blob.as_ref())
        .map_err(|_| anyhow!("Body encryption failed"))?;

    // B. Prepare Wrapping Key (Master + Keyfile)
    let mut wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();

    // C. Encrypt Kyber Private Key
    let mut wrapping_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut wrapping_nonce);
    let encrypted_priv_key = cipher_wrap.encrypt(Nonce::from_slice(&wrapping_nonce), sk.as_bytes())
        .map_err(|_| anyhow!("Key wrapping failed"))?;

    // D. Validation Tag
    let mut validation_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut validation_nonce);
    let encrypted_validation = cipher_wrap.encrypt(Nonce::from_slice(&validation_nonce), VALIDATION_MAGIC)
        .map_err(|_| anyhow!("Validation creation failed"))?;

    wrapping_key.zeroize();

    // E. Build
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
        },
        ciphertext: encrypted_body,
    })
}

pub fn decrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    container: &EncryptedFileContainer
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
        },
        Err(_) => {
            wrapping_key.zeroize();
            return Err(anyhow!("Decryption Denied. Master Key or Keyfile is incorrect."));
        }
    }

    let sk_bytes = cipher_wrap.decrypt(Nonce::from_slice(&h.wrapping_nonce), h.encrypted_private_key.as_ref())
        .map_err(|_| anyhow!("Failed to decrypt private key"))?;
    wrapping_key.zeroize();
    
    let sk = kyber1024::SecretKey::from_bytes(&sk_bytes).map_err(|_| anyhow!("Invalid SK struct"))?;

    let ct = kyber1024::Ciphertext::from_bytes(&h.kyber_encapped_session_key).map_err(|_| anyhow!("Invalid Kyber CT"))?;
    let ss = kyber1024::decapsulate(&ct, &sk);

    let mut session_key_bytes = ss.as_bytes().to_vec();
    let session_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&session_key_bytes);
    let cipher_session = Aes256Gcm::new(session_key);
    session_key_bytes.zeroize();

    let decrypted_blob = cipher_session.decrypt(Nonce::from_slice(&h.hybrid_nonce), container.ciphertext.as_ref())
        .map_err(|_| anyhow!("Body decryption failed."))?;

    let mut payload: InnerPayload = bincode::deserialize(&decrypted_blob)?;
    payload.content = decompress_data(&payload.content)?;

    Ok(payload)
}