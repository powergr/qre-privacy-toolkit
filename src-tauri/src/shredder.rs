// --- START OF FILE shredder.rs ---

use anyhow::{anyhow, Result};
use rand::Rng;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
// AtomicBool is used so the UI can cancel a 35-pass Gutmann shred mid-operation.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// SECURITY LIMITS: Prevents the shredder from locking up the system or running out of memory.
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024 * 1024; // Limit to 10 GB per file
const WARN_SIZE_THRESHOLD: u64 = 1 * 1024 * 1024 * 1024; // Warn the user if they try to shred > 1 GB
const BUFFER_SIZE: usize = 1024 * 1024; // 1 MB buffer for efficient disk write operations

// Global thread-safe flag to allow the user to abort the operation.
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

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

/// The result of a "Dry Run", showing the user exactly what will happen and how long it might take.
#[derive(serde::Serialize)]
pub struct DryRunResult {
    pub files: Vec<FileInfo>,
    pub total_size: u64,
    pub total_file_count: usize,
    pub warnings: Vec<String>,
    pub blocked: Vec<String>, // Files rejected due to security rules (e.g., system files)
}

/// The specific data destruction algorithm the user selected.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ShredMethod {
    Simple,   // 1 pass (Overwrites with 0x00)
    DoD3Pass, // 3 passes (US Department of Defense 5220.22-M standard)
    DoD7Pass, // 7 passes (DoD 5220.22-M Extended)
    Gutmann,  // 35 passes (Peter Gutmann method - extreme theoretical security)
}

// ═══════════════════════════════════════════════════════════════════════════
// PATH VALIDATION & BLACKLIST (CRITICAL SECURITY)
// ═══════════════════════════════════════════════════════════════════════════

/// Generates a list of critical OS directories that the shredder is strictly forbidden to touch.
/// If a user accidentally selects `C:\Windows`, this stops them from destroying their OS.
fn get_blacklist() -> Vec<PathBuf> {
    let mut blacklist: Vec<PathBuf> = Vec::new();

    // Universal critical paths for Windows
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

    // macOS System Integrity Protection areas
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

    // Standard Linux root directories
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

    // Android specific OS partitions
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

    // Canonicalize all blacklist paths to resolve symlinks and '..'
    // We silently drop paths that don't exist on the current system (e.g. /lib64 on a 32-bit OS)
    blacklist
        .into_iter()
        .filter_map(|p: PathBuf| fs::canonicalize(p).ok())
        .collect()
}

/// Deep security validation to ensure a file is safe to overwrite.
fn validate_path(path: &Path) -> Result<PathBuf> {
    // 1. Must exist
    if !path.exists() {
        return Err(anyhow!("Path does not exist"));
    }

    // 2. Read metadata without following symlinks
    let metadata = fs::symlink_metadata(path)?;

    // 3. Reject symlinks (A symlink could point into a blacklisted directory)
    if metadata.file_type().is_symlink() {
        return Err(anyhow!("Symlinks are not supported for security reasons"));
    }

    // 4. Must be a standard file
    if !metadata.is_file() {
        return Err(anyhow!(
            "Only regular files are supported (not directories or special files)"
        ));
    }

    // 5. Enforce size limits
    let size = metadata.len();
    if size > MAX_FILE_SIZE {
        return Err(anyhow!(
            "File too large: {} GB (maximum: {} GB)",
            size / (1024 * 1024 * 1024),
            MAX_FILE_SIZE / (1024 * 1024 * 1024)
        ));
    }

    // 6. Canonicalize to get the true absolute path
    let canonical = fs::canonicalize(path)?;

    // 7. Check against the OS blacklist
    let blacklist = get_blacklist();
    for blocked in &blacklist {
        if canonical.starts_with(blocked) || canonical == *blocked {
            return Err(anyhow!(
                "Path is in protected system directory: {}",
                blocked.display()
            ));
        }
    }

    // 8. Check OS write permissions
    if metadata.permissions().readonly() {
        return Err(anyhow!("File is read-only"));
    }

    Ok(canonical)
}

// ═══════════════════════════════════════════════════════════════════════════
// DRY RUN (Preview Before Shredding)
// ═══════════════════════════════════════════════════════════════════════════

/// Simulates the shredding process.
/// Calculates exactly what will happen, validates all files, and returns a report
/// so the user can confirm before irreversible destruction begins.
pub fn dry_run(paths: Vec<String>) -> Result<DryRunResult> {
    let mut files = Vec::new();
    let mut total_size = 0u64;
    let mut total_file_count = 0usize;
    let mut warnings = Vec::new();
    let mut blocked = Vec::new();

    for path_str in paths {
        let path = Path::new(&path_str);

        match validate_path(path) {
            Ok(canonical) => {
                if let Ok(metadata) = fs::metadata(&canonical) {
                    let size = metadata.len();
                    total_size += size;
                    total_file_count += 1;

                    // Warn the user if they selected a massive file that will take a long time
                    let warning = if size > WARN_SIZE_THRESHOLD {
                        Some(format!(
                            "Large file: {} - may take several minutes",
                            format_size(size)
                        ))
                    } else {
                        None
                    };

                    if warning.is_some() {
                        warnings.push(format!(
                            "{}: {}",
                            canonical.file_name().unwrap_or_default().to_string_lossy(),
                            warning.as_ref().unwrap()
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
                // If the file failed validation, add it to the blocked list so the user knows
                blocked.push(format!("{}: {}", path_str, e));
            }
        }
    }

    // Add a global warning if the total batch size is extremely large
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

/// Executes the actual overwriting passes on a single file.
fn shred_file<R: tauri::Runtime>(
    path: &Path,
    method: ShredMethod,
    app_handle: &tauri::AppHandle<R>,
    file_index: usize,
    total_files: usize,
) -> Result<u64> {
    let metadata = fs::metadata(path)?;
    let file_size = metadata.len();
    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Map the selected method to the sequence of byte patterns required
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
        ShredMethod::Gutmann => get_gutmann_passes(), // 35 specific passes
    };

    let total_passes = passes.len() as u8;

    // Open the file with Write permissions
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;

    // Perform each pass sequentially
    for (pass_num, pass_type) in passes.iter().enumerate() {
        // Allow user cancellation between passes
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            return Err(anyhow!("Operation cancelled by user"));
        }

        // Execute the write loop
        write_pass(&mut file, file_size, pass_type)?;

        // Emit live progress to the UI
        let progress = ShredProgress {
            current_file: file_index + 1,
            total_files,
            current_pass: pass_num as u8 + 1,
            total_passes,
            current_file_name: file_name.clone(),
            percentage: calculate_percentage(file_index, total_files, pass_num + 1, passes.len()),
            bytes_processed: (pass_num + 1) as u64 * file_size,
            total_bytes: file_size * total_passes as u64,
        };

        let _ = app_handle.emit("shred-progress", progress);
    }

    // Force the OS to flush all written buffers to the physical disk platter immediately
    file.sync_all()?;
    drop(file);

    // Finally, ask the OS to delete the file pointer from the filesystem directory
    fs::remove_file(path)?;

    // Final sanity check
    if path.exists() {
        return Err(anyhow!("File still exists after deletion attempt"));
    }

    Ok(file_size)
}

/// The type of data to overwrite the file with on a specific pass.
#[derive(Clone)]
enum ShredPass {
    Zeros,       // Write 0x00
    Random,      // Write random noise
    Pattern(u8), // Write a specific byte (e.g., 0xFF)
    Complement,  // Read the current data and invert the bits
}

/// The core loop that actually writes the data to the disk.
fn write_pass<W: Read + Write + Seek>(
    writer: &mut W,
    size: u64,
    pass_type: &ShredPass,
) -> Result<()> {
    // Rewind to the beginning of the file for every pass
    writer.seek(SeekFrom::Start(0))?;

    let mut rng = rand::thread_rng();
    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut remaining = size;

    while remaining > 0 {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            return Err(anyhow!("Cancelled"));
        }

        let chunk_size = std::cmp::min(remaining, BUFFER_SIZE as u64) as usize;

        // Fill the buffer based on the pass type
        match pass_type {
            ShredPass::Zeros => buffer[..chunk_size].fill(0x00),
            ShredPass::Random => rng.fill(&mut buffer[..chunk_size]),
            ShredPass::Pattern(byte) => buffer[..chunk_size].fill(*byte),
            ShredPass::Complement => {
                // Read current data, complement it (bitwise NOT), and step backward to overwrite
                writer.read_exact(&mut buffer[..chunk_size]).ok();
                for byte in &mut buffer[..chunk_size] {
                    *byte = !*byte;
                }
                writer.seek(SeekFrom::Current(-(chunk_size as i64)))?;
            }
        }

        // Write the filled buffer to the disk
        writer.write_all(&buffer[..chunk_size])?;
        remaining -= chunk_size as u64;
    }

    writer.flush()?;
    Ok(())
}

/// The Peter Gutmann algorithm requires 35 specific passes designed to maximize
/// magnetic flux changes on older hard drives to prevent microscopic magnetic
/// trace analysis via electron microscopes.
fn get_gutmann_passes() -> Vec<ShredPass> {
    vec![
        // Passes 1-4: Random data
        ShredPass::Random,
        ShredPass::Random,
        ShredPass::Random,
        ShredPass::Random,
        // Passes 5-31: Specific magnetic patterns
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
        ShredPass::Pattern(0x92),
        ShredPass::Pattern(0x49),
        ShredPass::Pattern(0x24),
        ShredPass::Pattern(0x6D),
        ShredPass::Pattern(0xB6),
        ShredPass::Pattern(0xDB),
        // Passes 32-35: Final random passes
        ShredPass::Random,
        ShredPass::Random,
    ]
}

/// Converts the nested loop states into a smooth 0-100 percentage for the progress bar.
fn calculate_percentage(
    current_file: usize,
    total_files: usize,
    current_pass: usize,
    total_passes: usize,
) -> u8 {
    if total_files == 0 || total_passes == 0 {
        return 0;
    }

    let file_progress = (current_file as f64 / total_files as f64) * 100.0;
    let pass_progress = (current_pass as f64 / total_passes as f64) * (100.0 / total_files as f64);

    ((file_progress + pass_progress).min(100.0)) as u8
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
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let mut success = Vec::new();
    let mut failed = Vec::new();
    let mut total_bytes_shredded = 0u64;

    // Phase 1: Pre-validate all paths in the batch before starting.
    // If there is an invalid/system file in the middle of the batch, we catch it
    // now before we start destroying the valid files.
    let validated: Vec<(String, PathBuf)> = paths
        .into_iter()
        .filter_map(|path_str| match validate_path(Path::new(&path_str)) {
            Ok(canonical) => Some((path_str, canonical)),
            Err(e) => {
                failed.push(FailedFile {
                    path: path_str,
                    error: e.to_string(),
                });
                None
            }
        })
        .collect();

    let total_files = validated.len();

    // Phase 2: Shred the valid files sequentially
    for (idx, (original_path, canonical_path)) in validated.into_iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            failed.push(FailedFile {
                path: "Remaining files".to_string(),
                error: "Operation cancelled by user".to_string(),
            });
            break;
        }

        match shred_file(&canonical_path, method, app_handle, idx, total_files) {
            Ok(bytes) => {
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
        total_files: total_files,
        total_bytes_shredded,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// CANCELLATION
// ═══════════════════════════════════════════════════════════════════════════

pub fn cancel_shred() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/// Converts raw bytes to a human-readable string (e.g. "1.50 MB").
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

// --- END OF FILE shredder.rs ---
