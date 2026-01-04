# QRE Locker (v2.0)

**A Stateless, Quantum-Resistant File Encryption Tool.**

QRE Locker is a modern desktop application designed to secure files against both current threats and future quantum computing attacks. It combines the speed of **AES-256-GCM** with the post-quantum security of **ML-KEM-1024 (Kyber)**.

![Screenshot](qrev2.jpg)

## 🛡️ Architecture & Security

Unlike traditional tools that rely solely on passwords, QRE Locker uses a **Hybrid Cryptographic Scheme**:

1. **Ephemeral Keys:** Every time you lock a file, a fresh, random Kyber-1024 Keypair and AES-256 Session Key are generated.
2. **Hybrid Encryption:** The file content is encrypted with AES-256. The Session Key is encapsulated using Kyber (Post-Quantum) and stored in the header.
3. **Key Wrapping:** The Kyber Private Key is encrypted using your **Passphrase** (derived via **Argon2id**) and an optional **Keyfile**.
4. **Metadata Protection:** The original filename is encrypted inside the payload. The output file (`.qre`) can be renamed safely without losing the original context.

### The Stack

- **Frontend:** React (TypeScript) + Vite
- **Backend:** Rust
- **Framework:** Tauri v2
- **Crypto Libraries:** `pqcrypto-kyber`, `aes-gcm`, `argon2`, `sha2`

## 🚀 Features

- **Stateless:** No database or "Vault" folder to manage. Everything needed to decrypt is inside the `.qre` file (protected by your password).
- **Keyfile Support:** Use any file (image, song, random bytes) as a second factor authentication.
- **Paranoid Mode:** Optionally inject entropy from the OS RNG mixed with browser crypto buffers for key generation.
- **Smart Renaming:** Automatically handles file collisions upon decryption (e.g., `file (1).txt`).
- **Cross-Platform:** Runs on Windows, macOS, and Linux.

## 📦 Installation

Go to the [Releases](https://github.com/powergr/quantum-locker/releases) page and download the installer for your OS:

- Windows: `.msi` or `.exe`
- macOS: `.dmg`
- Linux: `.AppImage` or `.deb`

## QRE v2.1 Update

This update introduces major performance, security, and usability improvements.

### ⚡ Performance & Core

**Compression:** Files are now compressed using **Zstd** before encryption, resulting in smaller `.qre` files.
**Batch Processing:** You can now select and process multiple files at once.
**Safety:** Added a file size limit (500MB) to prevent memory issues.
**Smart Overwrite:** Decrypting a file no longer overwrites existing files; it creates `file (1).txt` instead.

### 🛡️ Security

**Memory Wiping:** Implemented `Zeroize` to securely clear keys from RAM immediately after use.
**Integrity Check:** Added a validation token to the header. The app now instantly tells you if your password is wrong, rather than trying (and failing) to decrypt the whole file.

### 🎨 User Interface

**Modern Design:** Complete overhaul with a dark, cyberpunk-inspired theme.
**File List:** View exactly which files are selected before processing.
**Help & Guide:** Built-in documentation explaining how to use Keyfiles and Paranoid mode.

## 📖 Usage Guide

### Locking a File

1. Click **Select File** and choose the document you want to secure.
2. Enter a strong **Passphrase**.
3. (Optional) Click **🔑 Keyfile** to select a secret image/file to use as a key.
4. Click **Lock**.
5. A new file ending in `.qre` will be created. You can verify the original and delete it safely.

### Unlocking a File

1. Click **Select File** and choose the `.qre` file.
2. Enter the **Passphrase** used to lock it.
3. (If used) Select the same **Keyfile**.
4. Click **Unlock**.
5. The file will be restored with its original filename.

## 🛠️ Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v16+)
- [Rust](https://www.rust-lang.org/) (latest stable)
- Tauri CLI: `npm install -g @tauri-apps/cli`

### Setup

```bash
git clone https://github.com/powergr/quantum-locker.git
cd qre-gui
npm install
```

### Run in Development Mode

```bash
npm run tauri dev
```

### Build for Production

```bash
npm run tauri build
```

The executable will be located in `src-tauri/target/release/bundle/`.

## 📄 License

MIT License. See [LICENSE](LICENSE) file.
