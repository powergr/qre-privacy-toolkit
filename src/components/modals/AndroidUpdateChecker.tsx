// AndroidUpdateChecker.tsx
// This component checks for Android APK updates from GitHub releases

import { useState, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { platform } from "@tauri-apps/plugin-os";
import {
  Download,
  RefreshCw,
  X,
  CheckCircle,
  AlertTriangle,
} from "lucide-react";

interface AndroidUpdateCheckerProps {
  onClose: () => void;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

export function AndroidUpdateChecker({ onClose }: AndroidUpdateCheckerProps) {
  const [status, setStatus] = useState<
    "checking" | "available" | "uptodate" | "error"
  >("checking");
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    notes: string;
    downloadUrl: string;
  } | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    checkPlatformAndUpdate();
  }, []);

  async function checkPlatformAndUpdate() {
    const currentPlatform = platform();

    // Only run on Android
    if (currentPlatform !== "android") {
      setStatus("error");
      setErrorMsg("This update checker is only for Android");
      return;
    }

    const version = await getVersion();
    setCurrentVersion(version);
    checkForUpdates(version);
  }

  async function checkForUpdates(currentVersion: string) {
    try {
      // Fetch latest release from GitHub
      const response = await fetch(
        "https://api.github.com/repos/powergr/qre-privacy-toolkit/releases/latest",
      );

      if (!response.ok) {
        throw new Error("Failed to fetch release information");
      }

      const release: GitHubRelease = await response.json();

      // Extract version from tag (remove 'v' prefix if present)
      const latestVersion = release.tag_name.replace(/^v/, "");

      // Find APK asset
      const apkAsset = release.assets.find((asset) =>
        asset.name.endsWith(".apk"),
      );

      if (!apkAsset) {
        throw new Error("No APK found in the latest release");
      }

      // Compare versions
      if (isNewerVersion(latestVersion, currentVersion)) {
        setUpdateInfo({
          version: latestVersion,
          notes: release.body || "See release notes for details",
          downloadUrl: apkAsset.browser_download_url,
        });
        setStatus("available");
      } else {
        setStatus("uptodate");
      }
    } catch (e) {
      console.error(e);
      setStatus("error");
      setErrorMsg(String(e));
    }
  }

  function isNewerVersion(latest: string, current: string): boolean {
    const latestParts = latest.split(".").map(Number);
    const currentParts = current.split(".").map(Number);

    for (
      let i = 0;
      i < Math.max(latestParts.length, currentParts.length);
      i++
    ) {
      const latestPart = latestParts[i] || 0;
      const currentPart = currentParts[i] || 0;

      if (latestPart > currentPart) return true;
      if (latestPart < currentPart) return false;
    }

    return false;
  }

  async function downloadUpdate() {
    if (!updateInfo) return;

    try {
      // Open the download URL in the browser
      // Android will prompt to download the APK
      await openUrl(updateInfo.downloadUrl);

      // Show instructions
      alert(
        "Download started!\n\n" +
          "1. Wait for the download to complete\n" +
          "2. Open the downloaded APK\n" +
          "3. Allow installation from unknown sources if prompted\n" +
          "4. Install the update",
      );

      onClose();
    } catch (e) {
      setStatus("error");
      setErrorMsg("Failed to open download: " + String(e));
    }
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 99999 }}>
      <div className="auth-card" style={{ width: 450 }}>
        {/* HEADER */}
        <div className="modal-header">
          <RefreshCw
            size={20}
            className={status === "checking" ? "spinner" : ""}
            color="var(--accent)"
          />
          <h2>App Update</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>

        <div
          className="modal-body"
          style={{ textAlign: "center", padding: "20px 0" }}
        >
          {/* STATE: CHECKING */}
          {status === "checking" && (
            <p style={{ color: "var(--text-dim)" }}>Checking for updates...</p>
          )}

          {/* STATE: UP TO DATE */}
          {status === "uptodate" && (
            <div style={{ color: "#42b883" }}>
              <CheckCircle size={48} style={{ marginBottom: 15 }} />
              <h3>You are up to date!</h3>
              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                Version {currentVersion} is the latest version.
              </p>
              <button
                className="secondary-btn"
                onClick={onClose}
                style={{ marginTop: 20 }}
              >
                Close
              </button>
            </div>
          )}

          {/* STATE: AVAILABLE */}
          {status === "available" && updateInfo && (
            <div>
              <h3 style={{ margin: "0 0 10px 0" }}>New Version Available</h3>
              <div
                style={{
                  background: "var(--highlight)",
                  padding: "10px",
                  borderRadius: "8px",
                  marginBottom: 15,
                  fontFamily: "monospace",
                  fontSize: "1.2rem",
                  color: "var(--accent)",
                }}
              >
                v{updateInfo.version}
              </div>

              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.85rem",
                  marginBottom: 20,
                }}
              >
                Current: v{currentVersion}
              </p>

              {updateInfo.notes && (
                <div
                  style={{
                    textAlign: "left",
                    background: "rgba(0,0,0,0.2)",
                    padding: "10px",
                    borderRadius: "6px",
                    fontSize: "0.85rem",
                    color: "var(--text-dim)",
                    maxHeight: "100px",
                    overflowY: "auto",
                    marginBottom: 20,
                  }}
                >
                  {updateInfo.notes}
                </div>
              )}

              <button
                className="auth-btn"
                onClick={downloadUpdate}
                style={{ width: "100%" }}
              >
                <Download size={18} style={{ marginRight: 8 }} /> Download APK
              </button>

              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-dim)",
                  marginTop: 10,
                }}
              >
                You may need to enable "Install from Unknown Sources"
              </p>
            </div>
          )}

          {/* STATE: ERROR */}
          {status === "error" && (
            <div style={{ color: "var(--btn-danger)" }}>
              <AlertTriangle size={48} style={{ marginBottom: 15 }} />
              <h3>Update Check Failed</h3>
              <p style={{ fontSize: "0.9rem", margin: "10px 0" }}>{errorMsg}</p>
              <button className="secondary-btn" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
