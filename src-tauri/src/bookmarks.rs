use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

// --- CONDITIONAL IMPORTS (Desktop Only) ---
#[cfg(not(target_os = "android"))]
use directories::BaseDirs;
#[cfg(not(target_os = "android"))]
use serde_json::Value;
#[cfg(not(target_os = "android"))]
use std::fs;
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct BookmarkEntry {
    pub id: String,

    // SECURITY: Zeroed on drop
    pub title: String,
    pub url: String,

    pub category: String,
    pub created_at: i64, // Seconds

    #[serde(default)]
    pub is_pinned: bool,

    #[serde(default = "BookmarkEntry::default_color")]
    pub color: String,
}

impl BookmarkEntry {
    fn default_color() -> String {
        "#10b981".to_string()
    }
}

#[derive(Serialize, Deserialize, Debug, Default, Zeroize, ZeroizeOnDrop)]
pub struct BookmarksVault {
    #[serde(default = "BookmarksVault::default_schema_version")]
    pub schema_version: u32,
    pub entries: Vec<BookmarkEntry>,
}

impl BookmarksVault {
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
        for bookmark in &self.entries {
            if bookmark.id.is_empty() {
                return Err("Empty ID found.".into());
            }
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

pub fn import_chrome_bookmarks() -> Result<Vec<BookmarkEntry>, String> {
    #[cfg(target_os = "android")]
    {
        Err("Not supported on Android".into())
    }

    #[cfg(not(target_os = "android"))]
    {
        let base_dirs = BaseDirs::new().ok_or("Could not determine base directories")?;
        let mut candidates: Vec<PathBuf> = Vec::new();

        #[cfg(target_os = "windows")]
        {
            let data_local = base_dirs.data_local_dir();
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
            let config_dir = base_dirs.config_dir();
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
            let config_dir = base_dirs.config_dir();
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

        let bookmark_file = candidates
            .into_iter()
            .find(|p| p.exists())
            .ok_or("No supported browser bookmarks found.")?;

        let content = fs::read_to_string(&bookmark_file).map_err(|e| e.to_string())?;
        let json: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

        let mut results = Vec::new();
        let roots = &json["roots"];

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

#[cfg(not(target_os = "android"))]
fn parse_node(
    node: &Value,
    category: &str,
    results: &mut Vec<BookmarkEntry>,
) -> Result<(), String> {
    if let Some(children) = node["children"].as_array() {
        for child in children {
            let type_str = child["type"].as_str().unwrap_or("");

            if type_str == "url" {
                let title = child["name"].as_str().unwrap_or("Untitled").to_string();
                let url = child["url"].as_str().unwrap_or("").to_string();

                if url.is_empty() {
                    continue;
                }

                // Security: Reject scripts
                let url_lower = url.to_lowercase();
                if url_lower.starts_with("javascript:") || url_lower.starts_with("data:") {
                    continue;
                }

                results.push(BookmarkEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    title,
                    url,
                    category: category.to_string(),
                    created_at: chrono::Utc::now().timestamp(), // Seconds
                    is_pinned: false,
                    color: BookmarkEntry::default_color(),
                });
            } else if type_str == "folder" {
                let folder_name = child["name"].as_str().unwrap_or("Folder");
                let new_cat = format!("{} > {}", category, folder_name);
                parse_node(child, &new_cat, results)?;
            }
        }
    }
    Ok(())
}
