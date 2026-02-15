use anyhow::Result;
use directories::UserDirs;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter};
use walkdir::{DirEntry, WalkDir};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AnalysisResult {
    pub path: String,
    pub filename: String,
    pub extension: String,
    pub real_type: String,
    pub risk_level: String, // "DANGER", "WARNING", "SAFE"
    pub description: String,
}

// Helper to check if we should skip a directory (Optimization)
fn is_ignored_dir(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    // Skip hidden folders (.git, .vscode) and heavy dev folders
    name.starts_with('.')
        || name == "node_modules"
        || name == "target"
        || name == "build"
        || name == "dist"
        || name == "vendor"
        || name == "obj"
        || name == "__pycache__"
}

pub fn scan_directory(app: &AppHandle, dir: &str) -> Vec<AnalysisResult> {
    let entries: Vec<_> = WalkDir::new(dir)
        .min_depth(1)
        .max_depth(10)
        .into_iter()
        .filter_entry(|e| !e.path().is_dir() || !is_ignored_dir(e))
        .filter_map(|e| e.ok())
        .filter(|e| !e.path().is_dir())
        .collect();

    let results: Vec<AnalysisResult> = entries
        .par_iter()
        .filter_map(|entry| {
            let path = entry.path();
            let path_str = path.to_string_lossy().to_string();
            let _ = app.emit("qre:analyzer-progress", &path_str);

            match analyze_file(path) {
                Ok(res) => {
                    if res.risk_level != "SAFE" {
                        Some(res)
                    } else {
                        None
                    }
                }
                Err(_) => None,
            }
        })
        .collect();

    results
}

pub fn analyze_file(path: &Path) -> Result<AnalysisResult> {
    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let kind_opt = infer::get_from_path(path).unwrap_or(None);

    let (real_ext, mime) = match kind_opt {
        Some(kind) => (kind.extension(), kind.mime_type()),
        None => ("unknown", "unknown"),
    };

    let mut risk_level = "SAFE".to_string();
    let mut description = "Match".to_string();

    if real_ext != "unknown" {
        let is_executable_mime = mime.contains("dosexec")
            || mime.contains("executable")
            || mime.contains("mach-binary")
            || mime.contains("elf");
        let allowed_binary_exts = [
            "exe", "dll", "sys", "ocx", "cpl", "scr", "msi", "node", "pyd", "efi", "acm", "ax",
            "tsp", "drv", "bin", "elf", "so", "o", "deb", "rpm", "appimage", "dylib", "kext",
            "app", "sh", "bat", "cmd", "ps1", "vbs",
        ];

        if is_executable_mime {
            if !allowed_binary_exts.contains(&ext.as_str()) {
                let user_safe_formats = [
                    "txt", "pdf", "jpg", "jpeg", "png", "gif", "mp3", "mp4", "docx", "xlsx", "zip",
                    "rar", "csv",
                ];

                if user_safe_formats.contains(&ext.as_str()) {
                    risk_level = "DANGER".to_string();
                    description = format!("EXECUTABLE hidden as .{}", ext.to_uppercase());
                }
            }
        } else if real_ext != ext {
            let system_extensions = [
                "mui", "cat", "tlb", "cip", "nls", "icm", "inf", "pnf", "xml", "json", "lib",
                "rlib", "pdb", "exp", "obj", "iobj", "ipdb", "dat", "bin", "cache", "tmp", "db",
                "db-shm", "db-wal", "plugin", "bpl",
            ];

            // --- IMAGE FORMATS ---
            let image_formats = [
                "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "tiff", "tif",
            ];

            if system_extensions.contains(&ext.as_str()) {
                // Ignore
            } else if real_ext == "der" && (ext == "cat" || ext == "cip" || ext == "crl") {
                // Safe
            } else if (real_ext == "zip" || real_ext == "jar")
                && matches!(
                    ext.as_str(),
                    "docx" | "xlsx" | "pptx" | "odt" | "apk" | "nupkg" | "whl" | "vsix" | "crx"
                )
            {
                // Safe
            } else if mime.starts_with("text") {
                // Safe
            }
            // FIX: Cross-Image format mismatches are common and usually safe (e.g. .webp named .png)
            else if image_formats.contains(&real_ext) && image_formats.contains(&ext.as_str()) {
                // Safe
            } else {
                let monitored_exts = [
                    "jpg", "jpeg", "png", "gif", "pdf", "mp4", "mp3", "zip", "rar", "7z", "avi",
                    "mov", "wav",
                ];

                if monitored_exts.contains(&ext.as_str()) {
                    risk_level = "WARNING".to_string();
                    description = format!(
                        "File is actually .{} but named .{}",
                        real_ext.to_uppercase(),
                        ext
                    );
                }
            }
        }
    }

    Ok(AnalysisResult {
        path: path.to_string_lossy().to_string(),
        filename,
        extension: ext,
        real_type: real_ext.to_string(),
        risk_level,
        description,
    })
}

pub fn get_user_dirs() -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(user_dirs) = UserDirs::new() {
        if let Some(d) = user_dirs.download_dir() {
            paths.push(d.to_string_lossy().to_string());
        }
        if let Some(d) = user_dirs.desktop_dir() {
            paths.push(d.to_string_lossy().to_string());
        }
        if let Some(d) = user_dirs.document_dir() {
            paths.push(d.to_string_lossy().to_string());
        }
    }
    paths
}
