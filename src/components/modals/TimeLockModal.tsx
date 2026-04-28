// --- START OF FILE src/components/modals/TimeLockModal.tsx ---

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Lock, Clock, X, CalendarClock, CheckCircle2 } from "lucide-react";

// ==========================================
// --- TYPES ---
// ==========================================

interface TimeLockModalProps {
  filePath: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

interface BatchItemResult {
  name: string;
  success: boolean;
  message: string;
}

const MIN_DURATION_SECS = 60;
const MAX_DURATION_SECS = 50 * 365 * 24 * 3600;

const PRESETS: { label: string; secs: number }[] = [
  { label: "1 Hour", secs: 3600 },
  { label: "1 Day", secs: 86400 },
  { label: "1 Week", secs: 7 * 86400 },
  { label: "1 Month", secs: 30 * 86400 },
  { label: "1 Year", secs: 365 * 86400 },
];

// ==========================================
// --- HELPERS ---
// ==========================================

function getMinDatetimeLocal(): string {
  return new Date(Date.now() + MIN_DURATION_SECS * 1000)
    .toISOString()
    .slice(0, 16);
}

function getMaxDatetimeLocal(): string {
  return new Date(Date.now() + MAX_DURATION_SECS * 1000)
    .toISOString()
    .slice(0, 16);
}

function formatUnlockDate(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function datetimeLocalToUnix(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return isNaN(ms) ? null : Math.floor(ms / 1000);
}

function formatRemainingFromNow(unixSecs: number): string {
  const secs = unixSecs - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "immediately";
  if (secs < 3600) {
    const m = Math.round(secs / 60);
    return `${m} minute${m !== 1 ? "s" : ""}`;
  }
  if (secs < 86400) {
    const h = Math.round(secs / 3600);
    return `${h} hour${h !== 1 ? "s" : ""}`;
  }
  const d = Math.round(secs / 86400);
  return `${d} day${d !== 1 ? "s" : ""}`;
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

// ==========================================
// --- COMPONENT ---
// ==========================================

export function TimeLockModal({
  filePath,
  onClose,
  onSuccess,
}: TimeLockModalProps) {
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  const [customDatetime, setCustomDatetime] = useState<string>("");
  const [resolvedUnixTs, setResolvedUnixTs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const filename = basename(filePath);

  // Recalculate resolved timestamp whenever selection changes
  useEffect(() => {
    if (selectedPreset !== null) {
      setResolvedUnixTs(Math.floor(Date.now() / 1000) + selectedPreset);
    } else if (customDatetime) {
      setResolvedUnixTs(datetimeLocalToUnix(customDatetime));
    } else {
      setResolvedUnixTs(null);
    }
  }, [selectedPreset, customDatetime]);

  // Focus trap
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [loading, onClose]);

  function handlePresetClick(secs: number) {
    setSelectedPreset(secs);
    setCustomDatetime("");
    setError(null);
  }

  function handleCustomDatetimeChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCustomDatetime(e.target.value);
    setSelectedPreset(null);
    setError(null);
  }

  async function handleConfirm() {
    if (resolvedUnixTs === null) {
      setError("Please select a date and time.");
      return;
    }
    const nowSecs = Math.floor(Date.now() / 1000);
    if (resolvedUnixTs < nowSecs + MIN_DURATION_SECS) {
      setError("Unlock time must be at least 1 minute in the future.");
      return;
    }
    if (resolvedUnixTs > nowSecs + MAX_DURATION_SECS) {
      setError("Unlock time cannot exceed 50 years from now.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await invoke<BatchItemResult>("lock_file_with_timelock", {
        filePath,
        unlockAt: resolvedUnixTs,
        compressionMode: "auto",
      });

      if (result.success) {
        onSuccess(result.message);
      } else {
        setError(result.message);
      }
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }

  const canConfirm = resolvedUnixTs !== null && !loading;

  // ==========================================
  // --- STYLES (self-contained, no parent CSS dependency) ---
  // ==========================================

  // Overlay: fixed fullscreen with flex centering — immune to parent stacking context
  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 100020,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.65)",
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    padding: "20px",
  };

  const boxStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    maxWidth: "480px",
    background: "var(--bg-card, #1a1a2e)",
    border: "1px solid var(--border, rgba(255,255,255,0.1))",
    borderRadius: "12px",
    boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    maxHeight: "calc(100vh - 40px)",
    overflowY: "auto",
  };

  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "18px 20px 16px",
    borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))",
    flexShrink: 0,
  };

  const bodyStyle: React.CSSProperties = {
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: "0.72rem",
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--text-dim, #888)",
    marginBottom: "8px",
  };

  const presetRowStyle: React.CSSProperties = {
    display: "flex",
    gap: "6px",
    flexWrap: "wrap",
  };

  const getPresetBtnStyle = (active: boolean): React.CSSProperties => ({
    height: "32px",
    padding: "0 14px",
    fontSize: "0.82rem",
    fontWeight: 500,
    borderRadius: "6px",
    border: active
      ? "1px solid var(--accent, #4f8ef7)"
      : "1px solid var(--border, rgba(255,255,255,0.1))",
    background: active
      ? "var(--accent, #4f8ef7)"
      : "var(--bg-color, rgba(255,255,255,0.04))",
    color: active ? "#fff" : "var(--text-main, #ccc)",
    cursor: "pointer",
    transition: "all 0.15s",
    whiteSpace: "nowrap",
  });

  const customRowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  };

  const inputStyle: React.CSSProperties = {
    flex: 1,
    height: "38px",
    background: "var(--bg-color, rgba(255,255,255,0.04))",
    border: "1px solid var(--border, rgba(255,255,255,0.1))",
    borderRadius: "8px",
    color: "var(--text-main, #ccc)",
    padding: "0 12px",
    fontSize: "0.9rem",
    colorScheme: "dark",
    outline: "none",
  };

  const summaryBoxStyle: React.CSSProperties = {
    background: "rgba(var(--accent-rgb, 79,142,247), 0.07)",
    border: "1px solid rgba(var(--accent-rgb, 79,142,247), 0.22)",
    borderRadius: "8px",
    padding: "12px 14px",
    display: "flex",
    gap: "10px",
    alignItems: "flex-start",
  };

  const errorBoxStyle: React.CSSProperties = {
    background: "rgba(220,50,50,0.07)",
    border: "1px solid rgba(220,50,50,0.2)",
    borderRadius: "6px",
    padding: "10px 12px",
    color: "var(--btn-danger, #e05a5a)",
    fontSize: "0.85rem",
  };

  const footerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: "10px",
    padding: "14px 20px",
    borderTop: "1px solid var(--border, rgba(255,255,255,0.08))",
    flexShrink: 0,
  };

  const cancelBtnStyle: React.CSSProperties = {
    height: "38px",
    padding: "0 18px",
    borderRadius: "8px",
    border: "1px solid var(--border, rgba(255,255,255,0.1))",
    background: "transparent",
    color: "var(--text-main, #ccc)",
    fontSize: "0.9rem",
    cursor: "pointer",
  };

  const confirmBtnStyle: React.CSSProperties = {
    height: "38px",
    padding: "0 20px",
    borderRadius: "8px",
    border: "none",
    background: canConfirm ? "var(--accent, #4f8ef7)" : "rgba(79,142,247,0.3)",
    color: "#fff",
    fontSize: "0.9rem",
    fontWeight: 600,
    cursor: canConfirm ? "pointer" : "default",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    transition: "all 0.15s",
  };

  const spinnerStyle: React.CSSProperties = {
    width: "14px",
    height: "14px",
    border: "2px solid rgba(255,255,255,0.3)",
    borderTop: "2px solid white",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  };

  return (
    <>
      {/* Inject spinner keyframes once */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Fullscreen overlay — click outside to close */}
      <div style={overlayStyle} onClick={!loading ? onClose : undefined}>
        {/* Modal box — stop click propagation */}
        <div
          ref={modalRef}
          style={boxStyle}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tl-modal-title"
        >
          {/* ── HEADER ── */}
          <div style={headerStyle}>
            <CalendarClock size={19} color="var(--accent, #4f8ef7)" />
            <span
              id="tl-modal-title"
              style={{
                fontSize: "1rem",
                fontWeight: 600,
                flex: 1,
                color: "var(--text-main, #eee)",
              }}
            >
              Time-Lock Encryption
            </span>
            <button
              onClick={onClose}
              disabled={loading}
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                cursor: loading ? "default" : "pointer",
                color: "var(--text-dim, #888)",
                padding: "4px",
                display: "flex",
                alignItems: "center",
                borderRadius: "4px",
              }}
            >
              <X size={17} />
            </button>
          </div>

          {/* ── BODY ── */}
          <div style={bodyStyle}>
            {/* File label */}
            <div
              style={{
                background: "var(--bg-color, rgba(255,255,255,0.03))",
                border: "1px solid var(--border, rgba(255,255,255,0.08))",
                borderRadius: "7px",
                padding: "8px 12px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <Lock
                size={13}
                color="var(--accent, #4f8ef7)"
                style={{ flexShrink: 0 }}
              />
              <span
                style={{
                  fontSize: "0.85rem",
                  color: "var(--text-dim, #999)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={filePath}
              >
                {filename}
              </span>
            </div>

            {/* Quick presets */}
            <div>
              <p style={sectionLabelStyle}>Quick Presets</p>
              <div style={presetRowStyle}>
                {PRESETS.map((p) => (
                  <button
                    key={p.secs}
                    style={getPresetBtnStyle(selectedPreset === p.secs)}
                    onClick={() => handlePresetClick(p.secs)}
                    disabled={loading}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom datetime */}
            <div>
              <p style={sectionLabelStyle}>Custom Date &amp; Time</p>
              <div style={customRowStyle}>
                <Clock
                  size={15}
                  color="var(--text-dim, #888)"
                  style={{ flexShrink: 0 }}
                />
                <input
                  type="datetime-local"
                  style={inputStyle}
                  value={customDatetime}
                  min={getMinDatetimeLocal()}
                  max={getMaxDatetimeLocal()}
                  onChange={handleCustomDatetimeChange}
                  disabled={loading}
                  aria-label="Custom unlock date and time"
                />
              </div>
            </div>

            {/* Resolved summary */}
            {resolvedUnixTs !== null && (
              <div style={summaryBoxStyle}>
                <CheckCircle2
                  size={15}
                  color="var(--accent, #4f8ef7)"
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "0.875rem",
                      fontWeight: 500,
                      color: "var(--text-main, #eee)",
                    }}
                  >
                    Unlocks in {formatRemainingFromNow(resolvedUnixTs)}
                  </p>
                  <p
                    style={{
                      margin: "3px 0 0",
                      fontSize: "0.78rem",
                      color: "var(--text-dim, #999)",
                    }}
                  >
                    {formatUnlockDate(resolvedUnixTs)}
                  </p>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={errorBoxStyle} role="alert">
                {error}
              </div>
            )}
          </div>
          {/* end body */}

          {/* ── FOOTER ── */}
          <div style={footerStyle}>
            <button style={cancelBtnStyle} onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button
              style={confirmBtnStyle}
              onClick={handleConfirm}
              disabled={!canConfirm}
              aria-busy={loading}
            >
              {loading ? (
                <>
                  <span style={spinnerStyle} />
                  Locking…
                </>
              ) : (
                <>
                  <Lock size={14} />
                  Lock File
                </>
              )}
            </button>
          </div>
        </div>
        {/* end modal box */}
      </div>
      {/* end overlay */}
    </>
  );
}

// --- END OF FILE src/components/modals/TimeLockModal.tsx ---
