# QRE Locker User Manual

## Version 2.3.3

## 📖 Table of Contents

- [🚀 Quick Start](#quick-start)
- [💾 Backup & Restore](#backup-restore)
- [🚨 Panic Button](#panic-button)
- [⚙️ Advanced Features](#advanced-features)
- [🆘 Troubleshooting](#troubleshooting)
- [⌨️ Shortcuts & Tricks](#shortcuts-tricks)

---

## 🚀 Quick Start

QRE Locker secures your files using a hybrid of **AES-256** (standard encryption) and **Kyber-1024** (post-quantum encryption).

### 1. Locking Files

1. **Drag & Drop** files or folders into the application window.
2. Click the green **Lock** button.
3. Your original files remain untouched (unless you delete them). New `.qre` files are created next to them.

### 2. Unlocking Files

1. Select the `.qre` files you wish to restore.
2. Click the red **Unlock** button.
3. The files will be decrypted and restored to their original folder.

---

## 💾 Backup & Restore

Your **Master Password** unlocks a digital keychain stored on your computer. If your hard drive fails or this file is corrupted, you lose access to **ALL** your files.

### How to Backup

1. Go to **Options > Backup Keychain**.
2. Save the `QRE_Backup.json` file to a safe location (USB Drive, Cloud, etc.).
3. **Note:** This backup is encrypted. You still need your Master Password to use it.

### How to Restore

If you reinstall your OS or move to a new computer:

1. Install QRE Locker.
2. Close the application.
3. Locate the Configuration Folder:
   - **Windows:** `%APPDATA%\qre\locker\config\`
   - **Linux:** `~/.config/qre/locker/`
   - **macOS:** `~/Library/Application Support/com.qre.locker/`
4. Copy your `QRE_Backup.json` into this folder.
5. Rename it to `keychain.json` (replacing any existing file).
6. Open QRE Locker and log in with your original password.

---

## 🚨 Panic Button

In an emergency, you can instantly secure the application.

**Shortcut:** `Ctrl + Shift + Q` (Windows/Linux) or `Cmd + Shift + Q` (macOS).
**Action:** Immediately wipes encryption keys from RAM and terminates the process.
**Result:** The app closes instantly. No data is saved/corrupted, but any active encryption job will stop.

---

## ⚙️ Advanced Features

### Keyfiles (Two-Factor Authentication)

A Keyfile acts like a physical key.

1. Go to **Advanced > Select Keyfile**.
2. Choose _any_ file (an image, an MP3, a random document).
3. **Important:** You must select this **exact same file** to unlock your data later. If you lose or modify the Keyfile, your data is lost forever.

### Zip Compression

Located in **Advanced > Zip Options**:

- **Fast:** Minimal compression, fastest speed. Good for videos/images.
- **Normal:** Default balance.
- **Best:** Maximum compression (Zstd level 15). Slower, but saves space.

### Themes

Go to **Options > Theme** to switch between **Dark**, **Light**, or **System** modes.

---

## 🆘 Troubleshooting

**I forgot my Master Password.**
Use the **Recovery Code** (e.g., `QRE-XXXX...`) shown during setup.

1. Click "Forgot Password?" on the login screen.
2. Enter the code.
3. Create a new password.

## "Access Denied" Errors

- Ensure you have permission to write to the folder.
- QRE Locker cannot lock system files currently in use by Windows.

**"Validation Tag Mismatch"**
This means the password or Keyfile is incorrect, or the file is corrupted.

---

## ⌨️ Shortcuts & Tricks

**Right Click** any file to:
**Lock/Unlock**
**Rename**
**Delete** (Secure Shred or Trash)
**Reveal in Explorer**
**Double Click** a folder to open it.
**Double Click** a `.qre` file in Windows Explorer to open QRE Locker automatically.
