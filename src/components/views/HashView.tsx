import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  FileCheck,
  CheckCircle,
  XCircle,
  Copy,
  Hash,
  File as FileIcon,
  Loader2,
  Upload,
} from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { InfoModal } from "../modals/AppModals";

interface HashResult {
  sha256: string;
  sha1: string;
  md5: string;
}

export function HashView() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [hashes, setHashes] = useState<HashResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [compare, setCompare] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const { isDragging } = useDragDrop(async (paths) => {
    if (paths.length > 0) processFile(paths[0]);
  });

  async function handleBrowse() {
    try {
      const selected = await open({ multiple: false, directory: false });
      if (selected && typeof selected === "string") processFile(selected);
    } catch (e) {
      console.error(e);
    }
  }

  async function processFile(path: string) {
    setFilePath(path);
    setLoading(true);
    setHashes(null);
    setCompare("");

    try {
      const res = await invoke<HashResult>("calculate_file_hashes", { path });
      setHashes(res);
    } catch (e) {
      alert("Error hashing file: " + e);
    } finally {
      setLoading(false);
    }
  }

  const copyToClip = async (text: string) => {
    await writeText(text);
    setMsg("Hash copied to clipboard");
  };

  const getMatchStatus = (hashType: string) => {
    if (!compare.trim()) return "neutral";
    const cleanCompare = compare.trim().toLowerCase();
    const cleanHash = hashType.toLowerCase();
    if (cleanHash === cleanCompare) return "match";
    return "nomatch";
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
          // FIX: This ensures the content centers vertically when empty
          justifyContent: !hashes ? "center" : "flex-start",
        }}
      >
        {/* Header (Only show at top if we have results, otherwise center it with the dropzone) */}
        <div style={{ textAlign: "center", marginBottom: hashes ? 30 : 40 }}>
          <h2 style={{ margin: 0 }}>Integrity Checker</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
            Verify file downloads against official hashes.
          </p>
        </div>

        {/* DROP ZONE */}
        <div
          className={`shred-zone ${isDragging ? "active" : ""}`}
          style={{
            borderColor: loading ? "var(--text-dim)" : "var(--accent)",
            width: "100%",
            maxWidth: "600px",
            margin: "0 auto", // Horizontal Center
            minHeight: !hashes ? "300px" : "auto", // Taller when empty
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: hashes ? 20 : 0,
          }}
          onClick={!hashes && !loading ? handleBrowse : undefined}
        >
          {loading ? (
            <div style={{ textAlign: "center" }}>
              <Loader2
                size={48}
                className="spinner"
                style={{ marginBottom: 15 }}
              />
              <h3>Calculating...</h3>
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
              <p style={{ marginBottom: 20 }}>
                Supports ISOs, Installers, Archives
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
                  marginBottom: 15,
                }}
              >
                <FileIcon size={32} color="var(--accent)" />
                <h3
                  style={{
                    margin: 0,
                    wordBreak: "break-all",
                    fontSize: "1.1rem",
                  }}
                >
                  {filePath?.split(/[/\\]/).pop()}
                </h3>
              </div>
              <button
                className="secondary-btn"
                onClick={() => {
                  setHashes(null);
                  setFilePath(null);
                }}
              >
                Check Another File
              </button>
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
                <Hash size={18} color="var(--accent)" /> Compare Source:
              </label>
              <input
                className="auth-input"
                placeholder="Paste SHA256 / SHA1 / MD5 here..."
                value={compare}
                onChange={(e) => setCompare(e.target.value)}
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
                    color:
                      getMatchStatus(hashes.sha256) === "match" ||
                      getMatchStatus(hashes.sha1) === "match"
                        ? "#4ade80"
                        : "#f87171",
                  }}
                >
                  {getMatchStatus(hashes.sha256) === "match" ||
                  getMatchStatus(hashes.sha1) === "match"
                    ? "✅ MATCH CONFIRMED"
                    : "❌ HASH MISMATCH"}
                </div>
              )}
            </div>

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
                      style={{ wordBreak: "break-all", fontSize: "0.85rem" }}
                    >
                      {(hashes as any)[type]}
                    </code>
                    <button
                      className="icon-btn-ghost"
                      onClick={() => copyToClip((hashes as any)[type])}
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
