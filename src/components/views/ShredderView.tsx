import { useShortcut } from "../../hooks/useShortcut";
import { ToolScroll, ToolTabs } from "../common/ToolPage";
import { useState, useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  Trash2,
  AlertTriangle,
  File,
  X,
  Loader2,
  FileX,
  Eye,
  Flame,
  Shield,
  Zap,
  Info,
  HardDrive,
  CheckCircle,
  RefreshCw,
  Lock,
} from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import { Banner } from "../ui/Banner";
import { DropZone } from "../ui/DropZone";
import { ProgressCard } from "../ui/ProgressCard";

// ─── Types ─────────────────────────────────────────────────────────────────

interface ShredProgress {
  current_file: number;
  total_files: number;
  current_pass: number;
  total_passes: number;
  current_file_name: string;
  percentage: number;
  bytes_processed: number;
  total_bytes: number;
}

interface ShredResult {
  success: string[];
  failed: FailedFile[];
  total_files: number;
  total_bytes_shredded: number;
}

interface FailedFile {
  path: string;
  error: string;
}

interface FileInfo {
  path: string;
  name: string;
  size: number;
  is_directory: boolean;
  file_count: number;
  warning?: string;
}

interface DryRunResult {
  files: FileInfo[];
  total_size: number;
  total_file_count: number;
  warnings: string[];
  blocked: string[];
}

interface WipeProgress {
  bytes_written: number;
  phase: string;
}

interface WipeFreeSpaceResult {
  bytes_wiped: number;
  target_path: string;
}

interface TrimResult {
  success: boolean;
  drive: string;
  message: string;
}

type ShredMethod = "simple" | "dod3pass" | "dod7pass" | "gutmann";
type TopTab = "shred" | "drive";

// ─── Helpers ───────────────────────────────────────────────────────────────

const formatSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    sizes.length - 1,
    Math.floor(Math.log(bytes) / Math.log(k)),
  );
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
};

// ─── Sub-components ────────────────────────────────────────────────────────

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 12,
        background: "rgba(59, 130, 246, 0.05)",
        border: "1px solid rgba(59, 130, 246, 0.2)",
        borderRadius: 8,
        fontSize: "0.8rem",
        color: "var(--text-dim)",
        display: "flex",
        gap: 8,
      }}
    >
      <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div data-testid="error-banner" style={{ marginBottom: 20 }}>
      <Banner tone="error" onDismiss={onDismiss}>
        {message}
      </Banner>
    </div>
  );
}

// ─── Tab Bar ────────────────────────────────────────────────────────────────
// Pill-style, centered, floats inside the scroll area so it always appears
// at the same vertical position regardless of tab content height.

interface TabBarProps {
  active: TopTab;
  locked: boolean;
  onChange: (tab: TopTab) => void;
}

function TabBar({ active, locked, onChange }: TabBarProps) {
  const tabs: { id: TopTab; label: string; icon: React.ReactNode }[] = [
    { id: "shred", label: "Shred Files", icon: <FileX size={14} /> },
    { id: "drive", label: "Drive Maintenance", icon: <HardDrive size={14} /> },
  ];

  return (
    <ToolTabs>
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        const isDisabled = locked && !isActive;
        return (
          <button
            key={tab.id}
            data-testid={`top-tab-${tab.id}`}
            onClick={() => !isDisabled && onChange(tab.id)}
            title={isDisabled ? "An operation is in progress" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 20px",
              borderRadius: "6px",
              border: "none",
              background: isActive ? "var(--accent)" : "transparent",
              color: isActive ? "white" : "var(--text-dim)",
              cursor: isDisabled ? "not-allowed" : "pointer",
              fontWeight: 500,
              opacity: isDisabled ? 0.4 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {isDisabled ? <Lock size={13} /> : tab.icon}
            {tab.label}
          </button>
        );
      })}
    </ToolTabs>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function ShredderView() {
  // ── Navigation ────────────────────────────────────────────────────────
  const [topTab, setTopTab] = useState<TopTab>("shred");

  // ── Shred tab state ───────────────────────────────────────────────────
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const [shredding, setShredding] = useState(false);
  const [result, setResult] = useState<ShredResult | null>(null);
  const [shredError, setShredError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [method, setMethod] = useState<ShredMethod>("dod3pass");
  const [shredProgress, setShredProgress] = useState<ShredProgress | null>(
    null,
  );

  // ── Drive maintenance state ───────────────────────────────────────────
  const [wipePath, setWipePath] = useState("");
  const [trimPath, setTrimPath] = useState("");
  const [wipeRunning, setWipeRunning] = useState(false);
  const [trimRunning, setTrimRunning] = useState(false);
  const [wipeProgress, setWipeProgress] = useState<WipeProgress | null>(null);
  const [wipeResult, setWipeResult] = useState<WipeFreeSpaceResult | null>(
    null,
  );
  const [trimResult, setTrimResult] = useState<TrimResult | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [showTrimConfirm, setShowTrimConfirm] = useState(false);

  // A cancel request only asks the backend to stop. The operation keeps running until its
  // command returns, so the screen must keep showing it as running until then.
  const [shredCancelling, setShredCancelling] = useState(false);
  const [wipeCancelling, setWipeCancelling] = useState(false);
  const shredCancelRequested = useRef(false);
  const wipeCancelRequested = useRef(false);

  // ── Platform ──────────────────────────────────────────────────────────
  const [isAndroid, setIsAndroid] = useState(false);

  // ── Drag & Drop ───────────────────────────────────────────────────────
  const { isDragging } = useDragDrop((newFiles) => {
    // Files dropped while something is running would be wiped from the list when it ends,
    // and switching tabs would hide the running operation.
    if (isAndroid || shredding || wipeRunning || trimRunning) return;
    setTopTab("shred");
    setDroppedFiles((prev) => [...new Set([...prev, ...newFiles])]);
  });

  // ── Platform detection ────────────────────────────────────────────────
  useEffect(() => {
    try {
      Promise.resolve(platform())
        .then((os) => {
          if (os === "android") setIsAndroid(true);
        })
        .catch(() => {
          /* browser env */
        });
    } catch {
      /* platform() threw synchronously — browser/test environment, ignore */
    }
  }, []);

  // ── Progress listeners ────────────────────────────────────────────────
  useEffect(() => {
    let unlistenShred: UnlistenFn | null = null;
    let unlistenWipe: UnlistenFn | null = null;
    let closed = false;
    async function setup() {
      const shred = await listen<ShredProgress>("shred-progress", (e) =>
        setShredProgress(e.payload),
      );
      // The screen may have been closed while the listener was being set up.
      if (closed) shred();
      else unlistenShred = shred;
      const wipe = await listen<WipeProgress>("wipe-progress", (e) =>
        setWipeProgress(e.payload),
      );
      if (closed) wipe();
      else unlistenWipe = wipe;
    }
    setup();
    return () => {
      closed = true;
      unlistenShred?.();
      unlistenWipe?.();
    };
  }, []);

  // ── Shred handlers ────────────────────────────────────────────────────

  async function handleBrowse() {
    if (isAndroid) return;
    try {
      const selected = await open({
        multiple: true,
        title: "Select files to shred",
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        setDroppedFiles((prev) => [...new Set([...prev, ...paths])]);
      }
    } catch (e) {
      setShredError("Failed to open file dialog: " + e);
    }
  }

  async function handlePreview() {
    if (droppedFiles.length === 0) return;
    setShowPreview(true);
    setShredError(null);
    // Never show the answer for an earlier list while the new one is being worked out.
    setDryRunResult(null);
    try {
      const res = await invoke<DryRunResult>("dry_run_shred", {
        paths: droppedFiles,
      });
      setDryRunResult(res);
      if (res.blocked.length > 0)
        setShredError(
          `${res.blocked.length} file(s) blocked: ${res.blocked.slice(0, 3).join("; ")}${res.blocked.length > 3 ? "…" : ""}`,
        );
    } catch (e) {
      setShredError("Preview failed: " + e);
      setShowPreview(false);
    }
  }

  function handleClear() {
    setDroppedFiles([]);
    setResult(null);
    setShredError(null);
    setShowPreview(false);
    setDryRunResult(null);
  }

  async function executeShred() {
    setShowConfirm(false);
    setShredding(true);
    setShredError(null);
    setResult(null);
    setShredProgress(null);
    setShowPreview(false);
    shredCancelRequested.current = false;
    setShredCancelling(false);
    try {
      const res = await invoke<ShredResult>("batch_shred_files", {
        paths: droppedFiles,
        method,
      });
      setResult(res);
      setDroppedFiles([]);
      if (shredCancelRequested.current)
        setShredError("Shredding cancelled by user");
    } catch (e) {
      setShredError(
        shredCancelRequested.current
          ? "Shredding cancelled by user"
          : "Shredding failed: " + e,
      );
    } finally {
      setShredding(false);
      setShredCancelling(false);
      setShredProgress(null);
    }
  }

  async function cancelShred() {
    if (shredCancelRequested.current) return;
    shredCancelRequested.current = true;
    setShredCancelling(true);
    try {
      await invoke("cancel_shred");
      // Nothing else changes here: the shredding stops when its own command returns.
    } catch (e) {
      console.error("Failed to cancel:", e);
      shredCancelRequested.current = false;
      setShredCancelling(false);
    }
  }

  // ── Drive maintenance handlers ────────────────────────────────────────

  async function executeWipeFreeSpace() {
    setShowWipeConfirm(false);
    setWipeRunning(true);
    setDriveError(null);
    setWipeResult(null);
    setWipeProgress(null);
    wipeCancelRequested.current = false;
    setWipeCancelling(false);
    try {
      const res = await invoke<WipeFreeSpaceResult>("wipe_free_space", {
        drivePath: wipePath.trim(),
      });
      // A wipe that was cancelled did not finish, so it is not shown as complete.
      if (wipeCancelRequested.current)
        setDriveError("Wipe cancelled by user");
      else setWipeResult(res);
    } catch (e) {
      setDriveError(
        wipeCancelRequested.current
          ? "Wipe cancelled by user"
          : "Free-space wipe failed: " + e,
      );
    } finally {
      setWipeRunning(false);
      setWipeCancelling(false);
      setWipeProgress(null);
    }
  }

  async function executeTrim() {
    setShowTrimConfirm(false);
    setTrimRunning(true);
    setDriveError(null);
    setTrimResult(null);
    try {
      const res = await invoke<TrimResult>("trim_drive", {
        drivePath: trimPath.trim(),
      });
      setTrimResult(res);
    } catch (e) {
      // Strip raw PowerShell / fstrim noise down to the first meaningful sentence
      const raw = String(e);
      // A sentence ends at a full stop followed by a space, or at a line break; a dot inside
      // a device name or version number (nvme0n1.1) must not cut the message short.
      const firstSentence = raw
        .split(/\.\s|\.$|\n/)[0]
        .replace(/^TRIM failed:\s*/i, "")
        .trim();
      setDriveError("TRIM failed: " + (firstSentence || raw));
    } finally {
      setTrimRunning(false);
    }
  }

  async function cancelWipe() {
    if (wipeCancelRequested.current) return;
    wipeCancelRequested.current = true;
    setWipeCancelling(true);
    try {
      await invoke("cancel_shred");
      // The wipe stops when its own command returns.
    } catch (e) {
      console.error("Failed to cancel:", e);
      wipeCancelRequested.current = false;
      setWipeCancelling(false);
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────

  const tabLocked = shredding || wipeRunning || trimRunning;

  const methodInfo = {
    simple: {
      name: "Simple (1 pass)",
      icon: Zap,
      time: "Fastest",
      security: "Low",
    },
    dod3pass: {
      name: "DoD 3-Pass",
      icon: Shield,
      time: "Fast",
      security: "High",
    },
    dod7pass: {
      name: "DoD 7-Pass",
      icon: Shield,
      time: "Moderate",
      security: "Very High",
    },
    gutmann: {
      name: "Gutmann (35 pass)",
      icon: Flame,
      time: "Slow",
      security: "Maximum",
    },
  };

  // Ctrl+O adds files to shred, only on the idle shred screen.
  useShortcut("o", handleBrowse, {
    enabled: topTab === "shred" && !shredding && !result && !showPreview && !isAndroid,
  });

  // ── Android guard ─────────────────────────────────────────────────────

  if (isAndroid) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 40,
          textAlign: "center",
        }}
      >
        <div
          style={{
            background: "rgba(239, 68, 68, 0.1)",
            padding: 24,
            borderRadius: "50%",
            marginBottom: 20,
          }}
        >
          <AlertTriangle size={64} color="var(--btn-danger)" />
        </div>
        <h2>Not Available on Android</h2>
        <p style={{ color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 400 }}>
          Secure file shredding requires direct disk access and multiple
          overwrites, which is not supported on Android due to flash memory wear
          leveling and system restrictions.
        </p>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* ── SCROLLABLE CONTENT AREA: shared tool layout, header on top, tabs below it ── */}
      <ToolScroll
        title="Secure Shredder"
        subtitle={
          topTab === "shred"
            ? "Permanently overwrite and destroy sensitive files beyond recovery."
            : "Wipe leftover data from free space, or issue a TRIM command to your SSD."
        }
        tabs={<TabBar active={topTab} locked={tabLocked} onChange={setTopTab} />}
      >

        {/* ══════════════════════════════════════════════════════════════
            TAB A — SHRED FILES
            ════════════════════════════════════════════════════════════ */}
        {topTab === "shred" && (
          <>
            {/* Active shred progress */}
            {shredding && (
              <div style={{ maxWidth: 560, margin: "40px auto 0 auto", width: "100%" }}>
                <ProgressCard
                  title="Shredding Files…"
                  percent={shredProgress ? shredProgress.percentage : 0}
                  onCancel={cancelShred}
                  cancelling={shredCancelling}
                >
                  {shredProgress ? (
                    <>
                      <span data-testid="progress-counter">{`File ${shredProgress.current_file} of ${shredProgress.total_files} · Pass ${shredProgress.current_pass} of ${shredProgress.total_passes}`}</span>
                      <span>{shredProgress.current_file_name}</span>
                      <span data-testid="progress-bytes">{`${formatSize(shredProgress.bytes_processed)} of ${formatSize(shredProgress.total_bytes)} processed`}</span>
                    </>
                  ) : (
                    <span data-testid="progress-starting">Preparing…</span>
                  )}
                </ProgressCard>
              </div>
            )}

            {/* Result screen */}
            {result && (
              <div
                style={{
                  maxWidth: 680,
                  margin: "40px auto 0 auto",
                  width: "100%",
                }}
              >
                <div
                  className="modern-card"
                  style={{ padding: 30, textAlign: "center" }}
                >
                  {(() => {
                    const isFail =
                      result.success.length === 0 && result.failed.length > 0;
                    const isPartial =
                      result.success.length > 0 && result.failed.length > 0;
                    // Nothing shredded and nothing failed (for example a cancel before
                    // the first file): not a success, so do not say "Complete".
                    const isEmpty =
                      result.success.length === 0 && result.failed.length === 0;
                    const color = isFail
                      ? "var(--btn-danger)"
                      : isPartial || isEmpty
                        ? "#f59e0b"
                        : "#4ade80";
                    const Icon =
                      isFail || isPartial || isEmpty ? AlertTriangle : FileX;
                    const title = isFail
                      ? "Shredding Failed"
                      : isPartial
                        ? "Partial Success"
                        : isEmpty
                          ? "Nothing Was Shredded"
                          : "Shredding Complete!";
                    return (
                      <>
                        <Icon
                          size={60}
                          color={color}
                          style={{ marginBottom: 16 }}
                        />
                        <h2 style={{ color, margin: "0 0 20px 0" }}>{title}</h2>
                      </>
                    );
                  })()}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 14,
                      textAlign: "left",
                      marginBottom: result.failed.length > 0 ? 20 : 0,
                    }}
                  >
                    {[
                      {
                        label: "Files Destroyed",
                        value: result.success.length.toString(),
                      },
                      {
                        label: "Data Shredded",
                        value: formatSize(result.total_bytes_shredded),
                      },
                    ].map(({ label, value }) => (
                      <div
                        key={label}
                        style={{
                          background: "var(--bg-color)",
                          borderRadius: 8,
                          padding: "12px 16px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--text-dim)",
                            marginBottom: 4,
                          }}
                        >
                          {label}
                        </div>
                        <div
                          style={{
                            fontSize: "1.5rem",
                            fontWeight: "bold",
                            color:
                              result.success.length > 0
                                ? "#4ade80"
                                : "var(--text-dim)",
                          }}
                        >
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                  {result.failed.length > 0 && (
                    <div
                      style={{
                        background: "rgba(239, 68, 68, 0.08)",
                        border: "1px solid rgba(239, 68, 68, 0.25)",
                        borderRadius: 8,
                        padding: 14,
                        textAlign: "left",
                        marginBottom: 20,
                      }}
                    >
                      <h4
                        style={{
                          margin: "0 0 8px 0",
                          fontSize: "0.875rem",
                          color: "var(--btn-danger)",
                        }}
                      >
                        Failed to shred {result.failed.length} file(s):
                      </h4>
                      <div
                        style={{
                          maxHeight: 140,
                          overflowY: "auto",
                          fontSize: "0.8rem",
                          color: "var(--text-dim)",
                        }}
                      >
                        {result.failed.slice(0, 10).map((fail, i) => (
                          <div
                            key={i}
                            style={{ marginBottom: 7, fontFamily: "monospace" }}
                          >
                            <div style={{ fontWeight: "bold" }}>
                              {fail.path.split(/[/\\]/).pop()}
                            </div>
                            <div
                              style={{ paddingLeft: 10, fontSize: "0.75rem" }}
                            >
                              • {fail.error}
                            </div>
                          </div>
                        ))}
                        {result.failed.length > 10 && (
                          <div style={{ fontStyle: "italic" }}>
                            …and {result.failed.length - 10} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <button className="auth-btn" onClick={handleClear}>
                    Shred More Files
                  </button>
                </div>
              </div>
            )}

            {/* Dry-run preview */}
            {showPreview && dryRunResult && !shredding && !result && (
              <div
                style={{
                  maxWidth: 680,
                  margin: "40px auto 0 auto",
                  width: "100%",
                }}
              >
                <div
                  className="modern-card"
                  style={{ padding: 20, marginBottom: 16 }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 16,
                    }}
                  >
                    <h3 style={{ margin: 0 }}>Preview: Files to be Shredded</h3>
                    <button
                      onClick={() => setShowPreview(false)}
                      className="icon-btn-ghost"
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 12,
                      marginBottom: 14,
                    }}
                  >
                    {[
                      {
                        label: "Total Files",
                        value: dryRunResult.total_file_count,
                      },
                      {
                        label: "Total Size",
                        value: formatSize(dryRunResult.total_size),
                      },
                    ].map(({ label, value }) => (
                      <div
                        key={label}
                        style={{
                          background: "rgba(239, 68, 68, 0.06)",
                          border: "1px solid rgba(239, 68, 68, 0.2)",
                          borderRadius: 8,
                          padding: "10px 14px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--text-dim)",
                          }}
                        >
                          {label}
                        </div>
                        <div
                          style={{
                            fontSize: "1.2rem",
                            fontWeight: "bold",
                            marginTop: 2,
                          }}
                        >
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                  {dryRunResult.warnings.length > 0 && (
                    <div
                      style={{
                        background: "rgba(245, 158, 11, 0.08)",
                        border: "1px solid rgba(245, 158, 11, 0.25)",
                        borderRadius: 8,
                        padding: 12,
                        marginBottom: 14,
                      }}
                    >
                      <h4
                        style={{
                          margin: "0 0 6px 0",
                          fontSize: "0.85rem",
                          color: "#f59e0b",
                        }}
                      >
                        Warnings:
                      </h4>
                      {dryRunResult.warnings.map((w, i) => (
                        <div
                          key={i}
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-dim)",
                            marginBottom: 3,
                          }}
                        >
                          • {w}
                        </div>
                      ))}
                    </div>
                  )}
                  <h4 style={{ margin: "0 0 8px 0", fontSize: "0.875rem" }}>
                    Files ({dryRunResult.files.length}):
                  </h4>
                  <div
                    style={{
                      maxHeight: 260,
                      overflowY: "auto",
                      background: "var(--bg-color)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                    }}
                  >
                    {dryRunResult.files.map((file, i) => (
                      <div
                        key={i}
                        style={{
                          padding: "9px 12px",
                          borderBottom:
                            i < dryRunResult.files.length - 1
                              ? "1px solid var(--border)"
                              : "none",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{ fontSize: "0.85rem", fontWeight: 500 }}
                          >
                            {file.name}
                          </span>
                          <span
                            style={{
                              fontSize: "0.8rem",
                              color: "var(--text-dim)",
                            }}
                          >
                            {formatSize(file.size)}
                          </span>
                        </div>
                        {file.warning && (
                          <div
                            style={{
                              fontSize: "0.75rem",
                              color: "#f59e0b",
                              marginTop: 3,
                            }}
                          >
                            ⚠️ {file.warning}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div
                  style={{ display: "flex", gap: 10, justifyContent: "center" }}
                >
                  <button
                    className="secondary-btn"
                    onClick={() => setShowPreview(false)}
                  >
                    Back
                  </button>
                  <button
                    className="auth-btn danger-btn"
                    onClick={() => setShowConfirm(true)}
                  >
                    <FileX size={15} style={{ marginRight: 7 }} />
                    Confirm & Shred
                  </button>
                </div>
              </div>
            )}

            {/* shredError banner — shown in ALL states so it's visible even during preview */}
            {shredError && (
              <div
                style={{
                  maxWidth: 580,
                  margin: "0 auto 0 auto",
                  width: "100%",
                }}
              >
                <ErrorBanner
                  message={shredError}
                  onDismiss={() => setShredError(null)}
                />
              </div>
            )}

            {/* Idle state: hero + drop zone + method selector
                Uses flex: 1 + justify-content: center to fill remaining space
                and vertically center content, without affecting the tab bar above. */}
            {!shredding && !result && !showPreview && (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent:
                    droppedFiles.length === 0 ? "center" : "flex-start",
                  paddingTop: droppedFiles.length === 0 ? 0 : 30,
                }}
              >
                {/* Drop zone */}
                {droppedFiles.length === 0 ? (
                  <div style={{ width: "100%", maxWidth: 580, margin: "0 auto 20px auto" }}>
                    <DropZone
                      icon={<FileX size={48} />}
                      hue="var(--hue-clean)"
                      title="Drop files here or click to browse."
                      description="Shredded files are overwritten and cannot be recovered."
                      buttonLabel="Select Files"
                      onBrowse={handleBrowse}
                      active={isDragging}
                    />
                  </div>
                ) : (
                <div
                  className={`shred-zone ${isDragging ? "active" : ""}`}
                  style={{
                    borderColor: "var(--accent)",
                    width: "100%",
                    maxWidth: 580,
                    margin: "0 auto 20px auto",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                    <div style={{ width: "100%", textAlign: "left" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 12,
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: "1rem" }}>
                          {droppedFiles.length}{" "}
                          {droppedFiles.length === 1 ? "File" : "Files"}{" "}
                          Selected
                        </span>
                        <button
                          className="icon-btn-ghost"
                          onClick={handleClear}
                          style={{ fontSize: "0.8rem" }}
                        >
                          Clear All
                        </button>
                      </div>
                      <div
                        style={{
                          maxHeight: 180,
                          overflowY: "auto",
                          marginBottom: 14,
                        }}
                      >
                        {droppedFiles.map((f, i) => (
                          <div
                            key={i}
                            style={{
                              display: "flex",
                              gap: 9,
                              alignItems: "center",
                              fontSize: "0.875rem",
                              padding: "7px 10px",
                              background: "var(--bg-card)",
                              border: "1px solid var(--border)",
                              borderRadius: 6,
                              marginBottom: 4,
                            }}
                          >
                            <File
                              size={14}
                              style={{
                                flexShrink: 0,
                                color: "var(--text-dim)",
                              }}
                            />
                            <span
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                flex: 1,
                              }}
                            >
                              {f.split(/[/\\]/).pop()}
                            </span>
                            <X
                              size={14}
                              style={{
                                cursor: "pointer",
                                color: "var(--text-dim)",
                                flexShrink: 0,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setDroppedFiles((prev) =>
                                  prev.filter((p) => p !== f),
                                );
                              }}
                            />
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="secondary-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleBrowse();
                          }}
                          style={{ flex: 1 }}
                        >
                          Add More
                        </button>
                        <button
                          className="secondary-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePreview();
                          }}
                          style={{
                            flex: 1,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 6,
                          }}
                        >
                          <Eye size={14} /> Preview
                        </button>
                      </div>
                    </div>
                </div>
                )}

                {/* Method selector — visible once files are loaded */}
                {droppedFiles.length > 0 && (
                  <div
                    style={{ maxWidth: 580, margin: "0 auto", width: "100%" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        marginBottom: 10,
                      }}
                    >
                      <Shield size={15} />
                      <h4 style={{ margin: 0, fontSize: "0.875rem" }}>
                        Shredding Method
                      </h4>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(2, 1fr)",
                        gap: 8,
                      }}
                    >
                      {(Object.keys(methodInfo) as ShredMethod[]).map((m) => {
                        const info = methodInfo[m];
                        const Icon = info.icon;
                        const active = method === m;
                        return (
                          <div
                            key={m}
                            onClick={() => setMethod(m)}
                            style={{
                              padding: 12,
                              border: `2px solid ${active ? "var(--accent)" : "var(--border)"}`,
                              borderRadius: 8,
                              cursor: "pointer",
                              background: active
                                ? "rgba(0, 122, 204, 0.05)"
                                : "var(--bg-card)",
                              transition:
                                "border-color 0.15s, background 0.15s",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                marginBottom: 4,
                              }}
                            >
                              <Icon size={14} />
                              <span
                                style={{ fontWeight: 600, fontSize: "0.83rem" }}
                              >
                                {info.name}
                              </span>
                            </div>
                            <div
                              style={{
                                fontSize: "0.73rem",
                                color: "var(--text-dim)",
                              }}
                            >
                              {info.time} · {info.security} Security
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <InfoBox>
                        <strong>Recommended:</strong> DoD 3-Pass provides
                        excellent security with reasonable speed.{" "}
                        <strong>WARNING:</strong> Multi-pass overwriting
                        (especially Gutmann) is ineffective on SSDs and causes
                        unnecessary wear — it was designed for magnetic platters
                        only.
                      </InfoBox>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════
            TAB B — DRIVE MAINTENANCE
            Two side-by-side cards; no nested tabs.
            ════════════════════════════════════════════════════════════ */}
        {topTab === "drive" && (
          <>
            {driveError && (
              <ErrorBanner
                message={driveError}
                onDismiss={() => setDriveError(null)}
              />
            )}

            <div
              style={{
                maxWidth: 860,
                margin: "0 auto",
                width: "100%",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                gap: 20,
                alignItems: "start",
              }}
            >
              {/* Card 1: Wipe Free Space */}
              <div
                className="modern-card"
                style={{
                  padding: 24,
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      background: "rgba(0, 122, 204, 0.08)",
                      padding: 8,
                      borderRadius: 8,
                      display: "flex",
                    }}
                  >
                    <Trash2 size={18} color="var(--accent)" />
                  </div>
                  <div>
                    <h3 style={{ margin: "0 0 3px 0", fontSize: "1rem" }}>
                      Wipe Free Space
                    </h3>
                    <span
                      style={{
                        fontSize: "0.7rem",
                        background: "rgba(0, 122, 204, 0.1)",
                        color: "var(--accent)",
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontWeight: 600,
                        letterSpacing: "0.03em",
                      }}
                    >
                      HDD
                    </span>
                  </div>
                </div>
                <InfoBox>
                  Fills unallocated space with zeros to overwrite deleted file
                  remnants. <strong>Effective on HDDs only.</strong> On SSDs,
                  wear-leveling redirects writes and may retain traces
                  regardless of wiping — use the TRIM Drive card instead for
                  SSDs, or better yet, full-disk encryption with key destruction
                  for guaranteed erasure.
                </InfoBox>
                {wipeRunning ? (
                  <div style={{ textAlign: "center", padding: "6px 0" }}>
                    <Loader2
                      size={38}
                      className="spinner"
                      style={{ marginBottom: 10, color: "var(--accent)" }}
                    />
                    <p
                      data-testid="wipe-phase"
                      style={{ fontWeight: 600, margin: "0 0 4px 0" }}
                    >{`${wipeProgress?.phase ?? "Starting"}…`}</p>
                    {wipeProgress && (
                      <p
                        style={{
                          color: "var(--text-dim)",
                          fontSize: "0.83rem",
                          margin: "0 0 4px 0",
                        }}
                      >
                        {formatSize(wipeProgress.bytes_written)} written
                      </p>
                    )}
                    <p
                      style={{
                        color: "var(--text-dim)",
                        fontSize: "0.73rem",
                        margin: "0 0 14px 0",
                      }}
                    >
                      Drive will appear full until the operation completes.
                    </p>
                    <button
                      className="secondary-btn"
                      onClick={cancelWipe}
                      disabled={wipeCancelling}
                    >
                      {wipeCancelling ? "Cancelling…" : "Cancel"}
                    </button>
                  </div>
                ) : wipeResult ? (
                  <div style={{ textAlign: "center", padding: "6px 0" }}>
                    <CheckCircle
                      size={42}
                      color="#4ade80"
                      style={{ marginBottom: 10 }}
                    />
                    <h4 style={{ color: "#4ade80", margin: "0 0 6px 0" }}>
                      Wipe Complete
                    </h4>
                    <p
                      style={{
                        color: "var(--text-dim)",
                        fontSize: "0.85rem",
                        margin: "0 0 14px 0",
                      }}
                    >
                      {formatSize(wipeResult.bytes_wiped)} wiped on{" "}
                      <code>{wipeResult.target_path}</code>
                    </p>
                    <button
                      className="secondary-btn"
                      onClick={() => setWipeResult(null)}
                    >
                      Run Again
                    </button>
                  </div>
                ) : (
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "0.83rem",
                        fontWeight: 500,
                        marginBottom: 6,
                      }}
                    >
                      Drive or folder path
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="text"
                        value={wipePath}
                        onChange={(e) => setWipePath(e.target.value)}
                        placeholder="e.g. /home  or  C:\\"
                        style={{
                          flex: 1,
                          padding: "8px 11px",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: "var(--bg-card)",
                          color: "var(--text-main)",
                          fontSize: "0.85rem",
                        }}
                      />
                      <button
                        className="auth-btn"
                        onClick={() => {
                          const p = wipePath.trim();
                          if (!p) {
                            setDriveError(
                              "Please enter a drive or folder path.",
                            );
                            return;
                          }
                          // Windows drive roots: C:\, D:/, C: etc.
                          const isWindowsDriveRoot = /^[a-zA-Z]:[/\\]?$/.test(
                            p,
                          );
                          // Unix root or common system paths. Trailing slashes
                          // ("/etc/") name the same folder, so ignore them.
                          const unixPath = p.replace(/\/+$/, "") || "/";
                          const isUnixSystemPath =
                            /^(\/|\/etc|\/bin|\/sbin|\/usr|\/boot|\/var|\/sys|\/proc|\/dev)$/.test(
                              unixPath,
                            );
                          if (isWindowsDriveRoot || isUnixSystemPath) {
                            setDriveError(
                              "Free-space wipe is not supported on system drives or root paths. " +
                                "It is also ineffective on SSDs due to wear-leveling — " +
                                "use the TRIM card instead, or target a specific non-system folder.",
                            );
                            return;
                          }
                          setShowWipeConfirm(true);
                        }}
                        style={{ whiteSpace: "nowrap" }}
                      >
                        Wipe
                      </button>
                    </div>
                    <p
                      style={{
                        fontSize: "0.73rem",
                        color: "var(--text-dim)",
                        margin: "7px 0 0 0",
                      }}
                    >
                      The drive will appear full briefly — this is normal.
                    </p>
                  </div>
                )}
              </div>

              {/* Card 2: SSD TRIM */}
              <div
                className="modern-card"
                style={{
                  padding: 24,
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      background: "rgba(0, 122, 204, 0.08)",
                      padding: 8,
                      borderRadius: 8,
                      display: "flex",
                    }}
                  >
                    <RefreshCw size={18} color="var(--accent)" />
                  </div>
                  <div>
                    <h3 style={{ margin: "0 0 3px 0", fontSize: "1rem" }}>
                      TRIM Drive
                    </h3>
                    <span
                      style={{
                        fontSize: "0.7rem",
                        background: "rgba(0, 122, 204, 0.1)",
                        color: "var(--accent)",
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontWeight: 600,
                        letterSpacing: "0.03em",
                      }}
                    >
                      SSD
                    </span>
                  </div>
                </div>
                <InfoBox>
                  TRIM tells the SSD controller which blocks are free to erase,
                  improving future write speed. It does <strong>not</strong>{" "}
                  guarantee forensic-level erasure. For true SSD data
                  destruction, use full-disk encryption and discard the key.{" "}
                  <strong>Linux:</strong> requires root.{" "}
                  <strong>Windows:</strong> requires Administrator.{" "}
                  <strong>macOS:</strong> TRIM is managed automatically.
                </InfoBox>
                {trimRunning ? (
                  <div style={{ textAlign: "center", padding: "6px 0" }}>
                    <RefreshCw
                      size={38}
                      className="spinner"
                      style={{ marginBottom: 10, color: "var(--accent)" }}
                    />
                    <p style={{ fontWeight: 600, margin: "0 0 4px 0" }}>
                      Running TRIM…
                    </p>
                    <p
                      style={{
                        color: "var(--text-dim)",
                        fontSize: "0.83rem",
                        margin: 0,
                      }}
                    >
                      This may take a moment on large drives.
                    </p>
                  </div>
                ) : trimResult ? (
                  <div style={{ textAlign: "center", padding: "6px 0" }}>
                    {trimResult.success ? (
                      <CheckCircle
                        size={42}
                        color="#4ade80"
                        style={{ marginBottom: 10 }}
                      />
                    ) : (
                      <AlertTriangle
                        size={42}
                        color="var(--btn-danger)"
                        style={{ marginBottom: 10 }}
                      />
                    )}
                    <h4
                      style={{
                        color: trimResult.success
                          ? "#4ade80"
                          : "var(--btn-danger)",
                        margin: "0 0 6px 0",
                      }}
                    >
                      {trimResult.success ? "TRIM Complete" : "TRIM Failed"}
                    </h4>
                    <p
                      style={{
                        color: "var(--text-dim)",
                        fontSize: "0.83rem",
                        margin: "0 0 14px 0",
                        lineHeight: 1.5,
                      }}
                    >
                      {trimResult.message}
                    </p>
                    <button
                      className="secondary-btn"
                      onClick={() => setTrimResult(null)}
                    >
                      Run Again
                    </button>
                  </div>
                ) : (
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "0.83rem",
                        fontWeight: 500,
                        marginBottom: 6,
                      }}
                    >
                      Drive letter (Windows) or mount point (Linux / macOS)
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="text"
                        value={trimPath}
                        onChange={(e) => setTrimPath(e.target.value)}
                        placeholder="e.g. /  or  C"
                        style={{
                          flex: 1,
                          padding: "8px 11px",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: "var(--bg-card)",
                          color: "var(--text-main)",
                          fontSize: "0.85rem",
                        }}
                      />
                      <button
                        className="auth-btn"
                        onClick={() => {
                          if (trimPath.trim()) setShowTrimConfirm(true);
                          else
                            setDriveError(
                              "Please enter a drive letter or mount point.",
                            );
                        }}
                        style={{ whiteSpace: "nowrap" }}
                      >
                        Run TRIM
                      </button>
                    </div>
                    <p
                      style={{
                        fontSize: "0.73rem",
                        color: "var(--text-dim)",
                        margin: "7px 0 0 0",
                      }}
                    >
                      Windows: drive letter only, e.g. <code>C</code>. Linux /
                      macOS: mount point, e.g. <code>/</code> or{" "}
                      <code>/home</code>.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </ToolScroll>

      {/* ── SHRED FOOTER ─────────────────────────────────────────────────── */}
      {topTab === "shred" &&
        droppedFiles.length > 0 &&
        !shredding &&
        !result &&
        !showPreview && (
          <div
            style={{
              borderTop: "1px solid var(--border)",
              background: "var(--panel-bg)",
              padding: "14px 20px",
              display: "flex",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <button
              className="auth-btn danger-btn"
              onClick={() => setShowConfirm(true)}
              style={{
                width: "100%",
                maxWidth: 280,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 9,
              }}
            >
              <FileX size={17} />
              Shred {droppedFiles.length} File
              {droppedFiles.length !== 1 ? "s" : ""}
            </button>
          </div>
        )}

      {/* ══════════════════════════════════════════════════════════════════
          MODALS
          ════════════════════════════════════════════════════════════════ */}

      {showConfirm && (
        <div className="modal-overlay" style={{ zIndex: 100000 }}>
          <div
            className="auth-card"
            data-testid="shred-confirm-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <Trash2 size={20} color="var(--btn-danger)" />
              <h2 style={{ color: "var(--btn-danger)" }}>
                Confirm Permanent Deletion
              </h2>
              <div style={{ flex: 1 }} />
              <X
                size={20}
                style={{ cursor: "pointer" }}
                onClick={() => setShowConfirm(false)}
              />
            </div>
            <div className="modal-body" style={{ textAlign: "center" }}>
              <p
                style={{
                  fontSize: "1.05rem",
                  fontWeight: "bold",
                  color: "var(--text-main)",
                }}
              >
                Permanently destroy {droppedFiles.length}{" "}
                {droppedFiles.length === 1 ? "file" : "files"}?
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  marginTop: -8,
                  marginBottom: 18,
                }}
              >
                Using {methodInfo[method].name} method. This action cannot be
                undone.
              </p>
              <div
                style={{
                  background: "rgba(239, 68, 68, 0.08)",
                  border: "1px solid rgba(239, 68, 68, 0.25)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 20,
                  textAlign: "left",
                  fontSize: "0.85rem",
                }}
              >
                <strong>⚠️ Warning:</strong>{" "}
                {`Files will be overwritten ${method === "gutmann" ? "35" : method === "dod7pass" ? "7" : method === "dod3pass" ? "3" : "1"} time(s) before deletion. Recovery will be impossible.`}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn danger-btn"
                  style={{ flex: 1 }}
                  onClick={executeShred}
                >
                  Yes, Shred Forever
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showWipeConfirm && (
        <div className="modal-overlay" style={{ zIndex: 100000 }}>
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <HardDrive size={20} color="var(--btn-danger)" />
              <h2>Confirm Free Space Wipe</h2>
              <div style={{ flex: 1 }} />
              <X
                size={20}
                style={{ cursor: "pointer" }}
                onClick={() => setShowWipeConfirm(false)}
              />
            </div>
            <div className="modal-body" style={{ textAlign: "center" }}>
              <p
                style={{
                  fontSize: "0.95rem",
                  color: "var(--text-main)",
                  marginBottom: 10,
                }}
              >
                Wipe all unallocated space on:
              </p>
              <code
                style={{
                  display: "block",
                  padding: "8px 12px",
                  background: "var(--bg-color)",
                  borderRadius: 6,
                  marginBottom: 16,
                  wordBreak: "break-all",
                }}
              >
                {wipePath}
              </code>
              <div
                style={{
                  background: "rgba(245, 158, 11, 0.08)",
                  border: "1px solid rgba(245, 158, 11, 0.25)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 20,
                  textAlign: "left",
                  fontSize: "0.82rem",
                  color: "var(--text-dim)",
                }}
              >
                ⚠️ The drive will appear completely full during the operation.
                Do not unplug the drive or shut down the system until it
                completes.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowWipeConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn"
                  style={{ flex: 1 }}
                  onClick={executeWipeFreeSpace}
                >
                  Yes, Wipe Free Space
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showTrimConfirm && (
        <div className="modal-overlay" style={{ zIndex: 100000 }}>
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <RefreshCw size={20} color="var(--accent)" />
              <h2>Confirm TRIM</h2>
              <div style={{ flex: 1 }} />
              <X
                size={20}
                style={{ cursor: "pointer" }}
                onClick={() => setShowTrimConfirm(false)}
              />
            </div>
            <div className="modal-body" style={{ textAlign: "center" }}>
              <p
                style={{
                  fontSize: "0.95rem",
                  color: "var(--text-main)",
                  marginBottom: 10,
                }}
              >
                Run TRIM on:
              </p>
              <code
                style={{
                  display: "block",
                  padding: "8px 12px",
                  background: "var(--bg-color)",
                  borderRadius: 6,
                  marginBottom: 16,
                }}
              >
                {trimPath}
              </code>
              <div
                style={{
                  background: "rgba(59, 130, 246, 0.06)",
                  border: "1px solid rgba(59, 130, 246, 0.2)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 20,
                  textAlign: "left",
                  fontSize: "0.82rem",
                  color: "var(--text-dim)",
                }}
              >
                ℹ️ TRIM improves SSD performance but does not guarantee data
                destruction. Administrator / root privileges may be required.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowTrimConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn"
                  style={{ flex: 1 }}
                  onClick={executeTrim}
                >
                  Yes, Run TRIM
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
