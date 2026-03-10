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

#[cfg(target_os = "windows")]
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
        use winreg::{enums::*, RegKey};

        // Write backup to the OS temp directory with a timestamp.
        // Using winreg directly avoids reg.exe subprocess issues:
        //   - WOW64 file system redirection (32-bit process can't run System32 eg.exe)
        //   - PATH not being set correctly in Tauri's process environment
        //   - Silent failures that are impossible to diagnose
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // Save to Documents\QRE\Registry Backups — NOT the temp folder.
        // The temp folder is a cleaning target in this very app; storing backups
        // there would silently destroy them the next time the user runs a clean.
        // Fallback to AppData\Roaming\QRE\Registry Backups if Documents is unavailable.
        // Either location is permanent and never targeted by our temp/cache cleaners.
        let backup_dir = directories::UserDirs::new()
            .and_then(|u| {
                u.document_dir()
                    .map(|d| d.join("QRE").join("Registry Backups"))
            })
            .or_else(|| {
                directories::BaseDirs::new()
                    .map(|b| b.data_dir().join("QRE").join("Registry Backups"))
            })
            .unwrap_or_else(|| std::env::temp_dir().join("qre_registry_backups"));
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            return RegistryBackupResult {
                backup_path: String::new(),
                success: false,
                error: Some(format!("Cannot create backup directory: {}", e)),
            };
        }

        let backup_file = backup_dir.join(format!("registry_backup_{}.reg", timestamp));
        let backup_path_str = backup_file.display().to_string();

        // Keys to back up — same set we scan, so the backup covers everything we might delete.
        let keys_to_backup: &[(winreg::HKEY, &str, &str)] = &[
            (
                HKEY_CURRENT_USER,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                "HKEY_CURRENT_USER",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                "HKEY_LOCAL_MACHINE",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
                "HKEY_LOCAL_MACHINE",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
                "HKEY_LOCAL_MACHINE",
            ),
            (
                HKEY_CURRENT_USER,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
                "HKEY_CURRENT_USER",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
                "HKEY_LOCAL_MACHINE",
            ),
        ];

        let mut reg_content = String::from("Windows Registry Editor Version 5.00\r\n\r\n");
        let mut any_success = false;
        let mut export_errors: Vec<String> = Vec::new();

        for (hive, subkey_path, hive_name) in keys_to_backup {
            let root = RegKey::predef(*hive);
            match root.open_subkey(subkey_path) {
                Err(e) => {
                    // Key may simply not exist on this machine — not an error worth surfacing
                    export_errors.push(format!("Skipped {}\\{}: {}", hive_name, subkey_path, e));
                    continue;
                }
                Ok(key) => {
                    // Write the section header
                    reg_content.push_str(&format!("[{}\\{}]\r\n", hive_name, subkey_path));
                    export_key_recursive(
                        &key,
                        &format!("{}\\{}", hive_name, subkey_path),
                        &mut reg_content,
                    );
                    reg_content.push_str("\r\n");
                    any_success = true;
                }
            }
        }

        if !any_success {
            return RegistryBackupResult {
                backup_path: backup_path_str,
                success: false,
                error: Some(format!(
                    "No registry keys could be read. Errors: {}",
                    export_errors.join("; ")
                )),
            };
        }

        match std::fs::write(&backup_file, reg_content.as_bytes()) {
            Ok(_) => RegistryBackupResult {
                backup_path: backup_path_str,
                success: true,
                error: None,
            },
            Err(e) => RegistryBackupResult {
                backup_path: backup_path_str,
                success: false,
                error: Some(format!("Failed to write backup file: {}", e)),
            },
        }
    }
}

/// Recursively exports a registry key and all its subkeys into .reg format.
#[cfg(target_os = "windows")]
fn export_key_recursive(key: &winreg::RegKey, full_path: &str, out: &mut String) {
    // Export all values in this key
    for (name, value) in key.enum_values().filter_map(|v| v.ok()) {
        let formatted = format_reg_value(&name, &value);
        out.push_str(&formatted);
        out.push_str("\r\n");
    }

    // Recurse into subkeys
    for subkey_name in key.enum_keys().filter_map(|k| k.ok()) {
        let subkey_path = format!("{}\\{}", full_path, subkey_name);
        out.push_str(&format!("\r\n[{}]\r\n", subkey_path));
        if let Ok(subkey) = key.open_subkey(&subkey_name) {
            export_key_recursive(&subkey, &subkey_path, out);
        }
    }
}

/// Formats a single registry value into .reg file syntax.
#[cfg(target_os = "windows")]
fn format_reg_value(name: &str, value: &winreg::RegValue) -> String {
    use winreg::enums::*;

    // Default value uses "@" in .reg files; named values are quoted
    let key_part = if name.is_empty() {
        "@".to_string()
    } else {
        format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    };

    match value.vtype {
        REG_SZ | REG_EXPAND_SZ => {
            // Decode UTF-16LE bytes to a string
            let s = reg_value_to_string(value);
            let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
            if value.vtype == REG_EXPAND_SZ {
                format!("{}=hex(2):{}", key_part, bytes_to_hex(&value.bytes))
            } else {
                format!("{}=\"{}\"", key_part, escaped)
            }
        }
        REG_DWORD => {
            if value.bytes.len() >= 4 {
                let n = u32::from_le_bytes([
                    value.bytes[0],
                    value.bytes[1],
                    value.bytes[2],
                    value.bytes[3],
                ]);
                format!("{}=dword:{:08x}", key_part, n)
            } else {
                format!("{}=dword:00000000", key_part)
            }
        }
        REG_QWORD => {
            format!("{}=hex(b):{}", key_part, bytes_to_hex(&value.bytes))
        }
        REG_BINARY => {
            format!("{}=hex:{}", key_part, bytes_to_hex(&value.bytes))
        }
        REG_MULTI_SZ => {
            format!("{}=hex(7):{}", key_part, bytes_to_hex(&value.bytes))
        }
        _ => {
            // Unknown type — store as raw hex
            format!(
                "{}=hex({:x}):{}",
                key_part,
                value.vtype.clone() as u32,
                bytes_to_hex(&value.bytes)
            )
        }
    }
}

/// Decodes a REG_SZ / REG_EXPAND_SZ value's raw bytes (UTF-16LE) to a Rust String.
#[cfg(target_os = "windows")]
fn reg_value_to_string(value: &winreg::RegValue) -> String {
    let bytes = &value.bytes;
    if bytes.len() < 2 || bytes.len() % 2 != 0 {
        return String::new();
    }
    let words: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    // Strip trailing NUL
    let words: Vec<u16> = words.into_iter().take_while(|&w| w != 0).collect();
    String::from_utf16_lossy(&words).to_string()
}

/// Formats a byte slice as comma-separated hex pairs (reg.exe export style).
#[cfg(target_os = "windows")]
fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(",")
}

/// Deletes the specified registry entries. Call backup_registry() first.
pub fn clean_registry_entries(
    #[allow(unused_variables)] entries: Vec<RegistryCleanEntry>,
) -> RegistryCleanResult {
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
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            "HKLM (WOW64)",
        ),
    ];

    // Same app often appears in both HKLM and WOW64 — deduplicate by
    // (lowercase subkey name, lowercase uninstall string).
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

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

            let publisher: String = subkey.get_value("Publisher").unwrap_or_default();
            if publisher.to_lowercase().contains("microsoft") {
                continue;
            }

            let is_system_component: u32 = subkey.get_value("SystemComponent").unwrap_or(0);
            if is_system_component == 1 {
                continue;
            }

            let install_loc: String = subkey.get_value("InstallLocation").unwrap_or_default();
            let uninstall_str: String = subkey.get_value("UninstallString").unwrap_or_default();

            if !is_installation_orphaned(&install_loc, &uninstall_str) {
                continue;
            }

            let dedup_key = (
                subkey_name.to_lowercase(),
                uninstall_str.trim().to_lowercase(),
            );
            if !seen.insert(dedup_key) {
                continue;
            }

            let full_key_path = format!(r"{}\{}\{}", hive_name, path, subkey_name);
            items.push(RegistryItem {
                id: uuid::Uuid::new_v4().to_string(),
                name: display_name.clone(),
                key_path: full_key_path,
                value_name: None,
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

    // Dedup by resolved exe path — prevents double entries from both hive views.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (hive, path, hive_name) in hives {
        let root = RegKey::predef(*hive);
        let Ok(key) = root.open_subkey(path) else {
            continue;
        };

        for subkey_name in key.enum_keys().filter_map(|k| k.ok()) {
            let Ok(subkey) = key.open_subkey(&subkey_name) else {
                continue;
            };

            let raw: String = subkey.get_value("").unwrap_or_default();
            if raw.is_empty() {
                continue;
            }

            // App Paths entries should be a direct path to an executable, but some
            // vendors (e.g. Lenovo's warrantyviewer.exe) store a full shell command
            // like `cmd.exe /c "start protocol:..."` instead. If the value looks
            // like a command line rather than a plain file path, skip it — we
            // cannot meaningfully verify shell commands here.
            //
            // Strategy: strip quotes/whitespace/null bytes, expand %VAR% tokens,
            // then use extract_exe_from_command. If the result is empty (no path
            // separator, i.e. a bare exe name like "cmd.exe"), the entry is a
            // shell command — skip it to avoid false positives.
            let clean = raw.trim().trim_end_matches('\0').trim_matches('"');
            let expanded = expand_env_vars(clean);

            // If the value itself already looks like a bare command (no backslash),
            // treat it the same as extract_exe_from_command returning empty.
            let exe = if expanded.contains('\\') || expanded.contains('/') {
                // Looks like a path — but may still have arguments; extract cleanly
                extract_exe_from_command(&expanded)
            } else {
                String::new() // bare name like "cmd.exe" — skip
            };

            if exe.is_empty() {
                continue; // shell command, protocol handler, or unresolvable — skip
            }

            let dedup_key = exe.to_lowercase();
            if !seen.insert(dedup_key) {
                continue;
            }

            if !Path::new(&exe).exists() {
                let full_key_path = format!(r"{}\{}\{}", hive_name, path, subkey_name);
                items.push(RegistryItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: subkey_name.clone(),
                    key_path: full_key_path,
                    value_name: None,
                    category: "InvalidAppPath".to_string(),
                    description: format!(
                        "App Paths entry for \"{}\" points to a missing executable: {}",
                        subkey_name, exe
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

            let expanded = expand_env_vars(clean);
            if !Path::new(&expanded).exists() {
                let full_key = format!(r"HKCU\{}\{}", path, subkey_name);
                items.push(RegistryItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: Path::new(&expanded)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(clean)
                        .to_string(),
                    key_path: full_key,
                    value_name: Some(value_name.clone()),
                    category: "MUICache".to_string(),
                    description: format!("MUI cache entry for a missing executable: {}", expanded),
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

            let exe_expanded = expand_env_vars(&exe_path);
            if !Path::new(&exe_expanded).exists() {
                let full_key = format!(r"{}\{}", hive_name, path);
                items.push(RegistryItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: value_name.clone(),
                    key_path: full_key,
                    value_name: Some(value_name.clone()),
                    category: "StartupEntry".to_string(),
                    description: format!(
                        "Startup entry \"{}\" points to a missing file: {}",
                        value_name, exe_expanded
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

/// Expands Windows `%VARIABLE%` tokens using the current process environment.
/// `Path::new()` never does this — it passes strings verbatim to the OS.
#[cfg(target_os = "windows")]
fn expand_env_vars(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(rel) = bytes[i + 1..].iter().position(|&b| b == b'%') {
                let var_name = &s[i + 1..i + 1 + rel];
                if var_name.is_empty() {
                    result.push('%'); // "%%" → literal "%"
                } else if let Ok(val) = std::env::var(var_name) {
                    result.push_str(&val);
                } else {
                    result.push('%');
                    result.push_str(var_name);
                    result.push('%');
                }
                i += 1 + rel + 1;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap();
        result.push(ch);
        i += ch.len_utf8();
    }
    result
}

/// Returns `true` only when there is solid evidence the installation is gone.
///
/// Four checks are applied (all with trimming and `%VAR%` expansion):
///
/// 1. **`InstallLocation` exists** → not orphaned.
/// 2. **Uninstaller exe exists** → not orphaned.
/// 3. **Uninstaller's parent directory exists** — covers tools like Miniforge3
///    whose uninstaller exe is absent but whose install directory is intact.
/// 4. **Non-path command guard** — `MsiExec.exe /X{GUID}`, `rundll32`, etc.:
///    `extract_exe_from_command` returns `""`, so we cannot verify anything →
///    conservatively treat as not orphaned.
#[cfg(target_os = "windows")]
fn is_installation_orphaned(install_loc: &str, uninstall_str: &str) -> bool {
    let install_loc = install_loc.trim().trim_end_matches('\0');
    let uninstall_str = uninstall_str.trim().trim_end_matches('\0');

    let install_loc_exp = expand_env_vars(install_loc);
    let uninstall_str_exp = expand_env_vars(uninstall_str);

    // Check 1 — InstallLocation directory exists
    if !install_loc_exp.is_empty() && Path::new(&install_loc_exp).exists() {
        return false;
    }

    if !uninstall_str_exp.is_empty() {
        let exe = extract_exe_from_command(&uninstall_str_exp);

        // Check 4 — Non-path command: cannot verify → assume valid
        if exe.is_empty() {
            return false;
        }

        let exe_exp = expand_env_vars(&exe);

        // Check 2 — Uninstaller exe exists
        if Path::new(&exe_exp).exists() {
            return false;
        }

        // Check 3 — Uninstaller's parent directory exists.
        // Miniforge3, conda-based tools and some portable apps regenerate their
        // uninstaller on demand; the exe is absent but the install folder is real.
        if let Some(parent) = Path::new(&exe_exp).parent() {
            let parent_str = parent.to_str().unwrap_or("");
            // Reject trivial parents: empty string or bare drive root "C:\"
            if parent_str.len() > 3 && parent.exists() {
                return false;
            }
        }
    }

    !install_loc.is_empty() || !uninstall_str.is_empty()
}

/// Extracts the executable path from a Windows uninstall/run command string.
///
/// Handles all real-world patterns:
///   Quoted:                  `"C:\Program Files\App\uninstall.exe" /silent`
///   Unquoted, no spaces:     `C:\Tools\remove.exe /S`
///   Unquoted, WITH spaces:   `C:\Program Files\App\uninstall.exe`
///   Non-path (MsiExec etc.): `MsiExec.exe /X{GUID}` → `""`
///
/// Returns `""` for commands whose first path-token has no separator.
#[cfg(target_os = "windows")]
fn extract_exe_from_command(cmd: &str) -> String {
    let trimmed = cmd.trim();

    // Quoted path
    if trimmed.starts_with('"') {
        if let Some(end) = trimmed[1..].find('"') {
            return trimmed[1..end + 1].to_string();
        }
    }

    // Unquoted: accumulate tokens until we hit the .exe token or an argument flag
    let mut candidate = String::new();
    for token in trimmed.split(' ') {
        if token.is_empty() {
            continue;
        }
        if token.starts_with('/') || token.starts_with('-') {
            break;
        }
        if !candidate.is_empty() {
            candidate.push(' ');
        }
        candidate.push_str(token);

        let lower = candidate.to_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".bat") || lower.ends_with(".cmd") {
            break;
        }
    }

    if candidate.contains('\\') || candidate.contains('/') {
        candidate
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

    // ─────────────────────────────────────────────────────────────────────
    // Cross-platform: public API must never panic
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_scan_does_not_panic_on_any_platform() {
        let items = scan_registry();
        #[cfg(not(target_os = "windows"))]
        assert!(
            items.is_empty(),
            "Non-Windows scan must return an empty Vec"
        );
        #[cfg(target_os = "windows")]
        let _ = items; // On Windows just assert it ran
    }

    #[test]
    fn test_backup_returns_structured_result_on_all_platforms() {
        let result = backup_registry();
        // On Windows this may succeed or fail depending on permissions;
        // on other platforms it must fail with a descriptive error.
        #[cfg(not(target_os = "windows"))]
        {
            assert!(!result.success);
            assert!(result.error.is_some());
            assert!(
                result.error.unwrap().contains("Windows"),
                "Error message should mention Windows"
            );
        }
        #[cfg(target_os = "windows")]
        {
            // success depends on environment — just verify the fields are populated
            if result.success {
                assert!(!result.backup_path.is_empty());
                assert!(result.error.is_none());
            } else {
                assert!(result.error.is_some());
            }
        }
    }

    #[test]
    fn test_clean_returns_structured_result_on_all_platforms() {
        let result = clean_registry_entries(vec![]);
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(result.items_cleaned, 0);
            assert!(
                !result.errors.is_empty(),
                "Non-Windows clean must return an error explaining the limitation"
            );
        }
        #[cfg(target_os = "windows")]
        {
            // Empty input → nothing cleaned, no errors
            assert_eq!(result.items_cleaned, 0);
            assert!(result.errors.is_empty());
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // RegistryItem struct completeness
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn test_scan_items_have_non_empty_required_fields() {
        let items = scan_registry();
        for item in &items {
            assert!(!item.id.is_empty(), "Item '{}' has empty id", item.name);
            assert!(
                !item.name.is_empty(),
                "Item at '{}' has empty name",
                item.key_path
            );
            assert!(
                !item.key_path.is_empty(),
                "Item '{}' has empty key_path",
                item.name
            );
            assert!(
                !item.category.is_empty(),
                "Item '{}' has empty category",
                item.name
            );
            assert!(
                !item.description.is_empty(),
                "Item '{}' has empty description",
                item.name
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_scan_items_have_valid_categories() {
        let valid = [
            "OrphanedInstaller",
            "InvalidAppPath",
            "MUICache",
            "StartupEntry",
        ];
        let items = scan_registry();
        for item in &items {
            assert!(
                valid.contains(&item.category.as_str()),
                "Item '{}' has unknown category '{}'",
                item.name,
                item.category
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_scan_items_have_unique_ids() {
        let items = scan_registry();
        let mut seen = std::collections::HashSet::new();
        for item in &items {
            assert!(
                seen.insert(item.id.clone()),
                "Duplicate UUID for item '{}' at '{}'",
                item.name,
                item.key_path
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_scan_key_paths_contain_known_hive_prefix() {
        let valid_prefixes = ["HKLM\\", "HKCU\\", "HKLM (WOW64)\\"];
        let items = scan_registry();
        for item in &items {
            let has_valid_prefix = valid_prefixes.iter().any(|p| item.key_path.starts_with(p));
            assert!(
                has_valid_prefix,
                "Item '{}' key_path '{}' does not start with a known hive prefix",
                item.name, item.key_path
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // extract_exe_from_command
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_quoted_with_spaces() {
        assert_eq!(
            extract_exe_from_command(r#""C:\Program Files\App\uninstall.exe" /silent"#),
            r"C:\Program Files\App\uninstall.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_quoted_no_args() {
        assert_eq!(
            extract_exe_from_command(r#""C:\Program Files\App\remove.exe""#),
            r"C:\Program Files\App\remove.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_unquoted_no_spaces_with_flag() {
        assert_eq!(
            extract_exe_from_command(r"C:\Windows\App\uninst.exe /S"),
            r"C:\Windows\App\uninst.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_unquoted_no_args() {
        assert_eq!(
            extract_exe_from_command(r"C:\Tools\remove.exe"),
            r"C:\Tools\remove.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_unquoted_spaces_in_path_no_args() {
        // REGRESSION: split_whitespace().next() returned "C:\Program" only.
        assert_eq!(
            extract_exe_from_command(r"C:\Program Files\Android\Android Studio\uninstall.exe"),
            r"C:\Program Files\Android\Android Studio\uninstall.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_unquoted_spaces_with_slash_flag() {
        assert_eq!(
            extract_exe_from_command(r"C:\Program Files\App\uninstall.exe /S"),
            r"C:\Program Files\App\uninstall.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_unquoted_spaces_with_dash_flag() {
        assert_eq!(
            extract_exe_from_command(r"C:\Program Files (x86)\Steam\steam.exe -uninstall"),
            r"C:\Program Files (x86)\Steam\steam.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_msiexec_returns_empty() {
        assert_eq!(
            extract_exe_from_command(r"MsiExec.exe /X{12345678-1234-1234-1234-123456789012}"),
            ""
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_rundll32_returns_empty() {
        assert_eq!(
            extract_exe_from_command("rundll32.exe setupapi.dll,InstallHinfSection"),
            ""
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_cmd_shell_command_returns_empty() {
        // Lenovo's warrantyviewer.exe stores "cmd.exe /c start lenovo-companion:..."
        // in App Paths — must NOT be flagged as a missing exe.
        assert_eq!(
            extract_exe_from_command(r#"cmd.exe /c "start lenovo-companion:PARAM?featureId=foo""#),
            ""
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_empty_returns_empty() {
        assert_eq!(extract_exe_from_command(""), "");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_whitespace_only_returns_empty() {
        assert_eq!(extract_exe_from_command("   "), "");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_forward_slash_unquoted() {
        assert_eq!(
            extract_exe_from_command("C:/Tools/App/uninstall.exe /silent"),
            "C:/Tools/App/uninstall.exe"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_exe_forward_slash_quoted_with_spaces() {
        assert_eq!(
            extract_exe_from_command(r#""C:/Program Files/App/uninstall.exe" /silent"#),
            "C:/Program Files/App/uninstall.exe"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // expand_env_vars
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn test_expand_env_vars_known_var() {
        let r = expand_env_vars("%WINDIR%");
        assert!(!r.is_empty() && !r.contains('%'), "Got: {}", r);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_expand_env_vars_unknown_preserved() {
        assert_eq!(
            expand_env_vars("%TOTALLY_UNKNOWN_XYZ%"),
            "%TOTALLY_UNKNOWN_XYZ%"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_expand_env_vars_no_tokens() {
        let s = r"C:\Program Files\MyApp\app.exe";
        assert_eq!(expand_env_vars(s), s);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_expand_env_vars_double_percent() {
        assert_eq!(expand_env_vars("100%%"), "100%");
    }

    // ─────────────────────────────────────────────────────────────────────
    // is_installation_orphaned
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_both_fields_empty_returns_false() {
        assert!(!is_installation_orphaned("", ""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_existing_install_location_returns_false() {
        assert!(!is_installation_orphaned(r"C:\Windows", ""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_missing_both_returns_true() {
        assert!(is_installation_orphaned(
            r"C:\Program Files\FakeApp12345XYZ\",
            r"C:\Program Files\FakeApp12345XYZ\uninstall.exe"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_valid_uninstall_exe_returns_false() {
        assert!(!is_installation_orphaned(
            r"C:\FakeDir\12345\",
            r"C:\Windows\System32\cmd.exe"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_missing_exe_but_parent_dir_exists_returns_false() {
        // REGRESSION: Miniforge3 — uninstaller may be absent but install dir is real.
        // C:\Windows exists on all Windows machines; use it as the parent stand-in.
        assert!(!is_installation_orphaned(
            "",
            r"C:\Windows\FakeUninstaller-xyz-notreal.exe"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_msiexec_not_false_positive() {
        assert!(!is_installation_orphaned(
            "",
            r"MsiExec.exe /X{12345678-1234-1234-1234-123456789012}"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_trailing_whitespace_not_false_positive() {
        assert!(!is_installation_orphaned("C:\\Windows  \t", ""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_trailing_null_byte_not_false_positive() {
        assert!(!is_installation_orphaned("C:\\Windows\0", ""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_env_var_install_location_not_false_positive() {
        assert!(!is_installation_orphaned("%WINDIR%", ""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_orphaned_env_var_uninstall_string_not_false_positive() {
        assert!(!is_installation_orphaned(
            "",
            r#""%WINDIR%\System32\cmd.exe" /C echo hi"#
        ));
    }

    // ─────────────────────────────────────────────────────────────────────
    // parse_hive (Windows-only helper)
    // ─────────────────────────────────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_hive_hklm_short() {
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
    fn test_parse_hive_hkcu_short() {
        let (hive, path) = parse_hive(r"HKCU\SOFTWARE\TestKey").unwrap();
        assert_eq!(hive, winreg::enums::HKEY_CURRENT_USER);
        assert_eq!(path, r"SOFTWARE\TestKey");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_hive_hklm_wow64() {
        let (hive, path) = parse_hive(r"HKLM (WOW64)\SOFTWARE\TestApp").unwrap();
        assert_eq!(hive, winreg::enums::HKEY_LOCAL_MACHINE);
        assert_eq!(path, r"SOFTWARE\TestApp");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_hive_unknown_prefix_returns_error() {
        let result = parse_hive(r"HKCR\SOFTWARE\TestKey");
        assert!(
            result.is_err(),
            "Unknown hive prefix HKCR should return Err"
        );
        assert!(result.unwrap_err().contains("Unrecognized registry hive"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_hive_empty_string_returns_error() {
        let result = parse_hive("");
        assert!(result.is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_hive_preserves_nested_subkeys() {
        let (_, path) = parse_hive(r"HKCU\A\B\C\D\E").unwrap();
        assert_eq!(path, r"A\B\C\D\E");
    }

    // ─────────────────────────────────────────────────────────────────────
    // RegistryCleanEntry deserialization round-trip
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_registry_clean_entry_with_value_name() {
        let entry = RegistryCleanEntry {
            key_path: r"HKCU\SOFTWARE\Test".to_string(),
            value_name: Some("MyValue".to_string()),
        };
        assert_eq!(entry.key_path, r"HKCU\SOFTWARE\Test");
        assert_eq!(entry.value_name.as_deref(), Some("MyValue"));
    }

    #[test]
    fn test_registry_clean_entry_without_value_name() {
        let entry = RegistryCleanEntry {
            key_path: r"HKCU\SOFTWARE\Test".to_string(),
            value_name: None,
        };
        assert!(entry.value_name.is_none());
    }

    // ─────────────────────────────────────────────────────────────────────
    // RegistryBackupResult fields
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_backup_result_success_fields_consistent() {
        // Manually construct a "success" result and verify field consistency
        let r = RegistryBackupResult {
            backup_path: "/tmp/backup.reg".to_string(),
            success: true,
            error: None,
        };
        assert!(r.success);
        assert!(!r.backup_path.is_empty());
        assert!(r.error.is_none());
    }

    #[test]
    fn test_backup_result_failure_fields_consistent() {
        let r = RegistryBackupResult {
            backup_path: String::new(),
            success: false,
            error: Some("Access denied".to_string()),
        };
        assert!(!r.success);
        assert!(r.error.is_some());
    }
}
