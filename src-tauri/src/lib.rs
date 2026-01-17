// --- MODULE DECLARATIONS ---
// These modules organize the backend logic into distinct functional areas.
mod commands;       // Exports functions callable from the React frontend.
mod crypto;         // Legacy V4 Encryption Engine (Memory-based).
mod crypto_stream;  // Modern V5 Encryption Engine (Stream-based for large files).
mod entropy;        // Logic for collecting random data (Entropy) from user input.
mod keychain;       // Manages the secure storage of keys and passwords.
mod secure_rng;     // Wrappers for Cryptographically Secure Pseudo-Random Number Generators.
mod state;          // Holds global application state (like the decrypted Master Key) in RAM.
mod tests;          // Internal unit tests.
mod utils;          // General utility functions (File I/O helpers, Shredding logic).

use state::SessionState;
use std::sync::{Arc, Mutex};

// --- PLATFORM SPECIFIC IMPORTS ---
// The Global Shortcut plugin allows the application to listen for keystrokes
// even when the window is not in focus (used for the Panic Button).
//
// Android/iOS do not allow background key interception for security and lifecycle reasons,
// so this library is strictly excluded from mobile builds to prevent compilation errors.
#[cfg(not(mobile))]
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// The Main Entry Point for the Tauri Backend.
///
/// This function is called by `main.rs` (Desktop) or the Android/iOS Activity.
/// It configures the runtime environment, initializes all plugins, sets up global state,
/// and starts the main event loop.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 'unused_mut' suppression is required because 'builder' is mutated
    // only on Desktop (to add the shortcut plugin). On Mobile, it remains immutable.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // --- CORE PLUGIN REGISTRATION ---
        
        // OS: Provides information about the operating system (Platform detection).
        .plugin(tauri_plugin_os::init())
        
        // STATE MANAGEMENT:
        // Initializes the global session state. The Master Key is stored inside an
        // Arc<Mutex<...>> to allow safe concurrent access from multiple threads/commands.
        // Initially, the key is 'None' (Locked).
        .manage(SessionState {
            master_key: Arc::new(Mutex::new(None)),
        })
        
        // CLIPBOARD: Allows the app to securely copy/clear text (e.g., Recovery Codes).
        .plugin(tauri_plugin_clipboard_manager::init())
        
        // SHELL: Provides capabilities to execute system commands (restricted by capabilities config).
        .plugin(tauri_plugin_shell::init())
        
        // DIALOG: Opens native system file pickers (Open/Save dialogs).
        .plugin(tauri_plugin_dialog::init())
        
        // FS: Provides direct access to the filesystem for reading/writing encrypted files.
        .plugin(tauri_plugin_fs::init())
        
        // OPENER: The standard way in Tauri v2 to open external URLs (e.g., Help, Website)
        // in the user's default browser across Windows, Linux, macOS, and Android.
        .plugin(tauri_plugin_opener::init())
        
        // PROCESS: Allows the application to programmatically exit or restart.
        .plugin(tauri_plugin_process::init());

    // --- PANIC BUTTON (DESKTOP ONLY) ---
    // Registers a low-level global hook for "Ctrl + Shift + Q".
    // This acts as a "Dead Man's Switch". When triggered, it bypasses standard
    // cleanup routines and kills the process immediately to protect data.
    #[cfg(not(mobile))]
    {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |_app, shortcut, event| {
                    if event.state == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyQ)
                    {
                        println!("🔥 PANIC BUTTON TRIGGERED (RUST) - KILLING PROCESS 🔥");
                        std::process::exit(0); // Terminates the app instantly
                    }
                })
                .build(),
        );
    }

    builder
        .setup(|_app| {
            // --- LIFECYCLE SETUP ---
            // This block runs once when the application starts.
            
            // Registers the specific key combination for the Panic Button logic defined above.
            #[cfg(not(mobile))]
            {
                let ctrl_shift_q =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyQ);
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                _app.global_shortcut().register(ctrl_shift_q)?;
            }
            Ok(())
        })
        // --- COMMAND HANDLER REGISTRATION ---
        // Exposes specific Rust functions to the JavaScript frontend.
        // The frontend calls these via `invoke('command_name', { args })`.
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
            commands::get_keychain_data, // Helper for Android backups (writes via frontend)
            
            // File Operations
            commands::delete_items,
            commands::trash_items,
            commands::create_dir,
            commands::rename_item,
            commands::show_in_folder,
            
            // Cryptography Core
            commands::lock_file,
            commands::unlock_file
        ])
        // Starts the application loop. This blocks the main thread until the app exits.
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}