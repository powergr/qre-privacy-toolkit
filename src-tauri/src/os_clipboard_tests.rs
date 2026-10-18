//! Files on the system clipboard. The first groups need no clipboard: they check the exact bytes
//! of the list that Explorer reads and writes, the checks on the paths, and how the commands are
//! wired. The last group talks to the real Windows clipboard, changes it, and is therefore ignored
//! unless asked for: run it with `cargo test --lib clipboard_real -- --ignored --test-threads=1`.

use crate::commands::files::{check_clipboard_paths, usable_clipboard_paths};
use crate::crypto_failure_tests::{fresh_dir, function_body, write};
use crate::os_clipboard::{build_drop_list, parse_drop_list, ClipboardFiles, DROPEFFECT_COPY, DROPEFFECT_MOVE, MAX_PATHS};

fn s(text: &str) -> String {
    text.to_string()
}

fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
}

// ─── The block ───────────────────────────────────────────────────────────────

#[test]
fn test_the_list_for_one_path_has_exactly_the_bytes_explorer_expects() {
    let bytes = build_drop_list(&[s("C:\\a.txt")]).unwrap();

    let mut expected: Vec<u8> = Vec::new();
    expected.extend_from_slice(&20u32.to_le_bytes()); // the paths start after the 20 byte header
    expected.extend_from_slice(&[0u8; 8]); // a point, unused
    expected.extend_from_slice(&0u32.to_le_bytes()); // not in a non-client area
    expected.extend_from_slice(&1u32.to_le_bytes()); // the paths are UTF-16
    expected.extend(utf16("C:\\a.txt"));
    expected.extend_from_slice(&[0, 0]); // the end of this path
    expected.extend_from_slice(&[0, 0]); // the end of the list

    assert_eq!(bytes, expected);
}

#[test]
fn test_several_paths_follow_each_other_with_one_zero_between_and_two_at_the_end() {
    let bytes = build_drop_list(&[s("C:\\a.txt"), s("D:\\b c.txt")]).unwrap();
    let mut body = utf16("C:\\a.txt");
    body.extend_from_slice(&[0, 0]);
    body.extend(utf16("D:\\b c.txt"));
    body.extend_from_slice(&[0, 0, 0, 0]);
    assert_eq!(&bytes[20..], &body[..]);
}

#[test]
fn test_what_is_built_is_read_back_the_same() {
    let paths = vec![
        s("C:\\Users\\me\\report.pdf"),
        s("C:\\Users\\me\\Café résumé (final).txt"),
        s("D:\\日本語\\ファイル.pdf"),
        s("E:\\emoji 😀\\photo 📷.jpg"),
        s("\\\\server\\share\\folder\\file.bin"),
        s("C:\\folder with spaces\\and.dots.in.name.tar.gz"),
    ];
    assert_eq!(parse_drop_list(&build_drop_list(&paths).unwrap()).unwrap(), paths);
}

#[test]
fn test_a_path_longer_than_260_characters_survives() {
    let long = format!("C:\\{}\\file.txt", "x".repeat(300));
    assert_eq!(parse_drop_list(&build_drop_list(&[long.clone()]).unwrap()).unwrap(), vec![long]);
}

#[test]
fn test_ten_thousand_paths_are_the_most_and_one_more_is_refused() {
    let many: Vec<String> = (0..MAX_PATHS).map(|i| format!("C:\\f{}.txt", i)).collect();
    let bytes = build_drop_list(&many).unwrap();
    assert_eq!(parse_drop_list(&bytes).unwrap().len(), MAX_PATHS);

    let too_many: Vec<String> = (0..=MAX_PATHS).map(|i| format!("C:\\f{}.txt", i)).collect();
    assert!(build_drop_list(&too_many).is_err());
}

#[test]
fn test_an_empty_list_an_empty_path_and_a_path_with_a_zero_are_refused() {
    assert!(build_drop_list(&[]).is_err());
    assert!(build_drop_list(&[s("")]).is_err());
    assert!(build_drop_list(&[s("C:\\a\0b.txt")]).is_err());
    assert!(build_drop_list(&[s("C:\\ok.txt"), s("")]).is_err());
}

// ─── Reading what other programs wrote ───────────────────────────────────────

fn block(start: u32, wide: u32, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&start.to_le_bytes());
    bytes.extend_from_slice(&[0u8; 8]);
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&wide.to_le_bytes());
    bytes.extend_from_slice(body);
    bytes
}

#[test]
fn test_a_block_shorter_than_its_header_is_refused() {
    assert!(parse_drop_list(&[]).is_err());
    assert!(parse_drop_list(&[0u8; 19]).is_err());
}

#[test]
fn test_a_start_that_points_into_the_header_or_past_the_end_is_refused() {
    let mut body = utf16("C:\\a.txt");
    body.extend_from_slice(&[0, 0, 0, 0]);
    assert!(parse_drop_list(&block(0, 1, &body)).is_err());
    assert!(parse_drop_list(&block(19, 1, &body)).is_err());
    assert!(parse_drop_list(&block(20 + body.len() as u32 + 1, 1, &body)).is_err());
    assert!(parse_drop_list(&block(u32::MAX, 1, &body)).is_err());
}

#[test]
fn test_a_start_after_the_header_skips_what_is_in_between() {
    let mut body = vec![0xAA; 6]; // padding some program put there
    body.extend(utf16("C:\\a.txt"));
    body.extend_from_slice(&[0, 0, 0, 0]);
    assert_eq!(parse_drop_list(&block(26, 1, &body)).unwrap(), vec![s("C:\\a.txt")]);
}

#[test]
fn test_the_list_ends_at_the_first_empty_entry_and_ignores_what_follows() {
    let mut body = utf16("C:\\a.txt");
    body.extend_from_slice(&[0, 0, 0, 0]);
    body.extend(utf16("C:\\ignored.txt"));
    body.extend_from_slice(&[0, 0, 0, 0]);
    assert_eq!(parse_drop_list(&block(20, 1, &body)).unwrap(), vec![s("C:\\a.txt")]);
}

#[test]
fn test_a_list_whose_last_path_lacks_its_zero_is_still_read() {
    let body = utf16("C:\\a.txt");
    assert_eq!(parse_drop_list(&block(20, 1, &body)).unwrap(), vec![s("C:\\a.txt")]);
}

#[test]
fn test_a_list_with_nothing_in_it_gives_no_paths() {
    assert_eq!(parse_drop_list(&block(20, 1, &[0, 0, 0, 0])).unwrap(), Vec::<String>::new());
    assert_eq!(parse_drop_list(&block(20, 1, &[])).unwrap(), Vec::<String>::new());
}

#[test]
fn test_a_stray_odd_byte_at_the_end_is_ignored() {
    let mut body = utf16("C:\\a.txt");
    body.extend_from_slice(&[0, 0, 0, 0, 0x41]);
    assert_eq!(parse_drop_list(&block(20, 1, &body)).unwrap(), vec![s("C:\\a.txt")]);
}

#[test]
fn test_text_that_is_not_valid_utf16_is_skipped_and_the_rest_is_kept() {
    let mut body = utf16("C:\\one.txt");
    body.extend_from_slice(&[0, 0]);
    body.extend_from_slice(&[0x00, 0xD8, 0x41, 0x00]); // a lone high surrogate, then "A"
    body.extend_from_slice(&[0, 0]);
    body.extend(utf16("C:\\three.txt"));
    body.extend_from_slice(&[0, 0, 0, 0]);
    assert_eq!(parse_drop_list(&block(20, 1, &body)).unwrap(), vec![s("C:\\one.txt"), s("C:\\three.txt")]);
}

#[test]
fn test_a_list_in_the_old_single_byte_form_is_read_as_text() {
    let mut body = b"C:\\a.txt".to_vec();
    body.push(0);
    body.extend_from_slice(b"C:\\b.txt");
    body.extend_from_slice(&[0, 0]);
    assert_eq!(parse_drop_list(&block(20, 0, &body)).unwrap(), vec![s("C:\\a.txt"), s("C:\\b.txt")]);
}

#[test]
fn test_a_list_that_holds_more_than_the_limit_is_refused() {
    let mut body = Vec::new();
    for i in 0..=MAX_PATHS {
        body.extend(utf16(&format!("C:\\f{}", i)));
        body.extend_from_slice(&[0, 0]);
    }
    body.extend_from_slice(&[0, 0]);
    assert!(parse_drop_list(&block(20, 1, &body)).is_err());
}

#[test]
fn test_random_bytes_never_crash_the_reader() {
    // Garbage in every shape: no panic, just an error or a short list.
    let mut state: u64 = 0x1234_5678_9ABC_DEF0;
    for len in 0..300usize {
        let bytes: Vec<u8> = (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect();
        let _ = parse_drop_list(&bytes);
    }
}

#[test]
fn test_the_drop_effect_values_are_the_ones_explorer_uses() {
    assert_eq!(DROPEFFECT_COPY, 1);
    assert_eq!(DROPEFFECT_MOVE, 2);
}

// ─── The checks on paths ─────────────────────────────────────────────────────

#[test]
fn test_files_that_exist_may_be_copied() {
    let base = fresh_dir("qre_clip_ok");
    let a = write(&base, "a.txt", b"a");
    let folder = base.join("sub");
    std::fs::create_dir_all(&folder).unwrap();
    assert!(check_clipboard_paths(&[a, folder.to_str().unwrap().to_string()]).is_ok());
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn test_nothing_to_copy_a_missing_file_a_relative_path_and_dots_are_refused() {
    let base = fresh_dir("qre_clip_bad");
    let real = write(&base, "a.txt", b"a");
    let missing = base.join("gone.txt").to_str().unwrap().to_string();

    assert!(check_clipboard_paths(&[]).unwrap_err().contains("Nothing is selected"));
    let gone = check_clipboard_paths(&[real.clone(), missing]).unwrap_err();
    assert!(gone.contains("no longer exists"), "{}", gone);
    assert!(check_clipboard_paths(&[s("relative/file.txt")]).unwrap_err().contains("not a full path"));
    std::fs::create_dir_all(base.join("sub")).unwrap();
    let dots = format!("{}/sub/../a.txt", base.to_str().unwrap());
    assert!(std::path::Path::new(&dots).exists(), "the test needs a path that exists");
    assert!(check_clipboard_paths(&[dots]).unwrap_err().contains("Path traversal"));
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn test_only_existing_plain_paths_from_another_program_are_offered_for_pasting() {
    let base = fresh_dir("qre_clip_found");
    let real = write(&base, "a.txt", b"a");
    std::fs::create_dir_all(base.join("sub")).unwrap();
    // This one exists, but only by way of "..", so it must still be left out.
    let with_dots = format!("{}/sub/../a.txt", base.to_str().unwrap());
    assert!(std::path::Path::new(&with_dots).exists(), "the test needs a path that exists");
    let mut found = ClipboardFiles {
        supported: true,
        paths: vec![real.clone(), base.join("gone.txt").to_str().unwrap().to_string(), s("relative.txt"), with_dots],
        cut: true,
    };
    usable_clipboard_paths(&mut found);
    assert_eq!(found.paths, vec![real]);
    assert!(found.cut && found.supported, "the other fields must be kept");
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn test_the_clipboard_states_are_what_the_screen_expects() {
    let none = ClipboardFiles::empty();
    assert!(none.supported && none.paths.is_empty() && !none.cut);
    let unsupported = ClipboardFiles::unsupported();
    assert!(!unsupported.supported && unsupported.paths.is_empty() && !unsupported.cut);
    let json = serde_json::to_value(&unsupported).unwrap();
    assert_eq!(json, serde_json::json!({ "supported": false, "paths": [], "cut": false }));
}

#[cfg(not(windows))]
#[test]
fn test_where_the_system_clipboard_is_not_used_the_calls_say_so_without_failing() {
    assert!(crate::os_clipboard::set_files(&[s("/tmp/a")], false, 0).is_err());
    assert_eq!(crate::os_clipboard::get_files(0).unwrap(), ClipboardFiles::unsupported());
    assert!(crate::os_clipboard::clear_files(0).is_ok());
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

#[test]
fn test_the_commands_check_before_they_touch_the_clipboard_and_after_they_read_it() {
    let files = include_str!("commands/files.rs");
    let set = function_body(files, "pub fn set_clipboard_files(");
    assert!(set.contains("check_clipboard_paths(&paths)?"), "paths are no longer checked before copying");
    assert!(set.find("check_clipboard_paths").unwrap() < set.find("os_clipboard::set_files").unwrap());
    let get = function_body(files, "pub fn get_clipboard_files(");
    assert!(get.contains("usable_clipboard_paths(&mut found)"), "what another program put there is no longer filtered");
    assert!(function_body(files, "pub fn clear_clipboard_files(").contains("os_clipboard::clear_files("));
}

#[test]
fn test_the_three_commands_are_registered() {
    let lib = include_str!("lib.rs");
    for name in ["set_clipboard_files", "get_clipboard_files", "clear_clipboard_files"] {
        assert!(lib.contains(&format!("commands::files::{}", name)), "{} is not registered", name);
    }
}

#[test]
fn test_the_windows_calls_open_the_clipboard_through_one_guard_that_always_closes_it() {
    let source = include_str!("os_clipboard.rs");
    assert!(function_body(source, "fn drop(&mut self)").contains("CloseClipboard()"));
    for name in ["pub fn set(", "pub fn get(", "pub fn clear_if_files("] {
        assert!(function_body(source, name).contains("Open::new(owner)?"), "{} opens the clipboard by itself", name);
    }
}

// ─── The real Windows clipboard ──────────────────────────────────────────────

#[cfg(windows)]
mod clipboard_real {
    //! These change the clipboard of the machine that runs them. Run them with
    //! `cargo test --lib clipboard_real -- --ignored --test-threads=1`.
    use super::*;
    use crate::os_clipboard::{clear_files, get_files, set_files};
    use std::ffi::c_void;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
        SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::UI::Shell::DragQueryFileW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE};

    /// A window with no screen, only to own the clipboard, as the app's own window does.
    struct Owner(isize);
    impl Owner {
        fn new() -> Self {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            // SAFETY: STATIC is a built-in window class; a message-only window needs no message loop.
            let hwnd = unsafe {
                CreateWindowExW(0, class.as_ptr(), std::ptr::null(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
            };
            assert!(!hwnd.is_null(), "could not make a window to own the clipboard");
            Owner(hwnd as isize)
        }
    }
    impl Drop for Owner {
        fn drop(&mut self) {
            // SAFETY: the window was made in `new` and is destroyed once.
            unsafe { DestroyWindow(self.0 as *mut c_void) };
        }
    }

    fn files(test: &str, names: &[&str]) -> (std::path::PathBuf, Vec<String>) {
        let base = fresh_dir(test);
        let paths = names.iter().map(|n| write(&base, n, b"x")).collect();
        (base, paths)
    }

    /// Asks Windows' own shell code which files the clipboard holds, as Explorer would.
    fn what_windows_sees(owner: &Owner) -> (Vec<String>, Option<u32>) {
        let drop_effect_name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
        // SAFETY: the clipboard is opened and closed here; handles are used only while it is open.
        unsafe {
            assert!(OpenClipboard(owner.0 as *mut c_void) != 0, "could not open the clipboard");
            let mut names = Vec::new();
            let hdrop = GetClipboardData(15);
            if !hdrop.is_null() {
                let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
                for i in 0..count {
                    let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0) as usize;
                    let mut buf = vec![0u16; len + 1];
                    DragQueryFileW(hdrop, i, buf.as_mut_ptr(), buf.len() as u32);
                    names.push(String::from_utf16(&buf[..len]).unwrap());
                }
            }
            let format = RegisterClipboardFormatW(drop_effect_name.as_ptr());
            let mut effect = None;
            if IsClipboardFormatAvailable(format) != 0 {
                let h = GetClipboardData(format);
                if !h.is_null() {
                    let p = GlobalLock(h) as *const u32;
                    effect = Some(*p);
                    GlobalUnlock(h);
                }
            }
            CloseClipboard();
            (names, effect)
        }
    }

    #[test]
    #[ignore = "changes the clipboard of the machine it runs on"]
    fn test_clipboard_real_windows_itself_reads_what_was_copied() {
        let owner = Owner::new();
        let (base, paths) = files("qre_clip_real_copy", &["a.txt", "Café résumé.txt", "日本語.txt"]);

        set_files(&paths, false, owner.0).unwrap();

        let (seen, effect) = what_windows_sees(&owner);
        assert_eq!(seen, paths, "Windows does not see the files that were copied");
        assert_eq!(effect, Some(DROPEFFECT_COPY));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    #[ignore = "changes the clipboard of the machine it runs on"]
    fn test_clipboard_real_a_cut_is_marked_as_a_move_for_explorer() {
        let owner = Owner::new();
        let (base, paths) = files("qre_clip_real_cut", &["a.txt"]);
        set_files(&paths, true, owner.0).unwrap();
        assert_eq!(what_windows_sees(&owner).1, Some(DROPEFFECT_MOVE));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    #[ignore = "changes the clipboard of the machine it runs on"]
    fn test_clipboard_real_the_app_reads_back_what_it_wrote() {
        let owner = Owner::new();
        let (base, paths) = files("qre_clip_real_roundtrip", &["a.txt", "b b.txt"]);

        set_files(&paths, false, owner.0).unwrap();
        let copied = get_files(owner.0).unwrap();
        assert_eq!((copied.supported, copied.cut, &copied.paths), (true, false, &paths));

        set_files(&paths, true, owner.0).unwrap();
        assert!(get_files(owner.0).unwrap().cut);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    #[ignore = "changes the clipboard of the machine it runs on"]
    fn test_clipboard_real_a_new_copy_replaces_the_old_one() {
        let owner = Owner::new();
        let (base, paths) = files("qre_clip_real_replace", &["one.txt", "two.txt"]);
        set_files(&paths[..1], false, owner.0).unwrap();
        set_files(&paths[1..], false, owner.0).unwrap();
        assert_eq!(get_files(owner.0).unwrap().paths, paths[1..].to_vec());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    #[ignore = "changes the clipboard of the machine it runs on"]
    fn test_clipboard_real_clearing_removes_a_file_list_but_leaves_text_alone() {
        let owner = Owner::new();
        let (base, paths) = files("qre_clip_real_clear", &["a.txt"]);

        set_files(&paths, true, owner.0).unwrap();
        clear_files(owner.0).unwrap();
        let after = get_files(owner.0).unwrap();
        assert!(after.supported && after.paths.is_empty());

        // Text copied by the user in the meantime is not touched.
        // SAFETY: the clipboard is opened and closed here; the memory goes to the system on success.
        unsafe {
            assert!(OpenClipboard(owner.0 as *mut c_void) != 0);
            EmptyClipboard();
            let text: Vec<u16> = "keep me\0".encode_utf16().collect();
            let h = GlobalAlloc(GMEM_MOVEABLE, text.len() * 2);
            let p = GlobalLock(h) as *mut u16;
            std::ptr::copy_nonoverlapping(text.as_ptr(), p, text.len());
            GlobalUnlock(h);
            SetClipboardData(13, h);
            CloseClipboard();
        }
        clear_files(owner.0).unwrap();
        // SAFETY: as above.
        unsafe {
            assert!(OpenClipboard(owner.0 as *mut c_void) != 0);
            assert!(IsClipboardFormatAvailable(13) != 0, "the text was removed");
            CloseClipboard();
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    #[ignore = "changes the clipboard of the machine it runs on"]
    fn test_clipboard_real_an_empty_clipboard_has_no_files_and_is_still_supported() {
        let owner = Owner::new();
        // SAFETY: the clipboard is opened and closed here.
        unsafe {
            assert!(OpenClipboard(owner.0 as *mut c_void) != 0);
            EmptyClipboard();
            CloseClipboard();
        }
        let found = get_files(owner.0).unwrap();
        assert!(found.supported && found.paths.is_empty() && !found.cut);
    }
}
