use crate::keychain::MasterKey;
use crate::utils;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use rand::{rngs::OsRng, RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use zeroize::Zeroize;

// --- CONSTANTS ---

// The size of data blocks read from disk into RAM.
// 1MB is a "Sweet Spot": Small enough for low-end phones, large enough for fast I/O.
const CHUNK_SIZE: usize = 1 * 1024 * 1024; 

// Standard AES-GCM nonce length (12 bytes).
const AES_NONCE_LEN: usize = 12;

// The File Encryption Key (FEK) is always 256-bit (32 bytes).
const FILE_KEY_LEN: usize = 32;

// Protocol Version 5: Denotes the new Streaming Format.
const CURRENT_VERSION: u32 = 5; 

// A magic string encrypted in the header to verify the password quickly.
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

// --- HEADER STRUCTURE ---

/// The metadata stored at the beginning of a V5 (.qre) file.
/// It contains everything needed to derive keys and verify the password,
/// but DOES NOT contain the file data itself.
#[derive(Serialize, Deserialize, Debug)]
pub struct StreamHeader {
    // Used to verify if the entered password is correct before attempting decryption.
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,

    // The random "File Key" is encrypted using the User's "Master Key".
    // This allows changing the password without re-encrypting the whole file.
    pub key_wrapping_nonce: Vec<u8>,
    pub encrypted_file_key: Vec<u8>,

    // The starting nonce for the file body.
    // Individual chunk nonces are derived from this + the chunk index.
    pub base_nonce: Vec<u8>,

    // Preserves the original filename (e.g., "video.mp4") so it can be restored.
    pub original_filename: String,
    
    // Optional integrity hash (reserved for future use).
    pub original_hash: Option<Vec<u8>>,
}

// --- HELPER FUNCTIONS ---

/// Combines the User's Master Key (Password based) with the Keyfile (if present)
/// to create the "Wrapping Key". This key is used to encrypt the File Key.
fn derive_wrapping_key(master_key: &MasterKey, keyfile_bytes: Option<&[u8]>) -> [u8; 32] {
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
    key
}

/// Compresses a single 1MB chunk using Zstd.
/// The `level` parameter determines the compression strength (1 = Fast, 19 = Max).
fn compress_chunk(data: &[u8], level: i32) -> Result<Vec<u8>> {
    let mut encoder = zstd::Encoder::new(Vec::new(), level)?;
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
}

/// Decompresses a chunk back to its original state.
fn decompress_chunk(data: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = zstd::Decoder::new(std::io::Cursor::new(data))?;
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)?;
    Ok(out)
}

// --- STREAM ENCRYPTOR ---

/// Encrypts a file using the V5 Streaming Engine.
/// 
/// This function reads the input file in small chunks (1MB), compresses them,
/// encrypts them, and writes them to the output file immediately.
/// This ensures RAM usage stays constant (~50MB) even for files sized 10GB+.
pub fn encrypt_file_stream(
    input_path: &str,
    output_path: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32, 
    callback: impl Fn(u64, u64), // Progress update function
) -> Result<()> {
    // Open streams
    let mut input_file = BufReader::new(File::open(input_path)?);
    let total_size = std::fs::metadata(input_path)?.len();
    let original_filename = std::path::Path::new(input_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut output_file = BufWriter::new(File::create(output_path)?);

    // 1. Write the Protocol Version (4 bytes)
    // This allows the decryptor to know which engine to use (V4 vs V5).
    output_file.write_all(&CURRENT_VERSION.to_le_bytes())?;

    // 2. Setup Random Number Generator (RNG)
    // Uses hardware entropy + optional user mouse movements ("Paranoid Mode").
    let mut rng: Box<dyn RngCore> = match entropy_seed {
        Some(seed) => Box::new(ChaCha20Rng::from_seed(seed)),
        None => Box::new(OsRng),
    };

    // 3. Generate the File Encryption Key (FEK)
    // This random 32-byte key is unique to this specific file.
    let mut file_key = [0u8; FILE_KEY_LEN];
    rng.fill_bytes(&mut file_key);
    let cipher_file = Aes256Gcm::new_from_slice(&file_key).unwrap();

    // 4. Derive Wrapping Key (From Password)
    let mut wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();

    // 5. Create Header Data
    
    // A. Validation Tag (To check password correctness)
    let mut validation_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut validation_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&validation_nonce), VALIDATION_MAGIC)
        .map_err(|_| anyhow!("Validation failed"))?;

    // B. Encrypted File Key (Key Wrapping)
    let mut key_wrapping_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut key_wrapping_nonce);
    let encrypted_file_key = cipher_wrap
        .encrypt(Nonce::from_slice(&key_wrapping_nonce), file_key.as_ref())
        .map_err(|_| anyhow!("File Key Wrap failed"))?;

    // C. Base Nonce for the stream
    let mut base_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut base_nonce);

    let header = StreamHeader {
        validation_nonce: validation_nonce.to_vec(),
        encrypted_validation_tag: encrypted_validation,
        key_wrapping_nonce: key_wrapping_nonce.to_vec(),
        encrypted_file_key,
        base_nonce: base_nonce.to_vec(),
        original_filename,
        original_hash: None,
    };

    // 6. Write Header to disk
    bincode::serialize_into(&mut output_file, &header)?;

    // 7. Start Streaming Loop
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut chunk_index: u64 = 0;
    let mut processed_bytes: u64 = 0;

    loop {
        // Read a chunk from source
        let bytes_read = input_file.read(&mut buffer)?;
        if bytes_read == 0 {
            break; // End of File
        }

        let chunk_data = &buffer[..bytes_read];

        // Compress the chunk
        let compressed = compress_chunk(chunk_data, compression_level)?;

        // Calculate Rolling Nonce
        // Security Note: We cannot use the same nonce for every chunk.
        // We derive a new nonce by XORing the chunk index into the base nonce.
        let mut chunk_nonce_bytes = base_nonce;
        let index_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce_bytes[4 + i] ^= index_bytes[i];
        }
        
        let nonce = Nonce::from_slice(&chunk_nonce_bytes);

        // Encrypt the compressed chunk
        let ciphertext = cipher_file.encrypt(nonce, compressed.as_ref())
            .map_err(|_| anyhow!("Chunk encryption failed"))?;

        // Write Format: [Size (4 bytes)] + [Encrypted Data]
        // We must write the size because compression makes chunks variable length.
        let size = (ciphertext.len() as u32).to_le_bytes();
        output_file.write_all(&size)?;
        output_file.write_all(&ciphertext)?;

        // Update progress
        processed_bytes += bytes_read as u64;
        chunk_index += 1;
        callback(processed_bytes, total_size);
    }

    // 8. Cleanup
    output_file.flush()?; // Ensure all data is written to disk
    
    // Wipe keys from RAM
    file_key.zeroize();
    wrapping_key.zeroize();

    Ok(())
}

// --- STREAM DECRYPTOR ---

/// Decrypts a V5 (.qre) stream file.
pub fn decrypt_file_stream(
    input_path: &str,
    output_dir: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    callback: impl Fn(u64, u64),
) -> Result<String> {
    let mut input_file = BufReader::new(File::open(input_path)?);
    let file_size = std::fs::metadata(input_path)?.len();
    
    // 1. Skip Version Bytes
    // The command handler already checked these to route to V5 logic.
    let mut ver_buf = [0u8; 4];
    input_file.read_exact(&mut ver_buf).context("Failed to skip version bytes")?;

    // 2. Read and Parse Header
    let header: StreamHeader = bincode::deserialize_from(&mut input_file)
        .context("Failed to read V5 Header")?;

    // 3. Unwrap Keys
    let mut wrapping_key = derive_wrapping_key(master_key, keyfile_bytes);
    let cipher_wrap = Aes256Gcm::new_from_slice(&wrapping_key).unwrap();

    // Verify Password (Validation Tag)
    let val_nonce = Nonce::from_slice(&header.validation_nonce);
    match cipher_wrap.decrypt(val_nonce, header.encrypted_validation_tag.as_ref()) {
        Ok(bytes) => {
            if bytes != VALIDATION_MAGIC {
                return Err(anyhow!("Validation tag mismatch."));
            }
        }
        Err(_) => return Err(anyhow!("Decryption Denied. Check password.")),
    }

    // Decrypt the File Key (FEK)
    let file_key_vec = cipher_wrap.decrypt(
        Nonce::from_slice(&header.key_wrapping_nonce), 
        header.encrypted_file_key.as_ref()
    ).map_err(|_| anyhow!("Failed to unwrap file key"))?;
    
    let cipher_file = Aes256Gcm::new_from_slice(&file_key_vec).unwrap();
    wrapping_key.zeroize();

    // 4. Prepare Output File
    // Ensures we don't overwrite existing files (e.g., "video (1).mp4")
    let output_filename = header.original_filename;
    let raw_output_path = std::path::Path::new(output_dir).join(&output_filename);
    let final_output_path = utils::get_unique_path(&raw_output_path);
    
    let final_filename = final_output_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut output_file = BufWriter::new(File::create(&final_output_path)?);

    // 5. Decrypt Loop
    let mut chunk_index: u64 = 0;
    let mut size_buf = [0u8; 4];
    let mut processed_file_bytes = 0;

    loop {
        // Read Chunk Size (4 bytes)
        match input_file.read_exact(&mut size_buf) {
            Ok(_) => {},
            Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break, // Clean EOF
            Err(e) => return Err(anyhow!("Read error: {}", e)),
        };
        
        let chunk_len = u32::from_le_bytes(size_buf) as usize;
        
        // Safety check to prevent Out-Of-Memory attacks
        if chunk_len > CHUNK_SIZE + 4096 { 
             return Err(anyhow!("Chunk size too large (corrupt file?)"));
        }

        // Read Encrypted Chunk
        let mut ciphertext = vec![0u8; chunk_len];
        input_file.read_exact(&mut ciphertext)?;

        // Re-calculate the Nonce for this chunk
        let mut chunk_nonce_bytes = [0u8; AES_NONCE_LEN];
        chunk_nonce_bytes.copy_from_slice(&header.base_nonce);
        let index_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce_bytes[4 + i] ^= index_bytes[i];
        }
        let nonce = Nonce::from_slice(&chunk_nonce_bytes);

        // Decrypt
        let compressed = cipher_file.decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| anyhow!("Chunk {} decryption failed", chunk_index))?;

        // Decompress
        let plaintext = decompress_chunk(&compressed)?;

        // Write to disk
        output_file.write_all(&plaintext)?;
        
        chunk_index += 1;
        processed_file_bytes += chunk_len as u64; 
        
        // Update UI every 5 chunks to reduce overhead
        if chunk_index % 5 == 0 {
            callback(processed_file_bytes, file_size);
        }
    }

    output_file.flush()?;
    Ok(final_filename) // Return the actual filename used
}