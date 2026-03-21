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
    pub id: String,
    pub service: String,
    pub username: String,
    pub password: String,
    pub notes: String,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub is_pinned: bool,

    // --- NEW: OFFLINE 2FA (TOTP) ---
    // The secret key (usually a base32 string) provided by the website to generate 2FA codes.
    #[serde(default)]
    pub totp_secret: Option<String>,
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

// ==========================================
// --- TESTS ---
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    // Helper to create a valid, fully populated vault entry
    fn create_valid_entry(id: &str) -> VaultEntry {
        VaultEntry {
            id: id.to_string(),
            service: "GitHub".to_string(),
            username: "testuser".to_string(),
            password: "super_secret_password_123!".to_string(),
            notes: "2FA recovery codes".to_string(),
            created_at: 1700000000,
            updated_at: 1700000000,
            url: "https://github.com".to_string(),
            color: "#000000".to_string(),
            is_pinned: false,
            totp_secret: None,
        }
    }

    // --- Validation Tests ---

    #[test]
    fn test_vault_creation_defaults() {
        let vault = PasswordVault::new();
        assert_eq!(vault.schema_version, 1);
        assert!(vault.entries.is_empty());
        assert!(vault.validate().is_ok());
    }

    #[test]
    fn test_validation_passes_valid_entries() {
        let mut vault = PasswordVault::new();
        vault.entries.push(create_valid_entry("uuid-1"));
        vault.entries.push(create_valid_entry("uuid-2"));

        assert!(
            vault.validate().is_ok(),
            "Valid vault should pass validation"
        );
    }

    #[test]
    fn test_validation_fails_empty_id() {
        let mut vault = PasswordVault::new();
        vault.entries.push(create_valid_entry("")); // Empty ID

        let result = vault.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty ID"));
    }

    #[test]
    fn test_validation_fails_duplicate_id() {
        let mut vault = PasswordVault::new();
        vault.entries.push(create_valid_entry("same-id"));
        vault.entries.push(create_valid_entry("same-id")); // Duplicate

        let result = vault.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("duplicate entry ID"));
    }

    #[test]
    fn test_validation_fails_future_schema() {
        let mut vault = PasswordVault::new();
        // Simulate a user trying to load a V2 vault into a V1 application
        vault.schema_version = PasswordVault::CURRENT_SCHEMA_VERSION + 1;

        let result = vault.validate();
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("newer than this application supports"));
    }

    // --- Mutation Logic Tests ---

    #[test]
    fn test_add_entry() {
        let mut vault = PasswordVault::new();
        let entry = create_valid_entry("id-1");

        // Add first time should succeed
        assert!(vault.add_entry(entry.clone()).is_ok());
        assert_eq!(vault.entries.len(), 1);

        // Add same ID should fail
        assert!(vault.add_entry(entry).is_err());
    }

    #[test]
    fn test_update_entry() {
        let mut vault = PasswordVault::new();
        vault.add_entry(create_valid_entry("id-1")).unwrap();

        // Update existing entry
        let mut updated = create_valid_entry("id-1");
        updated.password = "NEW_PASSWORD".to_string();
        assert!(vault.update_entry(updated).is_ok());

        assert_eq!(vault.entries[0].password, "NEW_PASSWORD");

        // Try to update non-existent entry
        let missing = create_valid_entry("id-999");
        assert!(vault.update_entry(missing).is_err());
    }
}
// --- END OF FILE vault.rs ---
