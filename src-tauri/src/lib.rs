mod analyzer;
mod bookmarks;
mod breach;
mod cleaner;
mod clipboard_store;
mod commands;
mod crypto;
mod crypto_stream;
mod entropy;
mod hasher;
mod keychain;
mod notes;
mod qr;
mod secure_rng;
mod state;
mod system_cleaner;
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
        .manage(SessionState {
            master_key: Arc::new(Mutex::new(None)),
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // --- ADDED UPDATER PLUGIN HERE ---
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
            // Auth
            commands::check_auth_status,
            commands::init_vault,
            commands::login,
            commands::logout,
            commands::recover_vault,
            commands::regenerate_recovery_code,
            commands::change_user_password,
            // System
            commands::get_drives,
            commands::get_startup_file,
            commands::export_keychain,
            commands::get_keychain_data,
            // File Ops
            commands::delete_items,
            commands::trash_items,
            commands::create_dir,
            commands::rename_item,
            commands::show_in_folder,
            commands::scan_system_junk,
            commands::clean_system_junk,
            commands::read_text_file_content,
            commands::write_text_file_content,
            // Crypto
            commands::lock_file,
            commands::unlock_file,
            // Vaults
            commands::load_password_vault,
            commands::save_password_vault,
            commands::load_notes_vault,
            commands::save_notes_vault,
            // Utilities
            commands::generate_passphrase,
            commands::analyze_file_metadata,
            commands::clean_file_metadata,
            commands::check_password_breach,
            commands::check_email_breach,
            commands::get_public_ip_address,
            commands::generate_qr_code,
            commands::load_bookmarks_vault,
            commands::save_bookmarks_vault,
            commands::import_browser_bookmarks,
            commands::calculate_file_hashes,
            commands::scan_directory_targets,
            // Clipboard
            commands::add_clipboard_entry,
            commands::load_clipboard_vault,
            commands::save_clipboard_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
