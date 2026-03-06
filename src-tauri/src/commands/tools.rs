// --- START OF FILE tools.rs ---

use crate::analyzer;
use crate::breach;
use crate::cleaner::{self};
use crate::hasher;
use crate::qr;
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

// --- END OF FILE tools.rs ---
