// --- START OF FILE shredder.rs ---

use anyhow::{anyhow, Result};
use rand::Rng;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024 * 1024; // Limit to 10 GB per file
const WARN_SIZE_THRESHOLD: u64 = 1024 * 1024 * 1024; // Warn the user if > 1 GB
const BUFFER_SIZE: usize = 1024 * 1024; // 1 MB buffer for efficient disk writes

// FIX #7: Per-operation cancel flag stored in a Mutex.
// Replaced the global AtomicBool, which would cancel ALL concurrent operations.
// Now each batch_shred creates its own Arc<AtomicBool> and stores it here so
// cancel_shred only cancels the most-recently-started operation.
static OPERATION_FLAG: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

// ═══════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════

/// Live progress data emitted to the frontend during shredding.
#[derive(Clone, serde::Serialize)]
pub struct ShredProgress {
    pub current_file: usize,
    pub total_files: usize,
    pub current_pass: u8,
    pub total_passes: u8,
    pub current_file_name: String,
    pub percentage: u8,
    // FIX #10: bytes_processed is now cumulative across ALL files in the batch,
    // not reset to zero for each new file.
    pub bytes_processed: u64,
    pub total_bytes: u64,
}

/// The final report sent back to the frontend after a batch shred finishes.
#[derive(serde::Serialize)]
pub struct ShredResult {
    pub success: Vec<String>,
    pub failed: Vec<FailedFile>,
    pub total_files: usize,
    pub total_bytes_shredded: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct FailedFile {
    pub path: String,
    pub error: String,
}

/// A summary of a file generated during the "Dry Run" preview phase.
#[derive(serde::Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
    pub file_count: usize,
    pub warning: Option<String>,
}

/// The result of a "Dry Run", showing the user exactly what will happen.
#[derive(serde::Serialize)]
pub struct DryRunResult {
    pub files: Vec<FileInfo>,
    pub total_size: u64,
    pub total_file_count: usize,
    pub warnings: Vec<String>,
    pub blocked: Vec<String>,
}

/// The specific data destruction algorithm the user selected.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ShredMethod {
    Simple,   // 1 pass: overwrite with 0x00
    DoD3Pass, // 3 passes: US DoD 5220.22-M standard
    DoD7Pass, // 7 passes: DoD 5220.22-M Extended
    Gutmann,  // 35 passes: Peter Gutmann method
}

// ─── Free-space wipe structs ────────────────────────────────────────────────

/// Incremental progress emitted during a free-space wipe (indeterminate total).
#[derive(Clone, serde::Serialize)]
pub struct WipeProgress {
    /// Total bytes written to the wipe temp file so far.
    pub bytes_written: u64,
    /// Human-readable current phase ("Writing", "Flushing", "Cleaning up").
    pub phase: String,
}

/// Result returned to the frontend after wipe_free_space completes.
#[derive(serde::Serialize)]
pub struct WipeFreeSpaceResult {
    pub bytes_wiped: u64,
    pub target_path: String,
}

// ─── TRIM structs ────────────────────────────────────────────────────────────

/// Result returned to the frontend after trim_drive completes.
#[derive(serde::Serialize)]
pub struct TrimResult {
    pub success: bool,
    pub drive: String,
    pub message: String,
}

// ═══════════════════════════════════════════════════════════════════════════
// PATH VALIDATION & BLACKLIST
// ═══════════════════════════════════════════════════════════════════════════

/// Generates a list of critical OS directories the shredder is forbidden to touch.
/// FIX #8: This is now called ONCE per batch and the result is passed into
/// validate_path, instead of being rebuilt on every single file.
fn build_blacklist() -> Vec<PathBuf> {
    let mut blacklist: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(sys_drive) = std::env::var("SystemDrive") {
            blacklist.push(PathBuf::from(format!("{}\\Windows", sys_drive)));
            blacklist.push(PathBuf::from(format!("{}\\Program Files", sys_drive)));
            blacklist.push(PathBuf::from(format!("{}\\Program Files (x86)", sys_drive)));
            blacklist.push(PathBuf::from(format!("{}\\ProgramData", sys_drive)));
            blacklist.push(PathBuf::from(format!("{}\\Users\\Default", sys_drive)));
        }
    }

    #[cfg(target_os = "macos")]
    {
        blacklist.push(PathBuf::from("/System"));
        blacklist.push(PathBuf::from("/Library"));
        blacklist.push(PathBuf::from("/Applications"));
        blacklist.push(PathBuf::from("/usr"));
        blacklist.push(PathBuf::from("/bin"));
        blacklist.push(PathBuf::from("/sbin"));
        blacklist.push(PathBuf::from("/etc"));
        blacklist.push(PathBuf::from("/var"));
        blacklist.push(PathBuf::from("/private"));
    }

    #[cfg(target_os = "linux")]
    {
        blacklist.push(PathBuf::from("/bin"));
        blacklist.push(PathBuf::from("/boot"));
        blacklist.push(PathBuf::from("/dev"));
        blacklist.push(PathBuf::from("/etc"));
        blacklist.push(PathBuf::from("/lib"));
        blacklist.push(PathBuf::from("/lib64"));
        blacklist.push(PathBuf::from("/proc"));
        blacklist.push(PathBuf::from("/root"));
        blacklist.push(PathBuf::from("/sbin"));
        blacklist.push(PathBuf::from("/sys"));
        blacklist.push(PathBuf::from("/usr"));
        blacklist.push(PathBuf::from("/var"));
    }

    #[cfg(target_os = "android")]
    {
        blacklist.push(PathBuf::from("/system"));
        blacklist.push(PathBuf::from("/data/app"));
        blacklist.push(PathBuf::from("/data/data"));
        blacklist.push(PathBuf::from("/data/system"));
        blacklist.push(PathBuf::from("/proc"));
        blacklist.push(PathBuf::from("/sys"));
        blacklist.push(PathBuf::from("/dev"));
        blacklist.push(PathBuf::from("/etc"));
        blacklist.push(PathBuf::from("/bin"));
        blacklist.push(PathBuf::from("/sbin"));
        blacklist.push(PathBuf::from("/vendor"));
        blacklist.push(PathBuf::from("/apex"));
    }

    blacklist
        .into_iter()
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect()
}

/// Deep security validation for a single path.
/// FIX #8: Now accepts the pre-built blacklist instead of rebuilding it.
fn validate_path(path: &Path, blacklist: &[PathBuf]) -> Result<PathBuf> {
    if !path.exists() {
        return Err(anyhow!("Path does not exist"));
    }

    let metadata = fs::symlink_metadata(path)?;

    if metadata.file_type().is_symlink() {
        return Err(anyhow!("Symlinks are not supported for security reasons"));
    }

    if !metadata.is_file() {
        return Err(anyhow!(
            "Only regular files are supported (not directories or special files)"
        ));
    }

    let size = metadata.len();
    if size > MAX_FILE_SIZE {
        return Err(anyhow!(
            "File too large: {} GB (maximum: {} GB)",
            size / (1024 * 1024 * 1024),
            MAX_FILE_SIZE / (1024 * 1024 * 1024)
        ));
    }

    let canonical = fs::canonicalize(path)?;

    for blocked in blacklist {
        if canonical.starts_with(blocked) || canonical == *blocked {
            return Err(anyhow!(
                "Path is in protected system directory: {}",
                blocked.display()
            ));
        }
    }

    if metadata.permissions().readonly() {
        return Err(anyhow!("File is read-only"));
    }

    Ok(canonical)
}

// ═══════════════════════════════════════════════════════════════════════════
// DRY RUN (Preview Before Shredding)
// ═══════════════════════════════════════════════════════════════════════════

/// Simulates the shredding process and returns a full report for user confirmation.
pub fn dry_run(paths: Vec<String>) -> Result<DryRunResult> {
    // FIX #8: Build the blacklist once for the entire batch.
    let blacklist = build_blacklist();

    let mut files = Vec::new();
    let mut total_size = 0u64;
    let mut total_file_count = 0usize;
    let mut warnings = Vec::new();
    let mut blocked = Vec::new();

    for path_str in paths {
        let path = Path::new(&path_str);

        match validate_path(path, &blacklist) {
            Ok(canonical) => {
                if let Ok(metadata) = fs::metadata(&canonical) {
                    let size = metadata.len();
                    total_size += size;
                    total_file_count += 1;

                    let warning = if size > WARN_SIZE_THRESHOLD {
                        Some(format!(
                            "Large file: {} - may take several minutes",
                            format_size(size)
                        ))
                    } else {
                        None
                    };

                    if let Some(w) = &warning {
                        warnings.push(format!(
                            "{}: {}",
                            canonical.file_name().unwrap_or_default().to_string_lossy(),
                            w
                        ));
                    }

                    files.push(FileInfo {
                        path: canonical.display().to_string(),
                        name: canonical
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string(),
                        size,
                        is_directory: false,
                        file_count: 1,
                        warning,
                    });
                }
            }
            Err(e) => {
                blocked.push(format!("{}: {}", path_str, e));
            }
        }
    }

    if total_size > 10 * 1024 * 1024 * 1024 {
        warnings.push(format!(
            "Total size is {} - operation may take significant time",
            format_size(total_size)
        ));
    }

    Ok(DryRunResult {
        files,
        total_size,
        total_file_count,
        warnings,
        blocked,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// SHREDDING ALGORITHMS
// ═══════════════════════════════════════════════════════════════════════════

/// Executes the overwriting passes on a single file.
///
/// FIX #3: `file.sync_all()` is now called after EVERY pass to force the OS to
/// physically commit each overwrite to disk before the next pass begins.
/// Without this, the OS page cache can coalesce writes, making some passes no-ops.
///
/// FIX #5: The file is renamed to a random hex name before deletion so that the
/// original filename cannot be recovered from directory entry forensics.
///
/// FIX #10: `bytes_before` (sum of all bytes from completed files × their passes)
/// is used to calculate cumulative progress across the entire batch.
fn shred_file<R: tauri::Runtime>(
    path: &Path,
    method: ShredMethod,
    app_handle: &tauri::AppHandle<R>,
    file_index: usize,
    total_files: usize,
    bytes_before: u64,
    total_bytes_all: u64,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<u64> {
    let metadata = fs::metadata(path)?;
    let file_size = metadata.len();
    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let passes = match method {
        ShredMethod::Simple => vec![ShredPass::Zeros],
        ShredMethod::DoD3Pass => vec![ShredPass::Random, ShredPass::Complement, ShredPass::Random],
        ShredMethod::DoD7Pass => vec![
            ShredPass::Pattern(0xF6),
            ShredPass::Pattern(0x00),
            ShredPass::Pattern(0xFF),
            ShredPass::Random,
            ShredPass::Pattern(0x00),
            ShredPass::Pattern(0xFF),
            ShredPass::Random,
        ],
        ShredMethod::Gutmann => get_gutmann_passes(),
    };

    let total_passes = passes.len() as u8;

    let mut file = OpenOptions::new().read(true).write(true).open(path)?;

    for (pass_num, pass_type) in passes.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(anyhow!("Operation cancelled by user"));
        }

        write_pass(&mut file, file_size, pass_type, cancel_flag)?;

        // FIX #3: Force physical write to disk after every pass.
        file.sync_all()?;

        // FIX #10: Calculate percentage from cumulative bytes across the whole batch.
        let bytes_done_this_file = (pass_num as u64 + 1) * file_size;
        let total_processed = bytes_before + bytes_done_this_file;
        let percentage = if total_bytes_all > 0 {
            ((total_processed as f64 / total_bytes_all as f64) * 100.0).min(100.0) as u8
        } else {
            0
        };

        let progress = ShredProgress {
            current_file: file_index + 1,
            total_files,
            current_pass: pass_num as u8 + 1,
            total_passes,
            current_file_name: file_name.clone(),
            percentage,
            bytes_processed: total_processed,
            total_bytes: total_bytes_all,
        };

        let _ = app_handle.emit("shred-progress", progress);
    }

    // Final sync before closing.
    file.sync_all()?;
    drop(file);

    // FIX #5: Rename the file to a random hex name so the original filename
    // cannot be recovered from forensic directory analysis.
    let mut rng = rand::rng();
    let random_name: String = (0..16)
        .map(|_| format!("{:02x}", rng.random::<u8>()))
        .collect();
    let renamed_path = path.with_file_name(random_name);
    fs::rename(path, &renamed_path)?;

    // FIX #5 cont.: Sync directory entry so the rename reaches disk before unlink.
    // We do this by opening and syncing the parent directory (Unix only).
    #[cfg(unix)]
    if let Some(parent) = renamed_path.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    fs::remove_file(&renamed_path)?;

    if renamed_path.exists() {
        return Err(anyhow!("File still exists after deletion attempt"));
    }

    Ok(file_size)
}

/// The type of data to write on a given pass.
#[derive(Clone)]
enum ShredPass {
    Zeros,
    Random,
    Pattern(u8),
    Complement,
}

/// Core write loop. Fills the target with the specified pattern.
///
/// FIX #4: The `Complement` branch now propagates read errors instead of
/// silently discarding them with `.ok()`. A read failure during an overwrite
/// pass is a hard error.
fn write_pass<W: Read + Write + Seek>(
    writer: &mut W,
    size: u64,
    pass_type: &ShredPass,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<()> {
    writer.seek(SeekFrom::Start(0))?;

    let mut rng = rand::rng();
    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut remaining = size;

    while remaining > 0 {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(anyhow!("Cancelled"));
        }

        let chunk_size = std::cmp::min(remaining, BUFFER_SIZE as u64) as usize;

        match pass_type {
            ShredPass::Zeros => buffer[..chunk_size].fill(0x00),
            ShredPass::Random => rng.fill(&mut buffer[..chunk_size]),
            ShredPass::Pattern(byte) => buffer[..chunk_size].fill(*byte),
            ShredPass::Complement => {
                // FIX #4: Use `?` instead of `.ok()` to surface read errors.
                writer.read_exact(&mut buffer[..chunk_size])?;
                for byte in &mut buffer[..chunk_size] {
                    *byte = !*byte;
                }
                writer.seek(SeekFrom::Current(-(chunk_size as i64)))?;
            }
        }

        writer.write_all(&buffer[..chunk_size])?;
        remaining -= chunk_size as u64;
    }

    writer.flush()?;
    Ok(())
}

/// The 35-pass Gutmann method.
///
/// FIX #1: Corrected to exactly 35 passes: 4 random + 27 fixed patterns + 4 random.
/// The original code had an extra 0x92/0x49/0x24 triplet (36 passes) and only
/// 2 trailing random passes instead of the required 4.
fn get_gutmann_passes() -> Vec<ShredPass> {
    vec![
        // Passes 1–4: Random
        ShredPass::Random,
        ShredPass::Random,
        ShredPass::Random,
        ShredPass::Random,
        // Passes 5–31: Specific magnetic encoding patterns (27 total)
        ShredPass::Pattern(0x55),
        ShredPass::Pattern(0xAA),
        ShredPass::Pattern(0x92),
        ShredPass::Pattern(0x49),
        ShredPass::Pattern(0x24),
        ShredPass::Pattern(0x00),
        ShredPass::Pattern(0x11),
        ShredPass::Pattern(0x22),
        ShredPass::Pattern(0x33),
        ShredPass::Pattern(0x44),
        ShredPass::Pattern(0x55),
        ShredPass::Pattern(0x66),
        ShredPass::Pattern(0x77),
        ShredPass::Pattern(0x88),
        ShredPass::Pattern(0x99),
        ShredPass::Pattern(0xAA),
        ShredPass::Pattern(0xBB),
        ShredPass::Pattern(0xCC),
        ShredPass::Pattern(0xDD),
        ShredPass::Pattern(0xEE),
        ShredPass::Pattern(0xFF),
        ShredPass::Pattern(0x92),
        ShredPass::Pattern(0x49),
        ShredPass::Pattern(0x24),
        ShredPass::Pattern(0x6D),
        ShredPass::Pattern(0xB6),
        ShredPass::Pattern(0xDB),
        // Passes 32–35: Final random passes
        ShredPass::Random,
        ShredPass::Random,
        ShredPass::Random,
        ShredPass::Random,
    ]
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH SHREDDING
// ═══════════════════════════════════════════════════════════════════════════

/// Shreds a list of files sequentially.
pub fn batch_shred<R: tauri::Runtime>(
    paths: Vec<String>,
    method: ShredMethod,
    app_handle: &tauri::AppHandle<R>,
) -> Result<ShredResult> {
    // FIX #7: Create a fresh cancel flag for this specific operation and store
    // it in the global Mutex. This isolates cancellation to the active operation.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = OPERATION_FLAG.lock().unwrap();
        *guard = Some(Arc::clone(&cancel_flag));
    }

    let blacklist = build_blacklist();

    let mut success = Vec::new();
    let mut failed = Vec::new();
    let mut total_bytes_shredded = 0u64;

    // Phase 1: Pre-validate all paths before destroying anything.
    let validated: Vec<(String, PathBuf)> = paths
        .into_iter()
        .filter_map(
            |path_str| match validate_path(Path::new(&path_str), &blacklist) {
                Ok(canonical) => Some((path_str, canonical)),
                Err(e) => {
                    failed.push(FailedFile {
                        path: path_str,
                        error: e.to_string(),
                    });
                    None
                }
            },
        )
        .collect();

    let total_files = validated.len();

    // FIX #10: Pre-compute total bytes across all files so each shred_file call
    // can emit accurate cumulative progress percentages.
    let pass_count = match method {
        ShredMethod::Simple => 1u64,
        ShredMethod::DoD3Pass => 3,
        ShredMethod::DoD7Pass => 7,
        ShredMethod::Gutmann => 35,
    };
    let total_bytes_all: u64 = validated
        .iter()
        .filter_map(|(_, p)| fs::metadata(p).ok().map(|m| m.len() * pass_count))
        .sum();

    // Phase 2: Shred the valid files sequentially, tracking cumulative bytes.
    let mut bytes_before: u64 = 0;

    for (idx, (original_path, canonical_path)) in validated.into_iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            failed.push(FailedFile {
                path: "Remaining files".to_string(),
                error: "Operation cancelled by user".to_string(),
            });
            break;
        }

        let file_size = fs::metadata(&canonical_path).map(|m| m.len()).unwrap_or(0);

        match shred_file(
            &canonical_path,
            method,
            app_handle,
            idx,
            total_files,
            bytes_before,
            total_bytes_all,
            &cancel_flag,
        ) {
            Ok(bytes) => {
                bytes_before += file_size * pass_count;
                success.push(original_path);
                total_bytes_shredded += bytes;
            }
            Err(e) => {
                failed.push(FailedFile {
                    path: original_path,
                    error: e.to_string(),
                });
            }
        }
    }

    Ok(ShredResult {
        success,
        failed,
        total_files,
        total_bytes_shredded,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// FREE SPACE WIPE (HDD)
// ═══════════════════════════════════════════════════════════════════════════

/// Wipes unallocated space on an HDD by creating a large temp file that fills
/// the drive, then deleting it. This overwrites any deleted-file remnants.
///
/// Progress is emitted as indeterminate (bytes written, no total) because
/// querying exact free space requires platform-specific APIs. The UI shows a
/// spinner + running byte counter instead of a percentage bar.
///
/// NOTE: This is meaningful on HDDs only. On SSDs, the controller's wear-leveling
/// may still retain traces — use TRIM or full-disk encryption for SSDs.
pub fn wipe_free_space<R: tauri::Runtime>(
    drive_path: String,
    app_handle: &tauri::AppHandle<R>,
) -> Result<WipeFreeSpaceResult> {
    // FIX #7: Share the per-operation cancel flag.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = OPERATION_FLAG.lock().unwrap();
        *guard = Some(Arc::clone(&cancel_flag));
    }

    let base = Path::new(&drive_path);
    if !base.exists() {
        return Err(anyhow!("Drive path does not exist: {}", drive_path));
    }

    let blacklist = build_blacklist();
    for blocked in &blacklist {
        if base.starts_with(blocked) || base == blocked {
            return Err(anyhow!(
                "Cannot wipe free space on a protected system directory"
            ));
        }
    }

    // ── Drive type validation ─────────────────────────────────────────────
    // Wiping free space is only meaningful on persistent magnetic storage (HDDs).
    // RAM drives, removable media, network drives, and optical drives are all
    // either volatile or use wear-leveling that makes overwriting unreliable.

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Extract the drive letter from the supplied path (e.g. "Z:\temp" → "Z").
        let drive_letter = base
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .unwrap_or_default()
            .trim_end_matches([':', '\\', '/'])
            .to_uppercase();

        if !drive_letter.is_empty() {
            // ── Stage 1: Win32_LogicalDisk.DriveType ─────────────────────────
            // Catches RAM drives (6), removable (2), network (4), optical (5).
            // NOTE: DriveType = 3 ("fixed") covers BOTH HDDs and SSDs — they
            // are indistinguishable at this level, so we need a second query.
            let script_type = format!(
                "(Get-WmiObject Win32_LogicalDisk -Filter \"DeviceID=\'{drive_letter}:\'\").DriveType"
            );
            let result_type = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script_type])
                .creation_flags(CREATE_NO_WINDOW)
                .output();

            if let Ok(output) = result_type {
                let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let drive_type: u32 = raw.parse().unwrap_or(3);

                match drive_type {
                    6 => {
                        return Err(anyhow!(
                            "Free-space wipe is not supported on RAM drives. \
                        RAM is volatile — all data is lost on unmount or reboot. \
                        No wipe is needed or useful."
                        ))
                    }
                    2 => {
                        return Err(anyhow!(
                            "Free-space wipe is not supported on removable drives (USB/SD). \
                        Flash storage uses wear-leveling that redirects writes, so overwriting \
                        free space does not reliably erase deleted data. \
                        Use full-disk encryption for secure erasure on flash media."
                        ))
                    }
                    4 => {
                        return Err(anyhow!(
                            "Free-space wipe is not supported on network drives. \
                        The operation cannot guarantee secure overwrite of remote storage."
                        ))
                    }
                    5 => {
                        return Err(anyhow!(
                            "Free-space wipe is not supported on optical drives."
                        ))
                    }
                    _ => {} // DriveType 3 (fixed) — continue to Stage 2
                }
            }

            // ── Stage 2: Get-PhysicalDisk MediaType ──────────────────────────
            // Win32_LogicalDisk cannot distinguish HDD from SSD — both return
            // DriveType 3. Get-PhysicalDisk.MediaType returns "HDD", "SSD",
            // "SCM", or "Unspecified" and is the correct API for this check.
            let script_media = format!(
                "$d = Get-Partition -DriveLetter \'{drive_letter}\' -ErrorAction SilentlyContinue | \
                 Get-Disk -ErrorAction SilentlyContinue | \
                 Get-PhysicalDisk -ErrorAction SilentlyContinue; \
                 if ($d) {{ $d.MediaType }} else {{ 'Unspecified' }}"
            );
            let result_media = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script_media])
                .creation_flags(CREATE_NO_WINDOW)
                .output();

            if let Ok(output) = result_media {
                let media_type = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .to_lowercase();

                if media_type == "ssd" {
                    return Err(anyhow!(
                        "Free-space wipe is not effective on SSDs. \
                        SSD controllers use wear-leveling and over-provisioning that \
                        redirect writes to physical cells outside the visible drive, \
                        meaning overwriting free space does not guarantee erasure of \
                        deleted data. For true secure erasure on an SSD, use full-disk \
                        encryption and discard the key, or use the TRIM command."
                    ));
                }
                // "HDD" → allow. "Unspecified" / "SCM" / parse error → allow
                // (fail open so legitimate HDD wipes are never wrongly blocked).
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Detect tmpfs/ramfs mounts via /proc/mounts.
        let path_str = base.to_string_lossy();
        let is_ram_backed = std::fs::read_to_string("/proc/mounts")
            .unwrap_or_default()
            .lines()
            .any(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let mount_point = parts[1];
                    let fs_type = parts[2];
                    let is_tmpfs = matches!(fs_type, "tmpfs" | "ramfs");
                    let is_match = path_str.starts_with(mount_point);
                    is_tmpfs && is_match
                } else {
                    false
                }
            });

        if is_ram_backed {
            return Err(anyhow!(
                "Free-space wipe is not supported on RAM-backed filesystems (tmpfs/ramfs). \
                RAM is volatile — all data is automatically lost when unmounted or on reboot. \
                No wipe is needed or useful."
            ));
        }
    }

    // Use a hidden temp file with a fixed, recognizable name so a crash leaves
    // a recoverable artifact the user can manually delete.
    let temp_path = base.join(".qre_freespace_wipe.tmp");

    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp_path)
        .map_err(|e| anyhow!("Failed to create wipe temp file: {}", e))?;

    let buffer = vec![0u8; BUFFER_SIZE];
    let mut bytes_written: u64 = 0;

    let _ = app_handle.emit(
        "wipe-progress",
        WipeProgress {
            bytes_written: 0,
            phase: "Writing".to_string(),
        },
    );

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            drop(file);
            let _ = fs::remove_file(&temp_path);
            return Err(anyhow!("Wipe cancelled by user"));
        }

        match file.write_all(&buffer) {
            Ok(_) => {
                bytes_written += BUFFER_SIZE as u64;

                // Emit progress every ~16 MB to avoid overwhelming the IPC channel.
                if bytes_written % (16 * 1024 * 1024) == 0 {
                    let _ = app_handle.emit(
                        "wipe-progress",
                        WipeProgress {
                            bytes_written,
                            phase: "Writing".to_string(),
                        },
                    );
                }
            }
            // ENOSPC on Unix (28) / ERROR_DISK_FULL on Windows (112): drive is full — done.
            Err(e)
                if e.raw_os_error() == Some(28)
                    || e.raw_os_error() == Some(112)
                    || e.kind() == std::io::ErrorKind::StorageFull =>
            {
                break;
            }
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&temp_path);
                return Err(anyhow!("Write error during free-space wipe: {}", e));
            }
        }
    }

    let _ = app_handle.emit(
        "wipe-progress",
        WipeProgress {
            bytes_written,
            phase: "Flushing".to_string(),
        },
    );

    file.sync_all()?;
    drop(file);

    let _ = app_handle.emit(
        "wipe-progress",
        WipeProgress {
            bytes_written,
            phase: "Cleaning up".to_string(),
        },
    );

    fs::remove_file(&temp_path)?;

    Ok(WipeFreeSpaceResult {
        bytes_wiped: bytes_written,
        target_path: drive_path,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// SSD TRIM
// ═══════════════════════════════════════════════════════════════════════════

/// Issues a TRIM command to an SSD, telling the controller which blocks are free
/// to erase. This improves future write performance but does NOT guarantee
/// immediate or forensic-level erasure — the timing of physical block erasure
/// is entirely up to the SSD controller firmware.
///
/// For true SSD security erasure, use full-disk encryption (BitLocker, FileVault,
/// LUKS) and then discard the key, or use the drive manufacturer's Secure Erase
/// command via hdparm (Linux) or NVMe sanitize.
///
/// Privilege note:
///   Linux  — requires root or a mount with the `discard` option for fstrim.
///   Windows — requires Administrator to run Optimize-Volume.
///   macOS  — TRIM is fully automatic; this returns an informational message.
pub fn trim_drive(drive_path: String) -> Result<TrimResult> {
    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("fstrim")
            .arg("--verbose")
            .arg(&drive_path)
            .output()
            .map_err(|e| {
                anyhow!(
                    "Failed to run fstrim (is it installed and do you have root?): {}",
                    e
                )
            })?;

        if output.status.success() {
            let msg = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok(TrimResult {
                success: true,
                drive: drive_path,
                message: if msg.is_empty() {
                    "TRIM completed successfully.".to_string()
                } else {
                    msg
                },
            });
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(anyhow!("fstrim failed: {}", stderr));
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // drive_path should be a single drive letter, e.g. "C"
        let drive_letter = drive_path.trim_end_matches([':', '\\', '/']);
        let script = format!(
            "Optimize-Volume -DriveLetter '{}' -ReTrim -Verbose",
            drive_letter
        );
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| anyhow!("Failed to run PowerShell: {}", e))?;

        if output.status.success() {
            return Ok(TrimResult {
                success: true,
                drive: drive_path,
                message: "TRIM completed successfully.".to_string(),
            });
        }

        // Parse stderr into a human-readable message rather than dumping raw output.
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let combined = format!("{}{}", stderr, stdout).to_lowercase();

        let friendly = if combined.contains("43022")
            || combined.contains("not supported by the hardware")
            || combined.contains("hardware backing the volume")
        {
            // RAM drives, virtual disks, USB drives, and some network volumes
            // do not support the TRIM/ReTrim operation at the hardware level.
            format!(
                "Drive '{}:' does not support TRIM. This is expected for RAM drives, \
                virtual disks, USB storage, and some network volumes — only physical \
                SSDs that expose TRIM support at the hardware level will work.",
                drive_letter
            )
        } else if combined.contains("administrator")
            || combined.contains("access is denied")
            || combined.contains("privilege")
        {
            "Administrator privileges are required to run TRIM. \
             Please restart the application as Administrator."
                .to_string()
        } else if combined.contains("no such drive")
            || combined.contains("cannot find")
            || combined.contains("invalid drive")
        {
            format!(
                "Drive letter '{}' was not found. \
                 Please enter a valid drive letter (e.g. C).",
                drive_letter
            )
        } else {
            // Unexpected error — show only the first non-empty line to avoid
            // dumping the full PowerShell stack trace.
            let first_line = stderr
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("Unknown error")
                .trim()
                .to_string();
            format!("TRIM did not complete: {}", first_line)
        };

        return Ok(TrimResult {
            success: false,
            drive: drive_path,
            message: friendly,
        });
    }

    #[cfg(target_os = "macos")]
    {
        // macOS has managed TRIM automatically since 10.10.4 for Apple SSDs,
        // and since Monterey the `diskutil secureErase freespace` command was removed.
        // There is no user-facing TRIM command — the OS handles it transparently.
        return Ok(TrimResult {
            success: true,
            drive: drive_path,
            message:
                "macOS manages TRIM automatically for compatible SSDs. No manual action is required."
                    .to_string(),
        });
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = drive_path; // <--- ADD THIS LINE to fix the warning
        return Err(anyhow!("TRIM is not supported on this platform."));
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CANCELLATION
// ═══════════════════════════════════════════════════════════════════════════

/// Signals the active operation (shred or wipe) to stop at the next check point.
pub fn cancel_shred() {
    // FIX #7: Signal the per-operation flag stored in the Mutex, not a bare global.
    let guard = OPERATION_FLAG.lock().unwrap();
    if let Some(flag) = &*guard {
        flag.store(true, Ordering::Relaxed);
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

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};

    fn create_temp_file(name: &str, content: &[u8]) -> PathBuf {
        let test_dir = std::env::temp_dir().join("qre_shredder_tests");
        fs::create_dir_all(&test_dir).unwrap();
        let path = test_dir.join(name);
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(content).unwrap();
        path
    }

    fn dummy_flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    // ── Validation & Safety ───────────────────────────────────────────────

    #[test]
    fn test_validate_path_safe_file() {
        let blacklist = build_blacklist();
        let path = create_temp_file("safe_shred.txt", b"Can be deleted");
        let result = validate_path(&path, &blacklist);
        assert!(result.is_ok(), "A normal user file should pass validation");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_validate_path_system_blacklist() {
        let blacklist = build_blacklist();

        #[cfg(target_os = "windows")]
        let bad_path = Path::new("C:\\Windows\\System32\\cmd.exe");
        #[cfg(not(target_os = "windows"))]
        let bad_path = Path::new("/bin/sh");

        let result = validate_path(bad_path, &blacklist);
        assert!(result.is_err());

        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("protected system directory")
                || err_msg.contains("Path does not exist")
                || err_msg.contains("Permission denied")
                || err_msg.contains("read-only"),
            "Failed with unexpected error: {}",
            err_msg
        );
    }

    #[cfg(target_os = "windows")]
    fn create_test_symlink(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(original, link)
    }
    #[cfg(not(target_os = "windows"))]
    fn create_test_symlink(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    #[test]
    fn test_validate_path_symlink_rejected() {
        let blacklist = build_blacklist();
        let test_dir = std::env::temp_dir().join("qre_shredder_tests_symlink");
        fs::create_dir_all(&test_dir).unwrap();

        let target = test_dir.join("target.txt");
        fs::File::create(&target).unwrap();
        let symlink = test_dir.join("link_to_target.txt");

        if create_test_symlink(&target, &symlink).is_ok() {
            let result = validate_path(&symlink, &blacklist);
            assert!(result.is_err());
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("Symlinks are not supported"));
            let _ = fs::remove_file(symlink);
        }

        let _ = fs::remove_file(target);
        let _ = fs::remove_dir_all(test_dir);
    }

    // ── Core Write Passes ─────────────────────────────────────────────────

    #[test]
    fn test_write_pass_zeros() {
        let path = create_temp_file("zeros.txt", b"SECRET DATA 12345");
        let file_size = fs::metadata(&path).unwrap().len();
        let flag = dummy_flag();

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        write_pass(&mut file, file_size, &ShredPass::Zeros, &flag).unwrap();

        file.seek(SeekFrom::Start(0)).unwrap();
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).unwrap();

        assert_eq!(buffer.len() as u64, file_size);
        for byte in buffer {
            assert_eq!(byte, 0x00);
        }

        drop(file);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_write_pass_pattern() {
        let path = create_temp_file("pattern.txt", b"SECRET DATA 12345");
        let file_size = fs::metadata(&path).unwrap().len();
        let flag = dummy_flag();

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        write_pass(&mut file, file_size, &ShredPass::Pattern(0xFF), &flag).unwrap();

        file.seek(SeekFrom::Start(0)).unwrap();
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).unwrap();

        for byte in buffer {
            assert_eq!(byte, 0xFF);
        }

        drop(file);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_write_pass_complement() {
        // 'A' = 0x41 (01000001) → complement = 0xBE (10111110)
        let path = create_temp_file("complement.txt", &[0x41, 0x41, 0x41]);
        let file_size = fs::metadata(&path).unwrap().len();
        let flag = dummy_flag();

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        write_pass(&mut file, file_size, &ShredPass::Complement, &flag).unwrap();

        file.seek(SeekFrom::Start(0)).unwrap();
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).unwrap();

        for byte in buffer {
            assert_eq!(byte, 0xBE);
        }

        drop(file);
        let _ = fs::remove_file(path);
    }

    // ── Gutmann Pass Count ────────────────────────────────────────────────

    #[test]
    fn test_gutmann_has_exactly_35_passes() {
        let passes = get_gutmann_passes();
        assert_eq!(
            passes.len(),
            35,
            "Gutmann method must have exactly 35 passes, got {}",
            passes.len()
        );
    }

    #[test]
    fn test_gutmann_starts_and_ends_with_random() {
        let passes = get_gutmann_passes();
        // First 4 must be Random
        for i in 0..4 {
            assert!(
                matches!(passes[i], ShredPass::Random),
                "Pass {} should be Random",
                i + 1
            );
        }
        // Last 4 must be Random
        for i in 31..35 {
            assert!(
                matches!(passes[i], ShredPass::Random),
                "Pass {} should be Random",
                i + 1
            );
        }
    }

    // ── Progress Percentage ───────────────────────────────────────────────

    #[test]
    fn test_percentage_does_not_hit_100_on_first_pass() {
        // With 1 file, 3 passes, 1000 bytes per file:
        // total_bytes_all = 3000
        // After pass 0 (first pass): bytes_done = 1 * 1000 = 1000
        // percentage = 1000/3000 * 100 = 33%
        let file_size: u64 = 1000;
        let total_passes: u64 = 3;
        let total_bytes_all = file_size * total_passes;
        let bytes_before: u64 = 0;
        let pass_num: u64 = 0; // first pass completed

        let bytes_done = bytes_before + (pass_num + 1) * file_size;
        let pct = (bytes_done as f64 / total_bytes_all as f64 * 100.0) as u8;

        assert_eq!(pct, 33, "First pass of 3 should be ~33%, not 100%");
    }

    #[test]
    fn test_percentage_reaches_100_on_final_pass() {
        let file_size: u64 = 1000;
        let total_passes: u64 = 3;
        let total_bytes_all = file_size * total_passes;
        let bytes_before: u64 = 0;
        let pass_num: u64 = 2; // third (final) pass completed

        let bytes_done = bytes_before + (pass_num + 1) * file_size;
        let pct = ((bytes_done as f64 / total_bytes_all as f64) * 100.0).min(100.0) as u8;

        assert_eq!(pct, 100);
    }

    // ── Formatting Helper ─────────────────────────────────────────────────

    #[test]
    fn test_format_size() {
        assert_eq!(format_size(500), "500 bytes");
        assert_eq!(format_size(1024), "1.00 KB");
        assert_eq!(format_size(1536), "1.50 KB");
        assert_eq!(format_size(1024 * 1024), "1.00 MB");
        assert_eq!(format_size(1024 * 1024 * 1024), "1.00 GB");
    }

    // ── Blacklist Built Once ──────────────────────────────────────────────

    #[test]
    fn test_build_blacklist_returns_canonical_paths() {
        let blacklist = build_blacklist();
        // Every path in the blacklist must be absolute.
        for p in &blacklist {
            assert!(p.is_absolute(), "Blacklist path {:?} is not absolute", p);
        }
    }

    // ── Cancellation ─────────────────────────────────────────────────────

    #[test]
    fn test_cancel_flag_stops_write_pass() {
        let path = create_temp_file("cancel_test.txt", &vec![0xAA; 4096]);
        let file_size = fs::metadata(&path).unwrap().len();

        let flag = Arc::new(AtomicBool::new(false));
        // Pre-set cancel so the loop exits immediately.
        flag.store(true, Ordering::Relaxed);

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let result = write_pass(&mut file, file_size, &ShredPass::Random, &flag);

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Cancelled"));

        drop(file);
        let _ = fs::remove_file(path);
    }
}

// --- END OF FILE shredder.rs ---
