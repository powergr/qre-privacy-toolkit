use crate::keychain::MasterKey;
use std::sync::{Arc, Mutex};

/// Represents the global runtime state of the application.
///
/// It primarily holds the **Master Key** in memory (RAM) while the user is logged in.
/// The structure uses specific wrappers to ensure thread safety:
/// - `Arc`: Allows the state to be shared safely across multiple threads.
/// - `Mutex`: Ensures only one process can access or modify the key at a time to prevent data races.
/// - `Option`: The key is `Some(key)` when unlocked, and `None` when locked.
pub struct SessionState {
    pub master_key: Arc<Mutex<Option<MasterKey>>>,
}