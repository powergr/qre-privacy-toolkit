// --- START OF FILE src-tauri/src/crypto_stream.rs ---

use crate::keychain::MasterKey;
use crate::timelock_clock;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use rand::{rngs::OsRng, RngCore, SeedableRng, TryRngCore};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use zeroize::{Zeroize, Zeroizing};

// ==========================================
// --- CONSTANTS ---
// ==========================================

const CHUNK_SIZE: usize = 1024 * 1024; // 1 MB
const AES_NONCE_LEN: usize = 12;
const FILE_KEY_LEN: usize = 32;
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

/// Fixed header region size for V7 files (bytes 4 – 4099, after the version u32).
/// Allows in-place ratchet rewrites without touching ciphertext chunks.
const HEADER_RESERVED_BYTES: usize = 4096;

const VERSION_V5: u32 = 5;
const VERSION_V6: u32 = 6;
const VERSION_V7: u32 = 7; // V7 adds ratchet + fixed header region

// ==========================================
// --- DATA STRUCTURES ---
// ==========================================

/// Time-lock metadata embedded in the StreamHeader (V6 and V7).
///
/// `locked_until`              — in plaintext; UI can show countdown without master key.
/// `encrypted_binding_key`     — requires master key; decrypted only after lock expires.
/// `ratchet_max_seen`          — highest Unix timestamp ever witnessed during an unlock
///                               attempt; starts at 0, updated in-place (V7 only).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TimeLockMeta {
    pub locked_until: u64,
    pub encrypted_binding_key: Vec<u8>,
    pub binding_key_nonce: Vec<u8>,
    pub ratchet_max_seen: u64,
}

/// Stream header — written unencrypted at the start of every .qre file.
/// Identical layout for V6 (variable-length) and V7 (fixed 4 KB region).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StreamHeader {
    pub vault_id: Option<String>,
    pub validation_nonce: Vec<u8>,
    pub encrypted_validation_tag: Vec<u8>,
    pub key_wrapping_nonce: Vec<u8>,
    pub encrypted_file_key: Vec<u8>,
    pub base_nonce: Vec<u8>,
    pub original_filename: String,
    pub original_hash: Option<Vec<u8>>,
    pub timelock: Option<TimeLockMeta>,
}

/// V5 header — no timelock field. For reading legacy files only.
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
// --- INTERNAL HELPERS ---
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
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn plural_s(n: u64) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

fn format_duration_secs(secs: u64) -> String {
    if secs >= 86400 {
        let d = secs / 86400;
        let h = (secs % 86400) / 3600;
        if h > 0 {
            format!("{} day{}, {} hour{}", d, plural_s(d), h, plural_s(h))
        } else {
            format!("{} day{}", d, plural_s(d))
        }
    } else if secs >= 3600 {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        if m > 0 {
            format!("{} hour{}, {} minute{}", h, plural_s(h), m, plural_s(m))
        } else {
            format!("{} hour{}", h, plural_s(h))
        }
    } else if secs >= 60 {
        let m = secs / 60;
        format!("{} minute{}", m, plural_s(m))
    } else {
        format!("{} second{}", secs, plural_s(secs))
    }
}

/// Rewrites only the fixed header region of a V7 .qre file in-place.
///
/// Touches bytes 4–4099 only. Ciphertext chunks are never touched.
/// Called after a failed time-lock check to persist the updated ratchet.
/// Errors are intentionally swallowed — a failed write degrades offline
/// protection but does not corrupt the file or block future decryption.
fn update_v7_header_in_place(qre_path: &str, updated_header: &StreamHeader) {
    let serialized = match bincode::serialize(updated_header) {
        Ok(b) => b,
        Err(_) => return,
    };
    if serialized.len() > HEADER_RESERVED_BYTES {
        return;
    }

    let mut file = match OpenOptions::new().write(true).open(qre_path) {
        Ok(f) => f,
        Err(_) => return,
    };

    if file.seek(SeekFrom::Start(4)).is_err() {
        return;
    } // skip 4-byte version

    let mut region = vec![0u8; HEADER_RESERVED_BYTES];
    region[..serialized.len()].copy_from_slice(&serialized);
    let _ = file.write_all(&region);
    let _ = file.flush();
}

// ==========================================
// --- PUBLIC UTILITY ---
// ==========================================

/// Reads only the file header to inspect time-lock status.
///
/// Does NOT require the master key — `locked_until` is stored in plaintext.
/// Returns `None` for V5 files or non-time-locked V6/V7 files.
pub fn read_timelock_header(path: &str) -> Result<Option<TimeLockMeta>> {
    let mut file = BufReader::new(File::open(path).context("Failed to open file")?);

    let mut ver_buf = [0u8; 4];
    file.read_exact(&mut ver_buf)
        .context("Failed to read version")?;
    let version = u32::from_le_bytes(ver_buf);

    match version {
        VERSION_V5 => Ok(None),
        VERSION_V6 => {
            let header: StreamHeader =
                bincode::deserialize_from(&mut file).context("Failed to read V6 header")?;
            Ok(header.timelock)
        }
        VERSION_V7 => {
            let mut region = vec![0u8; HEADER_RESERVED_BYTES];
            file.read_exact(&mut region)
                .context("Failed to read V7 header region")?;
            let header: StreamHeader =
                bincode::deserialize(&region).context("Failed to parse V7 header")?;
            Ok(header.timelock)
        }
        other => Err(anyhow!("Unsupported file version: {}", other)),
    }
}

// ==========================================
// --- STREAM ENCRYPTOR ---
// ==========================================

/// Encrypts a file of any size using AES-256-GCM in 1 MB streaming chunks.
///
/// # Version selection
///   `timelock_until: None`  → V6 file (variable-length header, no ratchet)
///   `timelock_until: Some`  → V7 file (fixed 4 KB header, ratchet field)
///
/// # Time-lock internals
///   A random `binding_key` is generated internally.
///   SHA-256(binding_key) becomes the effective keyfile for FEK wrapping.
///   The binding_key is AES-encrypted with the BASE wrapping key (master key only)
///   and stored in `TimeLockMeta`. `ratchet_max_seen` starts at 0.
///
/// # API note
///   `timelock_until` is the 6th argument (after `keyfile_bytes`).
///   All non-time-lock callers in files.rs must pass `None` here.
pub fn encrypt_file_stream(
    input_path: &str,
    output_path: &str,
    master_key: &MasterKey,
    vault_id: &str,
    keyfile_bytes: Option<&[u8]>,
    timelock_until: Option<u64>,
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32,
    callback: impl Fn(u64, u64),
) -> Result<()> {
    let total_size = fs::metadata(input_path)
        .context("Failed to read input metadata")?
        .len();

    let original_filename = std::path::Path::new(input_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Pre-hash entire plaintext for truncation-attack defense
    let original_hash = {
        let mut reader =
            BufReader::new(File::open(input_path).context("Failed to open input for pre-hash")?);
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        hasher.finalize().to_vec()
    };

    let mut input_file = BufReader::new(File::open(input_path)?);
    let mut output_file = BufWriter::new(File::create(output_path)?);

    let version: u32 = if timelock_until.is_some() {
        VERSION_V7
    } else {
        VERSION_V6
    };
    output_file.write_all(&version.to_le_bytes())?;

    // Entropy mixing (Paranoid Mode)
    let mut combined_seed = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut combined_seed)
        .expect("OS RNG failed");
    if let Some(user_seed) = entropy_seed {
        for i in 0..32 {
            combined_seed[i] ^= user_seed[i];
        }
    }
    let mut rng = ChaCha20Rng::from_seed(combined_seed);

    // Generate File Encryption Key (FEK)
    let mut file_key = Zeroizing::new([0u8; FILE_KEY_LEN]);
    rng.fill_bytes(&mut *file_key);
    let cipher_file = Aes256Gcm::new_from_slice(&*file_key).map_err(|e| anyhow!(e))?;

    // ── TIME-LOCK KEY SETUP ───────────────────────────────────────────────────
    // For time-locked files two wrapping keys are needed:
    //   base_wrapping_key = H(master || "NO_KEYFILE")
    //     → encrypts binding_key for storage in the header
    //   file_wrapping_key = H(master || "KEYFILE_MIX" || SHA-256(binding_key))
    //     → encrypts the validation tag and wraps the FEK
    // For normal files only file_wrapping_key is used with caller's keyfile_bytes.
    let (timelock_meta, effective_keyfile_owned): (Option<TimeLockMeta>, Option<Vec<u8>>) =
        if let Some(locked_until) = timelock_until {
            let mut binding_key = Zeroizing::new([0u8; 32]);
            rng.fill_bytes(&mut *binding_key);

            let binding_key_hash: Vec<u8> = Sha256::digest(&*binding_key).to_vec();

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
                ratchet_max_seen: 0, // updated in-place on each failed unlock
            };
            (Some(meta), Some(binding_key_hash))
            // binding_key drops + zeroizes here
        } else {
            (None, None)
        };

    let effective_keyfile: Option<&[u8]> = effective_keyfile_owned.as_deref().or(keyfile_bytes);

    let wrapping_key = derive_wrapping_key(master_key, effective_keyfile);
    let cipher_wrap = Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    let mut val_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut val_nonce);
    let encrypted_validation = cipher_wrap
        .encrypt(Nonce::from_slice(&val_nonce), VALIDATION_MAGIC)
        .map_err(|e| anyhow!("Validation encrypt: {}", e))?;

    let mut key_wrap_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut key_wrap_nonce);
    let encrypted_file_key = cipher_wrap
        .encrypt(Nonce::from_slice(&key_wrap_nonce), file_key.as_ref())
        .map_err(|e| anyhow!("File key wrap: {}", e))?;

    let mut base_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut base_nonce);

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

    // Write header — V7 uses fixed padded region; V6 uses variable length
    if version == VERSION_V7 {
        let serialized = bincode::serialize(&header).context("Failed to serialize V7 header")?;

        if serialized.len() > HEADER_RESERVED_BYTES {
            return Err(anyhow!(
                "V7 header ({} bytes) exceeds HEADER_RESERVED_BYTES ({}).",
                serialized.len(),
                HEADER_RESERVED_BYTES
            ));
        }

        let mut region = vec![0u8; HEADER_RESERVED_BYTES];
        region[..serialized.len()].copy_from_slice(&serialized);
        output_file.write_all(&region)?;
    } else {
        bincode::serialize_into(&mut output_file, &header)
            .context("Failed to serialize V6 header")?;
    }

    // ── STREAMING ENCRYPTION LOOP ─────────────────────────────────────────────
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut chunk_index: u64 = 0;
    let mut processed_bytes: u64 = 0;

    loop {
        let n = input_file.read(&mut buffer)?;
        if n == 0 {
            break;
        }

        let compressed = compress_chunk(&buffer[..n], compression_level)?;

        let mut chunk_nonce = base_nonce;
        let idx_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce[4 + i] ^= idx_bytes[i];
        }

        let aad = format!("{}:{}", original_filename, chunk_index);
        let payload = Payload {
            msg: &compressed,
            aad: aad.as_bytes(),
        };

        let ciphertext = cipher_file
            .encrypt(Nonce::from_slice(&chunk_nonce), payload)
            .map_err(|_| anyhow!("Chunk {} encryption failed", chunk_index))?;

        output_file.write_all(&(ciphertext.len() as u32).to_le_bytes())?;
        output_file.write_all(&ciphertext)?;

        processed_bytes += n as u64;
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

/// Decrypts a V5, V6, or V7 `.qre` file back to disk.
///
/// # Time-lock enforcement
/// Returns `Err("TIME_LOCKED:<unix_ts>:<human msg>")` when locked.
///
/// # Clock verification
/// V7: NTP (online) + ratchet (offline) — full two-layer protection.
/// V6: NTP (online) + system clock (offline) — no ratchet possible.
/// V5: no time-lock.
///
/// # Ratchet update (V7 only)
/// On every failed unlock attempt the highest witnessed timestamp is written
/// back into the file header in-place. This prevents offline clock rewinds
/// from bypassing a lock that was previously accessed while online.
pub fn decrypt_file_stream(
    input_path: &str,
    output_dir: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    callback: impl Fn(u64, u64),
) -> Result<String> {
    let file_size = fs::metadata(input_path)?.len();
    let mut input_file = BufReader::new(File::open(input_path)?);

    let mut ver_buf = [0u8; 4];
    input_file.read_exact(&mut ver_buf)?;
    let version = u32::from_le_bytes(ver_buf);

    // ── HEADER DESERIALIZATION ────────────────────────────────────────────────
    let header: StreamHeader = match version {
        VERSION_V5 => {
            let v5: StreamHeaderV5 =
                bincode::deserialize_from(&mut input_file).context("Failed to parse V5 header")?;
            v5.into()
        }
        VERSION_V6 => {
            bincode::deserialize_from(&mut input_file).context("Failed to parse V6 header")?
        }
        VERSION_V7 => {
            // Read the full fixed region; bincode::deserialize ignores zero padding,
            // leaving input_file positioned at HEADER_RESERVED_BYTES + 4.
            let mut region = vec![0u8; HEADER_RESERVED_BYTES];
            input_file
                .read_exact(&mut region)
                .context("Failed to read V7 header region")?;
            bincode::deserialize::<StreamHeader>(&region).context("Failed to parse V7 header")?
        }
        other => return Err(anyhow!("Unsupported file version: {}", other)),
    };

    // ── TIME-LOCK CHECK ──────────────────────────────────────────────────────
    // Runs BEFORE key derivation — never reveals password correctness while locked.
    let effective_keyfile: Option<Vec<u8>> = if let Some(ref tl) = header.timelock {
        // Get the authoritative current time:
        //   V7 → NTP (online) or max(system_clock, ratchet) (offline)
        //   V6 → NTP (online) or system_clock (offline) — no ratchet available
        let authoritative_time = if version == VERSION_V7 {
            timelock_clock::get_authoritative_time(tl.ratchet_max_seen)
        } else {
            match timelock_clock::get_ntp_time() {
                Ok(ntp) => ntp.max(tl.ratchet_max_seen),
                Err(_) => timelock_clock::system_time_secs().max(tl.ratchet_max_seen),
            }
        };

        if authoritative_time < tl.locked_until {
            // ── RATCHET UPDATE ────────────────────────────────────────────────
            // Persist the highest witnessed time back into the V7 header.
            // On the next attempt — even offline with a rewound clock — the
            // ratchet value will be read from the file and override the clock.
            if version == VERSION_V7 {
                let new_ratchet = tl.ratchet_max_seen.max(authoritative_time);
                if new_ratchet > tl.ratchet_max_seen {
                    let mut updated = header.clone();
                    if let Some(ref mut utl) = updated.timelock {
                        utl.ratchet_max_seen = new_ratchet;
                    }
                    update_v7_header_in_place(input_path, &updated);
                }
            }

            let remaining = tl.locked_until.saturating_sub(authoritative_time);
            return Err(anyhow!(
                "TIME_LOCKED:{}:This file is time-locked for {}.",
                tl.locked_until,
                format_duration_secs(remaining)
            ));
        }

        // Lock expired — decrypt the binding key with the BASE wrapping key
        let base_wrapping_key = derive_wrapping_key(master_key, None);
        let cipher_base = Aes256Gcm::new_from_slice(&*base_wrapping_key).map_err(|e| anyhow!(e))?;

        let binding_key_vec = cipher_base
            .decrypt(
                Nonce::from_slice(&tl.binding_key_nonce),
                tl.encrypted_binding_key.as_ref(),
            )
            .map_err(|_| anyhow!("Failed to decrypt binding key. Wrong master password?"))?;

        let binding_key_hash = Sha256::digest(&binding_key_vec).to_vec();
        Some(binding_key_hash)
    } else {
        keyfile_bytes.map(|b| b.to_vec())
    };

    // ── VALIDATION AND KEY UNWRAP ─────────────────────────────────────────────
    let effective_keyfile_ref: Option<&[u8]> = effective_keyfile.as_deref();
    let wrapping_key = derive_wrapping_key(master_key, effective_keyfile_ref);
    let cipher_wrap = Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    match cipher_wrap.decrypt(
        Nonce::from_slice(&header.validation_nonce),
        header.encrypted_validation_tag.as_ref(),
    ) {
        Ok(bytes) if constant_time_eq(&bytes, VALIDATION_MAGIC) => {}
        _ => {
            return Err(anyhow!(
                "Decryption Denied. Password or Keyfile is incorrect."
            ))
        }
    }

    let file_key_vec = cipher_wrap
        .decrypt(
            Nonce::from_slice(&header.key_wrapping_nonce),
            header.encrypted_file_key.as_ref(),
        )
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;

    let file_key = Zeroizing::new(file_key_vec);
    let cipher_file =
        Aes256Gcm::new_from_slice(&file_key).map_err(|_| anyhow!("Invalid file key"))?;

    // ── OUTPUT FILE ───────────────────────────────────────────────────────────
    let raw_out = std::path::Path::new(output_dir).join(&header.original_filename);
    let final_out = crate::utils::get_unique_path(&raw_out);
    let final_filename = final_out
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut output_file = BufWriter::new(File::create(&final_out)?);
    let mut output_hasher = Sha256::new();

    // ── DECRYPTION LOOP ───────────────────────────────────────────────────────
    let mut chunk_index: u64 = 0;
    let mut size_buf = [0u8; 4];
    let mut processed: u64 = 0;

    loop {
        match input_file.read_exact(&mut size_buf) {
            Ok(_) => {}
            Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(anyhow!("Read error at chunk {}: {}", chunk_index, e)),
        }

        let chunk_len = u32::from_le_bytes(size_buf) as usize;
        if chunk_len > CHUNK_SIZE + 4096 {
            return Err(anyhow!(
                "Chunk {} size anomaly ({} bytes) — file may be corrupt.",
                chunk_index,
                chunk_len
            ));
        }

        let mut ciphertext = vec![0u8; chunk_len];
        input_file.read_exact(&mut ciphertext)?;

        let mut chunk_nonce = [0u8; AES_NONCE_LEN];
        chunk_nonce.copy_from_slice(&header.base_nonce);
        let idx_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce[4 + i] ^= idx_bytes[i];
        }

        let aad = format!("{}:{}", header.original_filename, chunk_index);
        let payload = Payload {
            msg: &ciphertext,
            aad: aad.as_bytes(),
        };

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
    if let Some(expected) = &header.original_hash {
        let actual = output_hasher.finalize().to_vec();
        if !constant_time_eq(&actual, expected) {
            let _ = fs::remove_file(&final_out);
            return Err(anyhow!(
                "INTEGRITY ERROR: File hash mismatch. Output removed. \
                 The encrypted file may be truncated or corrupt."
            ));
        }
    }

    Ok(final_filename)
}

// --- END OF FILE src-tauri/src/crypto_stream.rs ---
