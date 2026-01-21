use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NoteEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct NotesVault {
    pub entries: Vec<NoteEntry>,
}

impl NotesVault {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }
}