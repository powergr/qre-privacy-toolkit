// --- START OF FILE analyzer.rs ---

use anyhow::Result;
use rayon::prelude::*; // Provides parallel iterators for multi-threaded performance
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter};
use walkdir::{DirEntry, WalkDir};

// Use the directories crate to resolve standard OS user folders on Desktop platforms.
#[cfg(not(target_os = "android"))]
use directories::UserDirs;

/// Represents the findings for a single analyzed file.
/// Sent to the frontend to populate the security scan results table.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AnalysisResult {
    pub path: String,
    pub filename: String,
    pub extension: String,
    pub real_type: String, // The actual file type determined by its magic bytes
    pub risk_level: String, // "DANGER", "WARNING", "SAFE"
    pub description: String, // Human-readable explanation of the finding
}

// ==========================================
// --- HELPER: Directory Filtering ---
// ==========================================

/// Checks if a directory should be skipped during the recursive walk.
/// (Optimization & Noise Reduction)
fn is_ignored_dir(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    // Skip hidden folders (e.g., .git, .vscode) and heavy development/build folders.
    // Scanning these would take far too long and yield many false positives
    // (e.g., intermediate compiled objects masquerading as other data).
    name.starts_with('.')
        || name == "node_modules"
        || name == "target"
        || name == "build"
        || name == "dist"
        || name == "vendor"
        || name == "obj"
        || name == "__pycache__"
}

// ==========================================
// --- CORE: Directory Scanner ---
// ==========================================

/// Recursively scans a target directory and analyzes all files within it.
pub fn scan_directory(app: &AppHandle, dir: &str) -> Vec<AnalysisResult> {
    // 1. Collect all valid file entries synchronously using WalkDir.
    // We cap the depth at 10 to prevent infinite symlink loops or excessively deep structures.
    let entries: Vec<_> = WalkDir::new(dir)
        .min_depth(1)
        .max_depth(10)
        .into_iter()
        .filter_entry(|e| !e.path().is_dir() || !is_ignored_dir(e)) // Prune ignored dirs immediately
        .filter_map(|e| e.ok()) // Drop entries we don't have permission to read
        .filter(|e| !e.path().is_dir()) // Keep only actual files
        .collect();

    // 2. Process the collected files in PARALLEL using Rayon (`par_iter`).
    // This vastly speeds up I/O and CPU-bound heuristic checks across thousands of files.
    let results: Vec<AnalysisResult> = entries
        .par_iter()
        .filter_map(|entry| {
            let path = entry.path();
            let path_str = path.to_string_lossy().to_string();

            // Emit a progress event to the Tauri UI.
            // Note: Since this is highly multi-threaded, events will arrive rapidly and out of order.
            let _ = app.emit("qre:analyzer-progress", &path_str);

            // 3. Analyze the individual file.
            match analyze_file(path) {
                Ok(res) => {
                    // Only return files that triggered a security flag.
                    if res.risk_level != "SAFE" {
                        Some(res)
                    } else {
                        None // Discard safe files to save memory
                    }
                }
                Err(_) => None, // Ignore files that couldn't be read/analyzed
            }
        })
        .collect();

    results
}

// ==========================================
// --- CORE: Heuristic File Analysis ---
// ==========================================

/// Analyzes a single file by comparing its declared extension against its "Magic Bytes" (file header).
pub fn analyze_file(path: &Path) -> Result<AnalysisResult> {
    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // The "Declared" extension (what the user sees and what the OS uses to open it)
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Use the `infer` crate to read the first few bytes of the file and match them against known signatures.
    let kind_opt = infer::get_from_path(path).unwrap_or(None);

    let (real_ext, mime) = match kind_opt {
        Some(kind) => (kind.extension(), kind.mime_type()),
        None => ("unknown", "unknown"),
    };

    let mut risk_level = "SAFE".to_string();
    let mut description = "Match".to_string();

    // If we successfully identified the actual file type...
    if real_ext != "unknown" {
        // Check if the actual file contents represent an executable program.
        let is_executable_mime = mime.contains("dosexec") // Windows PE (.exe, .dll)
            || mime.contains("executable")
            || mime.contains("mach-binary") // macOS binaries
            || mime.contains("elf"); // Linux binaries

        // Expected extensions for legitimate executable formats.
        let allowed_binary_exts = [
            "exe", "dll", "sys", "ocx", "cpl", "scr", "msi", "node", "pyd", "efi", "acm", "ax",
            "tsp", "drv", "bin", "elf", "so", "o", "deb", "rpm", "appimage", "dylib", "kext",
            "app", "sh", "bat", "cmd", "ps1", "vbs",
        ];

        // ------------------------------------------------------------
        // SECURITY CHECK 1: DANGER - Executables masquerading as data
        // ------------------------------------------------------------
        if is_executable_mime {
            // If the actual file is an executable, but its extension is NOT an executable extension...
            if !allowed_binary_exts.contains(&ext.as_str()) {
                // If it's masquerading as a format users implicitly trust (like a document or image)...
                let user_safe_formats = [
                    "txt", "pdf", "jpg", "jpeg", "png", "gif", "mp3", "mp4", "docx", "xlsx", "zip",
                    "rar", "csv",
                ];

                if user_safe_formats.contains(&ext.as_str()) {
                    risk_level = "DANGER".to_string();
                    description = format!("EXECUTABLE hidden as .{}", ext.to_uppercase());
                }
            }
        }
        // ------------------------------------------------------------
        // SECURITY CHECK 2: WARNING - General Extension Mismatch
        // ------------------------------------------------------------
        else if real_ext != ext {
            // The file isn't an executable, but its extension is lying about what it is.
            // We need to filter out common legitimate reasons for mismatches (whitelisting).

            let system_extensions = [
                "mui", "cat", "tlb", "cip", "nls", "icm", "inf", "pnf", "xml", "json", "lib",
                "rlib", "pdb", "exp", "obj", "iobj", "ipdb", "dat", "bin", "cache", "tmp", "db",
                "db-shm", "db-wal", "plugin", "bpl",
            ];

            let image_formats = [
                "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "tiff", "tif",
            ];

            if system_extensions.contains(&ext.as_str()) {
                // Ignore: Common OS and dev files often have custom extensions but standard headers.
            } else if real_ext == "der" && (ext == "cat" || ext == "cip" || ext == "crl") {
                // Safe: Windows security catalog files use DER certificate encoding.
            } else if (real_ext == "zip" || real_ext == "jar")
                && matches!(
                    ext.as_str(),
                    "docx" | "xlsx" | "pptx" | "odt" | "apk" | "nupkg" | "whl" | "vsix" | "crx"
                )
            {
                // Safe: Modern documents (Office), Android apps (.apk), and browser extensions (.crx)
                // are actually just ZIP archives under the hood. The infer crate sees "ZIP", but the
                // extension is "docx". This is expected.
            } else if mime.starts_with("text") {
                // Safe: Text is text, regardless of extension.
            } else if image_formats.contains(&real_ext) && image_formats.contains(&ext.as_str()) {
                // Safe: Image format mismatches are incredibly common on the web
                // (e.g., a .webp file downloaded and saved as .png). Usually harmless.
            } else {
                // If it doesn't match our whitelists, flag it if the user thinks it's a standard media/document.
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

// ==========================================
// --- OS SPECIFIC DIRECTORY RESOLUTION ---
// ==========================================

// ── Desktop (Windows / macOS / Linux) ────────────────────────────────────────
#[cfg(not(target_os = "android"))]
pub fn get_user_dirs() -> Vec<String> {
    let mut paths = Vec::new();
    // Resolve standard directories where users typically download/store risky files.
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

// ── Android ───────────────────────────────────────────────────────────────────
// The standard Rust `directories` crate resolves to the app's isolated private sandbox
// on Android, which is normally empty and safe. We need to target the public storage
// folders (requires READ_EXTERNAL_STORAGE / MANAGE_EXTERNAL_STORAGE permissions in AndroidManifest).
#[cfg(target_os = "android")]
pub fn get_user_dirs() -> Vec<String> {
    // Common public paths across different Android vendor implementations
    let candidates = vec![
        "/sdcard/Download",
        "/sdcard/Documents",
        "/sdcard/DCIM",
        "/sdcard/Pictures",
        "/storage/emulated/0/Download",
        "/storage/emulated/0/Documents",
        "/storage/emulated/0/DCIM",
        "/storage/emulated/0/Pictures",
    ];

    candidates
        .into_iter()
        .filter(|p| std::path::Path::new(p).exists()) // Only return paths that actually exist on this device
        .map(|p| p.to_string())
        .collect()
}

// ==========================================
// --- TESTS ---
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    /// Helper to create a temporary file with specific byte content
    fn create_temp_file(name: &str, content: &[u8]) -> std::path::PathBuf {
        let test_dir = std::env::temp_dir().join("qre_analyzer_tests");
        fs::create_dir_all(&test_dir).unwrap();

        let path = test_dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(content).unwrap();
        path
    }

    #[test]
    fn test_analyze_safe_text_file() {
        // A normal text file
        let path = create_temp_file("safe.txt", b"Hello, this is just text.");
        let result = analyze_file(&path).unwrap();

        assert_eq!(result.risk_level, "SAFE");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_analyze_danger_executable_spoofing() {
        // Create a file with a Windows PE Executable Header (MZ)
        // but name it as an innocent PDF document.
        let exe_magic_bytes: &[u8] = b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xFF\xFF\x00\x00\xb8\x00\x00\x00\x00\x00\x00\x00\x40\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80\x00\x00\x00\x0E\x1F\xBA\x0E\x00\xB4\x09\xCD\x21\xB8\x01\x4C\xCD\x21\x54\x68\x69\x73\x20\x70\x72\x6F\x67\x72\x61\x6D\x20\x63\x61\x6E\x6E\x6F\x74\x20\x62\x65\x20\x72\x75\x6E\x20\x69\x6E\x20\x44\x4F\x53\x20\x6D\x6F\x64\x65\x2E\x0D\x0D\x0A\x24\x00\x00\x00\x00\x00\x00\x00";

        let path = create_temp_file("invoice.pdf", exe_magic_bytes);
        let result = analyze_file(&path).unwrap();

        assert_eq!(result.risk_level, "DANGER");
        assert!(result.description.contains("EXECUTABLE hidden as"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_analyze_warning_extension_mismatch() {
        // Create a ZIP file header (PK\x03\x04)
        // but name it as an image file. This shouldn't be an executable danger,
        // but it is a mismatch warning for monitored extensions.
        let zip_magic_bytes: &[u8] = b"PK\x03\x04\x14\x00\x08\x00\x08\x00";

        let path = create_temp_file("vacation.jpg", zip_magic_bytes);
        let result = analyze_file(&path).unwrap();

        assert_eq!(result.risk_level, "WARNING");
        assert_eq!(result.real_type, "zip");
        assert!(result
            .description
            .contains("File is actually .ZIP but named .jpg"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_analyze_safe_docx_is_zip() {
        // A .docx file is literally a ZIP file under the hood.
        // The analyzer should recognize this and whitelist it as SAFE.
        let zip_magic_bytes: &[u8] = b"PK\x03\x04\x14\x00\x08\x00\x08\x00";

        let path = create_temp_file("report.docx", zip_magic_bytes);
        let result = analyze_file(&path).unwrap();

        assert_eq!(
            result.risk_level, "SAFE",
            "DOCX files should be whitelisted even though they are ZIPs"
        );

        let _ = fs::remove_file(path);
    }
}
// --- END OF FILE analyzer.rs ---
