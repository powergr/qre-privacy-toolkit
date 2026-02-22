use crate::analyzer;
use crate::breach;
use crate::cleaner::{self};
use crate::hasher;
use crate::qr;
use crate::system_cleaner;
use crate::wordlist::WORDLIST;
use rand::RngCore;
use tauri::AppHandle;

pub type CommandResult<T> = Result<T, String>;

// --- SYSTEM CLEANER COMMANDS ---

#[tauri::command]
pub async fn scan_system_junk() -> CommandResult<Vec<system_cleaner::JunkItem>> {
    tauri::async_runtime::spawn_blocking(move || Ok(system_cleaner::scan_targets()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clean_system_junk(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
) -> CommandResult<system_cleaner::CleanResult> {
    // ← Changed return type
    system_cleaner::clean_paths(paths, &app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dry_run_clean(paths: Vec<String>) -> CommandResult<system_cleaner::DryRunResult> {
    system_cleaner::dry_run(paths).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_system_clean() -> CommandResult<()> {
    system_cleaner::cancel_cleaning();
    Ok(())
}

// --- FILE ANALYZER COMMANDS ---

#[tauri::command]
pub async fn scan_directory_targets(
    app: AppHandle,
    path: Option<String>,
) -> CommandResult<Vec<analyzer::AnalysisResult>> {
    let app_handle = app.clone(); // Clone handle for the thread

    tauri::async_runtime::spawn_blocking(move || {
        let targets = if let Some(p) = path {
            vec![p]
        } else {
            analyzer::get_user_dirs()
        };

        let mut results = Vec::new();
        for dir in targets {
            // Pass app_handle to emit events
            results.extend(analyzer::scan_directory(&app_handle, &dir));
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- METADATA CLEANER COMMANDS ---

#[tauri::command]
pub async fn analyze_file_metadata(path: String) -> CommandResult<cleaner::MetadataReport> {
    cleaner::analyze_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clean_file_metadata(
    path: String,
    output_dir: Option<String>,
    options: cleaner::CleaningOptions,
) -> CommandResult<String> {
    cleaner::remove_metadata(&path, output_dir.as_deref(), options).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn batch_clean_metadata(
    paths: Vec<String>,
    output_dir: Option<String>,
    options: cleaner::CleaningOptions,
    app_handle: tauri::AppHandle, // Required for progress events
) -> CommandResult<cleaner::CleanResult> {
    cleaner::batch_clean(paths, output_dir, options, &app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_metadata_clean() -> CommandResult<()> {
    cleaner::cancel_cleaning();
    Ok(())
}

#[tauri::command]
pub async fn compare_metadata_files(
    original: String,
    cleaned: String,
) -> CommandResult<cleaner::ComparisonResult> {
    cleaner::compare_files(&original, &cleaned).map_err(|e| e.to_string())
}

// --- HASHER COMMANDS ---

#[tauri::command]
pub async fn calculate_file_hashes(
    path: String,
    app_handle: tauri::AppHandle,
) -> CommandResult<hasher::HashResult> {
    hasher::calculate_hashes(&path, &app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_file_metadata(path: String) -> CommandResult<hasher::FileMetadata> {
    hasher::get_file_metadata(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_hashing() -> CommandResult<()> {
    hasher::cancel_hashing();
    Ok(())
}

#[tauri::command]
pub async fn save_text_to_file(path: String, content: String) -> CommandResult<()> {
    hasher::save_text_to_file(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn calculate_text_hashes(text: String) -> CommandResult<hasher::HashResult> {
    Ok(hasher::calculate_text_hashes(&text))
}

// --- QR CODE COMMANDS ---

#[tauri::command]
pub async fn generate_qr(options: qr::QrOptions) -> CommandResult<qr::QrResult> {
    qr::generate_qr(options).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_wifi_qr(options: qr::WifiQrOptions) -> CommandResult<qr::QrResult> {
    qr::generate_wifi_qr(options).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn validate_qr_input(text: String) -> CommandResult<qr::QrValidation> {
    Ok(qr::validate_qr_input(&text))
}

// --- PRIVACY & BREACH CHECK ---

#[tauri::command]
pub async fn check_password_breach(sha1_hash: String) -> CommandResult<breach::BreachResult> {
    // Validate input (40 hex characters)
    if sha1_hash.len() != 40 || !sha1_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid hash format. Frontend must send a SHA-1 hash.".to_string());
    }

    // Split hash for k-Anonymity
    let prefix = &sha1_hash[0..5];
    let suffix = &sha1_hash[5..];

    // Call breach check
    breach::check_pwned_by_prefix(prefix, suffix)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_public_ip_address() -> CommandResult<breach::IpResult> {
    breach::get_public_ip().await.map_err(|e| e.to_string())
}

// --- PASSWORD GENERATOR ---

#[tauri::command]
pub fn generate_passphrase() -> String {
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| {
            let idx = (rng.next_u64() as usize) % WORDLIST.len();
            WORDLIST[idx]
        })
        .collect::<Vec<_>>()
        .join("-")
}
