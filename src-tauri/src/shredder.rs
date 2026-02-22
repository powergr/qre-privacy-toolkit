use anyhow::{anyhow, Result};
use rand::Rng;
use std::fs::{self, OpenOptions};
use std::io::{Seek, Read, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024 * 1024; // 10 GB per file
const WARN_SIZE_THRESHOLD: u64 = 1 * 1024 * 1024 * 1024; // 1 GB warning
const BUFFER_SIZE: usize = 1024 * 1024; // 1 MB buffer for writing

// Global cancellation flag
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

// ═══════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════

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

#[derive(serde::Serialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
    pub file_count: usize,
    pub warning: Option<String>,
}

#[derive(serde::Serialize)]
pub struct DryRunResult {
    pub files: Vec<FileInfo>,
    pub total_size: u64,
    pub total_file_count: usize,
    pub warnings: Vec<String>,
    pub blocked: Vec<String>,
}

#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ShredMethod {
    Simple,      // 1 pass (zeros)
    DoD3Pass,    // 3 passes (DoD 5220.22-M)
    DoD7Pass,    // 7 passes (DoD 5220.22-M Extended)
    Gutmann,     // 35 passes (Peter Gutmann method)
}

// ═══════════════════════════════════════════════════════════════════════════
// PATH VALIDATION & BLACKLIST (CRITICAL SECURITY)
// ═══════════════════════════════════════════════════════════════════════════

/// Gets system directory blacklist - directories that should NEVER be deleted.
fn get_blacklist() -> Vec<PathBuf> {
    let mut blacklist = Vec::new();

    // Universal critical paths
    #[cfg(target_os = "windows")]
    {
        if let Ok(sys_drive) = std::env::var("SystemDrive") {

            
            blacklist.push(PathBuf::from(format!("{}\\Windows", sys_drive)));
            blacklist.push(PathBuf::from(format!("{}\\Program Files", sys_drive)));
            blacklist.push(PathBuf::from(format!("{}\\Program Files (x86)", sys_drive)));
            blacklist.push(PathBuf::from(format!("{}\\ProgramData", sys_drive))); // Added for extra security
            blacklist.push(PathBuf::from(format!("{}\\Users\\Default", sys_drive))); // Added for extra security
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

    // Canonicalize all blacklist paths
    blacklist
        .into_iter()
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect()
}

/// Validates a path is safe to shred.
///
/// SECURITY CHECKS:
/// 1. Path must exist
/// 2. Must be a regular file (not device, pipe, socket)
/// 3. Must not be a symlink
/// 4. File size must be within limits
/// 5. Must not be in system directory blacklist
/// 6. Must have proper permissions
fn validate_path(path: &Path) -> Result<PathBuf> {
    // 1. Check existence
    if !path.exists() {
        return Err(anyhow!("Path does not exist"));
    }

    // 2. Use symlink_metadata (doesn't follow symlinks)
    let metadata = fs::symlink_metadata(path)?;

    // 3. Reject symlinks
    if metadata.file_type().is_symlink() {
        return Err(anyhow!("Symlinks are not supported for security reasons"));
    }

    // 4. Must be regular file
    if !metadata.is_file() {
        return Err(anyhow!("Only regular files are supported (not directories or special files)"));
    }

    // 5. Check file size
    let size = metadata.len();
    if size > MAX_FILE_SIZE {
        return Err(anyhow!(
            "File too large: {} GB (maximum: {} GB)",
            size / (1024 * 1024 * 1024),
            MAX_FILE_SIZE / (1024 * 1024 * 1024)
        ));
    }

    // 6. Canonicalize
    let canonical = fs::canonicalize(path)?;

    // 7. Check against blacklist
    let blacklist = get_blacklist();
    for blocked in &blacklist {
        if canonical.starts_with(blocked) || canonical == *blocked {
            return Err(anyhow!(
                "Path is in protected system directory: {}",
                blocked.display()
            ));
        }
    }

    // 8. Check permissions (must be writable)
    if metadata.permissions().readonly() {
        return Err(anyhow!("File is read-only"));
    }

    Ok(canonical)
}

// ═══════════════════════════════════════════════════════════════════════════
// DRY RUN (Preview Before Shredding)
// ═══════════════════════════════════════════════════════════════════════════

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

/// Shreds a single file with specified method.
fn shred_file<R: tauri::Runtime>(
    path: &Path,
    method: ShredMethod,
    app_handle: &tauri::AppHandle<R>,
    file_index: usize,
    total_files: usize,
) -> Result<u64> {
    let metadata = fs::metadata(path)?;
    let file_size = metadata.len();
    let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

    let passes = match method {
        ShredMethod::Simple => vec![ShredPass::Zeros],
        ShredMethod::DoD3Pass => vec![
            ShredPass::Random,
            ShredPass::Complement,
            ShredPass::Random,
        ],
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

    // Open file for writing
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;

    // Perform passes
    for (pass_num, pass_type) in passes.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            return Err(anyhow!("Operation cancelled by user"));
        }

        write_pass(&mut file, file_size, pass_type)?;

        // Emit progress
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

    // Sync to disk
    file.sync_all()?;
    drop(file);

    // Delete the file
    fs::remove_file(path)?;

    // Verify deletion
    if path.exists() {
        return Err(anyhow!("File still exists after deletion attempt"));
    }

    Ok(file_size)
}

#[derive(Clone)]
enum ShredPass {
    Zeros,
    Random,
    Pattern(u8),
    Complement,
}

fn write_pass<W: Read + Write + Seek>(writer: &mut W, size: u64, pass_type: &ShredPass) -> Result<()> {
    writer.seek(SeekFrom::Start(0))?;

    let mut rng = rand::thread_rng();
    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut remaining = size;

    while remaining > 0 {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            return Err(anyhow!("Cancelled"));
        }

        let chunk_size = std::cmp::min(remaining, BUFFER_SIZE as u64) as usize;

        match pass_type {
            ShredPass::Zeros => buffer[..chunk_size].fill(0x00),
            ShredPass::Random => rng.fill(&mut buffer[..chunk_size]),
            ShredPass::Pattern(byte) => buffer[..chunk_size].fill(*byte),
            ShredPass::Complement => {
                // Read current data and complement it
                writer.read_exact(&mut buffer[..chunk_size]).ok();
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

fn get_gutmann_passes() -> Vec<ShredPass> {
    vec![
        // Random passes
        ShredPass::Random,
        ShredPass::Random,
        ShredPass::Random,
        ShredPass::Random,
        // Specific patterns for various encoding methods
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
        // Final random passes
        ShredPass::Random,
        ShredPass::Random,
    ]
}

fn calculate_percentage(current_file: usize, total_files: usize, current_pass: usize, total_passes: usize) -> u8 {
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

pub fn batch_shred<R: tauri::Runtime>(
    paths: Vec<String>,
    method: ShredMethod,
    app_handle: &tauri::AppHandle<R>,
) -> Result<ShredResult> {
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let mut success = Vec::new();
    let mut failed = Vec::new();
    let mut total_bytes_shredded = 0u64;

    // Validate all paths first
    let validated: Vec<(String, PathBuf)> = paths
        .into_iter()
        .filter_map(|path_str| {
            match validate_path(Path::new(&path_str)) {
                Ok(canonical) => Some((path_str, canonical)),
                Err(e) => {
                    failed.push(FailedFile {
                        path: path_str,
                        error: e.to_string(),
                    });
                    None
                }
            }
        })
        .collect();

    let total_files = validated.len();

    // Shred each file
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
