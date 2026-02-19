use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Serialize, Deserialize, Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct ClipboardEntry {
    pub id: String,
    pub content: String,
    pub preview: String,
    pub category: String,
    pub created_at: i64,

    /// FIX: Added Pinning support
    #[serde(default)]
    pub is_pinned: bool,
}

#[derive(Serialize, Deserialize, Debug, Default, Zeroize, ZeroizeOnDrop)]
pub struct ClipboardVault {
    #[serde(default = "ClipboardVault::default_schema_version")]
    pub schema_version: u32,
    pub entries: Vec<ClipboardEntry>,
}

impl ClipboardVault {
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

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version > Self::CURRENT_SCHEMA_VERSION {
            return Err(format!("Vault version {} is too new.", self.schema_version));
        }
        let mut seen_ids = std::collections::HashSet::new();
        for entry in &self.entries {
            if entry.id.is_empty() {
                return Err("Empty ID found".into());
            }
            if !seen_ids.insert(&entry.id) {
                return Err(format!("Duplicate ID: {}", entry.id));
            }
        }
        Ok(())
    }

    pub fn add_entry(&mut self, entry: ClipboardEntry) -> Result<(), String> {
        if entry.id.is_empty() {
            return Err("Empty ID".into());
        }
        if self.entries.iter().any(|e| e.id == entry.id) {
            return Err(format!("ID '{}' already exists.", entry.id));
        }
        self.entries.push(entry);
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RE-DOS SAFE DETECTION LOGIC
// ─────────────────────────────────────────────────────────────────────────────
pub fn analyze_content(text: &str) -> Option<String> {
    if text.len() > 100_000 {
        return Some("Text".to_string());
    }

    // 1. Credit Cards (Bounded)
    let card_regex = Regex::new(r"\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b").unwrap();
    if card_regex.is_match(text) {
        let nums = text.chars().filter(|c| c.is_numeric()).count();
        if nums >= 13 && nums <= 19 {
            return Some("Credit Card".to_string());
        }
    }

    // 2. IBAN
    let iban_regex = Regex::new(r"(?i)\b[A-Z]{2}\d{2}(?:[A-Z0-9]{4}[ ]?){3,7}\b").unwrap();
    if iban_regex.is_match(text) {
        return Some("Bank Info".to_string());
    }

    // 3. Crypto
    if text.starts_with("0x") && text.len() == 42 {
        if text[2..].chars().all(|c| c.is_ascii_hexdigit()) {
            return Some("Crypto Address".to_string());
        }
    }
    if text.len() >= 26 && text.len() <= 35 {
        let f = text.chars().next().unwrap_or(' ');
        if (f == '1' || f == '3' || f == 'b' || f == 'B')
            && text.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return Some("Crypto Address".to_string());
        }
    }

    // 4. API Keys
    if text.len() >= 16 && text.chars().filter(|c| *c == '-').count() >= 4 {
        return Some("Secret".to_string());
    }
    if text.starts_with("sk-")
        || text.starts_with("ghp_")
        || text.starts_with("eyJ")
        || text.starts_with("AKIA")
    {
        return Some("API Key".to_string());
    }

    // 5. Emails
    if text.contains('@') && text.chars().filter(|c| *c == '@').count() == 1 && text.len() < 100 {
        return Some("Email".to_string());
    }

    // 6. Links
    if text.starts_with("http") || (text.starts_with("www.") && text.contains('.')) {
        return Some("Link".to_string());
    }

    // 7. Passwords
    let has_upper = text.chars().any(|c| c.is_uppercase());
    let has_lower = text.chars().any(|c| c.is_lowercase());
    let has_digit = text.chars().any(|c| c.is_numeric());
    let has_special = text.chars().any(|c| !c.is_alphanumeric());
    let has_space = text.contains(' ');

    if !has_space && has_upper && has_lower && has_digit && text.len() >= 8 {
        return Some("Password".to_string());
    }
    if !has_space && has_lower && has_digit && has_special && text.len() >= 8 {
        return Some("Password".to_string());
    }

    Some("Text".to_string())
}

/// Creates a new clipboard entry with auto-detected category.
/// Creates a new clipboard entry with auto-detected category.
pub fn create_entry(text: &str) -> ClipboardEntry {
    let category = analyze_content(text).unwrap_or("Text".to_string());

    // FIX: Smart Redaction for sensitive types
    let preview = match category.as_str() {
        "Credit Card" => {
            // Keep first 4 and last 4, mask middle
            if text.len() > 8 {
                let end = text.len().saturating_sub(4);
                let start = 4;
                // Removed unused 'mask' variable calculation
                format!("{} **** **** **** {}", &text[0..start], &text[end..])
            } else {
                "****".to_string()
            }
        }
        "API Key" | "Secret" | "Password" => {
            // Show first 6 chars, mask rest
            if text.len() > 6 {
                format!("{}...", &text[0..6])
            } else {
                "***".to_string()
            }
        }
        "Bank Info" => {
            // IBAN: Show first 4 (Country/Check), mask rest
            if text.len() > 4 {
                format!("{} **** ****...", &text[0..4])
            } else {
                "****".to_string()
            }
        }
        _ => {
            // Standard Text / Links: Truncate at 60
            let max_len = 60;
            if text.len() > max_len {
                let truncated = &text[0..max_len];
                format!("{}...", truncated.replace("\n", " ").trim())
            } else {
                text.replace("\n", " ").trim().to_string()
            }
        }
    };

    ClipboardEntry {
        id: Uuid::new_v4().to_string(),
        content: text.to_string(),
        preview,
        category,
        created_at: Utc::now().timestamp(),
        is_pinned: false,
    }
}
