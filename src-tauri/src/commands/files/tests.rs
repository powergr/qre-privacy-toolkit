use super::*;
use std::collections::HashMap;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qre_files_cmd_{}_{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn critical_example() -> &'static str {
    if cfg!(target_os = "windows") {
        "C:\\Windows\\System32\\drivers\\etc\\hosts"
    } else {
        "/etc/hosts"
    }
}

// ── compression_level ────────────────────────────────────────────────────

#[test]
fn test_compression_level_store_and_extreme_ignore_the_file_type() {
    assert_eq!(compression_level("store", "notes.txt"), 0);
    assert_eq!(compression_level("store", "photo.jpg"), 0);
    assert_eq!(compression_level("extreme", "notes.txt"), 19);
    assert_eq!(compression_level("extreme", "photo.jpg"), 19);
}

#[test]
fn test_compression_level_auto_goes_light_for_already_compressed_files() {
    assert_eq!(compression_level("auto", "notes.txt"), 3);
    assert_eq!(compression_level("auto", "photo.JPG"), 1);
    assert_eq!(compression_level("auto", "archive.zip"), 1);
    assert_eq!(compression_level("auto", "no_extension"), 3);
}

#[test]
fn test_compression_level_unknown_mode_behaves_like_auto() {
    assert_eq!(compression_level("", "notes.txt"), 3);
    assert_eq!(compression_level("turbo", "movie.mp4"), 1);
}

// ── is_on_portable_mount ─────────────────────────────────────────────────

fn mounts(paths: &[&str]) -> HashMap<String, String> {
    paths.iter().map(|p| (p.to_string(), "vault-uuid".to_string())).collect()
}

#[test]
fn test_portable_mount_detects_files_on_the_drive_ignoring_case() {
    let m = mounts(&["D:\\"]);
    assert!(is_on_portable_mount("D:\\docs\\a.txt", &m));
    assert!(is_on_portable_mount("d:\\docs\\a.txt", &m));
    assert!(is_on_portable_mount("D:\\", &m));
}

#[test]
fn test_portable_mount_ignores_other_drives() {
    let m = mounts(&["D:\\"]);
    assert!(!is_on_portable_mount("C:\\docs\\a.txt", &m));
    assert!(!is_on_portable_mount("E:\\a.txt", &m));
}

#[test]
fn test_portable_mount_with_no_mounts_blocks_nothing() {
    assert!(!is_on_portable_mount("D:\\a.txt", &HashMap::new()));
}

#[test]
fn test_portable_mount_matches_unix_style_mount_points() {
    let m = mounts(&["/Volumes/MyUSB/"]);
    assert!(is_on_portable_mount("/Volumes/MyUSB/secret.txt", &m));
    assert!(is_on_portable_mount("/volumes/myusb/secret.txt", &m));
    assert!(!is_on_portable_mount("/Volumes/Other/secret.txt", &m));
}

// ── paste_one ────────────────────────────────────────────────────────────

#[test]
fn test_paste_copies_a_file_and_keeps_the_source() {
    let base = temp_dir("paste_copy");
    let dest = base.join("dest");
    fs::create_dir_all(&dest).unwrap();
    let src = base.join("a.txt");
    fs::write(&src, b"hello").unwrap();

    let r = paste_one(&src, &dest, false);
    assert!(r.success, "{}", r.message);
    assert_eq!(r.message, "Copied");
    assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"hello");
    assert!(src.exists(), "copy must not remove the source");

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_cut_moves_a_file() {
    let base = temp_dir("paste_cut");
    let dest = base.join("dest");
    fs::create_dir_all(&dest).unwrap();
    let src = base.join("a.txt");
    fs::write(&src, b"hello").unwrap();

    let r = paste_one(&src, &dest, true);
    assert!(r.success, "{}", r.message);
    assert_eq!(r.message, "Moved");
    assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"hello");
    assert!(!src.exists(), "cut must remove the source");

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_never_overwrites_an_existing_file() {
    let base = temp_dir("paste_clash");
    let dest = base.join("dest");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("a.txt"), b"ORIGINAL").unwrap();
    let src = base.join("a.txt");
    fs::write(&src, b"incoming").unwrap();

    let r = paste_one(&src, &dest, false);
    assert!(r.success, "{}", r.message);
    assert_eq!(fs::read(dest.join("a.txt")).unwrap(), b"ORIGINAL", "existing file was clobbered");

    let contents: Vec<Vec<u8>> = fs::read_dir(&dest)
        .unwrap()
        .map(|e| fs::read(e.unwrap().path()).unwrap())
        .collect();
    assert_eq!(contents.len(), 2, "the incoming copy must land under a new name");
    assert!(contents.contains(&b"incoming".to_vec()));

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_copies_a_folder_tree() {
    let base = temp_dir("paste_tree");
    let dest = base.join("dest");
    fs::create_dir_all(&dest).unwrap();
    let src = base.join("proj");
    fs::create_dir_all(src.join("sub").join("deep")).unwrap();
    fs::write(src.join("top.txt"), b"1").unwrap();
    fs::write(src.join("sub").join("deep").join("leaf.txt"), b"2").unwrap();

    let r = paste_one(&src, &dest, false);
    assert!(r.success, "{}", r.message);
    assert_eq!(fs::read(dest.join("proj").join("top.txt")).unwrap(), b"1");
    assert_eq!(
        fs::read(dest.join("proj").join("sub").join("deep").join("leaf.txt")).unwrap(),
        b"2"
    );
    assert!(src.join("top.txt").exists());

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_cut_moves_a_folder_tree() {
    let base = temp_dir("paste_cut_tree");
    let dest = base.join("dest");
    fs::create_dir_all(&dest).unwrap();
    let src = base.join("proj");
    fs::create_dir_all(src.join("sub")).unwrap();
    fs::write(src.join("sub").join("f.txt"), b"x").unwrap();

    let r = paste_one(&src, &dest, true);
    assert!(r.success, "{}", r.message);
    assert_eq!(fs::read(dest.join("proj").join("sub").join("f.txt")).unwrap(), b"x");
    assert!(!src.exists());

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_refuses_to_put_a_folder_inside_itself() {
    let base = temp_dir("paste_self");
    let src = base.join("proj");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("a.txt"), b"1").unwrap();

    let r = paste_one(&src, &src, false);
    assert!(!r.success);
    assert!(r.message.contains("into itself"), "got: {}", r.message);

    let entries: Vec<_> = fs::read_dir(&src).unwrap().collect();
    assert_eq!(entries.len(), 1, "nothing may be created inside the source folder");

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_refuses_to_put_a_folder_inside_its_own_subfolder() {
    let base = temp_dir("paste_into_child");
    let src = base.join("proj");
    let child = src.join("child");
    fs::create_dir_all(&child).unwrap();

    for is_cut in [false, true] {
        let r = paste_one(&src, &child, is_cut);
        assert!(!r.success, "is_cut={is_cut}");
        assert!(r.message.contains("into itself"), "got: {}", r.message);
    }
    assert!(src.exists());
    assert_eq!(fs::read_dir(&child).unwrap().count(), 0);

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_allows_a_folder_next_to_itself_and_into_a_similarly_named_sibling() {
    let base = temp_dir("paste_siblings");
    let src = base.join("proj");
    let sibling = base.join("proj2");
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    fs::write(src.join("a.txt"), b"1").unwrap();

    // Same parent: a duplicate under a new name.
    let r = paste_one(&src, &base, false);
    assert!(r.success, "{}", r.message);
    // "proj2" only shares a text prefix with "proj"; it is not inside it.
    let r = paste_one(&src, &sibling, false);
    assert!(r.success, "{}", r.message);
    assert_eq!(fs::read(sibling.join("proj").join("a.txt")).unwrap(), b"1");

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_missing_source_reports_failure() {
    let base = temp_dir("paste_missing");
    let r = paste_one(&base.join("ghost.txt"), &base, false);
    assert!(!r.success);
    assert_eq!(r.name, "ghost.txt");

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_rejects_protected_system_paths() {
    let base = temp_dir("paste_critical");
    let r = paste_one(Path::new(critical_example()), &base, false);
    assert!(!r.success);
    assert!(r.message.contains("protected"), "got: {}", r.message);
    assert_eq!(fs::read_dir(&base).unwrap().count(), 0);

    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_paste_rejects_path_traversal_in_the_source() {
    let base = temp_dir("paste_traversal");
    let sneaky = base.join("..").join("elsewhere.txt");
    let r = paste_one(&sneaky, &base, false);
    assert!(!r.success);
    assert!(r.message.contains("traversal"), "got: {}", r.message);

    let _ = fs::remove_dir_all(base);
}

// ── Linux and macOS system-critical paths ────────────────────────────────
// These test path text only, so they run on every platform.

#[test]
fn test_unix_critical_blocks_the_system_folders() {
    for p in ["/", "/etc", "/etc/passwd", "/var/log/syslog", "/bin/sh", "/sbin/init", "/usr/bin/env", "/usr/sbin/cron", "/boot/grub", "/proc/1/mem", "/sys/class", "/dev/null"] {
        assert!(is_unix_critical(p, false), "{p} must be critical");
        assert!(is_unix_critical(p, true), "{p} must be critical on macOS");
    }
}

#[test]
fn test_unix_critical_compares_whole_folder_names() {
    for p in ["/variables/x", "/devices/inventory", "/etcetera", "/binary", "/system", "/bootcamp/a", "/home/alice/etc", "/usr/local/bin/tool", "/usr/share/docs"] {
        assert!(!is_unix_critical(p, false), "{p} must be allowed");
    }
}

#[test]
fn test_unix_critical_ordinary_paths_are_allowed() {
    for p in ["/home/alice/vault.json", "/tmp/export.csv", "/mnt/usb/file", "/Users/bob/Documents/a.txt", "", "relative/path"] {
        assert!(!is_unix_critical(p, false), "{p:?} must be allowed");
        assert!(!is_unix_critical(p, true), "{p:?} must be allowed on macOS");
    }
}

#[test]
fn test_unix_critical_handles_repeated_slashes() {
    assert!(is_unix_critical("//etc//passwd", false));
    assert!(is_unix_critical("//", false));
}

#[test]
fn test_macos_protects_its_own_system_folders() {
    // These are lower-case because is_system_critical lower-cases the path first.
    for p in ["/system/library/coreservices", "/library/preferences", "/applications/safari.app", "/private/etc/hosts", "/private/var/db/dslocal"] {
        assert!(is_unix_critical(p, true), "{p} must be critical on macOS");
    }
}

#[test]
fn test_macos_system_folders_are_not_special_on_linux() {
    // A Linux machine can have a user folder called /library or /applications.
    for p in ["/library/books", "/applications/mine", "/system/notes"] {
        assert!(!is_unix_critical(p, false), "{p} must be allowed on Linux");
    }
}

#[test]
fn test_macos_users_temp_folder_is_not_critical() {
    for p in [
        "/var/folders/zz/abc123/t/work.txt",
        "/private/var/folders/zz/abc123/t/work.txt",
        "/tmp/export.csv",
        "/private/tmp/export.csv",
    ] {
        assert!(!is_unix_critical(p, true), "{p} must be allowed on macOS");
    }
}

#[test]
fn test_macos_temp_exemption_does_not_open_the_rest_of_var() {
    for p in ["/var/db/x", "/var/log/system.log", "/private/var/root", "/private/var/folders_old/x"] {
        assert!(is_unix_critical(p, true), "{p} must stay critical on macOS");
    }
}

#[test]
fn test_linux_still_protects_var_folders() {
    // The temp exemption is a macOS rule only.
    assert!(is_unix_critical("/var/folders/x", false));
}
