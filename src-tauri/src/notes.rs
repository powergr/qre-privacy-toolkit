use serde::{Deserialize, Serialize};

/// Represents a single encrypted note.
///
/// Secure Notes are useful for storing sensitive text that doesn't fit
/// into a standard password field, such as Recovery Codes, PINs, or private diaries.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NoteEntry {
    /// Unique UUID to identify the note for updates/deletions.
    pub id: String,
    
    /// The title displayed in the list view.
    pub title: String,
    
    /// The main body of the note. 
    /// Since the entire vault is encrypted, this text is secure on disk.
    pub content: String,
    
    /// Timestamp of creation (Unix Epoch).
    pub created_at: i64,
    
    /// Timestamp of last modification. Used for sorting.
    pub updated_at: i64,
}

/// The root container for the Secure Notes feature.
///
/// This entire struct is serialized, compressed, and encrypted 
/// into `notes.qre` using the Master Key.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct NotesVault {
    pub entries: Vec<NoteEntry>,
}

impl NotesVault {
    /// Creates a new, empty notes vault.
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }
}