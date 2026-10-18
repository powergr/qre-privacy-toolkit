// --- START OF FILE src-tauri/src/crypto_stream.rs ---

use crate::keychain::MasterKey;
use crate::timelock_clock;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use rand::{rngs::SysRng, Rng, SeedableRng, TryRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

// ==========================================
// --- CONSTANTS ---
// ==========================================

pub(crate) const CHUNK_SIZE: usize = 1024 * 1024; // 1 MB
const AES_NONCE_LEN: usize = 12;
const FILE_KEY_LEN: usize = 32;
const VALIDATION_MAGIC: &[u8] = b"QRE_VALID";

/// Fixed header region size for V7 files (bytes 4 – 4099, after the version u32).
/// Allows in-place ratchet rewrites without touching ciphertext chunks.
const HEADER_RESERVED_BYTES: usize = 4096;

const VERSION_V5: u32 = 5;
const VERSION_V6: u32 = 6;
const VERSION_V7: u32 = 7; // V7 adds ratchet + fixed header region
const VERSION_V8: u32 = 8; // V8 hides the file name and hash and authenticates the header

/// A V8 file is never changed after it is written: there is no ratchet and nothing is rewritten
/// when an unlock is refused.
///
/// A V8 header is a few hundred bytes. Anything near this size is damage, not a header.
const V8_MAX_HEADER_BYTES: usize = 64 * 1024;

/// Which file format new files are written in.
///
/// The app writes V8 for every new file. An older app cannot open a V8 file, which is accepted.
/// Files in V5 to V7 are still read. `Classic` can still be written on request, and is used by
/// the tests that cover reading the older formats.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileFormat {
    /// V6 for normal files, V7 for time-locked files.
    #[allow(dead_code)] // only built by the tests
    Classic,
    /// V8 for every file.
    V8,
}

pub const DEFAULT_WRITE_FORMAT: FileFormat = FileFormat::V8;

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

/// The time-lock part of a V8 header.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct SealedTimeLock {
    pub(crate) locked_until: u64,
    pub(crate) encrypted_binding_key: Vec<u8>,
    pub(crate) binding_key_nonce: Vec<u8>,
}

/// V8 header. Only `vault_id` and the time-lock date are readable without the key; the file
/// name and the plaintext hash are inside `encrypted_meta`. Every field is bound to the others
/// through `header_binding`, so changing any of them makes the file refuse to open.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct StreamHeaderV8 {
    pub(crate) vault_id: Option<String>,
    pub(crate) validation_nonce: Vec<u8>,
    pub(crate) encrypted_validation_tag: Vec<u8>,
    pub(crate) key_wrapping_nonce: Vec<u8>,
    pub(crate) encrypted_file_key: Vec<u8>,
    pub(crate) base_nonce: Vec<u8>,
    pub(crate) meta_nonce: Vec<u8>,
    pub(crate) encrypted_meta: Vec<u8>,
    pub(crate) timelock: Option<SealedTimeLock>,
}

/// What V8 keeps secret: the original file name and the SHA-256 of the plaintext.
#[derive(Serialize, Deserialize)]
struct SecretMeta {
    original_filename: String,
    original_hash: Vec<u8>,
}

impl SealedTimeLock {
    /// The same record in the shape older code expects. V8 has no ratchet, so it is 0.
    fn as_meta(&self) -> TimeLockMeta {
        TimeLockMeta {
            locked_until: self.locked_until,
            encrypted_binding_key: self.encrypted_binding_key.clone(),
            binding_key_nonce: self.binding_key_nonce.clone(),
            ratchet_max_seen: 0,
        }
    }
}

// ==========================================
// --- INTERNAL HELPERS ---
// ==========================================

/// What each chunk is bound to, besides its position. V5 to V7 bind a chunk to the file name.
/// V8 binds it to the whole header, so a chunk cannot be moved into another file.
enum ChunkAad {
    Name(String),
    Header([u8; 32]),
}

impl ChunkAad {
    fn for_chunk(&self, index: u64) -> Vec<u8> {
        match self {
            ChunkAad::Name(name) => format!("{}:{}", name, index).into_bytes(),
            ChunkAad::Header(digest) => {
                let mut aad = b"QRE-V8-CHUNK".to_vec();
                aad.extend_from_slice(digest);
                aad.extend_from_slice(&index.to_le_bytes());
                aad
            }
        }
    }
}

fn hash_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

/// A digest of the V8 header. It is used as the associated data of the wrapped file key, the
/// secret details and every chunk. Change a nonce, the vault id, the time-lock date or the
/// length of the header and the digest changes, so none of those can be opened any more. The
/// validation tag is deliberately not tied to it, so that a wrong key and a damaged header give
/// different errors.
///
/// It covers the version (8), the length of the header as stored, and every field in the order
/// the header stores them, except the three sealed fields (the validation tag, the wrapped file
/// key and the secret details), which authenticate themselves. Their lengths are part of the
/// stored length, so they are covered that way.
pub(crate) fn header_binding(h: &StreamHeaderV8) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"QRE-V8-HEADER");
    hasher.update(VERSION_V8.to_le_bytes());
    // `serialized_size` gives the same count as the length stored in the file, because the
    // header is written with `bincode::serialize` and read back with no bytes left over.
    let stored_len = bincode::serialized_size(h).unwrap_or(0) as u32;
    hasher.update(stored_len.to_le_bytes());
    match &h.vault_id {
        Some(id) => {
            hasher.update([1u8]);
            hash_field(&mut hasher, id.as_bytes());
        }
        None => hasher.update([0u8]),
    }
    hash_field(&mut hasher, &h.validation_nonce);
    hash_field(&mut hasher, &h.key_wrapping_nonce);
    hash_field(&mut hasher, &h.base_nonce);
    hash_field(&mut hasher, &h.meta_nonce);
    match &h.timelock {
        Some(tl) => {
            hasher.update([1u8]);
            hasher.update(tl.locked_until.to_le_bytes());
            hash_field(&mut hasher, &tl.encrypted_binding_key);
            hash_field(&mut hasher, &tl.binding_key_nonce);
        }
        None => hasher.update([0u8]),
    }
    hasher.finalize().into()
}

/// The associated data of the sealed binding key in a V8 file. It carries the date, so the date
/// cannot be changed without the master key: the binding key would no longer open.
fn binding_key_aad(locked_until: u64) -> Vec<u8> {
    let mut aad = b"QRE-V8-BINDING-KEY".to_vec();
    aad.extend_from_slice(&locked_until.to_le_bytes());
    aad
}

/// Reads a V8 header from just after the version: the length, then the header itself.
pub(crate) fn read_v8_header(reader: &mut impl Read) -> Result<StreamHeaderV8> {
    let mut len = [0u8; 4];
    reader
        .read_exact(&mut len)
        .context("Failed to read V8 header")?;
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > V8_MAX_HEADER_BYTES {
        return Err(anyhow!("Corrupt header: invalid header length"));
    }
    let mut bytes = vec![0u8; len];
    reader
        .read_exact(&mut bytes)
        .context("Failed to read V8 header")?;
    // The header must use every byte of its stated length. bincode::deserialize would ignore
    // extra bytes, which would let two different files open as the same file.
    use bincode::Options;
    let header: StreamHeaderV8 = bincode::options()
        .with_fixint_encoding()
        .reject_trailing_bytes()
        .deserialize(&bytes)
        .context("Failed to parse V8 header")?;
    Ok(header)
}

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

pub(crate) fn compress_chunk(data: &[u8], level: i32) -> Result<Vec<u8>> {
    let mut encoder = zstd::Encoder::new(Vec::new(), level)?;
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
}

/// Decompresses one chunk. A chunk is made from at most `CHUNK_SIZE` bytes of plaintext, so
/// anything that expands further is refused before it can fill the memory. The chunk is sealed,
/// so only someone holding the file key could make such a chunk, but the reader does not need to
/// trust the writer to stay within its own limit.
pub(crate) fn decompress_chunk(data: &[u8]) -> Result<Vec<u8>> {
    let decoder = zstd::Decoder::new(std::io::Cursor::new(data))?;
    let mut out = Vec::new();
    // One byte more than allowed, so an excess is noticed and not silently cut.
    decoder.take(CHUNK_SIZE as u64 + 1).read_to_end(&mut out)?;
    if out.len() > CHUNK_SIZE {
        return Err(anyhow!(
            "Chunk expands to more than {} bytes. The file is corrupt.",
            CHUNK_SIZE
        ));
    }
    Ok(out)
}

/// Characters that change the direction text is drawn in. In a file name they can make
/// "report<U+202E>cod.exe" appear as "reportexe.doc".
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// The name to give a decrypted file, taken from the file header.
///
/// In formats before V8 the header is stored in the clear and only partly authenticated, and in
/// every format the name is only as trustworthy as whoever made the file. A damaged or hand-made
/// file could carry "../x", an absolute path or a device name such as "CON". Only the last part
/// of the name is used, so the output always lands in the folder the user chose, and names the
/// operating system could not create, or would treat as something else, are refused.
///
/// Two things are changed instead of refused, so that a legitimate file still opens: characters
/// that reverse the direction of text become an underscore, and on Windows, where trailing dots
/// and spaces are silently dropped (so "CON " is the console), they are removed.
pub(crate) fn safe_output_name(raw: &str) -> Result<String> {
    let windows = cfg!(windows);
    let separators: &[char] = if windows { &['/', '\\'] } else { &['/'] };
    let last = raw
        .split(separators)
        .rfind(|part| !part.is_empty())
        .unwrap_or("");

    if last.is_empty() || last == "." || last == ".." {
        return Err(anyhow!("Corrupt header: invalid file name"));
    }

    let cleaned: String = last
        .chars()
        .map(|c| if is_bidi_control(c) { '_' } else { c })
        .collect();
    let name = if windows {
        cleaned.trim_end_matches([' ', '.'])
    } else {
        cleaned.as_str()
    };

    if name.is_empty() {
        return Err(anyhow!("Corrupt header: invalid file name"));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(anyhow!("Corrupt header: invalid file name"));
    }
    if windows {
        if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
            return Err(anyhow!("Corrupt header: invalid file name"));
        }
        // Opening one of these creates a connection to a device, not a file.
        // Spaces before the dot are ignored too: "AUX .txt" is the AUX device on Windows.
        let stem = name
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if reserved {
            return Err(anyhow!("Corrupt header: invalid file name"));
        }
    }
    Ok(name.to_string())
}

/// A name next to `final_path` for a file that is still being written: "<name>.part". The real
/// name is only given once the file is complete, so an interrupted run leaves a clearly
/// unfinished ".part" file and never something that looks like a finished one.
fn part_path(final_path: &Path) -> PathBuf {
    let base = format!("{}.part", final_path.to_string_lossy());
    crate::utils::get_unique_path(Path::new(&base))
}

/// Reads the 4 byte length that starts each chunk. `None` means the file ended exactly between
/// two chunks. A file that ends inside the 4 bytes is cut off, which is an error, not an end.
fn read_chunk_len(reader: &mut impl Read, chunk_index: u64) -> Result<Option<u32>> {
    let mut buf = [0u8; 4];
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => {
                return Err(anyhow!(
                    "Chunk {} is incomplete: the file is truncated.",
                    chunk_index
                ))
            }
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(anyhow!("Read error at chunk {}: {}", chunk_index, e)),
        }
    }
    Ok(Some(u32::from_le_bytes(buf)))
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
        VERSION_V8 => {
            // The date shown here is not yet authenticated: that needs the master key. Opening
            // the file does check it (see `open_stream_v8`), so a changed date shows a wrong
            // countdown at worst and never opens the file early. V8 has no ratchet.
            let header = read_v8_header(&mut file)?;
            Ok(header.timelock.map(|tl| tl.as_meta()))
        }
        other => Err(anyhow!("Unsupported file version: {}", other)),
    }
}

/// The vault a locked file belongs to, read from its header without any key. `None` when the
/// file is not a stream file or its header cannot be read.
pub fn read_vault_id(path: &str) -> Option<String> {
    let mut file = BufReader::new(File::open(path).ok()?);
    let mut ver_buf = [0u8; 4];
    file.read_exact(&mut ver_buf).ok()?;
    match u32::from_le_bytes(ver_buf) {
        VERSION_V5 => {
            let header: StreamHeaderV5 = bincode::deserialize_from(&mut file).ok()?;
            header.vault_id
        }
        VERSION_V6 => {
            let header: StreamHeader = bincode::deserialize_from(&mut file).ok()?;
            header.vault_id
        }
        VERSION_V7 => {
            let mut region = vec![0u8; HEADER_RESERVED_BYTES];
            file.read_exact(&mut region).ok()?;
            let header: StreamHeader = bincode::deserialize(&region).ok()?;
            header.vault_id
        }
        VERSION_V8 => read_v8_header(&mut file).ok()?.vault_id,
        _ => None,
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
// Bundling these into a params struct would ripple across every call site (tests,
// commands/files.rs, portable.rs) for a purely stylistic lint — not worth the
// churn/risk in the core encryption engine.
#[allow(clippy::too_many_arguments)]
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
    encrypt_file_stream_as(
        DEFAULT_WRITE_FORMAT,
        input_path,
        output_path,
        master_key,
        vault_id,
        keyfile_bytes,
        timelock_until,
        entropy_seed,
        compression_level,
        callback,
    )
}

/// Same as `encrypt_file_stream`, in a chosen file format.
#[allow(clippy::too_many_arguments)]
pub fn encrypt_file_stream_as(
    format: FileFormat,
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
    // The file is written under a ".part" name and given its real name only when every byte
    // is on disk. A failure or a power cut therefore never leaves a cut-off file that looks
    // like a finished .qre file, and a file already at `output_path` is untouched until the
    // new one is complete.
    let part = part_path(Path::new(output_path));
    let part_str = part.to_string_lossy().to_string();
    let written = encrypt_to_file(
        format,
        input_path,
        &part_str,
        master_key,
        vault_id,
        keyfile_bytes,
        timelock_until,
        entropy_seed,
        compression_level,
        callback,
    );
    match written {
        Ok(()) => fs::rename(&part, output_path).map_err(|e| {
            let _ = fs::remove_file(&part);
            anyhow!("Could not save the locked file: {}", e)
        }),
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Does the work of `encrypt_file_stream`, writing straight to `output_path`.
#[allow(clippy::too_many_arguments)]
fn encrypt_to_file(
    format: FileFormat,
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
            crate::cancel::check()?;
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        hasher.finalize().to_vec()
    };

    // The reading side: a file on disk, read in pieces of CHUNK_SIZE.
    let mut input_file = BufReader::new(File::open(input_path)?);
    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut processed_bytes: u64 = 0;
    encrypt_pieces(
        format,
        output_path,
        master_key,
        vault_id,
        keyfile_bytes,
        timelock_until,
        entropy_seed,
        compression_level,
        &original_filename,
        original_hash,
        |writer| {
            loop {
                let n = input_file.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                writer.push(&buffer[..n])?;
                processed_bytes += n as u64;
                callback(processed_bytes, total_size);
            }
            Ok(())
        },
    )
}

/// Seals pieces of plaintext into chunks and writes them. Locking a file feeds it from a file on
/// disk, and re-locking an old file feeds it from the old file's own decryption, so in both cases
/// the chunk format comes from this one place.
struct ChunkWriter {
    output: BufWriter<File>,
    cipher_file: Aes256Gcm,
    base_nonce: [u8; AES_NONCE_LEN],
    chunk_aad: ChunkAad,
    level: i32,
    index: u64,
}

impl ChunkWriter {
    /// Compresses, seals and writes one piece of at most CHUNK_SIZE bytes as the next chunk.
    fn push(&mut self, piece: &[u8]) -> Result<()> {
        crate::cancel::check()?;
        let compressed = compress_chunk(piece, self.level)?;

        let mut chunk_nonce = self.base_nonce;
        let idx_bytes = self.index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce[4 + i] ^= idx_bytes[i];
        }

        let aad = self.chunk_aad.for_chunk(self.index);
        let ciphertext = self
            .cipher_file
            .encrypt(
                Nonce::from_slice(&chunk_nonce),
                Payload {
                    msg: &compressed,
                    aad: &aad,
                },
            )
            .map_err(|_| anyhow!("Chunk {} encryption failed", self.index))?;

        self.output.write_all(&(ciphertext.len() as u32).to_le_bytes())?;
        self.output.write_all(&ciphertext)?;
        self.index += 1;
        Ok(())
    }

    /// Flushes the buffer and asks the operating system to put the bytes on disk. Without this a
    /// power cut just after "Locked" could leave the file cut off, and the user may already have
    /// shredded the original.
    fn finish(self) -> Result<()> {
        let finished = self
            .output
            .into_inner()
            .map_err(|e| anyhow!("Failed to write the locked file: {}", e.error()))?;
        finished
            .sync_all()
            .context("Failed to write the locked file to disk")?;
        Ok(())
    }
}

/// The encryption itself. It writes the header and then hands a [ChunkWriter] to `feed`, which
/// supplies the plaintext piece by piece. The caller states the file name and the SHA-256 of the
/// whole plaintext, because the header is written before the first chunk.
#[allow(clippy::too_many_arguments)]
fn encrypt_pieces(
    format: FileFormat,
    output_path: &str,
    master_key: &MasterKey,
    vault_id: &str,
    keyfile_bytes: Option<&[u8]>,
    timelock_until: Option<u64>,
    entropy_seed: Option<[u8; 32]>,
    compression_level: i32,
    original_filename: &str,
    original_hash: Vec<u8>,
    feed: impl FnOnce(&mut ChunkWriter) -> Result<()>,
) -> Result<()> {
    let mut output_file = BufWriter::new(File::create(output_path)?);

    let version: u32 = match format {
        FileFormat::V8 => VERSION_V8,
        FileFormat::Classic if timelock_until.is_some() => VERSION_V7,
        FileFormat::Classic => VERSION_V6,
    };
    // The version is written together with the header, once the header is complete.

    // Entropy mixing (Paranoid Mode). The seed is wiped when it goes out of scope, on every exit.
    let mut combined_seed = Zeroizing::new([0u8; 32]);
    SysRng
        .try_fill_bytes(&mut *combined_seed)
        .expect("OS RNG failed");
    if let Some(user_seed) = entropy_seed {
        for i in 0..32 {
            combined_seed[i] ^= user_seed[i];
        }
    }
    let mut rng = ChaCha20Rng::from_seed(*combined_seed);

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

            let binding_key_hash: Vec<u8> = Sha256::digest(*binding_key).to_vec();

            let base_wrapping_key = derive_wrapping_key(master_key, None);
            let cipher_base =
                Aes256Gcm::new_from_slice(&*base_wrapping_key).map_err(|e| anyhow!(e))?;

            let mut bk_nonce = [0u8; AES_NONCE_LEN];
            rng.fill_bytes(&mut bk_nonce);

            // V8 ties the date to the binding key, so the date cannot be changed without
            // the master key. Earlier versions seal the key with no associated data.
            let bk_aad = if version == VERSION_V8 {
                binding_key_aad(locked_until)
            } else {
                Vec::new()
            };
            let encrypted_binding_key = cipher_base
                .encrypt(
                    Nonce::from_slice(&bk_nonce),
                    Payload {
                        msg: &binding_key[..],
                        aad: &bk_aad,
                    },
                )
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
    let mut key_wrap_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut key_wrap_nonce);
    let mut base_nonce = [0u8; AES_NONCE_LEN];
    rng.fill_bytes(&mut base_nonce);

    let chunk_aad = if version == VERSION_V8 {
        // V8: the file name and the hash go inside an encrypted block, and every other field is
        // bound to the rest through `header_binding`.
        let mut meta_nonce = [0u8; AES_NONCE_LEN];
        rng.fill_bytes(&mut meta_nonce);

        let secret = bincode::serialize(&SecretMeta {
            original_filename: original_filename.to_string(),
            original_hash,
        })
        .context("Failed to serialize the file details")?;

        // The digest includes the stored length of the header, so it is computed with
        // placeholders that already have the final sizes of the three sealed fields (each is its
        // plaintext plus the 16 byte tag). They are replaced by the real values below.
        let mut header = StreamHeaderV8 {
            vault_id: Some(vault_id.to_string()),
            validation_nonce: val_nonce.to_vec(),
            encrypted_validation_tag: vec![0u8; VALIDATION_MAGIC.len() + 16],
            key_wrapping_nonce: key_wrap_nonce.to_vec(),
            encrypted_file_key: vec![0u8; FILE_KEY_LEN + 16],
            base_nonce: base_nonce.to_vec(),
            meta_nonce: meta_nonce.to_vec(),
            encrypted_meta: vec![0u8; secret.len() + 16],
            timelock: timelock_meta.as_ref().map(|tl| SealedTimeLock {
                locked_until: tl.locked_until,
                encrypted_binding_key: tl.encrypted_binding_key.clone(),
                binding_key_nonce: tl.binding_key_nonce.clone(),
            }),
        };
        let planned_len = bincode::serialized_size(&header).context("Failed to size the V8 header")?;
        let binding = header_binding(&header);

        header.encrypted_validation_tag = cipher_wrap
            .encrypt(
                Nonce::from_slice(&val_nonce),
                Payload {
                    msg: VALIDATION_MAGIC,
                    aad: &[], // a key check only: it must fail for a wrong key and nothing else
                },
            )
            .map_err(|e| anyhow!("Validation encrypt: {}", e))?;
        header.encrypted_file_key = cipher_wrap
            .encrypt(
                Nonce::from_slice(&key_wrap_nonce),
                Payload {
                    msg: &file_key[..],
                    aad: &binding,
                },
            )
            .map_err(|e| anyhow!("File key wrap: {}", e))?;

        header.encrypted_meta = cipher_file
            .encrypt(
                Nonce::from_slice(&meta_nonce),
                Payload {
                    msg: &secret,
                    aad: &binding,
                },
            )
            .map_err(|e| anyhow!("File details encrypt: {}", e))?;

        let bytes = bincode::serialize(&header).context("Failed to serialize V8 header")?;
        if bytes.len() > V8_MAX_HEADER_BYTES {
            return Err(anyhow!("The file name is too long to lock."));
        }
        // The digest was made for this length. If sealing changed it, the file could not be opened.
        if bytes.len() as u64 != planned_len {
            return Err(anyhow!("Internal error: the header size changed while it was sealed."));
        }
        output_file.write_all(&version.to_le_bytes())?;
        output_file.write_all(&(bytes.len() as u32).to_le_bytes())?;
        output_file.write_all(&bytes)?;
        ChunkAad::Header(binding)
    } else {
        let encrypted_validation = cipher_wrap
            .encrypt(Nonce::from_slice(&val_nonce), VALIDATION_MAGIC)
            .map_err(|e| anyhow!("Validation encrypt: {}", e))?;
        let encrypted_file_key = cipher_wrap
            .encrypt(Nonce::from_slice(&key_wrap_nonce), file_key.as_ref())
            .map_err(|e| anyhow!("File key wrap: {}", e))?;

        let header = StreamHeader {
            vault_id: Some(vault_id.to_string()),
            validation_nonce: val_nonce.to_vec(),
            encrypted_validation_tag: encrypted_validation,
            key_wrapping_nonce: key_wrap_nonce.to_vec(),
            encrypted_file_key,
            base_nonce: base_nonce.to_vec(),
            original_filename: original_filename.to_string(),
            original_hash: Some(original_hash),
            timelock: timelock_meta,
        };

        output_file.write_all(&version.to_le_bytes())?;
        // Write header: V7 uses fixed padded region; V6 uses variable length
        if version == VERSION_V7 {
            let serialized =
                bincode::serialize(&header).context("Failed to serialize V7 header")?;

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
        ChunkAad::Name(original_filename.to_string())
    };

    // ── STREAMING ENCRYPTION ──────────────────────────────────────────────────
    let mut writer = ChunkWriter {
        output: output_file,
        cipher_file,
        base_nonce,
        chunk_aad,
        level: compression_level,
        index: 0,
    };
    feed(&mut writer)?;
    writer.finish()?;
    Ok(())
}

// ==========================================
// --- STREAM DECRYPTOR ---
// ==========================================

/// An opened stream file, ready to have its chunks read.
struct OpenedStream {
    /// Positioned at the first chunk.
    reader: BufReader<File>,
    header: StreamHeader,
    /// The cipher for the chunks.
    cipher: Aes256Gcm,
    file_size: u64,
    chunk_aad: ChunkAad,
}

/// Opens a stream file: reads the header, applies the time-lock when asked to, checks the key,
/// and returns the reader (positioned at the first chunk), the header, the cipher for the chunks
/// and the size of the file.
///
/// `enforce_time_lock` is false only when the owner checks a file they have just locked. That
/// check does not read the clock and never changes the file.
fn open_stream(
    input_path: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    enforce_time_lock: bool,
) -> Result<OpenedStream> {
    let file_size = fs::metadata(input_path)?.len();
    let mut input_file = BufReader::new(File::open(input_path)?);

    let mut ver_buf = [0u8; 4];
    input_file.read_exact(&mut ver_buf)?;
    let version = u32::from_le_bytes(ver_buf);

    if version == VERSION_V8 {
        return open_stream_v8(
            input_file,
            file_size,
            master_key,
            keyfile_bytes,
            enforce_time_lock,
        );
    }

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
        if enforce_time_lock {
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

        }

        // Lock expired (or not being enforced): decrypt the binding key with the BASE wrapping key
        let base_wrapping_key = derive_wrapping_key(master_key, None);
        let cipher_base = Aes256Gcm::new_from_slice(&*base_wrapping_key).map_err(|e| anyhow!(e))?;

        let binding_key_nonce = crate::utils::checked_nonce(&tl.binding_key_nonce)
            .map_err(|_| anyhow!("Failed to decrypt binding key. Wrong master password?"))?;
        let binding_key_vec = cipher_base
            .decrypt(binding_key_nonce, tl.encrypted_binding_key.as_ref())
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

    match crate::utils::checked_nonce(&header.validation_nonce).and_then(|n| {
        cipher_wrap
            .decrypt(n, header.encrypted_validation_tag.as_ref())
            .map_err(|e| anyhow!(e))
    }) {
        Ok(bytes) if constant_time_eq(&bytes, VALIDATION_MAGIC) => {}
        _ => {
            return Err(anyhow!(
                "Decryption Denied. Password or Keyfile is incorrect."
            ))
        }
    }

    let key_wrap_nonce = crate::utils::checked_nonce(&header.key_wrapping_nonce)
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;
    let file_key_vec = cipher_wrap
        .decrypt(key_wrap_nonce, header.encrypted_file_key.as_ref())
        .map_err(|_| anyhow!("Failed to unwrap file key"))?;

    let file_key = Zeroizing::new(file_key_vec);
    let cipher_file =
        Aes256Gcm::new_from_slice(&file_key).map_err(|_| anyhow!("Invalid file key"))?;

    let chunk_aad = ChunkAad::Name(header.original_filename.clone());
    Ok(OpenedStream {
        reader: input_file,
        header,
        cipher: cipher_file,
        file_size,
        chunk_aad,
    })
}

/// Opens a V8 file. The steps and the order are those of the older versions: the time-lock is
/// checked before any key is touched, so a locked file never says whether the password was right.
/// What is new is that nothing is believed until it has been authenticated: the date by the
/// binding key, everything else by the file key and the secret details. The validation tag only
/// tells a wrong key from a damaged header.
fn open_stream_v8(
    mut input_file: BufReader<File>,
    file_size: u64,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    enforce_time_lock: bool,
) -> Result<OpenedStream> {
    // A time-locked file seals its binding key under the master key alone, so a wrong password
    // and a changed date fail at the same step and cannot be told apart.
    const REFUSED: &str =
        "Decryption Denied. Password or Keyfile is incorrect, or the file header was changed.";
    // The validation tag is not tied to the header, so it fails only for a wrong key. Once it has
    // passed, any later failure means the header was damaged or changed.
    const WRONG_KEY: &str = "Decryption Denied. Password or Keyfile is incorrect.";
    const DAMAGED: &str = "The file header is damaged or was changed. The password may be right.";

    let sealed = read_v8_header(&mut input_file)?;
    let binding = header_binding(&sealed);

    let effective_keyfile: Option<Vec<u8>> = if let Some(tl) = &sealed.timelock {
        if enforce_time_lock {
            // No ratchet: a ratchet can only record a time earlier than the date, because it was
            // only ever written during a refusal, so it could never change the answer. A refused
            // attempt writes nothing, and a V8 file is never modified.
            let authoritative_time = timelock_clock::get_authoritative_time(0);
            if authoritative_time < tl.locked_until {
                let remaining = tl.locked_until.saturating_sub(authoritative_time);
                return Err(anyhow!(
                    "TIME_LOCKED:{}:This file is time-locked for {}.",
                    tl.locked_until,
                    format_duration_secs(remaining)
                ));
            }
        }

        // The date is part of what the binding key was sealed with. A file whose date was
        // changed gets no further than this line.
        let base_wrapping_key = derive_wrapping_key(master_key, None);
        let cipher_base = Aes256Gcm::new_from_slice(&*base_wrapping_key).map_err(|e| anyhow!(e))?;
        let nonce = crate::utils::checked_nonce(&tl.binding_key_nonce)
            .map_err(|_| anyhow!(REFUSED))?;
        let binding_key = cipher_base
            .decrypt(
                nonce,
                Payload {
                    msg: &tl.encrypted_binding_key,
                    aad: &binding_key_aad(tl.locked_until),
                },
            )
            .map_err(|_| anyhow!(REFUSED))?;
        Some(Sha256::digest(&binding_key).to_vec())
    } else {
        keyfile_bytes.map(|b| b.to_vec())
    };

    let wrapping_key = derive_wrapping_key(master_key, effective_keyfile.as_deref());
    let cipher_wrap = Aes256Gcm::new_from_slice(&*wrapping_key).map_err(|e| anyhow!(e))?;

    let tag_ok = crate::utils::checked_nonce(&sealed.validation_nonce)
        .ok()
        .and_then(|n| {
            cipher_wrap
                .decrypt(
                    n,
                    Payload {
                        msg: &sealed.encrypted_validation_tag,
                        aad: &[],
                    },
                )
                .ok()
        })
        .map(|bytes| constant_time_eq(&bytes, VALIDATION_MAGIC))
        .unwrap_or(false);
    if !tag_ok {
        // With a time-lock the master key has already been proved right by the binding key, so
        // a failure here can only be damage to the tag or its nonce.
        return Err(anyhow!(if sealed.timelock.is_some() { DAMAGED } else { WRONG_KEY }));
    }

    let key_wrap_nonce = crate::utils::checked_nonce(&sealed.key_wrapping_nonce)
        .map_err(|_| anyhow!(DAMAGED))?;
    let file_key = Zeroizing::new(
        cipher_wrap
            .decrypt(
                key_wrap_nonce,
                Payload {
                    msg: &sealed.encrypted_file_key,
                    aad: &binding,
                },
            )
            .map_err(|_| anyhow!(DAMAGED))?,
    );
    let cipher_file =
        Aes256Gcm::new_from_slice(&file_key).map_err(|_| anyhow!("Invalid file key"))?;

    let meta_nonce = crate::utils::checked_nonce(&sealed.meta_nonce)
        .map_err(|_| anyhow!(DAMAGED))?;
    let secret_bytes = cipher_file
        .decrypt(
            meta_nonce,
            Payload {
                msg: &sealed.encrypted_meta,
                aad: &binding,
            },
        )
        .map_err(|_| anyhow!(DAMAGED))?;
    let secret: SecretMeta = bincode::deserialize(&secret_bytes).map_err(|_| anyhow!(DAMAGED))?;

    let header = StreamHeader {
        vault_id: sealed.vault_id,
        validation_nonce: sealed.validation_nonce,
        encrypted_validation_tag: sealed.encrypted_validation_tag,
        key_wrapping_nonce: sealed.key_wrapping_nonce,
        encrypted_file_key: sealed.encrypted_file_key,
        base_nonce: sealed.base_nonce,
        original_filename: secret.original_filename,
        original_hash: Some(secret.original_hash),
        timelock: sealed.timelock.map(|tl| tl.as_meta()),
    };

    Ok(OpenedStream {
        reader: input_file,
        header,
        cipher: cipher_file,
        file_size,
        chunk_aad: ChunkAad::Header(binding),
    })
}

/// Opens every chunk in turn and hands its plaintext to `sink`. At the end the SHA-256 of all
/// the plaintext is compared with the one in the header, which catches a file that was cut off
/// between two chunks. Nothing is accepted as complete until that check has passed.
fn read_all_chunks(
    stream: &mut OpenedStream,
    callback: &impl Fn(u64, u64),
    mut sink: impl FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    let OpenedStream {
        reader: input_file,
        header,
        cipher: cipher_file,
        file_size,
        chunk_aad,
    } = stream;
    let file_size = *file_size;

    // base_nonce feeds a fixed-size copy_from_slice below (once per chunk); check
    // its length once up front rather than letting a corrupt/short header panic.
    if header.base_nonce.len() != AES_NONCE_LEN {
        return Err(anyhow!("Corrupt header: invalid base_nonce length"));
    }

    let mut hasher = Sha256::new();
    let mut chunk_index: u64 = 0;
    let mut processed: u64 = 0;

    while let Some(chunk_len) = read_chunk_len(input_file, chunk_index)? {
        crate::cancel::check()?;
        let chunk_len = chunk_len as usize;
        if chunk_len > CHUNK_SIZE + 4096 {
            return Err(anyhow!(
                "Chunk {} size anomaly ({} bytes) — file may be corrupt.",
                chunk_index,
                chunk_len
            ));
        }

        let mut ciphertext = vec![0u8; chunk_len];
        input_file.read_exact(&mut ciphertext).map_err(|e| {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                anyhow!("Chunk {} is incomplete: the file is truncated.", chunk_index)
            } else {
                anyhow!("Read error at chunk {}: {}", chunk_index, e)
            }
        })?;

        let mut chunk_nonce = [0u8; AES_NONCE_LEN];
        chunk_nonce.copy_from_slice(&header.base_nonce);
        let idx_bytes = chunk_index.to_le_bytes();
        for i in 0..8 {
            chunk_nonce[4 + i] ^= idx_bytes[i];
        }

        let aad = chunk_aad.for_chunk(chunk_index);
        let payload = Payload {
            msg: &ciphertext,
            aad: &aad,
        };

        let compressed = cipher_file
            .decrypt(Nonce::from_slice(&chunk_nonce), payload)
            .map_err(|_| anyhow!("Chunk {} integrity check failed", chunk_index))?;

        let plaintext = decompress_chunk(&compressed)?;
        hasher.update(&plaintext);
        sink(&plaintext)?;

        processed += chunk_len as u64;
        chunk_index += 1;
        if chunk_index.is_multiple_of(5) {
            callback(processed, file_size);
        }
    }

    // Whole-file integrity check (truncation attack defense)
    if let Some(expected) = &header.original_hash {
        let actual = hasher.finalize().to_vec();
        if !constant_time_eq(&actual, expected) {
            return Err(anyhow!(
                "INTEGRITY ERROR: File hash mismatch. \
                 The encrypted file may be truncated or corrupt."
            ));
        }
    }
    Ok(())
}

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
    let mut stream = open_stream(input_path, master_key, keyfile_bytes, true)?;

    // In files before V8 the file name comes from the header, which is stored in the clear and
    // not covered by the authentication tag, so it cannot be trusted. In V8 it is authenticated,
    // but only its last part is used either way. The output always lands in the folder the
    // user chose.
    let out_name = safe_output_name(&stream.header.original_filename)?;
    let raw_out = Path::new(output_dir).join(&out_name);
    let part_out = part_path(&crate::utils::get_unique_path(&raw_out));

    // The plaintext is written under a ".part" name and only gets its real name after every
    // chunk has been authenticated and the whole-file hash has matched. If anything fails the
    // part file is removed, so no half-decrypted file is ever left next to the real ones.
    let outcome = (|| -> Result<()> {
        let mut output_file = BufWriter::new(File::create(&part_out)?);
        read_all_chunks(&mut stream, &callback, |plain| {
            output_file.write_all(plain)?;
            Ok(())
        })?;

        let finished = output_file
            .into_inner()
            .map_err(|e| anyhow!("Failed to write the unlocked file: {}", e.error()))?;
        finished
            .sync_all()
            .context("Failed to write the unlocked file to disk")?;
        Ok(())
    })();

    if let Err(e) = outcome {
        let _ = fs::remove_file(&part_out);
        return Err(e);
    }

    // Checked again here: something may have taken the name while the file was being decrypted.
    let final_out = crate::utils::get_unique_path(&raw_out);
    if let Err(e) = fs::rename(&part_out, &final_out) {
        let _ = fs::remove_file(&part_out);
        return Err(anyhow!("Could not save the unlocked file: {}", e));
    }
    let final_filename = final_out
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(final_filename)
}

// ==========================================
// --- VERIFY AFTER LOCKING ---
// ==========================================

/// Checks that a locked file can be opened with these keys and is complete and undamaged.
///
/// It goes through the same steps as unlocking: the header, the key, every chunk's
/// authentication tag and the whole-file hash. It writes nothing and never changes the file.
/// The time-lock is not applied, because this is the owner checking a file they have just made.
/// A time-locked file therefore verifies at once, without reading the clock or the network.
///
/// What it proves: the bytes on disk are the bytes that were meant to be written, and the key
/// the app holds opens them. What it cannot prove: that you remember your password.
pub fn verify_locked_file(
    input_path: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    callback: impl Fn(u64, u64),
) -> Result<()> {
    let mut stream = open_stream(input_path, master_key, keyfile_bytes, false)?;
    read_all_chunks(&mut stream, &callback, |_| Ok(()))
}

/// Verifies a freshly locked file. If it fails, the file is removed, because a locked file that
/// cannot be opened is worse than none: it looks like a backup and is not one. The message says
/// what happened and that the original was not touched.
pub fn verify_or_remove(
    locked_path: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    callback: impl Fn(u64, u64),
) -> std::result::Result<(), String> {
    match verify_locked_file(locked_path, master_key, keyfile_bytes, callback) {
        Ok(()) => Ok(()),
        Err(e) if crate::cancel::is_cancel_error(&e) => {
            let _ = fs::remove_file(locked_path);
            Err(format!(
                "{} The new locked file was removed, because it was not checked. Your original file has not been touched.",
                crate::cancel::CANCELLED
            ))
        }
        Err(e) => {
            let _ = fs::remove_file(locked_path);
            Err(format!(
                "Verification failed: {}. The locked file was removed. Your original file has not been touched.",
                e
            ))
        }
    }
}

// ==========================================
// --- VAULT FILES ---
// ==========================================

/// The most plaintext one vault file may hold when it is opened. A real vault is a few kilobytes
/// to a few megabytes of JSON. The limit keeps a damaged or hostile file, which can only be made
/// by someone who already has the key, from filling the memory.
pub(crate) const MAX_VAULT_BYTES: usize = 512 * 1024 * 1024;

/// How hard vault files are compressed. They are small and saved often, so a light setting.
const VAULT_COMPRESSION_LEVEL: i32 = 3;

/// Saves the content of a vault file (passwords, notes, bookmarks or the clipboard history) at
/// `path` in format 8, the same format as a locked file. The name inside, `inner_name`, and the
/// hash of the content are sealed, and the rest of the header is covered by the header digest.
///
/// The old file at `path` stays whole until the new one is complete, on disk, and has been opened
/// once to prove it can be read back. A failure at any step removes the new file and leaves the
/// old one alone.
pub fn seal_vault_file(
    path: &Path,
    vault_id: &str,
    master_key: &MasterKey,
    inner_name: &str,
    content: &[u8],
) -> Result<()> {
    let part = PathBuf::from(format!("{}.part", path.to_string_lossy()));
    // A stale file from an earlier run that was cut short is overwritten by File::create.
    let part_str = part.to_string_lossy().to_string();
    let hash = Sha256::digest(content).to_vec();

    let written = (|| -> Result<()> {
        encrypt_pieces(
            FileFormat::V8,
            &part_str,
            master_key,
            vault_id,
            None,
            None,
            None,
            VAULT_COMPRESSION_LEVEL,
            inner_name,
            hash,
            |writer| {
                for piece in content.chunks(CHUNK_SIZE) {
                    writer.push(piece)?;
                }
                Ok(())
            },
        )?;
        // The new file must open with this key and match the hash, before it replaces anything.
        verify_locked_file(&part_str, master_key, None, |_, _| {})
            .context("The new vault file could not be read back")?;
        fs::rename(&part, path).context("Could not replace the vault file")
    })();

    if written.is_err() {
        let _ = fs::remove_file(&part);
    }
    written
}

/// Opens a vault file written by [seal_vault_file] and returns its content. The file must be
/// format 8 without a time-lock, and the name sealed inside must be `inner_name`, so a vault file
/// copied over another one (notes over passwords, say) is refused instead of being read as that
/// one.
pub fn open_vault_file(
    path: &Path,
    master_key: &MasterKey,
    inner_name: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    let path_str = path.to_string_lossy().to_string();
    if stream_version(&path_str) != Some(VERSION_V8) {
        return Err(anyhow!("This vault file is in an unknown format."));
    }
    let mut stream = open_stream(&path_str, master_key, None, false)?;
    if stream.header.timelock.is_some() {
        return Err(anyhow!("This is a time-locked file, not a vault file."));
    }
    if stream.header.original_filename != inner_name {
        return Err(anyhow!(
            "This file is not the {} vault file. It may have been copied over it.",
            inner_name
        ));
    }
    let mut content = Zeroizing::new(Vec::new());
    read_all_chunks(&mut stream, &|_, _| {}, |plain| {
        if content.len() + plain.len() > MAX_VAULT_BYTES {
            return Err(anyhow!("This vault file is larger than any real vault."));
        }
        content.extend_from_slice(plain);
        Ok(())
    })?;
    Ok(content)
}

// ==========================================
// --- RE-LOCKING OLD FILES ---
// ==========================================

/// The format version at the start of a file, or `None` if the file cannot be read or is too
/// short to have one.
pub fn stream_version(path: &str) -> Option<u32> {
    let mut file = File::open(path).ok()?;
    let mut ver_buf = [0u8; 4];
    file.read_exact(&mut ver_buf).ok()?;
    Some(u32::from_le_bytes(ver_buf))
}

/// True for the stream formats that `relock_file_stream` can rewrite: versions 5, 6 and 7.
pub fn is_upgradable_version(version: u32) -> bool {
    matches!(version, VERSION_V5 | VERSION_V6 | VERSION_V7)
}

/// The SHA-256 of a file's plaintext, found by decrypting it once and writing nothing. Used when
/// an old file has no hash in its header, so that the new header can still carry one.
fn plaintext_hash(
    input_path: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let mut stream = open_stream(input_path, master_key, keyfile_bytes, true)?;
    let mut hasher = Sha256::new();
    read_all_chunks(&mut stream, &|_, _| {}, |piece| {
        hasher.update(piece);
        Ok(())
    })?;
    Ok(hasher.finalize().to_vec())
}

/// Rewrites a locked file of format 5, 6 or 7 as format 8, under the same name and with the same
/// content, vault and keys.
///
/// The plaintext is never written to disk: each piece is decrypted and sealed again in memory.
/// The new file is written under a ".part" name, opened once from start to finish to prove that
/// it is whole, and only then renamed over the old file. If anything goes wrong the old file is
/// left exactly as it was and the ".part" file is removed.
///
/// A file that is still time-locked is refused with the usual `TIME_LOCKED:` message. The owner
/// can open such a file early with the master key, but doing that here would quietly end the lock,
/// so it is left alone until the date has passed. A time-lock that has passed is not carried over,
/// since it no longer locks anything.
///
/// `on_write` reports progress while the new file is written and `on_check` while it is checked.
pub fn relock_file_stream(
    input_path: &str,
    master_key: &MasterKey,
    keyfile_bytes: Option<&[u8]>,
    compression_level: i32,
    on_write: impl Fn(u64, u64),
    on_check: impl Fn(u64, u64),
) -> Result<()> {
    match stream_version(input_path) {
        Some(v) if is_upgradable_version(v) => {}
        Some(VERSION_V8) => return Err(anyhow!("This file is already in the current format.")),
        _ => return Err(anyhow!("This is not a locked file that can be upgraded.")),
    }

    let part = part_path(Path::new(input_path));
    let part_str = part.to_string_lossy().to_string();

    let written = (|| -> Result<()> {
        let mut stream = open_stream(input_path, master_key, keyfile_bytes, true)?;
        // Only the last part of the name is kept, cleaned the same way as when unlocking.
        let name = safe_output_name(&stream.header.original_filename)?;
        let vault_id = stream
            .header
            .vault_id
            .clone()
            .unwrap_or_else(|| "local".to_string());
        let hash = match &stream.header.original_hash {
            Some(h) => h.clone(),
            None => plaintext_hash(input_path, master_key, keyfile_bytes)?,
        };
        // When the old header has a hash, `read_all_chunks` compares it with the plaintext at the
        // end and fails if they differ, so the hash written to the new header is the real one.
        encrypt_pieces(
            FileFormat::V8,
            &part_str,
            master_key,
            &vault_id,
            keyfile_bytes,
            None,
            None,
            compression_level,
            &name,
            hash,
            |writer| read_all_chunks(&mut stream, &on_write, |piece| writer.push(piece)),
        )
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&part);
        return Err(e);
    }

    if let Err(e) = verify_locked_file(&part_str, master_key, keyfile_bytes, on_check) {
        let _ = fs::remove_file(&part);
        if crate::cancel::is_cancel_error(&e) {
            return Err(e);
        }
        return Err(anyhow!(
            "The new file did not pass its check ({}). The old file was not changed.",
            e
        ));
    }

    fs::rename(&part, input_path).map_err(|e| {
        let _ = fs::remove_file(&part);
        anyhow!("Could not replace the old file: {}. The old file was not changed.", e)
    })
}

// --- END OF FILE src-tauri/src/crypto_stream.rs ---
