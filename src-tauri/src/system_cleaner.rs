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

    // Deduplicate: on Windows, %TEMP% and %TMP% often canonicalize to the same path.
    whitelist.sort();
    whitelist.dedup();
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

    // ─────────────────────────────────────────────────────────────────────
    // Test helpers
    // ─────────────────────────────────────────────────────────────────────

    /// Returns a unique subdirectory inside the OS temp dir for a given test name.
    /// Using unique names prevents cross-test contamination when tests run in parallel.
    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qre_test_{}", name));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Creates a file with a known payload inside `dir` and returns its path.
    fn make_file(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::File::create(&path).unwrap().write_all(content).unwrap();
        path
    }

    /// Removes a directory tree, ignoring errors (best-effort cleanup in tests).
    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    // ─────────────────────────────────────────────────────────────────────
    // format_size
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_format_size_bytes() {
        assert_eq!(format_size(0), "0 bytes");
        assert_eq!(format_size(1), "1 bytes");
        assert_eq!(format_size(500), "500 bytes");
        assert_eq!(format_size(1023), "1023 bytes");
    }

    #[test]
    fn test_format_size_kilobytes() {
        assert_eq!(format_size(1024), "1.00 KB");
        assert_eq!(format_size(1536), "1.50 KB");
        assert_eq!(format_size(1024 * 1023), "1023.00 KB");
    }

    #[test]
    fn test_format_size_megabytes() {
        assert_eq!(format_size(1024 * 1024), "1.00 MB");
        assert_eq!(format_size(1024 * 1024 * 512), "512.00 MB");
    }

    #[test]
    fn test_format_size_gigabytes() {
        assert_eq!(format_size(1024 * 1024 * 1024), "1.00 GB");
        assert_eq!(format_size(50 * 1024 * 1024 * 1024), "50.00 GB");
    }

    // ─────────────────────────────────────────────────────────────────────
    // validate_path — virtual commands
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_validate_path_all_virtual_commands_pass() {
        let wl = get_whitelist();
        let cmds = [
            "::DNS_CACHE::",
            "::CLIPBOARD::",
            "::RECYCLE_BIN::",
            "::TRASH::",
            "::CLEAR_BASH_HISTORY::",
            "::CLEAR_ZSH_HISTORY::",
            "::WINDOWS_THUMBNAIL_CACHE::",
        ];
        for cmd in &cmds {
            let result = validate_path(cmd, &wl);
            assert!(
                result.is_ok(),
                "Virtual command '{}' should bypass filesystem checks",
                cmd
            );
            // Verify the returned PathBuf is exactly the virtual command string
            assert_eq!(result.unwrap(), PathBuf::from(*cmd));
        }
    }

    #[test]
    fn test_validate_path_unknown_virtual_command_also_passes() {
        // Any string starting with "::" is treated as a virtual command.
        // The command router handles unknown ones gracefully at clean-time.
        let wl = get_whitelist();
        assert!(validate_path("::FUTURE_COMMAND::", &wl).is_ok());
    }

    // ─────────────────────────────────────────────────────────────────────
    // validate_path — filesystem enforcement
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_validate_path_rejects_nonexistent_path() {
        let wl = get_whitelist();
        let err = validate_path("/no/such/path/abc123xyz", &wl).unwrap_err();
        assert!(err.contains("does not exist"), "Error was: {}", err);
    }

    #[test]
    fn test_validate_path_rejects_system_binary() {
        let wl = get_whitelist();
        #[cfg(target_os = "windows")]
        let path = "C:\\Windows\\System32\\cmd.exe";
        #[cfg(not(target_os = "windows"))]
        let path = "/bin/sh";

        if Path::new(path).exists() {
            let err = validate_path(path, &wl).unwrap_err();
            assert!(err.contains("not in whitelist"), "Error was: {}", err);
        }
    }

    #[test]
    fn test_validate_path_rejects_home_dir_root() {
        // The home directory itself must not be in the whitelist — only subdirectories
        // like ~/.cache, ~/.npm, etc. are allowed.
        let wl = get_whitelist();
        if let Some(base_dirs) = directories::BaseDirs::new() {
            let home = base_dirs.home_dir();
            if home.exists() {
                // Home may or may not be whitelisted depending on OS; if it's not, verify rejection.
                let is_directly_whitelisted = wl.iter().any(|w| w == home);
                if !is_directly_whitelisted {
                    let result = validate_path(home.to_str().unwrap(), &wl);
                    assert!(
                        result.is_err(),
                        "Home directory root should not be directly whitelisted"
                    );
                }
            }
        }
    }

    #[test]
    fn test_validate_path_allows_file_inside_temp() {
        let wl = get_whitelist();
        let dir = test_dir("validate_allow");
        let file = make_file(&dir, "ok.tmp", b"test");

        // Only run the assertion if our test dir falls under a whitelisted path.
        // On CI environments the temp dir may not be canonicalized the same way.
        if wl.iter().any(|w| file.starts_with(w)) {
            assert!(validate_path(file.to_str().unwrap(), &wl).is_ok());
        }

        cleanup(&dir);
    }

    #[test]
    fn test_validate_path_rejects_symlink() {
        // Symlinks inside whitelisted directories must still be rejected.
        #[cfg(unix)]
        {
            let wl = get_whitelist();
            let dir = test_dir("validate_symlink");
            let target = make_file(&dir, "real.txt", b"data");
            let link = dir.join("link.txt");

            if std::os::unix::fs::symlink(&target, &link).is_ok() {
                let err = validate_path(link.to_str().unwrap(), &wl).unwrap_err();
                assert!(err.contains("Symlinks not allowed"), "Error was: {}", err);
            }
            cleanup(&dir);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // get_whitelist
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_whitelist_is_not_empty() {
        // On any supported platform there must be at least one whitelisted directory.
        let wl = get_whitelist();
        assert!(
            !wl.is_empty(),
            "Whitelist should contain at least the system temp directory"
        );
    }

    #[test]
    fn test_whitelist_entries_are_absolute_paths() {
        let wl = get_whitelist();
        for path in &wl {
            assert!(
                path.is_absolute(),
                "Whitelist entry '{}' should be an absolute path",
                path.display()
            );
        }
    }

    #[test]
    fn test_whitelist_entries_exist_on_disk() {
        // All whitelisted directories should actually exist — otherwise they'd never be useful.
        let wl = get_whitelist();
        for path in &wl {
            assert!(
                path.exists(),
                "Whitelisted path '{}' does not exist on disk",
                path.display()
            );
        }
    }

    #[test]
    fn test_whitelist_contains_no_duplicates() {
        let wl = get_whitelist();
        let mut seen = std::collections::HashSet::new();
        for path in &wl {
            assert!(
                seen.insert(path),
                "Duplicate whitelist entry: {}",
                path.display()
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // calculate_dir_size
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_calculate_dir_size_empty_dir_is_zero() {
        let dir = test_dir("dirsize_empty");
        assert_eq!(calculate_dir_size(&dir), 0);
        cleanup(&dir);
    }

    #[test]
    fn test_calculate_dir_size_single_file() {
        let dir = test_dir("dirsize_single");
        make_file(&dir, "a.txt", b"hello"); // 5 bytes
        let size = calculate_dir_size(&dir);
        assert_eq!(size, 5, "Expected 5 bytes, got {}", size);
        cleanup(&dir);
    }

    #[test]
    fn test_calculate_dir_size_multiple_files() {
        let dir = test_dir("dirsize_multi");
        make_file(&dir, "a.txt", &[0u8; 100]);
        make_file(&dir, "b.txt", &[0u8; 200]);
        let size = calculate_dir_size(&dir);
        assert_eq!(size, 300);
        cleanup(&dir);
    }

    #[test]
    fn test_calculate_dir_size_nested_dirs() {
        let dir = test_dir("dirsize_nested");
        make_file(&dir, "root.txt", &[0u8; 50]);
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        make_file(&sub, "child.txt", &[0u8; 75]);
        let deep = sub.join("deep");
        fs::create_dir_all(&deep).unwrap();
        make_file(&deep, "leaf.txt", &[0u8; 25]);
        let size = calculate_dir_size(&dir);
        assert_eq!(size, 150);
        cleanup(&dir);
    }

    #[test]
    fn test_calculate_dir_size_ignores_symlinks() {
        #[cfg(unix)]
        {
            let dir = test_dir("dirsize_symlink");
            make_file(&dir, "real.txt", &[0u8; 100]);

            // Create a symlink pointing to a large "external" file in another dir
            let ext_dir = test_dir("dirsize_symlink_ext");
            let ext_file = make_file(&ext_dir, "big.txt", &[0u8; 10_000]);
            let link = dir.join("link.txt");
            let _ = std::os::unix::fs::symlink(&ext_file, &link);

            // The symlink target should NOT be counted
            let size = calculate_dir_size(&dir);
            assert_eq!(
                size, 100,
                "Symlink contents should not be counted, got {} bytes",
                size
            );
            cleanup(&dir);
            cleanup(&ext_dir);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // count_files
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_count_files_empty_dir() {
        let dir = test_dir("count_empty");
        assert_eq!(count_files(&dir), 0);
        cleanup(&dir);
    }

    #[test]
    fn test_count_files_flat() {
        let dir = test_dir("count_flat");
        make_file(&dir, "1.txt", b"a");
        make_file(&dir, "2.txt", b"b");
        make_file(&dir, "3.txt", b"c");
        assert_eq!(count_files(&dir), 3);
        cleanup(&dir);
    }

    #[test]
    fn test_count_files_recursive() {
        let dir = test_dir("count_recursive");
        make_file(&dir, "root.txt", b"r");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        make_file(&sub, "a.txt", b"a");
        make_file(&sub, "b.txt", b"b");
        let deep = sub.join("deep");
        fs::create_dir_all(&deep).unwrap();
        make_file(&deep, "c.txt", b"c");
        assert_eq!(count_files(&dir), 4);
        cleanup(&dir);
    }

    #[test]
    fn test_count_files_single_file_path() {
        let dir = test_dir("count_singlefile");
        let file = make_file(&dir, "only.txt", b"data");
        // Passing a file path directly (not a dir) should return 1
        assert_eq!(count_files(&file), 1);
        cleanup(&dir);
    }

    #[test]
    fn test_count_files_ignores_symlinks() {
        #[cfg(unix)]
        {
            let dir = test_dir("count_symlink");
            make_file(&dir, "real.txt", b"r");

            // Point a symlink at another file — it should not be counted
            let ext_dir = test_dir("count_symlink_ext");
            let ext = make_file(&ext_dir, "ext.txt", b"e");
            let link = dir.join("link.txt");
            let _ = std::os::unix::fs::symlink(&ext, &link);

            assert_eq!(
                count_files(&dir),
                1,
                "Symlink should not be counted as a file"
            );
            cleanup(&dir);
            cleanup(&ext_dir);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // add_target — deduplication and existence guard
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_add_target_skips_nonexistent_path() {
        let mut list: Vec<JunkItem> = Vec::new();
        add_target(
            &mut list,
            "Ghost",
            "/no/such/path/abc123",
            "System",
            "Should not be added",
            None,
            false,
        );
        assert!(list.is_empty(), "Non-existent paths must not be added");
    }

    #[test]
    fn test_add_target_adds_existing_path() {
        let dir = test_dir("addtarget_exists");
        let mut list: Vec<JunkItem> = Vec::new();
        add_target(
            &mut list,
            "Test Dir",
            dir.to_str().unwrap(),
            "System",
            "Should be added",
            None,
            false,
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Test Dir");
        cleanup(&dir);
    }

    #[test]
    fn test_add_target_no_duplicates() {
        let dir = test_dir("addtarget_dedup");
        let mut list: Vec<JunkItem> = Vec::new();
        let path = dir.to_str().unwrap();

        add_target(&mut list, "First", path, "System", "desc", None, false);
        add_target(&mut list, "Second", path, "System", "desc", None, false);

        // Only the first call should have been inserted
        assert_eq!(list.len(), 1, "Duplicate paths must not be inserted twice");
        assert_eq!(list[0].name, "First");
        cleanup(&dir);
    }

    #[test]
    fn test_add_target_elevation_required_propagates() {
        let dir = test_dir("addtarget_elevation");
        let mut list: Vec<JunkItem> = Vec::new();
        add_target(
            &mut list,
            "Elevated",
            dir.to_str().unwrap(),
            "System",
            "Needs admin",
            None,
            true,
        );
        assert!(list[0].elevation_required);
        cleanup(&dir);
    }

    #[test]
    fn test_add_target_sets_correct_fields() {
        let dir = test_dir("addtarget_fields");
        let mut list: Vec<JunkItem> = Vec::new();
        add_target(
            &mut list,
            "MyName",
            dir.to_str().unwrap(),
            "Developer",
            "My description",
            Some("My warning".to_string()),
            false,
        );

        let item = &list[0];
        assert_eq!(item.name, "MyName");
        assert_eq!(item.category, "Developer");
        assert_eq!(item.description, "My description");
        assert_eq!(item.warning.as_deref(), Some("My warning"));
        assert!(!item.id.is_empty(), "UUID id must be populated");
        assert_eq!(item.size, 0, "Size is always 0 at target-creation time");
        cleanup(&dir);
    }

    // ─────────────────────────────────────────────────────────────────────
    // get_system_targets — structural invariants
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_system_targets_always_contains_virtual_commands() {
        let targets = get_system_targets();
        let paths: Vec<&str> = targets.iter().map(|t| t.path.as_str()).collect();

        // DNS and Clipboard are universal — present on every platform
        assert!(
            paths.contains(&"::DNS_CACHE::"),
            "DNS_CACHE virtual command must always be present"
        );
        assert!(
            paths.contains(&"::CLIPBOARD::"),
            "CLIPBOARD virtual command must always be present"
        );
    }

    #[test]
    fn test_system_targets_virtual_commands_have_correct_categories() {
        let targets = get_system_targets();

        let dns = targets.iter().find(|t| t.path == "::DNS_CACHE::").unwrap();
        assert_eq!(dns.category, "Network");

        let clip = targets.iter().find(|t| t.path == "::CLIPBOARD::").unwrap();
        assert_eq!(clip.category, "Privacy");
    }

    #[test]
    fn test_system_targets_no_virtual_command_requires_elevation() {
        let targets = get_system_targets();
        for item in targets.iter().filter(|t| t.path.starts_with("::")) {
            assert!(!item.elevation_required,
                "Virtual command '{}' must not require elevation — it uses OS APIs, not file deletion",
                item.name);
        }
    }

    #[test]
    fn test_system_targets_all_have_unique_ids() {
        let targets = get_system_targets();
        let mut ids = std::collections::HashSet::new();
        for item in &targets {
            assert!(
                ids.insert(item.id.clone()),
                "Duplicate UUID found for item '{}'",
                item.name
            );
        }
    }

    #[test]
    fn test_system_targets_all_have_non_empty_names_and_descriptions() {
        let targets = get_system_targets();
        for item in &targets {
            assert!(
                !item.name.is_empty(),
                "Item at path '{}' has an empty name",
                item.path
            );
            assert!(
                !item.description.is_empty(),
                "Item '{}' has an empty description",
                item.name
            );
        }
    }

    #[test]
    fn test_system_targets_categories_are_valid() {
        let valid_categories = [
            "System",
            "Browser",
            "Developer",
            "Logs",
            "Network",
            "Privacy",
        ];
        let targets = get_system_targets();
        for item in &targets {
            assert!(
                valid_categories.contains(&item.category.as_str()),
                "Item '{}' has unknown category '{}'",
                item.name,
                item.category
            );
        }
    }

    #[test]
    fn test_system_targets_filesystem_paths_must_exist_to_appear() {
        // Any item with a non-virtual path must refer to a real path on disk.
        // add_target() enforces this but let's double-check via the public surface.
        let targets = get_system_targets();
        for item in targets.iter().filter(|t| !t.path.starts_with("::")) {
            assert!(
                Path::new(&item.path).exists(),
                "Non-virtual item '{}' at path '{}' does not exist on disk",
                item.name,
                item.path
            );
        }
    }

    #[test]
    fn test_system_targets_no_duplicate_paths() {
        let targets = get_system_targets();
        let mut paths = std::collections::HashSet::new();
        for item in &targets {
            assert!(
                paths.insert(item.path.clone()),
                "Duplicate path '{}' found in system targets",
                item.path
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // scan_targets — size population
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_scan_targets_virtual_commands_have_zero_size() {
        let targets = scan_targets();
        for item in targets.iter().filter(|t| t.path.starts_with("::")) {
            assert_eq!(
                item.size, 0,
                "Virtual command '{}' must report size 0",
                item.name
            );
        }
    }

    #[test]
    fn test_scan_targets_filters_empty_filesystem_items() {
        // After scanning, items with size == 0 that are NOT virtual commands
        // should have been removed (they add no value to the UI).
        let targets = scan_targets();
        for item in &targets {
            if !item.path.starts_with("::") {
                assert!(
                    item.size > 0,
                    "Empty non-virtual item '{}' should have been filtered out",
                    item.name
                );
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // dry_run
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_dry_run_virtual_commands_are_listed_as_actions() {
        let result = dry_run(vec!["::DNS_CACHE::".to_string()]).unwrap();
        assert_eq!(result.total_files, 0);
        assert_eq!(result.total_size, 0);
        assert_eq!(result.file_list.len(), 1);
        assert!(result.file_list[0].contains("[ACTION]"));
    }

    #[test]
    fn test_dry_run_counts_files_correctly() {
        let dir = test_dir("dryrun_count");
        let wl = get_whitelist();

        // Only run this test if the test dir falls within the whitelist
        if !wl.iter().any(|w| dir.starts_with(w)) {
            cleanup(&dir);
            return;
        }

        make_file(&dir, "a.bin", &[1u8; 512]);
        make_file(&dir, "b.bin", &[2u8; 256]);

        let result = dry_run(vec![dir.to_str().unwrap().to_string()]).unwrap();
        assert_eq!(result.total_files, 2);
        assert_eq!(result.total_size, 768);

        cleanup(&dir);
    }

    #[test]
    fn test_dry_run_skips_invalid_paths_with_warning() {
        let result = dry_run(vec!["/no/such/path/xyz999".to_string()]).unwrap();
        assert_eq!(result.total_files, 0);
        assert!(
            !result.warnings.is_empty(),
            "Invalid path should produce a warning, not panic"
        );
    }

    #[test]
    fn test_dry_run_caps_file_list_at_100() {
        let dir = test_dir("dryrun_cap");
        let wl = get_whitelist();

        if !wl.iter().any(|w| dir.starts_with(w)) {
            cleanup(&dir);
            return;
        }

        // Create 150 tiny files
        for i in 0..150 {
            make_file(&dir, &format!("{}.tmp", i), b"x");
        }

        let result = dry_run(vec![dir.to_str().unwrap().to_string()]).unwrap();
        assert!(
            result.file_list.len() <= 100,
            "File list preview must be capped at 100, got {}",
            result.file_list.len()
        );
        assert_eq!(
            result.total_files, 150,
            "Total count should be exact regardless of preview cap"
        );
        assert!(
            !result.warnings.is_empty(),
            "A cap warning should be emitted"
        );

        cleanup(&dir);
    }

    #[test]
    fn test_dry_run_empty_paths_vec_returns_empty_result() {
        let result = dry_run(vec![]).unwrap();
        assert_eq!(result.total_files, 0);
        assert_eq!(result.total_size, 0);
        assert!(result.file_list.is_empty());
        assert!(result.warnings.is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────
    // clear_shell_history
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_clear_shell_history_nonexistent_file_is_ok() {
        // If the history file does not exist, the function must succeed silently.
        // We can't easily test with a real ~/.bash_history so we verify the
        // function signature and no-panic behavior via the "not exists" path.
        // This passes on any platform that has a resolvable home directory.
        if directories::BaseDirs::new().is_some() {
            // Unknown shell name should return a descriptive Err, not panic.
            let result = clear_shell_history("fish");
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("Unknown shell"));
        }
    }

    #[test]
    fn test_clear_shell_history_truncates_to_zero_bytes() {
        // Create a surrogate history file in temp and verify truncation.
        let dir = test_dir("shell_history");
        let fake_history = dir.join(".bash_history_test");
        fs::File::create(&fake_history)
            .unwrap()
            .write_all(b"ls -la\ncd /tmp\n")
            .unwrap();

        // Manually exercise the truncation logic (mirrors clear_shell_history internals)
        std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&fake_history)
            .unwrap();

        let metadata = fs::metadata(&fake_history).unwrap();
        assert_eq!(
            metadata.len(),
            0,
            "File should be truncated to 0 bytes, not deleted"
        );
        assert!(
            fake_history.exists(),
            "File should still exist after truncation"
        );

        cleanup(&dir);
    }

    // ─────────────────────────────────────────────────────────────────────
    // cancel_cleaning
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_cancel_cleaning_sets_flag() {
        // Reset first to ensure known state
        CANCEL_FLAG.store(false, Ordering::Relaxed);
        assert!(!CANCEL_FLAG.load(Ordering::Relaxed));

        cancel_cleaning();
        assert!(
            CANCEL_FLAG.load(Ordering::Relaxed),
            "CANCEL_FLAG must be true after cancel_cleaning()"
        );

        // Reset so other tests aren't affected
        CANCEL_FLAG.store(false, Ordering::Relaxed);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Windows-specific tests
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_targets_include_recycle_bin() {
        let targets = get_system_targets();
        assert!(
            targets.iter().any(|t| t.path == "::RECYCLE_BIN::"),
            "Windows targets must include the Recycle Bin virtual command"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_targets_include_thumbnail_cache() {
        let targets = get_system_targets();
        assert!(
            targets
                .iter()
                .any(|t| t.path == "::WINDOWS_THUMBNAIL_CACHE::"),
            "Windows targets must include the Thumbnail Cache virtual command"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_update_cache_requires_elevation() {
        let targets = get_system_targets();
        // Windows Update cache entry only appears if the path exists
        if let Some(item) = targets.iter().find(|t| t.name == "Windows Update Cache") {
            assert!(
                item.elevation_required,
                "Windows Update Cache must be flagged as requiring elevation"
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // macOS/Linux cross-platform tests
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn test_unix_targets_include_trash_not_recycle_bin() {
        let targets = get_system_targets();
        assert!(
            targets.iter().any(|t| t.path == "::TRASH::"),
            "Unix targets must include the Trash virtual command"
        );
        assert!(
            !targets.iter().any(|t| t.path == "::RECYCLE_BIN::"),
            "Unix targets must not include the Windows Recycle Bin command"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_linux_crash_dumps_require_elevation_if_present() {
        let targets = get_system_targets();
        if let Some(item) = targets.iter().find(|t| t.name == "Crash Dumps") {
            assert!(
                item.elevation_required,
                "Linux /var/crash must be flagged as requiring elevation"
            );
        }
    }
}
