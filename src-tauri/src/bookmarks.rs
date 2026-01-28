use serde::{Deserialize, Serialize};

// --- CONDITIONAL IMPORTS (Desktop Only) ---
#[cfg(not(target_os = "android"))]
use directories::BaseDirs;
#[cfg(not(target_os = "android"))]
use std::fs;
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;
#[cfg(not(target_os = "android"))]
use serde_json::Value;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BookmarkEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub category: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct BookmarksVault {
    pub entries: Vec<BookmarkEntry>,
}

impl BookmarksVault {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }
}

// --- IMPORTER LOGIC ---

pub fn import_chrome_bookmarks() -> Result<Vec<BookmarkEntry>, String> {
    // ANDROID: Not supported
    #[cfg(target_os = "android")]
    {
        Err("Importing browser bookmarks is not supported on Android due to OS sandboxing.".to_string())
    }

    // DESKTOP: Run the import logic
    #[cfg(not(target_os = "android"))]
    {
        let base_dirs = BaseDirs::new().ok_or("Could not determine base directories")?;
        let mut candidates: Vec<PathBuf> = Vec::new();

        // --- Windows Paths ---
        #[cfg(target_os = "windows")]
        {
            let data_local = base_dirs.data_local_dir();
            candidates.push(data_local.join("Google").join("Chrome").join("User Data").join("Default").join("Bookmarks"));
            candidates.push(data_local.join("Microsoft").join("Edge").join("User Data").join("Default").join("Bookmarks"));
            candidates.push(data_local.join("BraveSoftware").join("Brave-Browser").join("User Data").join("Default").join("Bookmarks"));
        }

        // --- macOS Paths ---
        #[cfg(target_os = "macos")]
        {
            let config_dir = base_dirs.config_dir();
            candidates.push(config_dir.join("Google").join("Chrome").join("Default").join("Bookmarks"));
            candidates.push(config_dir.join("Microsoft Edge").join("Default").join("Bookmarks"));
            candidates.push(config_dir.join("BraveSoftware").join("Brave-Browser").join("Default").join("Bookmarks"));
        }

        // --- Linux Paths ---
        #[cfg(target_os = "linux")]
        {
            let config_dir = base_dirs.config_dir();
            candidates.push(config_dir.join("google-chrome").join("Default").join("Bookmarks"));
            candidates.push(config_dir.join("chromium").join("Default").join("Bookmarks"));
            candidates.push(config_dir.join("microsoft-edge").join("Default").join("Bookmarks"));
        }

        // Find the first existing file
        let bookmark_file = candidates.into_iter().find(|p| p.exists())
            .ok_or("No supported browser installation found (Chrome/Edge/Brave).")?;

        // Read and Parse
        let content = fs::read_to_string(&bookmark_file).map_err(|e| format!("Failed to read file: {}", e))?;
        let json: Value = serde_json::from_str(&content).map_err(|e| format!("Invalid JSON format: {}", e))?;

        let mut results = Vec::new();
        let roots = &json["roots"];
        
        if let Some(bar) = roots.get("bookmark_bar") {
            parse_node(bar, "Bookmarks Bar", &mut results);
        }
        if let Some(other) = roots.get("other") {
            parse_node(other, "Other Bookmarks", &mut results);
        }
        if let Some(synced) = roots.get("synced") {
            parse_node(synced, "Mobile Bookmarks", &mut results);
        }

        Ok(results)
    }
}

// Recursive function to walk the bookmark tree (Desktop Only)
#[cfg(not(target_os = "android"))]
fn parse_node(node: &Value, category: &str, results: &mut Vec<BookmarkEntry>) {
    if let Some(children) = node["children"].as_array() {
        for child in children {
            let type_str = child["type"].as_str().unwrap_or("");
            
            if type_str == "url" {
                let title = child["name"].as_str().unwrap_or("Untitled").to_string();
                let url = child["url"].as_str().unwrap_or("").to_string();
                
                if !url.is_empty() {
                    results.push(BookmarkEntry {
                        id: uuid::Uuid::new_v4().to_string(),
                        title,
                        url,
                        category: category.to_string(),
                        created_at: chrono::Utc::now().timestamp_millis(),
                    });
                }
            } else if type_str == "folder" {
                let folder_name = child["name"].as_str().unwrap_or("Folder");
                let new_category = format!("{} > {}", category, folder_name);
                parse_node(child, &new_category, results);
            }
        }
    }
}