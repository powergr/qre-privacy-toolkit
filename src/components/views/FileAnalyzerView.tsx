import { useShortcut } from "../../hooks/useShortcut";
import { ToolPage } from "../common/ToolPage";
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
  Globe,
  RefreshCw,
} from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";
import { Banner } from "../ui/Banner";
import { Badge } from "../ui/Badge";
import { Chip } from "../ui/Chip";
import { DropZone } from "../ui/DropZone";
import { ProgressCard } from "../ui/ProgressCard";

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
  // Which findings the list shows: everything, only dangers, or only warnings.
  const [filter, setFilter] = useState<"all" | "DANGER" | "WARNING">("all");

  const isCancelled = useRef(false);
  // Identifies the scan that owns the screen. Starting or cancelling a scan bumps it,
  // so a cancelled scan that finishes late cannot overwrite a newer one.
  const scanIdRef = useRef(0);

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
    const scanId = ++scanIdRef.current;
    setLoading(true);
    setResults([]);
    setHasScanned(false);
    setError(null);
    setScanPath(path || "Smart Scan (Downloads, Documents, and Desktop)");
    setScanLog([]);
    setFilter("all");
    isCancelled.current = false;

    try {
      const res = await invoke<AnalysisResult[]>("scan_directory_targets", {
        path,
      });
      if (scanId === scanIdRef.current) {
        const sorted = res.sort((a, b) => {
          if (a.risk_level === "DANGER" && b.risk_level !== "DANGER") return -1;
          if (b.risk_level === "DANGER" && a.risk_level !== "DANGER") return 1;
          return a.filename.localeCompare(b.filename);
        });
        setResults(sorted);
        setHasScanned(true);
      }
    } catch (e) {
      if (scanId === scanIdRef.current) {
        setError("Scan Error: " + e);
        setHasScanned(false);
      }
    } finally {
      if (scanId === scanIdRef.current) setLoading(false);
    }
  }

  const handleCancel = () => {
    scanIdRef.current += 1;
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
    invoke("show_in_folder", { path }).catch((e) => setError(String(e)));
  }

  function searchMismatch(ext: string, realType: string) {
    const query = `file extension .${ext} detected as ${realType} malware indicator`;
    openUrl(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
  }

  // Ctrl+O picks a folder to scan, unless a scan is running.
  useShortcut("o", handleBrowse, { enabled: !loading });

  const dangers = results.filter((r) => r.risk_level === "DANGER").length;
  const warnings = results.filter((r) => r.risk_level === "WARNING").length;
  const visible = filter === "all" ? results : results.filter((r) => r.risk_level === filter);
  const columns = "100px 2fr 100px 100px 3fr 100px 50px";

  return (
    <ToolPage
      title="File Analyzer"
      subtitle="Deep scan files and folders for spoofed extensions, RTLO Unicode tricks, and hidden executables."
      centered={!hasScanned}
    >
      {error && (
        <div style={{ width: "100%", maxWidth: 600, margin: "0 auto 20px auto" }}>
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      )}

      {/* START AND WORKING STATES */}
      {!hasScanned && (
        <>
          <div style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
            {loading ? (
              <>
                <ProgressCard
                  title="Deep Scanning..."
                  detail={scanPath?.split(/[/\\]/).pop() || "Directory"}
                  percent={null}
                  onCancel={handleCancel}
                  cancelLabel="Cancel Scan"
                />
                {/* The newest files the scan has looked at */}
                <div
                  aria-label="Files being scanned"
                  style={{
                    background: "#0a0a0a",
                    padding: 15,
                    borderRadius: 8,
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    color: "#4ade80",
                    width: "100%",
                    height: "80px",
                    marginTop: 16,
                    overflow: "hidden",
                    border: "1px solid #333",
                    textAlign: "left",
                    boxSizing: "border-box",
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
              </>
            ) : isMobile ? (
              // Phones: no drag and drop and no folder picker, only the smart scan
              <DropZone
                icon={<FolderSearch size={42} />}
                hue="var(--hue-inspect)"
                title="Scan Your Device"
                description="Scans Downloads, Documents, and common folders"
                buttonLabel="Start Smart Scan"
                buttonIcon={<Search size={16} aria-hidden="true" />}
                onBrowse={() => runScan(null)}
                clickable={false}
              />
            ) : (
              <DropZone
                icon={<FolderSearch size={42} />}
                hue="var(--hue-inspect)"
                title="Drag & Drop a File or Folder"
                description="Supports single files and deep directory traversal"
                buttonLabel="Select Target"
                onBrowse={handleBrowse}
                active={isDragging}
              />
            )}
          </div>

          {/* Smart Scan link: desktop only, phones already show the smart scan as the main button */}
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
                Or run a Smart System Scan (Downloads, Documents, and Desktop)
              </button>
            </div>
          )}
        </>
      )}

      {/* RESULTS */}
      {hasScanned && !loading && (
        <div style={{ maxWidth: 1000, margin: "0 auto", width: "100%" }}>
          {/* Summary, filters and a way to start again */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 12,
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: "0.9rem" }}>
              {results.length === 0 ? (
                <div
                  style={{
                    color: "var(--status-ok)",
                    fontWeight: "bold",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <CheckCircle size={18} /> No malicious files found
                </div>
              ) : (
                <div role="group" aria-label="Show" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Chip selected={filter === "all"} onClick={() => setFilter("all")}>
                    {`All ${results.length}`}
                  </Chip>
                  <Chip selected={filter === "DANGER"} onClick={() => setFilter("DANGER")}>
                    {`${dangers} Dangers`}
                  </Chip>
                  <Chip selected={filter === "WARNING"} onClick={() => setFilter("WARNING")}>
                    {`${warnings} Warnings`}
                  </Chip>
                </div>
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

          {results.length > 0 && visible.length === 0 && (
            <Banner tone="info">
              Nothing in this category. Choose All to see every finding.
            </Banner>
          )}

          {/* GRID HEADER */}
          {visible.length > 0 && (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: columns,
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
              {visible.map((item, i) => (
                <div
                  key={item.path + i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    padding: "12px 10px",
                    alignItems: "center",
                    borderBottom: "1px solid var(--border)",
                    background: item.risk_level === "DANGER" ? "var(--status-danger-soft)" : "transparent",
                    fontSize: "0.9rem",
                  }}
                >
                  <div>
                    {item.risk_level === "DANGER" ? (
                      <Badge tone="danger">
                        <ShieldAlert size={13} aria-hidden="true" /> Danger
                      </Badge>
                    ) : (
                      <Badge tone="warn">
                        <AlertTriangle size={13} aria-hidden="true" /> Warning
                      </Badge>
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
                  <div style={{ fontFamily: "monospace", color: "var(--text-dim)" }}>.{item.extension}</div>
                  <div style={{ fontFamily: "monospace", color: "var(--accent-text)" }}>.{item.real_type}</div>
                  <div
                    style={{
                      color: item.risk_level === "DANGER" ? "var(--status-danger)" : "var(--status-warn)",
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
                      onClick={() => searchMismatch(item.extension, item.real_type)}
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
    </ToolPage>
  );
}
