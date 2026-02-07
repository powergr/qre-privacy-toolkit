export const HELP_MARKDOWN = `
# QRE Privacy Toolkit User Manual

## Version 2.5.9

QRE Privacy Toolkit is a **Local-First**, **Zero-Knowledge** security suite. This means your data never leaves your device, we have no servers, and we cannot recover your password if you lose it. You are in complete control.

---

## 📖 Table of Contents

- [🔐 File Encryption](#file-encryption)
- [🔑 Password Vault](#password-vault)
- [📝 Secure Notes](#secure-notes)
- [🔖 Private Bookmarks](#private-bookmarks)
- [📋 Secure Clipboard](#secure-clipboard)
- [🧹 Metadata Cleaner](#metadata-cleaner)
- [🛡️ Privacy Check](#privacy-check)
- [🔳 Secure QR Generator](#secure-qr-generator)
- [🗑️ Secure Shredder](#secure-shredder)
- [💾 Backup & Recovery](#backup-recovery)
- [⚙️ Advanced Settings](#advanced-settings)
- [🆘 Troubleshooting](#troubleshooting)

---

## 🔐 File Encryption

The core engine of QRE. Encrypt files of any size using military-grade **AES-256-GCM**.

### How to Lock

1. Navigate to the **Files** tab.

2. **Drag & Drop** files or folders into the window.

3. Click the green **Lock** button.

4. New .qre encrypted files are created next to the originals.

### How to Unlock

1. Drag a .qre file into the app.

2. Click the red **Unlock** button.

---

## 🔑 Password Vault

A secure, offline database for your logins.

**Features:**

**Search:** Quickly filter your logins by name or username.

**Organize:** Use **Color Labels** and **Pin** your most used logins to the top.

**Launch:** Store Website URLs and launch them directly.

**Generate:** Create strong, complex passwords instantly.

---

## 📝 Secure Notes

A safe place for sensitive text (Recovery Seeds, PINs, Diaries). Data is encrypted on disk and only decrypted in memory when you view it.

**Features:**

**Pinning:** Keep important notes at the top of the grid.

**Search:** Instantly filter through your notes.

**Copy:** Quick-copy button for easy access to content.

---

## 🔖 Private Bookmarks

Store sensitive links (Banks, Medical Portals, Dark Web links) securely.

**Privacy:** Unlike browser bookmarks, these are encrypted on disk and never synced to the cloud.

**Import:** Import existing bookmarks directly from Chrome or Edge.

**Organize:** Use **Color Labels** and **Pins** to categorize your links.

---

## 📋 Secure Clipboard

Stop apps from reading your clipboard history.

**How it works:**

1. **Copy** sensitive text from another app.

2. Click **"Secure Paste"** in QRE Toolkit.

3. The app encrypts the text into your vault and **wipes** the system clipboard immediately.

**New Features:**

**Auto-Clear:** Set a retention timer (e.g., 1 Hour, 24 Hours) to automatically delete old entries.

**Masking:** Sensitive data (Credit Cards, API Keys, Passwords) is visually masked by default.

**Search:** Find historical clips instantly.

---

## 🧹 Metadata Cleaner

Remove hidden data (Exif) from photos and documents before sharing them.

**Analyze:** View a detailed report of hidden data (GPS, Device Info, Dates) before cleaning.

**Scrubbing Options:** Selectively remove **GPS**, **Device Info**, or **Timestamps**.

**Supports:** JPG, PNG, PDF, DOCX, XLSX, PPTX, ZIP.

---

## 🛡️ Privacy Check

A comprehensive tool to verify your digital exposure.

**Tab 1: Identity Breach**
Check if your password has appeared in known data leaks (850M+ records) using k-Anonymity. Your password is never sent to any server.

**Tab 2: Network Security**
Check your **Public IP** address visibility.

- Detects if your connection is exposed to your ISP.

- Verifies if you are protected by a VPN or **Cloudflare Warp**.

---

## 🔳 Secure QR Generator

Share text, Wi-Fi credentials, or Crypto addresses with a phone offline.

**Wi-Fi Mode:** Easily create connection codes for your home network.

**Customize:** Change the **Foreground** and **Background** colors to match your preference.

**Export:** Save the code as **SVG** (Vector) or **PNG** (Image).

---

## 🗑️ Secure Shredder

**Desktop:** Overwrites files 3 times (DoD Standard) before deletion to prevent recovery.

**Android:** Performs a standard delete (Flash memory cannot be securely shredded this way).

---

## 💾 Backup & Recovery

**Your data lives on your device.**

1. Go to **Options -> Backup Keychain**.

2. Save the QRE_Backup.json file to a secure USB drive.

3. **Restore:** Copy this file back to your app data folder to restore access on a new computer.

**Forgot Password?** Use the **Recovery Code** saved during setup.

---

## ⚙️ Advanced Settings

### 🖱️ Paranoid Mode

Don't trust the computer's random number generator? Toggle this on.
The app will ask you to move your mouse (or touch the screen) to generate "Human Entropy." This physical chaos is used to seed the encryption keys.

### 🚨 Panic Button (Desktop)

Press **Ctrl + Shift + Q** at any time to instantly kill the app and wipe keys from memory. This works even if the app is minimized.

1. Go to **Options -> Backup Keychain**.
2. Save the QRE_Backup.json file to a secure USB drive.
3. **Restore:** Copy this file back to your app data folder to restore access on a new computer. The path to the data folder is:
   C:\Users\yourusername\AppData\Roaming\com.qre.locker

### ⏱️ Auto-Lock

If you are inactive for 15 minutes, the app will warn you and then automatically log out to protect your data.

---

## 🆘 Troubleshooting

**I forgot my Master Password.**
Use the **Recovery Code** (e.g., QRE-XXXX...) you saved during setup.

1. Click "Forgot Password?" on the login screen.
2. Enter the code.
3. Set a new password.
   _If you lost your password AND your recovery code, your data is lost forever._

**"Integrity Error"**
The file has been corrupted or modified by another program. QRE Toolkit refuses to decrypt it to prevent executing malicious code.
`;
