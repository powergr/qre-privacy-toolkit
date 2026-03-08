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

const MAX_TOTAL_SIZE: u64 = 50 * 1024 * 1024 * 1024; // 50 GB hard safety limit
const MAX_DEPTH: usize = 10;
const LARGE_OPERATION_THRESHOLD: u64 = 10 * 1024 * 1024 * 1024; // Warn at 10 GB

static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

// ═══════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════

/// Represents a specific cache folder or system command that the user can clean.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JunkItem {
    pub id: String,
    pub name: String,
    /// A standard file path OR a special command identifier e.g. `::DNS_CACHE::`.
    pub path: String,
    /// "System" | "Browser" | "Developer" | "Logs" | "Network" | "Privacy"
    pub category: String,
    pub size: u64,
    pub description: String,
    pub warning: Option<String>,
    /// When true, the UI shows a shield icon and warns that admin/root privileges
    /// are required. The OS will reject the operation gracefully if not elevated.
    pub elevation_required: bool,
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

/// Builds a strict whitelist of directories that are safe to delete from.
/// Even if the frontend sends a malicious path, the backend will reject it.
fn get_whitelist() -> Vec<PathBuf> {
    let mut whitelist = Vec::new();

    if let Some(base_dirs) = BaseDirs::new() {
        let home = base_dirs.home_dir();

        // ── Temp directories ──────────────────────────────────────────────
        #[cfg(target_os = "windows")]
        {
            for var in &["TEMP", "TMP"] {
                if let Ok(val) = std::env::var(var) {
                    if let Ok(c) = fs::canonicalize(&val) {
                        whitelist.push(c);
                    }
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(c) = fs::canonicalize("/tmp") {
                whitelist.push(c);
            }
        }

        // OS standard cache directory
        if let Ok(c) = fs::canonicalize(base_dirs.cache_dir()) {
            whitelist.push(c);
        }

        // ── Windows-specific ──────────────────────────────────────────────
        #[cfg(target_os = "windows")]
        {
            // %LOCALAPPDATA% — browser caches, thumbnail cache, WER, npm, pip, etc.
            if let Ok(c) = fs::canonicalize(base_dirs.data_local_dir()) {
                whitelist.push(c);
            }
            // %APPDATA% (roaming) — WER\ReportArchive, Jump Lists, Search history
            if let Ok(c) = fs::canonicalize(base_dirs.data_dir()) {
                whitelist.push(c);
            }
            // Windows Update download cache (requires elevation to clean)
            let upd = PathBuf::from(r"C:\Windows\SoftwareDistribution\Download");
            if upd.exists() {
                if let Ok(c) = fs::canonicalize(&upd) {
                    whitelist.push(c);
                }
            }
        }

        // ── macOS-specific ────────────────────────────────────────────────
        #[cfg(target_os = "macos")]
        {
            // ~/Library/Logs
            let logs = home.join("Library/Logs");
            if logs.exists() {
                if let Ok(c) = fs::canonicalize(&logs) {
                    whitelist.push(c);
                }
            }
            // ~/Library/Application Support — browser/dev caches stored there
            let app_support = home.join("Library/Application Support");
            if app_support.exists() {
                if let Ok(c) = fs::canonicalize(&app_support) {
                    whitelist.push(c);
                }
            }
            // ~/Library/Developer — Xcode DerivedData
            let developer = home.join("Library/Developer");
            if developer.exists() {
                if let Ok(c) = fs::canonicalize(&developer) {
                    whitelist.push(c);
                }
            }
        }

        // ── Linux-specific ────────────────────────────────────────────────
        #[cfg(target_os = "linux")]
        {
            // /var/crash — system crash dumps (elevation required)
            let crash = PathBuf::from("/var/crash");
            if crash.exists() {
                if let Ok(c) = fs::canonicalize(&crash) {
                    whitelist.push(c);
                }
            }
        }

        // ── Developer cache directories (home-dir based, cross-platform) ──
        let dev_dirs = [
            ".npm",
            ".cache",
            ".cargo/registry",
            ".gradle/caches",
            ".m2/repository",
            "go/pkg/mod/cache",
            ".local/share/pnpm/store",
            ".composer/cache",
        ];
        for d in &dev_dirs {
            let p = home.join(d);
            if p.exists() {
                if let Ok(c) = fs::canonicalize(&p) {
                    whitelist.push(c);
                }
            }
        }
    }

    whitelist
}

fn validate_path(path_str: &str, whitelist: &[PathBuf]) -> Result<PathBuf, String> {
    // Virtual commands (::DNS_CACHE::, etc.) bypass filesystem checks entirely
    if path_str.starts_with("::") {
        return Ok(PathBuf::from(path_str));
    }

    let path = Path::new(path_str);

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path_str));
    }

    // Check if symlink BEFORE canonicalizing — prevents symlink-in-safe-folder attacks
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            return Err(format!("Symlinks not allowed: {}", path_str));
        }
        Err(e) => return Err(format!("Cannot read path metadata: {}", e)),
        _ => {}
    }

    let canonical =
        fs::canonicalize(path).map_err(|e| format!("Cannot canonicalize path: {}", e))?;

    if !whitelist
        .iter()
        .any(|a| canonical.starts_with(a) || canonical == *a)
    {
        return Err(format!("Path not in whitelist: {}", canonical.display()));
    }

    Ok(canonical)
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM TARGETS DETECTION
// ═══════════════════════════════════════════════════════════════════════════

pub fn get_system_targets() -> Vec<JunkItem> {
    let mut targets = Vec::new();

    // ── NETWORK (Virtual commands) ────────────────────────────────────────
    targets.push(JunkItem {
        id: uuid::Uuid::new_v4().to_string(),
        name: "DNS Cache".to_string(),
        path: "::DNS_CACHE::".to_string(),
        category: "Network".to_string(),
        size: 0,
        description: "Flush OS DNS resolver cache to remove network traces.".to_string(),
        warning: Some("May temporarily slow first website loads.".to_string()),
        elevation_required: false,
    });

    // ── PRIVACY (Virtual commands) ────────────────────────────────────────
    targets.push(JunkItem {
        id: uuid::Uuid::new_v4().to_string(),
        name: "System Clipboard".to_string(),
        path: "::CLIPBOARD::".to_string(),
        category: "Privacy".to_string(),
        size: 0,
        description: "Clear current copied text/data from memory.".to_string(),
        warning: None,
        elevation_required: false,
    });

    targets.push(JunkItem {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Bash History".to_string(),
        path: "::CLEAR_BASH_HISTORY::".to_string(),
        category: "Privacy".to_string(),
        size: 0,
        description: "Erase all recorded bash terminal command history.".to_string(),
        warning: Some("Permanently erases your entire bash command history.".to_string()),
        elevation_required: false,
    });

    targets.push(JunkItem {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Zsh History".to_string(),
        path: "::CLEAR_ZSH_HISTORY::".to_string(),
        category: "Privacy".to_string(),
        size: 0,
        description: "Erase all recorded zsh terminal command history.".to_string(),
        warning: Some("Permanently erases your entire zsh command history.".to_string()),
        elevation_required: false,
    });

    // ── SYSTEM (OS-specific virtual commands) ─────────────────────────────
    #[cfg(target_os = "windows")]
    {
        targets.push(JunkItem {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Recycle Bin".to_string(),
            path: "::RECYCLE_BIN::".to_string(),
            category: "System".to_string(),
            size: 0,
            description: "Permanently empty the Windows Recycle Bin.".to_string(),
            warning: Some("Deleted files cannot be recovered after emptying.".to_string()),
            elevation_required: false,
        });
        targets.push(JunkItem {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Thumbnail Cache".to_string(),
            path: "::WINDOWS_THUMBNAIL_CACHE::".to_string(),
            category: "System".to_string(),
            size: 0,
            description:
                "Remove Explorer thumbcache_*.db files. Rebuilt automatically on next browse."
                    .to_string(),
            warning: None,
            elevation_required: false,
        });
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    targets.push(JunkItem {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Trash".to_string(),
        path: "::TRASH::".to_string(),
        category: "System".to_string(),
        size: 0,
        description: "Permanently empty the system Trash.".to_string(),
        warning: Some("Deleted files cannot be recovered after emptying.".to_string()),
        elevation_required: false,
    });

    if let Some(base_dirs) = BaseDirs::new() {
        let home = base_dirs.home_dir();

        // ── WINDOWS path-based targets ────────────────────────────────────
        #[cfg(target_os = "windows")]
        {
            let local = base_dirs.data_local_dir();
            let appdata = base_dirs.data_dir();

            let temp = std::env::var("TEMP").unwrap_or_default();
            if !temp.is_empty() {
                add_target(
                    &mut targets,
                    "Windows Temp",
                    &temp,
                    "System",
                    "Temporary system files",
                    None,
                    false,
                );
            }

            // Windows Error Reports
            let wer_archive = appdata.join("Microsoft/Windows/WER/ReportArchive");
            add_target(
                &mut targets,
                "Error Report Archive",
                wer_archive.to_str().unwrap(),
                "System",
                "Archived Windows crash and error reports",
                None,
                false,
            );

            let wer_queue = appdata.join("Microsoft/Windows/WER/ReportQueue");
            add_target(
                &mut targets,
                "Error Report Queue",
                wer_queue.to_str().unwrap(),
                "System",
                "Pending Windows crash and error reports",
                None,
                false,
            );

            // Windows Update download cache (elevation required)
            let upd = PathBuf::from(r"C:\Windows\SoftwareDistribution\Download");
            add_target(
                &mut targets,
                "Windows Update Cache",
                upd.to_str().unwrap(),
                "System",
                "Downloaded update packages — safe to clean when Windows Update is idle",
                Some("Do not clean while Windows Update is actively running.".to_string()),
                true,
            );

            // Privacy targets
            let recent = appdata.join("Microsoft/Windows/Recent");
            add_target(
                &mut targets,
                "Recent Files (MRU)",
                recent.to_str().unwrap(),
                "Privacy",
                "File history shortcuts tracked by Windows",
                Some("Clears jump list and recent file history.".to_string()),
                false,
            );

            let jump_auto = appdata.join("Microsoft/Windows/Recent/AutomaticDestinations");
            add_target(
                &mut targets,
                "Jump List — Recent",
                jump_auto.to_str().unwrap(),
                "Privacy",
                "Recently accessed documents tracked in taskbar jump lists",
                None,
                false,
            );

            let jump_custom = appdata.join("Microsoft/Windows/Recent/CustomDestinations");
            add_target(
                &mut targets,
                "Jump List — Pinned",
                jump_custom.to_str().unwrap(),
                "Privacy",
                "Pinned items in taskbar jump lists",
                None,
                false,
            );

            let search = local.join("Microsoft/Windows/Explorer");
            add_target(
                &mut targets,
                "Search History",
                search.to_str().unwrap(),
                "Privacy",
                "Windows Explorer search history entries",
                None,
                false,
            );

            // Browser caches (Windows)
            let browsers = [
                ("Google/Chrome/User Data/Default/Cache", "Chrome Cache"),
                ("Microsoft/Edge/User Data/Default/Cache", "Edge Cache"),
                (
                    "BraveSoftware/Brave-Browser/User Data/Default/Cache",
                    "Brave Cache",
                ),
                ("Mozilla/Firefox/Profiles", "Firefox Cache"),
                (
                    "Opera Software/Opera Stable/Cache/Cache_Data",
                    "Opera Cache",
                ),
                (
                    "Opera Software/Opera GX Stable/Cache/Cache_Data",
                    "Opera GX Cache",
                ),
                ("Vivaldi/User Data/Default/Cache", "Vivaldi Cache"),
            ];
            for (subpath, name) in &browsers {
                let p = local.join(subpath);
                add_target(
                    &mut targets,
                    name,
                    p.to_str().unwrap(),
                    "Browser",
                    "Web browsing cache",
                    Some("Close the browser before cleaning.".to_string()),
                    false,
                );
            }
        }

        // ── MACOS path-based targets ──────────────────────────────────────
        #[cfg(target_os = "macos")]
        {
            let cache = base_dirs.cache_dir();

            add_target(
                &mut targets,
                "User Caches",
                cache.to_str().unwrap(),
                "System",
                "Application cache files",
                None,
                false,
            );

            let logs = home.join("Library/Logs");
            add_target(
                &mut targets,
                "User Logs",
                logs.to_str().unwrap(),
                "Logs",
                "System and application log files",
                Some("May affect troubleshooting ability.".to_string()),
                false,
            );

            let crash = home.join("Library/Application Support/CrashReporter");
            add_target(
                &mut targets,
                "Crash Reports",
                crash.to_str().unwrap(),
                "System",
                "Application crash logs and diagnostic reports",
                None,
                false,
            );

            // Privacy
            let recent = home.join("Library/Application Support/com.apple.sharedfilelist");
            add_target(
                &mut targets,
                "Recent Items",
                recent.to_str().unwrap(),
                "Privacy",
                "Recently opened files and apps tracked by macOS Finder",
                Some("Clears the Recent Items menu in Finder and applications.".to_string()),
                false,
            );

            // Browser caches (macOS)
            let browsers: &[(&str, &str)] = &[
                ("Library/Caches/Google/Chrome/Default/Cache", "Chrome Cache"),
                ("Library/Caches/com.apple.Safari", "Safari Cache"),
                ("Library/Caches/Firefox/Profiles", "Firefox Cache"),
                (
                    "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cache",
                    "Brave Cache",
                ),
                ("Library/Caches/com.operasoftware.Opera", "Opera Cache"),
                (
                    "Library/Application Support/Vivaldi/Default/Cache",
                    "Vivaldi Cache",
                ),
                (
                    "Library/Caches/Company/Arc/User Data/Default/Cache",
                    "Arc Cache",
                ),
            ];
            for (subpath, name) in browsers {
                let p = home.join(subpath);
                add_target(
                    &mut targets,
                    name,
                    p.to_str().unwrap(),
                    "Browser",
                    "Web browsing cache",
                    Some("Close the browser before cleaning.".to_string()),
                    false,
                );
            }

            // Developer — macOS-specific
            let cocoapods = home.join("Library/Caches/CocoaPods");
            add_target(
                &mut targets,
                "CocoaPods Cache",
                cocoapods.to_str().unwrap(),
                "Developer",
                "CocoaPods dependency download cache",
                Some("Will require re-fetching pods on next pod install.".to_string()),
                false,
            );

            let homebrew = home.join("Library/Caches/Homebrew");
            add_target(
                &mut targets,
                "Homebrew Cache",
                homebrew.to_str().unwrap(),
                "Developer",
                "Homebrew package download cache",
                Some("Will require re-downloading bottles on next brew install.".to_string()),
                false,
            );

            let jetbrains = home.join("Library/Caches/JetBrains");
            add_target(
                &mut targets,
                "JetBrains IDE Caches",
                jetbrains.to_str().unwrap(),
                "Developer",
                "IntelliJ IDEA, WebStorm, PyCharm, etc. index caches",
                Some("IDEs will re-index projects on next launch (may be slow).".to_string()),
                false,
            );

            let xcode = home.join("Library/Developer/Xcode/DerivedData");
            add_target(
                &mut targets,
                "Xcode DerivedData",
                xcode.to_str().unwrap(),
                "Developer",
                "Xcode build output and intermediate compile files",
                Some("Will require a full rebuild of all Xcode projects.".to_string()),
                false,
            );
        }

        // ── LINUX path-based targets ──────────────────────────────────────
        #[cfg(target_os = "linux")]
        {
            let crash = PathBuf::from("/var/crash");
            add_target(
                &mut targets,
                "Crash Dumps",
                crash.to_str().unwrap(),
                "System",
                "System-wide application crash dump files",
                Some("Requires administrator privileges to delete.".to_string()),
                true,
            );

            let linux_browsers: &[(&str, &str)] = &[
                (".cache/google-chrome/Default/Cache", "Chrome Cache"),
                (".cache/chromium/Default/Cache", "Chromium Cache"),
                (".cache/mozilla/firefox", "Firefox Cache"),
                (
                    ".cache/BraveSoftware/Brave-Browser/Default/Cache",
                    "Brave Cache",
                ),
                (".cache/opera/Cache", "Opera Cache"),
                (".cache/vivaldi/Default/Cache", "Vivaldi Cache"),
            ];
            for (subpath, name) in linux_browsers {
                let p = home.join(subpath);
                add_target(
                    &mut targets,
                    name,
                    p.to_str().unwrap(),
                    "Browser",
                    "Web browsing cache",
                    Some("Close the browser before cleaning.".to_string()),
                    false,
                );
            }

            let jb = home.join(".cache/JetBrains");
            add_target(
                &mut targets,
                "JetBrains IDE Caches",
                jb.to_str().unwrap(),
                "Developer",
                "IntelliJ IDEA, WebStorm, PyCharm, etc. index caches",
                Some("IDEs will re-index projects on next launch.".to_string()),
                false,
            );
        }

        // ── DEVELOPER CACHES (Cross-Platform) ────────────────────────────

        // NPM — check multiple common locations
        let npm_locations = [
            home.join(".npm"),
            base_dirs.data_dir().join("npm-cache"),
            base_dirs.data_local_dir().join("npm-cache"),
            base_dirs.cache_dir().join("npm"),
        ];
        for path in npm_locations.iter() {
            if path.exists() {
                add_target(
                    &mut targets,
                    "NPM Cache",
                    path.to_str().unwrap(),
                    "Developer",
                    "Node.js package download cache",
                    Some("Will require re-downloading packages on next npm install.".to_string()),
                    false,
                );
                break; // Only add once
            }
        }

        // YARN
        #[cfg(target_os = "windows")]
        let yarn = base_dirs.data_local_dir().join("Yarn/Cache");
        #[cfg(not(target_os = "windows"))]
        let yarn = home.join(".cache/yarn");
        add_target(
            &mut targets,
            "Yarn Cache",
            yarn.to_str().unwrap(),
            "Developer",
            "Yarn package manager download cache",
            Some("Will slow down next yarn install.".to_string()),
            false,
        );

        // PNPM
        #[cfg(target_os = "windows")]
        let pnpm = base_dirs.data_local_dir().join("pnpm/store");
        #[cfg(not(target_os = "windows"))]
        let pnpm = home.join(".local/share/pnpm/store");
        add_target(
            &mut targets,
            "pnpm Store",
            pnpm.to_str().unwrap(),
            "Developer",
            "pnpm content-addressable package store",
            Some("Will require re-downloading packages on next pnpm install.".to_string()),
            false,
        );

        // CARGO
        let cargo = home.join(".cargo/registry");
        add_target(
            &mut targets,
            "Cargo Registry",
            cargo.to_str().unwrap(),
            "Developer",
            "Rust crate registry download cache",
            Some("Will force re-downloading all crates on next cargo build.".to_string()),
            false,
        );

        // PIP
        #[cfg(target_os = "windows")]
        let pip = base_dirs.data_local_dir().join("pip/Cache");
        #[cfg(not(target_os = "windows"))]
        let pip = home.join(".cache/pip");
        add_target(
            &mut targets,
            "Pip Cache",
            pip.to_str().unwrap(),
            "Developer",
            "Python pip package download cache",
            Some("Will slow down next pip install.".to_string()),
            false,
        );

        // GRADLE
        let gradle = home.join(".gradle/caches");
        add_target(
            &mut targets,
            "Gradle Cache",
            gradle.to_str().unwrap(),
            "Developer",
            "Gradle build system dependency and transform cache",
            Some("Will require re-downloading Gradle dependencies on next build.".to_string()),
            false,
        );

        // MAVEN
        let maven = home.join(".m2/repository");
        add_target(
            &mut targets,
            "Maven Repository",
            maven.to_str().unwrap(),
            "Developer",
            "Maven local artifact repository cache",
            Some("Will require re-downloading all Maven artifacts.".to_string()),
            false,
        );

        // GO MODULE CACHE
        let go_mod = home.join("go/pkg/mod/cache");
        add_target(
            &mut targets,
            "Go Module Cache",
            go_mod.to_str().unwrap(),
            "Developer",
            "Go module download cache",
            Some("Will require re-downloading Go modules on next go build.".to_string()),
            false,
        );

        // COMPOSER (PHP)
        #[cfg(target_os = "windows")]
        let composer = base_dirs.data_local_dir().join("Composer/cache");
        #[cfg(not(target_os = "windows"))]
        let composer = home.join(".composer/cache");
        add_target(
            &mut targets,
            "Composer Cache",
            composer.to_str().unwrap(),
            "Developer",
            "PHP Composer dependency download cache",
            Some("Will require re-downloading PHP packages on next composer install.".to_string()),
            false,
        );

        // JETBRAINS — Windows (macOS and Linux handled above in platform blocks)
        #[cfg(target_os = "windows")]
        {
            let jb = base_dirs.data_local_dir().join("JetBrains");
            add_target(
                &mut targets,
                "JetBrains IDE Caches",
                jb.to_str().unwrap(),
                "Developer",
                "IntelliJ IDEA, WebStorm, PyCharm, etc. index caches",
                Some("IDEs will re-index projects on next launch (may be slow).".to_string()),
                false,
            );
        }

        // VS CODE WORKSPACE STORAGE
        #[cfg(target_os = "windows")]
        let vscode = base_dirs.data_dir().join("Code/User/workspaceStorage");
        #[cfg(target_os = "macos")]
        let vscode = home.join("Library/Application Support/Code/User/workspaceStorage");
        #[cfg(target_os = "linux")]
        let vscode = home.join(".config/Code/User/workspaceStorage");
        add_target(
            &mut targets,
            "VS Code Workspace Storage",
            vscode.to_str().unwrap(),
            "Developer",
            "Stale per-project VS Code extension data and caches",
            Some("VS Code will recreate workspace storage on next project open.".to_string()),
            false,
        );
    }

    targets
}

/// Adds a target to the list only if the path exists and is not already present.
fn add_target(
    list: &mut Vec<JunkItem>,
    name: &str,
    path: &str,
    cat: &str,
    desc: &str,
    warning: Option<String>,
    elevation_required: bool,
) {
    if Path::new(path).exists() && !list.iter().any(|x| x.path == path) {
        list.push(JunkItem {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            path: path.to_string(),
            category: cat.to_string(),
            size: 0,
            description: desc.to_string(),
            warning,
            elevation_required,
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCANNING
// ═══════════════════════════════════════════════════════════════════════════

pub fn scan_targets() -> Vec<JunkItem> {
    let mut items = get_system_targets();

    // Parallel size calculation across all CPU cores
    items.par_iter_mut().for_each(|item| {
        item.size = if item.path.starts_with("::") {
            0
        } else {
            calculate_dir_size(Path::new(&item.path))
        };
    });

    // Remove already-empty targets to keep the UI clean
    items.retain(|i| i.size > 0 || i.path.starts_with("::"));
    items
}

fn calculate_dir_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .follow_links(false)
        .min_depth(1)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| match fs::symlink_metadata(e.path()) {
            Ok(m) if !m.file_type().is_symlink() && m.is_file() => Some(m.len()),
            _ => None,
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
        if path_str.starts_with("::") {
            file_list.push(format!("[ACTION] {}", path_str));
            continue;
        }

        let canonical = match validate_path(&path_str, &whitelist) {
            Ok(p) => p,
            Err(e) => {
                warnings.push(format!("Skipped {}: {}", path_str, e));
                continue;
            }
        };

        if canonical.is_dir() {
            for entry in WalkDir::new(&canonical)
                .follow_links(false)
                .max_depth(MAX_DEPTH)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if let Ok(m) = fs::symlink_metadata(entry.path()) {
                    if !m.file_type().is_symlink() && m.is_file() {
                        total_files += 1;
                        total_size += m.len();
                        if file_list.len() < 100 {
                            file_list.push(entry.path().display().to_string());
                        }
                    }
                }
            }
        } else if canonical.is_file() {
            if let Ok(m) = fs::symlink_metadata(&canonical) {
                if !m.file_type().is_symlink() {
                    total_files += 1;
                    total_size += m.len();
                    file_list.push(canonical.display().to_string());
                }
            }
        }
    }

    if file_list.len() >= 100 {
        warnings.push(format!("Showing first 100 of {} files.", total_files));
    }
    if total_size > LARGE_OPERATION_THRESHOLD {
        warnings.push(format!(
            "Large operation: {} — proceed with caution.",
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
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let whitelist = get_whitelist();
    let mut errors = Vec::new();
    let mut validated_paths = Vec::new();
    let mut total_size = 0u64;

    // Phase 1: Validate all paths
    for path_str in paths {
        if path_str.starts_with("::") {
            validated_paths.push(path_str);
        } else {
            match validate_path(&path_str, &whitelist) {
                Ok(canonical) => {
                    total_size += calculate_dir_size(Path::new(&canonical));
                    validated_paths.push(canonical.display().to_string());
                }
                Err(e) => errors.push(format!("Validation failed for {}: {}", path_str, e)),
            }
        }
    }

    if total_size > MAX_TOTAL_SIZE {
        return Err(anyhow::anyhow!(
            "Operation too large: {} exceeds the 50 GB safety limit. Please select fewer items.",
            format_size(total_size)
        ));
    }

    // Phase 2: Count files for accurate progress reporting
    let total_files = Arc::new(AtomicU64::new(0));
    let files_processed = Arc::new(AtomicU64::new(0));
    let bytes_freed = Arc::new(AtomicU64::new(0));

    for p in &validated_paths {
        if !p.starts_with("::") {
            total_files.fetch_add(count_files(Path::new(p)), Ordering::Relaxed);
        }
    }

    // Phase 3: Execute
    let results: Vec<_> = validated_paths
        .into_iter()
        .map(|path_str| {
            if CANCEL_FLAG.load(Ordering::Relaxed) {
                return (0u64, 0u64, vec!["Operation cancelled".to_string()]);
            }

            // Route virtual commands to their specific handlers
            match path_str.as_str() {
                "::DNS_CACHE::" => {
                    return virtual_result(
                        flush_dns(),
                        app_handle,
                        &files_processed,
                        &total_files,
                        &bytes_freed,
                        "Flushing DNS cache",
                    );
                }
                "::CLIPBOARD::" => {
                    return virtual_result(
                        clear_clipboard(),
                        app_handle,
                        &files_processed,
                        &total_files,
                        &bytes_freed,
                        "Clearing clipboard",
                    );
                }
                "::CLEAR_BASH_HISTORY::" => {
                    return virtual_result(
                        clear_shell_history("bash"),
                        app_handle,
                        &files_processed,
                        &total_files,
                        &bytes_freed,
                        "Clearing bash history",
                    );
                }
                "::CLEAR_ZSH_HISTORY::" => {
                    return virtual_result(
                        clear_shell_history("zsh"),
                        app_handle,
                        &files_processed,
                        &total_files,
                        &bytes_freed,
                        "Clearing zsh history",
                    );
                }
                "::RECYCLE_BIN::" => {
                    return virtual_result(
                        empty_recycle_bin(),
                        app_handle,
                        &files_processed,
                        &total_files,
                        &bytes_freed,
                        "Emptying Recycle Bin",
                    );
                }
                "::TRASH::" => {
                    return virtual_result(
                        empty_trash(),
                        app_handle,
                        &files_processed,
                        &total_files,
                        &bytes_freed,
                        "Emptying Trash",
                    );
                }
                "::WINDOWS_THUMBNAIL_CACHE::" => {
                    return match clean_thumbnail_cache() {
                        Ok(freed) => {
                            bytes_freed.fetch_add(freed, Ordering::Relaxed);
                            emit_progress(
                                app_handle,
                                files_processed.load(Ordering::Relaxed),
                                total_files.load(Ordering::Relaxed),
                                bytes_freed.load(Ordering::Relaxed),
                                "Cleaning thumbnail cache".to_string(),
                            );
                            (freed, 0, vec![])
                        }
                        Err(e) => (0, 0, vec![e]),
                    };
                }
                _ => {} // Fall through to standard file deletion
            }

            clean_single_path(
                &path_str,
                app_handle,
                &files_processed,
                &total_files,
                &bytes_freed,
            )
        })
        .collect();

    // Phase 4: Aggregate results
    let mut total_bytes_freed = 0u64;
    let mut total_files_deleted = 0u64;
    for (bytes, files, errs) in results {
        total_bytes_freed += bytes;
        total_files_deleted += files;
        errors.extend(errs);
    }

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

/// Helper to cleanly handle virtual command results and emit progress.
fn virtual_result<R: tauri::Runtime>(
    result: Result<(), String>,
    app_handle: &tauri::AppHandle<R>,
    files_processed: &Arc<AtomicU64>,
    total_files: &Arc<AtomicU64>,
    bytes_freed: &Arc<AtomicU64>,
    label: &str,
) -> (u64, u64, Vec<String>) {
    match result {
        Ok(_) => {
            emit_progress(
                app_handle,
                files_processed.load(Ordering::Relaxed),
                total_files.load(Ordering::Relaxed),
                bytes_freed.load(Ordering::Relaxed),
                label.to_string(),
            );
            (0, 0, vec![])
        }
        Err(e) => (0, 0, vec![e]),
    }
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
            fs::symlink_metadata(e.path())
                .map(|m| !m.file_type().is_symlink() && m.is_file())
                .unwrap_or(false)
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
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                if CANCEL_FLAG.load(Ordering::Relaxed) {
                    break;
                }
                let p = entry.path();
                if let Ok(m) = fs::symlink_metadata(&p) {
                    if m.file_type().is_symlink() {
                        continue;
                    }
                    emit_progress(
                        app_handle,
                        files_processed.load(Ordering::Relaxed),
                        total_files.load(Ordering::Relaxed),
                        bytes_freed.load(Ordering::Relaxed),
                        p.display().to_string(),
                    );
                    if p.is_dir() {
                        let size = calculate_dir_size(&p);
                        match fs::remove_dir_all(&p) {
                            Ok(_) => {
                                local_freed += size;
                                local_files += 1;
                                files_processed.fetch_add(1, Ordering::Relaxed);
                                bytes_freed.fetch_add(size, Ordering::Relaxed);
                            }
                            Err(e) => local_errors.push(format!(
                                "Failed to delete {}: {}",
                                p.display(),
                                e
                            )),
                        }
                    } else if m.is_file() {
                        let size = m.len();
                        match fs::remove_file(&p) {
                            Ok(_) => {
                                local_freed += size;
                                local_files += 1;
                                files_processed.fetch_add(1, Ordering::Relaxed);
                                bytes_freed.fetch_add(size, Ordering::Relaxed);
                            }
                            Err(e) => local_errors.push(format!(
                                "Failed to delete {}: {}",
                                p.display(),
                                e
                            )),
                        }
                    }
                }
            }
        }
    } else if path.is_file() {
        if let Ok(m) = fs::symlink_metadata(path) {
            if !m.file_type().is_symlink() {
                let size = m.len();
                match fs::remove_file(path) {
                    Ok(_) => {
                        local_freed += size;
                        local_files += 1;
                        files_processed.fetch_add(1, Ordering::Relaxed);
                        bytes_freed.fetch_add(size, Ordering::Relaxed);
                    }
                    Err(e) => {
                        local_errors.push(format!("Failed to delete {}: {}", path.display(), e))
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
        ((files_processed as f64 / total_files as f64) * 100.0).min(100.0) as u8
    } else {
        100
    };
    let _ = app_handle.emit(
        "clean-progress",
        CleanProgress {
            files_processed,
            total_files,
            bytes_freed,
            current_file,
            percentage,
        },
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// CANCELLATION
// ═══════════════════════════════════════════════════════════════════════════

pub fn cancel_cleaning() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

fn flush_dns() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("ipconfig")
            .arg("/flushdns")
            .output()
            .map_err(|e| format!("Failed to flush DNS: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("killall")
            .args(["-HUP", "mDNSResponder"])
            .output()
            .map_err(|e| format!("Failed to flush DNS: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        if std::process::Command::new("resolvectl")
            .arg("flush-caches")
            .output()
            .is_err()
        {
            let _ = std::process::Command::new("systemctl")
                .args(["restart", "systemd-resolved"])
                .output();
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("DNS flush not supported on this platform".to_string())
}

fn clear_clipboard() -> Result<(), String> {
    #[cfg(feature = "clipboard")]
    {
        use arboard::Clipboard;
        let mut cb = Clipboard::new().map_err(|e| format!("Clipboard error: {}", e))?;
        cb.clear()
            .map_err(|e| format!("Failed to clear clipboard: {}", e))?;
        return Ok(());
    }
    #[cfg(not(feature = "clipboard"))]
    {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(["/C", "echo off | clip"])
                .output()
                .map_err(|e| format!("Failed to clear clipboard: {}", e))?;
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("pbcopy")
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|e| format!("Failed to clear clipboard: {}", e))?;
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            if std::process::Command::new("xsel")
                .arg("-bc")
                .output()
                .is_err()
            {
                std::process::Command::new("xclip")
                    .args(["-selection", "clipboard", "-i"])
                    .stdin(std::process::Stdio::null())
                    .output()
                    .map_err(|e| format!("Failed to clear clipboard: {}", e))?;
            }
            Ok(())
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        Err("Clipboard clear not supported on this platform".to_string())
    }
}

/// Truncates the shell history file to zero bytes (safer than deleting).
fn clear_shell_history(shell: &str) -> Result<(), String> {
    let base_dirs = BaseDirs::new().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let history_path = match shell {
        "bash" => base_dirs.home_dir().join(".bash_history"),
        "zsh" => base_dirs.home_dir().join(".zsh_history"),
        _ => return Err(format!("Unknown shell: {}", shell)),
    };
    if !history_path.exists() {
        return Ok(());
    }
    std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&history_path)
        .map_err(|e| format!("Failed to clear {} history: {}", shell, e))?;
    Ok(())
}

fn empty_recycle_bin() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Clear-RecycleBin -Force -ErrorAction SilentlyContinue",
            ])
            .output()
            .map_err(|e| format!("Failed to empty Recycle Bin: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    Err("Recycle Bin is a Windows-only feature".to_string())
}

fn empty_trash() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("osascript")
            .args(["-e", "tell application \"Finder\" to empty trash"])
            .output()
            .map_err(|e| format!("Failed to empty Trash: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(base_dirs) = BaseDirs::new() {
            let trash = base_dirs.home_dir().join(".local/share/Trash");
            for sub in &["files", "info"] {
                let dir = trash.join(sub);
                if dir.exists() {
                    if let Ok(entries) = fs::read_dir(&dir) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.is_dir() {
                                let _ = fs::remove_dir_all(&p);
                            } else {
                                let _ = fs::remove_file(&p);
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err("Trash empty not supported on this platform".to_string())
}

/// Cleans only thumbcache_*.db and iconcache_*.db files from the Explorer directory.
/// Uses a targeted approach to avoid deleting unrelated Explorer state files.
fn clean_thumbnail_cache() -> Result<u64, String> {
    #[cfg(target_os = "windows")]
    {
        let base_dirs =
            BaseDirs::new().ok_or_else(|| "Cannot determine LocalAppData".to_string())?;
        let dir = base_dirs
            .data_local_dir()
            .join("Microsoft/Windows/Explorer");
        if !dir.exists() {
            return Ok(0);
        }
        let mut freed = 0u64;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if (name.starts_with("thumbcache_") || name.starts_with("iconcache_"))
                        && name.ends_with(".db")
                    {
                        if let Ok(meta) = fs::metadata(&p) {
                            freed += meta.len();
                        }
                        let _ = fs::remove_file(&p);
                    }
                }
            }
        }
        Ok(freed)
    }
    #[cfg(not(target_os = "windows"))]
    Ok(0)
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

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn create_temp_target(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("qre_system_cleaner_tests");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::File::create(&path)
            .unwrap()
            .write_all(b"junk data")
            .unwrap();
        path
    }

    #[test]
    fn test_validate_path_virtual_commands_allowed() {
        let wl = get_whitelist();
        for cmd in &[
            "::DNS_CACHE::",
            "::CLIPBOARD::",
            "::RECYCLE_BIN::",
            "::TRASH::",
            "::CLEAR_BASH_HISTORY::",
            "::CLEAR_ZSH_HISTORY::",
            "::WINDOWS_THUMBNAIL_CACHE::",
        ] {
            assert!(
                validate_path(cmd, &wl).is_ok(),
                "Virtual command {} should be allowed",
                cmd
            );
        }
    }

    #[test]
    fn test_validate_path_rejects_missing_files() {
        let wl = get_whitelist();
        let r = validate_path("/path/that/definitely/does/not/exist/999", &wl);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("does not exist"));
    }

    #[test]
    fn test_validate_path_rejects_system_paths() {
        let wl = get_whitelist();
        #[cfg(target_os = "windows")]
        let dangerous = "C:\\Windows\\System32\\cmd.exe";
        #[cfg(not(target_os = "windows"))]
        let dangerous = "/bin/sh";
        if Path::new(dangerous).exists() {
            let r = validate_path(dangerous, &wl);
            assert!(r.is_err());
            assert!(r.unwrap_err().contains("not in whitelist"));
        }
    }

    #[test]
    fn test_validate_path_allows_whitelisted() {
        let wl = get_whitelist();
        let target = create_temp_target("safe.tmp");
        if wl.iter().any(|w| target.starts_with(w)) {
            assert!(validate_path(target.to_str().unwrap(), &wl).is_ok());
        }
        let _ = fs::remove_file(target);
    }

    #[test]
    fn test_elevation_required_field_present() {
        let targets = get_system_targets();
        // Confirm the field exists and virtual commands don't require elevation
        assert!(!targets
            .iter()
            .filter(|t| t.path.starts_with("::"))
            .any(|t| t.elevation_required));
    }

    #[test]
    fn test_format_size_logic() {
        assert_eq!(format_size(500), "500 bytes");
        assert_eq!(format_size(1024), "1.00 KB");
        assert_eq!(format_size(1536), "1.50 KB");
        assert_eq!(format_size(1024 * 1024), "1.00 MB");
        assert_eq!(format_size(1024 * 1024 * 1024), "1.00 GB");
        assert_eq!(format_size(50 * 1024 * 1024 * 1024), "50.00 GB");
    }

    #[test]
    fn test_count_files() {
        let dir = std::env::temp_dir().join("qre_count_tests");
        fs::create_dir_all(&dir).unwrap();
        fs::File::create(dir.join("1.txt")).unwrap();
        fs::File::create(dir.join("2.txt")).unwrap();
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::File::create(sub.join("3.txt")).unwrap();
        assert_eq!(count_files(&dir), 3);
        let _ = fs::remove_dir_all(dir);
    }
}
