// --- START OF FILE src-tauri/src/commands/timelock.rs ---
//
// Tauri command surface for time-lock encryption.
//
// With the V6 embedded design:
//   - lock_file_with_timelock  → calls encrypt_file_stream with timelock_until
//   - get_file_timelock_status → reads the plaintext header, no master key needed
//   - unlock_file_with_timelock is REMOVED — the regular unlock command in
//     files.rs now handles time-locked files natively, since decrypt_file_stream
//     checks the timestamp and returns a TIME_LOCKED: error when appropriate.

use super::files::{is_already_compressed, reject_critical_path, BatchItemResult, CommandResult};
use crate::crypto_stream;
use crate::keychain::MasterKey;
use crate::state::SessionState;
use crate::timelock::{self, TimeLockStatus};
use crate::utils;
use std::path::{Component, Path};
use tauri::AppHandle;

// ==========================================
// --- LOCK COMMAND ---
// ==========================================

/// Encrypts a file with an embedded time-lock.
///
/// The timestamp validation (`unlock_at`) happens here in Rust.
/// The frontend check in TimeLockModal.tsx is UX-only and not trusted.
///
/// Passes `timelock_until: Some(unlock_at)` and `keyfile_bytes: None`
/// to `encrypt_file_stream`, which generates the binding key internally
/// and embeds the time-lock metadata in the V6 StreamHeader.
#[tauri::command]
pub async fn lock_file_with_timelock(
    app: AppHandle,
    state: tauri::State<'_, SessionState>,
    file_path: String,
    unlock_at: u64,
    compression_mode: Option<String>,
) -> CommandResult<BatchItemResult> {
    // ── PATH VALIDATION ───────────────────────────────────────────────────────
    let path = Path::new(&file_path);

    if path.components().any(|c| c == Component::ParentDir) {
        return Err("Path traversal not allowed.".to_string());
    }
    reject_critical_path(path)?;

    if !path.is_absolute() {
        return Err("File path must be absolute.".to_string());
    }
    if file_path.ends_with(".qre") {
        return Err("Cannot time-lock an already-encrypted .qre file.".to_string());
    }

    // ── TIMESTAMP VALIDATION (authoritative — Rust side) ─────────────────────
    timelock::validate_unlock_at(unlock_at).map_err(|e| e)?;

    let vaults_arc = state.vaults.clone();
    let portable_mounts_arc = state.portable_mounts.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&file_path);
        let filename = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Ghost-file protection — refuse to encrypt directly on a USB drive
        {
            let mounts = portable_mounts_arc
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let path_low = file_path.to_lowercase();
            if mounts
                .keys()
                .any(|m| path_low.starts_with(&m.to_lowercase()))
            {
                return Ok(BatchItemResult {
                    name: filename,
                    success: false,
                    message: "Ghost-file protection: encrypt on your PC first, then move \
                              the .qre file to the USB drive."
                        .to_string(),
                });
            }
        }

        // Retrieve master key
        let master_key: MasterKey = {
            let guard = match vaults_arc.lock() {
                Ok(g) => g,
                Err(poisoned) => {
                    let mut p = poisoned.into_inner();
                    p.clear();
                    return Err("Session state corrupted. Please re-authenticate.".to_string());
                }
            };
            match guard.get("local") {
                Some(mk) => mk.clone(),
                None => {
                    return Ok(BatchItemResult {
                        name: filename,
                        success: false,
                        message: "Vault is locked. Unlock it first.".to_string(),
                    })
                }
            }
        };

        // Resolve output path (deduplicate if a collision exists)
        let raw_output = format!("{}.qre", file_path);
        let final_qre = utils::get_unique_path(Path::new(&raw_output));
        let final_qre_str = final_qre.to_string_lossy().to_string();

        // Compression level
        let mode_str = compression_mode.unwrap_or_else(|| "auto".to_string());
        let level = match mode_str.as_str() {
            "store" => 0,
            "extreme" => 19,
            _ => {
                if is_already_compressed(&filename) {
                    1
                } else {
                    3
                }
            }
        };

        utils::emit_progress(&app, &format!("Time-locking: {}", filename), 10);

        let app_handle = app.clone();
        let fname_clone = filename.clone();
        let progress_cb = move |processed: u64, total: u64| {
            if total > 0 {
                let pct = ((processed as f64 / total as f64 * 100.0) as u8).min(95);
                utils::emit_progress(&app_handle, &format!("Encrypting: {}", fname_clone), pct);
            }
        };

        // Encrypt with embedded time-lock (no external keyfile, no sidecar)
        match crypto_stream::encrypt_file_stream(
            &file_path,
            &final_qre_str,
            &master_key,
            "local",
            None,            // keyfile_bytes: None (binding key is generated internally)
            Some(unlock_at), // timelock_until: embedded in V6 StreamHeader
            None,            // entropy_seed
            level,
            progress_cb,
        ) {
            Ok(()) => {
                utils::emit_progress(&app, &format!("Locked: {}", filename), 100);
                Ok(BatchItemResult {
                    name: filename,
                    success: true,
                    message: format!(
                        "Time-locked for {}",
                        timelock::format_duration(unlock_at.saturating_sub(timelock::now_secs()))
                    ),
                })
            }
            Err(e) => {
                // Clean up any partial output on failure
                let _ = std::fs::remove_file(&final_qre);
                Ok(BatchItemResult {
                    name: filename,
                    success: false,
                    message: format!("Encryption failed: {}", e),
                })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ==========================================
// --- STATUS COMMAND ---
// ==========================================

/// Returns the time-lock status of a .qre file by reading its plaintext header.
///
/// Does NOT require the master key — `locked_until` is stored unencrypted
/// in the V6 StreamHeader so the UI can show a countdown without unlocking
/// the vault. Returns `is_locked: false` for V5 files, non-.qre files,
/// and any file that fails to parse.
#[tauri::command]
pub fn get_file_timelock_status(qre_path: String) -> CommandResult<TimeLockStatus> {
    // Basic path safety
    let path = Path::new(&qre_path);
    if path.components().any(|c| c == Component::ParentDir) {
        return Err("Path traversal not allowed.".to_string());
    }

    match crypto_stream::read_timelock_header(&qre_path) {
        Ok(Some(meta)) => {
            let now = timelock::now_secs();
            let is_locked = now < meta.locked_until;
            let remaining = if is_locked {
                timelock::format_duration(meta.locked_until.saturating_sub(now))
            } else {
                String::new()
            };
            Ok(TimeLockStatus {
                is_locked,
                locked_until: meta.locked_until,
                remaining_display: remaining,
            })
        }
        // Not time-locked, V5 file, or unreadable — treat as unlocked
        Ok(None) | Err(_) => Ok(TimeLockStatus {
            is_locked: false,
            locked_until: 0,
            remaining_display: String::new(),
        }),
    }
}

// --- END OF FILE src-tauri/src/commands/timelock.rs ---
