// --- MODULE DECLARATIONS ---
// These files contain the logic for specific features of the application.
mod commands;   // Frontend-callable functions
mod crypto;     // Encryption/Decryption engine (Kyber + AES)
mod entropy;    // Randomness generation
mod keychain;   // Password and Key management
mod secure_rng; // Secure Random Number Generator wrappers
mod state;      // Global application state (Memory-only)
mod tests;      // Unit tests
mod utils;      // Helper functions (File I/O, Progress tracking)

use state::SessionState;
use std::sync::{Arc, Mutex};

// --- DESKTOP SPECIFIC IMPORTS ---
// The Global Shortcut plugin allows detecting keyboard combinations even when the app
// is not in focus. This is not supported on Mobile/Android, so it is strictly gated.
#[cfg(not(mobile))]
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// The Main Entry Point for the Tauri Application.
/// This function configures the environment, loads plugins, and starts the event loop.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Note: `unused_mut` allows the builder to be mutable on Desktop (where we add shortcuts)
    // but remains valid on Mobile where that block is skipped.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // --- PLUGIN REGISTRATION ---
        
        // OS: Detects if running on Windows, Linux, macOS, or Android.
        .plugin(tauri_plugin_os::init())
        
        // State Management: Holds the Master Key in RAM. 
        // Wrapped in Mutex for thread safety across async commands.
        .manage(SessionState {
            master_key: Arc::new(Mutex::new(None)),
        })
        
        // Clipboard: Allows copying recovery codes/text.
        .plugin(tauri_plugin_clipboard_manager::init())
        
        // Shell: Used for opening files in the OS file explorer.
        .plugin(tauri_plugin_shell::init())
        
        // Dialog: Native file pickers (Open/Save).
        .plugin(tauri_plugin_dialog::init())
        
        // FS: Access to the filesystem (Read/Write files).
        .plugin(tauri_plugin_fs::init())
        
        // Opener: Handles opening external URLs (e.g., Help links) reliably across platforms.
        .plugin(tauri_plugin_opener::init())
        
        // Process: Allows the app to exit or restart programmatically.
        .plugin(tauri_plugin_process::init());

    // --- PANIC BUTTON (DESKTOP ONLY) ---
    // Registers a Global Shortcut (Ctrl + Shift + Q) that instantly kills the process.
    // This acts as a "Dead Man's Switch" or emergency exit to wipe memory.
    // On Android, the OS manages app lifecycle, so this is disabled.
    #[cfg(not(mobile))]
    {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |_app, shortcut, event| {
                    if event.state == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyQ)
                    {
                        println!("🔥 PANIC BUTTON TRIGGERED (RUST) - KILLING PROCESS 🔥");
                        std::process::exit(0); // Instant termination
                    }
                })
                .build(),
        );
    }

    builder
        .setup(|_app| {
            // --- SETUP HOOK ---
            // Registers the actual key combination for the Panic Button on startup.
            #[cfg(not(mobile))]
            {
                let ctrl_shift_q =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyQ);
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                _app.global_shortcut().register(ctrl_shift_q)?;
            }
            Ok(())
        })
        // --- COMMAND REGISTRATION ---
        // Exposes Rust functions to the Frontend (TypeScript/React).
        .invoke_handler(tauri::generate_handler![
            // Authentication & Vault Management
            commands::check_auth_status,
            commands::init_vault,
            commands::login,
            commands::logout,
            commands::recover_vault,
            commands::regenerate_recovery_code,
            commands::change_user_password,
            
            // System Utilities
            commands::get_drives,
            commands::get_startup_file,
            commands::export_keychain,
            
            // File Operations
            commands::delete_items,
            commands::trash_items,
            commands::create_dir,
            commands::rename_item,
            commands::show_in_folder,
            commands::get_keychain_data, // Helper for Android backups
            
            // Cryptography Core
            commands::lock_file,
            commands::unlock_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}