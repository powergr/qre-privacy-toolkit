// --- START OF FILE bookmarks.rs ---

use serde::{Deserialize, Serialize};
// Zeroize is a crucial security crate that ensures sensitive data is actively overwritten
// with zeros in RAM when the variable goes out of scope, preventing memory scraping attacks.
use zeroize::{Zeroize, ZeroizeOnDrop};

// ==========================================
// --- CONDITIONAL IMPORTS (Desktop Only) ---
// ==========================================
// The importer feature requires direct filesystem access to other applications' data folders.
// This is heavily restricted on Android due to strict app sandboxing, so we only compile
// these dependencies for Desktop targets (Windows, macOS, Linux).
#[cfg(not(target_os = "android"))]
use directories::BaseDirs;
#[cfg(not(target_os = "android"))]
use serde_json::Value;
#[cfg(not(target_os = "android"))]
use std::fs;
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;

/// Represents a single saved web bookmark.
/// Deriving `Zeroize` and `ZeroizeOnDrop` ensures that if a user opens their vault,
/// the plaintext URLs and titles are wiped from memory the moment the vault is closed.
#[derive(Serialize, Deserialize, Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct BookmarkEntry {
    pub id: String, // Unique UUID for React frontend rendering and updates

    // SECURITY: These fields contain sensitive user data and will be zeroed on drop
    pub title: String,
    pub url: String,

    pub category: String, // Folder/Tag name
    pub created_at: i64,  // UNIX timestamp in seconds

    #[serde(default)]
    pub is_pinned: bool, // Allows users to pin favorite bookmarks to the top of the UI

    #[serde(default = "BookmarkEntry::default_color")]
    pub color: String, // UI accent color for the bookmark card
}

impl BookmarkEntry {
    /// Provides a fallback color for older vault versions that didn't have the color field.
    fn default_color() -> String {
        "#10b981".to_string() // Default Emerald Green
    }
}

/// The root container that holds all bookmarks.
/// This entire struct is encrypted and decrypted as a single JSON blob.
#[derive(Serialize, Deserialize, Debug, Default, Zeroize, ZeroizeOnDrop)]
pub struct BookmarksVault {
    // Schema versioning allows future updates to safely migrate old vault data structures.
    #[serde(default = "BookmarksVault::default_schema_version")]
    pub schema_version: u32,
    pub entries: Vec<BookmarkEntry>,
}

impl BookmarksVault {
    pub const CURRENT_SCHEMA_VERSION: u32 = 1;

    fn default_schema_version() -> u32 {
        1
    }

    /// Initializes a brand new, empty bookmark vault.
    pub fn new() -> Self {
        Self {
            schema_version: Self::CURRENT_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }

    /// Validates the internal integrity of the vault before allowing it to be saved.
    /// This prevents a bug in the frontend from corrupting the user's encrypted file.
    pub fn validate(&self) -> Result<(), String> {
        // Prevent older versions of the app from overwriting/corrupting newer vault formats.
        if self.schema_version > Self::CURRENT_SCHEMA_VERSION {
            return Err(format!("Vault version {} is too new.", self.schema_version));
        }

        let mut seen_ids = std::collections::HashSet::new();
        for bookmark in &self.entries {
            if bookmark.id.is_empty() {
                return Err("Empty ID found.".into());
            }
            // Ensure every bookmark has a strictly unique ID
            if !seen_ids.insert(&bookmark.id) {
                return Err(format!("Duplicate ID: {}", bookmark.id));
            }
            if bookmark.url.is_empty() {
                return Err("Empty URL found.".into());
            }
        }
        Ok(())
    }
}

// ───────────────────────────────────────────────────────────────────────────
// IMPORTER
// ───────────────────────────────────────────────────────────────────────────

/// Attempts to find and import bookmarks from locally installed Chromium-based browsers
/// (Google Chrome, Microsoft Edge, Brave).
pub fn import_chrome_bookmarks() -> Result<Vec<BookmarkEntry>, String> {
    // On Android, we cannot read the Chrome app's private data folder without root access.
    #[cfg(target_os = "android")]
    {
        Err("Not supported on Android".into())
    }

    #[cfg(not(target_os = "android"))]
    {
        let base_dirs = BaseDirs::new().ok_or("Could not determine base directories")?;
        let mut candidates: Vec<PathBuf> = Vec::new();

        // --- OS-Specific Path Resolution ---
        // We push known default installation paths for popular browsers into a list of candidates.

        #[cfg(target_os = "windows")]
        {
            let data_local = base_dirs.data_local_dir(); // Usually C:\Users\Username\AppData\Local
            candidates.push(
                data_local
                    .join("Google")
                    .join("Chrome")
                    .join("User Data")
                    .join("Default")
                    .join("Bookmarks"),
            );
            candidates.push(
                data_local
                    .join("Microsoft")
                    .join("Edge")
                    .join("User Data")
                    .join("Default")
                    .join("Bookmarks"),
            );
            candidates.push(
                data_local
                    .join("BraveSoftware")
                    .join("Brave-Browser")
                    .join("User Data")
                    .join("Default")
                    .join("Bookmarks"),
            );
        }

        #[cfg(target_os = "macos")]
        {
            let config_dir = base_dirs.config_dir(); // Usually ~/Library/Application Support
            candidates.push(
                config_dir
                    .join("Google")
                    .join("Chrome")
                    .join("Default")
                    .join("Bookmarks"),
            );
            candidates.push(
                config_dir
                    .join("Microsoft Edge")
                    .join("Default")
                    .join("Bookmarks"),
            );
            candidates.push(
                config_dir
                    .join("BraveSoftware")
                    .join("Brave-Browser")
                    .join("Default")
                    .join("Bookmarks"),
            );
        }

        #[cfg(target_os = "linux")]
        {
            let config_dir = base_dirs.config_dir(); // Usually ~/.config
            candidates.push(
                config_dir
                    .join("google-chrome")
                    .join("Default")
                    .join("Bookmarks"),
            );
            candidates.push(
                config_dir
                    .join("chromium")
                    .join("Default")
                    .join("Bookmarks"),
            );
        }

        // Find the first path that actually exists on the user's computer
        let bookmark_file = candidates
            .into_iter()
            .find(|p| p.exists())
            .ok_or("No supported browser bookmarks found.")?;

        // Chromium bookmarks are stored as a standard JSON file.
        let content = fs::read_to_string(&bookmark_file).map_err(|e| e.to_string())?;
        let json: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

        let mut results = Vec::new();
        // The "roots" object contains the main organizational trees in Chrome
        let roots = &json["roots"];

        // Parse the standard Chromium bookmark trees
        if let Some(bar) = roots.get("bookmark_bar") {
            parse_node(bar, "Bookmarks Bar", &mut results)?;
        }
        if let Some(other) = roots.get("other") {
            parse_node(other, "Other Bookmarks", &mut results)?;
        }
        if let Some(synced) = roots.get("synced") {
            parse_node(synced, "Mobile Bookmarks", &mut results)?;
        }

        Ok(results)
    }
}

/// Recursively traverses a Chromium bookmark JSON node.
/// Chromium structures bookmarks as a nested tree of "folder" and "url" nodes.
#[cfg(not(target_os = "android"))]
fn parse_node(
    node: &Value,
    category: &str,
    results: &mut Vec<BookmarkEntry>,
) -> Result<(), String> {
    // If the current node has children (i.e., it's a folder), iterate through them.
    if let Some(children) = node["children"].as_array() {
        for child in children {
            let type_str = child["type"].as_str().unwrap_or("");

            if type_str == "url" {
                // It's a standard web link
                let title = child["name"].as_str().unwrap_or("Untitled").to_string();
                let url = child["url"].as_str().unwrap_or("").to_string();

                if url.is_empty() {
                    continue; // Skip invalid entries
                }

                // ------------------------------------------------------------
                // SECURITY CHECK: Reject Executable URIs
                // ------------------------------------------------------------
                // Attackers sometimes hide malicious scripts in bookmarks (bookmarklets).
                // If a user clicks an imported javascript: URI, it could execute XSS
                // in the context of the React frontend.
                let url_lower = url.to_lowercase();
                if url_lower.starts_with("javascript:") || url_lower.starts_with("data:") {
                    continue; // Silently drop malicious/executable bookmarklets
                }

                results.push(BookmarkEntry {
                    id: uuid::Uuid::new_v4().to_string(), // Generate a fresh ID for our system
                    title,
                    url,
                    category: category.to_string(), // Apply the flattened folder path
                    created_at: chrono::Utc::now().timestamp(), // Standardize timestamp to now (seconds)
                    is_pinned: false,
                    color: BookmarkEntry::default_color(),
                });
            } else if type_str == "folder" {
                // It's a nested folder.
                // We flatten the hierarchy into string paths (e.g., "Bookmarks Bar > Work > Projects")
                let folder_name = child["name"].as_str().unwrap_or("Folder");
                let new_cat = format!("{} > {}", category, folder_name);

                // Recursively call this function to process the folder's contents
                parse_node(child, &new_cat, results)?;
            }
        }
    }
    Ok(())
}

// --- END OF FILE bookmarks.rs ---
