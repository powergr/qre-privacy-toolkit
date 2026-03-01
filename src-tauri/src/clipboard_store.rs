// --- START OF FILE clipboard_store.rs ---

use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
// Zeroize ensures that sensitive copied data (like passwords) is aggressively wiped
// from RAM when the struct is dropped, preventing memory forensics.
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Represents a single item saved from the OS clipboard.
#[derive(Serialize, Deserialize, Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct ClipboardEntry {
    pub id: String,       // Unique UUID for frontend rendering
    pub content: String,  // The actual raw text copied from the clipboard
    pub preview: String,  // A safely redacted short version of the text for the UI list
    pub category: String, // Auto-detected category (e.g., "API Key", "Credit Card")
    pub created_at: i64,  // UNIX timestamp used for the TTL (Time-To-Live) auto-deletion logic

    // Users can pin items to prevent them from being auto-deleted by the TTL timer
    #[serde(default)]
    pub is_pinned: bool,
}

/// The root container that holds all clipboard history.
/// This entire struct is encrypted and decrypted as a single JSON blob (`clipboard.qre`).
#[derive(Serialize, Deserialize, Debug, Default, Zeroize, ZeroizeOnDrop)]
pub struct ClipboardVault {
    // Schema versioning allows for safe backwards-compatible updates to the storage format
    #[serde(default = "ClipboardVault::default_schema_version")]
    pub schema_version: u32,
    pub entries: Vec<ClipboardEntry>,
}

impl ClipboardVault {
    pub const CURRENT_SCHEMA_VERSION: u32 = 1;

    fn default_schema_version() -> u32 {
        1
    }

    /// Initializes a brand new, empty clipboard history vault.
    pub fn new() -> Self {
        Self {
            schema_version: Self::CURRENT_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }

    /// Validates the internal integrity of the vault before allowing it to be saved to disk.
    /// Prevents data corruption caused by UI bugs or modified payloads.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version > Self::CURRENT_SCHEMA_VERSION {
            return Err(format!("Vault version {} is too new.", self.schema_version));
        }

        let mut seen_ids = std::collections::HashSet::new();
        for entry in &self.entries {
            if entry.id.is_empty() {
                return Err("Empty ID found".into());
            }
            // Ensure no duplicate UUIDs exist which would break React rendering
            if !seen_ids.insert(&entry.id) {
                return Err(format!("Duplicate ID: {}", entry.id));
            }
        }
        Ok(())
    }

    /// Helper to safely append a new item to the vault array.
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
// This function uses lightweight rules and strict bounds to analyze text.
// SECURITY: Avoiding overly complex regex prevents "Regular Expression Denial of Service"
// (ReDoS) attacks where a massive clipboard payload could freeze the application.

/// Analyzes raw text to guess what type of sensitive data it might be.
pub fn analyze_content(text: &str) -> Option<String> {
    // SECURITY: Fast-path exit for massive text blobs to prevent CPU exhaustion.
    if text.len() > 100_000 {
        return Some("Text".to_string());
    }

    // 1. Credit Cards (Bounded)
    // Matches 13-19 digit numbers, optionally separated by spaces or dashes.
    let card_regex = Regex::new(r"\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b").unwrap();
    if card_regex.is_match(text) {
        let nums = text.chars().filter(|c| c.is_numeric()).count();
        if nums >= 13 && nums <= 19 {
            return Some("Credit Card".to_string());
        }
    }

    // 2. IBAN (International Bank Account Number)
    // Matches 2 letters, 2 numbers, followed by groups of alphanumeric characters.
    let iban_regex = Regex::new(r"(?i)\b[A-Z]{2}\d{2}(?:[A-Z0-9]{4}[ ]?){3,7}\b").unwrap();
    if iban_regex.is_match(text) {
        return Some("Bank Info".to_string());
    }

    // 3. Cryptocurrency Addresses
    // Ethereum format (0x followed by 40 hex characters)
    if text.starts_with("0x") && text.len() == 42 {
        if text[2..].chars().all(|c| c.is_ascii_hexdigit()) {
            return Some("Crypto Address".to_string());
        }
    }
    // Bitcoin Legacy/SegWit format heuristic (starts with 1, 3, or bc1)
    if text.len() >= 26 && text.len() <= 35 {
        let f = text.chars().next().unwrap_or(' ');
        if (f == '1' || f == '3' || f == 'b' || f == 'B')
            && text.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return Some("Crypto Address".to_string());
        }
    }

    // 4. API Keys & Secrets
    // Standard UUIDs or keys containing multiple hyphens
    if text.len() >= 16 && text.chars().filter(|c| *c == '-').count() >= 4 {
        return Some("Secret".to_string());
    }
    // Known API key prefixes (Stripe, GitHub, JWT tokens, AWS)
    if text.starts_with("sk-")
        || text.starts_with("ghp_")
        || text.starts_with("eyJ") // Standard start of a Base64 encoded JSON Web Token
        || text.starts_with("AKIA")
    // AWS Access Key ID
    {
        return Some("API Key".to_string());
    }

    // 5. Emails
    // Basic heuristic: contains exactly one '@' and isn't too long.
    if text.contains('@') && text.chars().filter(|c| *c == '@').count() == 1 && text.len() < 100 {
        return Some("Email".to_string());
    }

    // 6. Web Links
    if text.starts_with("http") || (text.starts_with("www.") && text.contains('.')) {
        return Some("Link".to_string());
    }

    // 7. Passwords
    // Analyzes character entropy. If a string contains a mix of cases, numbers,
    // and/or symbols, is over 8 characters, and has no spaces, it's likely a password.
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

    // Fallback
    Some("Text".to_string())
}

/// Creates a new clipboard entry, automatically categorized and redacted for UI safety.
pub fn create_entry(text: &str) -> ClipboardEntry {
    // 1. Guess the category
    let category = analyze_content(text).unwrap_or("Text".to_string());

    // 2. Smart Redaction
    // The UI should never display raw credit cards or passwords in the main list view
    // to prevent "shoulder surfing" (people looking at the user's screen).
    let preview = match category.as_str() {
        "Credit Card" => {
            // Keep first 4 and last 4 digits visible, mask the middle
            if text.len() > 8 {
                let end = text.len().saturating_sub(4);
                let start = 4;
                format!("{} **** **** **** {}", &text[0..start], &text[end..])
            } else {
                "****".to_string()
            }
        }
        "API Key" | "Secret" | "Password" => {
            // Show only the first 6 characters, mask the rest
            if text.len() > 6 {
                format!("{}...", &text[0..6])
            } else {
                "***".to_string()
            }
        }
        "Bank Info" => {
            // IBAN: Show the first 4 characters (Country Code + Check Digits), mask the account number
            if text.len() > 4 {
                format!("{} **** ****...", &text[0..4])
            } else {
                "****".to_string()
            }
        }
        _ => {
            // Standard Text / Links: No masking needed, just truncate at 60 chars
            // and remove newlines so it fits nicely on one line in the UI.
            let max_len = 60;
            if text.len() > max_len {
                let truncated = &text[0..max_len];
                format!("{}...", truncated.replace("\n", " ").trim())
            } else {
                text.replace("\n", " ").trim().to_string()
            }
        }
    };

    // 3. Construct and return the safe entry
    ClipboardEntry {
        id: Uuid::new_v4().to_string(),
        content: text.to_string(), // The raw text is still saved to be copied later
        preview,                   // The safe text sent to the UI list
        category,
        created_at: Utc::now().timestamp(),
        is_pinned: false,
    }
}

// --- END OF FILE clipboard_store.rs ---
