# Auto-Update System

QRE Privacy Toolkit includes a built-in auto-update system that keeps your application up-to-date with the latest features and security patches across all supported platforms.

## How It Works

### Desktop (Windows, macOS, Linux)

The desktop version uses **Tauri's built-in updater** with cryptographic signature verification to ensure updates are authentic and secure.

**Update Process:**

1. The app periodically checks for updates from our GitHub releases
2. When a new version is available, you'll see an in-app notification
3. Click "Download & Install" to download the update in the background
4. Once downloaded, the update is verified using cryptographic signatures
5. Click "Restart Now" to apply the update

**Security Features:**

- All updates are cryptographically signed using industry-standard signatures
- The app verifies signatures before installing to prevent tampering
- Updates are delivered over HTTPS from GitHub's secure servers
- Failed verification automatically rejects the update

### Android

The Android version uses a **custom update checker** that connects to GitHub releases to find new APK versions.

**Update Process:**

1. Open the app and navigate to Settings → Check for Updates
2. The app queries GitHub for the latest release
3. If a new version is available, you'll see the version number and release notes
4. Tap "Download APK" to download the new version
5. Once downloaded, tap the APK file to install
6. You may need to allow "Install from Unknown Sources" in Android settings

**Note:** Unlike desktop platforms, Android updates require manual installation due to platform restrictions. We recommend enabling "Install from Unknown Sources" for this app in your Android security settings.

## Manual Updates

If you prefer to update manually or encounter issues with auto-updates:

### Desktop Installers

1. Visit our [Releases Page](https://github.com/powergr/qre-privacy-toolkit/releases/latest)
2. Download the appropriate installer for your platform:
   - **Windows**: `QRE.Privacy.Toolkit_x.x.x_x64-setup.exe`
   - **macOS**: `QRE.Privacy.Toolkit_x.x.x_aarch64.dmg` or `x64.dmg`
   - **Linux**: `QRE.Privacy.Toolkit_x.x.x_amd64.AppImage` or `.deb`
3. Run the installer (it will replace your current installation)

### Android Installers

1. Visit our [Releases Page](https://github.com/powergr/qre-privacy-toolkit/releases/latest)
2. Download the APK file: `QRE.Privacy.Toolkit_x.x.x_arm64-v8a.apk`
3. Open the downloaded APK file
4. Allow installation from unknown sources if prompted
5. Tap "Install"

## Update Frequency

- **Release Updates**: We publish stable releases when significant features or fixes are ready
- **Security Updates**: Critical security patches are released immediately when needed
- **Check Frequency**: The app checks for updates when launched and can be manually triggered in Settings

## Privacy & Data

The update system:

- ✅ Only connects to GitHub's servers (no third-party analytics)
- ✅ Does not collect any personal information
- ✅ Does not track update installations
- ✅ Uses standard HTTPS connections
- ✅ Only downloads when you authorize it

## Troubleshooting

### Desktop: "Update Failed" Error

- **Check internet connection**: Ensure you have a stable connection
- **Verify signature error**: This usually means the update was corrupted. Try again.
- **Download manually**: If auto-update continues to fail, download the installer from GitHub

### Desktop: "Could not fetch release information"

- **Check internet connection**: Ensure GitHub is accessible
- **Firewall/Antivirus**: Verify your security software isn't blocking the update check
- **Try later**: GitHub's API may be temporarily unavailable

### Android: "Failed to open download"

- **Browser permissions**: Ensure your browser has storage permissions
- **Storage space**: Check that you have enough space for the APK (~50-100 MB)
- **Download manually**: Use your browser to download from GitHub directly

### Android: "App not installed" when installing APK

- **Enable Unknown Sources**: Go to Settings → Security → Install Unknown Apps → [Your Browser] → Allow
- **Storage permissions**: Ensure the installer has permission to access storage
- **Corrupted download**: Delete and re-download the APK
- **Incompatible architecture**: Ensure you downloaded the correct APK for your device (arm64-v8a for most modern devices)

## Support

If you encounter issues with updates:

- Check the [Troubleshooting](#troubleshooting) section above
- Open an issue on [GitHub Issues](https://github.com/powergr/qre-privacy-toolkit/issues)
- Include your platform, current version, and error message
