use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Serialize, Deserialize, Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct VaultEntry {
    pub id: String,

    /// The name of the website or service (e.g., "Google", "Netflix").
    pub service: String,

    /// The login username or email address.
    pub username: String,

    /// The secret password.
    ///
    /// SECURITY: This field is zeroed in memory on drop via ZeroizeOnDrop.
    pub password: String,

    /// Optional free-text notes (may contain recovery codes — also zeroed on drop).
    pub notes: String,

    pub created_at: i64,

    #[serde(default)]
    pub updated_at: i64,

    // --- FIELDS (v2.5.5+) ---
    // #[serde(default)] lets existing vaults load without crashing.
    /// The website URL (e.g., "https://google.com").
    #[serde(default)]
    pub url: String,

    /// The visual card color (Hex Code).
    #[serde(default)]
    pub color: String,

    /// Whether the entry is pinned to the top.
    #[serde(default)]
    pub is_pinned: bool,
}
#[derive(Serialize, Deserialize, Debug, Default, Zeroize, ZeroizeOnDrop)]
pub struct PasswordVault {
    #[serde(default = "PasswordVault::default_schema_version")]
    pub schema_version: u32,

    pub entries: Vec<VaultEntry>,
}

impl PasswordVault {
    pub const CURRENT_SCHEMA_VERSION: u32 = 1;

    fn default_schema_version() -> u32 {
        // Old vaults without a schema_version field are treated as v1.
        1
    }

    /// Creates a new, empty vault.
    pub fn new() -> Self {
        Self {
            schema_version: Self::CURRENT_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
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
            if entry.id.is_empty() {
                return Err("Vault contains an entry with an empty ID.".to_string());
            }
            if !seen_ids.insert(&entry.id) {
                return Err(format!(
                    "Vault contains duplicate entry ID: '{}'. The file may be corrupted.",
                    entry.id
                ));
            }
        }
        Ok(())
    }
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
