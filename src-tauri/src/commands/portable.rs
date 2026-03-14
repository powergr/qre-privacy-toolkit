// --- START OF FILE portable.rs ---

use crate::keychain::MasterKey;
use crate::state::SessionState;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Result};
use argon2::password_hash::rand_core::OsRng as Argon2OsRng;
use argon2::password_hash::SaltString;
use argon2::{Algorithm, Argon2, Params, PasswordHasher, Version};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use zeroize::Zeroizing;

#[cfg(not(target_os = "android"))]
use sysinfo::Disks;

pub type CommandResult<T> = Result<T, String>;
const NONCE_LEN: usize = 12;

// ==========================================
// --- DATA STRUCTURES ---
// ==========================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DriveInfo {
    pub path: String,
    pub name: String,
    pub free_space: u64,
    pub total_space: u64,
    pub is_qre_portable: bool,
    /// UUID read from keychain.qre at scan time.
    /// Shown in the unlock modal for out-of-band evil-maid verification (S-05).
    pub vault_uuid: Option<String>,
}

#[derive(Deserialize)]
pub enum KdfTier {
    Standard, // 256 MB RAM, 5 Iterations
    High,     // 512 MB RAM, 8 Iterations
    Paranoid, // 1 GB RAM,  10 Iterations
    // Fast params used only in `cargo test` — never exposed to production.
    #[cfg(test)]
    Test, // 8 MB RAM, 1 Iteration, 1 Thread
}

impl KdfTier {
    pub(crate) fn get_params(&self) -> (u32, u32, u32) {
        match self {
            KdfTier::Standard => (262_144, 5, 4),
            KdfTier::High => (524_288, 8, 4),
            KdfTier::Paranoid => (1_048_576, 10, 4),
            #[cfg(test)]
            KdfTier::Test => (8_192, 1, 1),
        }
    }
}

/// Identical to the local keychain, but stores the UUID natively.
#[derive(Serialize, Deserialize, Debug)]
pub struct PortableKeychainStore {
    pub vault_id: String,
    pub kdf_memory: u32,
    pub kdf_iterations: u32,
    pub kdf_parallelism: u32,
    pub password_salt: String,
    pub password_nonce: Vec<u8>,
    pub encrypted_master_key_pass: Vec<u8>,
    pub recovery_salt: String,
    pub recovery_nonce: Vec<u8>,
    pub encrypted_master_key_recovery: Vec<u8>,
}

// ==========================================
// --- CORE CRYPTO (Isolated for USB) ---
// ==========================================

fn derive_kek(
    secret: &str,
    salt_str: &str,
    mem: u32,
    iter: u32,
    par: u32,
) -> Result<Zeroizing<[u8; 32]>> {
    let params =
        Params::new(mem, iter, par, Some(32)).map_err(|e| anyhow!("KDF param error: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::from_b64(salt_str).map_err(|_| anyhow!("Invalid salt"))?;

    let hash = argon2
        .hash_password(secret.as_bytes(), &salt)
        .map_err(|_| anyhow!("Hashing failed"))?;
    let hash_bytes = hash.hash.ok_or_else(|| anyhow!("No KDF output"))?;

    let mut key = [0u8; 32];
    key.copy_from_slice(hash_bytes.as_bytes());
    Ok(Zeroizing::new(key))
}

// ==========================================
// --- COMMANDS ---
// ==========================================

/// Scans the system for Removable USB Drives.
#[tauri::command]
pub fn enumerate_removable_drives() -> CommandResult<Vec<DriveInfo>> {
    #[cfg(target_os = "android")]
    {
        Ok(vec![]) // Handled via SAF File Picker on Android (Phase 4)
    }
    #[cfg(not(target_os = "android"))]
    {
        let mut results = Vec::new();
        let disks = Disks::new_with_refreshed_list();

        for disk in disks.list() {
            if disk.is_removable() {
                let path = disk.mount_point().to_string_lossy().to_string();
                let is_qre_portable = disk.mount_point().join(".qre_portable").exists();

                // Read the vault UUID from keychain.qre so the unlock modal can
                // display it for out-of-band evil-maid verification (S-05).
                let vault_uuid = if is_qre_portable {
                    let kc = disk
                        .mount_point()
                        .join(".qre_portable")
                        .join("keychain.qre");
                    fs::File::open(&kc)
                        .ok()
                        .and_then(|f| serde_json::from_reader::<_, PortableKeychainStore>(f).ok())
                        .map(|s| s.vault_id)
                } else {
                    None
                };

                results.push(DriveInfo {
                    path,
                    name: disk.name().to_string_lossy().to_string(),
                    free_space: disk.available_space(),
                    total_space: disk.total_space(),
                    is_qre_portable,
                    vault_uuid,
                });
            }
        }
        Ok(results)
    }
}

/// Formats a USB drive as a Portable QRE Vault.
#[tauri::command]
pub fn init_portable_vault(
    drive_path: String,
    password: String,
    tier: KdfTier,
) -> CommandResult<(String, String)> {
    #[cfg(target_os = "android")]
    {
        let _ = (drive_path, password, tier);
        return Err("Portable initialization not supported directly on Android yet.".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        let base_path = PathBuf::from(&drive_path);
        if !base_path.exists() {
            return Err("Drive not found.".to_string());
        }

        let qre_dir = base_path.join(".qre_portable");
        if qre_dir.exists() {
            return Err("Drive is already formatted as a QRE vault.".to_string());
        }

        fs::create_dir_all(&qre_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(base_path.join("Secure_Locker")).map_err(|e| e.to_string())?;

        // Cross-platform attempt to hide the directory (Windows specific flag)
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("attrib")
                .args(["+h", qre_dir.to_str().unwrap()])
                .output();
        }

        let (mem, iter, par) = tier.get_params();
        let vault_id = uuid::Uuid::new_v4().to_string();

        let mut rng = rand::rng();

        let mut mk_bytes = [0u8; 32];
        rng.fill(&mut mk_bytes);
        let master_key = MasterKey(mk_bytes);

        // --- SALT GENERATION ---
        // SaltString::generate uses the provided RNG to produce a properly encoded
        // PHC base64 salt. This is the correct API — from_b64 is for loading an
        // existing encoded salt, not creating a new one.
        let pass_salt = SaltString::generate(&mut Argon2OsRng).as_str().to_string();

        let pass_kek =
            derive_kek(&password, &pass_salt, mem, iter, par).map_err(|e| e.to_string())?;
        let cipher_pass = Aes256Gcm::new_from_slice(&*pass_kek).unwrap();

        let mut pass_nonce_bytes = [0u8; NONCE_LEN];
        rng.fill(&mut pass_nonce_bytes);

        let enc_mk_pass = cipher_pass
            .encrypt(Nonce::from_slice(&pass_nonce_bytes), master_key.0.as_ref())
            .unwrap();

        // Recovery Slot
        // FIX: rand::random::<u16>() gave only 64 bits total (4 × 16 bits).
        // Using u32 with {:08X} gives 128 bits (4 × 32 bits), matching the
        // implementation plan and keychain.rs.
        let raw_recovery: String = (0..4)
            .map(|_| format!("{:08X}", rand::random::<u32>()))
            .collect::<Vec<_>>()
            .join("-");
        let recovery_code = format!("QRE-{}", raw_recovery);

        let rec_salt = SaltString::generate(&mut Argon2OsRng).as_str().to_string();

        let rec_kek =
            derive_kek(&recovery_code, &rec_salt, mem, iter, par).map_err(|e| e.to_string())?;
        let cipher_rec = Aes256Gcm::new_from_slice(&*rec_kek).unwrap();

        let mut rec_nonce_bytes = [0u8; NONCE_LEN];
        rng.fill(&mut rec_nonce_bytes);

        let enc_mk_rec = cipher_rec
            .encrypt(Nonce::from_slice(&rec_nonce_bytes), master_key.0.as_ref())
            .unwrap();

        let store = PortableKeychainStore {
            vault_id: vault_id.clone(),
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

        let file = fs::File::create(qre_dir.join("keychain.qre")).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(file, &store).map_err(|e| e.to_string())?;

        Ok((recovery_code, vault_id))
    }
}

/// Core unlock logic, extracted so tests can call it without tauri::State.
/// The Tauri command is a thin wrapper around this function.
pub(crate) fn unlock_vault_from_drive(
    drive_path: &str,
    password: &str,
    vaults: &std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<crate::state::VaultId, MasterKey>>,
    >,
    mounts: &std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<String, crate::state::VaultId>>,
    >,
) -> CommandResult<String> {
    let keychain_path = PathBuf::from(drive_path)
        .join(".qre_portable")
        .join("keychain.qre");

    if !keychain_path.exists() {
        return Err("Portable vault not found on this drive.".to_string());
    }

    let file = fs::File::open(&keychain_path).map_err(|e| e.to_string())?;
    let store: PortableKeychainStore =
        serde_json::from_reader(file).map_err(|_| "Corrupted keychain".to_string())?;

    let kek = derive_kek(
        password,
        &store.password_salt,
        store.kdf_memory,
        store.kdf_iterations,
        store.kdf_parallelism,
    )
    .map_err(|e| e.to_string())?;

    let cipher = Aes256Gcm::new_from_slice(&*kek).unwrap();
    let nonce = Nonce::from_slice(&store.password_nonce);

    let mk_bytes: Zeroizing<Vec<u8>> = Zeroizing::new(
        cipher
            .decrypt(nonce, store.encrypted_master_key_pass.as_ref())
            .map_err(|_| "Incorrect Password".to_string())?,
    );

    if mk_bytes.len() != 32 {
        return Err("Invalid master key length".to_string());
    }

    let mut arr = [0u8; 32];
    arr.copy_from_slice(&mk_bytes);
    let master_key = MasterKey(arr);
    let vault_id = store.vault_id.clone();

    // Register key in the shared map.
    {
        let mut guard = vaults.lock().unwrap();
        guard.insert(vault_id.clone(), master_key);
    }

    // Register drive path → vault UUID so files.rs can route by path.
    {
        let mut guard = mounts.lock().unwrap();
        guard.insert(drive_path.to_string(), vault_id.clone());
    }

    // SECURITY FIX S-03: Spawn a watcher thread that zeroizes the key if the
    // drive is physically ejected while the vault is still unlocked.
    let watch_path = keychain_path.clone();
    let vaults_arc = vaults.clone();
    let mounts_arc = mounts.clone();
    let drive_path_owned = drive_path.to_string();
    let vid_clone = vault_id.clone();

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));

            // Drive ejected — path disappeared.
            if !watch_path.exists() {
                if let Ok(mut guard) = vaults_arc.lock() {
                    guard.remove(&vid_clone);
                    println!("🔒 Portable Drive Ejected. Master Key wiped from RAM.");
                }
                if let Ok(mut guard) = mounts_arc.lock() {
                    guard.remove(&drive_path_owned);
                }
                break;
            }

            // User locked via UI — stop the watcher.
            if let Ok(guard) = vaults_arc.lock() {
                if !guard.contains_key(&vid_clone) {
                    if let Ok(mut mg) = mounts_arc.lock() {
                        mg.remove(&drive_path_owned);
                    }
                    break;
                }
            }
        }
    });

    Ok(vault_id)
}

/// Unlocks a portable USB vault and spawns a background Watcher to monitor for sudden drive removal.
#[tauri::command]
pub fn unlock_portable_vault(
    _app: AppHandle,
    state: tauri::State<SessionState>,
    drive_path: String,
    password: String,
) -> CommandResult<String> {
    unlock_vault_from_drive(
        &drive_path,
        &password,
        &state.vaults,
        &state.portable_mounts,
    )
}

/// Core lock logic, extracted so tests can call it without tauri::State.
pub(crate) fn lock_vault_by_id(
    vault_id: &str,
    vaults: &std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<crate::state::VaultId, MasterKey>>,
    >,
    mounts: &std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<String, crate::state::VaultId>>,
    >,
) -> CommandResult<()> {
    let mut guard = vaults
        .lock()
        .map_err(|_| "Session state corrupted".to_string())?;
    guard.remove(vault_id);

    // Remove any drive path that maps to this vault UUID.
    if let Ok(mut mg) = mounts.lock() {
        mg.retain(|_, v| v != vault_id);
    }
    Ok(())
}

/// Manually locks the portable vault, wiping it from RAM.
#[tauri::command]
pub fn lock_portable_vault(
    state: tauri::State<SessionState>,
    vault_id: String,
) -> CommandResult<()> {
    lock_vault_by_id(&vault_id, &state.vaults, &state.portable_mounts)
}

// --- END OF FILE portable.rs ---
