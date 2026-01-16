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

// --- Global Constants ---

/// The maximum file size the application will attempt to process.
/// Currently set to **4 GB** to prevent memory exhaustion, as files are currently loaded into RAM.
///
/// **Note:** This limit will be increased or removed in a later release.
/// Future updates will implement file streaming, allowing the application to process
/// files significantly larger than the available system memory.
pub const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024 * 1024; // 4GB