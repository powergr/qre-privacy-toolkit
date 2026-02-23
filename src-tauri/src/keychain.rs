use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use argon2::password_hash::{rand_core::OsRng, SaltString};
use argon2::{Algorithm, Argon2, Params, PasswordHasher, Version};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

// Size of the cryptographic nonce used for AES-GCM (12 bytes is standard)
const NONCE_LEN: usize = 12;

// --- Default KDF Parameters ---
// KDF = Key Derivation Function (Argon2id).
// These settings control how "expensive" it is to check a password.
// Higher values make brute-force attacks harder but login slower.

fn default_kdf_memory() -> u32 {
    19456 // ~19 MB of RAM required
}
fn default_kdf_iterations() -> u32 {
    2 // Number of passes
}
fn default_kdf_parallelism() -> u32 {
    1 // Number of CPU threads
}

// --- Data Structures ---

/// The "Master Key" is the central secret that encrypts everything else.
/// It is a 32-byte array kept in memory only while the user is logged in.
/// The `Zeroize` trait ensures it is securely wiped from RAM when dropped.
#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct MasterKey(pub [u8; 32]);

/// The structure of the `keychain.json` file stored on disk.
/// This file does NOT contain the Master Key directly.
/// Instead, it contains encrypted versions of the Master Key (slots).
#[derive(Serialize, Deserialize, Debug)]
pub struct KeychainStore {
    pub vault_id: String, // Unique ID for this vault

    // Store KDF parameters so we can upgrade them in future versions
    // without breaking existing vaults.
    #[serde(default = "default_kdf_memory")]
    pub kdf_memory: u32,
    #[serde(default = "default_kdf_iterations")]
    pub kdf_iterations: u32,
    #[serde(default = "default_kdf_parallelism")]
    pub kdf_parallelism: u32,

    // --- Slot 1: User Password ---
    // Salt used to hash the user's password.
    pub password_salt: String,
    // Random nonce used for the AES encryption of this slot.
    pub password_nonce: Vec<u8>,
    // The Master Key encrypted with the user's password.
    pub encrypted_master_key_pass: Vec<u8>,

    // --- Slot 2: Recovery Code ---
    // Salt used to hash the recovery code.
    pub recovery_salt: String,
    // Random nonce for the recovery slot.
    pub recovery_nonce: Vec<u8>,
    // The Master Key encrypted with the recovery code (QRE-XXXX...).
    pub encrypted_master_key_recovery: Vec<u8>,
}

// --- Internal Logic ---

/// Derives a Key Encryption Key (KEK) from a secret (password) using Argon2id.
/// This turns a weak human password into a strong cryptographic key.
///
/// SECURITY: Returns a `Zeroizing` wrapper so the KEK is automatically wiped
/// from RAM when it goes out of scope. Returns `Result` instead of panicking
/// on corrupted keychain data.
fn derive_kek(
    secret: &str,
    salt_str: &str,
    mem: u32,
    iter: u32,
    par: u32,
) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(mem, iter, par, Some(32))
        .map_err(|e| anyhow!("Invalid KDF parameters: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt =
        SaltString::from_b64(salt_str).map_err(|e| anyhow!("Invalid salt in keychain: {}", e))?;

    let hash = argon2
        .hash_password(secret.as_bytes(), &salt)
        .map_err(|e| anyhow!("KDF failed: {}", e))?;

    let hash_bytes = hash.hash.ok_or_else(|| anyhow!("KDF produced no output"))?;

    let mut key = [0u8; 32];
    key.copy_from_slice(hash_bytes.as_bytes());
    // Zeroizing ensures this key is wiped from RAM when the caller drops it
    Ok(Zeroizing::new(key))
}

// --- Public API ---

/// Initializes a NEW vault (Onboarding).
/// 1. Generates a random Master Key.
/// 2. Encrypts it with the User's Password (Slot 1).
/// 3. Generates a Recovery Code (QRE-...).
/// 4. Encrypts the Master Key with the Recovery Code (Slot 2).
/// 5. Saves `keychain.json` to disk.
pub fn init_keychain(path: &Path, password: &str) -> Result<(String, MasterKey)> {
    if path.exists() {
        return Err(anyhow!("Keychain already exists."));
    }

    // 1. Define KDF Settings
    let mem = default_kdf_memory();
    let iter = default_kdf_iterations();
    let par = default_kdf_parallelism();

    // 2. Generate Random Master Key
    let mut mk_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut mk_bytes);
    let master_key = MasterKey(mk_bytes);

    // 3. Prepare Password Slot
    let pass_salt = SaltString::generate(&mut OsRng).as_str().to_string();
    // FIX: KEK is now auto-zeroized when it drops (Zeroizing wrapper)
    let pass_kek = derive_kek(password, &pass_salt, mem, iter, par)?;
    let cipher_pass =
        Aes256Gcm::new_from_slice(&*pass_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;

    let mut pass_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut pass_nonce_bytes);

    let enc_mk_pass = cipher_pass
        .encrypt(Nonce::from_slice(&pass_nonce_bytes), master_key.0.as_ref())
        .map_err(|e| anyhow!("Failed to encrypt master key: {}", e))?;

    // 4. Prepare Recovery Slot
    let raw_recovery: String = (0..4)
        .map(|_| {
            let mut buf = [0u8; 2];
            OsRng.fill_bytes(&mut buf);
            let n = u16::from_le_bytes(buf);
            format!("{:04X}", n)
        })
        .collect::<Vec<String>>()
        .join("-");
    let recovery_code = format!("QRE-{}", raw_recovery);

    let rec_salt = SaltString::generate(&mut OsRng).as_str().to_string();
    // FIX: KEK is now auto-zeroized when it drops (Zeroizing wrapper)
    let rec_kek = derive_kek(&recovery_code, &rec_salt, mem, iter, par)?;
    let cipher_rec =
        Aes256Gcm::new_from_slice(&*rec_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;

    let mut rec_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut rec_nonce_bytes);

    let enc_mk_rec = cipher_rec
        .encrypt(Nonce::from_slice(&rec_nonce_bytes), master_key.0.as_ref())
        .map_err(|_| anyhow!("Failed to encrypt recovery slot"))?;

    // 5. Save to Disk
    let store = KeychainStore {
        vault_id: uuid::Uuid::new_v4().to_string(),
        kdf_memory: mem,
        kdf_iterations: iter,
        kdf_parallelism: par,
        password_salt: pass_salt,
        password_nonce: pass_nonce_bytes.to_vec(),
        encrypted_master_key_pass: enc_mk_pass,
        recovery_salt: rec_salt,
        recovery_nonce: rec_nonce_bytes.to_vec(),
        encrypted_master_key_recovery: enc_mk_rec,
    };

    let file = fs::File::create(path)?;
    serde_json::to_writer_pretty(file, &store)?;

    Ok((recovery_code, master_key))
}

/// Attempts to unlock the keychain using the User's Password.
/// If successful, returns the decrypted Master Key.
pub fn unlock_keychain(path: &Path, password: &str) -> Result<MasterKey> {
    if !path.exists() {
        return Err(anyhow!("No keychain found. Please initialize first."));
    }

    let file = fs::File::open(path)?;
    let store: KeychainStore = serde_json::from_reader(file).context("Corrupted keychain file")?;

    // Re-derive the key using the SAME parameters stored in the file.
    // FIX: kek is now auto-zeroized when it drops.
    let kek = derive_kek(
        password,
        &store.password_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    )?;

    let cipher = Aes256Gcm::new_from_slice(&*kek).map_err(|e| anyhow!("Cipher init: {}", e))?;
    let nonce = Nonce::from_slice(&store.password_nonce);

    // Attempt Decryption.
    // FIX: Wrap mk_bytes in Zeroizing so it's wiped from RAM after we copy
    // it into the fixed-size MasterKey array.
    let mk_bytes: Zeroizing<Vec<u8>> = Zeroizing::new(
        cipher
            .decrypt(nonce, store.encrypted_master_key_pass.as_ref())
            .map_err(|_| anyhow!("Incorrect Password"))?,
    );

    if mk_bytes.len() != 32 {
        return Err(anyhow!("Keychain is corrupt: invalid master key length"));
    }

    let mut arr = [0u8; 32];
    arr.copy_from_slice(&mk_bytes);

    Ok(MasterKey(arr))
}

/// Used when the user forgets their password.
/// 1. Unlocks the vault using the Recovery Code (Slot 2).
/// 2. Immediately re-encrypts the Master Key with a NEW password (updating Slot 1).
pub fn recover_with_code(
    path: &Path,
    recovery_code: &str,
    new_password: &str,
) -> Result<MasterKey> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Decrypt Master Key using Recovery Code.
    // FIX: rec_kek is auto-zeroized when it drops.
    let rec_kek = derive_kek(
        recovery_code,
        &store.recovery_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    )?;
    let cipher_rec =
        Aes256Gcm::new_from_slice(&*rec_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;
    let nonce_rec = Nonce::from_slice(&store.recovery_nonce);

    // FIX: Wrap in Zeroizing — no clone, no panicking unwrap.
    let mk_bytes: Zeroizing<Vec<u8>> = Zeroizing::new(
        cipher_rec
            .decrypt(nonce_rec, store.encrypted_master_key_recovery.as_ref())
            .map_err(|_| anyhow!("Invalid Recovery Code"))?,
    );

    if mk_bytes.len() != 32 {
        return Err(anyhow!("Keychain is corrupt: invalid master key length"));
    }

    let mut arr = [0u8; 32];
    arr.copy_from_slice(&mk_bytes);
    let master_key = MasterKey(arr);
    // mk_bytes is dropped (and zeroized) here.

    // 2. Re-encrypt Master Key with NEW Password (Slot 1).
    // FIX: new_pass_kek is auto-zeroized when it drops.
    let new_pass_salt = SaltString::generate(&mut OsRng).as_str().to_string();
    let new_pass_kek = derive_kek(
        new_password,
        &new_pass_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    )?;
    let cipher_pass =
        Aes256Gcm::new_from_slice(&*new_pass_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;

    let mut new_pass_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut new_pass_nonce_bytes);

    let new_enc_mk_pass = cipher_pass
        .encrypt(
            Nonce::from_slice(&new_pass_nonce_bytes),
            master_key.0.as_ref(),
        )
        .map_err(|e| anyhow!("Failed to encrypt with new password: {}", e))?;

    // 3. Update Store and Save
    store.password_salt = new_pass_salt;
    store.password_nonce = new_pass_nonce_bytes.to_vec();
    store.encrypted_master_key_pass = new_enc_mk_pass;

    let outfile = fs::File::create(path)?;
    serde_json::to_writer_pretty(outfile, &store)?;

    Ok(master_key)
}

/// Generates a new Recovery Code and updates Slot 2.
/// Used if the user suspects their printed code was compromised.
pub fn reset_recovery_code(path: &Path, master_key: &MasterKey) -> Result<String> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Generate NEW Recovery Code string using OsRng for consistency
    let raw_recovery: String = (0..4)
        .map(|_| {
            let mut buf = [0u8; 2];
            OsRng.fill_bytes(&mut buf);
            let n = u16::from_le_bytes(buf);
            format!("{:04X}", n)
        })
        .collect::<Vec<String>>()
        .join("-");
    let recovery_code = format!("QRE-{}", raw_recovery);

    // 2. Encrypt Master Key with new code.
    // FIX: rec_kek is auto-zeroized when it drops.
    let rec_salt = SaltString::generate(&mut OsRng).as_str().to_string();
    let rec_kek = derive_kek(
        &recovery_code,
        &rec_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    )?;
    let cipher_rec =
        Aes256Gcm::new_from_slice(&*rec_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;

    let mut rec_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut rec_nonce_bytes);
    let rec_nonce = Nonce::from_slice(&rec_nonce_bytes);

    let enc_mk_rec = cipher_rec
        .encrypt(rec_nonce, master_key.0.as_ref())
        .map_err(|_| anyhow!("Failed to encrypt recovery slot"))?;

    // 3. Update Store
    store.recovery_salt = rec_salt;
    store.recovery_nonce = rec_nonce_bytes.to_vec();
    store.encrypted_master_key_recovery = enc_mk_rec;

    let outfile = fs::File::create(path)?;
    serde_json::to_writer_pretty(outfile, &store)?;

    Ok(recovery_code)
}

/// Changes the main User Password (Slot 1) while logged in.
pub fn change_password(path: &Path, master_key: &MasterKey, new_password: &str) -> Result<()> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Generate new Salt
    let new_pass_salt = SaltString::generate(&mut OsRng).as_str().to_string();

    // 2. Derive new Key Encryption Key (KEK).
    // FIX: new_pass_kek is auto-zeroized when it drops.
    let new_pass_kek = derive_kek(
        new_password,
        &new_pass_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    )?;
    let cipher_pass =
        Aes256Gcm::new_from_slice(&*new_pass_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;

    // 3. Encrypt existing Master Key with new KEK
    let mut new_pass_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut new_pass_nonce_bytes);

    let new_enc_mk_pass = cipher_pass
        .encrypt(
            Nonce::from_slice(&new_pass_nonce_bytes),
            master_key.0.as_ref(),
        )
        .map_err(|e| anyhow!("Failed to encrypt with new password: {}", e))?;

    // 4. Update Store
    store.password_salt = new_pass_salt;
    store.password_nonce = new_pass_nonce_bytes.to_vec();
    store.encrypted_master_key_pass = new_enc_mk_pass;

    // 5. Save
    let outfile = fs::File::create(path)?;
    serde_json::to_writer_pretty(outfile, &store)?;

    Ok(())
}

/// Simple check to see if a vault file exists.
pub fn keychain_exists(path: &Path) -> bool {
    path.exists()
}
