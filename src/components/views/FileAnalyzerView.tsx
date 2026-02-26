import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";
import {
  ShieldAlert,
  AlertTriangle,
  CheckCircle,
  FolderSearch,
  Search,
  X,
  Globe,
  Upload,
  RefreshCw,
} from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";

interface AnalysisResult {
  path: string;
  filename: string;
  extension: string;
  real_type: string;
  risk_level: "DANGER" | "WARNING" | "SAFE";
  description: string;
}

export function FileAnalyzerView() {
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [scanPath, setScanPath] = useState<string | null>(null);
  const [scanLog, setScanLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  const isCancelled = useRef(false);

  useEffect(() => {
    const p = platform();
    setIsMobile(p === "android" || p === "ios");
  }, []);

  // Integrate Drag & Drop hook — only meaningful on desktop, but safe to keep
  const { isDragging } = useDragDrop(async (paths) => {
    if (paths.length > 0 && !loading && !hasScanned) {
      runScan(paths[0]);
    }
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function setupListener() {
      unlisten = await listen<string>("qre:analyzer-progress", (event) => {
        if (!isCancelled.current) {
          setScanLog((prev) => [event.payload, ...prev].slice(0, 3));
        }
      });
    }
    setupListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  async function runScan(path: string | null) {
    setLoading(true);
    setResults([]);
    setHasScanned(false);
    setError(null);
    setScanPath(path || "Smart Scan (Downloads, Documents, and Desktop)");
    setScanLog([]);
    isCancelled.current = false;

    try {
      const res = await invoke<AnalysisResult[]>("scan_directory_targets", {
        path,
      });
      if (!isCancelled.current) {
        const sorted = res.sort((a, b) => {
          if (a.risk_level === "DANGER" && b.risk_level !== "DANGER") return -1;
          if (b.risk_level === "DANGER" && a.risk_level !== "DANGER") return 1;
          return a.filename.localeCompare(b.filename);
        });
        setResults(sorted);
        setHasScanned(true);
      }
    } catch (e) {
      if (!isCancelled.current) {
        setError("Scan Error: " + e);
        setHasScanned(false);
      }
    } finally {
      if (!isCancelled.current) setLoading(false);
    }
  }

  const handleCancel = () => {
    isCancelled.current = true;
    setLoading(false);
    setScanLog([]);
  };

  async function handleBrowse() {
    // Folder picker is not available on Android/iOS — fall back to smart scan
    if (isMobile) {
      runScan(null);
      return;
    }
    try {
      const selected = await open({
        directory: true,
        title: "Select folder to scan deeply",
      });
      if (selected && typeof selected === "string") runScan(selected);
    } catch (e) {
      setError("Failed to open file dialog: " + e);
    }
  }

  function showInFolder(path: string) {
    invoke("show_in_folder", { path });
  }

  function searchMismatch(ext: string, realType: string) {
    const query = `file extension .${ext} detected as ${realType} malware indicator`;
    openUrl(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
  }

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
          justifyContent: !hasScanned ? "center" : "flex-start",
        }}
      >
        {/* Header */}
        <div
          style={{ textAlign: "center", marginBottom: hasScanned ? 30 : 40 }}
        >
          <h2 style={{ margin: 0 }}>File Analyzer</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
            Deep scan files and folders for spoofed extensions, RTLO Unicode
            tricks, and hidden executables.
          </p>
        </div>

        {/* Global Error Banner */}
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
        {!hasScanned && (
          <>
            <div
              // Only make the whole zone clickable on desktop
              className={`shred-zone ${isDragging && !isMobile ? "active" : ""}`}
              style={{
                borderColor: loading ? "var(--text-dim)" : "var(--accent)",
                width: "100%",
                maxWidth: "600px",
                margin: "0 auto",
                minHeight: "300px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
                cursor: !loading && !isMobile ? "pointer" : "default",
              }}
              onClick={!loading && !isMobile ? handleBrowse : undefined}
            >
              {loading ? (
                <div
                  style={{ textAlign: "center", width: "100%", padding: 20 }}
                >
                  <Search
                    size={48}
                    color="var(--accent)"
                    className="spinner"
                    style={{ marginBottom: 15 }}
                  />
                  <h3>Deep Scanning...</h3>
                  <p style={{ color: "var(--text-dim)", marginBottom: 15 }}>
                    {scanPath?.split(/[/\\]/).pop() || "Directory"}
                  </p>

                  {/* Terminal Log Box */}
                  <div
                    style={{
                      background: "#0a0a0a",
                      padding: 15,
                      borderRadius: 8,
                      fontFamily: "monospace",
                      fontSize: "0.8rem",
                      color: "#4ade80",
                      width: "100%",
                      maxWidth: "400px",
                      height: "80px",
                      margin: "0 auto",
                      overflow: "hidden",
                      border: "1px solid #333",
                      textAlign: "left",
                    }}
                  >
                    {scanLog.map((line, i) => (
                      <div
                        key={i}
                        style={{
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          opacity: 1 - i * 0.3,
                        }}
                      >
                        &gt; {line}
                      </div>
                    ))}
                  </div>

                  <button
                    className="secondary-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCancel();
                    }}
                    style={{ marginTop: 20 }}
                  >
                    Cancel Scan
                  </button>
                </div>
              ) : (
                <div style={{ textAlign: "center", opacity: 0.8 }}>
                  <div
                    style={{
                      background: "rgba(0, 122, 204, 0.1)",
                      padding: 20,
                      borderRadius: "50%",
                      marginBottom: 20,
                      display: "inline-block",
                    }}
                  >
                    <FolderSearch size={48} color="var(--accent)" />
                  </div>

                  {isMobile ? (
                    // --- MOBILE: no drag & drop, no folder picker ---
                    <>
                      <h3>Scan Your Device</h3>
                      <p style={{ marginBottom: 10, color: "var(--text-dim)" }}>
                        Scans Downloads, Documents, and common folders
                      </p>
                      <button
                        className="secondary-btn"
                        style={{ marginTop: 10 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          runScan(null);
                        }}
                      >
                        <Search size={16} style={{ marginRight: 8 }} /> Start
                        Smart Scan
                      </button>
                    </>
                  ) : (
                    // --- DESKTOP: drag & drop + folder picker ---
                    <>
                      <h3>Drag & Drop a File or Folder</h3>
                      <p style={{ marginBottom: 10, color: "var(--text-dim)" }}>
                        Supports single files and deep directory traversal
                      </p>
                      <button
                        className="secondary-btn"
                        style={{ marginTop: 10 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleBrowse();
                        }}
                      >
                        <Upload size={16} style={{ marginRight: 8 }} /> Select
                        Target
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Smart Scan link — desktop only, mobile already shows Smart Scan as primary */}
            {!loading && !isMobile && (
              <div style={{ textAlign: "center", marginTop: 25 }}>
                <button
                  className="icon-btn-ghost"
                  onClick={() => runScan(null)}
                  style={{
                    color: "var(--text-dim)",
                    textDecoration: "underline",
                    fontSize: "0.9rem",
                  }}
                >
                  Or run a Smart System Scan (Downloads, Documents, Desktop)
                </button>
              </div>
            )}
          </>
        )}

        {/* RESULTS GRID */}
        {hasScanned && !loading && (
          <div
            style={{
              maxWidth: 1000,
              margin: "0 auto",
              width: "100%",
            }}
          >
            {/* Top Action Bar */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 20,
              }}
            >
              <div style={{ display: "flex", gap: 20, fontSize: "0.9rem" }}>
                {results.length === 0 ? (
                  <div
                    style={{
                      color: "#4ade80",
                      fontWeight: "bold",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <CheckCircle size={18} /> No malicious files found
                  </div>
                ) : (
                  <>
                    <div
                      style={{ color: "var(--btn-danger)", fontWeight: "bold" }}
                    >
                      {results.filter((r) => r.risk_level === "DANGER").length}{" "}
                      Dangers
                    </div>
                    <div style={{ color: "#f59e0b", fontWeight: "bold" }}>
                      {results.filter((r) => r.risk_level === "WARNING").length}{" "}
                      Warnings
                    </div>
                  </>
                )}
              </div>

              <button
                className="secondary-btn"
                onClick={() => {
                  setHasScanned(false);
                  setResults([]);
                }}
                style={{ display: "flex", gap: 8, alignItems: "center" }}
              >
                <RefreshCw size={16} /> New Scan
              </button>
            </div>

            {/* GRID HEADER */}
            {results.length > 0 && (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "50px 2fr 100px 100px 3fr 100px 50px",
                    padding: "12px 10px",
                    background: "var(--panel-bg)",
                    fontWeight: "bold",
                    color: "var(--text-dim)",
                    fontSize: "0.75rem",
                    borderBottom: "1px solid var(--border)",
                    letterSpacing: 0.5,
                  }}
                >
                  <div>STATUS</div>
                  <div>FILENAME</div>
                  <div>EXT</div>
                  <div>REAL TYPE</div>
                  <div>ANALYSIS</div>
                  <div>ACTION</div>
                  <div></div>
                </div>

                {/* GRID ROWS */}
                {results.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "50px 2fr 100px 100px 3fr 100px 50px",
                      padding: "12px 10px",
                      alignItems: "center",
                      borderBottom: "1px solid var(--border)",
                      background:
                        item.risk_level === "DANGER"
                          ? "rgba(239, 68, 68, 0.05)"
                          : "transparent",
                      fontSize: "0.9rem",
                    }}
                  >
                    <div>
                      {item.risk_level === "DANGER" ? (
                        <ShieldAlert size={20} color="var(--btn-danger)" />
                      ) : (
                        <AlertTriangle size={20} color="#f59e0b" />
                      )}
                    </div>
                    <div
                      style={{
                        fontWeight: "bold",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        paddingRight: 10,
                      }}
                      title={item.filename}
                    >
                      {item.filename}
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        color: "var(--text-dim)",
                      }}
                    >
                      .{item.extension}
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        color: "var(--accent)",
                      }}
                    >
                      .{item.real_type}
                    </div>
                    <div
                      style={{
                        color:
                          item.risk_level === "DANGER"
                            ? "var(--btn-danger)"
                            : "#f59e0b",
                        fontSize: "0.85rem",
                        fontWeight: 500,
                      }}
                    >
                      {item.description}
                    </div>
                    <div>
                      <button
                        className="secondary-btn"
                        style={{ padding: "4px 10px", fontSize: "0.75rem" }}
                        onClick={() => showInFolder(item.path)}
                      >
                        Locate
                      </button>
                    </div>
                    <div>
                      <button
                        className="icon-btn-ghost"
                        title="Search this mismatch online"
                        onClick={() =>
                          searchMismatch(item.extension, item.real_type)
                        }
                        style={{ color: "var(--text-dim)" }}
                      >
                        <Globe size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
