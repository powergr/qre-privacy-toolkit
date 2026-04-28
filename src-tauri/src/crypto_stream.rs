// --- START OF FILE crypto_stream.rs ---

use crate::keychain::MasterKey;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use rand::{rngs::OsRng, RngCore, SeedableRng, TryRngCore};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use zeroize::{Zeroize, Zeroizing};

// ==========================================
// --- CONSTANTS ---
// ==========================================

const CHUNK_SIZE: usize = 1024 * 1024;
const AES_NONCE_LEN: usize = 12;
const FILE_KEY_LEN: usize = 32;
const CURRENT_VERSION: u32 = 6; // V6 adds embedded time-lock metadata
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

// ==========================================
// --- HEADER STRUCTURES ---
// ==========================================

/// Time-lock metadata embedded in the V6 StreamHeader.
///
/// SECURITY DESIGN:
///   `locked_until` is stored in plaintext intentionally — it lets the app
///   check the timestamp and display a countdown without the master key.
///
///   `encrypted_binding_key` is AES-256-GCM encrypted with the BASE wrapping
///   key (master key, no keyfile). An attacker without the master password
///   cannot extract the binding key and decrypt the file early.
///
///   SHA-256(binding_key) was used as the keyfile when wrapping the file key,
///   so decrypting the file also requires the binding key.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TimeLockMeta {
    /// Unix timestamp (seconds UTC). Decryption refused before this.
    pub locked_until: u64,
    /// binding_key encrypted with derive_wrapping_key(master_key, None).
    pub encrypted_binding_key: Vec<u8>,
    /// AES-GCM nonce used when encrypting the binding key.
    pub binding_key_nonce: Vec<u8>,
}

/// V6 stream header — serialized unencrypted at the start of every .qre file.
#[derive(Serialize, Deserialize, Debug)]
pub struct StreamHeader {
    pub vault_id: Option<String>,
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,
    pub key_wrapping_nonce: Vec<u8>,
    pub encrypted_file_key: Vec<u8>,
    pub base_nonce: Vec<u8>,
    pub original_filename: String,
    pub original_hash: Option<Vec<u8>>,
    /// None  → not time-locked.
    /// Some  → time-locked; contains the encrypted binding key + expiry.
    pub timelock: Option<TimeLockMeta>,
}

/// V5 header — no timelock field. Used only for reading legacy files.
#[derive(Serialize, Deserialize, Debug)]
struct StreamHeaderV5 {
    pub vault_id: Option<String>,
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,
    pub key_wrapping_nonce: Vec<u8>,
    pub encrypted_file_key: Vec<u8>,
    pub base_nonce: Vec<u8>,
    pub original_filename: String,
    pub original_hash: Option<Vec<u8>>,
}

impl From<StreamHeaderV5> for StreamHeader {
    fn from(v5: StreamHeaderV5) -> Self {
        Self {
            vault_id: v5.vault_id,
            validation_nonce: v5.validation_nonce,
            encrypted_validation_tag: v5.encrypted_validation_tag,
            key_wrapping_nonce: v5.key_wrapping_nonce,
            encrypted_file_key: v5.encrypted_file_key,
            base_nonce: v5.base_nonce,
            original_filename: v5.original_filename,
            original_hash: v5.original_hash,
            timelock: None,
        }
    }
}

// ==========================================
// --- HELPERS ---
// ==========================================

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

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    let mut result = 0u8;
    for (x, y) in a.iter().zip(b.iter()) { result |= x ^ y; }
    result == 0
}

fn plural_s(n: u64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// Formats seconds into a human-readable duration string.
/// Defined here to avoid a circular dependency with timelock.rs.
fn format_duration_secs(seconds: u64) -> String {
    if seconds >= 86400 {
        let d = seconds / 86400;
        let h = (seconds % 86400) / 3600;
        if h > 0 { format!("{} day{}, {} hour{}", d, plural_s(d), h, plural_s(h)) }
        else      { format!("{} day{}", d, plural_s(d)) }
    } else if seconds >= 3600 {
        let h = seconds / 3600;
        let m = (seconds % 3600) / 60;
        if m > 0 { format!("{} hour{}, {} minute{}", h, plural_s(h), m, plural_s(m)) }
        else      { format!("{} hour{}", h, plural_s(h)) }
    } else if seconds >= 60 {
        let m = seconds / 60;
        format!("{} minute{}", m, plural_s(m))
    } else {
        format!("{} second{}", seconds, plural_s(seconds))
    }
}

// ==========================================
// --- PUBLIC UTILITY ---
// ==========================================

/// Reads ONLY the file header to inspect time-lock status.
///
/// Does NOT require the master key — `locked_until` is in plaintext.
/// Returns `None` for V5 files (no time-lock) or non-time-locked V6 files.
pub fn read_timelock_header(path: &str) -> Result<Option<TimeLockMeta>> {
    let mut file = BufReader::new(File::open(path).context("Failed to open file")?);

    let mut ver_buf = [0u8; 4];
    file.read_exact(&mut ver_buf).context("Failed to read version")?;
    let version = u32::from_le_bytes(ver_buf);

    match version {
        5 => Ok(None),
        6 => {
            let header: StreamHeader =
                bincode::deserialize_from(&mut file).context("Failed to read V6 header")?;
            Ok(header.timelock)
        }
        other => Err(anyhow!("Unsupported file version: {}", other)),
    }
}

// ==========================================
// --- STREAM ENCRYPTOR ---
// ==========================================

/// Encrypts a file of any size by streaming it in 1MB chunks.
///
/// # Time-lock (`timelock_until`)
/// When `Some(unix_ts)` is provided:
///   - A random `binding_key` is generated internally.
///   - SHA-256(binding_key) becomes the effective keyfile for file key wrapping.
///   - The binding key is stored encrypted (master key only) in the header.
///   - Pass `keyfile_bytes: None` when using time-lock.
///
/// # API change from V5
/// `timelock_until: Option<u64>` is inserted after `keyfile_bytes`.
/// All existing callers in `files.rs` must pass `None` for this argument.
pub fn encrypt_file_stream(
    input_path: &str,
    output_path: &str,
    master_key: &MasterKey,
    vault_id: &str,
    keyfile_bytes: Option<&[u8]>,
    timelock_until: Option<u64>, // NEW in V6
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32,
    callback: impl Fn(u64, u64),
) -> Result<()> {
    let total_size = std::fs::metadata(input_path)?.len();
    let original_filename = std::path::Path::new(input_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Pre-hash entire plaintext for truncation-attack defense
    let original_hash = {
        let mut pre_reader = BufReader::new(
            File::open(input_path).context("Failed to open input for pre-hash")?,
        );
        let mut hasher = Sha256::new();
        let mut hash_buf = vec![0u8; CHUNK_SIZE];
        loop {
            let n = pre_reader.read(&mut hash_buf)?;
            if n == 0 { break; }
            hasher.update(&hash_buf[..n]);
        }
        hasher.finalize().to_vec()
    };

    let mut input_file = BufReader::new(File::open(input_path)?);
    let mut output_file = BufWriter::new(File::create(output_path)?);

    // Write version marker
    output_file.write_all(&CURRENT_VERSION.to_le_bytes())?;

    // Entropy mixing (Paranoid Mode)
    let mut combined_seed = [0u8; 32];
    OsRng.try_fill_bytes(&mut combined_seed).expect("OS RNG failed");
    if let Some(user_seed) = entropy_seed {
        for i in 0..32 { combined_seed[i] ^= user_seed[i]; }
    }
    let mut rng = ChaCha20Rng::from_seed(combined_seed);

    // Generate File Encryption Key (FEK)
    let mut file_key = Zeroizing::new([0u8; FILE_KEY_LEN]);
    rng.fill_bytes(&mut *file_key);
    let cipher_file = Aes256Gcm::new_from_slice(&*file_key).map_err(|e| anyhow!(e))?;

    // ── TIME-LOCK SETUP ──────────────────────────────────────────────────────
    //
    // For time-locked files we need TWO wrapping keys:
    //
    //   base_wrapping_key  = SHA-256(master_key || "NO_KEYFILE")
    //     → encrypts the binding_key for storage in the header
    //
    //   file_wrapping_key  = SHA-256(master_key || "KEYFILE_MIX" || SHA-256(binding_key))
    //     → encrypts the validation tag and the FEK
    //
    // For normal files only file_wrapping_key is used (with caller keyfile_bytes).
    // ────────────────────────────────────────────────────────────────────────
    let (timelock_meta, effective_keyfile_owned): (Option<TimeLockMeta>, Option<Vec<u8>>) =
        if let Some(locked_until) = timelock_until {
            let mut binding_key = Zeroizing::new([0u8; 32]);
            rng.fill_bytes(&mut *binding_key);

            // SHA-256(binding_key) becomes the effective keyfile
            let binding_key_hash: Vec<u8> = Sha256::digest(&*binding_key).to_vec();

            // Encrypt binding_key with the BASE wrapping key (no keyfile)
            let base_wrapping_key = derive_wrapping_key(master_key, None);
            let cipher_base =
                Aes256Gcm::new_from_slice(&*base_wrapping_key).map_err(|e| anyhow!(e))?;

            let mut bk_nonce = [0u8; AES_NONCE_LEN];
            rng.fill_bytes(&mut bk_nonce);

            let encrypted_binding_key = cipher_base
                .encrypt(Nonce::from_slice(&bk_nonce), binding_key.as_ref())
                .map_err(|_| anyhow!("Failed to encrypt binding key"))?;

            let meta = TimeLockMeta {
                locked_until,
                encrypted_binding_key,
                binding_key_nonce: bk_nonce.to_vec(),
            };

            (Some(meta), Some(binding_key_hash))
        } else {
            (None, None)
        };

    // Resolve effective keyfile: time-lock hash takes priority over caller keyfile
    let effective_keyfile: Option<&[u8]> =
        effective_keyfile_owned.as_deref().or(keyfile_bytes);

    // Derive file wrapping key
    let wrapping_key = derive_wrapping_key(master_key, effective_keyfile);
    let cipher_wrap = Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    // Validation tag
    let mut val_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut val_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&val_nonce), VALIDATION_MAGIC)
        .map_err(|e| anyhow!("Validation encrypt failed: {}", e))?;

    // Wrap FEK
    let mut key_wrap_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut key_wrap_nonce);
    let encrypted_file_key = cipher_wrap
        .encrypt(Nonce::from_slice(&key_wrap_nonce), file_key.as_ref())
        .map_err(|e| anyhow!("File key wrap failed: {}", e))?;

    // Base nonce for chunk rolling
    let mut base_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut base_nonce);

    // Build and write V6 header
    let header = StreamHeader {
        vault_id: Some(vault_id.to_string()),
        validation_nonce: val_nonce.to_vec(),
        encrypted_validation_tag: encrypted_validation,
        key_wrapping_nonce: key_wrap_nonce.to_vec(),
        encrypted_file_key,
        base_nonce: base_nonce.to_vec(),
        original_filename: original_filename.clone(),
        original_hash: Some(original_hash),
        timelock: timelock_meta,
    };

    bincode::serialize_into(&mut output_file, &header)?;

    // ── STREAMING ENCRYPTION LOOP ─────────────────────────────────────────────
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut chunk_index: u64 = 0;
    let mut processed_bytes: u64 = 0;

    loop {
        let bytes_read = input_file.read(&mut buffer)?;
        if bytes_read == 0 { break; }

        let compressed = compress_chunk(&buffer[..bytes_read], compression_level)?;

        // Rolling nonce: XOR chunk index into last 8 bytes of base_nonce
        let mut chunk_nonce = base_nonce;
        let index_bytes = chunk_index.to_le_bytes();
        for i in 0..8 { chunk_nonce[4 + i] ^= index_bytes[i]; }

        // AAD: binds ciphertext to exact filename + position (block reordering defense)
        let aad_tag = format!("{}:{}", original_filename, chunk_index);
        let payload = Payload { msg: &compressed, aad: aad_tag.as_bytes() };

        let ciphertext = cipher_file
            .encrypt(Nonce::from_slice(&chunk_nonce), payload)
            .map_err(|_| anyhow!("Chunk encryption failed"))?;

        let size = (ciphertext.len() as u32).to_le_bytes();
        output_file.write_all(&size)?;
        output_file.write_all(&ciphertext)?;

        processed_bytes += bytes_read as u64;
        chunk_index += 1;
        callback(processed_bytes, total_size);
    }

    output_file.flush()?;
    combined_seed.zeroize();
    Ok(())
}

// ==========================================
// --- STREAM DECRYPTOR ---
// ==========================================

/// Decrypts a V5 or V6 `.qre` file back to disk.
///
/// # Time-lock errors
/// Returns `Err` prefixed `"TIME_LOCKED:<unix_ts>:<human msg>"` when the
/// lock has not yet expired. The command layer surfaces this to the frontend.
///
/// # keyfile_bytes for time-locked files
/// Ignored — the binding key in the header IS the keyfile. Pass `None`.
pub fn decrypt_file_stream(
    input_path: &str,
    output_dir: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    callback: impl Fn(u64, u64),
) -> Result<String> {
    let mut input_file = BufReader::new(File::open(input_path)?);
    let file_size = std::fs::metadata(input_path)?.len();

    // Read version
    let mut ver_buf = [0u8; 4];
    input_file.read_exact(&mut ver_buf)?;
    let version = u32::from_le_bytes(ver_buf);

    // Deserialize header — V5 and V6 use different structs (bincode is strict)
    let header: StreamHeader = match version {
        5 => {
            let v5: StreamHeaderV5 = bincode::deserialize_from(&mut input_file)
                .context("Failed to parse V5 header")?;
            v5.into()
        }
        6 => bincode::deserialize_from(&mut input_file)
            .context("Failed to parse V6 header")?,
        other => return Err(anyhow!("Unsupported file version: {}", other)),
    };

    // ── TIME-LOCK CHECK ──────────────────────────────────────────────────────
    // Happens BEFORE any key derivation — we never reveal whether the password
    // is correct until after the lock has expired.
    let effective_keyfile: Option<Vec<u8>> = if let Some(ref tl) = header.timelock {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        if now < tl.locked_until {
            let remaining = tl.locked_until.saturating_sub(now);
            return Err(anyhow!(
                "TIME_LOCKED:{}:This file is time-locked for {}.",
                tl.locked_until,
                format_duration_secs(remaining)
            ));
        }

        // Lock expired — decrypt the binding key with the base wrapping key
        let base_wrapping_key = derive_wrapping_key(master_key, None);
        let cipher_base =
            Aes256Gcm::new_from_slice(&*base_wrapping_key).map_err(|e| anyhow!(e))?;

        let binding_key_vec = cipher_base
            .decrypt(
                Nonce::from_slice(&tl.binding_key_nonce),
                tl.encrypted_binding_key.as_ref(),
            )
            .map_err(|_| anyhow!("Failed to decrypt binding key. Wrong master password?"))?;

        // SHA-256(binding_key) is the effective keyfile for file key unwrapping
        let binding_key_hash = Sha256::digest(&binding_key_vec).to_vec();
        Some(binding_key_hash)
        // binding_key_vec drops and is freed here
    } else {
        keyfile_bytes.map(|b| b.to_vec())
    };
    // ────────────────────────────────────────────────────────────────────────

    let effective_keyfile_ref: Option<&[u8]> = effective_keyfile.as_deref();
    let wrapping_key = derive_wrapping_key(master_key, effective_keyfile_ref);
    let cipher_wrap =
        Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    // Validate password / keyfile
    let val_nonce = Nonce::from_slice(&header.validation_nonce);
    match cipher_wrap.decrypt(val_nonce, header.encrypted_validation_tag.as_ref()) {
        Ok(bytes) => {
            if !constant_time_eq(&bytes, VALIDATION_MAGIC) {
                return Err(anyhow!("Decryption Denied. Password or Keyfile is incorrect."));
            }
        }
        Err(_) => return Err(anyhow!("Decryption Denied. Password or Keyfile is incorrect.")),
    }

    // Unwrap FEK
    let file_key_vec = cipher_wrap
        .decrypt(
            Nonce::from_slice(&header.key_wrapping_nonce),
            header.encrypted_file_key.as_ref(),
        )
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;

    let file_key = Zeroizing::new(file_key_vec);
    let cipher_file =
        Aes256Gcm::new_from_slice(&file_key).map_err(|_| anyhow!("Invalid file key length"))?;

    // Prepare output file
    let output_filename = header.original_filename.clone();
    let raw_output_path = std::path::Path::new(output_dir).join(&output_filename);
    let final_output_path = crate::utils::get_unique_path(&raw_output_path);
    let final_filename = final_output_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut output_file = BufWriter::new(File::create(&final_output_path)?);
    let mut output_hasher = Sha256::new();

    // ── DECRYPTION LOOP ───────────────────────────────────────────────────────
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
            return Err(anyhow!("Chunk size anomaly — file may be corrupt."));
        }

        let mut ciphertext = vec![0u8; chunk_len];
        input_file.read_exact(&mut ciphertext)?;

        let mut chunk_nonce = [0u8; AES_NONCE_LEN];
        chunk_nonce.copy_from_slice(&header.base_nonce);
        let index_bytes = chunk_index.to_le_bytes();
        for i in 0..8 { chunk_nonce[4 + i] ^= index_bytes[i]; }

        let aad_tag = format!("{}:{}", header.original_filename, chunk_index);
        let payload = Payload { msg: &ciphertext, aad: aad_tag.as_bytes() };

        let compressed = cipher_file
            .decrypt(Nonce::from_slice(&chunk_nonce), payload)
            .map_err(|_| anyhow!("Chunk {} integrity check failed", chunk_index))?;

        let plaintext = decompress_chunk(&compressed)?;
        output_hasher.update(&plaintext);
        output_file.write_all(&plaintext)?;

        processed += chunk_len as u64;
        chunk_index += 1;
        if chunk_index.is_multiple_of(5) {
            callback(processed, file_size);
        }
    }

    output_file.flush()?;

    // Whole-file integrity check (truncation attack defense)
    if let Some(expected_hash) = &header.original_hash {
        let actual_hash = output_hasher.finalize().to_vec();
        if !constant_time_eq(&actual_hash, expected_hash) {
            let _ = fs::remove_file(&final_output_path);
            return Err(anyhow!(
                "INTEGRITY ERROR: File hash mismatch. Output removed. \
                 The encrypted file may be truncated or corrupt."
            ));
        }
    }

    Ok(final_filename)
}

// --- END OF FILE crypto_stream.rs ---