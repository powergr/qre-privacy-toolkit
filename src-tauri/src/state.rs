use crate::keychain::MasterKey;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type VaultId = String; // E.g., "local" or "D:\"

/// Represents the global runtime state of the application.
/// Now manages multiple unlocked vaults simultaneously (Local + Portable USBs).
pub struct SessionState {
    pub vaults: Arc<Mutex<HashMap<VaultId, MasterKey>>>,
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            vaults: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
