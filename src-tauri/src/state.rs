use crate::keychain::MasterKey;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type VaultId = String; // "local" or a portable vault UUID

/// Global runtime state for the application.
/// Manages all currently unlocked vaults (local + portable USB).
pub struct SessionState {
    /// Maps VaultId → MasterKey for every unlocked vault.
    /// "local" is the desktop vault; portable vault UUIDs are added on unlock.
    pub vaults: Arc<Mutex<HashMap<VaultId, MasterKey>>>,

    /// Maps drive mount paths (e.g. "D:\\", "/Volumes/MyUSB/") to their
    /// portable vault UUIDs. Populated on unlock, cleared on lock or ejection.
    /// Used by files.rs for:
    ///   - Ghost-file detection: reject encrypt if source is on a portable drive.
    ///   - Vault routing: use the correct key when decrypting a file on a USB drive.
    pub portable_mounts: Arc<Mutex<HashMap<String, VaultId>>>,
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            vaults: Arc::new(Mutex::new(HashMap::new())),
            portable_mounts: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
