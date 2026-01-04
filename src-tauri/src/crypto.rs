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
use argon2::{
    password_hash::{PasswordHasher, SaltString},
    Argon2, Params, Algorithm, Version
};
use sha2::{Sha256, Digest};
use zeroize::{Zeroize, ZeroizeOnDrop};
use std::io::Cursor;

// --- Constants ---
const AES_NONCE_LEN: usize = 12;
const CURRENT_VERSION: u32 = 2; // Bumped version for Compression + Validation

// Magic bytes to verify the key. Encrypted in the header.
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID"; 

// --- Structs ---

#[derive(Serialize, Deserialize, Debug, Zeroize, ZeroizeOnDrop)]
pub struct InnerPayload {
    #[zeroize(skip)] 
    pub filename: String,
    pub content: Vec<u8>, // Now holds COMPRESSED data
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileHeader {
    pub password_salt: String,
    pub wrapping_nonce: Vec<u8>,
    pub encrypted_private_key: Vec<u8>,
    
    // NEW: Small encrypted blob to verify password quickly
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,

    pub hybrid_nonce: Vec<u8>,
    pub kyber_encapped_session_key: Vec<u8>,
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
        let container: Self = bincode::deserialize_from(reader).context("Failed to parse encrypted file (Is this a valid .qre file?)")?;
        
        if container.version > CURRENT_VERSION {
            return Err(anyhow!("File version {} is newer than this tool supports. Update QRE.", container.version));
        }
        Ok(container)
    }
}

// --- Helpers ---

fn derive_key_multifactor(password: &str, keyfile_bytes: Option<&[u8]>, salt_str: &str) -> [u8; 32] {
    #[cfg(debug_assertions)]
    let (mem_cost, time_cost) = (1024, 1); 
    #[cfg(not(debug_assertions))]
    let (mem_cost, time_cost) = (19456, 2); 

    let params = Params::new(mem_cost, time_cost, 1, Some(32)).expect("Invalid Argon2 params");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::from_b64(salt_str).expect("Invalid salt");
    
    let mut input_material = password.as_bytes().to_vec();
    if let Some(kb) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(kb);
        let key_hash = hasher.finalize();
        input_material.extend_from_slice(&key_hash);
    }

    let hash = argon2.hash_password(&input_material, &salt).expect("Hashing failed");
    input_material.zeroize();

    let mut key = [0u8; 32];
    key.copy_from_slice(hash.hash.unwrap().as_bytes());
    key
}

fn compress_data(data: &[u8]) -> Result<Vec<u8>> {
    // 0 = default compression level (good balance)
    zstd::stream::encode_all(Cursor::new(data), 0).map_err(|e| anyhow!("Compression failed: {}", e))
}

fn decompress_data(data: &[u8]) -> Result<Vec<u8>> {
    zstd::stream::decode_all(Cursor::new(data)).map_err(|e| anyhow!("Decompression failed: {}", e))
}

// --- Main Logic ---

pub fn encrypt_file_with_password(
    password: &str, 
    keyfile_bytes: Option<&[u8]>,
    filename: &str,
    file_bytes: &[u8],
    entropy_seed: Option<[u8; 32]>
) -> Result<EncryptedFileContainer> {
    
    // 0. Compress Data
    let compressed_bytes = compress_data(file_bytes)?;

    // 1. Prepare Payload
    let payload = InnerPayload {
        filename: filename.to_string(),
        content: compressed_bytes,
    };
    let plaintext_blob = bincode::serialize(&payload).context("Failed to pack payload")?;

    // 2. Initialize RNG
    let mut rng: Box<dyn RngCore> = match entropy_seed {
        Some(seed) => Box::new(ChaCha20Rng::from_seed(seed)),
        None => Box::new(OsRng),
    };

    // A. Generate Kyber Keys
    let (pk, sk) = kyber1024::keypair();

    // B. Hybrid Encrypt Body
    let (ss, kyber_ct) = kyber1024::encapsulate(&pk);
    let mut session_key_bytes = ss.as_bytes().to_vec();
    let session_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&session_key_bytes);
    let cipher_session = Aes256Gcm::new(session_key);
    session_key_bytes.zeroize();
    
    let mut hybrid_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut hybrid_nonce);
    
    let encrypted_body = cipher_session.encrypt(Nonce::from_slice(&hybrid_nonce), plaintext_blob.as_ref())
        .map_err(|_| anyhow!("Body encryption failed"))?;

    // C. Derive Master Key
    let mut salt_bytes = [0u8; 16];
    rng.fill_bytes(&mut salt_bytes);
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| anyhow!(e))?.to_string();
    
    let mut master_key = derive_key_multifactor(password, keyfile_bytes, &salt);
    let cipher_master = Aes256Gcm::new_from_slice(&master_key).unwrap();

    // D. Encrypt Kyber Private Key
    let mut wrapping_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut wrapping_nonce);
    let encrypted_priv_key = cipher_master.encrypt(Nonce::from_slice(&wrapping_nonce), sk.as_bytes())
        .map_err(|_| anyhow!("Key wrapping failed"))?;

    // E. Create Validation Tag (Fingerprint)
    // We encrypt the magic string "QRE_VALID". If decrypt works later, creds are good.
    let mut validation_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut validation_nonce);
    let encrypted_validation = cipher_master.encrypt(Nonce::from_slice(&validation_nonce), VALIDATION_MAGIC)
        .map_err(|_| anyhow!("Validation creation failed"))?;

    master_key.zeroize();

    // F. Build Container
    Ok(EncryptedFileContainer {
        version: CURRENT_VERSION,
        header: EncryptedFileHeader {
            password_salt: salt,
            wrapping_nonce: wrapping_nonce.to_vec(),
            encrypted_private_key: encrypted_priv_key,
            validation_nonce: validation_nonce.to_vec(),
            encrypted_validation_tag: encrypted_validation, // <--- Added
            hybrid_nonce: hybrid_nonce.to_vec(),
            kyber_encapped_session_key: kyber_ct.as_bytes().to_vec(),
        },
        ciphertext: encrypted_body,
    })
}

pub fn decrypt_file_with_password(
    password: &str, 
    keyfile_bytes: Option<&[u8]>,
    container: &EncryptedFileContainer
) -> Result<InnerPayload> {
    let h = &container.header;

    // A. Derive Master Key
    let mut master_key = derive_key_multifactor(password, keyfile_bytes, &h.password_salt);
    let cipher_master = Aes256Gcm::new_from_slice(&master_key).unwrap();

    // B. Verify Fingerprint (Fast Fail)
    // If this version has a validation tag (v2+), use it.
    if container.version >= 2 {
        let val_nonce = Nonce::from_slice(&h.validation_nonce);
        match cipher_master.decrypt(val_nonce, h.encrypted_validation_tag.as_ref()) {
            Ok(bytes) => {
                if bytes != VALIDATION_MAGIC {
                    master_key.zeroize();
                    return Err(anyhow!("Invalid Credentials (Integrity Check Failed)"));
                }
            },
            Err(_) => {
                master_key.zeroize();
                // THIS IS THE FRIENDLY ERROR MESSAGE
                return Err(anyhow!("Incorrect Password or Keyfile."));
            }
        }
    }

    // C. Unlock Private Key
    let sk_bytes = cipher_master.decrypt(Nonce::from_slice(&h.wrapping_nonce), h.encrypted_private_key.as_ref())
        .map_err(|_| anyhow!("Incorrect Password or Keyfile (Key Unwrap Failed)."))?;
    
    master_key.zeroize();
    
    let sk = kyber1024::SecretKey::from_bytes(&sk_bytes).map_err(|_| anyhow!("Invalid internal key structure"))?;

    // D. Unwrap Session Key
    let ct = kyber1024::Ciphertext::from_bytes(&h.kyber_encapped_session_key).map_err(|_| anyhow!("Invalid Kyber CT"))?;
    let ss = kyber1024::decapsulate(&ct, &sk);

    // E. Decrypt Body
    let mut session_key_bytes = ss.as_bytes().to_vec();
    let session_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&session_key_bytes);
    let cipher_session = Aes256Gcm::new(session_key);
    session_key_bytes.zeroize();

    let decrypted_blob = cipher_session.decrypt(Nonce::from_slice(&h.hybrid_nonce), container.ciphertext.as_ref())
        .map_err(|_| anyhow!("File corrupted or tampering detected."))?;

    // F. Deserialize & Decompress
    let mut payload: InnerPayload = bincode::deserialize(&decrypted_blob)
        .context("Failed to unpack payload")?;

    // Decompress the content
    if container.version >= 2 {
        payload.content = decompress_data(&payload.content)?;
    }

    Ok(payload)
}