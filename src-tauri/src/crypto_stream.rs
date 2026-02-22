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
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use zeroize::Zeroizing;

// --- CONSTANTS ---

// 1MB Chunk Size
const CHUNK_SIZE: usize = 1024 * 1024;
const AES_NONCE_LEN: usize = 12;
const FILE_KEY_LEN: usize = 32;
const CURRENT_VERSION: u32 = 5;
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

// --- HEADER STRUCTURE ---

#[derive(Serialize, Deserialize, Debug)]
pub struct StreamHeader {
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,
    pub key_wrapping_nonce: Vec<u8>,
    pub encrypted_file_key: Vec<u8>,
    pub base_nonce: Vec<u8>,
    pub original_filename: String,
    pub original_hash: Option<Vec<u8>>,
}

// --- HELPER FUNCTIONS ---

/// Derives a wrapping key from the Master Key + Keyfile.
/// Returns a Zeroizing wrapper to ensure it's wiped from RAM automatically.
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

    let res = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&res);
    Zeroizing::new(key)
}

fn compress_chunk(data: &[u8], level: i32) -> Result<Vec<u8>> {
    let mut encoder = zstd::Encoder::new(Vec::new(), level)?;
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
}

fn decompress_chunk(data: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = zstd::Decoder::new(std::io::Cursor::new(data))?;
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)?;
    Ok(out)
}

// --- STREAM ENCRYPTOR ---

pub fn encrypt_file_stream(
    input_path: &str,
    output_path: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32,
    callback: impl Fn(u64, u64),
) -> Result<()> {
    let mut input_file = BufReader::new(File::open(input_path)?);
    let total_size = std::fs::metadata(input_path)?.len();
    let original_filename = std::path::Path::new(input_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut output_file = BufWriter::new(File::create(output_path)?);

    // 1. Write Version
    output_file.write_all(&CURRENT_VERSION.to_le_bytes())?;

    // 2. Setup RNG
    let mut rng: Box<dyn RngCore> = match entropy_seed {
        Some(seed) => Box::new(ChaCha20Rng::from_seed(seed)),
        None => Box::new(OsRng),
    };

    // 3. Generate File Key (FEK) - Automatically Zeroized on drop
    let mut file_key = Zeroizing::new([0u8; FILE_KEY_LEN]);
    rng.fill_bytes(&mut *file_key);
    let cipher_file = Aes256Gcm::new_from_slice(&*file_key).map_err(|e| anyhow!(e))?;

    // 4. Derive Wrapping Key (KEK) - Automatically Zeroized
    let wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    // 5. Create Header
    // A. Validation Tag
    let mut val_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut val_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&val_nonce), VALIDATION_MAGIC)
        .map_err(|e| anyhow!("Validation encrypt failed: {}", e))?;

    // B. Encrypt File Key
    let mut key_wrap_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut key_wrap_nonce);
    let encrypted_file_key = cipher_wrap
        .encrypt(Nonce::from_slice(&key_wrap_nonce), file_key.as_ref())
        .map_err(|e| anyhow!("File key wrap failed: {}", e))?;

    // C. Base Nonce
    let mut base_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut base_nonce);

    let header = StreamHeader {
        validation_nonce: val_nonce.to_vec(),
        encrypted_validation_tag: encrypted_validation,
        key_wrapping_nonce: key_wrap_nonce.to_vec(),
        encrypted_file_key,
        base_nonce: base_nonce.to_vec(),
        original_filename: original_filename.clone(),
        original_hash: None,
    };

    bincode::serialize_into(&mut output_file, &header)?;

    // 6. Streaming Loop
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut chunk_index: u64 = 0;
    let mut processed_bytes: u64 = 0;

    loop {
        let bytes_read = input_file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }

        let chunk_data = &buffer[..bytes_read];
        let compressed = compress_chunk(chunk_data, compression_level)?;

        // Calculate Rolling Nonce
        let mut chunk_nonce = base_nonce;
        let index_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce[4 + i] ^= index_bytes[i];
        }

        // SECURITY UPGRADE: Add Associated Data (AAD)
        // We bind the Chunk Index and Filename to the encryption.
        // If an attacker swaps chunks, the index won't match, and decryption fails.
        let aad_tag = format!("{}:{}", original_filename, chunk_index);
        let payload = Payload {
            msg: &compressed,
            aad: aad_tag.as_bytes(),
        };

        let ciphertext = cipher_file
            .encrypt(Nonce::from_slice(&chunk_nonce), payload)
            .map_err(|_| anyhow!("Chunk encryption failed"))?;

        // Write: [Size (4 bytes)] + [Ciphertext]
        let size = (ciphertext.len() as u32).to_le_bytes();
        output_file.write_all(&size)?;
        output_file.write_all(&ciphertext)?;

        processed_bytes += bytes_read as u64;
        chunk_index += 1;
        callback(processed_bytes, total_size);
    }

    output_file.flush()?;
    Ok(())
}

// --- STREAM DECRYPTOR ---

pub fn decrypt_file_stream(
    input_path: &str,
    output_dir: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    callback: impl Fn(u64, u64),
) -> Result<String> {
    let mut input_file = BufReader::new(File::open(input_path)?);
    let file_size = std::fs::metadata(input_path)?.len();

    // 1. Skip Version
    let mut ver_buf = [0u8; 4];
    input_file.read_exact(&mut ver_buf)?;

    // 2. Read Header
    let header: StreamHeader =
        bincode::deserialize_from(&mut input_file).context("Failed to read header")?;

    // 3. Unwrap Keys
    let wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    // Verify Password
    let val_nonce = Nonce::from_slice(&header.validation_nonce);
    match cipher_wrap.decrypt(val_nonce, header.encrypted_validation_tag.as_ref()) {
        Ok(bytes) => {
            if bytes != VALIDATION_MAGIC {
                return Err(anyhow!("Validation tag mismatch"));
            }
        }
        Err(_) => return Err(anyhow!("Decryption Denied")),
    }

    // Unwrap File Key
    let file_key_vec = cipher_wrap
        .decrypt(
            Nonce::from_slice(&header.key_wrapping_nonce),
            header.encrypted_file_key.as_ref(),
        )
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;

    // Zeroizing wrapper for File Key
    let file_key = Zeroizing::new(file_key_vec);
    let cipher_file = Aes256Gcm::new_from_slice(&*file_key).unwrap();

    // 4. Prepare Output
    let output_filename = header.original_filename.clone();
    let raw_output_path = std::path::Path::new(output_dir).join(&output_filename);
    let final_output_path = crate::utils::get_unique_path(&raw_output_path);
    let final_filename = final_output_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut output_file = BufWriter::new(File::create(&final_output_path)?);

    // 5. Decrypt Loop
    let mut chunk_index: u64 = 0;
    let mut size_buf = [0u8; 4];
    let mut processed = 0;

    loop {
        match input_file.read_exact(&mut size_buf) {
            Ok(_) => {}
            Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(anyhow!("Read error: {}", e)),
        };

        let chunk_len = u32::from_le_bytes(size_buf) as usize;
        if chunk_len > CHUNK_SIZE + 4096 {
            return Err(anyhow!("Chunk size anomaly"));
        }

        let mut ciphertext = vec![0u8; chunk_len];
        input_file.read_exact(&mut ciphertext)?;

        // Reconstruct Nonce
        let mut chunk_nonce = [0u8; AES_NONCE_LEN];
        chunk_nonce.copy_from_slice(&header.base_nonce);
        let index_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce[4 + i] ^= index_bytes[i];
        }

        // SECURITY CHECK: Reconstruct AAD
        let aad_tag = format!("{}:{}", header.original_filename, chunk_index);
        let payload = Payload {
            msg: &ciphertext,
            aad: aad_tag.as_bytes(),
        };

        // Decrypt (Fails if Index or Filename doesn't match)
        let compressed = cipher_file
            .decrypt(Nonce::from_slice(&chunk_nonce), payload)
            .map_err(|_| anyhow!("Chunk {} integrity check failed", chunk_index))?;

        let plaintext = decompress_chunk(&compressed)?;
        output_file.write_all(&plaintext)?;

        processed += chunk_len as u64;
        chunk_index += 1;

        if chunk_index % 5 == 0 {
            callback(processed, file_size);
        }
    }

    output_file.flush()?;
    Ok(final_filename)
}
