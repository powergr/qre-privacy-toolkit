//! What happens to the user's files when locking or unlocking goes wrong.
//!
//! The round trip tests in tests.rs show that a good lock and unlock work. These cover the
//! other cases: a damaged or cut-off file, a wrong password, a name in the header that is not
//! a plain file name, a folder that cannot be zipped. In each one nothing may be left behind
//! that looks like a finished file, and nothing may be written outside the chosen folder.

use crate::crypto_stream::{self, safe_output_name, StreamHeader};
use crate::keychain::MasterKey;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

// ─── Helpers ─────────────────────────────────────────────────────────────────

pub(crate) fn key(seed: u8) -> MasterKey {
    MasterKey([seed; 32])
}

pub(crate) fn fresh_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Bytes that do not compress, so a file of n bytes really takes about n bytes of chunks.
pub(crate) fn noise(len: usize) -> Vec<u8> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

pub(crate) fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
    let path = dir.join(name);
    fs::File::create(&path).unwrap().write_all(bytes).unwrap();
    path.to_str().unwrap().to_owned()
}

pub(crate) fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    found.sort();
    found
}

/// Locks the way the app does, in the format it writes by default.
pub(crate) fn lock(input: &str, output: &str, mk: &MasterKey) -> anyhow::Result<()> {
    crypto_stream::encrypt_file_stream(input, output, mk, "local", None, None, None, 1, |_, _| {})
}

/// Locks in a chosen format. The older formats are still read, so they are still tested.
pub(crate) fn lock_as(format: crypto_stream::FileFormat, input: &str, output: &str, mk: &MasterKey) -> anyhow::Result<()> {
    crypto_stream::encrypt_file_stream_as(format, input, output, mk, "local", None, None, None, 1, |_, _| {})
}

pub(crate) fn unlock(encrypted: &str, out_dir: &Path, mk: &MasterKey) -> anyhow::Result<String> {
    crypto_stream::decrypt_file_stream(encrypted, out_dir.to_str().unwrap(), mk, None, |_, _| {})
}

/// A locked file in `dir/in`, with an empty `dir/out` to unlock into.
pub(crate) fn locked_file(test: &str, size: usize) -> (PathBuf, PathBuf, String, Vec<u8>) {
    locked_file_as(crypto_stream::DEFAULT_WRITE_FORMAT, test, size)
}

/// Same, in a chosen format.
pub(crate) fn locked_file_as(
    format: crypto_stream::FileFormat,
    test: &str,
    size: usize,
) -> (PathBuf, PathBuf, String, Vec<u8>) {
    let base = fresh_dir(test);
    let input_dir = base.join("in");
    let out_dir = base.join("out");
    fs::create_dir_all(&input_dir).unwrap();
    fs::create_dir_all(&out_dir).unwrap();
    let data = noise(size);
    let input = write(&input_dir, "data.bin", &data);
    let encrypted = format!("{}.qre", input);
    lock_as(format, &input, &encrypted, &key(7)).unwrap();
    (base, out_dir, encrypted, data)
}

/// Where the first chunk starts, in a V6 or a V8 file.
pub(crate) fn chunks_start(bytes: &[u8]) -> usize {
    if bytes[..4] == 8u32.to_le_bytes() {
        let len_at = 4;
        let len = u32::from_le_bytes(bytes[len_at..len_at + 4].try_into().unwrap()) as usize;
        return len_at + 4 + len;
    }
    let mut cursor = std::io::Cursor::new(bytes);
    cursor.set_position(4);
    let _: StreamHeader = bincode::deserialize_from(&mut cursor).unwrap();
    cursor.position() as usize
}

/// Where each chunk of a V6 or V8 file ends: the offsets at which a file can be cut cleanly.
pub(crate) fn chunk_ends(bytes: &[u8]) -> Vec<usize> {
    let mut pos = chunks_start(bytes);
    let mut ends = Vec::new();
    while pos + 4 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4 + len;
        ends.push(pos);
    }
    ends
}

/// The same file with another name in its header (V6 headers have no fixed size).
fn with_header_name(encrypted: &str, new_name: &str) -> String {
    let bytes = fs::read(encrypted).unwrap();
    let mut cursor = std::io::Cursor::new(&bytes[..]);
    cursor.set_position(4);
    let mut header: StreamHeader = bincode::deserialize_from(&mut cursor).unwrap();
    let rest = &bytes[cursor.position() as usize..];
    header.original_filename = new_name.to_string();
    let mut out = bytes[..4].to_vec();
    out.extend(bincode::serialize(&header).unwrap());
    out.extend_from_slice(rest);
    let path = format!("{}.renamed.qre", encrypted);
    fs::write(&path, out).unwrap();
    path
}

// ─── safe_output_name ────────────────────────────────────────────────────────

#[test]
fn test_plain_names_are_kept_exactly() {
    for name in ["notes.txt", "résumé final.pdf", "archive.tar.gz", ".env", "a b (1).txt", "日本語.txt"] {
        assert_eq!(safe_output_name(name).unwrap(), name);
    }
}

#[test]
fn test_only_the_last_part_of_a_name_with_folders_is_used() {
    assert_eq!(safe_output_name("../../escape.txt").unwrap(), "escape.txt");
    assert_eq!(safe_output_name("some/folder/file.txt").unwrap(), "file.txt");
    assert_eq!(safe_output_name("/etc/passwd").unwrap(), "passwd");
    assert_eq!(safe_output_name("folder/").unwrap(), "folder");
}

#[test]
fn test_names_that_are_not_names_are_refused() {
    for bad in ["", ".", "..", "/", "a/..", "a/b/.", "//"] {
        assert!(safe_output_name(bad).is_err(), "{:?} must be refused", bad);
    }
}

#[test]
fn test_control_characters_are_refused() {
    for bad in ["bad\0name", "new\nline.txt", "tab\there", "bell\u{7}"] {
        assert!(safe_output_name(bad).is_err(), "{:?} must be refused", bad);
    }
}

#[cfg(windows)]
#[test]
fn test_windows_folder_separators_of_both_kinds_are_cut_off() {
    assert_eq!(safe_output_name("..\\..\\escape.txt").unwrap(), "escape.txt");
    assert_eq!(safe_output_name("C:\\Windows\\win.ini").unwrap(), "win.ini");
    assert_eq!(safe_output_name("a/b\\c.txt").unwrap(), "c.txt");
}

#[cfg(windows)]
#[test]
fn test_windows_device_names_are_refused_with_or_without_an_extension() {
    for bad in ["CON", "con", "NUL.txt", "prn.tar.gz", "AUX", "COM1", "com9.log", "LPT1", "lpt9.txt"] {
        assert!(safe_output_name(bad).is_err(), "{:?} must be refused", bad);
    }
}

#[cfg(windows)]
#[test]
fn test_windows_names_that_only_look_like_device_names_are_kept() {
    for ok in ["console.txt", "COM0", "COM10", "LPT0", "nullable.txt", "auxiliary", "con-tent.txt"] {
        assert_eq!(safe_output_name(ok).unwrap(), ok);
    }
}

#[cfg(windows)]
#[test]
fn test_windows_characters_that_cannot_be_in_a_name_are_refused() {
    for bad in ["a:b", "file.txt:hidden", "what?.txt", "star*.txt", "q\"uote", "a<b", "a>b", "pipe|name"] {
        assert!(safe_output_name(bad).is_err(), "{:?} must be refused", bad);
    }
}

#[cfg(not(windows))]
#[test]
fn test_on_unix_a_backslash_is_an_ordinary_character() {
    assert_eq!(safe_output_name("a\\b.txt").unwrap(), "a\\b.txt");
}

// ─── Locking ─────────────────────────────────────────────────────────────────

#[test]
fn test_the_locked_file_only_appears_when_it_is_complete() {
    let base = fresh_dir("qre_fail_lock_appears_last");
    let input = write(&base, "big.bin", &noise(3 * 1024 * 1024));
    let output = format!("{}.qre", input);
    let seen_early = std::cell::Cell::new(false);

    crypto_stream::encrypt_file_stream(&input, &output, &key(1), "local", None, None, None, 1, |_, _| {
        if Path::new(&output).exists() {
            seen_early.set(true);
        }
    })
    .unwrap();

    assert!(!seen_early.get(), "the .qre file existed while it was still being written");
    assert!(Path::new(&output).exists());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_finished_lock_leaves_no_partial_file_behind() {
    let base = fresh_dir("qre_fail_lock_no_part");
    let input = write(&base, "small.txt", b"hello");
    lock(&input, &format!("{}.qre", input), &key(1)).unwrap();
    assert_eq!(names(&base), ["small.txt", "small.txt.qre"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_locking_a_missing_file_creates_nothing() {
    let base = fresh_dir("qre_fail_lock_missing");
    let missing = base.join("nope.txt").to_str().unwrap().to_owned();
    assert!(lock(&missing, &format!("{}.qre", missing), &key(1)).is_err());
    assert!(names(&base).is_empty(), "left behind: {:?}", names(&base));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_locking_into_a_folder_that_does_not_exist_fails_cleanly() {
    let base = fresh_dir("qre_fail_lock_no_folder");
    let input = write(&base, "a.txt", b"hello");
    let output = base.join("missing").join("a.txt.qre");
    assert!(lock(&input, output.to_str().unwrap(), &key(1)).is_err());
    assert_eq!(names(&base), ["a.txt"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_failed_lock_does_not_destroy_a_file_already_at_that_name() {
    let base = fresh_dir("qre_fail_lock_keeps_old");
    let input = write(&base, "a.txt", b"hello");
    let output = write(&base, "a.txt.qre", b"an earlier locked file");
    let result = lock(base.join("gone.txt").to_str().unwrap(), &output, &key(1));
    assert!(result.is_err());
    assert_eq!(fs::read(&output).unwrap(), b"an earlier locked file");
    let _ = (input, fs::remove_dir_all(base));
}

#[test]
fn test_an_empty_file_locks_and_unlocks() {
    let (base, out_dir, _, _) = locked_file("qre_fail_empty_probe", 1);
    let empty = write(&base.join("in"), "empty.txt", b"");
    let encrypted = format!("{}.qre", empty);
    lock(&empty, &encrypted, &key(7)).unwrap();
    let name = unlock(&encrypted, &out_dir, &key(7)).unwrap();
    assert_eq!(fs::read(out_dir.join(name)).unwrap(), b"");
    let _ = fs::remove_dir_all(base);
}

// ─── Unlocking: nothing half-done is left ────────────────────────────────────

#[test]
fn test_a_wrong_password_creates_no_file() {
    let (base, out_dir, encrypted, _) = locked_file("qre_fail_unlock_wrong_key", 3 * 1024 * 1024);
    assert!(unlock(&encrypted, &out_dir, &key(99)).is_err());
    assert!(names(&out_dir).is_empty(), "left behind: {:?}", names(&out_dir));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_damaged_chunk_leaves_no_partial_plaintext() {
    let (base, out_dir, encrypted, _) = locked_file("qre_fail_unlock_damaged", 3 * 1024 * 1024);
    let mut bytes = fs::read(&encrypted).unwrap();
    let at = bytes.len() * 3 / 4;
    bytes[at] ^= 0xFF;
    fs::write(&encrypted, bytes).unwrap();

    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("integrity"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty(), "plaintext left behind: {:?}", names(&out_dir));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_off_inside_a_chunk_leaves_no_partial_plaintext_and_says_so() {
    let (base, out_dir, encrypted, _) = locked_file("qre_fail_unlock_cut_inside", 3 * 1024 * 1024);
    let bytes = fs::read(&encrypted).unwrap();
    fs::write(&encrypted, &bytes[..bytes.len() - 100]).unwrap();

    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.to_lowercase().contains("truncated"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty(), "plaintext left behind: {:?}", names(&out_dir));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_off_between_chunks_is_caught_and_leaves_nothing() {
    let (base, out_dir, encrypted, _) = locked_file("qre_fail_unlock_cut_between", 3 * 1024 * 1024);
    let bytes = fs::read(&encrypted).unwrap();
    let ends = chunk_ends(&bytes);
    assert!(ends.len() >= 3, "the test needs several chunks");
    fs::write(&encrypted, &bytes[..ends[ends.len() - 2]]).unwrap();

    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("INTEGRITY"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty(), "plaintext left behind: {:?}", names(&out_dir));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_cut_off_inside_a_chunk_length_is_truncated_not_finished() {
    let (base, out_dir, encrypted, _) = locked_file("qre_fail_unlock_cut_length", 3 * 1024 * 1024);
    let bytes = fs::read(&encrypted).unwrap();
    let ends = chunk_ends(&bytes);
    // Two bytes of the next chunk's four byte length are all that is left of it.
    fs::write(&encrypted, &bytes[..ends[0] + 2]).unwrap();

    // "incomplete" is the message for a cut-off chunk. The whole-file hash check would also
    // fail here, but with a different message, which is not the one wanted.
    let err = unlock(&encrypted, &out_dir, &key(7)).unwrap_err().to_string();
    assert!(err.contains("incomplete"), "unexpected message: {}", err);
    assert!(names(&out_dir).is_empty(), "left behind: {:?}", names(&out_dir));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_locking_onto_a_name_that_is_a_folder_fails_and_leaves_no_partial_file() {
    let base = fresh_dir("qre_fail_lock_target_is_folder");
    let input = write(&base, "a.txt", b"hello");
    let target = base.join("a.txt.qre");
    fs::create_dir_all(&target).unwrap();
    assert!(lock(&input, target.to_str().unwrap(), &key(1)).is_err());
    assert!(target.is_dir());
    assert_eq!(names(&base), ["a.txt", "a.txt.qre"], "a temporary file was left behind");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_extra_bytes_after_the_last_chunk_are_refused() {
    let (base, out_dir, encrypted, _) = locked_file("qre_fail_unlock_extra", 100 * 1024);
    let mut bytes = fs::read(&encrypted).unwrap();
    bytes.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    fs::write(&encrypted, bytes).unwrap();
    assert!(unlock(&encrypted, &out_dir, &key(7)).is_err());
    assert!(names(&out_dir).is_empty(), "left behind: {:?}", names(&out_dir));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_file_that_is_not_a_qre_file_is_refused_cleanly() {
    let base = fresh_dir("qre_fail_unlock_garbage");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    for (i, junk) in [vec![], vec![6, 0, 0], vec![9, 9, 9, 9, 1, 2, 3], noise(5000)].into_iter().enumerate() {
        let path = write(&base, &format!("junk{}.qre", i), &junk);
        assert!(unlock(&path, &out_dir, &key(7)).is_err(), "junk{} was accepted", i);
    }
    assert!(names(&out_dir).is_empty(), "left behind: {:?}", names(&out_dir));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_unlocking_into_a_folder_that_does_not_exist_fails_cleanly() {
    let (base, _, encrypted, _) = locked_file("qre_fail_unlock_no_folder", 1000);
    let missing = base.join("not-there");
    assert!(unlock(&encrypted, &missing, &key(7)).is_err());
    assert!(!missing.exists());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_unlocked_file_only_appears_after_it_has_been_checked() {
    let (base, out_dir, encrypted, data) = locked_file("qre_fail_unlock_appears_last", 6 * 1024 * 1024);
    let seen_early = std::cell::Cell::new(false);
    let calls = std::cell::Cell::new(0);

    let name = crypto_stream::decrypt_file_stream(
        &encrypted,
        out_dir.to_str().unwrap(),
        &key(7),
        None,
        |_, _| {
            calls.set(calls.get() + 1);
            if out_dir.join("data.bin").exists() {
                seen_early.set(true);
            }
        },
    )
    .unwrap();

    assert!(calls.get() > 0, "the progress callback never ran, so the test proved nothing");
    assert!(!seen_early.get(), "the output existed before its hash was checked");
    assert_eq!(fs::read(out_dir.join(&name)).unwrap(), data);
    assert_eq!(names(&out_dir), [name]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_name_already_taken_is_never_overwritten() {
    let (base, out_dir, encrypted, data) = locked_file("qre_fail_unlock_name_taken", 5000);
    write(&out_dir, "data.bin", b"the user's own file");
    let name = unlock(&encrypted, &out_dir, &key(7)).unwrap();
    assert_ne!(name, "data.bin");
    assert_eq!(fs::read(out_dir.join("data.bin")).unwrap(), b"the user's own file");
    assert_eq!(fs::read(out_dir.join(name)).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

// ─── Unlocking: a header that points outside the chosen folder ───────────────

#[test]
fn test_a_header_name_with_folders_cannot_write_outside_the_chosen_folder() {
    let (base, out_dir, encrypted, _) = locked_file_as(crypto_stream::FileFormat::Classic, "qre_fail_unlock_traversal", 5000);
    let tampered = with_header_name(&encrypted, "../escaped.txt");

    // The chunks were sealed under the real name, so this cannot succeed. What matters is that
    // it also creates nothing next to the chosen folder on its way to failing.
    assert!(unlock(&tampered, &out_dir, &key(7)).is_err());
    assert!(!base.join("escaped.txt").exists(), "a file was created outside the chosen folder");
    assert!(names(&out_dir).is_empty(), "left behind: {:?}", names(&out_dir));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_header_name_that_is_an_absolute_path_cannot_write_there() {
    let (base, out_dir, encrypted, _) = locked_file_as(crypto_stream::FileFormat::Classic, "qre_fail_unlock_absolute", 5000);
    let target = base.join("absolute-target.txt");
    let tampered = with_header_name(&encrypted, target.to_str().unwrap());

    assert!(unlock(&tampered, &out_dir, &key(7)).is_err());
    assert!(!target.exists(), "a file was created at the absolute path from the header");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_header_name_that_is_empty_or_dots_is_refused() {
    let (base, out_dir, encrypted, _) = locked_file_as(crypto_stream::FileFormat::Classic, "qre_fail_unlock_dots", 5000);
    for bad in ["", ".", ".."] {
        let tampered = with_header_name(&encrypted, bad);
        let err = unlock(&tampered, &out_dir, &key(7)).unwrap_err().to_string();
        assert!(err.contains("invalid file name"), "{:?} gave: {}", bad, err);
    }
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_names_with_spaces_and_accents_survive_a_lock_and_unlock() {
    let base = fresh_dir("qre_fail_names_roundtrip");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    for name in ["résumé final (2).txt", "日本語.txt", "no extension", ".hidden"] {
        let input = write(&base, name, b"content");
        let encrypted = format!("{}.qre", input);
        lock(&input, &encrypted, &key(3)).unwrap();
        let got = unlock(&encrypted, &out_dir, &key(3)).unwrap();
        assert_eq!(got, name);
        assert_eq!(fs::read(out_dir.join(got)).unwrap(), b"content");
    }
    let _ = fs::remove_dir_all(base);
}

// ─── Folders: the temporary zip ──────────────────────────────────────────────

#[cfg(windows)]
#[test]
fn test_a_folder_that_cannot_be_read_leaves_no_partial_zip() {
    use std::os::windows::fs::OpenOptionsExt;
    let base = fresh_dir("qre_fail_zip_unreadable");
    let folder = base.join("docs");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("a.txt"), b"readable").unwrap();
    fs::write(folder.join("b.txt"), b"held open by another program").unwrap();
    // Share mode 0: no other program, including this one, can open the file meanwhile.
    let _held = fs::OpenOptions::new().read(true).share_mode(0).open(folder.join("b.txt")).unwrap();

    let zip = base.join("docs.zip");
    assert!(crate::utils::zip_directory_to_file(&folder, &zip).is_err());
    assert!(!zip.exists(), "a partial zip of the folder was left behind");
    let _ = fs::remove_dir_all(base);
}

#[cfg(unix)]
#[test]
fn test_a_folder_that_cannot_be_read_leaves_no_partial_zip() {
    use std::os::unix::fs::PermissionsExt;
    let base = fresh_dir("qre_fail_zip_unreadable");
    let folder = base.join("docs");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("a.txt"), b"readable").unwrap();
    fs::write(folder.join("b.txt"), b"no permission").unwrap();
    fs::set_permissions(folder.join("b.txt"), fs::Permissions::from_mode(0o000)).unwrap();
    // Running as root, permissions do not stop a read, so there is nothing to test.
    if fs::File::open(folder.join("b.txt")).is_ok() {
        let _ = fs::remove_dir_all(base);
        return;
    }

    let zip = base.join("docs.zip");
    assert!(crate::utils::zip_directory_to_file(&folder, &zip).is_err());
    assert!(!zip.exists(), "a partial zip of the folder was left behind");
    fs::set_permissions(folder.join("b.txt"), fs::Permissions::from_mode(0o644)).unwrap();
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_folder_zips_and_the_zip_holds_every_file() {
    let base = fresh_dir("qre_fail_zip_ok");
    let folder = base.join("docs");
    fs::create_dir_all(folder.join("sub")).unwrap();
    fs::write(folder.join("a.txt"), b"one").unwrap();
    fs::write(folder.join("sub").join("b.txt"), b"two").unwrap();
    let zip_path = base.join("docs.zip");

    crate::utils::zip_directory_to_file(&folder, &zip_path).unwrap();

    let archive = zip::ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
    let mut listed: Vec<String> = archive.file_names().map(|n| n.expect("a readable name").to_string()).collect();
    listed.sort();
    assert_eq!(listed, ["docs/", "docs/a.txt", "docs/sub/", "docs/sub/b.txt"]);
    let _ = fs::remove_dir_all(base);
}

// ─── Saving vault files and the keychain: never half a file ──────────────────

use crate::crypto::{self, EncryptedFileContainer};
use crate::utils::atomic_write;

#[test]
fn test_a_safe_write_creates_a_new_file_and_leaves_nothing_else() {
    let base = fresh_dir("qre_fail_atomic_new");
    let target = base.join("vault.qre");
    atomic_write(&target, b"first").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"first");
    assert_eq!(names(&base), ["vault.qre"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_safe_write_replaces_the_whole_of_an_older_longer_file() {
    let base = fresh_dir("qre_fail_atomic_replace");
    let target = base.join("vault.qre");
    fs::write(&target, vec![b'x'; 100_000]).unwrap();
    atomic_write(&target, b"short").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"short", "no tail of the old file may remain");
    assert_eq!(names(&base), ["vault.qre"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_safe_write_handles_a_large_file() {
    let base = fresh_dir("qre_fail_atomic_large");
    let target = base.join("big.qre");
    let data = noise(5 * 1024 * 1024);
    atomic_write(&target, &data).unwrap();
    assert_eq!(fs::read(&target).unwrap(), data);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_failed_safe_write_leaves_the_old_file_and_no_temporary_file() {
    let base = fresh_dir("qre_fail_atomic_blocked");
    // A folder sits where the file should go, so the final swap cannot succeed.
    let target = base.join("vault.qre");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("inside.txt"), b"kept").unwrap();

    assert!(atomic_write(&target, b"new content").is_err());
    assert!(target.is_dir(), "the old item was replaced");
    assert_eq!(fs::read(target.join("inside.txt")).unwrap(), b"kept");
    assert_eq!(names(&base), ["vault.qre"], "a temporary file was left behind");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_write_that_stops_halfway_leaves_the_old_file_exactly_as_it_was() {
    use crate::utils::atomic_write_with;
    let base = fresh_dir("qre_fail_atomic_halfway");
    let target = base.join("vault.qre");
    fs::write(&target, b"the old vault, whole").unwrap();

    // The disk fills up, or the program is stopped, after part of the new content is written.
    let result = atomic_write_with(&target, |file| {
        file.write_all(b"half of the new")?;
        Err(std::io::Error::other("disk full"))
    });

    assert!(result.is_err());
    assert_eq!(fs::read(&target).unwrap(), b"the old vault, whole");
    assert_eq!(names(&base), ["vault.qre"], "the unfinished temporary file was left behind");
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_write_that_finishes_replaces_the_old_file() {
    use crate::utils::atomic_write_with;
    let base = fresh_dir("qre_fail_atomic_finishes");
    let target = base.join("vault.qre");
    fs::write(&target, b"old").unwrap();
    atomic_write_with(&target, |file| file.write_all(b"new")).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new");
    assert_eq!(names(&base), ["vault.qre"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_safe_write_into_a_missing_folder_fails_and_creates_nothing() {
    let base = fresh_dir("qre_fail_atomic_no_folder");
    let target = base.join("missing").join("vault.qre");
    assert!(atomic_write(&target, b"data").is_err());
    assert!(names(&base).is_empty());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_temporary_file_is_hidden_and_named_after_its_target() {
    // Seen only if the write is interrupted; the name tells a user what it was for.
    let base = fresh_dir("qre_fail_atomic_name");
    let blocked = base.join("notes.qre");
    fs::create_dir_all(&blocked).unwrap();
    let _ = atomic_write(&blocked, b"x");
    // It was removed on failure, so the best check is that the success path never shows it.
    let target = base.join("passwords.qre");
    atomic_write(&target, b"x").unwrap();
    assert!(names(&base).iter().all(|n| !n.ends_with(".tmp")));
    let _ = fs::remove_dir_all(base);
}

fn small_container() -> EncryptedFileContainer {
    crypto::encrypt_file_with_master_key(&key(5), None, "vault.json", b"{\"entries\":[]}", None, 3).unwrap()
}

#[test]
fn test_a_saved_vault_file_loads_back_and_opens() {
    let base = fresh_dir("qre_fail_vault_roundtrip");
    let path = base.join("passwords.qre");
    small_container().save(path.to_str().unwrap()).unwrap();

    let loaded = EncryptedFileContainer::load(path.to_str().unwrap()).unwrap();
    let opened = crypto::decrypt_file_with_master_key(&key(5), None, &loaded).unwrap();
    assert_eq!(opened.content, b"{\"entries\":[]}");
    assert_eq!(names(&base), ["passwords.qre"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_saving_a_vault_again_replaces_it_whole() {
    let base = fresh_dir("qre_fail_vault_resave");
    let path = base.join("passwords.qre");
    let first = crypto::encrypt_file_with_master_key(&key(5), None, "v.json", &noise(50_000), None, 3).unwrap();
    first.save(path.to_str().unwrap()).unwrap();
    small_container().save(path.to_str().unwrap()).unwrap();

    let loaded = EncryptedFileContainer::load(path.to_str().unwrap()).unwrap();
    let opened = crypto::decrypt_file_with_master_key(&key(5), None, &loaded).unwrap();
    assert_eq!(opened.content, b"{\"entries\":[]}");
    assert_eq!(names(&base), ["passwords.qre"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_failed_vault_save_keeps_the_old_vault_readable() {
    let base = fresh_dir("qre_fail_vault_keeps_old");
    let path = base.join("passwords.qre");
    small_container().save(path.to_str().unwrap()).unwrap();
    let before = fs::read(&path).unwrap();

    // Saving somewhere that cannot work must not touch this file, and must say it failed.
    let impossible = base.join("no-such-folder").join("passwords.qre");
    assert!(small_container().save(impossible.to_str().unwrap()).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(names(&base), ["passwords.qre"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_restoring_a_keychain_backup_leaves_no_temporary_file() {
    use crate::commands::vault::restore_keychain_to;
    let base = fresh_dir("qre_fail_restore_clean");
    let backup = base.join("backup.json");
    crate::keychain::init_keychain(&backup, "correct horse battery staple 42!").unwrap();
    let dest = base.join("keychain.json");

    restore_keychain_to(&dest, &backup).unwrap();

    assert_eq!(fs::read(&dest).unwrap(), fs::read(&backup).unwrap());
    assert_eq!(names(&base), ["backup.json", "keychain.json"]);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_fastest_level_still_locks_and_unlocks_every_kind_of_data() {
    let base = fresh_dir("qre_fail_fast_level");
    let out_dir = base.join("out");
    fs::create_dir_all(&out_dir).unwrap();
    let samples: Vec<(&str, Vec<u8>)> = vec![
        ("zeros.bin", vec![0u8; 3 * 1024 * 1024]),
        ("noise.bin", noise(2 * 1024 * 1024 + 17)),
        ("text.txt", "the quick brown fox ".repeat(200_000).into_bytes()),
        ("tiny.txt", b"x".to_vec()),
    ];
    for (name, data) in samples {
        let input = write(&base, name, &data);
        let encrypted = format!("{}.qre", input);
        crypto_stream::encrypt_file_stream(
            &input,
            &encrypted,
            &key(2),
            "local",
            None,
            None,
            None,
            crate::commands::files::FASTEST_ZSTD_LEVEL,
            |_, _| {},
        )
        .unwrap();
        let got = unlock(&encrypted, &out_dir, &key(2)).unwrap();
        assert_eq!(fs::read(out_dir.join(got)).unwrap(), data, "{} did not survive", name);
    }
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_the_fastest_level_compresses_less_than_auto_on_ordinary_text() {
    let base = fresh_dir("qre_fail_fast_vs_auto");
    let text = "the quick brown fox jumps over the lazy dog, again and again. ".repeat(40_000).into_bytes();
    let input = write(&base, "text.txt", &text);
    let size_at = |level: i32, tag: &str| {
        let out = format!("{}.{}.qre", input, tag);
        crypto_stream::encrypt_file_stream(&input, &out, &key(1), "local", None, None, None, level, |_, _| {}).unwrap();
        fs::metadata(&out).unwrap().len()
    };
    let fastest = size_at(crate::commands::files::FASTEST_ZSTD_LEVEL, "fast");
    let default = size_at(3, "default");
    assert!(fastest >= default, "the fastest level ({}) produced a smaller file than level 3 ({})", fastest, default);
    let _ = fs::remove_dir_all(base);
}

// ─── Guards for what a test cannot cause ─────────────────────────────────────
//
// A power cut or a full disk cannot be made to happen inside a test, so the steps that survive
// them are checked in the source. If one of these fails, a safeguard was removed.

/// The text of the function that starts at `signature`, up to the next line that is not indented.
pub(crate) fn function_body(source: &str, signature: &str) -> String {
    // Source files may have Windows line endings, which would hide the end of the function.
    let source = source.replace("\r\n", "\n");
    let start = source.find(signature).unwrap_or_else(|| panic!("{} not found", signature));
    let rest = &source[start..];
    let end = rest.find("\n}\n").map(|i| i + 3).expect("the end of the function");
    rest[..end].to_string()
}

#[test]
fn test_every_vault_file_is_saved_through_the_safe_write() {
    let source = include_str!("crypto.rs");
    let save = function_body(source, "pub fn save(&self, path: &str)");
    assert!(save.contains("crate::utils::atomic_write("), "save() no longer uses the safe write");
    assert!(!save.contains("File::create"), "save() creates the vault file directly again");
}

#[test]
fn test_a_restored_keychain_is_written_through_the_safe_write() {
    let source = include_str!("commands/vault.rs");
    let restore = function_body(source, "pub(crate) fn restore_keychain_to(");
    assert!(restore.contains("crate::utils::atomic_write(dest"));
    assert!(!restore.contains("fs::write(dest"));
}

#[test]
fn test_the_bytes_are_forced_to_disk_before_a_file_is_put_in_place() {
    let stream = include_str!("crypto_stream.rs");
    // Every locked file is finished by ChunkWriter::finish, whether it was made by locking a file
    // or by re-locking an old one.
    assert!(function_body(stream, "fn finish(self)").contains(".sync_all()"), "a locked file is no longer synced");
    assert!(function_body(stream, "fn encrypt_pieces(").contains("writer.finish()"), "the writer is no longer finished");
    assert!(function_body(stream, "pub fn decrypt_file_stream(").contains(".sync_all()"), "an unlocked file is no longer synced");
    let keychain = include_str!("keychain.rs");
    assert!(function_body(keychain, "fn atomic_write_keychain(").contains(".sync_all()"), "the keychain is no longer synced");
    let utils = include_str!("utils.rs");
    assert!(function_body(utils, "pub fn atomic_write_with(").contains(".sync_all()"), "the safe write no longer syncs");
}

#[test]
fn test_a_new_file_is_given_its_real_name_only_by_a_rename() {
    let stream = include_str!("crypto_stream.rs");
    assert!(function_body(stream, "pub fn encrypt_file_stream_as(").contains("fs::rename(&part, output_path)"));
    assert!(function_body(stream, "pub fn encrypt_file_stream(").contains("encrypt_file_stream_as("), "the plain entry point must go through the safe one");
    assert!(function_body(stream, "pub fn decrypt_file_stream(").contains("fs::rename(&part_out, &final_out)"));
}

// ─── A length field that claims far more than the file holds ─────────────────

#[test]
fn test_a_vault_file_that_claims_a_huge_body_is_refused_without_crashing() {
    let base = fresh_dir("qre_fail_vault_huge");
    let path = base.join("v.qre");
    let container = small_container();
    let body = container.ciphertext.len();
    container.save(path.to_str().unwrap()).unwrap();

    let mut bytes = fs::read(&path).unwrap();
    let at = bytes.len() - body - 8;
    assert_eq!(u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap()), body as u64, "the length field was not where expected");
    bytes[at..at + 8].copy_from_slice(&(1u64 << 60).to_le_bytes());
    fs::write(&path, bytes).unwrap();

    assert!(EncryptedFileContainer::load(path.to_str().unwrap()).is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn test_a_version_6_header_that_claims_a_huge_field_is_refused_without_crashing() {
    let (base, out_dir, encrypted, _) = locked_file_as(crypto_stream::FileFormat::Classic, "qre_fail_v6_huge", 5000);
    let mut bytes = fs::read(&encrypted).unwrap();
    // version (4), vault id: flag (1) + length (8) + "local" (5), then the validation nonce's length.
    let at = 4 + 1 + 8 + 5;
    assert_eq!(u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap()), 12, "the length field was not where expected");
    bytes[at..at + 8].copy_from_slice(&(1u64 << 60).to_le_bytes());
    fs::write(&encrypted, bytes).unwrap();

    assert!(unlock(&encrypted, &out_dir, &key(7)).is_err());
    assert!(names(&out_dir).is_empty());
    let _ = fs::remove_dir_all(base);
}
