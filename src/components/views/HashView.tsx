import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  FileCheck,
  CheckCircle,
  XCircle,
  Copy,
  Hash,
  File as FileIcon,
  Loader2,
  Upload,
  AlertTriangle,
  Download,
  X,
  Info,
} from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { InfoModal } from "../modals/AppModals";

interface HashResult {
  sha256: string;
  sha1: string;
  md5: string;
}

interface FileMetadata {
  size: number;
  is_file: boolean;
  is_symlink: boolean;
}

// FIX: Progress event payload from Rust
interface ProgressPayload {
  bytes_processed: number;
  total_bytes: number;
  percentage: number;
}

// Constants for validation
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
const MAX_COMPARE_LENGTH = 128; // SHA512 would be 128 hex chars max

// Helper to format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

export function HashView() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [fileSize, setFileSize] = useState<number>(0);
  const [hashes, setHashes] = useState<HashResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [compare, setCompare] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // FIX: Real progress tracking from events
  const [progress, setProgress] = useState(0);
  const [bytesProcessed, setBytesProcessed] = useState(0);
  const [canCancel, setCanCancel] = useState(false);

  // Clipboard auto-clear timer
  const [clipboardTimer, setClipboardTimer] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);

  const { isDragging } = useDragDrop(async (paths) => {
    if (paths.length > 0) processFile(paths[0]);
  });

  // FIX: Set up progress event listener
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    async function setupProgressListener() {
      unlisten = await listen<ProgressPayload>("hash-progress", (event) => {
        const { bytes_processed, total_bytes, percentage } = event.payload;
        setProgress(percentage);
        setBytesProcessed(bytes_processed);

        // Optional: log for debugging
        console.log(
          `Progress: ${percentage}% (${formatBytes(bytes_processed)} / ${formatBytes(total_bytes)})`,
        );
      });
    }

    setupProgressListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Cleanup clipboard timer on unmount
  useEffect(() => {
    return () => {
      if (clipboardTimer) clearTimeout(clipboardTimer);
    };
  }, [clipboardTimer]);

  async function handleBrowse() {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Select file to hash",
      });
      if (selected && typeof selected === "string") {
        processFile(selected);
      }
    } catch (e) {
      setError("Failed to open file dialog: " + e);
    }
  }

  async function processFile(path: string) {
    setError(null);
    setFilePath(path);
    setFileName(path.split(/[/\\]/).pop() || "Unknown");
    setLoading(true);
    setHashes(null);
    setCompare("");
    setProgress(0);
    setBytesProcessed(0);
    setCanCancel(false);

    try {
      // Check file metadata first (size, type, symlink)
      const metadata = await invoke<FileMetadata>("get_file_metadata", {
        path,
      });

      // Validate it's a regular file
      if (!metadata.is_file) {
        throw new Error("Selected path is not a regular file");
      }

      // Validate not a symlink
      if (metadata.is_symlink) {
        throw new Error("Symlinks are not supported for security reasons");
      }

      // Validate file size
      if (metadata.size > MAX_FILE_SIZE) {
        throw new Error(
          `File is too large (${formatBytes(metadata.size)}). Maximum size: ${formatBytes(MAX_FILE_SIZE)}`,
        );
      }

      setFileSize(metadata.size);
      setCanCancel(true); // Allow cancellation once hashing starts

      // FIX: Call backend - it will emit progress events automatically
      const res = await invoke<HashResult>("calculate_file_hashes", {
        path,
      });

      setHashes(res);
      setMsg("Hashing completed successfully");
    } catch (e) {
      const errorMsg = String(e);

      // Better error messages
      if (errorMsg.includes("cancelled")) {
        setError("Hashing cancelled by user");
      } else if (errorMsg.includes("permission")) {
        setError("Permission denied. Cannot read file.");
      } else if (errorMsg.includes("not found")) {
        setError("File not found. It may have been moved or deleted.");
      } else {
        setError(errorMsg);
      }
    } finally {
      setLoading(false);
      setCanCancel(false);
    }
  }

  // Clipboard auto-clear (30 seconds)
  const copyToClip = async (text: string) => {
    try {
      await writeText(text);
      setMsg("Hash copied to clipboard (will auto-clear in 30s)");

      // Clear any existing timer
      if (clipboardTimer) clearTimeout(clipboardTimer);

      // Set new timer to clear clipboard after 30 seconds
      const timer = setTimeout(async () => {
        try {
          await writeText("");
        } catch {
          // Silent fail on clipboard clear
        }
      }, 30000);

      setClipboardTimer(timer);
    } catch (e) {
      setError("Failed to copy to clipboard: " + e);
    }
  };

  // Cancellation support
  async function cancelHashing() {
    setCanCancel(false);
    try {
      await invoke("cancel_hashing");
      setLoading(false);
      setError("Hashing cancelled");
    } catch (e) {
      console.error("Failed to cancel:", e);
    }
  }

  // Export results to text file
  async function exportResults() {
    if (!hashes || !filePath) return;

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const defaultFilename = `${fileName}_hashes_${timestamp}.txt`;

      const savePath = await save({
        defaultPath: defaultFilename,
        filters: [
          {
            name: "Text File",
            extensions: ["txt"],
          },
        ],
      });

      if (!savePath) return; // User cancelled

      const matchStatus = getMatchStatus(hashes.sha256);
      const content = `
File Integrity Check Report
Generated: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FILE INFORMATION:
  Path: ${filePath}
  Name: ${fileName}
  Size: ${formatBytes(fileSize)}

CRYPTOGRAPHIC HASHES:
  SHA-256: ${hashes.sha256}
  SHA-1:   ${hashes.sha1}
  MD5:     ${hashes.md5}

${
  compare
    ? `VERIFICATION:
  Expected:  ${compare}
  Status:    ${matchStatus === "match" ? "✓ MATCH CONFIRMED" : "✗ HASH MISMATCH"}
  Algorithm: ${getMatchedAlgorithm()}
`
    : ""
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generated by QRE Integrity Checker
      `.trim();

      await invoke("save_text_to_file", { path: savePath, content });
      setMsg("Results exported successfully");
    } catch (e) {
      setError("Failed to export results: " + e);
    }
  }

  const getMatchStatus = (hashType: string) => {
    if (!compare.trim()) return "neutral";
    const cleanCompare = compare.trim().toLowerCase();
    const cleanHash = hashType.toLowerCase();
    if (cleanHash === cleanCompare) return "match";
    return "nomatch";
  };

  const getMatchedAlgorithm = () => {
    if (!hashes || !compare.trim()) return "Unknown";
    const len = compare.trim().length;
    if (len === 64 && getMatchStatus(hashes.sha256) === "match")
      return "SHA-256";
    if (len === 40 && getMatchStatus(hashes.sha1) === "match") return "SHA-1";
    if (len === 32 && getMatchStatus(hashes.md5) === "match") return "MD5";
    return "Unknown";
  };

  const StatusIcon = ({ status }: { status: string }) => {
    if (status === "match") return <CheckCircle size={20} color="#4ade80" />;
    if (status === "nomatch") return <XCircle size={20} color="#f87171" />;
    return <Copy size={16} className="icon-copy" />;
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Scrollable Area */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "30px",
          display: "flex",
          flexDirection: "column",
          justifyContent: !hashes ? "center" : "flex-start",
        }}
      >
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: hashes ? 30 : 40 }}>
          <h2 style={{ margin: 0 }}>Integrity Checker</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
            Verify file downloads against official hashes.
          </p>
        </div>

        {/* Global error banner */}
        {error && (
          <div
            style={{
              maxWidth: 600,
              margin: "0 auto 20px auto",
              padding: 12,
              background: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: 8,
              color: "var(--btn-danger)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <AlertTriangle size={18} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{error}</span>
            <button
              onClick={() => setError(null)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                padding: 4,
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* DROP ZONE */}
        <div
          className={`shred-zone ${isDragging ? "active" : ""}`}
          style={{
            borderColor: loading ? "var(--text-dim)" : "var(--accent)",
            width: "100%",
            maxWidth: "600px",
            margin: "0 auto",
            minHeight: !hashes ? "300px" : "auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: hashes ? 20 : 0,
          }}
          onClick={!hashes && !loading ? handleBrowse : undefined}
        >
          {loading ? (
            <div style={{ textAlign: "center", width: "100%", padding: 20 }}>
              <Loader2
                size={48}
                className="spinner"
                style={{ marginBottom: 15 }}
              />
              <h3>Calculating Hashes...</h3>

              {/* FIX: Real progress bar with actual percentage */}
              <div
                style={{
                  width: "100%",
                  maxWidth: 400,
                  margin: "15px auto",
                  background: "var(--border)",
                  height: 8,
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    background: "var(--accent)",
                    height: "100%",
                    width: `${progress}%`,
                    transition: "width 0.3s ease",
                  }}
                />
              </div>

              {/* FIX: Show actual progress with bytes processed */}
              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                {progress > 0
                  ? `${progress}% - ${formatBytes(bytesProcessed)} processed`
                  : "Starting..."}
              </p>

              {/* Cancel button */}
              {canCancel && (
                <button
                  className="secondary-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelHashing();
                  }}
                  style={{ marginTop: 10 }}
                >
                  Cancel
                </button>
              )}
            </div>
          ) : !hashes ? (
            <div style={{ textAlign: "center", opacity: 0.8 }}>
              <div
                style={{
                  background: "rgba(234, 179, 8, 0.1)",
                  padding: 20,
                  borderRadius: "50%",
                  marginBottom: 20,
                  display: "inline-block",
                }}
              >
                <FileCheck size={48} color="#eab308" />
              </div>
              <h3>Drag & Drop a File</h3>
              <p style={{ marginBottom: 10, color: "var(--text-dim)" }}>
                Supports ISOs, Installers, Archives, Documents
              </p>
              <p
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-dim)",
                  marginBottom: 20,
                }}
              >
                Maximum file size: {formatBytes(MAX_FILE_SIZE)}
              </p>
              <button
                className="secondary-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleBrowse();
                }}
              >
                <Upload size={16} style={{ marginRight: 8 }} /> Select File
              </button>
            </div>
          ) : (
            <div style={{ textAlign: "center", width: "100%", padding: 20 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <FileIcon size={32} color="var(--accent)" />
                <div style={{ textAlign: "left" }}>
                  <h3
                    style={{
                      margin: 0,
                      fontSize: "1.1rem",
                      wordBreak: "break-word",
                    }}
                  >
                    {fileName}
                  </h3>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "0.8rem",
                      color: "var(--text-dim)",
                    }}
                  >
                    {formatBytes(fileSize)}
                  </p>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 10,
                  justifyContent: "center",
                  marginTop: 15,
                }}
              >
                <button
                  className="secondary-btn"
                  onClick={() => {
                    setHashes(null);
                    setFilePath(null);
                    setError(null);
                  }}
                >
                  Check Another File
                </button>

                <button
                  className="secondary-btn"
                  onClick={exportResults}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Download size={16} /> Export
                </button>
              </div>
            </div>
          )}
        </div>

        {/* RESULTS */}
        {hashes && (
          <div
            style={{
              maxWidth: 700,
              width: "100%",
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              gap: 20,
            }}
          >
            {/* Info banner */}
            <div
              style={{
                background: "rgba(59, 130, 246, 0.1)",
                border: "1px solid rgba(59, 130, 246, 0.3)",
                borderRadius: 8,
                padding: 12,
                display: "flex",
                gap: 10,
                fontSize: "0.85rem",
                color: "var(--text-dim)",
              }}
            >
              <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong style={{ color: "var(--text-main)" }}>
                  How to verify:
                </strong>{" "}
                Find the official hash on the software's website (usually in a
                file named SHA256SUMS or similar). Paste it below to verify your
                download hasn't been tampered with.
              </div>
            </div>

            {/* Compare Input */}
            <div
              style={{
                background: "var(--bg-card)",
                padding: 20,
                borderRadius: 10,
                border: "1px solid var(--border)",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 10,
                  fontWeight: "bold",
                }}
              >
                <Hash size={18} color="var(--accent)" /> Compare Hash:
              </label>
              <input
                className="auth-input"
                placeholder="Paste SHA256 / SHA1 / MD5 here..."
                value={compare}
                onChange={(e) => {
                  const val = e.target.value.trim();

                  if (val.length > MAX_COMPARE_LENGTH) {
                    setError(
                      `Hash too long (max ${MAX_COMPARE_LENGTH} characters)`,
                    );
                    return;
                  }

                  if (val && !/^[a-fA-F0-9]*$/.test(val)) {
                    setError("Invalid characters. Only hex allowed (0-9, a-f)");
                    return;
                  }

                  setError(null);
                  setCompare(val);
                }}
                style={{
                  borderColor:
                    getMatchStatus(hashes.sha256) === "match" ||
                    getMatchStatus(hashes.sha1) === "match" ||
                    getMatchStatus(hashes.md5) === "match"
                      ? "#4ade80"
                      : compare && getMatchStatus(hashes.sha256) !== "match"
                        ? "#f87171"
                        : "var(--border)",
                }}
              />
              {compare && (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: "0.9rem",
                    fontWeight: "bold",
                    textAlign: "center",
                    padding: 10,
                    borderRadius: 6,
                    background:
                      getMatchStatus(hashes.sha256) === "match" ||
                      getMatchStatus(hashes.sha1) === "match" ||
                      getMatchStatus(hashes.md5) === "match"
                        ? "rgba(74, 222, 128, 0.1)"
                        : "rgba(248, 113, 113, 0.1)",
                    border:
                      getMatchStatus(hashes.sha256) === "match" ||
                      getMatchStatus(hashes.sha1) === "match" ||
                      getMatchStatus(hashes.md5) === "match"
                        ? "1px solid rgba(74, 222, 128, 0.3)"
                        : "1px solid rgba(248, 113, 113, 0.3)",
                    color:
                      getMatchStatus(hashes.sha256) === "match" ||
                      getMatchStatus(hashes.sha1) === "match" ||
                      getMatchStatus(hashes.md5) === "match"
                        ? "#4ade80"
                        : "#f87171",
                  }}
                >
                  {getMatchStatus(hashes.sha256) === "match" ||
                  getMatchStatus(hashes.sha1) === "match" ||
                  getMatchStatus(hashes.md5) === "match" ? (
                    <>
                      <CheckCircle
                        size={20}
                        style={{ marginBottom: -4, marginRight: 8 }}
                      />
                      MATCH CONFIRMED ({getMatchedAlgorithm()})
                    </>
                  ) : (
                    <>
                      <XCircle
                        size={20}
                        style={{ marginBottom: -4, marginRight: 8 }}
                      />
                      HASH MISMATCH - File may be corrupted or tampered
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Hash Results */}
            <div
              className="modern-card"
              style={{ padding: 0, overflow: "hidden" }}
            >
              {["sha256", "sha1", "md5"].map((type) => (
                <div
                  key={type}
                  style={{
                    padding: 15,
                    borderBottom:
                      type !== "md5" ? "1px solid var(--border)" : "none",
                    background:
                      getMatchStatus((hashes as any)[type]) === "match"
                        ? "rgba(74, 222, 128, 0.1)"
                        : "transparent",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-dim)",
                      marginBottom: 5,
                      fontWeight: "bold",
                      textTransform: "uppercase",
                    }}
                  >
                    {type}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <code
                      style={{
                        wordBreak: "break-all",
                        fontSize: "0.85rem",
                        userSelect: "none",
                        WebkitUserSelect: "none",
                      }}
                    >
                      {(hashes as any)[type]}
                    </code>
                    <button
                      className="icon-btn-ghost"
                      onClick={() => copyToClip((hashes as any)[type])}
                      title="Copy to clipboard (auto-clears in 30s)"
                    >
                      <StatusIcon
                        status={getMatchStatus((hashes as any)[type])}
                      />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {msg && <InfoModal message={msg} onClose={() => setMsg(null)} />}
    </div>
  );
}
