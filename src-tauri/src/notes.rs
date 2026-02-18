use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Represents a single encrypted note.
/// SECURITY: Fields are zeroed in memory when dropped to prevent RAM scraping.
#[derive(Serialize, Deserialize, Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct NoteEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: i64, // Unix seconds
    pub updated_at: i64, // Unix seconds
    #[serde(default)]
    pub is_pinned: bool,
}

/// The root container for the Secure Notes.
#[derive(Serialize, Deserialize, Debug, Default, Zeroize, ZeroizeOnDrop)]
pub struct NotesVault {
    #[serde(default = "NotesVault::default_schema_version")]
    pub schema_version: u32,
    pub entries: Vec<NoteEntry>,
}

impl NotesVault {
    pub const CURRENT_SCHEMA_VERSION: u32 = 1;

    fn default_schema_version() -> u32 {
        1
    }

    pub fn new() -> Self {
        Self {
            schema_version: Self::CURRENT_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }

    /// Validates the vault to prevent corruption before saving/loading
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version > Self::CURRENT_SCHEMA_VERSION {
            return Err(format!(
                "Vault version {} is too new. Update app.",
                self.schema_version
            ));
        }
        let mut seen_ids = std::collections::HashSet::new();
        for note in &self.entries {
            if note.id.is_empty() {
                return Err("Note has empty ID".into());
            }
            if !seen_ids.insert(&note.id) {
                return Err(format!("Duplicate ID: {}", note.id));
            }
        }
        Ok(())
    }
}
