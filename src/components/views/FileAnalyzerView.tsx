import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FileSearch,
  ShieldAlert,
  AlertTriangle,
  CheckCircle,
  FolderSearch,
  Search,
  X,
  RefreshCw,
  Globe,
} from "lucide-react";

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
  const [hasScanned, setHasanned] = useState(false);
  const [scanPath, setScanPath] = useState<string | null>(null);
  const [scanLog, setScanLog] = useState<string[]>([]);

  const isCancelled = useRef(false);

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
    setHasanned(false);
    setScanPath(path || "Smart Scan (Downloads & Desktop)");
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
        setHasanned(true);
      }
    } catch (e) {
      if (!isCancelled.current) alert("Scan Error: " + e);
    } finally {
      if (!isCancelled.current) setLoading(false);
    }
  }

  const handleCancel = () => {
    isCancelled.current = true;
    setLoading(false);
  };

  async function handleBrowse() {
    try {
      const selected = await open({ directory: true });
      if (selected && typeof selected === "string") runScan(selected);
    } catch (e) {
      console.error(e);
    }
  }

  function showInFolder(path: string) {
    invoke("show_in_folder", { path });
  }

  function searchMismatch(ext: string, realType: string) {
    const query = `file extension .${ext} detected as ${realType}`;
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
      {/* HEADER */}
      <div
        style={{
          padding: "20px 30px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "var(--panel-bg)",
          flexShrink: 0,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: "1.4rem" }}>File Analyzer</h2>
          <p
            style={{ color: "var(--text-dim)", margin: 0, fontSize: "0.9rem" }}
          >
            Scan for files with disguised extensions.
          </p>
        </div>

        {hasScanned && (
          <button
            className="auth-btn"
            onClick={() => {
              setHasanned(false);
              setResults([]);
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <RefreshCw size={16} /> New Scan
          </button>
        )}
      </div>

      {/* CONTENT AREA */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          // Center vertically if NOT showing results list (Start or Loading)
          justifyContent: !hasScanned || loading ? "center" : "flex-start",
        }}
      >
        {/* 1. START SCREEN */}
        {!hasScanned && !loading && (
          <div
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 30,
                maxWidth: 700,
                width: "90%",
              }}
            >
              <div
                onClick={() => runScan(null)}
                className="modern-card"
                style={{
                  textAlign: "center",
                  cursor: "pointer",
                  padding: 40,
                  border: "1px solid var(--accent)",
                  background: "rgba(0, 122, 204, 0.05)",
                }}
              >
                <div
                  style={{
                    background: "rgba(0, 122, 204, 0.1)",
                    padding: 15,
                    borderRadius: "50%",
                    display: "inline-block",
                    marginBottom: 15,
                  }}
                >
                  <FileSearch size={50} color="var(--accent)" />
                </div>
                <h3 style={{ fontSize: "1.2rem", margin: 0 }}>Smart Scan</h3>
                <p
                  style={{
                    fontSize: "0.9rem",
                    color: "var(--text-dim)",
                    marginTop: 5,
                  }}
                >
                  Downloads, Documents, and Desktop
                </p>
              </div>

              <div
                onClick={handleBrowse}
                className="modern-card"
                style={{ textAlign: "center", cursor: "pointer", padding: 40 }}
              >
                <div
                  style={{
                    background: "rgba(255, 255, 255, 0.05)",
                    padding: 15,
                    borderRadius: "50%",
                    display: "inline-block",
                    marginBottom: 15,
                  }}
                >
                  <FolderSearch size={50} color="var(--text-dim)" />
                </div>
                <h3 style={{ fontSize: "1.2rem", margin: 0 }}>Custom Folder</h3>
                <p
                  style={{
                    fontSize: "0.9rem",
                    color: "var(--text-dim)",
                    marginTop: 5,
                  }}
                >
                  Select directory
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 2. LOADING SCREEN */}
        {loading && (
          <div
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div className="spinner" style={{ marginBottom: 20 }}>
              <Search size={64} color="var(--accent)" />
            </div>
            <h3>Deep Scanning...</h3>
            <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
              {scanPath?.split(/[/\\]/).pop() || "Directory"}
            </p>

            {/* WIDER LOG BOX */}
            <div
              style={{
                background: "#000",
                padding: 15,
                borderRadius: 8,
                fontFamily: "monospace",
                fontSize: "0.85rem",
                color: "#4ade80",
                width: "80%",
                maxWidth: "800px",
                height: "100px",
                overflow: "hidden",
                opacity: 0.9,
                border: "1px solid #333",
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
              onClick={handleCancel}
              style={{ marginTop: 30, padding: "10px 25px" }}
            >
              <X size={16} style={{ marginRight: 8 }} /> Stop Scan
            </button>
          </div>
        )}

        {/* 3. RESULTS GRID */}
        {hasScanned && !loading && (
          <div
            style={{
              padding: 20,
              maxWidth: 1000,
              margin: "0 auto",
              width: "100%",
            }}
          >
            {results.length === 0 ? (
              <div style={{ textAlign: "center", marginTop: 50 }}>
                <CheckCircle
                  size={64}
                  color="#4ade80"
                  style={{ marginBottom: 15 }}
                />
                <h3>Clean! No Mismatches Found.</h3>
                <p style={{ color: "var(--text-dim)" }}>
                  All scanned files match their extensions.
                </p>
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    gap: 20,
                    marginBottom: 20,
                    fontSize: "0.9rem",
                  }}
                >
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
                </div>

                {/* HEADER */}
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

                {/* ROWS */}
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
