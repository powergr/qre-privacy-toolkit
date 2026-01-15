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
use zeroize::{Zeroize, ZeroizeOnDrop};

// Standard nonce length for AES-256-GCM (12 bytes)
const AES_NONCE_LEN: usize = 12;

// Tracks format changes. V3 adds integrity hashing.
const CURRENT_VERSION: u32 = 3; 

// A constant string encrypted inside the header to verify if a password is correct quickly.
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

// --- Data Structures ---

/// The decrypted content of a file.
/// This structure is strictly internal and wipes itself from memory (Zeroize) when dropped.
#[derive(Serialize, Deserialize, Debug, Zeroize, ZeroizeOnDrop)]
pub struct InnerPayload {
    #[zeroize(skip)]
    pub filename: String, // Original filename (e.g., "photo.jpg")
    pub content: Vec<u8>, // The actual file data (decompressed)
}

/// The Header contains all the cryptographic metadata needed to unlock the file.
/// It does NOT contain the file data itself.
#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileHeader {
    // Nonce used to encrypt the Kyber Private Key
    pub wrapping_nonce: Vec<u8>,
    
    // The Post-Quantum Kyber Private Key, encrypted with the User's Master Password
    pub encrypted_private_key: Vec<u8>,
    
    // Nonce and Tag used to check if the password is correct before attempting full decryption
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,
    
    // Nonce used to encrypt the actual file body
    pub hybrid_nonce: Vec<u8>,
    
    // The Kyber Encapsulated Key (Public part) needed to derive the Session Key
    pub kyber_encapped_session_key: Vec<u8>,
    
    // Flag indicating if a Keyfile is required to open this file
    pub uses_keyfile: bool,
    
    // HASH of the original file content. Used to verify the file hasn't been corrupted or tampered with.
    // Present in V3+ files only.
    pub original_hash: Option<Vec<u8>>,
}

/// The main container format for a .qre file.
#[derive(Serialize, Deserialize, Debug)]
pub struct EncryptedFileContainer {
    pub version: u32,
    pub header: EncryptedFileHeader,
    pub ciphertext: Vec<u8>, // The encrypted file body
}

// --- Legacy V2 Structures (for Backward Compatibility) ---
// Used to read older files created by previous versions of the software.
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
    /// Serializes the container structure and writes it to disk as a binary file.
    pub fn save(&self, path: &str) -> Result<()> {
        let file = std::fs::File::create(path).context("Failed to create output file")?;
        let writer = std::io::BufWriter::new(file);
        bincode::serialize_into(writer, self).context("Failed to write encrypted file")?;
        Ok(())
    }

    /// Reads a .qre file from disk, detecting its version and upgrading it if necessary.
    pub fn load(path: &str) -> Result<Self> {
        let mut file = std::fs::File::open(path).context("Failed to open encrypted file")?;

        // 1. Peek at the first 4 bytes to determine the Version number.
        let mut ver_buf = [0u8; 4];
        file.read_exact(&mut ver_buf)
            .context("Failed to read version")?;
        let version = u32::from_le_bytes(ver_buf);

        // 2. Rewind file to the beginning to read the full structure.
        file.seek(SeekFrom::Start(0))?;
        let reader = std::io::BufReader::new(file);

        if version == 2 {
            // HANDLE LEGACY V2 FILES
            // Reads the old format and maps it to the new V3 structure (setting hash to None).
            let legacy: LegacyEncryptedFileContainer =
                bincode::deserialize_from(reader).context("Failed to parse Legacy V2 file")?;

            Ok(EncryptedFileContainer {
                version: 3, // Upgrade in memory
                header: EncryptedFileHeader {
                    wrapping_nonce: legacy.header.wrapping_nonce,
                    encrypted_private_key: legacy.header.encrypted_private_key,
                    validation_nonce: legacy.header.validation_nonce,
                    encrypted_validation_tag: legacy.header.encrypted_validation_tag,
                    hybrid_nonce: legacy.header.hybrid_nonce,
                    kyber_encapped_session_key: legacy.header.kyber_encapped_session_key,
                    uses_keyfile: legacy.header.uses_keyfile,
                    original_hash: None, // V2 files lack integrity hashes
                },
                ciphertext: legacy.ciphertext,
            })
        } else if version == 3 {
            // HANDLE CURRENT V3 FILES
            let container: Self =
                bincode::deserialize_from(reader).context("Failed to parse V3 file")?;
            Ok(container)
        } else {
            Err(anyhow!(
                "Unsupported version: {}. Please update QRE Locker.",
                version
            ))
        }
    }
}

// --- Helper Functions ---

/// Generates the "Wrapping Key" used to encrypt the Kyber Private Key.
/// It combines the Master Key (from password) and the optional Keyfile bytes (if provided).
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

/// Compresses data using Zstd before encryption to save space.
fn compress_data(data: &[u8], level: i32) -> Result<Vec<u8>> {
    zstd::stream::encode_all(Cursor::new(data), level)
        .map_err(|e| anyhow!("Compression failed: {}", e))
}

/// Decompresses data after decryption.
fn decompress_data(data: &[u8]) -> Result<Vec<u8>> {
    zstd::stream::decode_all(Cursor::new(data)).map_err(|e| anyhow!("Decompression failed: {}", e))
}

// --- MAIN CRYPTO LOGIC ---

/// ENCRYPTION PROCESS
/// 1. Hashes the original file for integrity checking.
/// 2. Compresses the file data.
/// 3. Generates a one-time Post-Quantum Kyber Keypair (Public/Private).
/// 4. Uses Kyber to generate a shared "Session Key".
/// 5. Encrypts the file body using the Session Key (AES-256-GCM).
/// 6. Encrypts the Kyber Private Key using the User's Master Key (wrapping).
/// 7. Packages everything into a container.
pub fn encrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    filename: &str,
    file_bytes: &[u8],
    entropy_seed: Option<[u8; 32]>, // Optional mouse movement data for true randomness
    compression_level: i32,
) -> Result<EncryptedFileContainer> {
    
    // Step 1: Calculate Integrity Hash
    let original_hash = Sha256::digest(file_bytes).to_vec();

    // Step 2: Compress
    let compressed_bytes = compress_data(file_bytes, compression_level)?;

    let payload = InnerPayload {
        filename: filename.to_string(),
        content: compressed_bytes,
    };
    let plaintext_blob = bincode::serialize(&payload)?;

    // Step 3: Setup Random Number Generator
    let mut rng: Box<dyn RngCore> = match entropy_seed {
        Some(seed) => Box::new(ChaCha20Rng::from_seed(seed)), // Use user-provided entropy
        None => Box::new(OsRng), // Fallback to OS randomness
    };

    // Step 4: Generate Ephemeral Kyber Keys (Post-Quantum)
    let (pk, sk) = kyber1024::keypair();
    let (ss, kyber_ct) = kyber1024::encapsulate(&pk);

    // Use the shared secret from Kyber as the AES Key
    let mut session_key_bytes = ss.as_bytes().to_vec();
    let session_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&session_key_bytes);
    let cipher_session = Aes256Gcm::new(session_key);
    session_key_bytes.zeroize(); // Wipe key from memory immediately

    // Step 5: Encrypt the File Body
    let mut hybrid_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut hybrid_nonce);

    let encrypted_body = cipher_session
        .encrypt(Nonce::from_slice(&hybrid_nonce), plaintext_blob.as_ref())
        .map_err(|_| anyhow!("Body encryption failed"))?;

    // Step 6: Encrypt the Private Key (Key Wrapping)
    // We encrypt the Kyber Private Key so only the user (with their password) can retrieve it later.
    let mut wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();

    let mut wrapping_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut wrapping_nonce);
    let encrypted_priv_key = cipher_wrap
        .encrypt(Nonce::from_slice(&wrapping_nonce), sk.as_bytes())
        .map_err(|_| anyhow!("Key wrapping failed"))?;

    // Step 7: Create Validation Tag (For quick password checking)
    let mut validation_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut validation_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&validation_nonce), VALIDATION_MAGIC)
        .map_err(|_| anyhow!("Validation creation failed"))?;

    wrapping_key.zeroize(); // Wipe wrapping key

    // Step 8: Build Final Container
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
            original_hash: Some(original_hash), // Store the hash for integrity checks
        },
        ciphertext: encrypted_body,
    })
}

/// DECRYPTION PROCESS
/// 1. Checks if Keyfile is present (if required).
/// 2. Derives the Wrapping Key from Password + Keyfile.
/// 3. Validates the password by trying to decrypt the Validation Tag.
/// 4. Decrypts the Kyber Private Key.
/// 5. Uses Kyber Decapsulate to recover the Session Key.
/// 6. Decrypts the file body using the Session Key.
/// 7. Decompresses the data.
/// 8. Verifies the Integrity Hash to ensure data safety.
pub fn decrypt_file_with_master_key(
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    container: &EncryptedFileContainer,
) -> Result<InnerPayload> {
    let h = &container.header;

    // Check Keyfile Requirement
    if h.uses_keyfile && keyfile_bytes.is_none() {
        return Err(anyhow!("This file requires a Keyfile. Please select it."));
    }

    // Derive Wrapping Key
    let mut wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();

    // Verify Password (Validation Tag)
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

    // Recover Kyber Private Key
    let sk_bytes = cipher_wrap
        .decrypt(
            Nonce::from_slice(&h.wrapping_nonce),
            h.encrypted_private_key.as_ref(),
        )
        .map_err(|_| anyhow!("Failed to decrypt private key"))?;
    wrapping_key.zeroize();

    let sk =
        kyber1024::SecretKey::from_bytes(&sk_bytes).map_err(|_| anyhow!("Invalid SK struct"))?;

    // Recover Session Key via Kyber
    let ct = kyber1024::Ciphertext::from_bytes(&h.kyber_encapped_session_key)
        .map_err(|_| anyhow!("Invalid Kyber CT"))?;
    let ss = kyber1024::decapsulate(&ct, &sk);

    let mut session_key_bytes = ss.as_bytes().to_vec();
    let session_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&session_key_bytes);
    let cipher_session = Aes256Gcm::new(session_key);
    session_key_bytes.zeroize();

    // Decrypt File Body
    let decrypted_blob = cipher_session
        .decrypt(
            Nonce::from_slice(&h.hybrid_nonce),
            container.ciphertext.as_ref(),
        )
        .map_err(|_| anyhow!("Body decryption failed."))?;

    // Deserialize and Decompress
    let mut payload: InnerPayload = bincode::deserialize(&decrypted_blob)?;
    payload.content = decompress_data(&payload.content)?;

    // VERIFY INTEGRITY (V3+)
    // Calculates the hash of the decrypted data and compares it to the stored hash.
    if let Some(expected_hash) = &h.original_hash {
        let actual_hash = Sha256::digest(&payload.content).to_vec();
        if &actual_hash != expected_hash {
            return Err(anyhow!("INTEGRITY ERROR: The decrypted file does not match the original hash. It may be corrupted or tampered with."));
        }
    }

    Ok(payload)
}