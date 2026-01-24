// This attribute prevents a blank Command Prompt window from appearing
// alongside the application window on Windows builds.
// It is only active in "Release" mode (not Debug mode), so you can still see logs while developing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The main function delegates execution to the `qre_core` library.
    //
    // By keeping the logic in `lib.rs` (qre_core), we allow Tauri to bind
    // the application differently depending on the platform:
    // - On Desktop: This `main` function runs the app.
    // - On Android: The OS calls the library entry point directly via JNI, bypassing this function.
    qre_core::run();
}