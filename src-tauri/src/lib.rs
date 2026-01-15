mod commands;
mod crypto;
mod entropy;
mod keychain;
mod secure_rng;
mod state;
mod tests;
mod utils;

use state::SessionState;
use std::sync::{Arc, Mutex};

// Gated Import: Only import shortcut types on Desktop
// These do not exist on Android, so we must hide them.
#[cfg(not(mobile))]
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FIX: Allow unused mut for Android build (since we don't add the shortcut plugin there)
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .manage(SessionState {
            master_key: Arc::new(Mutex::new(None)),
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    // GATED PLUGIN: Panic Button (Desktop Only)
    // Android does not allow global key interception in the background.
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
            // GATED SETUP: Register Shortcut (Desktop Only)
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
            // File Ops
            commands::delete_items,
            commands::trash_items,
            commands::create_dir,
            commands::rename_item,
            commands::show_in_folder,
            commands::get_keychain_data,
            // Crypto
            commands::lock_file,
            commands::unlock_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}