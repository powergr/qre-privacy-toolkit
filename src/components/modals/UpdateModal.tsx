import { useState, useEffect } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { platform } from "@tauri-apps/plugin-os"; // <--- Import platform
import {
  Download,
  RefreshCw,
  X,
  CheckCircle,
  AlertTriangle,
  Play,
  Smartphone,
} from "lucide-react";

interface UpdateModalProps {
  onClose: () => void;
}

export function UpdateModal({ onClose }: UpdateModalProps) {
  const [status, setStatus] = useState<
    | "checking"
    | "available"
    | "uptodate"
    | "downloading"
    | "ready"
    | "error"
    | "wrong-platform"
  >("checking");

  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    body?: string;
    date?: string;
  } | null>(null);

  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [currentVersion, setCurrentVersion] = useState<string>("");

  useEffect(() => {
    initialize();
  }, []);

  async function initialize() {
    try {
      // 1. Safety Check for Android
      if (platform() === "android" || platform() === "ios") {
        setStatus("wrong-platform");
        return;
      }

      // 2. Normal Desktop Logic
      const v = await getVersion();
      setCurrentVersion(v);
      checkForUpdates();
    } catch (e) {
      console.error(e);
      setStatus("error");
      setErrorMsg("Initialization failed: " + String(e));
    }
  }

  async function checkForUpdates() {
    try {
      setStatus("checking");
      const update = await check();

      if (update && update.available) {
        setUpdateInfo({
          version: update.version,
          body: update.body,
          date: update.date,
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

  async function startUpdate() {
    const update = await check();
    if (!update) return;

    setStatus("downloading");
    let downloaded = 0;
    let contentLength = 0;

    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength || 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              const pct = Math.round((downloaded / contentLength) * 100);
              setProgress(pct);
            }
            break;
          case "Finished":
            setStatus("ready");
            break;
        }
      });
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      let msg = String(e);
      if (msg.includes("Signature")) msg = "Signature verification failed.";
      if (msg.includes("404")) msg = "Update file not found on server.";
      setErrorMsg(msg);
    }
  }

  async function restartApp() {
    try {
      await relaunch();
    } catch (e) {
      setErrorMsg("Failed to restart: " + String(e));
    }
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 99999 }}>
      <div className="auth-card" style={{ width: 450 }}>
        <div className="modal-header">
          <RefreshCw
            size={20}
            className={
              status === "checking" || status === "downloading" ? "spinner" : ""
            }
            color="var(--accent)"
          />
          <h2>Software Update</h2>
          <div style={{ flex: 1 }}></div>
          {status !== "downloading" && (
            <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
          )}
        </div>

        <div
          className="modal-body"
          style={{ textAlign: "center", padding: "20px 0" }}
        >
          {/* WRONG PLATFORM GUARD */}
          {status === "wrong-platform" && (
            <div style={{ color: "#f59e0b" }}>
              <Smartphone size={48} style={{ marginBottom: 15 }} />
              <h3>Wrong Updater Loaded</h3>
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.9rem",
                  marginBottom: 20,
                }}
              >
                This is the Desktop updater. <br />
                Please use <b>UniversalUpdateModal</b> in your code.
              </p>
              <button className="secondary-btn" onClick={onClose}>
                Close
              </button>
            </div>
          )}

          {/* CHECKING */}
          {status === "checking" && (
            <p style={{ color: "var(--text-dim)" }}>Checking for updates...</p>
          )}

          {/* UP TO DATE */}
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

          {/* AVAILABLE */}
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.8rem",
                  color: "var(--text-dim)",
                  marginBottom: 15,
                }}
              >
                <span>Current: v{currentVersion}</span>
                {updateInfo.date && (
                  <span>{updateInfo.date.split(" ")[0]}</span>
                )}
              </div>
              {updateInfo.body && (
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
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {updateInfo.body}
                </div>
              )}
              <button
                className="auth-btn"
                onClick={startUpdate}
                style={{ width: "100%" }}
              >
                <Download size={18} style={{ marginRight: 8 }} /> Download &
                Install
              </button>
            </div>
          )}

          {/* DOWNLOADING */}
          {status === "downloading" && (
            <div>
              <h3 style={{ marginBottom: 15 }}>Downloading...</h3>
              <div
                style={{
                  width: "100%",
                  height: "8px",
                  background: "var(--border)",
                  borderRadius: "4px",
                  overflow: "hidden",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    width: `${progress}%`,
                    height: "100%",
                    background: "var(--accent)",
                    transition: "width 0.2s",
                  }}
                />
              </div>
              <p style={{ fontFamily: "monospace", color: "var(--accent)" }}>
                {progress}%
              </p>
            </div>
          )}

          {/* READY */}
          {status === "ready" && (
            <div>
              <CheckCircle
                size={48}
                color="var(--accent)"
                style={{ marginBottom: 15 }}
              />
              <h3>Update Installed!</h3>
              <button
                className="auth-btn"
                onClick={restartApp}
                style={{ width: "100%" }}
              >
                <Play size={18} style={{ marginRight: 8 }} /> Restart Now
              </button>
            </div>
          )}

          {/* ERROR */}
          {status === "error" && (
            <div style={{ color: "var(--btn-danger)" }}>
              <AlertTriangle size={48} style={{ marginBottom: 15 }} />
              <h3>Update Failed</h3>
              <p
                style={{
                  fontSize: "0.9rem",
                  margin: "10px 0",
                  wordBreak: "break-word",
                }}
              >
                {errorMsg}
              </p>
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
