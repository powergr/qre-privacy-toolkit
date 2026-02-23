// Declare all modules
mod analyzer;
mod bookmarks;
mod breach;
mod cleaner;
mod clipboard_store;
mod commands; // Refers to src/commands/mod.rs
mod crypto;
mod crypto_stream;
mod entropy;
mod hasher;
mod keychain;
mod notes;
mod qr;
mod secure_rng;
mod shredder;
mod state;
mod system_cleaner;
#[cfg(test)]
mod tests;
mod utils;
mod vault;
mod wordlist;

use state::SessionState;
use std::sync::{Arc, Mutex};

#[cfg(not(mobile))]
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        // FIX: Wrapped Mutex in Arc::new() to match SessionState struct definition
        .manage(SessionState {
            master_key: Arc::new(Mutex::new(None)),
        })
        .plugin(tauri_plugin_http::init()) // <--- ADDED HTTP PLUGIN HERE
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(not(mobile))]
    {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |_app, shortcut, event| {
                    if event.state == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyQ)
                    {
                        println!("🔥 PANIC BUTTON TRIGGERED (RUST) - KILLING PROCESS 🔥");
                        std::process::exit(0);
                    }
                })
                .build(),
        );
    }

    builder
        .setup(|_app| {
            #[cfg(not(mobile))]
            {
                let ctrl_shift_q =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyQ);
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                _app.global_shortcut().register(ctrl_shift_q)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // --- FILE COMMANDS (commands/files.rs) ---
            commands::files::lock_file,
            commands::files::unlock_file,
            commands::files::delete_items,
            commands::files::trash_items,
            commands::files::create_dir,
            commands::files::rename_item,
            commands::files::show_in_folder,
            commands::files::read_text_file_content,
            commands::files::write_text_file_content,
            commands::files::dry_run_shred,
            commands::files::batch_shred_files,
            commands::files::cancel_shred,
            commands::files::get_drives,
            commands::files::get_startup_file,
            // --- VAULT COMMANDS (commands/vault.rs) ---
            // Auth & System
            commands::vault::check_auth_status,
            commands::vault::init_vault,
            commands::vault::login,
            commands::vault::logout,
            commands::vault::change_user_password,
            commands::vault::recover_vault,
            commands::vault::regenerate_recovery_code,
            commands::vault::get_keychain_data,
            commands::vault::export_keychain,
            // Password Vault
            commands::vault::load_password_vault,
            commands::vault::save_password_vault,
            // Notes Vault
            commands::vault::load_notes_vault,
            commands::vault::save_notes_vault,
            // Bookmarks Vault
            commands::vault::load_bookmarks_vault,
            commands::vault::save_bookmarks_vault,
            commands::vault::import_browser_bookmarks,
            // Clipboard Vault
            commands::vault::load_clipboard_vault,
            commands::vault::save_clipboard_vault,
            commands::vault::add_clipboard_entry,
            // --- TOOLS COMMANDS (commands/tools.rs) ---
            // System Cleaner
            commands::tools::scan_system_junk,
            commands::tools::clean_system_junk,
            commands::tools::dry_run_clean,
            commands::tools::cancel_system_clean,
            // File Analyzer
            commands::tools::scan_directory_targets,
            // Metadata Cleaner
            commands::tools::analyze_file_metadata,
            commands::tools::clean_file_metadata,
            commands::tools::batch_clean_metadata,
            commands::tools::cancel_metadata_clean,
            commands::tools::compare_metadata_files,
            // Hasher
            commands::tools::calculate_file_hashes,
            commands::tools::get_file_metadata,
            commands::tools::cancel_hashing,
            commands::tools::save_text_to_file,
            commands::tools::calculate_text_hashes,
            // QR Generator
            commands::tools::generate_qr,
            commands::tools::generate_wifi_qr,
            commands::tools::validate_qr_input,
            // Privacy Check
            commands::tools::check_password_breach,
            commands::tools::get_public_ip_address,
            // Generator
            commands::tools::generate_passphrase,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
