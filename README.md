# QRE Privacy Toolkit

**The Local-First Swiss Army Knife for Digital Privacy.**

[![Release](https://github.com/powergr/qre-privacy-toolkit/actions/workflows/build.yml/badge.svg)](https://github.com/powergr/qre-privacy-toolkit/actions/workflows/build.yml)
![Version](https://img.shields.io/github/v/release/powergr/qre-privacy-toolkit)
![License](https://img.shields.io/github/license/powergr/qre-privacy-toolkit)
![Downloads](https://img.shields.io/github/downloads/powergr/qre-privacy-toolkit/total)
![Stars](https://img.shields.io/github/stars/powergr/qre-privacy-toolkit?style=social)

![Rust](https://img.shields.io/badge/Rust-1.99-000000?logo=rust&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19.3-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)

![Last Commit](https://img.shields.io/github/last-commit/powergr/qre-privacy-toolkit)

QRE Privacy Toolkit is a secure, cross-platform application designed to handle your sensitive data without relying on the cloud. It runs natively on **Windows, macOS, Linux, and Android**.

**[📥 Download the Latest Release](https://github.com/powergr/qre-privacy-toolkit/releases)**

[![Sponsor powergr](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github-sponsors&logoColor=white&style=flat)](https://github.com/sponsors/powergr)

---

![QRE Privacy Toolkit](qrev2.jpg)

---

## 🛠️ The 12-Tool Suite (v2.8.4)

QRE Privacy Toolkit combines 12 essential privacy tools into one mathematically secure, memory-safe application:

### **1. 🔐 File Encryption**

Secure any file, such as photos, tax documents or 50GB video backups, using military-grade **AES-256-GCM**.

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

- **Meta Cleaner:** Scrub hidden GPS coordinates, camera/device models, and author data from Images (JPG/PNG/WebP/TIFF), PDFs, Office Docs, ZIP archives, Audio (MP3/FLAC/OGG), Video (MP4/MOV), and RAW camera formats. RAW formats (CR2/NEF/ARW/DNG) are analysis-only: cleaning is disabled to protect irreplaceable originals. Embedded images (cover art, pasted photos) are scrubbed recursively too, not just the outer file.
- **Steganography Detector:** Two complementary checks run on an image's decoded pixel data. A direct plaintext-recovery pass tries to read a hidden message straight out of each color channel's Least Significant Bits. A statistical pass flags a channel or region whose LSB entropy is an outlier relative to the rest of the image. This catches encrypted or compressed payloads that don't look like readable text.

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

Transform any standard USB flash drive into a highly secure, cross-platform encrypted vault. No hardware encryption chips required.

- **True Portability:** Initialize a USB drive on your PC, unplug it, and securely unlock your files on any Windows, macOS, or Linux machine running QRE.
- **Multi-Vault Architecture:** QRE’s Rust backend functions as a dynamic Key Manager, securely holding multiple active `MasterKeys` in isolated memory environments simultaneously.
- **Ghost-File Protection (NAND Defense):** Because flash memory hardware uses wear-leveling algorithms that leave deleted plaintext data forensically recoverable, QRE enforces a safe "Encrypt locally, copy securely" workflow, warning you before you encrypt directly on a USB.
- **Sudden Ejection Watcher:** If a malicious actor (or clumsy user) physically yanks the unlocked USB drive out of the machine, a dedicated Rust background thread instantly detects the hardware removal and zeroes the Master Key from RAM.
- **Evil-Maid Verification:** During initialization, a unique Vault UUID is generated. Every time you unlock the drive on a new computer, the UUID is displayed, allowing you to verify out-of-band that an attacker hasn't stealthily swapped your USB's keychain file.

---

## New in v2.8.4

- **Security:** A 2FA secret key could end up in the application log. It no longer does.
- **Security:** The recovery code of a new USB vault is now wiped from the clipboard 30 seconds after you copy it. The sign-in screen already did this.
- **Security:** Leaving a screen no longer cancels the 30 second clipboard wipe of a copied password, note or code.
- **Security:** When your session ends, open dialogs close and any typed USB vault password is discarded. Before, a stale dialog could be waiting after you signed in again.
- **Fixed:** Cancel now really cancels. In the Shredder, the free-space wipe, the Metadata Cleaner and the System Cleaner, the screen used to return to normal while files were still being changed. You could start a second run on the same files. These screens now show "Cancelling…" until the work has stopped. A cancelled scan, hash or clean also no longer affects the next one.
- **Fixed:** Pasting a folder into itself in the Files screen is now refused with a clear message.
- **Fixed:** Password Vault: exported 2FA keys used to come back as note text when re-imported. Import now finds columns by name, so files from other password managers work too. Pressing Save twice no longer stores an entry twice.
- **Fixed:** Secure Notes: Replace could paste the whole note into itself, and Find skipped the first match. The heading and list buttons now put their marker at the start of the line. A code block without a closing fence now shows in the preview. A slow auto-save could store a new note twice.
- **Fixed:** The Time-Lock dialog used UTC for its earliest and latest dates, so the limits were off by your time zone. A one hour lock no longer reads "60 minutes".
- **Fixed:** The update dialog said "installed" before the install had finished, and it hid a failed restart.
- **Fixed:** Paranoid Mode could start encryption twice, or after you cancelled the mouse-movement step. It also asked for movement when no file was selected.
- **Fixed:** Files screen: time-lock badges from a folder you had left could appear in the new one. A message about a time-locked file was lost when another file failed. Shortcuts such as Backspace no longer act behind an open dialog. Cancelling in the address bar no longer opens the typed path.
- **Fixed:** Several screens could show results for something you had already left, such as a slow folder listing, QR code, scan or metadata report. The newest request now always wins.
- **Fixed:** A failed delete or pin was silent in some screens, and a CSV import could claim success when the save had failed. Both now report the problem.
- **Fixed:** The exported report of the Integrity Checker now matches the results shown on screen.
- **Fixed:** System Cleaner: "Confirm & Clean" in the preview could be clicked a second time while cleaning. It also now opens on a category that has items.
- **Fixed:** The Escape key did nothing in the Notes, Vault and Bookmarks editors. It now closes the top dialog first in every screen, so a confirmation closes before the editor behind it.
- **New:** Keyboard shortcuts in the tools. Ctrl+N adds an entry, bookmark or note, and Ctrl+F jumps to the search box. Ctrl+S saves the open editor. Ctrl+O picks files or a folder in the Integrity Checker, File Analyzer, Privacy Check, Metadata Cleaner and Shredder. In the QR Generator, Ctrl+S saves a PNG and Ctrl+Shift+S saves an SVG. Shortcuts pause while a dialog is open. The full list is in Help under Keyboard Shortcuts.
- **Changed:** Privacy Check, Integrity Checker, System Cleaner, Metadata Cleaner, Shredder, File Analyzer and the QR Generator now share one layout. The title sits at the top, tabs follow, and each start screen is centered below. Before, every page was arranged a little differently.
- **Fixed:** Linux: Privacy Check refused any folder with a system name inside its path, such as `~/dev` or `~/variables`. It now blocks only real system folders. The free-space wipe also judged RAM drives by loose text matching. It now picks the mount that really holds the folder. The bookmark import now finds Brave and Edge as well as Chrome and Chromium.
- **Fixed:** macOS: files in the temporary folder were refused as system files by the Shredder and by file locking, because a Mac keeps that folder under `/var`. Only your own temporary folder is now allowed. The protected-folder check for locking also compared loose text, so a folder such as `/variables` counted as system, and the macOS system folders were not covered. Both are fixed.
- **Fixed:** Android: the File Analyzer smart scan listed every file twice, because `/sdcard` and `/storage/emulated/0` are the same storage. Each real folder is now scanned once.
- **Maintenance:** The Tauri plugins now match the Tauri version, which fixes the release build. Updated `zip`, `zstd`, `lopdf`, Vite and other npm and Cargo packages, and cleared the Android build warnings.
- **Testing:** The project now has 504 Rust tests and over 1,600 frontend tests, and every screen and dialog is covered. Each push to GitHub runs a fast subset on Windows, Linux and macOS, and a full run happens weekly.

Also see: Time-Lock Encryption, added in v2.7.6. Read more in the [Time-lock blog post](https://powergr.github.io/privacy_toolkit/blog-timelock-encryption.html).

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

- 504 tests passed from 504 total. Covers memory wiping, file routing, steganography detection, and Zip-Bomb prevention. Also covers AES-GCM streaming integrity and metadata-cleaner round-trips across every supported file format. Includes concurrency and injection regression tests for the Shredder and keychain. The command layer now has tests for login lockout, session wiping, vault file encryption, clipboard expiry, TOTP codes, paste, and time-lock checks. Cancelling a scan, hash, or clean is tested too, including starting a new run right after a cancel. The Linux, macOS and Android paths are tested as well: protected folders, RAM-backed drives, TRIM results, browser bookmark locations, and the Android storage folders.

**Automated checks (GitHub Actions):** every push and pull request runs the type-check, the whole frontend suite (about ten seconds) and the Rust tests except two slow file-system scans. The Rust tests run on Windows, Linux and macOS. Android logic is tested through plain functions on those machines, and its screens by the frontend tests. A full run of everything happens weekly and can be started by hand from the Actions tab.

**Frontend (`npm test`):**

- 1608 tests passed from 1608 total (Jest suite covering UI state, ReDoS-safe regex heuristic parsing, and password strength algorithm boundaries). Tests run in a fixed US Eastern time zone, so date handling is checked the same way on every machine. Also covers the login, setup, and recovery flows, file browsing, key file handling, and portable USB vaults. Nearly every screen is tested end to end, including the Vault, Notes, Bookmarks, Clipboard, Integrity Checker, QR, Privacy Check, and File Analyzer, with their failed-save and cancelled-scan cases. The dialogs are tested too, including the password health check, time-lock picker, update flows, and the entropy collector. The Files screen is covered as well, including locking and unlocking, USB drive warnings, drag and drop, cut, copy and paste, deleting, keyboard shortcuts, time-lock badges, and the right-click menu. The main app shell is tested too: sign-in screens, tab switching, keychain backup, password changes, USB vault dialogs, and what happens to open dialogs when a session ends. The sign-in screen and the password field (show or hide, passphrase generator, strength meter) are tested as well. The Notes editor is covered in depth: sorting, the markdown preview, the formatting buttons, find and replace, tags, auto-save, and import and export. The password vault is covered the same way, including live 2FA codes, the editor, and CSV import and export. The shredder is tested too, including cancelling, progress, the free-space wipe and TRIM cards, and their safeguards. The metadata cleaner and steganography scanner are covered as well, including cancelling, comparisons and scan results. The system and registry cleaner is tested as well, including its size limits, backup requirement, cancelling and administrator relaunch. The Escape key (topmost dialog closes first), every keyboard shortcut, and the shared tool page layout are covered too.

---

**License:** MIT | **Copyright:** © 2026 Project QRE Privacy Toolkit

---
