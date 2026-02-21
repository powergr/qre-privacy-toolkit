import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { platform } from "@tauri-apps/plugin-os";
import {
  Trash2,
  HardDrive,
  Chrome,
  AppWindow,
  RefreshCw,
  CheckCircle,
  Smartphone,
  Brush,
  FileText,
  AlertTriangle,
  Code2,
  Globe,
  Eye,
  X,
  Loader2,
} from "lucide-react";
import { formatSize } from "../../utils/formatting";
import { InfoModal } from "../modals/AppModals";

interface JunkItem {
  id: string;
  name: string;
  path: string;
  category: string;
  size: number;
  description: string;
  warning?: string;
}

interface CleanProgress {
  files_processed: number;
  total_files: number;
  bytes_freed: number;
  current_file: string;
  percentage: number;
}

interface CleanResult {
  bytes_freed: number;
  files_deleted: number;
  errors: string[];
}

interface DryRunResult {
  total_files: number;
  total_size: number;
  file_list: string[];
  warnings: string[];
}

const LARGE_SIZE_WARNING = 10 * 1024 * 1024 * 1024; // 10 GB

export function SystemCleanerView() {
  const [isAndroid, setIsAndroid] = useState(false);
  const [items, setItems] = useState<JunkItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Dry run / Preview
  const [showPreview, setShowPreview] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);

  // Confirmation dialog
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);

  // Cleaning state
  const [cleaning, setCleaning] = useState(false);
  const [progress, setProgress] = useState<CleanProgress | null>(null);
  const [cleanResult, setCleanResult] = useState<CleanResult | null>(null);

  useEffect(() => {
    try {
      if (platform() === "android") setIsAndroid(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Progress event listener
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    async function setupProgressListener() {
      unlisten = await listen<CleanProgress>("clean-progress", (event) => {
        setProgress(event.payload);
      });
    }

    setupProgressListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // --- ACTIONS ---
  async function scan() {
    setLoading(true);
    setError(null);
    setCleanResult(null);
    setShowPreview(false);
    setDryRunResult(null);

    try {
      const res = await invoke<JunkItem[]>("scan_system_junk");
      setItems(res);

      // Select SAFE items by default (exclude Developer category)
      const safeIds = res
        .filter((i) => i.category !== "Developer")
        .map((i) => i.id);

      setSelectedIds(new Set(safeIds));
      setScanned(true);
    } catch (e) {
      setError("Scan failed: " + e);
    } finally {
      setLoading(false);
    }
  }

  async function previewClean() {
    if (selectedIds.size === 0) return;

    setLoading(true);
    setError(null);

    const paths = items.filter((i) => selectedIds.has(i.id)).map((i) => i.path);

    try {
      const result = await invoke<DryRunResult>("dry_run_clean", { paths });
      setDryRunResult(result);
      setShowPreview(true);
    } catch (e) {
      setError("Preview failed: " + e);
    } finally {
      setLoading(false);
    }
  }

  async function initiateClean() {
    const totalSize = items
      .filter((i) => selectedIds.has(i.id))
      .reduce((acc, i) => acc + i.size, 0);

    // Check if operation is large
    if (totalSize > LARGE_SIZE_WARNING) {
      setShowConfirmation(true);
    } else {
      performClean();
    }
  }

  async function performClean() {
    if (selectedIds.size === 0) return;

    setCleaning(true);
    setError(null);
    setShowConfirmation(false);
    setConfirmChecked(false);
    setProgress(null);

    const paths = items.filter((i) => selectedIds.has(i.id)).map((i) => i.path);

    try {
      const result = await invoke<CleanResult>("clean_system_junk", { paths });
      setCleanResult(result);
      setItems([]);
      setScanned(false);
      setShowPreview(false);

      if (result.errors.length > 0) {
        setError(
          `Cleaned successfully but encountered ${result.errors.length} error(s). See details.`,
        );
      } else {
        setMsg("Cleanup completed successfully!");
      }
    } catch (e) {
      setError("Clean failed: " + e);
    } finally {
      setCleaning(false);
      setProgress(null);
    }
  }

  async function cancelClean() {
    try {
      await invoke("cancel_system_clean");
      setError("Cleanup cancelled by user");
      setCleaning(false);
    } catch (e) {
      console.error("Failed to cancel:", e);
    }
  }

  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  };

  const toggleAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
    }
  };

  const totalSelectedSize = items
    .filter((i) => selectedIds.has(i.id))
    .reduce((acc, i) => acc + i.size, 0);

  const hasWarnings = items
    .filter((i) => selectedIds.has(i.id))
    .some((i) => i.warning);

  // --- ICONS ---
  const getIcon = (cat: string) => {
    if (cat === "Browser") return <Chrome size={20} color="#f97316" />;
    if (cat === "System") return <HardDrive size={20} color="#3b82f6" />;
    if (cat === "Logs") return <FileText size={20} color="#10b981" />;
    if (cat === "Developer") return <Code2 size={20} color="#ef4444" />;
    if (cat === "Network") return <Globe size={20} color="#06b6d4" />;
    return <AppWindow size={20} color="#a855f7" />;
  };

  // --- ANDROID VIEW ---
  if (isAndroid) {
    return (
      <div
        style={{
          padding: 40,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <div
          style={{
            background: "rgba(234, 179, 8, 0.1)",
            padding: 25,
            borderRadius: "50%",
            marginBottom: 20,
          }}
        >
          <Smartphone size={64} color="#eab308" />
        </div>
        <h2>Desktop Feature</h2>
        <p style={{ color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 300 }}>
          System cleaning is restricted on Android due to OS sandboxing.
        </p>
      </div>
    );
  }

  // --- DESKTOP VIEW ---
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "30px",
          display: "flex",
          flexDirection: "column",
          justifyContent: !scanned && !cleanResult ? "center" : "flex-start",
        }}
      >
        {/* HEADER */}
        <div
          style={{
            textAlign: "center",
            marginBottom: scanned || cleanResult ? 20 : 40,
          }}
        >
          <h2 style={{ margin: 0 }}>System Cleaner</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
            Clear temporary files, caches, and developer build artifacts.
          </p>
        </div>

        {/* ERROR BANNER */}
        {error && (
          <div
            style={{
              maxWidth: 700,
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

        {/* 1. START STATE */}
        {!scanned && !cleanResult && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              width: "100%",
            }}
          >
            <div
              className="shred-zone"
              style={{
                width: "100%",
                maxWidth: "400px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "40px",
                cursor: loading ? "wait" : "pointer",
                borderColor: loading ? "var(--text-dim)" : "var(--accent)",
              }}
              onClick={!loading ? scan : undefined}
            >
              <Brush
                size={64}
                color="var(--accent)"
                className={loading ? "spinner" : ""}
                style={{ marginBottom: 20 }}
              />
              {loading ? (
                <>
                  <h3>Scanning System...</h3>
                  <p style={{ color: "var(--text-dim)" }}>
                    Analyzing caches and temp files
                  </p>
                </>
              ) : (
                <>
                  <h3>Start Scan</h3>
                  <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
                    Click to analyze junk files
                  </p>
                  <button className="auth-btn" style={{ padding: "10px 30px" }}>
                    Scan Now
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* 2. SUCCESS STATE */}
        {cleanResult && (
          <div
            style={{
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 40,
              maxWidth: 600,
              margin: "0 auto",
            }}
          >
            <CheckCircle
              size={64}
              color="#4ade80"
              style={{ marginBottom: 20 }}
            />
            <h2>Cleanup Complete!</h2>
            <p
              style={{
                fontSize: "1.2rem",
                color: "var(--text-main)",
                marginBottom: 10,
              }}
            >
              Freed <strong>{formatSize(cleanResult.bytes_freed)}</strong> of
              space.
            </p>
            <p
              style={{
                fontSize: "0.9rem",
                color: "var(--text-dim)",
                marginBottom: 20,
              }}
            >
              Deleted {cleanResult.files_deleted.toLocaleString()} file(s)
            </p>

            {/* Show errors if any */}
            {cleanResult.errors.length > 0 && (
              <div
                style={{
                  width: "100%",
                  maxWidth: 500,
                  marginBottom: 20,
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  borderRadius: 8,
                  padding: 15,
                  textAlign: "left",
                }}
              >
                <h4 style={{ margin: "0 0 10px 0", fontSize: "0.9rem" }}>
                  Errors Encountered ({cleanResult.errors.length}):
                </h4>
                <div
                  style={{
                    maxHeight: 150,
                    overflowY: "auto",
                    fontSize: "0.8rem",
                    color: "var(--text-dim)",
                  }}
                >
                  {cleanResult.errors.slice(0, 10).map((err, i) => (
                    <div
                      key={i}
                      style={{ marginBottom: 5, fontFamily: "monospace" }}
                    >
                      • {err}
                    </div>
                  ))}
                  {cleanResult.errors.length > 10 && (
                    <div style={{ marginTop: 5, fontStyle: "italic" }}>
                      ... and {cleanResult.errors.length - 10} more
                    </div>
                  )}
                </div>
              </div>
            )}

            <button
              className="secondary-btn"
              onClick={scan}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <RefreshCw size={16} /> Scan Again
            </button>
          </div>
        )}

        {/* 3. RESULTS LIST */}
        {scanned && items.length > 0 && !showPreview && (
          <div style={{ maxWidth: 700, margin: "0 auto", width: "100%" }}>
            {/* Toolbar */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 15,
                background: "var(--panel-bg)",
                padding: "10px 15px",
                borderRadius: 8,
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={selectedIds.size === items.length}
                  onChange={toggleAll}
                  style={{ cursor: "pointer" }}
                />
                <span style={{ fontWeight: "bold", fontSize: "0.9rem" }}>
                  {selectedIds.size} selected ({formatSize(totalSelectedSize)})
                </span>
              </div>
              <button
                className="icon-btn-ghost"
                onClick={scan}
                title="Rescan"
                disabled={loading}
              >
                <RefreshCw size={16} className={loading ? "spinner" : ""} />
              </button>
            </div>

            {/* Warning Banner */}
            {hasWarnings && (
              <div
                style={{
                  marginBottom: 15,
                  padding: 12,
                  background: "rgba(245, 158, 11, 0.1)",
                  border: "1px solid rgba(245, 158, 11, 0.3)",
                  borderRadius: 8,
                  color: "#f59e0b",
                  fontSize: "0.85rem",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                <span>
                  Selected items include warnings. Review carefully before
                  cleaning.
                </span>
              </div>
            )}

            {/* List */}
            <div
              style={{
                background: "var(--bg-card)",
                borderRadius: 10,
                border: "1px solid var(--border)",
                overflow: "hidden",
              }}
            >
              {items.map((item, index) => (
                <div
                  key={item.id}
                  onClick={() => toggleSelect(item.id)}
                  title={item.warning || item.description}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "15px",
                    borderBottom:
                      index < items.length - 1
                        ? "1px solid var(--border)"
                        : "none",
                    cursor: "pointer",
                    background: selectedIds.has(item.id)
                      ? "rgba(0, 122, 204, 0.05)"
                      : "transparent",
                    transition: "background 0.2s",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    onChange={() => {}}
                    style={{ marginRight: 15, transform: "scale(1.2)" }}
                  />
                  <div
                    style={{
                      marginRight: 15,
                      padding: 8,
                      background: "rgba(255,255,255,0.05)",
                      borderRadius: 8,
                    }}
                  >
                    {getIcon(item.category)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: "0.95rem",
                          color: item.warning ? "#f59e0b" : "var(--text-main)",
                        }}
                      >
                        {item.name}
                      </span>
                      {item.warning && (
                        <AlertTriangle size={14} color="#f59e0b" />
                      )}
                    </div>

                    <div
                      style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}
                    >
                      {item.description}
                    </div>
                  </div>

                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: "0.85rem",
                      fontWeight: "bold",
                      color: item.path.startsWith("::")
                        ? "var(--text-dim)"
                        : "var(--accent)",
                      border: item.path.startsWith("::")
                        ? "1px solid var(--border)"
                        : "none",
                      padding: item.path.startsWith("::") ? "2px 6px" : "0",
                      borderRadius: "4px",
                      opacity: item.path.startsWith("::") ? 0.8 : 1,
                      textAlign: "right",
                      minWidth: "70px",
                    }}
                  >
                    {item.path.startsWith("::")
                      ? "ACTION"
                      : formatSize(item.size)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 4. PREVIEW / DRY RUN */}
        {showPreview && dryRunResult && (
          <div style={{ maxWidth: 700, margin: "0 auto", width: "100%" }}>
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 20,
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 15,
                }}
              >
                <h3 style={{ margin: 0 }}>Preview: What Will Be Deleted</h3>
                <button
                  onClick={() => setShowPreview(false)}
                  className="icon-btn-ghost"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Summary */}
              <div
                style={{
                  background: "rgba(59, 130, 246, 0.1)",
                  border: "1px solid rgba(59, 130, 246, 0.3)",
                  borderRadius: 8,
                  padding: 15,
                  marginBottom: 15,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 10,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-dim)",
                      }}
                    >
                      Total Files:
                    </div>
                    <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                      {dryRunResult.total_files.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-dim)",
                      }}
                    >
                      Total Size:
                    </div>
                    <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                      {formatSize(dryRunResult.total_size)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Warnings */}
              {dryRunResult.warnings.length > 0 && (
                <div
                  style={{
                    background: "rgba(245, 158, 11, 0.1)",
                    border: "1px solid rgba(245, 158, 11, 0.3)",
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 15,
                  }}
                >
                  <h4
                    style={{
                      margin: "0 0 8px 0",
                      fontSize: "0.9rem",
                      color: "#f59e0b",
                    }}
                  >
                    Warnings:
                  </h4>
                  {dryRunResult.warnings.map((warning, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-dim)",
                        marginBottom: 4,
                      }}
                    >
                      • {warning}
                    </div>
                  ))}
                </div>
              )}

              {/* File List */}
              <div>
                <h4 style={{ margin: "0 0 10px 0", fontSize: "0.9rem" }}>
                  Files to be deleted:
                </h4>
                <div
                  style={{
                    maxHeight: 300,
                    overflowY: "auto",
                    background: "var(--bg-color)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 10,
                  }}
                >
                  {dryRunResult.file_list.map((file, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: "0.75rem",
                        fontFamily: "monospace",
                        color: "var(--text-dim)",
                        marginBottom: 4,
                        wordBreak: "break-all",
                      }}
                    >
                      {file}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                className="secondary-btn"
                onClick={() => setShowPreview(false)}
              >
                Back to List
              </button>
              <button className="auth-btn danger-btn" onClick={initiateClean}>
                <Trash2 size={16} style={{ marginRight: 8 }} />
                Confirm & Clean
              </button>
            </div>
          </div>
        )}

        {/* 5. CLEANING PROGRESS */}
        {cleaning && progress && (
          <div style={{ maxWidth: 600, margin: "0 auto", width: "100%" }}>
            <div
              className="modern-card"
              style={{
                padding: 30,
                textAlign: "center",
              }}
            >
              <Loader2
                size={48}
                className="spinner"
                style={{ marginBottom: 20 }}
              />
              <h3>Cleaning in Progress...</h3>

              {/* Progress Bar */}
              <div
                style={{
                  width: "100%",
                  background: "var(--border)",
                  height: 8,
                  borderRadius: 4,
                  overflow: "hidden",
                  margin: "20px 0",
                }}
              >
                <div
                  style={{
                    width: `${progress.percentage}%`,
                    height: "100%",
                    background: "var(--accent)",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>

              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                {progress.percentage}% - {progress.files_processed} of{" "}
                {progress.total_files} files
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.8rem",
                  marginTop: 10,
                  wordBreak: "break-all",
                }}
              >
                {formatSize(progress.bytes_freed)} freed
              </p>

              <button
                className="secondary-btn"
                onClick={cancelClean}
                style={{ marginTop: 20 }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* EMPTY STATE */}
        {scanned && items.length === 0 && (
          <div
            style={{
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 40,
            }}
          >
            <CheckCircle size={64} color="#4ade80" />
            <h3 style={{ marginTop: 20 }}>System is Clean</h3>
            <p style={{ color: "var(--text-dim)" }}>
              No temporary files or junk found.
            </p>
            <button
              className="secondary-btn"
              onClick={scan}
              style={{ marginTop: 20 }}
            >
              Scan Again
            </button>
          </div>
        )}
      </div>

      {/* FOOTER ACTIONS */}
      {scanned && items.length > 0 && !showPreview && !cleaning && (
        <div
          style={{
            padding: 20,
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "center",
            gap: 10,
            background: "var(--panel-bg)",
          }}
        >
          <button
            className="secondary-btn"
            onClick={previewClean}
            disabled={loading || selectedIds.size === 0}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Eye size={18} /> Preview ({selectedIds.size})
          </button>

          <button
            className="auth-btn danger-btn"
            onClick={initiateClean}
            disabled={loading || selectedIds.size === 0}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Trash2 size={18} /> Clean Selected ({formatSize(totalSelectedSize)}
            )
          </button>
        </div>
      )}

      {/* CONFIRMATION MODAL */}
      {showConfirmation && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowConfirmation(false)}
        >
          <div
            className="modern-card"
            style={{
              maxWidth: 500,
              width: "90%",
              padding: 30,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <AlertTriangle size={48} color="#f59e0b" />
            </div>

            <h3 style={{ textAlign: "center", marginBottom: 15 }}>
              Large Cleanup Operation
            </h3>

            <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
              You're about to delete{" "}
              <strong>{formatSize(totalSelectedSize)}</strong> of data. This
              operation cannot be undone.
            </p>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 20,
                cursor: "pointer",
                fontSize: "0.9rem",
              }}
            >
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />
              <span>
                I understand this will permanently delete the selected files
              </span>
            </label>

            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="secondary-btn"
                onClick={() => {
                  setShowConfirmation(false);
                  setConfirmChecked(false);
                }}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
              <button
                className="auth-btn danger-btn"
                onClick={performClean}
                disabled={!confirmChecked}
                style={{ flex: 1 }}
              >
                Confirm & Clean
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INFO MODAL */}
      {msg && <InfoModal message={msg} onClose={() => setMsg(null)} />}
    </div>
  );
}
