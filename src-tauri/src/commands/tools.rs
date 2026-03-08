// --- START OF FILE tools.rs ---

use crate::analyzer;
use crate::breach;
use crate::cleaner::{self};
use crate::hasher;
use crate::qr;
use crate::registry_cleaner;
use crate::system_cleaner;
use crate::wordlist::WORDLIST;
use rand::RngCore;
use tauri::AppHandle;

/// Standardized result type for Tauri commands in this module.
/// Maps successful outcomes to `T` and errors to standard Strings for easy JSON serialization to the frontend.
pub type CommandResult<T> = Result<T, String>;

// ==========================================
// --- SYSTEM CLEANER COMMANDS ---
// ==========================================
// These commands handle the detection and removal of system junk (e.g., temp files, caches).

/// Scans the system for safe-to-delete junk files.
#[tauri::command]
pub async fn scan_system_junk() -> CommandResult<Vec<system_cleaner::JunkItem>> {
    // Run the potentially slow disk scan on a dedicated blocking thread to keep the Tauri UI responsive.
    tauri::async_runtime::spawn_blocking(move || Ok(system_cleaner::scan_targets()))
        .await
        .map_err(|e| e.to_string())?
}

/// Permanently deletes the selected junk files/folders from the system.
#[tauri::command]
pub async fn clean_system_junk(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
) -> CommandResult<system_cleaner::CleanResult> {
    // Passes the AppHandle down so the actual cleaner function can emit live progress events.
    system_cleaner::clean_paths(paths, &app_handle).map_err(|e| e.to_string())
}

/// Performs a simulation of the cleaning process to report how much space *would* be freed,
/// without actually deleting any files.
#[tauri::command]
pub async fn dry_run_clean(paths: Vec<String>) -> CommandResult<system_cleaner::DryRunResult> {
    system_cleaner::dry_run(paths).map_err(|e| e.to_string())
}

/// Signals the active cleaning thread to abort its operation early.
#[tauri::command]
pub async fn cancel_system_clean() -> CommandResult<()> {
    system_cleaner::cancel_cleaning();
    Ok(())
}

// ==========================================
// --- FILE ANALYZER COMMANDS ---
// ==========================================

/// Scans directories to analyze files (e.g., finding large files, old unused files, or specific types).
#[tauri::command]
pub async fn scan_directory_targets(
    app: AppHandle,
    path: Option<String>,
) -> CommandResult<Vec<analyzer::AnalysisResult>> {
    let app_handle = app.clone(); // Clone handle so it can be moved into the thread

    tauri::async_runtime::spawn_blocking(move || {
        // If a specific path is provided, use it. Otherwise, default to standard user directories.
        let targets = if let Some(p) = path {
            vec![p]
        } else {
            analyzer::get_user_dirs()
        };

        let mut results = Vec::new();
        for dir in targets {
            // Pass app_handle to emit live discovery events as files are found
            results.extend(analyzer::scan_directory(&app_handle, &dir));
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ==========================================
// --- METADATA CLEANER COMMANDS ---
// ==========================================
// These commands deal with stripping privacy-compromising metadata (like EXIF GPS data) from files.

/// Reads and reports all metadata currently attached to a target file.
#[tauri::command]
pub async fn analyze_file_metadata(path: String) -> CommandResult<cleaner::MetadataReport> {
    cleaner::analyze_file(&path).map_err(|e| e.to_string())
}

/// Strips metadata from a single file, optionally saving it to a new output directory.
#[tauri::command]
pub async fn clean_file_metadata(
    path: String,
    output_dir: Option<String>,
    options: cleaner::CleaningOptions,
) -> CommandResult<String> {
    cleaner::remove_metadata(&path, output_dir.as_deref(), options).map_err(|e| e.to_string())
}

/// Strips metadata from a batch of files asynchronously, emitting progress to the UI.
#[tauri::command]
pub async fn batch_clean_metadata(
    paths: Vec<String>,
    output_dir: Option<String>,
    options: cleaner::CleaningOptions,
    app_handle: tauri::AppHandle, // Required for sending progress events back to the frontend
) -> CommandResult<cleaner::CleanResult> {
    cleaner::batch_clean(paths, output_dir, options, &app_handle).map_err(|e| e.to_string())
}

/// Signals the active metadata cleaning thread to halt.
#[tauri::command]
pub async fn cancel_metadata_clean() -> CommandResult<()> {
    cleaner::cancel_cleaning();
    Ok(())
}

/// Compares the original file against the cleaned file to verify what metadata was successfully removed.
#[tauri::command]
pub async fn compare_metadata_files(
    original: String,
    cleaned: String,
) -> CommandResult<cleaner::ComparisonResult> {
    cleaner::compare_files(&original, &cleaned).map_err(|e| e.to_string())
}

// ==========================================
// --- HASHER COMMANDS ---
// ==========================================
// Tools for verifying file integrity using cryptographic hashes (MD5, SHA256, etc.).

/// Calculates multiple cryptographic hashes for a given file.
#[tauri::command]
pub async fn calculate_file_hashes(
    path: String,
    app_handle: tauri::AppHandle,
) -> CommandResult<hasher::HashResult> {
    hasher::calculate_hashes(&path, &app_handle).map_err(|e| e.to_string())
}

/// Retrieves basic OS-level file properties (size, creation date, etc.) prior to hashing.
#[tauri::command]
pub async fn get_file_metadata(path: String) -> CommandResult<hasher::FileMetadata> {
    hasher::get_file_metadata(&path).map_err(|e| e.to_string())
}

/// Cancels an ongoing hashing operation (useful for very large files).
#[tauri::command]
pub async fn cancel_hashing() -> CommandResult<()> {
    hasher::cancel_hashing();
    Ok(())
}

/// Utility to export calculated hashes or text output to a local file.
#[tauri::command]
pub async fn save_text_to_file(path: String, content: String) -> CommandResult<()> {
    hasher::save_text_to_file(&path, &content).map_err(|e| e.to_string())
}

/// Quickly calculates cryptographic hashes for an arbitrary string of text from the UI.
#[tauri::command]
pub async fn calculate_text_hashes(text: String) -> CommandResult<hasher::HashResult> {
    Ok(hasher::calculate_text_hashes(&text))
}

// ==========================================
// --- QR CODE COMMANDS ---
// ==========================================

/// Generates a standard text/URL QR code based on provided options (size, error correction level, etc.).
#[tauri::command]
pub async fn generate_qr(options: qr::QrOptions) -> CommandResult<qr::QrResult> {
    qr::generate_qr(options).map_err(|e| e.to_string())
}

/// Generates a specially formatted QR code that allows devices to connect to a WiFi network automatically.
#[tauri::command]
pub async fn generate_wifi_qr(options: qr::WifiQrOptions) -> CommandResult<qr::QrResult> {
    qr::generate_wifi_qr(options).map_err(|e| e.to_string())
}

/// Validates input text to ensure it isn't too large or incorrectly formatted for QR generation.
#[tauri::command]
pub async fn validate_qr_input(text: String) -> CommandResult<qr::QrValidation> {
    Ok(qr::validate_qr_input(&text))
}

// ==========================================
// --- PRIVACY & BREACH CHECK ---
// ==========================================

/// Checks if a given password has been exposed in a known data breach.
/// IMPORTANT SECURITY IMPLEMENTATION: This uses the k-Anonymity privacy model.
#[tauri::command]
pub async fn check_password_breach(sha1_hash: String) -> CommandResult<breach::BreachResult> {
    // 1. Validate that the frontend provided a properly formatted, fully calculated SHA-1 hash.
    // The raw password MUST NOT be sent to the backend to minimize memory exposure.
    if sha1_hash.len() != 40 || !sha1_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid hash format. Frontend must send a SHA-1 hash.".to_string());
    }

    // 2. Split hash for k-Anonymity (e.g., HaveIBeenPwned API model).
    // We only send the first 5 characters (`prefix`) to the external API.
    // We never send the full hash. We verify the `suffix` locally against the returned list.
    let prefix = &sha1_hash[0..5];
    let suffix = &sha1_hash[5..];

    // 3. Call breach check logic.
    breach::check_pwned_by_prefix(prefix, suffix)
        .await
        .map_err(|e| e.to_string())
}

/// Fetches the user's current public IP address (useful for VPN checks).
#[tauri::command]
pub async fn get_public_ip_address() -> CommandResult<breach::IpResult> {
    breach::get_public_ip().await.map_err(|e| e.to_string())
}

// ==========================================
// --- PASSWORD GENERATOR ---
// ==========================================

/// Generates a highly secure, memorable passphrase using a Diceware-style algorithm.
#[tauri::command]
pub fn generate_passphrase() -> String {
    // Uses a cryptographically secure random number generator (CSPRNG).
    let mut rng = rand::rng();

    // Generate exactly 6 words.
    (0..6)
        .map(|_| {
            // Select a random index within the bounds of the hardcoded EFF (Electronic Frontier Foundation) wordlist.
            let idx = (rng.next_u64() as usize) % WORDLIST.len();
            WORDLIST[idx]
        })
        .collect::<Vec<_>>()
        .join("-") // Join the 6 randomly selected words with hyphens (e.g., "correct-horse-battery-staple-apple-tree").
}

use regex::Regex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// Global cancellation flag for the secret scanner.
/// Reset to `false` at the start of every scan, set to `true` by `cancel_secret_scan`.
static SCAN_CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize)]
pub struct SecretFinding {
    pub filename: String,
    pub path: String,
    pub category: String,
}

const MAX_FINDINGS: usize = 500;

/// Checks whether the RESOLVED, CANONICAL path is safe to scan.
/// Called on both the root input AND every directory encountered during the walk.
fn is_safe_to_scan(path: &std::path::Path) -> bool {
    // Sensitive subdirectories to block even inside user home — covers all drives on Windows
    #[cfg(target_os = "windows")]
    {
        let lower = path.to_string_lossy().to_lowercase();
        let blocked = [
            "\\windows\\",
            "\\program files\\",
            "\\program files (x86)\\",
            "\\programdata\\",
            "\\system32\\",
            "\\syswow64\\",
            // Credential stores inside AppData
            "\\appdata\\roaming\\microsoft\\credentials",
            "\\appdata\\roaming\\microsoft\\vault",
            "\\appdata\\local\\microsoft\\credentials",
            "\\appdata\\roaming\\gnupg",
            "\\.ssh\\",
            "\\.aws\\",
            "\\.gnupg\\",
        ];
        if blocked.iter().any(|&b| lower.contains(b)) {
            return false;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let lower = path.to_string_lossy().to_lowercase();
        let blocked = [
            "/bin",
            "/sbin",
            "/usr/bin",
            "/usr/sbin",
            "/usr/lib",
            "/etc",
            "/var",
            "/boot",
            "/proc",
            "/sys",
            "/dev",
            "/.ssh",
            "/.aws",
            "/.gnupg",
            "/.config/google-chrome",
            "/.mozilla",
            "/library/keychains",
        ];
        if blocked
            .iter()
            .any(|&b| lower.starts_with(b) || lower.contains(b))
        {
            return false;
        }
    }
    true
}

fn is_scannable_extension(path: &std::path::Path) -> bool {
    match path.extension().and_then(|s| s.to_str()) {
        Some(ext) => matches!(
            ext.to_lowercase().as_str(),
            "txt" | "md" | "csv" | "env" | "pem" | "key" | "ini" | "conf" | "json"
        ),
        // Files without extension are skipped (e.g. SAM, NTUSER.DAT, HOSTS)
        None => false,
    }
}

/// Returns true if the filename looks like a placeholder/example file.
/// These files exist specifically to show fake values — never real secrets.
fn is_example_filename(path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    // .env.example, config.sample.js, secrets.template, etc.
    name.contains(".example")
        || name.contains(".sample")
        || name.contains(".template")
        || name.contains(".placeholder")
        || name == ".env.example"
        || name == ".env.sample"
}

/// Returns true if the line is a comment — these almost never contain real secrets.
fn is_comment_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("//")
        || t.starts_with('#')
        || t.starts_with('*')
        || t.starts_with("<!--")
        || t.starts_with("```") // markdown code fence labels
}

/// Returns true if the extracted value looks like a documentation placeholder.
fn looks_like_placeholder(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "your_",
        "your-",
        "yourkey",
        "example",
        "placeholder",
        "changeme",
        "replace",
        "enter_",
        "_here",
        "xxxx",
        "test",
        "dummy",
        "sample",
        "process.env",
        "env.",
        "<",
        ">",
        "todo",
        "fixme",
        "insert",
        "put_your",
    ]
    .iter()
    .any(|&p| lower.contains(p))
}

/// Computes Shannon entropy of a string.
/// Real secrets (random tokens, keys) have entropy > 3.5.
/// Dictionary words, type names, and placeholders have entropy < 3.5.
fn value_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut freq = [0usize; 256];
    for b in s.bytes() {
        freq[b as usize] += 1;
    }
    let len = s.len() as f64;
    freq.iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / len;
            -p * p.log2()
        })
        .sum()
}

/// Quickly checks first 512 bytes for null bytes — reliable binary file detection.
fn looks_like_binary(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut buf = [0u8; 512];
    match std::fs::File::open(path).and_then(|mut f| f.read(&mut buf)) {
        Ok(n) => buf[..n].contains(&0u8),
        Err(_) => true, // If we can't read it, skip it
    }
}

/// Developer tool directories that are never user-authored and always generate
/// enormous false positives. Skipped entirely via filter_entry (never descended into).
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    "target", // Rust build output
    "__pycache__",
    ".cache",
    ".parcel-cache",
    "vendor", // PHP / Go dependencies
    ".venv",
    "venv",
    ".tox",
    "coverage",
    ".terraform",
    ".gradle",
    ".m2",        // Maven local repo
    "Pods",       // iOS CocoaPods
    ".pub-cache", // Dart/Flutter
];

#[tauri::command]
pub async fn scan_local_secrets(
    dir_path: String,
    app_handle: tauri::AppHandle,
) -> Result<Vec<SecretFinding>, String> {
    // Reset cancel flag for this new scan
    SCAN_CANCEL_FLAG.store(false, Ordering::Relaxed);

    // Canonicalize to resolve any ".." traversal before security checks
    let canonical = std::fs::canonicalize(&dir_path)
        .map_err(|_| "Could not resolve the selected directory.".to_string())?;

    if !is_safe_to_scan(&canonical) {
        return Err("Protected system directories cannot be scanned.".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut findings = Vec::new();

        if !canonical.exists() || !canonical.is_dir() {
            return Err("Invalid directory".to_string());
        }

        // Compile regexes ONCE outside the loop.
        // Whitespace quantifier capped at {0,5} to prevent ReDoS.
        // Capture group 2 captures the value so we can entropy-check it.
        let regex_credentials = Regex::new(
            r#"(?i)(password|secret|api_key|token|access_key)[\s]{0,5}[:=][\s]{0,5}['"]?([a-zA-Z0-9\-_]{16,})['"]?"#,
        ).unwrap();
        // High-confidence specific key formats — no entropy check needed, format is unique
        let regex_api = Regex::new(
            r"(sk_live_[0-9a-zA-Z]{24,}|sk_test_[0-9a-zA-Z]{24,}|ghp_[0-9a-zA-Z]{36}|gho_[0-9a-zA-Z]{36}|AKIA[0-9A-Z]{16}|eyJ[a-zA-Z0-9_-]{20,}[.][a-zA-Z0-9_-]{20,})",
        ).unwrap();
        // Crypto seed phrases: exactly 12 lowercase BIP-39 words on a single line
        let regex_seed = Regex::new(r"^(?:[a-z]{3,}\s){11}[a-z]{3,}$").unwrap();

        for entry in walkdir::WalkDir::new(&canonical)
            .max_depth(5)
            .follow_links(false) // Never follow symlinks — prevents scope escapes
            .into_iter()
            .filter_entry(|e| {
                // filter_entry prunes entire directory subtrees — far more efficient
                // than filter_map which still lists every entry before skipping
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    return !SKIP_DIRS.iter().any(|&d| name == d);
                }
                true
            })
            .filter_map(|e| e.ok())
        {
            let p = entry.path();

            // Check cancellation before every file
            if SCAN_CANCEL_FLAG.load(Ordering::Relaxed) {
                break;
            }

            // Cap total findings to prevent UI freeze
            if findings.len() >= MAX_FINDINGS {
                break;
            }

            if !p.is_file() {
                continue;
            }

            // Skip blocked subdirectories encountered during the walk
            if !is_safe_to_scan(p) {
                continue;
            }

            if !is_scannable_extension(p) {
                continue;
            }

            // Skip example/template/sample files — they contain fake values by design
            if is_example_filename(p) {
                continue;
            }

            if let Ok(metadata) = entry.metadata() {
                if metadata.len() > 1024 * 1024 {
                    continue;
                }
            }

            // Check for binary content before reading entire file into memory
            if looks_like_binary(p) {
                continue;
            }

            let _ = app_handle.emit("secret-scan-progress", p.to_string_lossy().to_string());

            if let Ok(file_content) = std::fs::read_to_string(p) {
                let mut found_category = None;

                for line in file_content.lines() {
                    // Skip comment lines — documentation never contains real secrets
                    if is_comment_line(line) {
                        continue;
                    }

                    // High-confidence API key formats — match immediately
                    if regex_api.is_match(line) {
                        found_category = Some("API Key");
                        break;
                    }

                    // Credential pairs — require entropy check on the captured value
                    if let Some(caps) = regex_credentials.captures(line) {
                        if let Some(val) = caps.get(2) {
                            let v = val.as_str();
                            if !looks_like_placeholder(v) && value_entropy(v) > 3.5 {
                                found_category = Some("Credential Pair");
                                break;
                            }
                        }
                    }

                    // Seed phrases — structure is highly specific, no entropy check needed
                    if regex_seed.is_match(line.trim()) {
                        found_category = Some("Crypto Seed Phrase");
                        break;
                    }
                }

                if let Some(category) = found_category {
                    findings.push(SecretFinding {
                        filename: entry.file_name().to_string_lossy().to_string(),
                        path: p.to_string_lossy().to_string(),
                        category: category.to_string(),
                    });
                }
            }
        }
        Ok(findings)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Signals the secret scanner to stop after the current file and return partial results.
#[tauri::command]
pub async fn cancel_secret_scan() -> CommandResult<()> {
    SCAN_CANCEL_FLAG.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn scan_registry() -> Vec<registry_cleaner::RegistryItem> {
    registry_cleaner::scan_registry()
}

#[tauri::command]
pub fn backup_registry() -> registry_cleaner::RegistryBackupResult {
    registry_cleaner::backup_registry()
}

#[tauri::command]
pub fn clean_registry(
    entries: Vec<registry_cleaner::RegistryCleanEntry>,
) -> registry_cleaner::RegistryCleanResult {
    registry_cleaner::clean_registry_entries(entries)
}

// --- END OF FILE tools.rs ---
