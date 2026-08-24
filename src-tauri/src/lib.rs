// --- START OF FILE lib.rs ---

// ==========================================
// --- MODULE DECLARATIONS ---
// ==========================================
// In Rust, explicitly declaring `mod` tells the compiler to look for these files
// (e.g., `analyzer.rs`, `bookmarks.rs`) and compile them into the binary tree.
mod analyzer;
mod bookmarks;
mod breach;
// `cleaner`, `crypto`, and `keychain` are private in normal builds — the fuzz
// targets need direct access to `analyze_zip_reader`, `decrypt_file_with_master_key`,
// and `MasterKey`, so they're exposed only when the `fuzzing` feature is enabled
// (see src-tauri/fuzz/Cargo.toml).
#[cfg(not(feature = "fuzzing"))]
mod cleaner;
#[cfg(feature = "fuzzing")]
pub mod cleaner;
mod clipboard_store;
mod commands; // Refers to src/commands/mod.rs (which encapsulates files.rs, tools.rs, vault.rs)
#[cfg(not(feature = "fuzzing"))]
mod crypto;
#[cfg(feature = "fuzzing")]
pub mod crypto;
mod crypto_stream;
mod hasher;
#[cfg(not(feature = "fuzzing"))]
mod keychain;
#[cfg(feature = "fuzzing")]
pub mod keychain;
mod notes;
mod passwords;
mod qr;
mod registry_cleaner;
mod shredder;
mod state;
mod system_cleaner;
#[cfg(test)]
mod tests; // Only compiled when running `cargo test`
mod timelock;
mod timelock_clock;
mod utils;
mod wordlist;

// Conditional compilation: Global OS-level keyboard shortcuts are not supported on iOS/Android.
#[cfg(not(mobile))]
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

// `Manager` provides `.manage()`, used below to store the Android opener plugin's handle.
#[cfg(target_os = "android")]
use tauri::Manager;

// Handle to our own minimal Android plugin (gen/android/app/src/main/java/com/qre/locker/
// OpenFilePlugin.kt), registered below. It exists because tauri-plugin-opener's own
// open_path is broken on Android (see commands::files::open_file_android for the full
// explanation) - this is the workaround, not a general-purpose plugin bridge.
#[cfg(target_os = "android")]
pub(crate) struct AndroidOpenerHandle(pub tauri::plugin::PluginHandle<tauri::Wry>);

// ==========================================
// --- MAIN TAURI ENTRY POINT ---
// ==========================================
// `tauri::mobile_entry_point` generates the necessary boilerplate to run this Rust library
// as a native mobile app library on Android (JNI) and iOS (C ABI). On desktop, it's just a normal func.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // --- PLUGIN INITIALIZATION ---
        // Tauri plugins provide safe, sandboxed APIs to native OS features so the frontend
        // doesn't have to use raw Node.js/OS calls (which is a major security risk in Electron).
        .plugin(tauri_plugin_os::init())
        // --- GLOBAL STATE MANAGEMENT ---
        // `.manage()` injects our `SessionState` struct into the Tauri application context.
        // Any command can request `state: tauri::State<SessionState>` to access it.
        // ARCHITECTURE: `Arc` (Atomic Reference Counting) allows multiple threads to share ownership.
        // `Mutex` (Mutual Exclusion) ensures only one thread can read/write the MasterKey at a time.
        .manage(state::SessionState::new())
        // More plugins for standard OS interactions
        .plugin(tauri_plugin_http::init()) // <--- Allows Rust to handle secure HTTP requests bypassing CORS
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init()) // Native OS file pickers
        .plugin(tauri_plugin_fs::init()) // Sandboxed file system access
        .plugin(tauri_plugin_opener::init()) // Opens URLs/files in the user's default external apps
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build()); // Secure OTA auto-updates

    // ==========================================
    // --- ANDROID FILE OPENER (see commands::files::open_file_android) ---
    // ==========================================
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(
            // Generic params pinned explicitly (R = Wry, C = ()) - without this, rustc can't
            // infer the config type C from the .setup() closure's parameter alone (it needs C
            // resolved before it can even infer the closure's own PluginApi<R, C> parameter
            // type), and C's `= ()` default only applies to unspecified positions, not to
            // inference through a closure signature. tauri-plugin-opener's own Builder::build()
            // hits the identical situation and pins both generics the same way.
            tauri::plugin::Builder::<tauri::Wry, ()>::new("qre-open")
                .setup(|app, api| {
                    let handle = api.register_android_plugin("com.qre.locker", "OpenFilePlugin")?;
                    app.manage(AndroidOpenerHandle(handle));
                    Ok(())
                })
                .build(),
        );
    }

    // ==========================================
    // --- PANIC BUTTON (DESKTOP ONLY) ---
    // ==========================================
    // SECURITY FEATURE: Registers a global, system-wide shortcut (Ctrl+Shift+Q).
    // If the user feels threatened or someone walks in, they hit this shortcut.
    // `std::process::exit(0)` instantly kills the app. Since our keys are stored in RAM,
    // killing the process is the fastest and most absolute way to wipe the master key
    // and lock the vault instantly.
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
            // Register the panic button shortcut during app initialization
            #[cfg(not(mobile))]
            {
                let ctrl_shift_q =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyQ);
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                _app.global_shortcut().register(ctrl_shift_q)?;
            }
            Ok(())
        })
        // ==========================================
        // --- IPC COMMAND ROUTER ---
        // ==========================================
        // This macro takes all our Rust functions marked with `#[tauri::command]`
        // and exposes them to the frontend Javascript/Typescript via the `invoke()` API.
        .invoke_handler(tauri::generate_handler![
            // --- FILE COMMANDS (commands/files.rs) ---
            commands::files::lock_file,
            commands::files::unlock_file,
            commands::files::delete_items,
            commands::files::trash_items,
            commands::files::paste_items,
            commands::files::create_dir,
            commands::files::rename_item,
            commands::files::show_in_folder,
            commands::files::read_text_file_content,
            commands::files::write_text_file_content,
            commands::files::dry_run_shred,
            commands::files::batch_shred_files,
            commands::files::cancel_shred,
            commands::files::wipe_free_space,
            commands::files::trim_drive,
            commands::files::get_drives,
            commands::files::get_startup_file,
            commands::files::list_directory,
            commands::files::open_file_android,
            commands::portable::enumerate_removable_drives,
            commands::portable::init_portable_vault,
            commands::portable::unlock_portable_vault,
            commands::portable::lock_portable_vault,
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
            commands::vault::restore_keychain,
            commands::vault::get_backup_done,
            commands::vault::set_backup_done,
            // Password Vault
            commands::vault::load_password_vault,
            commands::vault::save_password_vault,
            commands::vault::generate_totp_code,
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
            // Registry Cleaner
            commands::tools::scan_registry,
            commands::tools::backup_registry,
            commands::tools::clean_registry,
            commands::tools::relaunch_as_admin,
            // File Analyzer
            commands::tools::scan_directory_targets,
            // Metadata Cleaner
            commands::tools::analyze_file_metadata,
            commands::tools::clean_file_metadata,
            commands::tools::batch_clean_metadata,
            commands::tools::cancel_metadata_clean,
            commands::tools::compare_metadata_files,
            commands::tools::detect_steganography,
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
            commands::tools::scan_local_secrets,
            commands::tools::cancel_secret_scan,
            // Generator
            commands::tools::generate_passphrase,
            // Timelock
            commands::timelock::lock_file_with_timelock,
            commands::timelock::get_file_timelock_status,
        ])
        // Boot the Tauri application loop. This will block the main thread and keep the app alive
        // until all windows are closed or `std::process::exit()` is called.
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// --- END OF FILE lib.rs ---
