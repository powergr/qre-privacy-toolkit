use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ClipboardEntry {
    pub id: String,
    pub content: String,
    pub preview: String,
    pub category: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ClipboardVault {
    pub entries: Vec<ClipboardEntry>,
}

impl ClipboardVault {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

// --- SENSITIVE DATA DETECTION ---

pub fn analyze_content(text: &str) -> Option<String> {
    // 1. Credit Cards
    let card_regex = Regex::new(r"\b(?:\d[ -]*?){13,19}\b").unwrap();
    if card_regex.is_match(text) {
        let nums = text.chars().filter(|c| c.is_numeric()).count();
        if nums >= 13 && nums <= 19 {
            return Some("Credit Card".to_string());
        }
    }

    // 2. IBAN
    let iban_regex = Regex::new(r"(?i)\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,}\b").unwrap();
    if iban_regex.is_match(text) {
        return Some("Bank Info".to_string());
    }

    // 3. Crypto Addresses
    if (text.starts_with("0x") && text.len() == 42)
        || (text.starts_with("1") && text.len() >= 26 && text.len() <= 35)
    {
        return Some("Crypto Address".to_string());
    }

    // 4. API Keys / Secrets
    let uuid_char_count = text.chars().filter(|c| c.is_ascii_hexdigit()).count();
    let hyphen_count = text.chars().filter(|c| *c == '-').count();

    if text.len() >= 16 && hyphen_count >= 1 && (uuid_char_count + hyphen_count == text.len()) {
        return Some("Secret".to_string());
    }

    if text.starts_with("sk-") || text.starts_with("ghp_") || text.starts_with("eyJ") {
        return Some("API Key".to_string());
    }

    // 5. Emails
    if text.contains('@') && text.contains('.') && !text.contains(' ') && text.len() < 100 {
        return Some("Email".to_string());
    }

    // 6. URLs
    if text.starts_with("http://")
        || text.starts_with("https://")
        || (text.starts_with("www.") && !text.contains(' '))
    {
        return Some("Link".to_string());
    }

    // 7. Heuristics for Passwords
    let has_upper = text.chars().any(|c| c.is_uppercase());
    let has_lower = text.chars().any(|c| c.is_lowercase());
    let has_digit = text.chars().any(|c| c.is_numeric());
    let has_special = text.chars().any(|c| !c.is_alphanumeric());
    let has_space = text.contains(' ');

    // Rule A: Standard Strong (Upper + Lower + Digit)
    if !has_space && has_upper && has_lower && has_digit && text.len() >= 8 {
        return Some("Password".to_string());
    }

    // Rule B: Complex Lowercase (Lower + Digit + Special) <--- NOW USING has_special
    if !has_space && has_lower && has_digit && has_special && text.len() >= 8 {
        return Some("Password".to_string());
    }

    // Default
    Some("Text".to_string())
}

pub fn create_entry(text: &str) -> ClipboardEntry {
    let category = analyze_content(text).unwrap_or("Text".to_string());

    let preview = if text.len() > 60 {
        format!("{}...", &text[0..60].replace("\n", " "))
    } else {
        text.to_string()
    };

    ClipboardEntry {
        id: Uuid::new_v4().to_string(),
        content: text.to_string(),
        preview,
        category,
        created_at: Utc::now().timestamp_millis(),
    }
}
