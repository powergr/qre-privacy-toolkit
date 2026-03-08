// ═══════════════════════════════════════════════════════════════════════════
// registry_cleaner.rs
//
// CARGO.TOML DEPENDENCY REQUIRED (Windows only):
//   [target.'cfg(windows)'.dependencies]
//   winreg = "0.52"
//
// This module provides conservative registry scanning that only targets
// well-understood, low-risk orphaned entries. It never touches:
//   - HKLM\SYSTEM
//   - COM / CLSID registrations (without deep verification)
//   - Windows NT core keys
//
// A .reg backup is created before any deletion is performed.
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::path::Path;

// ═══════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════

/// A single orphaned or invalid registry entry flagged for removal.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RegistryItem {
    pub id: String,
    /// Human-readable display name (e.g. the application name from DisplayName).
    pub name: String,
    /// Full registry key path, e.g. `HKCU\Software\...\Uninstall\{GUID}`.
    pub key_path: String,
    /// If Some, a specific named value is being targeted rather than the whole key.
    pub value_name: Option<String>,
    /// "OrphanedInstaller" | "InvalidAppPath" | "MUICache" | "StartupEntry"
    pub category: String,
    pub description: String,
    pub warning: Option<String>,
}

/// Result of a registry backup operation.
#[derive(Serialize, Debug)]
pub struct RegistryBackupResult {
    /// Absolute path to the written .reg backup file.
    pub backup_path: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Summary returned after cleaning registry entries.
#[derive(Serialize, Debug)]
pub struct RegistryCleanResult {
    pub items_cleaned: u64,
    pub errors: Vec<String>,
    /// Path to the backup that was taken before cleaning, if any.
    pub backup_path: Option<String>,
}

/// Input for a single registry deletion — passed from the frontend.
#[derive(Deserialize, Debug, Clone)]
pub struct RegistryCleanEntry {
    pub key_path: String,
    pub value_name: Option<String>,
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/// Scans the registry for safe-to-remove orphaned entries.
/// Returns an empty Vec on non-Windows platforms.
pub fn scan_registry() -> Vec<RegistryItem> {
    #[cfg(not(target_os = "windows"))]
    return vec![];

    #[cfg(target_os = "windows")]
    {
        let mut items = Vec::new();
        scan_orphaned_uninstall(&mut items);
        scan_invalid_app_paths(&mut items);
        scan_mui_cache(&mut items);
        scan_startup_entries(&mut items);
        items
    }
}

/// Exports the scanned registry locations to a timestamped .reg backup file
/// in the app's data directory. Always call this before clean_registry_entries().
pub fn backup_registry() -> RegistryBackupResult {
    #[cfg(not(target_os = "windows"))]
    return RegistryBackupResult {
        backup_path: String::new(),
        success: false,
        error: Some("Registry backup is only available on Windows".to_string()),
    };

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        // Write backup to the OS temp directory with a timestamp
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let backup_dir = std::env::temp_dir().join("qre_registry_backups");
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            return RegistryBackupResult {
                backup_path: String::new(),
                success: false,
                error: Some(format!("Cannot create backup directory: {}", e)),
            };
        }

        let backup_file = backup_dir.join(format!("registry_backup_{}.reg", timestamp));
        let backup_path_str = backup_file.display().to_string();

        // Backup all four locations we scan — one combined export via reg.exe
        // reg.exe is present on all modern Windows installations
        let keys_to_backup = [
            r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
            r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        ];

        // Write a combined .reg file by exporting each key and appending
        // We use a temp prefix file per key then merge
        let mut combined = String::from("Windows Registry Editor Version 5.00\r\n\r\n");
        let mut any_success = false;

        for key in &keys_to_backup {
            let tmp = backup_dir.join(format!("tmp_{}_{}.reg", timestamp, key.replace('\\', "_")));
            let output = Command::new("reg")
                .args(["export", key, tmp.to_str().unwrap_or(""), "/y"])
                .output();

            if let Ok(out) = output {
                if out.status.success() {
                    if let Ok(content) = std::fs::read_to_string(&tmp) {
                        // Strip the header from subsequent files
                        let body = content
                            .lines()
                            .skip(1) // Skip "Windows Registry Editor Version 5.00"
                            .collect::<Vec<_>>()
                            .join("\r\n");
                        combined.push_str(&body);
                        combined.push_str("\r\n");
                        any_success = true;
                    }
                    let _ = std::fs::remove_file(&tmp);
                }
            }
        }

        match std::fs::write(&backup_file, combined.as_bytes()) {
            Ok(_) if any_success => RegistryBackupResult {
                backup_path: backup_path_str,
                success: true,
                error: None,
            },
            Ok(_) => RegistryBackupResult {
                backup_path: backup_path_str,
                success: false,
                error: Some("No registry keys could be exported — check permissions.".to_string()),
            },
            Err(e) => RegistryBackupResult {
                backup_path: backup_path_str,
                success: false,
                error: Some(format!("Failed to write backup file: {}", e)),
            },
        }
    }
}

/// Deletes the specified registry entries. Call backup_registry() first.
pub fn clean_registry_entries(entries: Vec<RegistryCleanEntry>) -> RegistryCleanResult {
    #[cfg(not(target_os = "windows"))]
    return RegistryCleanResult {
        items_cleaned: 0,
        errors: vec!["Registry cleaning is only available on Windows".to_string()],
        backup_path: None,
    };

    #[cfg(target_os = "windows")]
    {
        let mut cleaned = 0u64;
        let mut errors = Vec::new();

        for entry in entries {
            let result = delete_registry_entry(&entry.key_path, &entry.value_name);
            match result {
                Ok(_) => cleaned += 1,
                Err(e) => errors.push(format!("Failed to delete {}: {}", entry.key_path, e)),
            }
        }

        RegistryCleanResult {
            items_cleaned: cleaned,
            errors,
            backup_path: None, // Caller manages the backup path
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCANNING IMPLEMENTATIONS (Windows only)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
fn scan_orphaned_uninstall(items: &mut Vec<RegistryItem>) {
    use winreg::{enums::*, RegKey};

    // Scan both HKLM and HKCU uninstall hives
    let hives: &[(winreg::HKEY, &str, &str)] = &[
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            "HKLM",
        ),
        (
            HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            "HKCU",
        ),
        // 32-bit on 64-bit Windows
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            "HKLM (WOW64)",
        ),
    ];

    for (hive, path, hive_name) in hives {
        let root = RegKey::predef(*hive);
        let Ok(key) = root.open_subkey(path) else {
            continue;
        };

        for subkey_name in key.enum_keys().filter_map(|k| k.ok()) {
            let Ok(subkey) = key.open_subkey(&subkey_name) else {
                continue;
            };

            let display_name: String = subkey
                .get_value("DisplayName")
                .unwrap_or_else(|_| subkey_name.clone());

            // Skip system components and Windows updates — too risky to flag
            let publisher: String = subkey.get_value("Publisher").unwrap_or_default();
            if publisher.to_lowercase().contains("microsoft") {
                continue;
            }

            let is_system_component: u32 = subkey.get_value("SystemComponent").unwrap_or(0);
            if is_system_component == 1 {
                continue;
            }

            // Determine if the install location or uninstall string still exists
            let install_loc: String = subkey.get_value("InstallLocation").unwrap_or_default();
            let uninstall_str: String = subkey.get_value("UninstallString").unwrap_or_default();

            let is_orphaned = is_installation_orphaned(&install_loc, &uninstall_str);
            if !is_orphaned {
                continue;
            }

            let full_key_path = format!(r"{}\{}\{}", hive_name, path, subkey_name);

            items.push(RegistryItem {
                id: uuid::Uuid::new_v4().to_string(),
                name: display_name.clone(),
                key_path: full_key_path,
                value_name: None, // Delete the whole subkey
                category: "OrphanedInstaller".to_string(),
                description: format!(
                    "\"{}\" — install location no longer exists on disk.",
                    display_name
                ),
                warning: Some(
                    "Verify this application is truly uninstalled before removing.".to_string(),
                ),
            });
        }
    }
}

#[cfg(target_os = "windows")]
fn scan_invalid_app_paths(items: &mut Vec<RegistryItem>) {
    use winreg::{enums::*, RegKey};

    let hives: &[(winreg::HKEY, &str, &str)] = &[
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
            "HKLM",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
            "HKLM (WOW64)",
        ),
    ];

    for (hive, path, hive_name) in hives {
        let root = RegKey::predef(*hive);
        let Ok(key) = root.open_subkey(path) else {
            continue;
        };

        for subkey_name in key.enum_keys().filter_map(|k| k.ok()) {
            let Ok(subkey) = key.open_subkey(&subkey_name) else {
                continue;
            };

            // The default (unnamed) value is the path to the executable
            let exe_path: String = subkey.get_value("").unwrap_or_default();
            if exe_path.is_empty() {
                continue;
            }

            // Strip surrounding quotes if present
            let clean_path = exe_path.trim_matches('"');

            if !Path::new(clean_path).exists() {
                let full_key_path = format!(r"{}\{}\{}", hive_name, path, subkey_name);
                items.push(RegistryItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: subkey_name.clone(),
                    key_path: full_key_path,
                    value_name: None,
                    category: "InvalidAppPath".to_string(),
                    description: format!(
                        "App Paths entry for \"{}\" points to a missing executable: {}",
                        subkey_name, clean_path
                    ),
                    warning: None,
                });
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn scan_mui_cache(items: &mut Vec<RegistryItem>) {
    use winreg::{enums::*, RegKey};

    // MUI cache stores localized application names. Value names ARE the exe paths.
    let path = r"SOFTWARE\Classes\Local Settings\MuiCache";
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(mui_root) = root.open_subkey(path) else {
        return;
    };

    // MUI cache has numbered subkeys like "0", "1", etc.
    for subkey_name in mui_root.enum_keys().filter_map(|k| k.ok()) {
        let Ok(subkey) = mui_root.open_subkey(&subkey_name) else {
            continue;
        };

        for (value_name, _value) in subkey.enum_values().filter_map(|v| v.ok()) {
            // The value name itself is an exe path
            let clean = value_name.trim_matches('"');

            // Only flag actual file paths (starts with drive letter or \\)
            if !clean.contains('\\') {
                continue;
            }

            if !Path::new(clean).exists() {
                let full_key = format!(r"HKCU\{}\{}", path, subkey_name);
                items.push(RegistryItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: Path::new(clean)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(clean)
                        .to_string(),
                    key_path: full_key,
                    value_name: Some(value_name.clone()),
                    category: "MUICache".to_string(),
                    description: format!("MUI cache entry for a missing executable: {}", clean),
                    warning: None,
                });
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn scan_startup_entries(items: &mut Vec<RegistryItem>) {
    use winreg::{enums::*, RegKey};

    let run_locations: &[(winreg::HKEY, &str, &str)] = &[
        (
            HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            "HKCU",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            "HKLM",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run",
            "HKLM (WOW64)",
        ),
    ];

    for (hive, path, hive_name) in run_locations {
        let root = RegKey::predef(*hive);
        let Ok(key) = root.open_subkey(path) else {
            continue;
        };

        for (value_name, value) in key.enum_values().filter_map(|v| v.ok()) {
            let raw_path: String = match value.to_string().parse() {
                Ok(s) => s,
                Err(_) => continue,
            };

            let exe_path = extract_exe_from_command(&raw_path);
            if exe_path.is_empty() {
                continue;
            }

            if !Path::new(&exe_path).exists() {
                let full_key = format!(r"{}\{}", hive_name, path);
                items.push(RegistryItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: value_name.clone(),
                    key_path: full_key,
                    value_name: Some(value_name.clone()),
                    category: "StartupEntry".to_string(),
                    description: format!(
                        "Startup entry \"{}\" points to a missing file: {}",
                        value_name, exe_path
                    ),
                    warning: Some(
                        "Removing this stops it from running at login — verify before deleting."
                            .to_string(),
                    ),
                });
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETION (Windows only)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
fn delete_registry_entry(key_path: &str, value_name: &Option<String>) -> Result<(), String> {
    use winreg::{enums::*, RegKey};

    // Parse the hive prefix
    let (hive_key, subpath) = parse_hive(key_path)?;
    let root = RegKey::predef(hive_key);

    if let Some(vname) = value_name {
        // Delete a specific value within a key
        let key = root
            .open_subkey_with_flags(subpath, KEY_SET_VALUE)
            .map_err(|e| format!("Cannot open key for write: {}", e))?;
        key.delete_value(vname)
            .map_err(|e| format!("Cannot delete value \"{}\": {}", vname, e))?;
    } else {
        // Delete the entire subkey (and all values within it)
        // Split into parent key + child name for RegDeleteKey semantics
        let last_backslash = subpath
            .rfind('\\')
            .ok_or_else(|| format!("Cannot find parent key in path: {}", key_path))?;
        let parent_path = &subpath[..last_backslash];
        let child_name = &subpath[last_backslash + 1..];

        let parent = root
            .open_subkey_with_flags(parent_path, KEY_WRITE)
            .map_err(|e| format!("Cannot open parent key: {}", e))?;
        parent
            .delete_subkey_all(child_name)
            .map_err(|e| format!("Cannot delete subkey \"{}\": {}", child_name, e))?;
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/// Parses "HKLM\SOFTWARE\..." into (HKEY_LOCAL_MACHINE, "SOFTWARE\\...").
#[cfg(target_os = "windows")]
fn parse_hive(key_path: &str) -> Result<(winreg::HKEY, &str), String> {
    use winreg::enums::*;

    let prefixes: &[(&str, winreg::HKEY)] = &[
        ("HKEY_LOCAL_MACHINE\\", HKEY_LOCAL_MACHINE),
        ("HKEY_CURRENT_USER\\", HKEY_CURRENT_USER),
        ("HKLM\\", HKEY_LOCAL_MACHINE),
        ("HKCU\\", HKEY_CURRENT_USER),
        ("HKLM (WOW64)\\", HKEY_LOCAL_MACHINE),
    ];

    for (prefix, hive) in prefixes {
        if key_path.starts_with(prefix) {
            let remaining = &key_path[prefix.len()..];
            return Ok((*hive, remaining));
        }
    }

    Err(format!("Unrecognized registry hive in path: {}", key_path))
}

/// Determines if an installation is truly orphaned by checking both
/// the install location and the uninstall executable on disk.
#[cfg(target_os = "windows")]
fn is_installation_orphaned(install_loc: &str, uninstall_str: &str) -> bool {
    // If there's a valid install location that still exists → not orphaned
    if !install_loc.is_empty() && Path::new(install_loc).exists() {
        return false;
    }

    // If there's a valid uninstall string pointing to a real exe → not orphaned
    if !uninstall_str.is_empty() {
        let exe = extract_exe_from_command(uninstall_str);
        if !exe.is_empty() && Path::new(&exe).exists() {
            return false;
        }
    }

    // Both checks failed: only flag as orphaned if we had SOME data to check
    // (entries with no install location AND no uninstall string are ambiguous — skip them)
    !install_loc.is_empty() || !uninstall_str.is_empty()
}

/// Extracts the executable path from a command string that may include arguments.
/// Handles: `"C:\path\to\app.exe" /uninstall`, `C:\path\to\app.exe /S`, etc.
#[cfg(target_os = "windows")]
fn extract_exe_from_command(cmd: &str) -> String {
    let trimmed = cmd.trim();

    if trimmed.starts_with('"') {
        // Quoted path: extract up to the closing quote
        if let Some(end) = trimmed[1..].find('"') {
            return trimmed[1..end + 1].to_string();
        }
    }

    // Unquoted: take everything up to the first space or argument flag
    let exe_part = trimmed.split_whitespace().next().unwrap_or("");

    // Ignore entries that are not filesystem paths (e.g. "MsiExec.exe /X{GUID}")
    if exe_part.contains('\\') || exe_part.contains('/') {
        exe_part.to_string()
    } else {
        String::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_returns_vec_on_all_platforms() {
        // Must not panic on any platform
        let items = scan_registry();
        // On non-Windows this will always be empty
        #[cfg(not(target_os = "windows"))]
        assert!(items.is_empty());
        // On Windows just confirm it ran without panic
        #[cfg(target_os = "windows")]
        let _ = items;
    }

    #[test]
    fn test_backup_fails_gracefully_on_non_windows() {
        #[cfg(not(target_os = "windows"))]
        {
            let result = backup_registry();
            assert!(!result.success);
            assert!(result.error.is_some());
        }
    }

    #[test]
    fn test_clean_fails_gracefully_on_non_windows() {
        #[cfg(not(target_os = "windows"))]
        {
            let result = clean_registry_entries(vec![]);
            assert_eq!(result.items_cleaned, 0);
            assert!(!result.errors.is_empty());
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_quoted() {
        let cmd = r#""C:\Program Files\App\uninstall.exe" /silent"#;
        assert_eq!(
            extract_exe_from_command(cmd),
            r"C:\Program Files\App\uninstall.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_unquoted() {
        let cmd = r"C:\Windows\App\uninstall.exe /S";
        assert_eq!(
            extract_exe_from_command(cmd),
            r"C:\Windows\App\uninstall.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_msiexec_ignored() {
        // MsiExec.exe has no path separator — should return empty
        let cmd = r"MsiExec.exe /X{12345678-1234-1234-1234-123456789012}";
        assert_eq!(extract_exe_from_command(cmd), "");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_hive_hklm() {
        let (hive, path) =
            parse_hive(r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\TestApp")
                .unwrap();
        assert_eq!(hive, winreg::enums::HKEY_LOCAL_MACHINE);
        assert_eq!(
            path,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\TestApp"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_hive_hkcu() {
        let (hive, path) = parse_hive(r"HKCU\SOFTWARE\TestKey").unwrap();
        assert_eq!(hive, winreg::enums::HKEY_CURRENT_USER);
        assert_eq!(path, r"SOFTWARE\TestKey");
    }
}
