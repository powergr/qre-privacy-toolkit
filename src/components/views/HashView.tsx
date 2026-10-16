import { useToast } from "../ui/Toast";
import { useShortcut } from "../../hooks/useShortcut";
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
  Download,
} from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ToolPage } from "../common/ToolPage";
import { Banner } from "../ui/Banner";
import { DropZone } from "../ui/DropZone";
import { ProgressCard } from "../ui/ProgressCard";

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
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  // FIX: Real progress tracking from events
  // SHA-256 is the one to check. SHA-1 and MD5 are older, so they sit behind a toggle.
  const [showOlder, setShowOlder] = useState(false);
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

  // The clipboard timer is deliberately not cancelled on unmount: it only wipes the
  // clipboard, and it must still fire if the user switches screens within 30 seconds.

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

  // Ctrl+O picks a file, unless one is being hashed right now.
  useShortcut("o", handleBrowse, { enabled: !loading });

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
      toast.success("Hashing completed successfully");
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);

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
      toast.success("Hash copied to clipboard (will auto-clear in 30s)");

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

      // Any of the three digests may be the one the user compared against.
      const isMatch = [hashes.sha256, hashes.sha1, hashes.md5].some(
        (h) => getMatchStatus(h) === "match",
      );
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
  Status:    ${isMatch ? "✓ MATCH CONFIRMED" : "✗ HASH MISMATCH"}
  Algorithm: ${getMatchedAlgorithm()}
`
    : ""
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generated by QRE Integrity Checker
      `.trim();

      await invoke("save_text_to_file", { path: savePath, content });
      toast.success("Results exported successfully");
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

  const matched =
    !!hashes && ["sha256", "sha1", "md5"].some((t) => getMatchStatus((hashes as any)[t]) === "match");
  const olderMatched = !!hashes && ["sha1", "md5"].some((t) => getMatchStatus((hashes as any)[t]) === "match");
  // A match on an older hash is shown even if the toggle is closed, so the proof is in view.
  const olderOpen = showOlder || olderMatched;

  const hashRow = (type: "sha256" | "sha1" | "md5") => (
    <div
      key={type}
      style={{
        padding: 15,
        borderBottom: "1px solid var(--border)",
        background: getMatchStatus((hashes as any)[type]) === "match" ? "var(--status-ok-soft)" : "transparent",
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
          <StatusIcon status={getMatchStatus((hashes as any)[type])} />
        </button>
      </div>
    </div>
  );

  return (
    <ToolPage
      title="Integrity Checker"
      subtitle="Verify file downloads against official hashes."
      centered={!hashes}
    >
      {error && (
        <div style={{ width: "100%", maxWidth: 600, margin: "0 auto 20px auto" }}>
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      )}

      {loading ? (
        <div style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
          <ProgressCard
            title="Calculating Hashes..."
            detail={progress > 0 ? `${progress}% - ${formatBytes(bytesProcessed)} processed` : "Starting..."}
            percent={progress > 0 ? progress : null}
            onCancel={canCancel ? cancelHashing : undefined}
          />
        </div>
      ) : !hashes ? (
        <div style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
          <DropZone
            icon={<FileCheck size={42} />}
            hue="var(--hue-inspect)"
            title="Drag & Drop a File"
            description="Supports ISOs, Installers, Archives, Documents"
            hint={`Maximum file size: ${formatBytes(MAX_FILE_SIZE)}`}
            buttonLabel="Select File"
            onBrowse={handleBrowse}
            active={isDragging}
          />
        </div>
      ) : (
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
          {/* The file that was checked, and what to do next */}
          <div
            className="modern-card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
              padding: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <FileIcon size={32} color="var(--accent)" />
              <div style={{ textAlign: "left", minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: "1.1rem", wordBreak: "break-word" }}>{fileName}</h3>
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-dim)" }}>{formatBytes(fileSize)}</p>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="secondary-btn"
                onClick={() => {
                  setHashes(null);
                  setFilePath(null);
                  setError(null);
                  setShowOlder(false);
                }}
              >
                Check Another File
              </button>
              <button
                className="secondary-btn"
                onClick={exportResults}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <Download size={16} /> Export
              </button>
            </div>
          </div>

          <Banner tone="info">
            <strong style={{ color: "var(--text-main)" }}>How to verify:</strong> Find the official hash on the
            software's website (usually in a file named SHA256SUMS or similar). Paste it below to verify your
            download hasn't been tampered with.
          </Banner>

          {/* Compare input */}
          <div
            style={{
              background: "var(--panel-bg)",
              padding: 20,
              borderRadius: 10,
              border: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: "bold" }}>
              <Hash size={18} color="var(--accent)" /> Compare Hash:
            </label>
            <input
              className="auth-input"
              placeholder="Paste SHA256 / SHA1 / MD5 here..."
              value={compare}
              onChange={(e) => {
                const val = e.target.value.trim();

                if (val.length > MAX_COMPARE_LENGTH) {
                  setError(`Hash too long (max ${MAX_COMPARE_LENGTH} characters)`);
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
                borderColor: matched ? "var(--status-ok)" : compare ? "var(--status-danger)" : "var(--border)",
              }}
            />
            {compare &&
              (matched ? (
                <Banner tone="success">MATCH CONFIRMED ({getMatchedAlgorithm()})</Banner>
              ) : (
                <Banner tone="error">HASH MISMATCH - File may be corrupted or tampered</Banner>
              ))}
          </div>

          {/* Hash results: SHA-256 first, the older ones on request */}
          <div className="modern-card" style={{ padding: 0, overflow: "hidden" }}>
            {hashRow("sha256")}
            {olderOpen && (
              <>
                {hashRow("sha1")}
                {hashRow("md5")}
              </>
            )}
            <button
              type="button"
              className="secondary-btn"
              aria-expanded={olderOpen}
              disabled={olderMatched}
              title={olderMatched ? "Shown because the hash you pasted matches one of them" : undefined}
              onClick={() => setShowOlder((o) => !o)}
              style={{ margin: 12, width: "calc(100% - 24px)" }}
            >
              {olderOpen ? "Hide older hashes" : "Show older hashes (SHA-1, MD5)"}
            </button>
          </div>
        </div>
      )}
    </ToolPage>
  );
}
