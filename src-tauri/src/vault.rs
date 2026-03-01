// --- START OF FILE vault.rs ---

use serde::{Deserialize, Serialize};
// Zeroize prevents memory forensics by explicitly overwriting sensitive variables
// in RAM with zeroes (`0x00`) the exact moment they drop out of scope.
use zeroize::{Zeroize, ZeroizeOnDrop};

// ==========================================
// --- DATA STRUCTURES ---
// ==========================================

/// Represents a single saved password entry in the user's vault.
///
/// SECURITY IMPLEMENTATION:
/// By deriving `Zeroize` and `ZeroizeOnDrop`, the Rust compiler automatically injects
/// a `Drop` trait implementation. When the vault is locked or the app is closed,
/// the highly sensitive fields (`password`, `notes`, `username`) are aggressively
/// scrubbed from the system's RAM, preventing attackers or malware from extracting
/// the plaintext data via memory dumps.
#[derive(Serialize, Deserialize, Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct VaultEntry {
    pub id: String, // Unique UUID for precise frontend rendering and database updates

    /// The name of the website or service (e.g., "Google", "Netflix").
    pub service: String,

    /// The login username or email address.
    pub username: String,

    /// The secret password.
    ///
    /// SECURITY: This field is zeroed in memory on drop via ZeroizeOnDrop.
    pub password: String,

    /// Optional free-text notes.
    /// (Often contains highly sensitive 2FA recovery codes — also zeroed on drop).
    pub notes: String,

    pub created_at: i64, // Unix timestamp in seconds

    // `#[serde(default)]` allows older vault files that didn't have this field
    // to load successfully. The deserializer will just fill it with `0`.
    #[serde(default)]
    pub updated_at: i64,

    // --- NEW FIELDS (v2.5.5+) ---
    // The following fields were added in a later update. `#[serde(default)]` ensures
    // that when an older V1 vault is loaded, it doesn't crash the app. Instead, it
    // initializes these with empty strings/false booleans. When the user saves next,
    // the vault is seamlessly upgraded to the new schema.
    /// The website URL (e.g., "https://google.com").
    #[serde(default)]
    pub url: String,

    /// The visual card color (Hex Code) used to customize the UI.
    #[serde(default)]
    pub color: String,

    /// Whether the entry is pinned to the top of the user's list.
    #[serde(default)]
    pub is_pinned: bool,
}

/// The root container for the Password Vault.
/// This entire struct is serialized into JSON and encrypted into the `passwords.qre` file.
#[derive(Serialize, Deserialize, Debug, Default, Zeroize, ZeroizeOnDrop)]
pub struct PasswordVault {
    // Schema versioning allows for safe, backwards-compatible updates.
    #[serde(default = "PasswordVault::default_schema_version")]
    pub schema_version: u32,

    pub entries: Vec<VaultEntry>,
}

impl PasswordVault {
    // Defines the current data structure version expected by this backend build
    pub const CURRENT_SCHEMA_VERSION: u32 = 1;

    fn default_schema_version() -> u32 {
        // Old vaults created before the versioning system was implemented are treated as v1.
        1
    }

    /// Creates a new, empty password vault.
    pub fn new() -> Self {
        Self {
            schema_version: Self::CURRENT_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }

    // ==========================================
    // --- DATA INTEGRITY & VALIDATION ---
    // ==========================================

    /// Validates the internal integrity of the vault.
    /// This is strictly called *before* saving the vault to disk. It acts as a safety net
    /// against frontend bugs that might otherwise corrupt the user's encrypted file.
    pub fn validate(&self) -> Result<(), String> {
        // Forward-compatibility check: Prevent an older version of the app from
        // overwriting and corrupting a vault created by a newer version of the app.
        if self.schema_version > Self::CURRENT_SCHEMA_VERSION {
            return Err(format!(
                "Vault schema version {} is newer than this application supports (max: {}). \
                 Please update the application.",
                self.schema_version,
                Self::CURRENT_SCHEMA_VERSION
            ));
        }

        let mut seen_ids = std::collections::HashSet::new();
        for entry in &self.entries {
            // Ensure the frontend didn't pass a broken object
            if entry.id.is_empty() {
                return Err("Vault contains an entry with an empty ID.".to_string());
            }
            // Ensure strictly unique IDs to prevent React rendering bugs or data overwrites
            if !seen_ids.insert(&entry.id) {
                return Err(format!(
                    "Vault contains duplicate entry ID: '{}'. The file may be corrupted.",
                    entry.id
                ));
            }
        }
        Ok(())
    }

    // ==========================================
    // --- HELPER MUTATIONS ---
    // ==========================================
    // #[allow(dead_code)] is used because currently, the React frontend manipulates
    // the JSON array directly and sends the whole payload back to be validated and saved.
    // These remain here for future backend-only modifications or CLI tools.

    #[allow(dead_code)]
    pub fn add_entry(&mut self, entry: VaultEntry) -> Result<(), String> {
        if entry.id.is_empty() {
            return Err("Entry ID must not be empty.".to_string());
        }
        if self.entries.iter().any(|e| e.id == entry.id) {
            return Err(format!("An entry with ID '{}' already exists.", entry.id));
        }
        self.entries.push(entry);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn update_entry(&mut self, updated: VaultEntry) -> Result<(), String> {
        let pos = self
            .entries
            .iter()
            .position(|e| e.id == updated.id)
            .ok_or_else(|| format!("No entry found with ID '{}'.", updated.id))?;
        self.entries[pos] = updated;
        Ok(())
    }
}

// --- END OF FILE vault.rs ---
