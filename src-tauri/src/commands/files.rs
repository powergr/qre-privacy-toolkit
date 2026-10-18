// --- START OF FILE files.rs ---

use crate::cancel;
use crate::crypto;
use crate::crypto_stream;
use crate::keychain::MasterKey;
use crate::os_clipboard::{self, ClipboardFiles};
use crate::shredder;
use crate::state::SessionState;
use crate::utils;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[cfg(not(target_os = "android"))]
use std::process::Command;

#[cfg(not(target_os = "android"))]
use sysinfo::Disks;

pub type CommandResult<T> = Result<T, String>;

#[derive(serde::Serialize)]
pub struct BatchItemResult {
    pub name: String,
    pub success: bool,
    pub message: String,
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn is_already_compressed(filename: &str) -> bool {
    let ext = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    matches!(
        ext.as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "zip"
            | "7z"
            | "rar"
            | "gz"
            | "bz2"
            | "xz"
            | "mp4"
            | "mkv"
            | "mov"
            | "avi"
            | "webm"
            | "mp3"
            | "aac"
            | "flac"
            | "wav"
            | "pdf"
    )
}

pub(crate) fn is_system_critical(path: &Path) -> bool {
    let path_str = path.to_string_lossy().to_lowercase();

    if cfg!(target_os = "windows") {
        if path_str.starts_with("c:\\windows")
            || path_str.starts_with("c:\\program files")
            || path_str.starts_with("c:\\program files (x86)")
            || path_str == "c:\\"
        {
            return true;
        }
    } else {
        if is_unix_critical(&path_str, cfg!(target_os = "macos")) {
            return true;
        }
    }
    false
}

/// The Linux and macOS half of is_system_critical, working on the lower-cased path text.
///
/// Folders are compared by whole name, so /var is protected but /variables is not.
/// With macos set, the system folders of macOS are protected too. The user's temporary
/// folder (/var/folders and /tmp there) is not, because every Mac keeps it under /var.
pub(crate) fn is_unix_critical(path_lower: &str, macos: bool) -> bool {
    let parts: Vec<&str> = path_lower.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return path_lower.starts_with('/');
    }

    if macos {
        const USER_TEMP: &[&[&str]] = &[
            &["var", "folders"],
            &["private", "var", "folders"],
            &["tmp"],
            &["private", "tmp"],
        ];
        if USER_TEMP.iter().any(|t| parts.starts_with(t)) {
            return false;
        }
    }

    const CRITICAL: &[&[&str]] = &[
        &["bin"],
        &["sbin"],
        &["usr", "bin"],
        &["usr", "sbin"],
        &["etc"],
        &["var"],
        &["boot"],
        &["proc"],
        &["sys"],
        &["dev"],
    ];
    const MACOS_CRITICAL: &[&[&str]] = &[
        &["system"],
        &["library"],
        &["applications"],
        &["private"],
    ];
    CRITICAL.iter().any(|c| parts.starts_with(c))
        || (macos && MACOS_CRITICAL.iter().any(|c| parts.starts_with(c)))
}

pub(crate) fn reject_critical_path(path: &Path) -> Result<(), String> {
    if path.components().any(|c| c == Component::ParentDir) {
        return Err("Path traversal not allowed: path must not contain '..'".to_string());
    }
    if is_system_critical(path) {
        return Err(format!(
            "Access Denied: '{}' is a protected system path.",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn reject_path_traversal(path: &Path) -> Result<(), String> {
    if path.components().any(|c| c == Component::ParentDir) {
        return Err("Path traversal not allowed: path must not contain '..'".to_string());
    }
    Ok(())
}

/// The fastest zstd setting this app uses. Level 0 does not mean "none": in zstd it means "use the
/// default level" (3), so "store" used to compress as much as Auto. A negative level is
/// zstd's fast mode, which does almost no work and, on data that does not compress (video,
/// archives, photos), writes it nearly as it is. True "no compression" would need a new
/// marker in the file format, and older versions of the app could not open such files.
pub(crate) const FASTEST_ZSTD_LEVEL: i32 = -7;

/// Zstd level for a lock request. `mode` is "store", "extreme", or anything else for auto.
pub(crate) fn compression_level(mode: &str, filename: &str) -> i32 {
    match mode {
        "store" => FASTEST_ZSTD_LEVEL,
        "extreme" => 19,
        _ => {
            if is_already_compressed(filename) {
                1
            } else {
                3
            }
        }
    }
}

/// Whether to open each new locked file once to check it. Checking is the default: a request
/// that says nothing about it (an older caller) gets the safer behaviour.
pub(crate) fn should_verify(verify_after: Option<bool>) -> bool {
    verify_after.unwrap_or(true)
}

/// Progress shown while locking. With a check afterwards, locking fills the first half of the
/// bar and the check the second half, so the bar never runs twice.
pub(crate) fn lock_progress_percent(phase_percent: u8, verifying_after: bool, in_check: bool) -> u8 {
    let pct = phase_percent.min(100) as u32;
    if !verifying_after {
        return pct as u8;
    }
    let half = pct / 2;
    (if in_check { 50 + half } else { half }) as u8
}

/// True if `path` sits on a drive that is currently an unlocked portable vault.
/// Encrypting there would leave plaintext traces on the USB drive ("ghost files").
pub(crate) fn is_on_portable_mount(
    path: &str,
    mounts: &std::collections::HashMap<String, String>,
) -> bool {
    let path_lower = path.to_lowercase();
    mounts.keys().any(|m| path_lower.starts_with(&m.to_lowercase()))
}

// --- CRYPTO LOGIC ---

/// Where progress goes. The commands send it to the window; the tests collect it.
pub(crate) type Progress = Arc<dyn Fn(&str, u8) + Send + Sync>;

/// What to report for the files a cancelled job did not get to: one line, not one per file.
pub(crate) fn cancelled_rest(results: &mut Vec<BatchItemResult>, remaining: usize) {
    if remaining == 0 {
        return;
    }
    let name = if remaining == 1 { "1 more file".to_string() } else { format!("{} more files", remaining) };
    results.push(BatchItemResult { name, success: false, message: format!("{} Not started.", cancel::CANCELLED) });
}

/// Stops the job that is running: locking, unlocking or upgrading. It ends at its next step, which
/// is at most one chunk of 1 MiB away, and removes what it was writing. Files that were finished
/// before the stop stay finished. Asking when nothing is running does nothing.
#[tauri::command]
pub fn cancel_operation(state: tauri::State<'_, SessionState>) {
    cancel::request(&state.cancel);
}

/// The unlocked vaults, by id.
pub(crate) type Vaults = Arc<Mutex<HashMap<String, MasterKey>>>;

/// Drive mount paths of unlocked portable vaults, by vault id.
pub(crate) type Mounts = Arc<Mutex<HashMap<String, String>>>;

/// Progress that is shown in the app window.
pub(crate) fn window_progress(app: &AppHandle) -> Progress {
    let app = app.clone();
    Arc::new(move |label: &str, percentage: u8| utils::emit_progress(&app, label, percentage))
}

/// What a lock request asks for, after the command has read the key file.
pub(crate) struct LockRequest {
    pub file_paths: Vec<String>,
    pub keyfile_hash: Option<Vec<u8>>,
    pub raw_entropy: Option<Vec<u8>>,
    pub mode: String,
    pub verify: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // the arguments are what the window sends
pub async fn lock_file(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>,
    keyfile_path: Option<String>,
    keyfile_bytes: Option<Vec<u8>>,
    extra_entropy: Option<Vec<u8>>,
    compression_mode: Option<String>,
    verify_after: Option<bool>,
) -> CommandResult<Vec<BatchItemResult>> {
    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    let request = LockRequest {
        file_paths,
        keyfile_hash,
        raw_entropy: extra_entropy,
        mode: compression_mode.unwrap_or("auto".to_string()),
        verify: should_verify(verify_after),
    };

    let vaults_arc = state.vaults.clone();
    let portable_mounts_arc = state.portable_mounts.clone();
    let progress = window_progress(&app);
    let stop = state.cancel.clone();
    cancel::reset(&stop);

    tauri::async_runtime::spawn_blocking(move || {
        cancel::run_with(&stop, || lock_files_blocking(request, &vaults_arc, &portable_mounts_arc, &progress))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The work of `lock_file`, without the window: it takes the vaults and a progress sink, so
/// tests can run the same path the command runs.
pub(crate) fn lock_files_blocking(
    request: LockRequest,
    vaults_arc: &Vaults,
    portable_mounts_arc: &Mounts,
    progress: &Progress,
) -> CommandResult<Vec<BatchItemResult>> {
    let LockRequest { file_paths, keyfile_hash, raw_entropy, mode: mode_str, verify } = request;
    {
        let mut results = Vec::new();
        let total = file_paths.len();

        for (file_index, file_path) in file_paths.into_iter().enumerate() {
            if cancel::is_cancelled() {
                cancelled_rest(&mut results, total - file_index);
                break;
            }
            let path = Path::new(&file_path);

            if let Err(e) = reject_critical_path(path) {
                results.push(BatchItemResult { name: path.to_string_lossy().to_string(), success: false, message: e });
                continue;
            }

            {
                let mounts = portable_mounts_arc.lock().unwrap_or_else(|e| e.into_inner());
                if is_on_portable_mount(&path.to_string_lossy(), &mounts) {
                    results.push(BatchItemResult {
                        name: path.to_string_lossy().to_string(),
                        success: false,
                        message: "Ghost-file protection: files on a portable USB drive cannot be encrypted directly. Copy the file to your PC first, encrypt it there, then move the .qre file to the USB drive.".to_string(),
                    });
                    continue;
                }
            }

            let vault_id = "local".to_string();

            let master_key = {
                let guard = match vaults_arc.lock() {
                    Ok(g) => g,
                    Err(poisoned) => {
                        let mut p = poisoned.into_inner();
                        p.clear();
                        return Err("Session state corrupted.".to_string());
                    }
                };
                match guard.get(&vault_id) {
                    Some(mk) => mk.clone(),
                    None => {
                        results.push(BatchItemResult { name: path.to_string_lossy().to_string(), success: false, message: format!("Vault '{}' is locked.", vault_id) });
                        continue;
                    }
                }
            };

            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            progress(&format!("Preparing: {}", filename), 5);

            let level = compression_level(&mode_str, &filename);

            let (input_path_str, is_temp) = if path.is_dir() {
                let parent = path.parent().unwrap_or(Path::new("."));
                let temp_zip_name = format!("{}.zip", filename);
                let temp_zip_path = utils::get_unique_path(&parent.join(&temp_zip_name));

                progress(&format!("Zipping Folder: {}", filename), 10);
                if let Err(e) = utils::zip_directory_to_file(path, &temp_zip_path) {
                    results.push(BatchItemResult { name: filename.to_string(), success: false, message: if e == cancel::CANCELLED { e } else { format!("Zip failed: {}", e) } });
                    continue;
                }
                (temp_zip_path.to_string_lossy().to_string(), true)
            } else {
                (file_path.clone(), false)
            };

            let raw_output = format!("{}.qre", file_path);
            let final_path = utils::get_unique_path(Path::new(&raw_output));
            let final_path_str = final_path.to_string_lossy().to_string();

            let entropy_seed: Option<[u8; 32]> = raw_entropy.as_ref().map(|bytes| {
                let mut hasher = Sha256::new();
                hasher.update(bytes);
                hasher.update((file_index as u64).to_le_bytes());
                hasher.finalize().into()
            });

            let progress_for_cb = progress.clone();
            let f_name_clone = filename.to_string();

            let progress_cb = move |processed: u64, total: u64| {
                if total > 0 {
                    let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                    let display_pct = if is_temp { 20u8.saturating_add((pct as f64 * 0.8) as u8).min(100) } else { pct };
                    progress_for_cb(&format!("Encrypting: {}", f_name_clone), lock_progress_percent(display_pct, verify, false));
                }
            };

let encryption_result = crypto_stream::encrypt_file_stream(
    &input_path_str, &final_path_str, &master_key, &vault_id, keyfile_hash.as_deref(), None, entropy_seed, level, progress_cb,
);

            if is_temp { let _ = fs::remove_file(&input_path_str); }

            match encryption_result {
                Ok(_) if verify => {
                    // Open the new file once, the way unlocking would, before calling it done.
                    progress(&format!("Verifying: {}", filename), 50);
                    let progress_for_check = progress.clone();
                    let name_for_check = filename.clone();
                    let check_progress = move |processed: u64, total: u64| {
                        if total > 0 {
                            let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                            progress_for_check(&format!("Verifying: {}", name_for_check), lock_progress_percent(pct, true, true));
                        }
                    };
                    match crypto_stream::verify_or_remove(&final_path_str, &master_key, keyfile_hash.as_deref(), check_progress) {
                        Ok(()) => results.push(BatchItemResult { name: filename.to_string(), success: true, message: "Locked and verified".into() }),
                        Err(message) => results.push(BatchItemResult { name: filename.to_string(), success: false, message }),
                    }
                }
                Ok(_) => results.push(BatchItemResult { name: filename.to_string(), success: true, message: "Locked".into() }),
                Err(e) => {
                    let _ = fs::remove_file(&final_path);
                    results.push(BatchItemResult { name: filename.to_string(), success: false, message: e.to_string() });
                }
            }
        }
        Ok(results)
    }
}

#[tauri::command]
pub async fn unlock_file(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>,
    keyfile_path: Option<String>,
    keyfile_bytes: Option<Vec<u8>>,
    output_dir: Option<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    let vaults_arc = state.vaults.clone();
    let progress = window_progress(&app);
    let stop = state.cancel.clone();
    cancel::reset(&stop);

    tauri::async_runtime::spawn_blocking(move || {
        cancel::run_with(&stop, || unlock_files_blocking(file_paths, keyfile_hash, output_dir, &vaults_arc, &progress))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The work of `unlock_file`, without the window (see `lock_files_blocking`).
pub(crate) fn unlock_files_blocking(
    file_paths: Vec<String>,
    keyfile_hash: Option<Vec<u8>>,
    output_dir: Option<String>,
    vaults_arc: &Vaults,
    progress: &Progress,
) -> CommandResult<Vec<BatchItemResult>> {
    {
        let mut results = Vec::new();
        let total = file_paths.len();

        for (file_index, file_path) in file_paths.into_iter().enumerate() {
            if cancel::is_cancelled() {
                cancelled_rest(&mut results, total - file_index);
                break;
            }
            let path = Path::new(&file_path);
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();

            progress(&format!("Checking: {}", filename), 5);

            let mut file = match fs::File::open(path) {
                Ok(f) => f,
                Err(e) => { results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }); continue; }
            };

            let mut ver_buf = [0u8; 4];
            if file.read_exact(&mut ver_buf).is_err() {
                results.push(BatchItemResult { name: filename, success: false, message: "Invalid file".into() });
                continue;
            }
            let version = u32::from_le_bytes(ver_buf);

            let target_dir_path = match &output_dir {
                Some(dir) => std::path::PathBuf::from(dir),
                None => path.parent().unwrap_or(Path::new(".")).to_path_buf(),
            };
            let target_dir_str = target_dir_path.to_string_lossy().to_string();

            if version == 4 {
                let master_key = {
                    let guard = match utils::lock_or_clear(vaults_arc) {
                        Ok(g) => g,
                        Err(e) => {
                            results.push(BatchItemResult { name: filename.clone(), success: false, message: e });
                            continue;
                        }
                    };
                    match guard.get("local") {
                        Some(mk) => mk.clone(),
                        None => {
                            results.push(BatchItemResult { name: filename.clone(), success: false, message: "Local Vault is locked.".to_string() });
                            continue;
                        }
                    }
                };

                match crypto::EncryptedFileContainer::load(&file_path) {
                    Ok(container) => {
                        progress(&format!("Decrypting: {}", filename), 50);
                        match crypto::decrypt_file_with_master_key(&master_key, keyfile_hash.as_deref(), &container) {
                            Ok(payload) => {
                                progress(&format!("Writing: {}", payload.filename), 80);
                                let final_path = utils::get_unique_path(&target_dir_path.join(&payload.filename));

                                if let Err(e) = fs::write(&final_path, &payload.content) {
                                    let _ = fs::remove_file(&final_path);
                                    results.push(BatchItemResult { name: filename, success: false, message: e.to_string() });
                                } else {
                                    results.push(BatchItemResult { name: filename, success: true, message: "Unlocked".into() });
                                }
                            }
                            Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                        }
                    }
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            } else if (5..=8).contains(&version) {
                let vault_id = crypto_stream::read_vault_id(&file_path)
                    .unwrap_or_else(|| "local".to_string());

                let master_key = {
                    let guard = match utils::lock_or_clear(vaults_arc) {
                        Ok(g) => g,
                        Err(e) => {
                            results.push(BatchItemResult { name: filename.clone(), success: false, message: e });
                            continue;
                        }
                    };
                    match guard.get(&vault_id) {
                        Some(mk) => mk.clone(),
                        None => {
                            results.push(BatchItemResult { 
                                name: filename.clone(), 
                                success: false, 
                                message: if vault_id == "local" { "Local Vault is locked.".to_string() } else { "This file belongs to a Portable USB Vault. Please unlock the USB drive first.".to_string() }
                            });
                            continue;
                        }
                    }
                };

                let progress_for_cb = progress.clone();
                let f_name = filename.clone();

                let progress_cb = move |processed: u64, total: u64| {
                    if total > 0 {
                        let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                        progress_for_cb(&format!("Decrypting: {}", f_name), pct);
                    }
                };

                match crypto_stream::decrypt_file_stream(&file_path, &target_dir_str, &master_key, keyfile_hash.as_deref(), progress_cb) {
                    Ok(out_name) => results.push(BatchItemResult { name: filename, success: true, message: format!("Unlocked: {}", out_name) }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            } else {
                results.push(BatchItemResult { name: filename, success: false, message: format!("Unsupported Version: {}", version) });
            }
        }
        Ok(results)
    }
}

// --- UPGRADING OLD LOCKED FILES ---

/// A locked file in an older format (5, 6 or 7), as found by a scan of a folder.
#[derive(serde::Serialize, Debug)]
pub struct OldFormatFile {
    pub path: String,
    pub name: String,
    pub version: u32,
    /// For a time-locked file, the Unix time the lock ends. `None` otherwise.
    pub locked_until: Option<u64>,
}

/// How deep and how wide a scan goes. A folder tree larger than this is cut off, not scanned
/// forever.
const SCAN_MAX_DEPTH: usize = 12;
const SCAN_MAX_ENTRIES: usize = 50_000;

/// Finds the `.qre` files in `dir` that are in format 5, 6 or 7, sorted by path. Symbolic links
/// are not followed, and anything that cannot be read is skipped.
pub(crate) fn find_old_format_files_in(dir: &Path, recursive: bool) -> Vec<OldFormatFile> {
    let mut found = Vec::new();
    let mut pending: Vec<(PathBuf, usize)> = vec![(dir.to_path_buf(), 0)];
    let mut seen = 0usize;

    while let Some((folder, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > SCAN_MAX_ENTRIES {
                found.sort_by(|a: &OldFormatFile, b| a.path.cmp(&b.path));
                return found;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if recursive && depth < SCAN_MAX_DEPTH {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().ends_with(".qre") {
                continue;
            }
            let path_str = path.to_string_lossy().to_string();
            let Some(version) = crypto_stream::stream_version(&path_str) else { continue };
            if !crypto_stream::is_upgradable_version(version) {
                continue;
            }
            let locked_until = crypto_stream::read_timelock_header(&path_str)
                .ok()
                .flatten()
                .map(|meta| meta.locked_until);
            found.push(OldFormatFile { path: path_str, name, version, locked_until });
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

#[tauri::command]
pub async fn find_old_format_files(folder: String, recursive: bool) -> CommandResult<Vec<OldFormatFile>> {
    reject_path_traversal(Path::new(&folder))?;
    if !Path::new(&folder).is_dir() {
        return Err("Folder not found.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || find_old_format_files_in(Path::new(&folder), recursive))
        .await
        .map_err(|e| e.to_string())
}

/// Rewrites locked files from format 5, 6 or 7 as format 8. See `crypto_stream::relock_file_stream`
/// for what happens to each file.
#[tauri::command]
pub async fn relock_file(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_paths: Vec<String>,
    keyfile_path: Option<String>,
    keyfile_bytes: Option<Vec<u8>>,
) -> CommandResult<Vec<BatchItemResult>> {
    let keyfile_hash = if let Some(bytes) = keyfile_bytes {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        Some(hasher.finalize().to_vec())
    } else {
        utils::process_keyfile(keyfile_path)?
    };

    let vaults_arc = state.vaults.clone();
    let progress = window_progress(&app);
    let stop = state.cancel.clone();
    cancel::reset(&stop);

    tauri::async_runtime::spawn_blocking(move || {
        cancel::run_with(&stop, || relock_files_blocking(file_paths, keyfile_hash, &vaults_arc, &progress))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The work of `relock_file`, without the window (see `lock_files_blocking`).
pub(crate) fn relock_files_blocking(
    file_paths: Vec<String>,
    keyfile_hash: Option<Vec<u8>>,
    vaults_arc: &Vaults,
    progress: &Progress,
) -> CommandResult<Vec<BatchItemResult>> {
    let mut results = Vec::new();
    let total = file_paths.len();

    for (file_index, file_path) in file_paths.into_iter().enumerate() {
        if cancel::is_cancelled() {
            cancelled_rest(&mut results, total - file_index);
            break;
        }
        let path = Path::new(&file_path);
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let fail = |message: String| BatchItemResult { name: name.clone(), success: false, message };

        if let Err(e) = reject_critical_path(path) {
            results.push(fail(e));
            continue;
        }
        if !name.to_lowercase().ends_with(".qre") {
            results.push(fail("This is not a locked file (.qre).".to_string()));
            continue;
        }

        match crypto_stream::stream_version(&file_path) {
            Some(v) if crypto_stream::is_upgradable_version(v) => {}
            Some(8) => {
                results.push(BatchItemResult {
                    name: name.clone(),
                    success: true,
                    message: "Already in the current format".into(),
                });
                continue;
            }
            _ => {
                results.push(fail("This is not a locked file that can be upgraded.".to_string()));
                continue;
            }
        }

        let vault_id = crypto_stream::read_vault_id(&file_path).unwrap_or_else(|| "local".to_string());
        let master_key = {
            let guard = match utils::lock_or_clear(vaults_arc) {
                Ok(g) => g,
                Err(e) => {
                    results.push(fail(e));
                    continue;
                }
            };
            match guard.get(&vault_id) {
                Some(mk) => mk.clone(),
                None => {
                    results.push(fail(if vault_id == "local" {
                        "Local Vault is locked.".to_string()
                    } else {
                        "This file belongs to a Portable USB Vault. Please unlock the USB drive first.".to_string()
                    }));
                    continue;
                }
            }
        };

        progress(&format!("Upgrading: {}", name), 5);
        let level = compression_level("auto", &name);
        let write_progress = {
            let progress = progress.clone();
            let name = name.clone();
            move |processed: u64, total: u64| {
                if total > 0 {
                    let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                    progress(&format!("Upgrading: {}", name), lock_progress_percent(pct, true, false));
                }
            }
        };
        let check_progress = {
            let progress = progress.clone();
            let name = name.clone();
            move |processed: u64, total: u64| {
                if total > 0 {
                    let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(100);
                    progress(&format!("Checking: {}", name), lock_progress_percent(pct, true, true));
                }
            }
        };

        match crypto_stream::relock_file_stream(&file_path, &master_key, keyfile_hash.as_deref(), level, write_progress, check_progress) {
            Ok(()) => results.push(BatchItemResult {
                name: name.clone(),
                success: true,
                message: "Upgraded to the current format".into(),
            }),
            Err(e) => {
                let text = e.to_string();
                let message = if text == cancel::CANCELLED {
                    format!("{} The old file was not changed.", cancel::CANCELLED)
                } else if let Some(rest) = text.strip_prefix("TIME_LOCKED:") {
                    // "<unix time>:<sentence>". Say what to do about it.
                    let sentence = rest.split_once(':').map(|(_, s)| s).unwrap_or(rest);
                    format!("{} Upgrade it after the lock ends.", sentence)
                } else if text.starts_with("Decryption Denied") {
                    format!("{} If it was locked with a key file, select that key file and try again.", text)
                } else {
                    text
                };
                results.push(fail(message));
            }
        }
    }
    Ok(results)
}

// --- FILE OPERATIONS ---

#[tauri::command]
pub async fn delete_items(
    app: AppHandle,
    paths: Vec<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for path in paths {
            let p = Path::new(&path);

            if let Err(e) = reject_critical_path(p) {
                results.push(BatchItemResult { name: p.to_string_lossy().to_string(), success: false, message: e });
                continue;
            }

            let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();

            #[cfg(target_os = "android")]
            {
                utils::emit_progress(&app, &format!("Deleting {}", filename), 50);
                let res = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
                match res {
                    Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Deleted".into() }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            }

            #[cfg(not(target_os = "android"))]
            {
                utils::emit_progress(&app, &format!("Preparing to shred {}", filename), 0);
                match utils::shred_recursive(&app, p) {
                    Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Deleted".into() }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e }),
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_items(
    app: AppHandle,
    paths: Vec<String>,
) -> CommandResult<Vec<BatchItemResult>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();

        for path in paths {
            let p = Path::new(&path);

            if let Err(e) = reject_critical_path(p) {
                results.push(BatchItemResult { name: p.to_string_lossy().to_string(), success: false, message: e });
                continue;
            }

            let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();

            #[cfg(target_os = "android")]
            {
                utils::emit_progress(&app, &format!("Deleting {}", filename), 50);
                let res = if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
                match res {
                    Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Deleted (No Trash)".into() }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e.to_string() }),
                }
            }

            #[cfg(not(target_os = "android"))]
            {
                utils::emit_progress(&app, &format!("Trashing {}", filename), 50);
                match utils::move_to_trash(p) {
                    Ok(_) => results.push(BatchItemResult { name: filename, success: true, message: "Moved to Trash".into() }),
                    Err(e) => results.push(BatchItemResult { name: filename, success: false, message: e }),
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// True if `dest` is `dir` itself or lies somewhere inside it.
fn is_inside_dir(dest: &Path, dir: &Path) -> bool {
    let dest = fs::canonicalize(dest).unwrap_or_else(|_| dest.to_path_buf());
    let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    dest.starts_with(dir)
}

/// Copies or moves one item into `dest_base`. Never overwrites: a name clash gets a unique name.
pub(crate) fn paste_one(src: &Path, dest_base: &Path, is_cut: bool) -> BatchItemResult {
    if let Err(e) = reject_critical_path(src) {
        return BatchItemResult { name: src.to_string_lossy().to_string(), success: false, message: e };
    }

    let filename = src.file_name().unwrap_or_default();
    let name = filename.to_string_lossy().to_string();

    // Without this, copy_dir_recursive keeps finding the folder it just created inside the source.
    if src.is_dir() && is_inside_dir(dest_base, src) {
        return BatchItemResult { name, success: false, message: "Cannot paste a folder into itself.".into() };
    }

    let dest = utils::get_unique_path(&dest_base.join(filename));

    if is_cut && fs::rename(src, &dest).is_ok() {
        return BatchItemResult { name, success: true, message: "Moved".into() };
    }

    let res = if src.is_dir() {
        copy_dir_recursive(src, &dest)
    } else {
        fs::copy(src, &dest).map(|_| ())
    };

    match res {
        Ok(_) => {
            if is_cut {
                let _ = if src.is_dir() { fs::remove_dir_all(src) } else { fs::remove_file(src) };
            }
            BatchItemResult { name, success: true, message: "Copied".into() }
        }
        Err(e) => BatchItemResult { name, success: false, message: e.to_string() },
    }
}

// --- FILES ON THE SYSTEM CLIPBOARD ---

/// The window that owns the system clipboard while it holds files. Windows needs one; the other
/// systems do not, and give 0.
fn clipboard_owner(app: &AppHandle) -> isize {
    #[cfg(windows)]
    {
        use tauri::Manager;
        app.webview_windows()
            .values()
            .next()
            .and_then(|window| window.hwnd().ok())
            .map(|hwnd| hwnd.0 as isize)
            .unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        0
    }
}

/// Checks the paths that are about to be put on the clipboard: there must be some, each must be a
/// full path without "..", and each must exist. Putting a path on the clipboard only lets another
/// program ask to read it, but a list of names that do not exist would make the paste fail later,
/// away from the cause.
pub(crate) fn check_clipboard_paths(paths: &[String]) -> CommandResult<()> {
    if paths.is_empty() {
        return Err("Nothing is selected to copy.".to_string());
    }
    for raw in paths {
        let path = Path::new(raw);
        if path.components().any(|c| c == Component::ParentDir) {
            return Err("Path traversal not allowed.".to_string());
        }
        if !path.is_absolute() {
            return Err(format!("\"{}\" is not a full path.", raw));
        }
        if fs::symlink_metadata(path).is_err() {
            return Err(format!("\"{}\" no longer exists.", raw));
        }
    }
    Ok(())
}

/// What another program put on the clipboard may name things that are gone by now, or paths with
/// "..". Only existing items with plain paths are offered for pasting.
pub(crate) fn usable_clipboard_paths(found: &mut ClipboardFiles) {
    found.paths.retain(|raw| {
        let path = Path::new(raw);
        path.is_absolute()
            && !path.components().any(|c| c == Component::ParentDir)
            && fs::symlink_metadata(path).is_ok()
    });
}

/// Puts the selected files on the system clipboard, as a copy or a cut, so they can be pasted in
/// Explorer or another program. Where the system does not support it, this fails and the Files
/// screen keeps using its own list.
#[tauri::command]
pub fn set_clipboard_files(app: AppHandle, paths: Vec<String>, cut: bool) -> CommandResult<()> {
    check_clipboard_paths(&paths)?;
    os_clipboard::set_files(&paths, cut, clipboard_owner(&app)).map_err(|e| e.to_string())
}

/// The files another program (or QRE) put on the system clipboard, if any, and whether they were cut.
#[tauri::command]
pub fn get_clipboard_files(app: AppHandle) -> CommandResult<ClipboardFiles> {
    let mut found = os_clipboard::get_files(clipboard_owner(&app)).map_err(|e| e.to_string())?;
    usable_clipboard_paths(&mut found);
    Ok(found)
}

/// Takes a file list off the system clipboard after the files were moved by a cut and paste, so
/// that no program is left holding a list of names that are gone. Text and pictures are left alone.
#[tauri::command]
pub fn clear_clipboard_files(app: AppHandle) -> CommandResult<()> {
    os_clipboard::clear_files(clipboard_owner(&app)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn paste_items(
    app: AppHandle,
    sources: Vec<String>,
    dest_dir: String,
    is_cut: bool,
) -> CommandResult<Vec<BatchItemResult>> {
    
    // FIX: Clone dest_dir into a PathBuf so it can be moved into the thread
    let dest_base = PathBuf::from(dest_dir);

    // Initial sanity check before thread
    reject_critical_path(&dest_base)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        
        for src_str in sources {
            let src = Path::new(&src_str);
            let filename = src.file_name().unwrap_or_default();
            utils::emit_progress(&app, &format!("Pasting: {}", filename.to_string_lossy()), 50);
            results.push(paste_one(src, &dest_base, is_cut));
        }
        Ok(results)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn create_dir(path: String) -> CommandResult<()> {
    // fs::create_dir_all is a silent no-op if `path` already exists (it only errors on a
    // real I/O failure), so without this check a user who typed the name of an existing
    // file or folder would see "success" and believe they created a fresh empty folder,
    // when nothing happened at all - not data loss like the rename bug, but the same
    // family of "silently not what the user asked for."
    if Path::new(&path).exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_item(path: String, new_name: String) -> CommandResult<()> {
    if new_name.is_empty() || new_name == "." || new_name == ".." || new_name.contains('/') || new_name.contains('\\') {
        return Err("Invalid name".to_string());
    }

    let old_path = Path::new(&path);
    let parent = old_path.parent().ok_or("Invalid path")?;
    let new_path = parent.join(&new_name);

    // SECURITY/DATA-SAFETY FIX: std::fs::rename silently overwrites an existing destination
    // on every OS (this is documented std behavior, not a bug in std) - so renaming
    // "report.txt" onto an already-existing "notes.txt" would previously destroy notes.txt
    // with zero warning. Refuse instead of clobbering; the user can delete the existing item
    // themselves first if that's genuinely what they want.
    if new_path.exists() {
        return Err(format!("\"{}\" already exists.", new_name));
    }

    fs::rename(old_path, new_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn show_in_folder(path: String) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        let _ = path;
        Err("Reveal in Explorer is not supported on Android".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        #[cfg(target_os = "windows")]
        Command::new("explorer").args(["/select,", &path]).spawn().map_err(|e| e.to_string())?;

        #[cfg(target_os = "linux")]
        {
            let p = Path::new(&path);
            let parent = p.parent().unwrap_or(p);
            Command::new("xdg-open").arg(parent).spawn().map_err(|e| e.to_string())?;
        }

        #[cfg(target_os = "macos")]
        Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;

        Ok(())
    }
}

// Android's equivalent of "Reveal in Explorer" (see show_in_folder above, which is
// unsupported there). This deliberately does NOT go through tauri-plugin-opener's own
// open_path command: as of tauri-plugin-opener 2.5.4, its Android implementation
// (`Opener::open_path` in the plugin's lib.rs) sends the path as a bare JSON string to the
// Kotlin side, but the Kotlin "open" command can only deserialize an object with a `url`
// field - it's the same command open_url uses, with no path-specific handling at all. Every
// call fails before any file-opening logic runs, with a Jackson deserialization error like
// "Cannot construct instance of 'app.tauri.opener.OpenArgs' ... no string-argument
// constructor ... to deserialize from String value". This command routes through our own
// minimal Android plugin instead (gen/android/app/src/main/java/com/qre/locker/
// OpenFilePlugin.kt), which builds a proper content:// URI via FileProvider and launches a
// correctly MIME-typed ACTION_VIEW intent.
#[tauri::command]
pub fn open_file_android(app: AppHandle, path: String) -> CommandResult<()> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path);
        Err("open_file_android is only supported on Android".to_string())
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        reject_critical_path(Path::new(&path))?;
        let handle = app.state::<crate::AndroidOpenerHandle>();
        handle
            .0
            .run_mobile_plugin::<()>("openFile", serde_json::json!({ "path": path }))
            .map_err(|e| e.to_string())
    }
}

// Sets the colour of the Android status bar and navigation bar icons to suit the app's own
// theme (see OpenFilePlugin.kt, setSystemBars, for why the phone's setting is not enough).
// `light_background` is true when the app is showing its light theme, which needs dark icons.
// Everywhere else the bars belong to the operating system and nothing needs doing, so this is
// a no-op that succeeds, and the web side can call it without checking the platform first.
#[tauri::command]
pub fn set_android_system_bars(app: AppHandle, light_background: bool) -> CommandResult<()> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, light_background);
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let handle = app.state::<crate::AndroidOpenerHandle>();
        handle
            .0
            .run_mobile_plugin::<()>(
                "setSystemBars",
                serde_json::json!({ "lightBackground": light_background }),
            )
            .map_err(|e| e.to_string())
    }
}

// --- HELPER COMMANDS FOR IMPORT/EXPORT ---

#[tauri::command]
pub fn read_text_file_content(path: String) -> CommandResult<String> {
    reject_path_traversal(Path::new(&path))?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file_content(path: String, content: String) -> CommandResult<()> {
    reject_path_traversal(Path::new(&path))?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// --- SHREDDER COMMANDS ---

#[tauri::command]
pub async fn dry_run_shred(paths: Vec<String>) -> CommandResult<shredder::DryRunResult> {
    shredder::dry_run(paths).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn batch_shred_files(
    paths: Vec<String>,
    method: shredder::ShredMethod,
    app_handle: tauri::AppHandle,
) -> CommandResult<shredder::ShredResult> {
    for path in &paths {
        reject_critical_path(Path::new(path))?;
    }
    shredder::batch_shred(paths, method, &app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_shred() -> CommandResult<()> {
    shredder::cancel_shred();
    Ok(())
}

#[tauri::command]
pub async fn wipe_free_space(
    drive_path: String,
    app_handle: tauri::AppHandle,
) -> CommandResult<shredder::WipeFreeSpaceResult> {
    #[cfg(target_os = "android")]
    {
        let _ = drive_path;
        let _ = app_handle;
        Err("Free space wiping is not supported on Android.".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        reject_critical_path(Path::new(&drive_path))?;
        shredder::wipe_free_space(drive_path, &app_handle).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn trim_drive(drive_path: String) -> CommandResult<shredder::TrimResult> {
    #[cfg(target_os = "android")]
    {
        let _ = drive_path;
        Err("TRIM is managed automatically by the Android OS.".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        reject_critical_path(Path::new(&drive_path))?;
        shredder::trim_drive(drive_path).map_err(|e| e.to_string())
    }
}

// --- SYSTEM UTILS ---

#[derive(serde::Serialize)]
pub struct DirListEntry {
    pub name: String,
    pub is_directory: bool,
    pub path: String,
    pub size: Option<u64>,
    /// Milliseconds since the Unix epoch, or `None` if the OS couldn't report a
    /// modification time for this entry.
    pub modified: Option<u64>,
}

/// Lists a directory's contents directly via `std::fs`, deliberately bypassing the
/// `@tauri-apps/plugin-fs` `readDir`/`stat` JS commands entirely.
///
/// That plugin enforces its access scope with glob patterns, and has a confirmed upstream
/// bug (tauri-apps/tauri#11705, #11708): a path containing an unmatched bracket can poison
/// its scope state so every subsequent listing fails, regardless of what's being browsed.
/// On Android this was observed to survive even a full app restart — which rules out
/// in-process state as the sole cause, since restarting gives every in-memory Rust
/// structure (including this plugin's own scope cache) a completely fresh start. The most
/// likely explanation is that it's interacting with Android's own OS-level Storage Access
/// Framework "persistable URI permission" grants, which are recorded outside our process
/// and handed back to the app automatically on every launch — something no in-app restart
/// can clear.
///
/// Since the exact mechanism lives inside Tauri/Android internals we don't control, the
/// robust fix is to not depend on that code path at all for this core feature: this command
/// never compiles a glob pattern from anything, so it can't be affected by that bug no
/// matter where the poisoned state actually lives. A single unreadable entry is skipped
/// rather than aborting the whole listing, so one oddly-named or inaccessible file can't
/// take down the rest of the folder either.
#[tauri::command]
pub fn list_directory(path: String) -> CommandResult<Vec<DirListEntry>> {
    let dir_path = Path::new(&path);
    reject_critical_path(dir_path)?;

    let read_dir = fs::read_dir(dir_path).map_err(|e| format!("Cannot read directory: {e}"))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let Ok(entry) = entry else {
            continue; // unreadable entry (permissions, race with deletion, ...) - skip it
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry.file_type().ok();
        let is_symlink = file_type.map(|t| t.is_symlink()).unwrap_or(false);

        // DirEntry::metadata describes a symlink itself (its size is the length of the
        // path it points to, and it is never a folder). Follow the link instead, so a
        // linked folder can be opened and a linked file shows its real size.
        let meta = if is_symlink {
            fs::metadata(entry.path())
        } else {
            entry.metadata()
        };

        let is_directory = match &meta {
            Ok(m) => m.is_dir(),
            Err(_) => file_type.map(|t| t.is_dir()).unwrap_or(false),
        };

        let (size, modified) = match meta {
            Ok(meta) => {
                let size = if meta.is_dir() { None } else { Some(meta.len()) };
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64);
                (size, modified)
            }
            // metadata() failing for one entry (e.g. a broken symlink) shouldn't take the
            // whole listing down - just report it without size/date.
            Err(_) => (None, None),
        };

        entries.push(DirListEntry {
            name,
            is_directory,
            path: entry.path().to_string_lossy().to_string(),
            size,
            modified,
        });
    }

    Ok(entries)
}

#[tauri::command]
pub fn get_drives(_app: AppHandle) -> Vec<String> {
    let mut drives = Vec::new();
    
    #[cfg(not(target_os = "android"))]
    {
        let disks = Disks::new_with_refreshed_list();
        for disk in disks.list() {
            // SECURITY: Do NOT call app.fs_scope().allow_directory() here.
            // We only return the strings for the UI. The user cannot browse
            // C:\ or D:\ unless those paths are specifically allowed in default.json.
            // Only USB drives unlocked via portable.rs will inject into fs:scope.
            drives.push(disk.mount_point().to_string_lossy().to_string());
        }
    }
    
    #[cfg(target_os = "android")]
    {
        drives.push("/storage/emulated/0".to_string());
    }
    
    drives
}

#[tauri::command]
pub fn get_startup_file() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        let path = args[1].clone();
        if !path.starts_with("--") {
            return Some(path);
        }
    }
    None
}
#[cfg(test)]
mod tests;
