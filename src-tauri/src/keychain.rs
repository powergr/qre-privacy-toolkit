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
use zeroize::{Zeroize, ZeroizeOnDrop};

const NONCE_LEN: usize = 12;

// --- Defaults for Backward Compatibility ---
fn default_kdf_memory() -> u32 {
    19456
}
fn default_kdf_iterations() -> u32 {
    2
}
fn default_kdf_parallelism() -> u32 {
    1
}

// --- Data Structures ---

#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct MasterKey(pub [u8; 32]);

#[derive(Serialize, Deserialize, Debug)]
pub struct KeychainStore {
    pub vault_id: String,

    #[serde(default = "default_kdf_memory")]
    pub kdf_memory: u32,
    #[serde(default = "default_kdf_iterations")]
    pub kdf_iterations: u32,
    #[serde(default = "default_kdf_parallelism")]
    pub kdf_parallelism: u32,

    pub password_salt: String,
    pub password_nonce: Vec<u8>,
    pub encrypted_master_key_pass: Vec<u8>,

    pub recovery_salt: String,
    pub recovery_nonce: Vec<u8>,
    pub encrypted_master_key_recovery: Vec<u8>,
}

// --- Logic ---

// CHANGED: Now accepts dynamic parameters
fn derive_kek(secret: &str, salt_str: &str, mem: u32, iter: u32, par: u32) -> [u8; 32] {
    let params = Params::new(mem, iter, par, Some(32)).unwrap();
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::from_b64(salt_str).expect("Invalid salt");

    let hash = argon2
        .hash_password(secret.as_bytes(), &salt)
        .expect("Hashing failed");
    let mut key = [0u8; 32];
    key.copy_from_slice(hash.hash.unwrap().as_bytes());
    key
}

/// Create a NEW Keychain (Onboarding)
pub fn init_keychain(path: &Path, password: &str) -> Result<(String, MasterKey)> {
    if path.exists() {
        return Err(anyhow!("Keychain already exists."));
    }

    // 1. Define KDF Settings for this new vault
    let mem = default_kdf_memory();
    let iter = default_kdf_iterations();
    let par = default_kdf_parallelism();

    // 2. Generate Master Key
    let mut mk_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut mk_bytes);
    let master_key = MasterKey(mk_bytes);

    // 3. Prepare Password Slot
    let pass_salt = SaltString::generate(&mut OsRng).as_str().to_string();
    let pass_kek = derive_kek(password, &pass_salt, mem, iter, par);
    let cipher_pass = Aes256Gcm::new_from_slice(&pass_kek).unwrap();

    let mut pass_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut pass_nonce_bytes);

    let enc_mk_pass = cipher_pass
        .encrypt(Nonce::from_slice(&pass_nonce_bytes), master_key.0.as_ref())
        .map_err(|e| anyhow!("Failed to encrypt master key: {}", e))?;

    // 4. Prepare Recovery Slot
    let raw_recovery: String = (0..4)
        .map(|_| {
            let n: u16 = rand::random();
            format!("{:04X}", n)
        })
        .collect::<Vec<String>>()
        .join("-");
    let recovery_code = format!("QRE-{}", raw_recovery);

    let rec_salt = SaltString::generate(&mut OsRng).as_str().to_string();
    let rec_kek = derive_kek(&recovery_code, &rec_salt, mem, iter, par);
    let cipher_rec = Aes256Gcm::new_from_slice(&rec_kek).unwrap();

    let mut rec_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut rec_nonce_bytes);

    let enc_mk_rec = cipher_rec
        .encrypt(Nonce::from_slice(&rec_nonce_bytes), master_key.0.as_ref())
        .map_err(|_| anyhow!("Failed to encrypt recovery slot"))?;

    // 5. Save
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

/// Unlock the Keychain with Password
pub fn unlock_keychain(path: &Path, password: &str) -> Result<MasterKey> {
    if !path.exists() {
        return Err(anyhow!("No keychain found. Please initialize first."));
    }

    let file = fs::File::open(path)?;
    let store: KeychainStore = serde_json::from_reader(file).context("Corrupted keychain file")?;

    // Use stored params (or defaults if missing)
    let kek = derive_kek(
        password,
        &store.password_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    );

    let cipher = Aes256Gcm::new_from_slice(&kek).unwrap();
    let nonce = Nonce::from_slice(&store.password_nonce);

    let mk_bytes = cipher
        .decrypt(nonce, store.encrypted_master_key_pass.as_ref())
        .map_err(|_| anyhow!("Incorrect Password"))?;

    let mut arr = [0u8; 32];
    arr.copy_from_slice(&mk_bytes);

    Ok(MasterKey(arr))
}

/// Recover the Vault using the Recovery Code and set a NEW Password.
pub fn recover_with_code(
    path: &Path,
    recovery_code: &str,
    new_password: &str,
) -> Result<MasterKey> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Decrypt with Recovery Code
    let rec_kek = derive_kek(
        recovery_code,
        &store.recovery_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    );
    let cipher_rec = Aes256Gcm::new_from_slice(&rec_kek).unwrap();
    let nonce_rec = Nonce::from_slice(&store.recovery_nonce);

    let mk_bytes = cipher_rec
        .decrypt(nonce_rec, store.encrypted_master_key_recovery.as_ref())
        .map_err(|_| anyhow!("Invalid Recovery Code"))?;

    let master_key = MasterKey(mk_bytes.clone().try_into().unwrap());

    // 2. Re-encrypt with NEW Password (using SAME KDF params)
    let new_pass_salt = SaltString::generate(&mut OsRng).as_str().to_string();
    let new_pass_kek = derive_kek(
        new_password,
        &new_pass_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    );
    let cipher_pass = Aes256Gcm::new_from_slice(&new_pass_kek).unwrap();

    let mut new_pass_nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut new_pass_nonce_bytes);

    let new_enc_mk_pass = cipher_pass
        .encrypt(
            Nonce::from_slice(&new_pass_nonce_bytes),
            master_key.0.as_ref(),
        )
        .map_err(|e| anyhow!("Failed to encrypt with new password: {}", e))?;

    // 3. Update Store
    store.password_salt = new_pass_salt;
    store.password_nonce = new_pass_nonce_bytes.to_vec();
    store.encrypted_master_key_pass = new_enc_mk_pass;

    let outfile = fs::File::create(path)?;
    serde_json::to_writer_pretty(outfile, &store)?;

    Ok(master_key)
}

/// Rotates the Recovery Code (Requires Decrypted MasterKey)
pub fn reset_recovery_code(path: &Path, master_key: &MasterKey) -> Result<String> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Generate NEW Recovery Code
    let raw_recovery: String = (0..4)
        .map(|_| {
            let n: u16 = rand::random();
            format!("{:04X}", n)
        })
        .collect::<Vec<String>>()
        .join("-");
    let recovery_code = format!("QRE-{}", raw_recovery);

    // 2. Encrypt Master Key with NEW Code
    let rec_salt = SaltString::generate(&mut OsRng).as_str().to_string();
    let rec_kek = derive_kek(
        &recovery_code,
        &rec_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    );
    let cipher_rec = Aes256Gcm::new_from_slice(&rec_kek).unwrap();

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

/// Change Password (requires being logged in / having the decrypted MasterKey)
pub fn change_password(path: &Path, master_key: &MasterKey, new_password: &str) -> Result<()> {
    let file = fs::File::open(path)?;
    let mut store: KeychainStore = serde_json::from_reader(file)?;

    // 1. Generate new Salt
    let new_pass_salt = SaltString::generate(&mut OsRng).as_str().to_string();

    // 2. Derive new KEK
    let new_pass_kek = derive_kek(
        new_password,
        &new_pass_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    );
    let cipher_pass = Aes256Gcm::new_from_slice(&new_pass_kek).unwrap();

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

pub fn keychain_exists(path: &Path) -> bool {
    path.exists()
}
