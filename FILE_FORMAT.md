# QRE file format

This document describes how QRE Privacy Toolkit stores locked files, vault files and its keychain. It matches the current source code, which writes file version 8 for every new locked file and every vault file.

It is written for three readers.

- **A user** who wants to know what is protected and what is not. Read sections 3, 8 and 13.
- **A developer** who wants to write a program that opens a `.qre` file. The byte layouts are in sections 4, 5 and 9, and Appendix A has two sample files with a known key.
- **A security reviewer:** Read sections 13 to 16 first. They give the threat model, the known limits and a log of every finding raised so far, with the decision taken.

The source of truth is the code. The files to read are `src-tauri/src/crypto_stream.rs` for locked files, `seal_vault_file` and `open_vault_file` in the same file for vault files, `src-tauri/src/crypto.rs` for the old container format that is now only read, `src-tauri/src/keychain.rs` for the keychain and `src-tauri/src/commands/portable.rs` for portable USB vaults.

**Status of this document.** Locked files are written in format 8. Formats 5, 6 and 7 are still read, and they have weaker integrity (section 14, item 1). The format has not been published before, so there are no format 8 files in the wild that this document could contradict.

**How the layout was checked.** A second program, written in Node.js from section 4.7 alone with no look at the Rust code, opens the two sample files in Appendix A. It recovers the file name, the content and the hash, and it refuses a wrong key and a changed header byte. The header digest is also fixed by known-answer tests whose expected values came from that program. The decoder is listed in Appendix B so a reviewer can run it. The Rust test suite (743 tests at the time of writing) is described in section 12.

## 1. The three kinds of file

| File                                     | Written by               | Holds                                                                                      |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `name.ext.qre`                           | Lock in the Files screen | One locked file or one zipped folder, of any size.                                         |
| `passwords.qre`, `notes.qre` and similar | The vaults               | A small JSON document (your entries), sealed in file format 8 like a locked file.         |
| `keychain.json`                          | Vault setup              | Your master key, sealed twice: once under your password and once under your recovery code. |

Locked files use the **stream format** (versions 5 to 8), which works in 1 MiB chunks. Vault files use the same stream format, version 8 (section 5). Earlier apps wrote them in a **container format** (version 4), which is still read (section 5.1). The keychain is plain JSON.

## 2. Conventions

- All integers are little-endian.
- The headers are written with the Rust `bincode` crate, version 1, in its default layout. In that layout an integer has a fixed width, a string or byte list is a `u64` length followed by the bytes, and an optional value is one byte (`0` for none, `1` for present) followed by the value.
- Encryption is AES-256-GCM everywhere. Nonces are 12 bytes and tags are 16 bytes, and the tag is appended to the ciphertext.
- Compression is zstd, applied before encryption.
- All hashes are SHA-256.

## 3. Keys

A locked file is protected by a chain of keys. Each step is a random key sealed by the one before it.

```text
password  --Argon2id-->  key-encryption key  --AES-GCM-->  master key (32 random bytes)
                                                                 |
                      SHA-256(master key || label)  = wrapping key
                                                                 |
                              AES-GCM  -->  file key (32 random bytes, new for every file)
                                                                 |
                                       AES-GCM  -->  each 1 MiB chunk of the file
```

**Master key:** 32 random bytes made when the vault is created. It is stored only in `keychain.json`, sealed under the password and, in a second slot, under the recovery code, as described in section 9. Both slots hold the same master key.

**Wrapping key:** `SHA-256(master key || label)`, where the label is one of:

| Case             | Label bytes after the master key                                                      |
| ---------------- | ------------------------------------------------------------------------------------- |
| No key file      | the 10 ASCII bytes `NO_KEYFILE`                                                       |
| With a key file  | the 11 ASCII bytes `KEYFILE_MIX`, then the 32-byte SHA-256 of the key file's contents |
| Time-locked file | `KEYFILE_MIX`, then `SHA-256(binding key)` (see section 7)                            |

**File key:** 32 random bytes made for every file, so two files never share a key. It is sealed under the wrapping key in the header.

**Random numbers (the ChaCha20 seeding path).** Every locked file and every vault file gets its own generator. It is made in four steps.

1. **System randomness:** The app reads 32 bytes from the operating system's secure random source, through the `getrandom` crate (`SysRng` in the `rand` crate, version 0.10). If that source fails, the app stops with an error. It never falls back to another source.
2. **Paranoid Mode, optional:** The Files screen collects mouse or touch movements. Each movement of more than 5 pixels adds one byte: the low byte of the time since the last movement, in microseconds, XORed with one byte from the browser's own secure source (`crypto.getRandomValues`). So each byte is at least as unpredictable as the browser's source, and the timing only adds to it. The first 32 bytes are sent to the backend. For each file of a batch the backend computes `SHA-256(those bytes || file index as u64, little-endian)`, so two files of one batch get different values. That value is XORed into the 32 system bytes.
3. **The generator:** The result is the 32-byte seed of `ChaCha20Rng` (the `rand_chacha` crate, version 0.10), which is the 20-round ChaCha stream cipher used as a deterministic random bit generator. Values are drawn in a fixed order. First comes the file key (32 bytes). A time-locked file then takes its binding key (32) and the nonce for it (12). After that come the validation nonce, the key wrapping nonce and the base nonce (12 each). Format 8 ends with the metadata nonce (12).
4. **Cleaning up:** The seed is wiped (`zeroize`) when it goes out of scope, whether the lock succeeds or fails. The generator is used for one file and then dropped. It is never reused, never stored and never seeded from a file's content.

**What this gives:** XOR with independent data cannot make the seed weaker than the system bytes alone, so Paranoid Mode can only add. If the user bytes were fixed or guessable, the seed would be exactly as strong as the system source. Two files never share a key, because each has its own seed. The order of the draws is not part of the format, because every value is stored in the file or is a key, so a reader does not depend on it. Vault files use no Paranoid Mode: their seed is the system bytes alone.

**Limits of this path:** The quality of the keys is the quality of the operating system's source, and nothing in the app tests it. The seed is wiped on every exit, but the generator's own state is not wiped by the app. The timing bytes from a mouse are a weak source on their own. They are there as a second, independent input, not as a replacement.

## 4. A locked file

```text
offset 0     4 bytes   version (u32): 5, 6, 7 or 8
offset 4     ...       header (bincode StreamHeader)
             ...       chunk 0, chunk 1, ... until the end of the file
```

This is the layout of versions 5, 6 and 7. Version 8 has a different layout after the version number, described in section 4.7.

Version 8 is written for every new locked file, with or without a time-lock. Versions 5, 6 and 7 come from older apps and can still be read. Version 6 was the ordinary file and version 7 the time-locked file (section 7). The app refuses any other version.

### 4.1 The header

The fields are listed in order, with the sizes for a file locked in the local vault.

| #   | Field                      | Type            | Size on disk            | Meaning                                                                               |
| --- | -------------------------- | --------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| 1   | `vault_id`                 | optional string | 1 + 8 + 5 (for `local`) | Which vault's master key opens the file. A portable USB vault uses its own id.        |
| 2   | `validation_nonce`         | bytes           | 8 + 12                  | Nonce for field 3.                                                                    |
| 3   | `encrypted_validation_tag` | bytes           | 8 + 25                  | The text `QRE_VALID` (9 bytes) sealed under the wrapping key. A correct key opens it. |
| 4   | `key_wrapping_nonce`       | bytes           | 8 + 12                  | Nonce for field 5.                                                                    |
| 5   | `encrypted_file_key`       | bytes           | 8 + 48                  | The file key (32 bytes) sealed under the wrapping key.                                |
| 6   | `base_nonce`               | bytes           | 8 + 12                  | Starting nonce for the chunks.                                                        |
| 7   | `original_filename`        | string          | 8 + the name            | The file name before locking. For a folder, the name of its temporary zip.            |
| 8   | `original_hash`            | optional bytes  | 1 + 8 + 32              | SHA-256 of the whole original file.                                                   |
| 9   | `timelock`                 | optional record | 1, or 1 + 92            | Present only for a time-locked file.                                                  |

The `timelock` record holds `locked_until` (u64), `encrypted_binding_key` (8 + 48 bytes), `binding_key_nonce` (8 + 12 bytes) and `ratchet_max_seen` (u64). Version 5 has no field 9.

A file named `a.txt` has a 218-byte header, so with the 4-byte version the first chunk starts at offset 222.

### 4.2 Version 7 header region

A version 7 file reserves exactly 4096 bytes for the header, right after the version. The serialized header is written first and the rest is zero. The first chunk therefore always starts at offset 4100. The fixed size lets the app update one field of the header later without moving any other byte. The app refuses to write a header that does not fit.

### 4.3 Chunks

The original file is read in pieces of 1 048 576 bytes (the last one may be shorter). Each piece becomes one chunk.

```text
chunk := length (u32)  ||  ciphertext          // ciphertext is length bytes, including the 16-byte tag
```

To produce chunk number `i`, counting from 0:

1. Compress the piece with zstd.
2. Make the nonce: copy `base_nonce`, then XOR bytes 4 to 11 with `i` written as a little-endian `u64`.
3. Make the associated data: the text `original_filename`, a colon, and `i` in decimal, for example `report.pdf:0`.
4. Encrypt with the file key.

The chunk list has no end marker. It ends where the file ends. A length above 1 MiB plus 4096 bytes is treated as corruption.

A chunk may expand to at most 1 MiB when it is decompressed, and the reader refuses anything larger. An empty original file has no chunks at all.

### 4.4 Compression levels

| Setting in the app                                                    | zstd level |
| --------------------------------------------------------------------- | ---------- |
| Auto, for a file that is already compressed (video, images, archives) | 1          |
| Auto, for anything else                                               | 3          |
| Extreme                                                               | 19         |
| Fastest                                                               | -7         |

The level is not stored. The reader does not need it, because every chunk is a complete zstd frame.

### 4.5 Opening a file

A program that opens a locked file does the following.

1. Read the version and the header. For version 7, read the 4096-byte region and parse the header from its start.
2. If there is a `timelock` record, check the time first (section 7), then take `SHA-256(binding key)` as the key-file input.
3. Compute the wrapping key and open `encrypted_validation_tag`. If the result is not `QRE_VALID`, stop: the password or key file is wrong.
4. Open `encrypted_file_key` to get the file key.
5. Open each chunk in order, decompress it and write it out.
6. When the data ends, compare SHA-256 of everything written with `original_hash`. A mismatch means the file was cut short or damaged, and the output must be discarded.

Step 6 matters because chunk boundaries are not marked. Without it, a file with its last chunks cut off would open without any error.

### 4.6 Folders

A folder is first written as an uncompressed zip file next to the folder, with the name of the folder and `.zip` added (a number is added if that name is taken). That zip is locked like any other file and then deleted. The zip is plaintext on the disk while the lock runs and is deleted, not overwritten (section 14, item 15). Symbolic links inside the folder are skipped. Unlocking such a file writes the zip, and the app does not extract it.

### 4.7 Version 8

Version 8 fixes the weak points of the older versions. The file name and the plaintext hash are no longer readable without the key, and every other part of the header is authenticated, including the time-lock date.

The app writes version 8 for every new file. An older app cannot open a version 8 file, so every device that shares files must run a current version. Files in versions 4 to 7 are still read.

A version 8 file is never modified after it is written. It has no ratchet, and a refused unlock writes nothing to it. Section 7 explains why the ratchet could go.

```text
offset 0     4 bytes   version (u32): 8
offset 4     4 bytes   header length (u32)
offset 8     ...       header (bincode StreamHeaderV8), exactly that many bytes
             ...       chunk 0, chunk 1, ... until the end of the file
```

Every version 8 file has the same layout, with or without a time-lock. The header has no fixed size and no padding. A length of zero, or above 64 KiB, is treated as corruption before anything is read. The header must use every byte of its stated length, and extra bytes are refused.

| #   | Field                      | Type            | Meaning                                                                                                |
| --- | -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `vault_id`                 | optional string | Which vault's master key opens the file. Readable without the key.                                     |
| 2   | `validation_nonce`         | bytes           | Nonce for field 3.                                                                                     |
| 3   | `encrypted_validation_tag` | bytes           | `QRE_VALID` sealed under the wrapping key, with **no** associated data. It fails only for a wrong key. |
| 4   | `key_wrapping_nonce`       | bytes           | Nonce for field 5.                                                                                     |
| 5   | `encrypted_file_key`       | bytes           | The file key sealed under the wrapping key, with the header digest as associated data.                 |
| 6   | `base_nonce`               | bytes           | Starting nonce for the chunks.                                                                         |
| 7   | `meta_nonce`               | bytes           | Nonce for field 8.                                                                                     |
| 8   | `encrypted_meta`           | bytes           | The file name and the SHA-256 of the whole original file, sealed under the **file key**.               |
| 9   | `timelock`                 | optional record | `locked_until` (u64), `encrypted_binding_key` (bytes) and `binding_key_nonce` (bytes), in that order.  |

The plaintext of field 8 is a bincode record of two values: the file name as a string, then the hash as bytes. Its associated data is the header digest.

**Header digest:** A SHA-256 over these items, in order.

1. The ASCII text `QRE-V8-HEADER`.
2. The version, 8, as a `u32`.
3. The header length as a `u32`. This is the number of bytes of the stored header, the same value as at offset 4.
4. `vault_id`: one byte, `0` for none or `1` for present, followed by its length (u64) and bytes if present.
5. `validation_nonce`, `key_wrapping_nonce`, `base_nonce` and `meta_nonce`, each as a length (u64) followed by the bytes.
6. The time-lock: one byte `0` or `1`, and if present `locked_until` (u64), then `encrypted_binding_key` and `binding_key_nonce`, each as a length (u64) followed by the bytes.

The fields follow the order of the table above. The digest leaves out the contents of the three sealed fields (3, 5 and 8), because they authenticate themselves. Their sizes are part of the stored length, so they are covered that way. Change any other byte of the header and the digest changes, so the file key, the secret details and every chunk stop opening.

The digest includes the version and the length so that a header can never be read as another version or another length. The version already chooses the parser, and the length must match exactly, so these two entries are a second line of defence and cost nothing.

The key check (field 3) is deliberately not tied to the digest. It is only there to tell a wrong key from a damaged file. If it were tied to the header, a damaged header would fail it in the same way as a wrong password, and the user would be told to retype a password that was right. With no associated data it passes whenever the key is right, so every failure after it can be reported as damage to the header (section 4.8). This costs nothing in security: the file key and the details are still bound to the digest, and the key check carries no secret.

**Chunks:** The layout, the compression and the nonce are the same as in section 4.3. Only the associated data differs. It is the ASCII text `QRE-V8-CHUNK`, the 32-byte header digest and the chunk number `i` as a little-endian `u64`. It is binary, not decimal text, and it holds no file name. A chunk may expand to at most 1 MiB when it is decompressed, and the reader stops there (section 14, item 14).

**Time-lock:** The binding key is sealed with the associated data `QRE-V8-BINDING-KEY` followed by `locked_until` (u64). The date is therefore part of the seal, and a file whose date was edited can no longer unseal its binding key (see section 7).

A program that opens a version 8 file follows section 4.5 with these changes. It reads the header length and the header, computes the digest, and checks the time as in section 7. It then opens the binding key (if there is one), the key check and the file key, and finally `encrypted_meta`, which gives the name and the hash. Each chunk is opened with the version 8 associated data. At the end it compares the hash from `encrypted_meta` with SHA-256 of everything written. When it writes the file, it uses only the cleaned last part of the name (section 10).

### 4.8 Errors in version 8

The order of the checks decides which message the user sees.

| Order | Check                                                     | Message when it fails                                                                                     | What it means                                                                                     |
| ----- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1     | Header length is 1 to 65536 and the header uses all of it | `Corrupt header: invalid header length`, or `Failed to parse V8 header`                                   | The file is not a version 8 file, or the length field or the header was damaged or padded.        |
| 2     | Time-lock date (only if the file has a `timelock` record) | `TIME_LOCKED:<unix time>:This file is time-locked for <duration>.`                                        | The date has not been reached. No key is touched, so nothing is said about the password.          |
| 3     | Binding key opens (time-locked files only)                | `Decryption Denied. Password or Keyfile is incorrect, or the file header was changed.`                    | Wrong master key, or the date or another time-lock field was edited. These fail at the same step. |
| 4     | Key check opens, file without a time-lock                 | `Decryption Denied. Password or Keyfile is incorrect.`                                                    | Wrong password or key file. Damage to the key check's own bytes looks the same (see below).       |
| 4     | Key check opens, time-locked file                         | `The file header is damaged or was changed. The password may be right.`                                   | Step 3 already proved the master key, so the key check can only have been damaged.                |
| 5     | File key opens, then the secret details open              | `The file header is damaged or was changed. The password may be right.`                                   | The key is right, but a header field covered by the digest, or the details block, was changed.    |
| 6     | Each chunk                                                | `Chunk N integrity check failed`, `Chunk N is incomplete: the file is truncated.`, `Chunk N size anomaly` | The data was changed, cut inside a chunk, or a length field is wrong.                             |
| 7     | Whole-file hash                                           | `INTEGRITY ERROR: File hash mismatch. The encrypted file may be truncated or corrupt.`                    | The file was cut at a chunk boundary, so whole chunks are missing.                                |

A chunk that expands to more than 1 MiB is refused with `Chunk expands to more than 1048576 bytes. The file is corrupt.` This applies to every format.

One case cannot be told apart: damage to the 53 bytes of the key check itself, which are the validation nonce and tag. For a file locked in the local vault they sit at header offsets 14 to 66. A flipped bit there makes the key check fail like a wrong key. A test flips every header byte and requires that the "wrong password" message appears only inside that window.

## 5. Vault files (format 8)

Passwords, notes, bookmarks and the clipboard history each have their own file: `passwords.qre`, `notes.qre`, `bookmarks.qre` and `clipboard.qre`. They sit next to the keychain. Every vault file is a **format 8 file**, exactly as section 4.7 describes it. The content is the JSON of the vault. The code is `seal_vault_file` and `open_vault_file` in `crypto_stream.rs`, and `read_vault_file` and `write_vault_file` in `commands/vault.rs`.

What differs from a file locked in the Files screen:

| Part                         | In a vault file                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `vault_id`                   | The id of the vault: `local`, or the id of a portable USB vault.                                                   |
| The name inside `encrypted_meta` | One fixed name per file: `passwords.json`, `notes.json`, `bookmarks.json` or `clipboard.json`.                  |
| The hash inside              | The SHA-256 of the whole JSON.                                                                                     |
| Time-lock and key file       | None. A vault file that carries a time-lock is refused.                                                            |
| Compression                  | zstd level 3 for each chunk.                                                                                       |
| Random numbers               | No Paranoid Mode. The file key and the nonces come from the system seed alone (section 3).                         |
| Size                         | A vault under 1 MiB of JSON is one chunk. The reader accepts at most 512 MiB of content, and refuses more.         |

**Writing:** The new file is written under the name `<file>.qre.part` in the same folder. A leftover `.part` file from a crash is overwritten. The file is forced onto the disk. The app then opens it again the way unlocking does: the header, the key, every chunk and the hash. Only if all of that passes is it renamed over the old vault, in one step. A failure at any point removes the `.part` file and leaves the old vault exactly as it was. The old vault is never changed in place.

**Reading:** The app checks the version, authenticates the header and every chunk, and checks the hash. It also checks that the name sealed inside is the one expected for that file. A notes vault copied over `passwords.qre` is refused, with a message that names the file. The old container format had a name inside too, but the app never compared it, so this swap went unnoticed.

**Moving old vault files:** When the app reads a vault file in the old container format (section 5.1), it parses the JSON and then writes the same bytes again in format 8 at once, with all the checks of writing. Three rules always hold. Nothing is rewritten unless the old file opened with the right key and parsed. The JSON bytes are carried over as they were, not parsed and written again. If the rewrite fails for any reason, such as a full disk, the old file stays and the vault opens as before, and the next read tries again. A vault that is never opened stays in the old format. After the rewrite, apps older than version 2.9.1 cannot open that vault file (limit 12). To keep the way back open, copy the four vault files before the first start of the new version.

**What is protected, and what a test checks:**

| Property                                                                    | Result | How it is tested                                                              |
| --------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| The content, the inner name and the hash cannot be read without the key     | Yes    | The raw file is searched for the content, the name and the hash.              |
| Any change to any byte is refused                                           | Yes    | One bit is flipped in every byte of a file in turn, and each is refused.      |
| A file cut at any length is refused, including at a chunk boundary          | Yes    | Every shorter length is tried, and a file with its last chunk removed.        |
| Bytes added at the end are refused                                          | Yes    | Forty bytes are appended.                                                     |
| A vault file copied over another one is refused                             | Yes    | Notes are copied over passwords, and the read is refused with the file named. |
| A wrong key gives the "password is incorrect" message                       | Yes    | A file is opened with another key.                                            |
| A failed save keeps the old vault and leaves no temporary file              | Yes    | A missing folder and a directory in the way are both tried.                   |
| An old vault is moved only after a good read, and is kept if the move fails | Yes    | Wrong key, bad shape, damage and a blocked rewrite are each tried.            |

**Independent check:** The decoder in Appendix B opens a vault file without any change. A sample written by the app with the key byte 7 decoded to the name `passwords.json` and the right JSON, with a matching hash. A second sample of 2 MiB, which has three chunks, decoded too.

**What is not protected:** An attacker who can write the folder (A2) can still delete a vault file, or put back an older valid copy of it, and nothing notices (limit 8). The file name `passwords.qre`, the vault id, the size and the number of chunks are visible, as for any format 8 file (section 8).

### 5.1 The old container format (version 4, read only)

Earlier apps sealed a vault file as one block. The app still reads this format, so that existing vaults open and can be moved to format 8 (section 5). It no longer writes it. The same format was also used for very old locked files, which the Files screen still unlocks.

```text
version (u32) = 4
header:
    validation_nonce, encrypted_validation_tag, key_wrapping_nonce, encrypted_file_key   (as in 4.1)
    body_nonce          bytes
    uses_keyfile        bool (1 byte)
    original_hash       optional bytes
ciphertext             bytes (u64 length, then the bytes)
```

The key steps are the same as for a locked file. The body is the bincode of `{ filename: string, content: bytes }`, where `content` is the zstd-compressed JSON of the vault, sealed with the file key. There is no associated data. The `original_hash` is the SHA-256 of the uncompressed JSON. The ciphertext length is a `u64`, and a test sets it to 2^60 to show that the file is refused cleanly, without trying to allocate that much.

The whole body is one AES-GCM block, so any change to the ciphertext is detected. Three header fields had no associated data and no tag of their own. They are the reason vault files were moved to format 8.

| Field           | If it is changed                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `body_nonce`    | The body no longer opens. The vault is refused, nothing is exposed.                                                        |
| `uses_keyfile`  | Only the friendly "this file needs a key file" message changes. The key is always derived from what the user supplied.     |
| `original_hash` | The check after decryption fails and the vault is refused. It cannot make a changed body pass, because the body is sealed. |

An attacker who could write the file could make a vault unreadable, but could not change what it contained. The hash was readable in the clear. For an empty vault the JSON is a known short text, so its hash was known too.

## 6. Key files and Paranoid Mode

A key file adds a second thing you must have to open a file. The app reads the whole file, takes its SHA-256 and mixes that into the wrapping key as shown in section 3. The key file is never stored. Lose it and the files locked with it cannot be opened. A time-locked file cannot also use a key file.

Paranoid Mode changes only how the random numbers are made (section 3). It does not change the layout of the file.

## 7. Time-lock

A time-locked file has a `timelock` record in its header. New files are version 8, and files from older apps are version 7. The first parts of this section describe version 7, and the paragraphs headed "Version 8" say what changes.

**How it is made.** The app makes a random 32-byte _binding key_. It seals the binding key under the wrapping key that uses only the master key and the label `NO_KEYFILE`, and stores it in `encrypted_binding_key`. The file key is then wrapped under a key built from the master key and `SHA-256(binding key)`. The date is stored in `locked_until` as Unix seconds.

**How it is checked.** Before anything else, the app asks for the current time.

- Online: it asks three NTP servers (`time.cloudflare.com`, `time.google.com`, `pool.ntp.org`), takes the middle answer, and uses it.
- Offline: it uses the device clock.
- In version 7 it also never uses a time lower than `ratchet_max_seen`, the highest time it has seen for this file. Version 8 has no ratchet.

If that time is earlier than `locked_until`, the app refuses to continue and says how long is left. The refusal comes before the password is checked, so a locked file never tells you whether your password was right. In version 7 each refusal also writes the highest time seen back into `ratchet_max_seen`, in place, in the header.

**What this does and does not protect against.** It is a strong reminder and a good guard against honest mistakes, but it is enforced by the app, not by the mathematics.

- Anyone who knows the master key can open the file early. The binding key is sealed only under the master key, so the app can unseal it at any time. In version 7 the date is just a number that nothing authenticates, and changing `locked_until` to 1 makes the app open the file at once, which was tested.
- Offline, setting the device clock forward opens the file.
- The date is visible in the clear, without any key.

A lock that holds against its own owner would need a secret that nobody holds until the date, such as one released by a time server. This version does not do that.

**Version 8:** A version 8 file has the same checks in the same order, with two differences.

- The date is authenticated. It is part of the associated data of the sealed binding key and of the header digest. If `locked_until` is edited, in either direction, the binding key no longer opens and the app says the header was changed. Setting it to 1 no longer opens the file. A test makes that edit to a version 7 file and to a version 8 file and shows the difference.
- There is no ratchet, and the file is never written to when an unlock is refused. A test unlocks and refuses a file several times and requires it to stay byte for byte the same.

**Why the ratchet was removed.** In versions 6 and 7 the ratchet records the highest time seen during a refused attempt. The open rule takes the later of the clock and the ratchet and compares it with the date. Two facts show that this never changes the outcome.

- The ratchet is only written during a refusal, when the time seen was already earlier than the date. It is therefore always earlier than the date.
- If the ratchet is below the date, then "the later of the clock and the ratchet" is below the date exactly when the clock is. The answer is the same with or without the ratchet.

Turning the clock back cannot open a time-locked file, because it makes the time earlier. The only thing the ratchet changed was the "time remaining" text. The only way it could change the answer was in the wrong direction, if someone wrote a large value into it, which in version 7 needs nothing more than a hex editor. An earlier draft of version 8 sealed the ratchet to prevent that. Removing it is simpler and safer, and it also means a version 8 file is never rewritten, so a power cut cannot damage one in the middle of a refusal. Version 7 files still carry a ratchet, and the app still writes it, so a forged ratchet still opens an old time-locked file early. That is one more reason to lock old files again.

Back to version 8: what stays the same matters more than what changed. The master key unseals the binding key, so a program that knows this format and holds the master key can seal it again under a different date. Offline, setting the clock forward still opens the file. So the change raises the bar from a hex editor to a purpose-written program. It does not make the lock hold against its owner.

**Limits on the date.** The command that creates a time-lock accepts a date from one minute to 50 years ahead. The frontend repeats the check for the user's benefit only. The format itself accepts any `u64`.

**Further notes for a reviewer.**

- **Denial of service by editing the date.** The time check runs before any key is used, so that a locked file never reveals whether the password was right. The price is that a changed date is believed until the binding key is tried. A date moved far into the future makes the app refuse the file, and a date moved into the past gets no further than the binding key. Someone who can write the file can also delete it, so this adds no new power.
- **NTP is not authenticated.** The median of three answers resists one bad server. It does not resist an attacker who controls the network path and answers all three. NTS and Roughtime were considered and not adopted, for these reasons. A network attacker who moves the clock forward only makes the lock expire early for the owner, and still cannot open the file without the password. The owner can reach the same result offline by setting the device clock forward. Authenticated time would add a dependency and a server list and protect nothing the lock promises.
- **Verify after locking** does not apply the time-lock, so a new time-locked file can be checked at once without the clock or the network.

## 8. What is visible without the key

In versions 5 to 7, everything in the header is stored in the clear.

| Visible                               | Why it matters                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `original_filename`                   | Anyone holding the file can read the name, such as `tax-return-2024.pdf`.                                                                |
| `original_hash`                       | The SHA-256 of the whole original file. A person who already has a copy of the file, or can guess it, can confirm that this is the file. |
| `vault_id`                            | Which vault the file belongs to.                                                                                                         |
| `locked_until` and `ratchet_max_seen` | For time-locked files only.                                                                                                              |
| File size                             | Close to the original size, reduced by compression. The number of chunks shows roughly how large it is.                                  |

The contents of the file, and the file key, are not visible.

In those versions, only some header fields are covered by a tag. The validation tag proves the key is right, the wrapped file key is authenticated, and the file name is bound into every chunk through the associated data, so changing the name makes every chunk fail. The other header fields, including `locked_until`, `vault_id` and `original_hash`, are not authenticated. The app therefore treats the header as untrusted. It checks lengths and verifies the whole-file hash at the end. It also uses only the last part of `original_filename` when it picks the output name, so a damaged header cannot point outside the chosen folder.

Version 8 removes these exposures (section 4.7). The file name and the hash are inside `encrypted_meta`, and every other field is authenticated. Files made by older apps keep their exposures until they are locked again.

What a version 8 file shows to someone who has the file and no key:

| Visible              | Why it matters                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The version          | It is a QRE format 8 file.                                                                                                                                                      |
| `vault_id`           | Which vault it belongs to. The local vault is always `local`, so it is the same for everyone. A portable USB vault has a random id that links its files together.               |
| `locked_until`       | For time-locked files only. It shows when the file becomes available.                                                                                                           |
| The header length    | A few hundred bytes. It is 265 for an ordinary file with the name `hello.txt` and 349 for a time-locked one, and it grows with the length of the file name and of the vault id. |
| The file size        | Close to the original size, reduced by compression. The name length leaks a little through the header length.                                                                   |
| The number of chunks | Roughly how large the original is, in steps of 1 MiB.                                                                                                                           |

Not visible: the file name, the hash, the key and the content. Whether a file has a time-lock is visible, because the `timelock` record is present.

## 9. The keychain (`keychain.json`)

The keychain is JSON with these fields.

| Field                                                              | Meaning                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `vault_id`                                                         | A random id (UUID) for this vault.                                                                                 |
| `kdf_memory`, `kdf_iterations`, `kdf_parallelism`                  | Argon2id settings: 65536 KiB, 3 passes and 4 lanes for new vaults. Stored per vault, so older vaults keep working. |
| `password_salt`, `password_nonce`, `encrypted_master_key_pass`     | Slot 1: the master key sealed under a key derived from the password.                                               |
| `recovery_salt`, `recovery_nonce`, `encrypted_master_key_recovery` | Slot 2: the same master key sealed under a key derived from the recovery code.                                     |

The key-encryption key is the 32-byte Argon2id output (version 0x13) for the password or the recovery code and the matching salt. The recovery code has 128 bits of randomness, shown as `QRE-` followed by four groups of eight hexadecimal digits. Changing the password replaces slot 1 only.

**Limits on the settings.** `kdf_memory`, `kdf_iterations` and `kdf_parallelism` are read from this file before the password is used, and anyone who can write the folder can edit them. The app refuses a keychain whose settings exceed 1 048 576 KiB (1 GiB) of memory, 16 passes or 16 lanes, with the message `Invalid KDF parameters`. Those limits are the largest values the app itself writes (the Paranoid portable tier is 1 GiB, 10 passes and 4 lanes) with room above for passes and lanes. The check is in the shared key derivation of both the desktop keychain and the portable USB keychain, and it runs before any memory is allocated. A test sets the memory to four billion KiB and requires an immediate refusal.

**The file is not authenticated as a whole, by design.** Nothing in `keychain.json` is covered by a MAC. The two slots are sealed with AES-GCM, so the master key cannot be changed, but the settings, the salts, the nonces and `vault_id` can be edited by someone with write access. The effect of each edit:

| Edit                                                        | Effect                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lower or raise the KDF settings                             | The slot no longer opens, because the key is derived with other settings. It cannot weaken anything. Values above the limit are refused at once.          |
| Change a salt or nonce                                      | The slot no longer opens.                                                                                                                                 |
| Swap slot 1 and slot 2                                      | Neither opens with its own secret. The nonces are length-checked before use, so there is no crash.                                                        |
| Change `vault_id` in the desktop keychain                   | Nothing. Files of the local vault always carry the id `local`, not this value.                                                                            |
| Change `vault_id` in a portable USB keychain                | The vault is registered under another id. Its files still carry the old id, so the app asks for a portable vault it does not have and refuses them.       |
| Replace the whole file with a keychain made by the attacker | The user's password no longer works, which is noticed at once. The attacker gains no access to existing files, which are sealed under the old master key. |
| Delete the file                                             | The vault cannot be opened except with a backup of the keychain, which the app can restore.                                                               |

Every edit is therefore a denial of service at most, and an attacker with write access can delete the file anyway. A MAC would change the failure message and nothing more, and it would need a key, which the app only has after the password is typed. For that reason the file is left as plain JSON that a user can read, back up and restore.

**Recovery code and password change.** Slot 2 holds the same master key as slot 1. Changing the password replaces slot 1 and leaves slot 2 alone, so a recovery code that has leaked still opens the vault after a password change. Using the code to get back in has the same effect: it replaces slot 1 and the code keeps working. The app therefore says so at those two moments. After a password change it shows "Your recovery code did not change", and after a recovery it shows "You just used your recovery code, and it still works". Both offer **Make a new recovery code** and **Keep my current code**, and the new code is made at once, without a second question. The app does this through `reset_recovery_code`, which makes a new code and replaces slot 2 using the master key from the open vault. It cannot help if the attacker already has an old copy of `keychain.json`, because that copy still holds the old slot 2. The notice goes away when the session ends. It does not force a choice.

**Argon2 settings:** The default of 64 MiB, 3 passes and 4 lanes balances the cost of a guess against the time to unlock. Both slots share one set of settings, so raising them for an existing vault means re-sealing both slots, which needs the password and the recovery code together. The app does not do that. The portable USB vault offers three higher tiers (256 MiB, 512 MiB and 1 GiB) when it is created.

## 10. Writing safely, and what happens when something goes wrong

The app is built so that a failure never leaves something that looks finished but is not.

| Situation                                                                                                               | What the app does                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locking a file                                                                                                          | Writes `name.qre.part`, forces it onto the disk, then renames it to `name.qre`. A `.qre` file exists only when it is complete. If locking fails, the `.part` file is removed.                                                                                                                                     |
| Checking the new file                                                                                                   | Opens it once, like unlocking, and removes it if anything is wrong (see below).                                                                                                                                                                                                                                   |
| Unlocking a file                                                                                                        | Writes `name.part`, checks every chunk and the whole-file hash, then renames it. If anything fails, the `.part` file is removed, so no half-decrypted file is left.                                                                                                                                               |
| A wrong password                                                                                                        | No output file is created at all.                                                                                                                                                                                                                                                                                 |
| A damaged, cut-off or extended `.qre` file                                                                              | Unlocking fails with a message and leaves nothing behind. A cut inside a chunk says the file is truncated.                                                                                                                                                                                                        |
| A name that is already taken                                                                                            | The app adds a number, such as `report (1).pdf`. It never overwrites an existing file.                                                                                                                                                                                                                            |
| Saving a vault file or the keychain                                                                                     | Writes a temporary file in the same folder (hidden for the keychain, `.part` for a vault file), forces it onto the disk, then replaces the real file in one step. A vault file is also opened again first. The old vault stays whole until the new one is complete. A crash or a full disk cannot leave a vault empty or cut off.                                                                       |
| Locking a folder fails partway                                                                                          | The temporary zip of the folder is removed.                                                                                                                                                                                                                                                                       |
| A file name in the header with folders, an absolute path, a device name, direction controls, or trailing dots or spaces | Only the last part is used. Characters that reverse the direction of text become an underscore. On Windows, trailing dots and spaces are dropped, and a name that is a device (`CON`, `AUX .txt`, `COM1`, and so on) or contains a character Windows forbids is refused, with or without a trailing space or dot. |

A crash or power cut can still leave a `.part` file or a hidden `.tmp` file in the folder. It is safe to delete them. A `.part` file is never a valid `.qre` file.

**Details for a reviewer.**

- **Names:** The `.part` name is made unique before the file is created, so two runs, or a leftover from a crash, never share one. The final name is also made unique, with a number added. Locking chooses it once, before the work starts. Unlocking chooses it again just before the rename. A file that another program creates under the locking name during a long lock would therefore be replaced by the rename. This is a narrow race and is listed in section 14. The vault and keychain saves replace their target on purpose, and they use a hidden temporary name in the same folder.
- **What is synced:** The file's bytes are synced to disk before the rename (`sync_all`). The folder that contains the file is **not** synced after the rename. On Linux and macOS a power cut just after a rename can therefore lose the rename while keeping the data, which leaves a complete `.part` file and no `.qre` file. It cannot leave a cut-off `.qre` file. Windows has no equivalent call, so the gap is left open on all systems. It is listed in section 14.
- **Order of the steps:** Locking writes, syncs, renames, and only then runs the check. A failed check removes the new file. The original is never touched by any of these steps.
- **Same folder:** The temporary file is always created in the folder of its target, so the rename never crosses a file system and is atomic on the platforms the app supports.

Locking never deletes or changes the original.

### Verify after locking

By default the app opens each new locked file once before it reports the lock as done. This is the **Verify After Locking** option in the options menu of the Files screen. It is on by default and the choice is remembered.

The check goes through the same steps as unlocking. It reads the header, unwraps the file key, authenticates every chunk and compares the whole-file hash. It writes nothing and never changes the file. It takes about as long as locking did, so the progress bar shows locking in its first half and the check in its second half.

- If the check fails, the locked file is removed and the message says so, and that the original was not touched. A locked file that cannot be opened looks like a backup and is not one.
- A time-locked file is checked without applying the lock. The check reads neither the clock nor the network, does not change the file, and does not unlock anything.
- What it proves: the bytes on disk are the bytes that were meant to be written, and the key the app holds opens them. A disk that failed to write, or a file cut short, is caught.
- What it cannot prove: that you remember your password. Only you can check that.

Turn it off for very large files if the extra time matters, and open the locked copy once yourself before you shred the original.

### Re-locking old files

The app can rewrite a locked file of format 5, 6 or 7 as format 8. This is the **Upgrade Older Locked Files…** item in the options menu of the Files screen. It is the answer to the exposures of the older formats (section 8) and to limit 1 in section 14.

**Finding the files:** A scan of the open folder, and its sub folders if the user leaves that box ticked, lists the `.qre` files whose version is 5, 6 or 7. It reads only the first four bytes of each file, plus the header of a version 6 or 7 file to learn whether it is time-locked. It does not follow symbolic links. It goes at most 12 folders deep and looks at most 50 000 entries, so that a very large tree is cut off and not scanned for ever. Nothing is changed by the scan.

**Three ways to start it:** The same function does the work in all three, so the rules below hold for each.

1. **The dialog:** Upgrade Older Locked Files… scans a folder and upgrades what it finds.
2. **One file:** Right-click a `.qre` file and choose Upgrade Format. The entry is offered only for files whose version is 5, 6 or 7. The Files screen learns the version from the same call that reads the time-lock status (`get_file_timelock_status`), which now also returns `format_version`: the first four bytes of the file, or 0 if the file cannot be read. Only 5, 6 and 7 count as old. If several files are selected, the old ones among them are upgraded.
3. **Automatically when unlocking:** The setting Upgrade Older Files When Unlocking is **off by default** and is remembered. When it is on, a file that was in an older format and **unlocked successfully** also has its locked copy rewritten, right after the unlock. A file that did not unlock, for example because of a wrong key file or a time-lock that has not ended, is never touched. The setting applies to unlocking from the toolbar, the right-click menu, a drop on the window and extraction from a USB drive. It is off by default because it replaces files without asking each time.

**Seeing which files are old:** The Details panel of the Files screen shows the version from the same `format_version` value. A file in version 5, 6 or 7 gets an "Older format (version N)" badge and a note, a version 8 file gets "Current format", and any other value shows nothing. With several files selected, the panel counts the older ones. Only `.qre` files are described this way. Nothing here reads more than the first four bytes of the file and, for a time-lock, the header.

When an upgrade follows an unlock, the unlock problems and the upgrade problems are shown together in one message, and a success is shown as a short notice.

**What happens to each file:**

1. The file is opened with the vault's master key, and the key file if one was selected, exactly as unlocking would. A wrong key, a damaged chunk or a file cut inside a chunk stops here.
2. A new file is written next to it under a `.part` name, in format 8. Each piece is decrypted and sealed again in memory, one chunk at a time. **The plaintext is never written to the disk.** A test watches the folder while the upgrade runs and requires that nothing but the `.part` file appears.
3. The old header's hash is compared with the plaintext at the end, as in a normal unlock, and the new header carries that hash. If the old header has no hash, the file is read once more first to find it.
4. The new file is opened from start to finish, as in verify after locking. If that fails, the `.part` file is removed and the old file is untouched.
5. Only then is the `.part` file renamed over the old file. The name does not change. The vault id, the key file and the file name inside the header are kept.

If any step fails, the old file stays exactly as it was and no `.part` file is left. Tests check this byte for byte for a wrong password, a damaged chunk, a cut file, a wrong hash, a file already in format 8 and a file that is not a locked file.

**Time-locks:** A file whose lock has not ended is refused with `TIME_LOCKED` and left alone. The owner could open it early with the master key, but doing that here would end the lock without being asked. A lock that has ended is not carried over, because it no longer locks anything. Version 7 time-locked files that are still locked therefore stay in version 7 until their date has passed.

**What re-locking does not do:** It keeps what the old file says. A version 6 or 7 file that was cut at a chunk boundary by someone who then rewrote its hash (limit 1) passes the old checks, so it is upgraded as it is. The new file then carries a hash that matches the cut content. Format 8 protects a file from the moment it is written. It cannot recover a loss that the old format could not see.

**Files that need something else:** A file locked with a key file needs the same key file, and the message says so. A file of a portable USB vault needs that vault to be unlocked, and is rewritten in place on the drive, again with no plaintext. The compression level is the automatic one for the file's type.

| Version | Used for                                                   | Written now | Read |
| ------- | ---------------------------------------------------------- | ----------- | ---- |
| 4       | Vault files from older apps; very old locked files         | No          | Yes  |
| 5       | Older locked files; no time-lock field                     | No          | Yes  |
| 6       | Ordinary locked files from older apps                      | No          | Yes  |
| 7       | Time-locked files from older apps (fixed 4096-byte header) | No          | Yes  |
| 8       | Every new locked file and every vault file                 | Yes         | Yes  |

A version the app does not know is refused with the message `Unsupported file version`. A change to this format will use a new version number, and the app will keep reading the old ones.

## 12. Tests

The tests are in `src-tauri/src`. Run them with `cargo test --lib` inside `src-tauri`. The counts below were taken when this section was written, and the whole suite has 836 tests that run by default, and 6 more that change the real Windows clipboard and run only on request. The frontend suite (`npm test`) is separate and has 2 433 tests. It covers the upgrade dialog, the recovery code notice, and the toolbar and Files screen wiring.

| File                          | Tests | What it covers                                                                                                                                                                                                                                                             |
| ----------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto_failure_tests.rs`     | 53    | Section 10: damaged, cut-off and extended files, wrong passwords, header names that point outside the folder, safe writes, zip failures, huge length fields in vault files and version 6 headers.                                                                          |
| `crypto_verify_tests.rs`      | 20    | Verify after locking, including that it never applies a time-lock and never changes the file.                                                                                                                                                                              |
| `crypto_v8_tests.rs`          | 46    | Format 8: the default format, round trips, hidden name and hash, every header byte flipped, cut headers, padding, the date, files never modified, the header digest against known answers, and reading older formats.                                                      |
| `crypto_v8_messages_tests.rs` | 6     | Section 4.8: a wrong key and a damaged header give different messages, and the "wrong password" message appears only for the key check's own bytes.                                                                                                                        |
| `crypto_command_tests.rs`     | 31    | The lock, unlock and time-lock commands as the app runs them, without a window: vault keys, USB vault routing for every format, progress, refusals, batches, folders, key files.                                                                                           |
| `keychain_limits_tests.rs`    | 6     | The limits on key derivation settings read from `keychain.json` (section 9).                                                                                                                                                                                               |
| `crypto_hardening_tests.rs`   | 12    | The 1 MiB limit on how far one chunk may expand, and the cleaning of file names (direction controls, trailing dots and spaces, device names).                                                                                                                              |
| `crypto_relock_tests.rs`      | 43    | Re-locking (section 10): versions 5, 6 and 7 become 8, nothing is written in the clear, a failure leaves the old file untouched, time-locks, key files, USB vaults, a missing hash, the folder scan, and the command.                                                      |
| `crypto_cancel_tests.rs`      | 35    | Cancelling a long job: the stop is honoured while hashing, zipping a folder, sealing chunks, verifying, unlocking, upgrading and time-locking; nothing half-made is left behind; the original is untouched; finished files stay finished; two jobs do not stop each other. |
| `os_clipboard_tests.rs`       | 25    | Files on the system clipboard: the exact bytes Explorer reads and writes, reading lists from other programs, the checks on paths, and how the commands are wired. Six more tests use the real Windows clipboard and run with `--ignored`.                                  |
| `vault_v8_tests.rs`           | 33    | Vault files in format 8 (section 5): round trips of every size, hidden name and hash, every byte changed, every cut length, a swapped file, failed saves, and moving old vault files. |
| `tests.rs`                    | 94    | Round trips for every version, vault files, the keychain, portable vaults, the cleaners and other parts of the app.                                                                                                                                                        |

The rest of the suite sits next to the code it tests, for example `commands/files/tests.rs` for the verify option and the time-lock clock tests.

**Two kinds of checks:** Most tests run the real code on real files. A few read the source text (`include_str!`) to confirm that a rule is still wired in where a test cannot trigger it, for example that the file is synced before the rename. They are named in the code and are marked as source checks.

**Mutation checks:** For each rule in sections 4.7, 4.8, 7, 9 and 13, a line of the code was broken on purpose and the suite was run to see whether a test failed. About 70 such breaks were tried across the format 8 code, the commands, the key derivation limits and the file name rules. Every one was caught except three, which are not gaps:

- Removing the time-lock flag byte from the header digest is not detectable, because the digest still differs between a file with a time-lock and one without it, through the extra date bytes that follow.
- Removing the date from the binding key's associated data alone is not detectable, because the date is also in the header digest. This is a deliberate second layer. Removing both is caught.
- Removing the 1 MiB limit while decompressing a chunk gives the same result as keeping it, because the size is checked again afterwards. Only the memory used differs, and a test cannot see that. A source review confirms that the limit is applied while reading.

**Independent decoder:** The decoder in Appendix B was written from section 4.7 without reading the Rust code. It opens the two sample files in Appendix A and agrees with the app on the name, the content and the hash. A wrong key and a flipped header byte are refused. The header digest is also fixed by known-answer tests in `crypto_v8_tests.rs`. Their expected values were computed by a separate program that follows section 4.7, not by the Rust code, so the two implementations must agree on the version, the stored length, the field order and the time-lock fields.

## 13. Threat model and what is protected

### Attackers considered

| Attacker                                           | What they can do                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A1: has a copy of a `.qre` file, no key            | Cloud storage, a lost disk, a backup. Reads everything in the file and can try passwords offline against the keychain if they also have it. |
| A2: can also change files, no key                  | A sync tool, a malicious host, malware that does not know the password. Can edit, cut, extend, replace or delete files and `keychain.json`. |
| A3: has the master key                             | The owner, or malware inside an unlocked session. Can do anything the app can do.                                                           |
| A4: controls the network                           | Can answer time requests.                                                                                                                   |
| A5: has an old `keychain.json` and a recovery code | A leaked backup. Can open that vault whatever happens to the password later.                                                                |

**Not considered:** reading the app's memory while it runs, a keylogger, a weak password, side channels, and whether an SSD really erased shredded data.

### Properties

"Yes" means a test checks it.

| Property                                                         | Formats 5 to 7                                                 | Format 8                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Content is unreadable to A1                                      | Yes                                                            | Yes                                                |
| File name is unreadable to A1                                    | No, it is in the header                                        | Yes                                                |
| Plaintext hash is unreadable to A1                               | No                                                             | Yes                                                |
| A2 cannot change the data unnoticed                              | Yes, every chunk is sealed                                     | Yes                                                |
| A2 cannot reorder or splice chunks                               | Yes, the index is in the nonce and the data                    | Yes, and the header digest is in the data too      |
| A2 cannot cut the file at a chunk boundary unnoticed             | **No.** The hash is editable, so cut file and new hash verify. | Yes, the hash is sealed                            |
| A2 cannot change a header field unnoticed                        | Only some fields                                               | Every field and the version and length             |
| A2 cannot move the time-lock date                                | No, but A2 also cannot open the file                           | Yes                                                |
| A3 cannot open a time-locked file early with a hex editor        | No, editing the date or the ratchet works                      | Yes, but a purpose-written program can (section 7) |
| A refused unlock never changes the file                          | No, version 7 rewrites its ratchet                             | Yes, byte for byte                                 |
| A wrong key and a damaged header give different errors           | Not applicable                                                 | Yes, except for the 53 bytes of the key check      |
| The header cannot have extra bytes added                         | Not applicable                                                 | Yes                                                |
| A2 cannot make the app allocate huge memory from a length field  | Yes, tested for version 6 headers                              | Yes, the header length is capped at 64 KiB         |
| A2 cannot make the app allocate huge memory from `keychain.json` | Yes, since the KDF limits                                      | Yes                                                |
| A chunk cannot expand without limit when it is decompressed      | Yes, 1 MiB                                                     | Yes, 1 MiB                                         |
| An unlocked file cannot be named to read backwards               | Yes, direction controls are replaced                           | Yes                                                |
| An unlocked file cannot be named after a device on Windows       | Yes, including a trailing space or dot                         | Yes                                                |
| A4 cannot move the time-lock early                               | No, NTP is not authenticated                                   | No, same                                           |
| A5's old recovery code stops working after a password change     | No                                                             | No (section 9)                                     |

## 14. Known limits

Each item says how serious it is for the user and what has been decided. "Open" means not fixed, and it is known.

| #   | Limit                                                                                                                                                                                                                                                                                                         | Severity           | Status                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Formats 5 to 7 can be cut at a chunk boundary by A2, and the new hash can be written to match.** The app accepts the shorter file. Format 8 closes this. Version 7 time-locks can also be opened early by editing the date or the ratchet.                                                                  | High for old files | **Mitigated.** Upgrade Older Locked Files… rewrites them in format 8 (section 10). It covers only the files the user upgrades, and it keeps what the old file says, so an already-cut file is upgraded as it is. Still-locked version 7 files must wait for their date. |
| 2   | The time-lock does not hold against its owner (section 7). The user interface and the Help text say so.                                                                                                                                                                                                       | By design          | Accepted. A lock that holds needs a secret released by a third party, which is a different product.                                                                                                                                                                     |
| 3   | `keychain.json` is not authenticated as a whole (section 9). Every edit is a denial of service at most.                                                                                                                                                                                                       | Low                | Accepted, with the KDF limits added.                                                                                                                                                                                                                                    |
| 4   | Format 8 shows the vault id, the time-lock date and whether a time-lock exists, the header length and the file size (section 8).                                                                                                                                                                              | Low                | Accepted. The vault id is needed to pick the key. The local vault always uses `local`.                                                                                                                                                                                  |
| 5   | **Fixed.** Vault files had a readable SHA-256 of their content and unauthenticated `body_nonce` and `uses_keyfile` (section 5.1).                                                                                                                                                         | Was low | **Fixed.** Vault files are format 8 (section 5). Old ones are rewritten when they are read. A vault never opened stays old. |
| 6   | The folder is not synced after the rename (section 10). A power cut can leave a complete `.part` file and no `.qre` file.                                                                                                                                                                                     | Low                | Open. Cannot leave a cut-off `.qre` file.                                                                                                                                                                                                                               |
| 7   | Locking chooses its output name once, before it starts. A file that another program creates there during the lock is replaced by the rename.                                                                                                                                                                  | Low                | Open. Unlocking checks again before its rename.                                                                                                                                                                                                                         |
| 8   | There is no protection against rollback. A2 can replace a `.qre` file or a vault file with an older valid copy, and nothing notices. The same holds for `keychain.json`.                                                                                                                                      | Medium             | Open. The format has no counter or signature, and adding one needs a key held outside the files.                                                                                                                                                                        |
| 9   | Changing the password does not change the recovery slot (section 9). `reset_recovery_code` does.                                                                                                                                                                                                              | Medium             | **Mitigated.** After a password change and after a recovery, the app says the code still works and offers a new one in one click. It does not force the choice, and it cannot help against an old copy of `keychain.json`.                                              |
| 10  | One set of Argon2 settings per vault (section 9). Raising them needs the password and the recovery code together.                                                                                                                                                                                             | Low                | Accepted.                                                                                                                                                                                                                                                               |
| 11  | NTP is not authenticated (section 7). A network attacker can make the clock jump forward and so end a lock early, but cannot open the file. The owner can do the same offline.                                                                                                                                | Low                | Accepted. Authenticated time would protect nothing that limit 2 does not already give away.                                                                                                                                                                             |
| 12  | Older apps cannot open format 8 files. A phone that is not updated cannot open files made on a desktop that is, nor a vault file the newer app has rewritten.                                                                                                                                                                                               | Medium             | Accepted. All platforms must be released together.                                                                                                                                                                                                                      |
| 13  | Not tested on real hardware: Android, a power cut during the disk sync, the Linux-only path rules (covered by the Linux CI).                                                                                                                                                                                  | Medium             | Open.                                                                                                                                                                                                                                                                   |
| 14  | The chunk length prefix is not in the associated data.                                                                                                                                                                                                                                                        | None               | Accepted. A wrong length shifts the ciphertext and the tag fails. A test cuts and extends files.                                                                                                                                                                        |
| 15  | **A plaintext copy of a locked folder exists on disk while it is being locked.** The folder is first written as an uncompressed zip next to the folder, locked, and then deleted, not overwritten, so its content can stay in unused disk space. A backup or sync tool that watches the folder may upload it. | Medium             | Open. The original folder is still on the disk too, so the copy adds less than it seems. Streaming the zip straight into the encryption is hard, because the format stores the hash of the whole file before the first chunk, which needs the file twice.               |
| 16  | **A key file is mixed in as the SHA-256 of its contents, with no stretching.** If A3's master key leaks, a key file that is a common or guessable file can be found by trying candidates against the key check at the speed of AES. A random key file is not affected.                                        | Low                | Accepted. Advice: use a random file as the key file. Stretching it with Argon2 would slow every unlock and change the format.                                                                                                                                           |
| 17  | Keys are made with a plain SHA-256 over the key followed by a label, not with HKDF (section 3). The inputs are random 256-bit keys and the outputs are never shown, so no known attack applies.                                                                                                               | Informational      | Accepted. HKDF may be adopted if the format changes again.                                                                                                                                                                                                              |
| 18  | Re-locking trusts the old file (section 10). A version 6 or 7 file cut at a chunk boundary with its hash rewritten is upgraded as it is.                                                                                                                                                                      | Medium             | Accepted. The old format could not see that loss, and nothing can restore it. Format 8 prevents it for new files.                                                                                                                                                       |

## 15. Review log

Findings that outside reviewers raised, with what was decided. Reviewers looked at the text and not at the code, so each point was checked against the code before a decision was made. A reviewer who finds something new should add it here.

### Round 1

| Finding                                                                                            | Verdict                                     | Action                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formats 5 to 7 can be truncated on purpose and still verify.                                       | Correct                                     | Documented as limit 1. Format 8 closes it. No migration action exists yet.                                                                                          |
| The time check comes before the date is authenticated, so a far date is a denial of service.       | Correct, no new power for A2                | Documented in section 7. A2 can delete the file.                                                                                                                    |
| Header damage can look like a wrong password.                                                      | Correct                                     | **Fixed.** The key check is no longer tied to the header, and the error messages are separate (section 4.8). Damage to the key check itself is still ambiguous.     |
| Keychain metadata is not authenticated, so KDF settings can cause a huge allocation.               | Partly correct                              | **Fixed** for the allocation: the KDF limits (section 9). The rest is a denial of service only and is accepted (limit 3).                                           |
| Folder extraction can write outside the chosen folder.                                             | Not applicable                              | The app never extracts a zip. Unlocking a folder writes `name.zip`, and the user's own tool extracts it. Zip creation skips symbolic links.                         |
| The header length and version are not in the digest, and extra bytes after the header are allowed. | Correct about extra bytes                   | **Fixed.** The parser refuses any byte left over. A test pads a header and requires a refusal. The version and length were later added to the digest too (round 2). |
| The chunk length prefix is not in the associated data.                                             | Correct, no effect                          | Limit 14.                                                                                                                                                           |
| An invalid ratchet is treated as zero.                                                             | Correct, deliberate                         | **Gone in round 2.** Format 8 has no ratchet.                                                                                                                       |
| The ratchet key is per vault with random nonces.                                                   | Correct, negligible                         | **Gone in round 2.** Format 8 has no ratchet.                                                                                                                       |
| Vault files (format 4) have weaker header authentication and an unbounded length.                  | Correct about the header                    | **Fixed.** Vault files are format 8 (section 5). The length was never a problem: a test set it to 2^60 and the file was refused without allocating it. |
| Version 7 relies on bincode ignoring zero padding.                                                 | Correct                                     | Version 7 is read only. Format 8 has an explicit length and refuses extra bytes.                                                                                    |
| Format 8 still shows the vault id and the date.                                                    | Correct                                     | Limit 4.                                                                                                                                                            |
| NTP is not authenticated.                                                                          | Correct                                     | Limit 11.                                                                                                                                                           |
| The parent folder is not synced after the rename, and `.part` names may collide.                   | Correct about the folder; wrong about names | Limit 6. The `.part` name is made unique before the file is created (section 10).                                                                                   |
| Argon2 settings are moderate.                                                                      | Correct                                     | Limit 10.                                                                                                                                                           |
| Changing the password does not rotate the recovery slot.                                           | Correct                                     | Limit 9. `reset_recovery_code` exists.                                                                                                                              |

### Round 2

| Finding                                                                            | Verdict                                                                | Action                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corrupting the ratchet and turning the clock back bypasses the time-lock.          | Wrong: a clock turned back never opens a lock                          | The review led to a better finding: the ratchet never changed whether a file opens, because it is always below the date. **Removed from format 8** (section 7). An earlier text of this document that said the ratchet catches a clock turned back was wrong, and was corrected. |
| Unauthenticated NTP lets a network attacker end a time-lock early.                 | True, but no value in fixing                                           | Limit 11. The owner can do the same offline, and the attacker still needs the password. NTS and Roughtime were not adopted.                                                                                                                                                      |
| The plaintext `folder.zip` is left on disk and may be clobbered.                   | Partly correct                                                         | The leftover is real: limit 15. Clobbering is wrong, because the zip name goes through the unique-name function. The document said `folder.zip`, but the name is `<folder name>.zip`, and this was corrected.                                                                    |
| A key file is checked with one fast SHA-256, so a weak key file is found quickly.  | Correct, low, only after the master key leaks                          | Limit 16. Advice to use a random file.                                                                                                                                                                                                                                           |
| Keys should use HKDF, not a plain SHA-256 over the key and a label.                | Theoretical                                                            | Limit 17. Not adopted.                                                                                                                                                                                                                                                           |
| The digest lists the time-lock fields in a different order from the header.        | Correct                                                                | **Fixed.** The digest now follows the order of the header. A known-answer test with values from the independent program fixes the order.                                                                                                                                         |
| The version and the header length are not in the digest.                           | Harmless, because the version picks the parser and the length is exact | **Added** to the digest as a second line of defence. The digest is computed with placeholders of the final sizes of the sealed fields, and the writer checks that the size did not change.                                                                                       |
| A decompression bomb can fill memory.                                              | Low, because the chunk must be sealed under the file key               | **Fixed.** One chunk may expand to at most 1 MiB, and the reader stops reading there (section 4.7).                                                                                                                                                                              |
| A name with a direction control (`U+202E`) can make a file look like another type. | Correct, low                                                           | **Fixed.** Direction controls are replaced with an underscore.                                                                                                                                                                                                                   |
| Names with a colon can write to an alternate data stream on Windows.               | Wrong                                                                  | A colon was already refused on Windows.                                                                                                                                                                                                                                          |
| Trailing dots and spaces in names are not handled.                                 | Correct, and a bigger gap was found: `CON` was accepted                | **Fixed.** Trailing dots and spaces are dropped on Windows, and the device name check ignores them. A test then found that `AUX .txt` was also accepted, and that was fixed too.                                                                                                 |

## 16. Constants

### Strings

These are used as keys, labels and associated data. All are ASCII, with no terminator.

| Text                 | Used for                                                                             |
| -------------------- | ------------------------------------------------------------------------------------ |
| `QRE_VALID`          | The plaintext of the key check (all formats).                                        |
| `NO_KEYFILE`         | Wrapping key label when there is no key file.                                        |
| `KEYFILE_MIX`        | Wrapping key label when a key file or a binding key is mixed in.                     |
| `QRE-V8-HEADER`      | Start of the header digest.                                                          |
| `QRE-V8-CHUNK`       | Start of the associated data of a chunk.                                             |
| `QRE-V8-BINDING-KEY` | Start of the associated data of the sealed binding key. The date follows as a `u64`. |
| `passwords.json`, `notes.json`, `bookmarks.json`, `clipboard.json` | The names sealed inside the four vault files. |

### Numbers

| Value                  | Meaning                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| 1 048 576 bytes        | Size of one chunk of plaintext, and the most it may expand to when decompressed. |
| 1 048 576 + 4096 bytes | Largest chunk length the reader accepts.                                         |
| 65 536 bytes           | Largest format 8 header the reader accepts.                                      |
| 12, 16, 32 bytes       | AES-GCM nonce, tag, and key and hash sizes.                                      |
| 1 048 576 KiB, 16, 16  | Largest KDF memory, passes and lanes the reader accepts.                         |
| 60 seconds to 50 years | Range of a new time-lock date, checked by the command.                           |
| 5, 6, 7, 8 and 4       | Stream format versions. 4 is the old container version, read only.                            |

## Appendix A. Sample files

Both files were made by the app from a file named `hello.txt` that holds the text `hello world`, in the local vault. The master key is 32 bytes that all equal `0x07`. No key file was used. The second file is time-locked until Unix time 4 000 000 000. The nonces are random, so a new file will differ from these bytes.

To check an implementation, decode these bytes and expect the name `hello.txt`, the content `hello world`, a matching hash and the vault id `local`. The time-locked file also gives the date 4 000 000 000. The header lengths are 265 and 349.

### sample_plain

| Bytes    | Size | Field                    | Notes                                          |
| -------- | ---- | ------------------------ | ---------------------------------------------- |
| 0..4     | 4    | version                  | u32 = 8                                        |
| 4..8     | 4    | header length            | u32 = 265                                      |
| 8..22    | 14   | vault_id                 | option tag 1, length 5, "local"                |
| 22..42   | 20   | validation_nonce         |                                                |
| 42..75   | 33   | encrypted_validation_tag | "QRE_VALID" (9) + tag (16)                     |
| 75..95   | 20   | key_wrapping_nonce       |                                                |
| 95..151  | 56   | encrypted_file_key       | file key (32) + tag (16)                       |
| 151..171 | 20   | base_nonce               |                                                |
| 171..191 | 20   | meta_nonce               |                                                |
| 191..272 | 81   | encrypted_meta           | name (8+9) + hash (8+32) = 57, + tag (16) = 73 |
| 272..273 | 1    | timelock                 | option tag 0 = none                            |
| 273..277 | 4    | chunk 0 length           | u32 = 36                                       |
| 277..313 | 36   | chunk 0 ciphertext       | zstd of the data, sealed, with the 16-byte tag |

```text
0000  08 00 00 00 09 01 00 00 01 05 00 00 00 00 00 00 00 6c 6f 63 61 6c 0c 00 00 00 00 00 00 00 42 af
0020  42 7b 6a 60 0e 69 55 34 d0 19 19 00 00 00 00 00 00 00 72 b3 ed 49 46 94 cd e0 bc 47 1a 19 c2 c1
0040  3c 69 87 dd 02 8b 0f 44 79 6b 66 0c 00 00 00 00 00 00 00 25 57 25 37 62 d0 2a 50 79 79 37 60 30
0060  00 00 00 00 00 00 00 9c f1 24 81 a8 fa 1f da cf 83 ea 02 8a 3e e7 8c 58 03 06 f4 db b0 22 5a 33
0080  72 16 a8 9a 98 e0 dd 3e 86 c4 83 7a 65 58 e0 09 f9 d8 6c e9 d0 bf 90 0c 00 00 00 00 00 00 00 55
00a0  bd 2d 7d fb 1e cf cb 9f af a7 23 0c 00 00 00 00 00 00 00 11 3b 5b 2f 87 2a 97 73 8f d7 9b 41 49
00c0  00 00 00 00 00 00 00 61 7d a0 45 66 1a f6 ed d3 10 c5 90 52 16 19 37 f1 e2 65 2e 9d 16 00 da db
00e0  5c fb 1e c2 e1 40 79 18 ac 99 7e e9 4e ac 65 c3 3e ca a7 46 dc 28 a8 3d 79 96 e9 1b 95 82 1d d2
0100  98 00 53 91 2f c4 fb ed 52 d0 f9 f6 30 87 25 fd 00 24 00 00 00 49 1a ca 54 36 07 5f e4 64 b3 7a
0120  d2 f7 8f e7 77 5d 7e 52 a4 7b 5e ae 9d 3e 9c ec c4 95 a0 b0 1e 09 39 2d 06
```

### sample_timed

| Bytes    | Size | Field                    | Notes                                                                           |
| -------- | ---- | ------------------------ | ------------------------------------------------------------------------------- |
| 0..4     | 4    | version                  | u32 = 8                                                                         |
| 4..8     | 4    | header length            | u32 = 349                                                                       |
| 8..22    | 14   | vault_id                 | option tag 1, length 5, "local"                                                 |
| 22..42   | 20   | validation_nonce         |                                                                                 |
| 42..75   | 33   | encrypted_validation_tag | "QRE_VALID" (9) + tag (16)                                                      |
| 75..95   | 20   | key_wrapping_nonce       |                                                                                 |
| 95..151  | 56   | encrypted_file_key       | file key (32) + tag (16)                                                        |
| 151..171 | 20   | base_nonce               |                                                                                 |
| 171..191 | 20   | meta_nonce               |                                                                                 |
| 191..272 | 81   | encrypted_meta           | name (8+9) + hash (8+32) = 57, + tag (16) = 73                                  |
| 272..357 | 85   | timelock                 | tag 1, locked_until u64, encrypted_binding_key (8+48), binding_key_nonce (8+12) |
| 357..361 | 4    | chunk 0 length           | u32 = 36                                                                        |
| 361..397 | 36   | chunk 0 ciphertext       | zstd of the data, sealed, with the 16-byte tag                                  |

```text
0000  08 00 00 00 5d 01 00 00 01 05 00 00 00 00 00 00 00 6c 6f 63 61 6c 0c 00 00 00 00 00 00 00 24 66
0020  4a 7e 70 47 0e d5 0e 74 36 ac 19 00 00 00 00 00 00 00 c0 58 05 a4 04 4f 45 76 1b 2b cd dc 26 46
0040  4c 64 e6 d1 6c 2c 0e 22 8a 7e 31 0c 00 00 00 00 00 00 00 8b 65 11 54 38 03 a8 d5 95 f6 dd a4 30
0060  00 00 00 00 00 00 00 f4 f8 ac 47 f3 1b 4e e9 d5 4c 1c 54 5d 80 ad ef 64 4a 92 4b 4b c7 ab 85 5d
0080  ad 3c 66 ed 36 70 74 ff fb aa 67 70 c7 34 5e 54 82 62 de 11 15 1f c0 0c 00 00 00 00 00 00 00 b3
00a0  52 8e f1 fe 0d a9 93 bf 9d eb 51 0c 00 00 00 00 00 00 00 67 01 81 71 3f 7f 49 1b 82 a6 b4 47 49
00c0  00 00 00 00 00 00 00 fe f5 b8 45 80 a9 35 d5 99 0d df 57 71 de 89 42 39 d7 ca 4d 3d 14 fa 12 9a
00e0  0e cc 86 99 65 b1 0e 3e 98 d7 c2 9a b2 be 24 b1 fc c7 f0 42 48 96 da 1b b4 61 08 fc 65 bc 7f 0c
0100  d7 dc 88 68 00 33 91 76 62 e3 b1 ce 7b 16 6e e6 01 00 28 6b ee 00 00 00 00 30 00 00 00 00 00 00
0120  00 85 96 b9 77 87 e3 d6 b3 40 22 f4 c2 82 38 9f a0 05 ba fd 56 b3 dd 5b 31 45 e5 94 0a 3f 88 e5
0140  b0 95 17 2d f7 79 c9 95 00 21 96 6e 51 74 58 e7 64 0c 00 00 00 00 00 00 00 24 b4 6c fb ac 49 61
0160  39 33 56 98 b5 24 00 00 00 46 72 76 92 e6 98 3d 5e f8 59 2d 95 da 3c c8 b9 4f da df 2b a3 c5 29
0180  ad ec 47 c4 fd 92 da f2 9c 48 7a f9 b3
```

## Appendix B. An independent decoder

This program opens a format 8 file given the master key. It was written from section 4.7 alone, in Node.js (version 24 or later, for the zstd support in `zlib`). Run it as `node decode_v8.js sample.qre 7`, where 7 is the byte that fills the master key.

```js
// An independent reader of format 8, written from FILE_FORMAT.md section 4.7 only (no Rust code
// consulted). Usage: node decode_v8.js <file.qre> <master-key-byte>
const crypto = require("crypto");
const zlib = require("zlib");
const fs = require("fs");

const file = fs.readFileSync(process.argv[2]);
const master = Buffer.alloc(32, Number(process.argv[3]));
const sha = (...parts) =>
  crypto
    .createHash("sha256")
    .update(Buffer.concat(parts.map((p) => Buffer.from(p))))
    .digest();
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

function open(key, nonce, ct, aad) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

// --- bincode reader (fixed-width integers, u64 lengths, one byte for Option)
let pos = 0;
let buf = file;
const take = (n) => {
  const out = buf.subarray(pos, pos + n);
  if (out.length !== n) throw new Error("short read");
  pos += n;
  return out;
};
const readU64 = () => Number(take(8).readBigUInt64LE());
const readBytes = () => take(readU64());
const readOption = (f) => {
  const tag = take(1)[0];
  if (tag === 0) return null;
  if (tag !== 1) throw new Error("bad option tag");
  return f();
};

if (file.readUInt32LE(0) !== 8) throw new Error("not version 8");
const headerLen = file.readUInt32LE(4);
buf = file.subarray(8, 8 + headerLen);
pos = 0;
const h = {};
h.vaultId = readOption(() => readBytes().toString());
h.validationNonce = readBytes();
h.validationTag = readBytes();
h.keyWrapNonce = readBytes();
h.encryptedFileKey = readBytes();
h.baseNonce = readBytes();
h.metaNonce = readBytes();
h.encryptedMeta = readBytes();
h.timelock = readOption(() => ({
  lockedUntil: readU64(),
  encryptedBindingKey: readBytes(),
  bindingKeyNonce: readBytes(),
}));
if (pos !== buf.length)
  throw new Error("trailing bytes in header: " + (buf.length - pos));

// --- header digest
const lenField = (b) => Buffer.concat([u64(b.length), b]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const parts = [Buffer.from("QRE-V8-HEADER"), u32(8), u32(headerLen)];
parts.push(
  h.vaultId === null
    ? Buffer.from([0])
    : Buffer.concat([Buffer.from([1]), lenField(Buffer.from(h.vaultId))]),
);
parts.push(
  lenField(h.validationNonce),
  lenField(h.keyWrapNonce),
  lenField(h.baseNonce),
  lenField(h.metaNonce),
);
if (h.timelock)
  parts.push(
    Buffer.from([1]),
    u64(h.timelock.lockedUntil),
    lenField(h.timelock.encryptedBindingKey),
    lenField(h.timelock.bindingKeyNonce),
  );
else parts.push(Buffer.from([0]));
const digest = sha(...parts);

// --- keys
const baseWrap = sha(master, "NO_KEYFILE");
let wrap = baseWrap;
if (h.timelock) {
  const bk = open(
    baseWrap,
    h.timelock.bindingKeyNonce,
    h.timelock.encryptedBindingKey,
    Buffer.concat([
      Buffer.from("QRE-V8-BINDING-KEY"),
      u64(h.timelock.lockedUntil),
    ]),
  );
  wrap = sha(master, "KEYFILE_MIX", sha(bk));
}
const magic = open(
  wrap,
  h.validationNonce,
  h.validationTag,
  Buffer.alloc(0),
).toString();
if (magic !== "QRE_VALID") throw new Error("key check failed");
const fileKey = open(wrap, h.keyWrapNonce, h.encryptedFileKey, digest);
const metaPlain = open(fileKey, h.metaNonce, h.encryptedMeta, digest);
buf = metaPlain;
pos = 0;
const name = readBytes().toString();
const hash = readBytes();

// --- chunks
let at = 8 + headerLen;
let index = 0;
const out = [];
while (at < file.length) {
  const len = file.readUInt32LE(at);
  at += 4;
  const ct = file.subarray(at, at + len);
  at += len;
  const nonce = Buffer.from(h.baseNonce);
  const idx = u64(index);
  for (let i = 0; i < 8; i++) nonce[4 + i] ^= idx[i];
  const comp = open(
    fileKey,
    nonce,
    ct,
    Buffer.concat([Buffer.from("QRE-V8-CHUNK"), digest, idx]),
  );
  out.push(zlib.zstdDecompressSync(comp));
  index++;
}
const plain = Buffer.concat(out);
const hashOk = sha(plain).equals(hash);

console.log(
  JSON.stringify(
    {
      file: process.argv[2].split(/[\\/]/).pop(),
      size: file.length,
      vaultId: h.vaultId,
      name,
      plaintext: plain.toString(),
      hashMatches: hashOk,
      chunks: index,
      headerLen,
      timelock: h.timelock && { lockedUntil: h.timelock.lockedUntil },
    },
    null,
    1,
  ),
);
if (!hashOk) process.exit(1);
```
