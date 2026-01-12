mod crypto;
mod entropy;
mod secure_rng;
mod keychain;
mod state;
mod utils;
mod commands;
mod tests;

use std::sync::{Arc, Mutex};
use state::SessionState;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionState { 
            master_key: Arc::new(Mutex::new(None)) 
        })
        .plugin(tauri_plugin_clipboard_manager::init()) 
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        // FIX: Register Panic Button directly in Rust
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |_app, shortcut, event| {
                    // Check for Ctrl + Shift + Q
                    if event.state == ShortcutState::Pressed 
                       && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyQ) 
                    {
                        println!("🔥 PANIC BUTTON TRIGGERED (RUST) - KILLING PROCESS 🔥");
                        // Wipes memory by virtue of the OS reclaiming the process memory immediately
                        std::process::exit(0); 
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Register the specific shortcut on startup
            let ctrl_shift_q = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyQ);
            
            // Register it using the plugin extension
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            app.global_shortcut().register(ctrl_shift_q)?;
            
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
            // Crypto
            commands::lock_file, 
            commands::unlock_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}