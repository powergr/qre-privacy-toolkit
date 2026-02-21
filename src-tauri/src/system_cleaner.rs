use anyhow::Result;
use directories::BaseDirs;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use walkdir::WalkDir;

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TOTAL_SIZE: u64 = 50 * 1024 * 1024 * 1024; // 50 GB max per operation
const MAX_DEPTH: usize = 10; // Max directory depth to traverse
const LARGE_OPERATION_THRESHOLD: u64 = 10 * 1024 * 1024 * 1024; // 10 GB warning

// Global cancellation flag
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

// ═══════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JunkItem {
    pub id: String,
    pub name: String,
    pub path: String, // Can be a file path OR a special command identifier (::CMD::)
    pub category: String, // "System", "Browser", "Developer", "Logs", "Network"
    pub size: u64,
    pub description: String,
    pub warning: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct CleanProgress {
    pub files_processed: u64,
    pub total_files: u64,
    pub bytes_freed: u64,
    pub current_file: String,
    pub percentage: u8,
}

#[derive(Serialize)]
pub struct CleanResult {
    pub bytes_freed: u64,
    pub files_deleted: u64,
    pub errors: Vec<String>,
}

#[derive(Serialize)]
pub struct DryRunResult {
    pub total_files: u64,
    pub total_size: u64,
    pub file_list: Vec<String>,
    pub warnings: Vec<String>,
}

// ═══════════════════════════════════════════════════════════════════════════
// PATH VALIDATION (CRITICAL SECURITY)
// ═══════════════════════════════════════════════════════════════════════════

/// Gets the list of whitelisted base directories that are safe to clean.
///
/// SECURITY: Only directories in this whitelist can be cleaned.
/// This prevents deletion of system files, user documents, etc.
fn get_whitelist() -> Vec<PathBuf> {
    let mut whitelist = Vec::new();

    if let Some(base_dirs) = BaseDirs::new() {
        // Temp directories
        #[cfg(target_os = "windows")]
        {
            if let Ok(temp) = std::env::var("TEMP") {
                if let Ok(canonical) = fs::canonicalize(&temp) {
                    whitelist.push(canonical);
                }
            }
            if let Ok(tmp) = std::env::var("TMP") {
                if let Ok(canonical) = fs::canonicalize(&tmp) {
                    whitelist.push(canonical);
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(canonical) = fs::canonicalize("/tmp") {
                whitelist.push(canonical);
            }
        }

        // Cache directories (safe to clean)
        if let Ok(canonical) = fs::canonicalize(base_dirs.cache_dir()) {
            whitelist.push(canonical);
        }

        #[cfg(target_os = "windows")]
        {
            // Windows local app data cache
            if let Ok(canonical) = fs::canonicalize(base_dirs.data_local_dir()) {
                whitelist.push(canonical);
            }
        }

        // Developer caches (already in home, but specific subdirs)
        let home = base_dirs.home_dir();
        let dev_caches = vec![".npm", ".cache", ".cargo/registry"];

        for cache_dir in dev_caches {
            let path = home.join(cache_dir);
            if path.exists() {
                if let Ok(canonical) = fs::canonicalize(&path) {
                    whitelist.push(canonical);
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            // Windows Recent folder
            let recent = base_dirs.data_dir().join("Microsoft/Windows/Recent");
            if recent.exists() {
                if let Ok(canonical) = fs::canonicalize(&recent) {
                    whitelist.push(canonical);
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            // macOS specific cache locations
            let logs = home.join("Library/Logs");
            if logs.exists() {
                if let Ok(canonical) = fs::canonicalize(&logs) {
                    whitelist.push(canonical);
                }
            }
        }
    }

    whitelist
}

/// Validates that a path is safe to clean.
///
/// SECURITY CHECKS:
/// 1. Path must exist
/// 2. Path must canonicalize successfully (no broken symlinks)
/// 3. Canonical path must start with one of the whitelisted directories
/// 4. Path cannot be a symlink itself
///
/// # Arguments
/// * `path_str` - The path to validate
/// * `whitelist` - List of allowed base directories
///
/// # Returns
/// * `Ok(PathBuf)` - Canonical path if valid
/// * `Err(String)` - Error message if invalid
fn validate_path(path_str: &str, whitelist: &[PathBuf]) -> Result<PathBuf, String> {
    // Skip virtual commands
    if path_str.starts_with("::") {
        return Ok(PathBuf::from(path_str));
    }

    let path = Path::new(path_str);

    // 1. Path must exist
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path_str));
    }

    // 2. Check if it's a symlink BEFORE canonicalizing
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!("Symlinks not allowed: {}", path_str));
            }
        }
        Err(e) => {
            return Err(format!("Cannot read path metadata: {}", e));
        }
    }

    // 3. Canonicalize (resolves .., ., symlinks in parent paths)
    let canonical = match fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) => {
            return Err(format!("Cannot canonicalize path: {}", e));
        }
    };

    // 4. Verify canonical path starts with a whitelisted directory
    let is_whitelisted = whitelist
        .iter()
        .any(|allowed| canonical.starts_with(allowed) || canonical == *allowed);

    if !is_whitelisted {
        return Err(format!("Path not in whitelist: {}", canonical.display()));
    }

    Ok(canonical)
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM TARGETS DETECTION
// ═══════════════════════════════════════════════════════════════════════════

pub fn get_system_targets() -> Vec<JunkItem> {
    let mut targets = Vec::new();

    // --- VIRTUAL TARGETS (Commands) ---
    targets.push(JunkItem {
        id: uuid::Uuid::new_v4().to_string(),
        name: "DNS Cache".to_string(),
        path: "::DNS_CACHE::".to_string(),
        category: "Network".to_string(),
        size: 0,
        description: "Flush OS DNS resolver cache to remove network traces.".to_string(),
        warning: Some("May temporarily slow down first website loads.".to_string()),
    });

    targets.push(JunkItem {
        id: uuid::Uuid::new_v4().to_string(),
        name: "System Clipboard".to_string(),
        path: "::CLIPBOARD::".to_string(),
        category: "System".to_string(),
        size: 0,
        description: "Clear current copied text/data from memory.".to_string(),
        warning: None,
    });

    if let Some(base_dirs) = BaseDirs::new() {
        // --- WINDOWS TARGETS ---
        #[cfg(target_os = "windows")]
        {
            let temp = std::env::var("TEMP").unwrap_or_default();
            if !temp.is_empty() {
                add_target(
                    &mut targets,
                    "Windows Temp",
                    &temp,
                    "System",
                    "Temporary system files",
                    None,
                );
            }

            // Windows Recent Documents
            let recent = base_dirs
                .data_dir()
                .join("Microsoft")
                .join("Windows")
                .join("Recent");
            add_target(
                &mut targets,
                "Recent Files",
                recent.to_str().unwrap(),
                "System",
                "File history shortcuts",
                Some("Will clear jump list and recent file history.".to_string()),
            );

            // Browser Caches
            let local_app_data = base_dirs.data_local_dir();
            let browsers = vec![
                ("Google/Chrome/User Data/Default/Cache", "Chrome Cache"),
                ("Microsoft/Edge/User Data/Default/Cache", "Edge Cache"),
                (
                    "BraveSoftware/Brave-Browser/User Data/Default/Cache",
                    "Brave Cache",
                ),
                ("Mozilla/Firefox/Profiles", "Firefox Cache"),
            ];

            for (subpath, name) in browsers {
                let p = local_app_data.join(subpath);
                add_target(
                    &mut targets,
                    name,
                    p.to_str().unwrap(),
                    "Browser",
                    "Web browsing cache",
                    Some("Close browser before cleaning.".to_string()),
                );
            }
        }

        // --- MACOS TARGETS ---
        #[cfg(target_os = "macos")]
        {
            let home = base_dirs.home_dir();
            let cache = base_dirs.cache_dir();

            add_target(
                &mut targets,
                "User Caches",
                cache.to_str().unwrap(),
                "System",
                "Application cache files",
                None,
            );

            let logs = home.join("Library/Logs");
            add_target(
                &mut targets,
                "User Logs",
                logs.to_str().unwrap(),
                "Logs",
                "System and app log files",
                Some("May affect troubleshooting.".to_string()),
            );

            let chrome = home.join("Library/Caches/Google/Chrome/Default/Cache");
            add_target(
                &mut targets,
                "Chrome Cache",
                chrome.to_str().unwrap(),
                "Browser",
                "Web browsing cache",
                Some("Close Chrome before cleaning.".to_string()),
            );

            let safari = home.join("Library/Caches/com.apple.Safari");
            add_target(
                &mut targets,
                "Safari Cache",
                safari.to_str().unwrap(),
                "Browser",
                "Web browsing cache",
                Some("Close Safari before cleaning.".to_string()),
            );
        }

        // --- DEVELOPER CACHES (Cross-Platform) ---
        let home = base_dirs.home_dir();

        // NPM CACHE
        let npm_locations = vec![
            home.join(".npm"),
            base_dirs.data_dir().join("npm-cache"),
            base_dirs.data_local_dir().join("npm-cache"),
            base_dirs.cache_dir().join("npm"),
        ];

        let mut npm_found = false;
        for path in npm_locations {
            if path.exists() && !npm_found {
                add_target(
                    &mut targets,
                    "NPM Cache",
                    path.to_str().unwrap(),
                    "Developer",
                    "Node.js package cache",
                    Some("Will require re-downloading packages.".to_string()),
                );
                npm_found = true; // Only add once
            }
        }

        // YARN CACHE
        #[cfg(target_os = "windows")]
        let yarn = base_dirs.data_local_dir().join("Yarn/Cache");
        #[cfg(not(target_os = "windows"))]
        let yarn = home.join(".cache/yarn");

        add_target(
            &mut targets,
            "Yarn Cache",
            yarn.to_str().unwrap(),
            "Developer",
            "Yarn package cache",
            Some("Will slow down next yarn install.".to_string()),
        );

        // CARGO CACHE
        let cargo = home.join(".cargo/registry");
        add_target(
            &mut targets,
            "Cargo Registry",
            cargo.to_str().unwrap(),
            "Developer",
            "Rust crate registry cache",
            Some("Will force re-downloading crates.".to_string()),
        );

        // PIP CACHE
        #[cfg(target_os = "windows")]
        let pip = base_dirs.data_local_dir().join("pip/Cache");
        #[cfg(not(target_os = "windows"))]
        let pip = home.join(".cache/pip");

        add_target(
            &mut targets,
            "Pip Cache",
            pip.to_str().unwrap(),
            "Developer",
            "Python package cache",
            Some("Will slow down next pip install.".to_string()),
        );
    }

    targets
}

fn add_target(
    list: &mut Vec<JunkItem>,
    name: &str,
    path: &str,
    cat: &str,
    desc: &str,
    warning: Option<String>,
) {
    if Path::new(path).exists() {
        if !list.iter().any(|x| x.path == path) {
            list.push(JunkItem {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.to_string(),
                path: path.to_string(),
                category: cat.to_string(),
                size: 0,
                description: desc.to_string(),
                warning,
            });
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCANNING
// ═══════════════════════════════════════════════════════════════════════════

pub fn scan_targets() -> Vec<JunkItem> {
    let mut items = get_system_targets();

    // PARALLEL: Calculate sizes with symlink protection
    items.par_iter_mut().for_each(|item| {
        if item.path.starts_with("::") {
            item.size = 0;
        } else {
            let path = Path::new(&item.path);
            item.size = calculate_dir_size(path);
        }
    });

    // Filter: Keep items with size > 0 OR virtual commands
    items.retain(|i| i.size > 0 || i.path.starts_with("::"));
    items
}

/// Calculates directory size with symlink protection.
///
/// SECURITY: Never follows symlinks, max depth protection
fn calculate_dir_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .follow_links(false) // CRITICAL: Never follow symlinks
        .min_depth(1)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            // Use symlink_metadata to never follow symlinks
            match fs::symlink_metadata(e.path()) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        None // Skip symlinks
                    } else if metadata.is_file() {
                        Some(metadata.len())
                    } else {
                        None
                    }
                }
                Err(_) => None,
            }
        })
        .sum()
}

// ═══════════════════════════════════════════════════════════════════════════
// DRY RUN (Preview Before Delete)
// ═══════════════════════════════════════════════════════════════════════════

pub fn dry_run(paths: Vec<String>) -> Result<DryRunResult> {
    let whitelist = get_whitelist();
    let mut total_files = 0u64;
    let mut total_size = 0u64;
    let mut file_list = Vec::new();
    let mut warnings = Vec::new();

    for path_str in paths {
        // Virtual commands
        if path_str.starts_with("::") {
            file_list.push(format!("[ACTION] {}", path_str));
            continue;
        }

        // Validate path
        let canonical = match validate_path(&path_str, &whitelist) {
            Ok(p) => p,
            Err(e) => {
                warnings.push(format!("Skipped {}: {}", path_str, e));
                continue;
            }
        };

        // Collect files that would be deleted
        if canonical.is_dir() {
            for entry in WalkDir::new(&canonical)
                .follow_links(false)
                .max_depth(MAX_DEPTH)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if let Ok(metadata) = fs::symlink_metadata(entry.path()) {
                    if !metadata.file_type().is_symlink() && metadata.is_file() {
                        total_files += 1;
                        total_size += metadata.len();

                        if file_list.len() < 100 {
                            // Only show first 100 files
                            file_list.push(entry.path().display().to_string());
                        }
                    }
                }
            }
        } else if canonical.is_file() {
            if let Ok(metadata) = fs::symlink_metadata(&canonical) {
                if !metadata.file_type().is_symlink() {
                    total_files += 1;
                    total_size += metadata.len();
                    file_list.push(canonical.display().to_string());
                }
            }
        }
    }

    if file_list.len() >= 100 {
        warnings.push(format!("Showing first 100 of {} files", total_files));
    }

    if total_size > LARGE_OPERATION_THRESHOLD {
        warnings.push(format!(
            "Large operation: {} - proceed with caution",
            format_size(total_size)
        ));
    }

    Ok(DryRunResult {
        total_files,
        total_size,
        file_list,
        warnings,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEANING (With Progress & Security)
// ═══════════════════════════════════════════════════════════════════════════

pub fn clean_paths<R: tauri::Runtime>(
    paths: Vec<String>,
    app_handle: &tauri::AppHandle<R>,
) -> Result<CleanResult> {
    // Reset cancellation flag
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let whitelist = get_whitelist();
    let mut errors = Vec::new();

    // Validate all paths first
    let mut validated_paths = Vec::new();
    let mut total_size = 0u64;

    for path_str in paths {
        if path_str.starts_with("::") {
            validated_paths.push(path_str);
        } else {
            match validate_path(&path_str, &whitelist) {
                Ok(canonical) => {
                    // Calculate size for hard limit check
                    let path = Path::new(&canonical);
                    let size = calculate_dir_size(path);
                    total_size += size;

                    validated_paths.push(canonical.display().to_string());
                }
                Err(e) => {
                    errors.push(format!("Validation failed for {}: {}", path_str, e));
                }
            }
        }
    }

    // Hard limit check: Reject if total size exceeds MAX_TOTAL_SIZE
    if total_size > MAX_TOTAL_SIZE {
        return Err(anyhow::anyhow!(
            "Operation too large: {} exceeds maximum of {} (50 GB). Please select fewer items.",
            format_size(total_size),
            format_size(MAX_TOTAL_SIZE)
        ));
    }

    // Count total files for progress
    let total_files = Arc::new(AtomicU64::new(0));
    let files_processed = Arc::new(AtomicU64::new(0));
    let bytes_freed = Arc::new(AtomicU64::new(0));

    // Pre-count files
    for path_str in &validated_paths {
        if !path_str.starts_with("::") {
            let path = Path::new(path_str);
            let count = count_files(path);
            total_files.fetch_add(count, Ordering::Relaxed);
        }
    }

    // Process paths
    let results: Vec<_> = validated_paths
        .into_iter()
        .map(|path_str| {
            if CANCEL_FLAG.load(Ordering::Relaxed) {
                return (0, 0, vec!["Operation cancelled".to_string()]);
            }

            // Virtual commands
            if path_str == "::DNS_CACHE::" {
                match flush_dns() {
                    Ok(_) => {
                        emit_progress(
                            app_handle,
                            files_processed.load(Ordering::Relaxed),
                            total_files.load(Ordering::Relaxed),
                            bytes_freed.load(Ordering::Relaxed),
                            "Flushing DNS cache".to_string(),
                        );
                        return (0, 0, vec![]);
                    }
                    Err(e) => return (0, 0, vec![e]),
                }
            }

            if path_str == "::CLIPBOARD::" {
                match clear_clipboard() {
                    Ok(_) => {
                        emit_progress(
                            app_handle,
                            files_processed.load(Ordering::Relaxed),
                            total_files.load(Ordering::Relaxed),
                            bytes_freed.load(Ordering::Relaxed),
                            "Clearing clipboard".to_string(),
                        );
                        return (0, 0, vec![]);
                    }
                    Err(e) => return (0, 0, vec![e]),
                }
            }

            // File deletion with progress
            clean_single_path(
                &path_str,
                app_handle,
                &files_processed,
                &total_files,
                &bytes_freed,
            )
        })
        .collect();

    // Aggregate results
    let mut total_bytes_freed = 0u64;
    let mut total_files_deleted = 0u64;

    for (bytes, files, errs) in results {
        total_bytes_freed += bytes;
        total_files_deleted += files;
        errors.extend(errs);
    }

    // Final progress update
    emit_progress(
        app_handle,
        files_processed.load(Ordering::Relaxed),
        total_files.load(Ordering::Relaxed),
        total_bytes_freed,
        "Cleanup complete".to_string(),
    );

    Ok(CleanResult {
        bytes_freed: total_bytes_freed,
        files_deleted: total_files_deleted,
        errors,
    })
}

fn count_files(path: &Path) -> u64 {
    if path.is_file() {
        return 1;
    }

    WalkDir::new(path)
        .follow_links(false)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            if let Ok(metadata) = fs::symlink_metadata(e.path()) {
                !metadata.file_type().is_symlink() && metadata.is_file()
            } else {
                false
            }
        })
        .count() as u64
}

fn clean_single_path<R: tauri::Runtime>(
    path_str: &str,
    app_handle: &tauri::AppHandle<R>,
    files_processed: &Arc<AtomicU64>,
    total_files: &Arc<AtomicU64>,
    bytes_freed: &Arc<AtomicU64>,
) -> (u64, u64, Vec<String>) {
    let mut local_freed = 0u64;
    let mut local_files = 0u64;
    let mut local_errors = Vec::new();

    let path = Path::new(path_str);

    if path.is_dir() {
        // Delete directory contents
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                if CANCEL_FLAG.load(Ordering::Relaxed) {
                    break;
                }

                let p = entry.path();

                // Skip symlinks
                if let Ok(metadata) = fs::symlink_metadata(&p) {
                    if metadata.file_type().is_symlink() {
                        continue;
                    }

                    // Emit progress
                    emit_progress(
                        app_handle,
                        files_processed.load(Ordering::Relaxed),
                        total_files.load(Ordering::Relaxed),
                        bytes_freed.load(Ordering::Relaxed),
                        p.display().to_string(),
                    );

                    if p.is_dir() {
                        // Get size before deletion
                        let size = calculate_dir_size(&p);

                        match fs::remove_dir_all(&p) {
                            Ok(_) => {
                                local_freed += size;
                                local_files += 1;
                                files_processed.fetch_add(1, Ordering::Relaxed);
                                bytes_freed.fetch_add(size, Ordering::Relaxed);
                            }
                            Err(e) => {
                                local_errors.push(format!(
                                    "Failed to delete {}: {}",
                                    p.display(),
                                    e
                                ));
                            }
                        }
                    } else if metadata.is_file() {
                        let size = metadata.len();

                        match fs::remove_file(&p) {
                            Ok(_) => {
                                local_freed += size;
                                local_files += 1;
                                files_processed.fetch_add(1, Ordering::Relaxed);
                                bytes_freed.fetch_add(size, Ordering::Relaxed);
                            }
                            Err(e) => {
                                local_errors.push(format!(
                                    "Failed to delete {}: {}",
                                    p.display(),
                                    e
                                ));
                            }
                        }
                    }
                }
            }
        }
    } else if path.is_file() {
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if !metadata.file_type().is_symlink() {
                let size = metadata.len();

                match fs::remove_file(path) {
                    Ok(_) => {
                        local_freed += size;
                        local_files += 1;
                        files_processed.fetch_add(1, Ordering::Relaxed);
                        bytes_freed.fetch_add(size, Ordering::Relaxed);
                    }
                    Err(e) => {
                        local_errors.push(format!("Failed to delete {}: {}", path.display(), e));
                    }
                }
            }
        }
    }

    (local_freed, local_files, local_errors)
}

fn emit_progress<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    files_processed: u64,
    total_files: u64,
    bytes_freed: u64,
    current_file: String,
) {
    let percentage = if total_files > 0 {
        ((files_processed as f64 / total_files as f64) * 100.0) as u8
    } else {
        0
    };

    let progress = CleanProgress {
        files_processed,
        total_files,
        bytes_freed,
        current_file,
        percentage,
    };

    let _ = app_handle.emit("clean-progress", progress);
}

// ═══════════════════════════════════════════════════════════════════════════
// CANCELLATION
// ═══════════════════════════════════════════════════════════════════════════

pub fn cancel_cleaning() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM COMMANDS (With Error Handling)
// ═══════════════════════════════════════════════════════════════════════════

fn flush_dns() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("ipconfig")
            .arg("/flushdns")
            .output()
            .map_err(|e| format!("Failed to flush DNS: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("killall")
            .arg("-HUP")
            .arg("mDNSResponder")
            .output()
            .map_err(|e| format!("Failed to flush DNS: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        // Try systemd-resolved first, fall back to legacy
        if Command::new("resolvectl")
            .arg("flush-caches")
            .output()
            .is_err()
        {
            // Fallback for older systems
            let _ = Command::new("systemctl")
                .args(&["restart", "systemd-resolved"])
                .output();
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("DNS flush not supported on this platform".to_string())
    }
}

fn clear_clipboard() -> Result<(), String> {
    // Try using arboard crate if available (safer than shell commands)
    #[cfg(feature = "clipboard")]
    {
        use arboard::Clipboard;
        let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard error: {}", e))?;
        clipboard
            .clear()
            .map_err(|e| format!("Failed to clear clipboard: {}", e))?;
        return Ok(());
    }

    // Fallback to platform-specific shell commands
    #[cfg(not(feature = "clipboard"))]
    {
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            Command::new("cmd")
                .args(&["/C", "echo off | clip"])
                .output()
                .map_err(|e| format!("Failed to clear clipboard: {}", e))?;
            Ok(())
        }

        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            Command::new("pbcopy")
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|e| format!("Failed to clear clipboard: {}", e))?;
            Ok(())
        }

        #[cfg(target_os = "linux")]
        {
            use std::process::Command;
            // Try xsel first, then xclip as fallback
            if Command::new("xsel").arg("-bc").output().is_err() {
                Command::new("xclip")
                    .args(&["-selection", "clipboard", "-i"])
                    .stdin(std::process::Stdio::null())
                    .output()
                    .map_err(|e| format!("Failed to clear clipboard: {}", e))?;
            }
            Ok(())
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            Err("Clipboard clear not supported on this platform".to_string())
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} bytes", bytes)
    }
}
