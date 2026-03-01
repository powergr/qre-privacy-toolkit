// --- START OF FILE keychain.rs ---

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
// Argon2id is currently the industry standard, cryptographically recommended Key Derivation Function (KDF).
use argon2::password_hash::{rand_core::OsRng, SaltString};
use argon2::{Algorithm, Argon2, Params, PasswordHasher, Version};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
// Zeroize prevents memory scraping/forensics by actively overwriting cryptographic
// keys with zeros before releasing the RAM back to the operating system.
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

// Size of the cryptographic nonce used for AES-GCM (12 bytes/96 bits is the standard)
const NONCE_LEN: usize = 12;

// ==========================================
// --- Default KDF Parameters ---
// ==========================================
// KDF = Key Derivation Function. Human passwords are mathematically weak and easy
// for modern GPUs to guess (brute-force). Argon2id "stretches" the password by
// forcing the computer to use a specific amount of RAM and CPU time to calculate the key.

fn default_kdf_memory() -> u32 {
    19456 // ~19 MB of RAM required. Balanced to be secure but fast enough on mobile devices.
}
fn default_kdf_iterations() -> u32 {
    2 // Number of passes. Increases CPU time required for an attacker.
}
fn default_kdf_parallelism() -> u32 {
    1 // Number of CPU threads required to calculate the hash.
}

// ==========================================
// --- Data Structures ---
// ==========================================

/// The "Master Key" is the central cryptographic secret that encrypts the user's files.
/// It is a completely random 32-byte array kept in memory ONLY while the user is actively logged in.
/// The `ZeroizeOnDrop` trait ensures that when the user logs out (and this struct is destroyed),
/// the 32 bytes are instantly overwritten with `0x00` in RAM.
#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct MasterKey(pub [u8; 32]);

/// The unencrypted structure of the `keychain.json` file stored on disk.
/// SECURITY: This file does NOT contain the Master Key directly.
/// Instead, it acts like a safe with two different keyholes (Slots).
#[derive(Serialize, Deserialize, Debug)]
pub struct KeychainStore {
    pub vault_id: String, // Unique UUID for this specific vault

    // We store the KDF parameters in the file so we can seamlessly upgrade
    // the required RAM/CPU difficulty in future app versions without breaking old vaults.
    #[serde(default = "default_kdf_memory")]
    pub kdf_memory: u32,
    #[serde(default = "default_kdf_iterations")]
    pub kdf_iterations: u32,
    #[serde(default = "default_kdf_parallelism")]
    pub kdf_parallelism: u32,

    // --- Slot 1: User Password ---
    // The random salt defends against pre-computed Rainbow Table attacks.
    pub password_salt: String,
    // The random AES-GCM nonce used to encrypt this specific slot.
    pub password_nonce: Vec<u8>,
    // The Master Key, securely encrypted by the User's Password.
    pub encrypted_master_key_pass: Vec<u8>,

    // --- Slot 2: Recovery Code ---
    // A secondary salt specifically for the recovery code.
    pub recovery_salt: String,
    // A secondary AES-GCM nonce specifically for the recovery code.
    pub recovery_nonce: Vec<u8>,
    // The SAME Master Key, encrypted by the randomly generated Recovery Code (QRE-XXXX...).
    pub encrypted_master_key_recovery: Vec<u8>,
}

// ==========================================
// --- Internal Logic ---
// ==========================================

/// Derives a Key Encryption Key (KEK) from a weak human secret (password) using Argon2id.
///
/// SECURITY: Returns a `Zeroizing` wrapper. This means the highly sensitive derived KEK
/// is automatically wiped from RAM the moment the calling function finishes using it.
fn derive_kek(
    secret: &str,
    salt_str: &str,
    mem: u32,
    iter: u32,
    par: u32,
) -> Result<Zeroizing<[u8; 32]>> {
    // Set up Argon2 parameters dynamically based on the stored vault settings
    let params = Params::new(mem, iter, par, Some(32))
        .map_err(|e| anyhow!("Invalid KDF parameters: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let salt =
        SaltString::from_b64(salt_str).map_err(|e| anyhow!("Invalid salt in keychain: {}", e))?;

    // Perform the heavy cryptographic hashing
    let hash = argon2
        .hash_password(secret.as_bytes(), &salt)
        .map_err(|e| anyhow!("KDF failed: {}", e))?;

    let hash_bytes = hash.hash.ok_or_else(|| anyhow!("KDF produced no output"))?;

    let mut key = [0u8; 32];
    key.copy_from_slice(hash_bytes.as_bytes());

    // Wrap the raw byte array in a Zeroizing struct for automatic memory sanitization
    Ok(Zeroizing::new(key))
}

// ==========================================
// --- Public API ---
// ==========================================

/// Initializes a NEW vault (Onboarding Process).
///
/// The Step-by-Step Envelope Encryption Setup:
/// 1. Generates a truly random Master Key.
/// 2. Derives a KEK from the User's Password & Encrypts the Master Key (Slot 1).
/// 3. Generates a random, printable Recovery Code (e.g., QRE-A1B2-C3D4...).
/// 4. Derives a KEK from the Recovery Code & Encrypts the Master Key again (Slot 2).
/// 5. Saves the metadata and encrypted slots to `keychain.json` on disk.
pub fn init_keychain(path: &Path, password: &str) -> Result<(String, MasterKey)> {
    // Prevent accidentally overwriting an existing user's vault
    if path.exists() {
        return Err(anyhow!("Keychain already exists."));
    }

    // 1. Define KDF Settings
    let mem = default_kdf_memory();
    let iter = default_kdf_iterations();
    let par = default_kdf_parallelism();

    // 2. Generate Truly Random Master Key
    let mut mk_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut mk_bytes);
    let master_key = MasterKey(mk_bytes);

    // 3. Prepare Password Slot (Slot 1)
    let pass_salt = SaltString::generate(&mut OsRng).as_str().to_string();

    // pass_kek is auto-zeroized when this function ends
    let pass_kek = derive_kek(password, &pass_salt, mem, iter, par)?;
    let cipher_pass =
        Aes256Gcm::new_from_slice(&*pass_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;

    let mut pass_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut pass_nonce_bytes);

    let enc_mk_pass = cipher_pass
        .encrypt(Nonce::from_slice(&pass_nonce_bytes), master_key.0.as_ref())
        .map_err(|e| anyhow!("Failed to encrypt master key: {}", e))?;

    // 4. Prepare Recovery Slot (Slot 2)
    // Generate a readable format: QRE-XXXX-XXXX-XXXX-XXXX
    let raw_recovery: String = (0..4)
        .map(|_| {
            let mut buf = [0u8; 2];
            OsRng.fill_bytes(&mut buf);
            let n = u16::from_le_bytes(buf);
            format!("{:04X}", n) // Format as uppercase hex
        })
        .collect::<Vec<String>>()
        .join("-");
    let recovery_code = format!("QRE-{}", raw_recovery);

    let rec_salt = SaltString::generate(&mut OsRng).as_str().to_string();

    // rec_kek is auto-zeroized when this function ends
    let rec_kek = derive_kek(&recovery_code, &rec_salt, mem, iter, par)?;
    let cipher_rec =
        Aes256Gcm::new_from_slice(&*rec_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;

    let mut rec_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut rec_nonce_bytes);

    let enc_mk_rec = cipher_rec
        .encrypt(Nonce::from_slice(&rec_nonce_bytes), master_key.0.as_ref())
        .map_err(|_| anyhow!("Failed to encrypt recovery slot"))?;

    // 5. Construct the JSON structure and save it to Disk
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

    // Return both the string recovery code (to show the user) and the MasterKey (to load into active RAM)
    Ok((recovery_code, master_key))
}

/// Attempts to unlock the keychain using the User's Password (Slot 1).
/// If successful, returns the decrypted Master Key for the active session.
pub fn unlock_keychain(path: &Path, password: &str) -> Result<MasterKey> {
    if !path.exists() {
        return Err(anyhow!("No keychain found. Please initialize first."));
    }

    let file = fs::File::open(path)?;
    let store: KeychainStore = serde_json::from_reader(file).context("Corrupted keychain file")?;

    // 1. Re-derive the KEK using the SAME parameters stored in the file.
    let kek = derive_kek(
        password,
        &store.password_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    )?;

    let cipher = Aes256Gcm::new_from_slice(&*kek).map_err(|e| anyhow!("Cipher init: {}", e))?;
    let nonce = Nonce::from_slice(&store.password_nonce);

    // 2. Attempt Decryption.
    // If the password was wrong, `derive_kek` succeeds, but `decrypt` fails because the AES-GCM Auth Tag won't match.
    // SECURITY: We immediately wrap the decrypted raw master key bytes in a `Zeroizing` vector.
    let mk_bytes: Zeroizing<Vec<u8>> = Zeroizing::new(
        cipher
            .decrypt(nonce, store.encrypted_master_key_pass.as_ref())
            .map_err(|_| anyhow!("Incorrect Password"))?,
    );

    // Sanity check to prevent out-of-bounds crashes
    if mk_bytes.len() != 32 {
        return Err(anyhow!("Keychain is corrupt: invalid master key length"));
    }

    // Move the bytes into our secure `MasterKey` array struct
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&mk_bytes);

    Ok(MasterKey(arr))
}

/// Used when the user forgets their primary password.
/// 1. Unlocks the vault using the Recovery Code (Slot 2).
/// 2. Immediately re-encrypts the Master Key with a NEW password provided by the user (Updating Slot 1).
pub fn recover_with_code(
    path: &Path,
    recovery_code: &str,
    new_password: &str,
) -> Result<MasterKey> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Decrypt Master Key using Recovery Code (Slot 2).
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

    // Securely hold the decrypted master key
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
    // `mk_bytes` drops and zeroizes here.

    // 2. Re-encrypt the extracted Master Key with the NEW Password (Slot 1).
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

    // 3. Update the JSON Store and Save it
    // NOTE: Because we are only updating the keychain, the terabytes of files the user encrypted
    // over the years do NOT need to be re-encrypted! The Master Key never changed.
    store.password_salt = new_pass_salt;
    store.password_nonce = new_pass_nonce_bytes.to_vec();
    store.encrypted_master_key_pass = new_enc_mk_pass;

    let outfile = fs::File::create(path)?;
    serde_json::to_writer_pretty(outfile, &store)?;

    Ok(master_key)
}

/// Generates a new Recovery Code and updates Slot 2.
/// Useful if the user suspects someone found the piece of paper where they wrote down their recovery code.
pub fn reset_recovery_code(path: &Path, master_key: &MasterKey) -> Result<String> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Generate NEW string Recovery Code
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

    // 2. Derive new KEK and Encrypt the active Master Key with the new code.
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

    // 3. Update Store and save
    store.recovery_salt = rec_salt;
    store.recovery_nonce = rec_nonce_bytes.to_vec();
    store.encrypted_master_key_recovery = enc_mk_rec;

    let outfile = fs::File::create(path)?;
    serde_json::to_writer_pretty(outfile, &store)?;

    Ok(recovery_code)
}

/// Changes the main User Password (Slot 1) while the user is already logged in.
/// This functions exactly like Step 2 of the `recover_with_code` function.
pub fn change_password(path: &Path, master_key: &MasterKey, new_password: &str) -> Result<()> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Generate new Salt
    let new_pass_salt = SaltString::generate(&mut OsRng).as_str().to_string();

    // 2. Derive new Key Encryption Key (KEK) using the new password.
    let new_pass_kek = derive_kek(
        new_password,
        &new_pass_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    )?;
    let cipher_pass =
        Aes256Gcm::new_from_slice(&*new_pass_kek).map_err(|e| anyhow!("Cipher init: {}", e))?;

    // 3. Encrypt the existing active Master Key with the new KEK
    let mut new_pass_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut new_pass_nonce_bytes);

    let new_enc_mk_pass = cipher_pass
        .encrypt(
            Nonce::from_slice(&new_pass_nonce_bytes),
            master_key.0.as_ref(),
        )
        .map_err(|e| anyhow!("Failed to encrypt with new password: {}", e))?;

    // 4. Update JSON Store
    store.password_salt = new_pass_salt;
    store.password_nonce = new_pass_nonce_bytes.to_vec();
    store.encrypted_master_key_pass = new_enc_mk_pass;

    // 5. Save to Disk
    let outfile = fs::File::create(path)?;
    serde_json::to_writer_pretty(outfile, &store)?;

    Ok(())
}

/// Simple utility check to see if a vault file exists on disk yet.
pub fn keychain_exists(path: &Path) -> bool {
    path.exists()
}

// --- END OF FILE keychain.rs ---
