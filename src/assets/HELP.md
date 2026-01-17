# QRE Locker User Manual

## Version 2.4.0

## 📖 Table of Contents

- [🚀 Quick Start](#quick-start)
- [💾 Backup & Restore](#backup-restore)
- [📱 Android & Mobile](#android--mobile)
- [🚨 Panic Button](#panic-button)
- [⚙️ Advanced Features](#advanced-features)
- [🆘 Troubleshooting](#troubleshooting)
- [⌨️ Shortcuts & Tricks](#shortcuts-tricks)

---

## 🚀 Quick Start

QRE Locker secures your files with industry-standard **AES-256-GCM** encryption.

### 1. Locking Files

1. **Drag & Drop** files or folders into the application window.
2. Click the green **Lock** button.
3. Your original files remain untouched (unless you choose to delete them). New `.qre` files are created next to them.

**Note:** QRE Locker uses **Streaming Encryption**, meaning there is **no file size limit**. You can encrypt 50GB+ videos without slowing down your computer.

### 2. Unlocking Files

1. Select the `.qre` files you wish to restore.
2. Click the red **Unlock** button.
3. The files will be decrypted and restored to their original folder.

---

## 💾 Backup & Restore

Your **Master Password** unlocks a digital keychain stored locally on your device. If your hard drive fails or this file is corrupted, you lose access to **ALL** your files.

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
   - **Android:** Use the "Import Keychain" feature (Coming in v2.4) or manually copy to the app data folder.
4. Copy your `QRE_Backup.json` into this folder.
5. Rename it to `keychain.json` (replacing any existing file).
6. Open QRE Locker and log in with your original password.

---

## 📱 Android & Mobile

QRE Locker works natively on Android with the same security as the desktop version.

### Permissions

On Android 11+, you must grant **"Manage All Files"** permission when prompted. This allows the app to save encrypted files back to your storage instead of trapping them inside the app.

### Limitations vs Desktop

- **Secure Shredding:** This feature is **disabled** on mobile. Overwriting data on Flash storage (used by phones) damages the chip and is unreliable due to "wear leveling." The app uses standard deletion instead.
- **Panic Button:** The global hotkey is not supported by the Android OS.

---

## 🚨 Panic Button (Desktop Only)

In an emergency, you can instantly secure the application.

**Shortcut:** `Ctrl + Shift + Q` (Windows/Linux) or `Cmd + Shift + Q` (macOS).
**Action:** Immediately wipes encryption keys from RAM and terminates the process.
**Result:** The app closes instantly. No data is saved/corrupted, but any active encryption job will stop.

---

## ⚙️ Advanced Features

### 🖱️ Paranoid Mode (Entropy Injection)

By default, computers generate random numbers using internal system clocks. While secure, some users prefer absolute certainty.

- **Action:** Toggle **Paranoid Mode** in the Advanced menu.
- **Desktop:** You must move your mouse randomly to fill the entropy bar.
- **Mobile:** You must swipe your finger across the screen.
- **Result:** The encryption keys are generated from your physical movements, ensuring no software algorithm can predict your key.

### 📂 Keyfiles (Two-Factor Authentication)

A Keyfile acts like a physical key.

1. Go to **Advanced > Select Keyfile**.
2. Choose _any_ file (an image, an MP3, a random document).
3. **Important:** You must select this **exact same file** to unlock your data later. If you lose or modify the Keyfile, your data is lost forever.

### 🗜️ Zip Compression

Located in **Advanced > Zip Options**. QRE Locker uses **Zstd** compression with a smart engine:

- **Auto (Default):** Intelligently detects the file type.
  - Media/Archives: Uses fast mode (Level 1) since they don't compress well.
  - Documents/Text: Uses balanced mode (Level 3) for better space savings.

- **Extreme:** Forces **Maximum** compression (Level 19). This is much slower but achieves the smallest possible file size. Best for databases or log files.
- **Store:** No compression (Level 0). Fastest speed. Useful for simple wrapping of already compressed data.

### 🎨 Themes

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

**"Integrity Error / Hash Mismatch"**
This means the file has been tampered with or corrupted (bit-rot). The app refuses to output potentially malicious data.

**"Validation Tag Mismatch"**
This means the password or Keyfile is incorrect.

---

## ⌨️ Shortcuts & Tricks

**Right Click** any file to:

- **Lock/Unlock**
- **Rename**
- **Delete** (Secure Shred or Trash)
- **Reveal in Explorer** (Desktop only)

**Double Click** a folder to open it.
**Double Click** a `.qre` file in Windows Explorer to open QRE Locker automatically.
