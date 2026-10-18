//! Files on the operating system's clipboard, so that Copy in QRE can be pasted in Explorer and
//! files copied in Explorer can be pasted in QRE.
//!
//! A list of files on the Windows clipboard is a block of memory in the CF_HDROP format: a small
//! header (DROPFILES) and then the paths as UTF-16 text, each ending in a zero, with one more zero
//! after the last. Explorer also looks at a second entry, "Preferred DropEffect", to tell whether
//! the files were copied (1) or cut (2). Cut files are moved by the program that pastes them.
//!
//! The functions that build and read the block are plain byte work and run, and are tested, on
//! every system. Only the few calls that touch the clipboard itself are Windows-only. Other
//! systems report that they do not support it, and the Files screen then keeps its own list, so
//! Copy and Paste inside QRE work everywhere.

use anyhow::{anyhow, Result};

/// The most paths one clipboard list may hold. A larger list is refused, not cut short.
pub const MAX_PATHS: usize = 10_000;

/// The clipboard drop effect values Explorer uses.
pub const DROPEFFECT_COPY: u32 = 1;
pub const DROPEFFECT_MOVE: u32 = 2;

/// Size of the DROPFILES header: the offset to the paths (u32), a point (two i32), and two flags (u32).
const HEADER_LEN: usize = 20;

/// What the clipboard held.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ClipboardFiles {
    /// False on a system where QRE cannot use the clipboard for files. The screen then keeps its own list.
    pub supported: bool,
    pub paths: Vec<String>,
    /// True if the files were cut, so the program that pastes them should move them.
    pub cut: bool,
}

impl ClipboardFiles {
    #[cfg_attr(windows, allow(dead_code))]
    pub fn unsupported() -> Self {
        Self { supported: false, paths: Vec::new(), cut: false }
    }
    pub fn empty() -> Self {
        Self { supported: true, paths: Vec::new(), cut: false }
    }
}

/// Builds the CF_HDROP block for these paths: the header, then each path in UTF-16 with a zero
/// after it, then a final zero.
pub fn build_drop_list(paths: &[String]) -> Result<Vec<u8>> {
    if paths.is_empty() {
        return Err(anyhow!("There is nothing to put on the clipboard."));
    }
    if paths.len() > MAX_PATHS {
        return Err(anyhow!("Too many items for the clipboard ({} at most).", MAX_PATHS));
    }
    let mut bytes = Vec::with_capacity(HEADER_LEN + paths.iter().map(|p| p.len() * 2 + 2).sum::<usize>() + 2);
    bytes.extend_from_slice(&(HEADER_LEN as u32).to_le_bytes()); // where the paths start
    bytes.extend_from_slice(&0i32.to_le_bytes()); // point x
    bytes.extend_from_slice(&0i32.to_le_bytes()); // point y
    bytes.extend_from_slice(&0u32.to_le_bytes()); // not in a non-client area
    bytes.extend_from_slice(&1u32.to_le_bytes()); // the paths are UTF-16
    for path in paths {
        if path.is_empty() || path.contains('\0') {
            return Err(anyhow!("A path on the clipboard list is not valid."));
        }
        for unit in path.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    Ok(bytes)
}

/// Reads the paths out of a CF_HDROP block. A block that is cut short, points outside itself or
/// holds too many paths is refused. Paths that are not valid text are skipped.
pub fn parse_drop_list(bytes: &[u8]) -> Result<Vec<String>> {
    if bytes.len() < HEADER_LEN {
        return Err(anyhow!("The clipboard list is too short."));
    }
    let start = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let wide = u32::from_le_bytes(bytes[16..20].try_into().unwrap()) != 0;
    if start < HEADER_LEN || start > bytes.len() {
        return Err(anyhow!("The clipboard list is damaged."));
    }
    let body = &bytes[start..];
    let mut paths = Vec::new();

    if wide {
        let units: Vec<u16> = body.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        for part in units.split(|u| *u == 0) {
            if part.is_empty() {
                // Two zeros in a row end the list.
                break;
            }
            if paths.len() >= MAX_PATHS {
                return Err(anyhow!("The clipboard holds too many items."));
            }
            if let Ok(text) = String::from_utf16(part) {
                paths.push(text);
            }
        }
    } else {
        for part in body.split(|b| *b == 0) {
            if part.is_empty() {
                break;
            }
            if paths.len() >= MAX_PATHS {
                return Err(anyhow!("The clipboard holds too many items."));
            }
            if let Ok(text) = std::str::from_utf8(part) {
                paths.push(text.to_string());
            }
        }
    }
    Ok(paths)
}

/// Puts these files on the system clipboard, as a copy or as a cut. Replaces what was there.
/// `owner` is the window that owns the clipboard while it holds the files (Windows needs one).
#[cfg(windows)]
pub fn set_files(paths: &[String], cut: bool, owner: isize) -> Result<()> {
    let list = build_drop_list(paths)?;
    let effect = if cut { DROPEFFECT_MOVE } else { DROPEFFECT_COPY };
    win::set(&list, effect, owner)
}

#[cfg(not(windows))]
pub fn set_files(_paths: &[String], _cut: bool, _owner: isize) -> Result<()> {
    Err(anyhow!("Copying files to the system clipboard is not supported on this system."))
}

/// The files on the system clipboard, if it holds any.
#[cfg(windows)]
pub fn get_files(owner: isize) -> Result<ClipboardFiles> {
    match win::get(owner)? {
        None => Ok(ClipboardFiles::empty()),
        Some((list, effect)) => Ok(ClipboardFiles {
            supported: true,
            paths: parse_drop_list(&list)?,
            cut: effect.is_some_and(|e| e & DROPEFFECT_MOVE != 0),
        }),
    }
}

#[cfg(not(windows))]
pub fn get_files(_owner: isize) -> Result<ClipboardFiles> {
    Ok(ClipboardFiles::unsupported())
}

/// Takes a file list off the clipboard, but only if the clipboard holds one. Text, pictures and
/// anything else the user copied are left alone.
#[cfg(windows)]
pub fn clear_files(owner: isize) -> Result<()> {
    win::clear_if_files(owner)
}

#[cfg(not(windows))]
pub fn clear_files(_owner: isize) -> Result<()> {
    Ok(())
}

#[cfg(windows)]
mod win {
    use anyhow::{anyhow, Result};
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};

    const CF_HDROP: u32 = 15;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn drop_effect_format() -> u32 {
        // SAFETY: the argument is a valid, zero-ended UTF-16 string that lives for the call.
        unsafe { RegisterClipboardFormatW(wide("Preferred DropEffect").as_ptr()) }
    }

    /// The clipboard, open until this is dropped. Another program may hold it for a moment, so
    /// opening is tried a few times.
    struct Open;

    impl Open {
        fn new(owner: isize) -> Result<Self> {
            for _ in 0..20 {
                // SAFETY: `owner` is a window handle, or 0 for none.
                if unsafe { OpenClipboard(owner as *mut c_void) } != 0 {
                    return Ok(Open);
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            Err(anyhow!("The clipboard is in use by another program. Try again."))
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: the clipboard was opened by this thread in `Open::new`.
            unsafe { CloseClipboard() };
        }
    }

    /// Moves bytes into global memory, which is what the clipboard takes ownership of.
    fn global_copy(bytes: &[u8]) -> Result<HANDLE> {
        // SAFETY: the memory is allocated, locked, written within its size, and unlocked here.
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            if handle.is_null() {
                return Err(anyhow!("Out of memory."));
            }
            let target = GlobalLock(handle) as *mut u8;
            if target.is_null() {
                GlobalFree(handle);
                return Err(anyhow!("Could not use memory for the clipboard."));
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
            GlobalUnlock(handle);
            Ok(handle)
        }
    }

    pub fn set(list: &[u8], effect: u32, owner: isize) -> Result<()> {
        let _open = Open::new(owner)?;
        // SAFETY: the clipboard is open. Memory given to SetClipboardData belongs to the system
        // afterwards, and is freed here only if the call failed.
        unsafe {
            if EmptyClipboard() == 0 {
                return Err(anyhow!("Could not clear the clipboard."));
            }
            let files = global_copy(list)?;
            if SetClipboardData(CF_HDROP, files).is_null() {
                GlobalFree(files);
                return Err(anyhow!("Could not put the files on the clipboard."));
            }
            let flag = global_copy(&effect.to_le_bytes())?;
            if SetClipboardData(drop_effect_format(), flag).is_null() {
                GlobalFree(flag);
                // The files are on the clipboard without a copy or cut flag. Explorer treats that as a copy.
            }
        }
        Ok(())
    }

    /// Copies the bytes of a clipboard entry, or None if there is no such entry.
    fn read(format: u32) -> Option<Vec<u8>> {
        // SAFETY: the clipboard is open (the caller holds `Open`). The memory is locked while read
        // and only up to its own size.
        unsafe {
            if IsClipboardFormatAvailable(format) == 0 {
                return None;
            }
            let handle = GetClipboardData(format);
            if handle.is_null() {
                return None;
            }
            let size = GlobalSize(handle);
            let source = GlobalLock(handle) as *const u8;
            if source.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(source, size).to_vec();
            GlobalUnlock(handle);
            Some(bytes)
        }
    }

    pub fn get(owner: isize) -> Result<Option<(Vec<u8>, Option<u32>)>> {
        let _open = Open::new(owner)?;
        let Some(list) = read(CF_HDROP) else { return Ok(None) };
        let effect = read(drop_effect_format()).and_then(|b| b.get(0..4).map(|b| u32::from_le_bytes(b.try_into().unwrap())));
        Ok(Some((list, effect)))
    }

    pub fn clear_if_files(owner: isize) -> Result<()> {
        let _open = Open::new(owner)?;
        // SAFETY: the clipboard is open.
        unsafe {
            if IsClipboardFormatAvailable(CF_HDROP) != 0 {
                EmptyClipboard();
            }
        }
        Ok(())
    }
}
