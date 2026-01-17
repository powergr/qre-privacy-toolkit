# QRE Locker

**Secure, Local-First, Cross-Platform File Encryption.**

![Build Status](https://img.shields.io/github/actions/workflow/status/powergr/quantum-locker/build.yml?branch=main)
![Version](https://img.shields.io/github/v/release/powergr/quantum-locker)
![License](https://img.shields.io/github/license/powergr/quantum-locker)

QRE Locker is a modern file encryption tool designed for privacy. It runs natively on **Windows, macOS, Linux, and Android**, allowing you to secure your sensitive documents, photos, and videos with a single drag-and-drop action.

**[📥 Download the Latest Release](https://github.com/powergr/quantum-locker/releases)**

---

## 🔒 Key Features

### **1. Military-Grade Security**

Your data is protected using **AES-256-GCM** (Galois/Counter Mode). This provides both confidentiality (they can't read it) and integrity (they can't modify it). Passwords are hardened using **Argon2id**, the winner of the Password Hashing Competition, making GPU brute-force attacks prohibitively expensive.

### **2. Unlimited File Size**

Powered by a custom **Rust Streaming Engine**, QRE Locker processes files chunk-by-chunk. You can encrypt 10GB, 50GB, or even 1TB files without using up your RAM, even on mobile devices.

### **3. Smart Compression**

The app uses **Zstd** compression to save space.
**Auto-Detect:** Automatically applies fast compression to media files (images/video) and high compression to documents/text.
**Extreme Mode:** Forces maximum compression levels for archival storage.

### **4. Cross-Platform & Mobile Ready**

The exact same encryption engine runs on your Desktop and your **Android Phone**.
**Desktop:** Drag & Drop files or folders.
**Android:** Fully native app. Encrypt photos directly from your Gallery or transfer secured files from your PC to your phone.

### **5. Zero Knowledge**

**No Cloud:** Files never leave your device.
**No Accounts:** No email signup, no tracking.
**No Backdoors:** We cannot recover your password. Only you hold the keys.

---

## 🛡️ Operational Security

QRE Locker includes features designed for high-risk scenarios and physical security:

### **🚨 Panic Button (Desktop)**

A global "Dead Man's Switch." Pressing **`Ctrl + Shift + Q`** (or `Cmd + Shift + Q` on macOS) instantly kills the application process and wipes encryption keys from RAM. This works even if the app is minimized or in the background.

### **⏱️ Auto-Lock**

To prevent unauthorized access if you step away from your device, the vault includes an inactivity watchdog.
**15 Minutes:** If no mouse/keyboard/touch activity is detected, a timer starts.
**60 Seconds:** A warning countdown appears.
**Action:** The app automatically logs out and wipes memory if you do not respond.

### **🖱️ Paranoid Mode**

Don't trust the computer's random number generator?
**Paranoid Mode** allows you to inject your own entropy by moving your mouse (Desktop) or swiping your screen (Mobile). This physical chaos is mixed into the encryption seed, ensuring your keys are truly unpredictable.

---

## 🚀 How to Use

1.**Create a Vault:** Set a strong Master Password. 2.**Save your Recovery Code:** This `QRE-XXXX` code is the _only_ way to restore access if you forget your password. 3.**Lock:** Drag files or folders into the app. They are compressed and encrypted into `.qre` files. 4.**Unlock:** Drag a `.qre` file back into the app to restore the original.

---

## 🛠️ Technical Stack

**Core:** Rust (Performance & Memory Safety)
**Frontend:** React + TypeScript + Vite
**Mobile Bridge:** Tauri v2 + Android NDK
**Cryptography:**
_Encryption:_ AES-256-GCM
_KDF:_ Argon2id (19MB memory hardness)
_RNG:_ ChaCha20 seeded via OS + User Entropy \* _Compression:_ Zstd (Zstandard)

---

## 📦 Building from Source

### Prerequisites

**Rust:** `rustup` (latest stable)
**Node.js:** v20+
**Android (Optional):** Android Studio + NDK

### Desktop Build

```bash
# 1. Install dependencies
npm install

# 2. Run in Development Mode
npm run tauri dev

# 3. Build Release Bundle
npm run tauri build
```

### Android Build

```bash
# 1. Setup Android Environment
npm run tauri android init

# 2. Build APK (Signed Debug)
npm run tauri android build -- --debug --apk true --target aarch64
```

---

## ⚠️ Important Security Notice

QRE Locker follows a **Zero-Knowledge** architecture.
If you lose your **Master Password** AND your **Recovery Code**, your data is mathematically inaccessible. There is no "Password Reset" button because there is no server.

**Backup your `keychain.json` file and store your Recovery Code safely.**

---

**License:** MIT
**Copyright:** © 2026 Project QRE
