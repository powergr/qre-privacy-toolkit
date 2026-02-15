use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path; // Removed unused PathBuf
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JunkItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub category: String, // "System", "Browser", "Application"
    pub size: u64,
    pub description: String,
}

pub fn get_system_targets() -> Vec<JunkItem> {
    let mut targets = Vec::new();

    if let Some(base_dirs) = BaseDirs::new() {
        // --- WINDOWS TARGETS ---
        #[cfg(target_os = "windows")]
        {
            let temp = std::env::var("TEMP").unwrap_or_default();
            if !temp.is_empty() {
                add_target(
                    &mut targets,
                    "Windows Temp",
                    &temp,
                    "System",
                    "Temporary system files",
                );
            }

            // Windows Recent Documents
            let recent = base_dirs
                .data_dir()
                .join("Microsoft")
                .join("Windows")
                .join("Recent");
            add_target(
                &mut targets,
                "Recent Files",
                recent.to_str().unwrap(),
                "System",
                "File history shortcuts",
            );

            // Browser Caches (Chrome/Edge/Brave)
            let local_app_data = base_dirs.data_local_dir();

            let browsers = vec![
                ("Google/Chrome/User Data/Default/Cache", "Chrome Cache"),
                ("Microsoft/Edge/User Data/Default/Cache", "Edge Cache"),
                (
                    "BraveSoftware/Brave-Browser/User Data/Default/Cache",
                    "Brave Cache",
                ),
                ("Mozilla/Firefox/Profiles", "Firefox Cache"),
            ];

            for (subpath, name) in browsers {
                let p = local_app_data.join(subpath);
                add_target(
                    &mut targets,
                    name,
                    p.to_str().unwrap(),
                    "Browser",
                    "Web browsing cache",
                );
            }
        }

        // --- MACOS TARGETS ---
        #[cfg(target_os = "macos")]
        {
            let home = base_dirs.home_dir();
            let cache = base_dirs.cache_dir();

            // User Caches
            add_target(
                &mut targets,
                "User Caches",
                cache.to_str().unwrap(),
                "System",
                "Application cache files",
            );

            // Logs
            let logs = home.join("Library/Logs");
            add_target(
                &mut targets,
                "User Logs",
                logs.to_str().unwrap(),
                "System",
                "System and app log files",
            );

            // Browsers
            let chrome = home.join("Library/Caches/Google/Chrome/Default/Cache");
            add_target(
                &mut targets,
                "Chrome Cache",
                chrome.to_str().unwrap(),
                "Browser",
                "Web browsing cache",
            );

            let safari = home.join("Library/Caches/com.apple.Safari");
            add_target(
                &mut targets,
                "Safari Cache",
                safari.to_str().unwrap(),
                "Browser",
                "Web browsing cache",
            );
        }

        // --- LINUX TARGETS ---
        #[cfg(target_os = "linux")]
        {
            let cache = base_dirs.cache_dir();

            // Cache
            add_target(
                &mut targets,
                "User Cache",
                cache.to_str().unwrap(),
                "System",
                "~/.cache directory",
            );

            // Thumbnails
            let thumbs = cache.join("thumbnails");
            add_target(
                &mut targets,
                "Thumbnails",
                thumbs.to_str().unwrap(),
                "System",
                "Image preview cache",
            );
        }
    }

    targets
}

fn add_target(list: &mut Vec<JunkItem>, name: &str, path: &str, cat: &str, desc: &str) {
    if Path::new(path).exists() {
        list.push(JunkItem {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            path: path.to_string(),
            category: cat.to_string(),
            size: 0, // Calculated later
            description: desc.to_string(),
        });
    }
}

pub fn scan_targets() -> Vec<JunkItem> {
    let mut items = get_system_targets();

    // Calculate sizes (Expensive operation, done in thread)
    for item in &mut items {
        let path = Path::new(&item.path);
        item.size = calculate_dir_size(path);
    }

    // Filter out empty items
    items.retain(|i| i.size > 0);
    items
}

fn calculate_dir_size(path: &Path) -> u64 {
    let mut total_size = 0;
    // Walkdir handles permissions gracefully-ish (skips errors)
    for entry in WalkDir::new(path)
        .min_depth(1)
        .max_depth(10)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                total_size += metadata.len();
            }
        }
    }
    total_size
}

pub fn clean_paths(paths: Vec<String>) -> u64 {
    let mut bytes_cleaned = 0;

    for path_str in paths {
        let path = Path::new(&path_str);
        if path.is_dir() {
            // We iterate content to avoid deleting the ROOT folder if possible (e.g. don't delete ~/.cache, delete contents)
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    let size = calculate_dir_size(&p); // Estimate what we are about to delete

                    if p.is_dir() {
                        if fs::remove_dir_all(&p).is_ok() {
                            bytes_cleaned += size;
                        }
                    } else {
                        if let Ok(meta) = fs::metadata(&p) {
                            if fs::remove_file(&p).is_ok() {
                                bytes_cleaned += meta.len();
                            }
                        }
                    }
                }
            }
        } else if path.is_file() {
            if let Ok(meta) = fs::metadata(path) {
                if fs::remove_file(path).is_ok() {
                    bytes_cleaned += meta.len();
                }
            }
        }
    }

    bytes_cleaned
}
