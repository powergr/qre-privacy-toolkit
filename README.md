# QRE Privacy Toolkit

**The Local-First Swiss Army Knife for Digital Privacy.**

[![Release](https://github.com/powergr/qre-privacy-toolkit/actions/workflows/build.yml/badge.svg)](https://github.com/powergr/qre-privacy-toolkit/actions/workflows/build.yml)
![Version](https://img.shields.io/github/v/release/powergr/qre-privacy-toolkit)
![License](https://img.shields.io/github/license/powergr/qre-privacy-toolkit)
![Downloads](https://img.shields.io/github/downloads/powergr/qre-privacy-toolkit/total)
![Stars](https://img.shields.io/github/stars/powergr/qre-privacy-toolkit?style=social)

![Rust](https://img.shields.io/badge/Rust-1.97-000000?logo=rust&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19.1-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)

![Last Commit](https://img.shields.io/github/last-commit/powergr/qre-privacy-toolkit)

QRE Privacy Toolkit is a secure, cross-platform application designed to handle your sensitive data without relying on the cloud. It runs natively on **Windows, macOS, Linux, and Android**.

**[📥 Download the Latest Release](https://github.com/powergr/qre-privacy-toolkit/releases)**

[![Sponsor powergr](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github-sponsors&logoColor=white&style=flat)](https://github.com/sponsors/powergr)

---

![QRE Privacy Toolkit](qrev2.jpg)

---

## 🛠️ The 12-Tool Suite (v2.8.3)

QRE Privacy Toolkit combines 12 essential privacy tools into one mathematically secure, memory-safe application:

### **1. 🔐 File Encryption**

Secure any file—photos, tax documents, 50GB video backups—using military-grade **AES-256-GCM**.

- **Unlimited Size:** Powered by a custom **Rust Streaming Engine**, you can encrypt files of any size without exhausting your RAM.
- **Smart Compression:** Automatically compresses documents while skipping already-compressed media files to save CPU cycles.
- **Cross-Platform:** Lock a file on your PC, unlock it on your Android phone.
- **Time-lock Feature:** Time-Lock Encryption function implemented. Checking the correct time with NTP and ratchet time check.

### **2. 🔑 Password Vault & Offline 2FA**

A secure, offline, zero-knowledge database for your logins.

- **Offline Authenticator (TOTP):** Generate live 6-digit 2FA codes directly inside your vault. No need for cloud-synced authenticator apps on your phone.
- **Generators:** Built-in strong password generator and local strength meter.

### **3. 📝 Secure Notes**

An encrypted notepad for sensitive text that isn't just a password. Store recovery seeds, Wi-Fi codes, or private journals safely at rest.

### **4. 🔖 Private Bookmarks**

Save your sensitive links (Bank logins, Medical portals, Crypto exchanges) in an encrypted vault, completely hidden from browser syncing and forensic tools.

### **5. 📋 Secure Clipboard**

Grabs text from your clipboard, encrypts it into a secure history, and **wipes** the OS clipboard immediately. Auto-clears entries after a customizable TTL.

### **6. 🧹 Metadata Cleaner & Steganography Scan**

A dual-purpose media privacy suite:

- **Meta Cleaner:** Scrub hidden GPS coordinates, camera/device models, and author data from Images (JPG/PNG/WebP/TIFF), PDFs, Office Docs, ZIP archives, Audio (MP3/FLAC/OGG), Video (MP4/MOV), and RAW camera formats (CR2/NEF/ARW/DNG, analysis-only — cleaning is disabled to protect irreplaceable originals). Embedded images (cover art, pasted photos) are scrubbed recursively too, not just the outer file.
- **Steganography Detector:** Two complementary checks on an image's decoded pixel data — a direct plaintext-recovery pass that tries to read a hidden message straight out of each color channel's Least Significant Bits, and a statistical pass that flags a channel/region whose LSB entropy is an outlier relative to the rest of that image, for encrypted or compressed payloads that don't look like readable text.

### **7. 🕵️‍♂️ Local Secret Scanner & Breach Check**

Detect data leaks before they happen, and check if you've already been compromised.

- **Local Scanner:** Rapidly scans unencrypted `.txt`, `.csv`, and `.env` files on your hard drive to find exposed API keys, plaintext passwords, and crypto seed phrases.
- **HIBP API:** Checks if your password has appeared in known data leaks using **k-Anonymity**. We send only the first 5 characters of the hash to the internet.

### **8. ✅ Integrity Checker**

Verify that files you download (like crypto wallets, Linux ISOs, or installers) haven't been tampered with by hackers. Calculates SHA-256, SHA-1, and MD5 simultaneously.

### **9. 🗑️ Secure Shredder (Desktop)**

When you delete a file normally, the data remains on your disk. The Shredder physically overwrites your files with random noise (up to DoD Standard 3-Pass) before deleting them. Includes free-space wiping for HDDs and TRIM commands for SSDs.

### **10. 🔳 Secure QR Generator**

Share sensitive data (Wi-Fi passwords, Crypto addresses) with mobile devices completely offline. Data stays air-gapped on your screen.

### **11. 🧹 System & Registry Clean (Desktop)**

Remove temporary files, browser caches (Chrome, Edge, Brave), Windows Temp, and developer build artifacts (npm, cargo) to free up space. Safely scans and removes orphaned Windows Registry keys.

### **12. 🔎 File Analyzer**

Detects malicious files hiding behind fake extensions (e.g., `salary.pdf.exe`). Analyzes file headers (Magic Numbers) to determine the 'true' file type, ignoring the extension.

---

## 🛡️ Security Architecture

- **Memory Zeroization:** Cryptographic keys and plaintext payloads are actively scrubbed from your system's RAM (`0x00`) the exact moment they are no longer needed, defeating cold-boot attacks and RAM-scrapers.
- **Key Derivation:** Argon2id (Resistant to GPU brute-force attacks).
- **Hybrid Paranoid Mode:** Mitigates theoretical hardware RNG backdoors by XOR-mixing your physical mouse/touch timing jitter directly into the OS's cryptographic seed.
- **Panic Button:** `Ctrl+Shift+Q` instantly kills the app and wipes memory (Desktop).
- **Auto-Lock:** Sessions timeout automatically after inactivity.

---

## 💾 Portable USB Vaults

Transform any standard USB flash drive into a highly secure, cross-platform encrypted vault—no hardware encryption chips required.

- **True Portability:** Initialize a USB drive on your PC, unplug it, and securely unlock your files on any Windows, macOS, or Linux machine running QRE.
- **Multi-Vault Architecture:** QRE’s Rust backend functions as a dynamic Key Manager, securely holding multiple active `MasterKeys` in isolated memory environments simultaneously.
- **Ghost-File Protection (NAND Defense):** Because flash memory hardware uses wear-leveling algorithms that leave deleted plaintext data forensically recoverable, QRE enforces a safe "Encrypt locally, copy securely" workflow, warning you before you encrypt directly on a USB.
- **Sudden Ejection Watcher:** If a malicious actor (or clumsy user) physically yanks the unlocked USB drive out of the machine, a dedicated Rust background thread instantly detects the hardware removal and zeroes the Master Key from RAM.
- **Evil-Maid Verification:** During initialization, a unique Vault UUID is generated. Every time you unlock the drive on a new computer, the UUID is displayed, allowing you to verify out-of-band that an attacker hasn't stealthily swapped your USB's keychain file.

---

## New in v2.8.3

- **Security:** Fixed a symlink-following bug in the Shredder. Deleting a folder containing a symlink or junction could overwrite files outside it. Symlinks are now unlinked in place, never followed.
- **Security:** Closed a command-injection risk in the free-space-wipe and TRIM tools. The drive letter wasn't strictly validated before use. It's now checked before it ever reaches the shell.
- **Fixed:** encrypted-file saves now explicitly flush to disk. Before, a late write error like disk-full could go unnoticed. A save could report success even on a truncated file.
- **Fixed:** copying some non-English or emoji text into the Secure Clipboard could crash that save. Long previews are now always cut on a safe character boundary.
- **Fixed:** a UI bug could silently ignore a setting you just changed. This affected Paranoid Mode, compression, and keyfile choices. Toggling one right before Lock/Unlock now always applies it.
- **Fixed:** a race condition in the Vault, Notes, Bookmarks, and Clipboard views. Editing two entries in quick succession could silently discard one change.
- **Fixed:** native window theme syncing was dead code. It never ran on any platform. The OS window frame now correctly follows the app's theme.
- **Fixed:** shredding or wiping 1 TB or more could show a broken byte count. This showed up in progress and result screens.
- **Fixed:** several smaller issues: a keychain-init race, duplicate wordlist entries, and missing keyboard-shortcut guards.
- **Maintenance:** routine npm and Cargo dependency updates. Also bumped `rand`, `sha2`/`sha1`/`md-5`, and `zip` to remove 5 duplicate crates from the dependency tree. See the dependency audit notes below for details.

Also see: Time-Lock Encryption, added in v2.7.6. Read more in the [Time-lock blog post](https://powergr.github.io/privacy_toolkit/blog-timelock-encryption.html).

---

## 🔮 What's Next

A larger Rust dependency upgrade is intentionally being held back. It needs a dedicated, careful pass, since it touches the `.qre` file format directly:

- **`bincode`** (1.x → 3.x): serializes the `.qre` container format itself. It needs verified round-trip compatibility with files already encrypted by earlier versions before upgrading.

### Dependency audit notes (2026-09-12)

`Cargo.lock` now resolves 702 packages, 619 of them distinct crate names. 53 crate names still appear more than once in the tree. Most of those are the same version built twice under different feature sets. That's a normal effect of Cargo's per-target feature resolver, not a real version conflict.

- **Completed this pass: 3 of 5 targeted duplicates removed.** `qre-gui`'s own `rand`/`rand_chacha`, `md-5`, and `zip` pins were bumped. They now match what `lopdf` and `tauri-plugin-updater` already pulled in. That removed 5 duplicate packages from the tree, 707 down to 702. All tests still pass. No code changes were needed for `zip`'s 2.x-to-4.x jump. Only a few digest hex-formatting call sites needed fixing for `sha2`/`sha1`/`md-5` 0.11's new output type.
- **`sha1` and `sha2` stay duplicated, but not for a reason we control.** The original audit missed something. Bumping our own pin to 0.11 just moved us into a different camp. It didn't shrink the camp count. `zip` 4.6.1 itself still depends on `sha1` 0.10 internally. Tauri's own build-time `tauri-codegen` crate still depends on `sha2` 0.10. Neither depends on what `qre-gui` pins. Fixing these two would need zip's or Tauri's own maintainers to upgrade. It's not something we can change from our side.
- **Not prunable, unavoidable ecosystem skew.** Most remaining duplicates (`windows`/`windows-core`, `reqwest`, `toml`, `indexmap`, `hashbrown`, `syn`, `thiserror`, `getrandom`, `winnow`, etc.) come from transitive major-version conflicts between Tauri's own plugins and their sub-dependencies (e.g. `winreg` wanting an older `windows` than `tao`/`muda`/`arboard`). Cargo already collapses everything semver allows here; what's left can't be removed without upstream crates converging.
- **Checked for redundant direct dependencies, none found.** `id3` + `lofty` + `ape` look like three overlapping audio-tag libraries. Each actually covers a gap the others don't handle correctly (see the APEv2 header/footer and ID3v1/APEv2 ordering fixes in past release notes). Removing any one breaks real, tested behavior in `cleaner/media/mp3.rs`. Likewise, `reqwest` and `tauri-plugin-http` look redundant by name. They actually serve different halves of the app. `reqwest` is the direct backend HTTP client in `breach.rs`, for HIBP and IP checks. `tauri-plugin-http` is the frontend CORS-bypass fetch, used by the Android update checker. Every one of the 702 resolved packages traces back to a real cause. It's either a direct dependency the codebase actually uses, or a transitive requirement of Tauri and its official plugins. None are dead weight pulled in by mistake.
- Android build warnings about unused functions (`wipe_free_space`, `trim_drive`, etc.) are false alarms. Those are `#[cfg(not(target_os = "android"))]`-gated desktop-only code, correctly unreachable when cross-compiling for Android.

---

## 🚀 Getting Started & Building

```bash
# 1. Install Dependencies
npm install

# 2. Run in Dev Mode
npm run tauri dev

# 3. Build for Release
npm run tauri build
```

## ⚠️ Important Security Notice

QRE Privacy Toolkit follows a strict **Zero-Knowledge** architecture. If you lose your **Master Password** AND your **Recovery Code**, your data is mathematically inaccessible. There is no "Password Reset" button because there is no server. **Backup your `keychain.json` file safely.**

---

## ✅ Test Coverage

QRE Privacy Toolkit maintains rigorous, automated cryptographic and UI testing to guarantee safety across updates.

**Rust Backend (`cargo test`):**

- 378 tests passed from 378 total. Covers memory wiping, file routing, steganography detection, and Zip-Bomb prevention. Also covers AES-GCM streaming integrity and metadata-cleaner round-trips across every supported file format. Includes concurrency and injection regression tests for the Shredder and keychain.

**Frontend (`npm test`):**

- 216 tests passed from 216 total (Jest suite covering UI state, ReDoS-safe regex heuristic parsing, and password strength algorithm boundaries).

---

**License:** MIT | **Copyright:** © 2026 Project QRE Privacy Toolkit

---
