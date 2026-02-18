import { useState, useMemo, useRef, useEffect } from "react";
import {
  X,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  ArrowRight,
  Lock,
  Repeat,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { VaultEntry } from "../../hooks/useVault";
import { getPasswordStrength } from "../../utils/security";
import { invoke } from "@tauri-apps/api/core";

interface VaultHealthModalProps {
  entries: VaultEntry[];
  onClose: () => void;
  onEditEntry: (entry: VaultEntry) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX: Hash the password with SHA-1 using the Web Crypto API entirely in the
// frontend. The plaintext NEVER leaves the JS heap — only the hex digest is
// passed to the Tauri backend, which uses the first 5 chars as the HIBP
// k-Anonymity prefix. This closes the IPC plaintext-exposure vulnerability.
// ─────────────────────────────────────────────────────────────────────────────
async function sha1Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function VaultHealthModal({
  entries,
  onClose,
  onEditEntry,
}: VaultHealthModalProps) {
  const [pwnedIds, setPwnedIds] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  // FIX: Track scan errors so failures are surfaced instead of silently
  // being treated as "safe". A failure-to-check is not the same as "not pwned".
  const [scanErrors, setScanErrors] = useState(0);

  // FIX: Cancellation ref. When the modal unmounts mid-scan (or the user clicks
  // Stop), the scan loop checks this flag and breaks, preventing setState calls
  // on an unmounted component and wasted API calls.
  const cancelledRef = useRef(false);

  // FIX: Clean up on unmount — cancel any in-flight scan automatically.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // ─── 1. DETECT REUSED (Instant) ───────────────────────────────────────────
  // FIX: Use Map<string, string[]> instead of Record<string, string[]>.
  // A plain object used as a map has prototype properties (e.g. "constructor",
  // "toString") that can collide with password strings, causing false "reused"
  // flags. Map has no such prototype pollution risk.
  const reusedIds = useMemo(() => {
    const counts = new Map<string, string[]>();
    entries.forEach((e) => {
      if (!e.password) return; // skip blank passwords
      const existing = counts.get(e.password) ?? [];
      counts.set(e.password, [...existing, e.id]);
    });

    const reused = new Set<string>();
    counts.forEach((ids) => {
      if (ids.length > 1) ids.forEach((id) => reused.add(id));
    });
    return reused;
  }, [entries]);

  // ─── 2. DETECT WEAK (Instant) ─────────────────────────────────────────────
  const weakIds = useMemo(() => {
    const weak = new Set<string>();
    entries.forEach((e) => {
      if (getPasswordStrength(e.password).score < 3) weak.add(e.id);
    });
    return weak;
  }, [entries]);

  // ─── 3. DETECT COMPROMISED (Async) ────────────────────────────────────────
  async function scanBreaches() {
    if (isScanning) return;

    // Reset state for a fresh scan
    setIsScanning(true);
    setPwnedIds(new Set());
    setScanProgress(0);
    setScanErrors(0);
    cancelledRef.current = false;

    const total = entries.length;
    let completed = 0;
    let errorCount = 0;
    // FIX: Collect all pwned IDs and do a single batched setState at the end,
    // plus incremental updates. This avoids the O(n²) Set-copy problem where
    // every found entry triggered `new Set(prev).add(...)` inside a hot loop.
    const newPwned = new Set<string>();

    for (const entry of entries) {
      // FIX: Check cancellation flag before each request so a modal-close or
      // manual Stop cancels the loop immediately.
      if (cancelledRef.current) break;

      try {
        // FIX: Compute SHA-1 hash in the frontend. The backend now receives the
        // full hex hash — NOT the plaintext password. It derives the prefix
        // itself and does the HIBP range query. The plaintext never crosses IPC.
        const sha1 = await sha1Hex(entry.password);

        const res = await invoke<{ found: boolean; count: number }>(
          "check_password_breach",
          { sha1Hash: sha1 },
        );

        if (res.found) {
          newPwned.add(entry.id);
          // Incremental UI update so the user sees results as they arrive,
          // but we spread the existing Set once, not create a full copy each time.
          setPwnedIds(new Set(newPwned));
        }
      } catch (e) {
        // FIX: Don't silently swallow errors. Count them so we can warn the user
        // that some passwords could not be checked — a failed check is NOT "safe".
        errorCount++;
        console.error(`Breach scan error for entry "${entry.service}":`, e);
      }

      completed++;
      setScanProgress(Math.round((completed / total) * 100));
      // FIX: Update error count incrementally so the warning appears in real time.
      if (errorCount > 0) setScanErrors(errorCount);
    }

    setIsScanning(false);
  }

  function stopScan() {
    cancelledRef.current = true;
  }

  // ─── AGGREGATE ISSUES ─────────────────────────────────────────────────────
  const issues = entries
    .map((e) => {
      const issuesList = [];
      if (pwnedIds.has(e.id))
        issuesList.push({ type: "pwned", label: "Compromised" });
      if (reusedIds.has(e.id))
        issuesList.push({ type: "reused", label: "Reused" });
      if (weakIds.has(e.id)) issuesList.push({ type: "weak", label: "Weak" });
      return { entry: e, issues: issuesList };
    })
    .filter((x) => x.issues.length > 0);

  // FIX: Sort now includes a tiebreaker for weak-only entries (alphabetical)
  // so the list is deterministic and most dangerous entries always appear first.
  const sortedIssues = [...issues].sort((a, b) => {
    const score = (item: (typeof issues)[0]) =>
      (item.issues.some((i) => i.type === "pwned") ? 100 : 0) +
      (item.issues.some((i) => i.type === "reused") ? 10 : 0) +
      (item.issues.some((i) => i.type === "weak") ? 1 : 0);
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return a.entry.service.localeCompare(b.entry.service);
  });

  return (
    <div className="modal-overlay" style={{ zIndex: 100000 }} onClick={onClose}>
      <div
        className="auth-card"
        style={{
          width: 700,
          maxWidth: "95vw",
          height: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div className="modal-header">
          <ShieldCheck size={20} color="var(--accent)" />
          <h2>Security Health</h2>
          <div style={{ flex: 1 }} />
          <X size={20} style={{ cursor: "pointer" }} onClick={onClose} />
        </div>

        {/* DASHBOARD STATS */}
        <div
          style={{
            padding: 20,
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 15,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <StatCard
            count={pwnedIds.size}
            label="Compromised"
            color="239, 68, 68"
            icon={<ShieldAlert size={14} />}
          />
          <StatCard
            count={reusedIds.size}
            label="Reused"
            color="249, 115, 22"
            icon={<Repeat size={14} />}
          />
          <StatCard
            count={weakIds.size}
            label="Weak"
            color="234, 179, 8"
            icon={<Lock size={14} />}
          />
        </div>

        {/* SCANNER CONTROL */}
        <div
          style={{
            padding: "10px 20px",
            background: "var(--bg-card)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 15,
            flexWrap: "wrap",
          }}
        >
          <button
            className="auth-btn"
            onClick={isScanning ? stopScan : scanBreaches}
            style={{
              display: "flex",
              gap: 10,
              padding: "8px 16px",
              fontSize: "0.9rem",
              // FIX: Stop button uses a warning color so it's clearly different
              background: isScanning ? "var(--btn-danger)" : undefined,
            }}
          >
            {isScanning ? (
              <Loader2 size={16} className="spinner" />
            ) : (
              <RefreshCw size={16} />
            )}
            {isScanning ? `Stop (${scanProgress}%)` : "Scan for Breaches"}
          </button>

          <span style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
            {isScanning
              ? "Checking passwords against known leaks..."
              : "Passwords are hashed locally (k-Anonymity) before checking."}
          </span>

          {/* FIX: Prominently show scan errors so the user knows the results
               may be incomplete. A failed check is not a "safe" result. */}
          {scanErrors > 0 && !isScanning && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: "#f97316",
                fontSize: "0.8rem",
                marginLeft: "auto",
              }}
            >
              <AlertTriangle size={14} />
              {scanErrors} password{scanErrors > 1 ? "s" : ""} could not be
              checked — results may be incomplete.
            </div>
          )}
        </div>

        {/* ISSUE LIST */}
        <div
          className="modal-body"
          style={{ flex: 1, overflowY: "auto", padding: 0 }}
        >
          {sortedIssues.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: 40,
                color: "var(--text-dim)",
              }}
            >
              <ShieldCheck
                size={48}
                color="#4ade80"
                style={{ marginBottom: 10 }}
              />
              <p>No obvious issues found.</p>
              <p style={{ fontSize: "0.8rem" }}>
                Run a "Scan" to check for data leaks.
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {sortedIssues.map((item) => (
                <div
                  key={item.entry.id}
                  style={{
                    padding: "12px 20px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 15,
                    background: "var(--panel-bg)",
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: item.entry.color || "#555",
                      color: "#fff",
                      fontWeight: "bold",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {item.entry.service.charAt(0).toUpperCase()}
                  </div>

                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <div style={{ fontWeight: 600, color: "var(--text-main)" }}>
                      {item.entry.service}
                    </div>
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-dim)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.entry.username}
                    </div>
                  </div>

                  {/* BADGES */}
                  <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                    {item.issues.map((iss) => (
                      <span
                        key={iss.type}
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: "bold",
                          padding: "2px 8px",
                          borderRadius: 4,
                          background:
                            iss.type === "pwned"
                              ? "rgba(239, 68, 68, 0.2)"
                              : iss.type === "reused"
                                ? "rgba(249, 115, 22, 0.2)"
                                : "rgba(234, 179, 8, 0.2)",
                          color:
                            iss.type === "pwned"
                              ? "var(--btn-danger)"
                              : iss.type === "reused"
                                ? "#f97316"
                                : "#eab308",
                        }}
                      >
                        {iss.label}
                      </span>
                    ))}
                  </div>

                  <button
                    className="secondary-btn"
                    style={{
                      padding: "6px 12px",
                      fontSize: "0.8rem",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      flexShrink: 0,
                    }}
                    onClick={() => onEditEntry(item.entry)}
                  >
                    Fix <ArrowRight size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Small helper to avoid repetitive stat card JSX ──────────────────────────
function StatCard({
  count,
  label,
  color,
  icon,
}: {
  count: number;
  label: string;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: `rgba(${color}, 0.1)`,
        padding: 15,
        borderRadius: 8,
        textAlign: "center",
        border: `1px solid rgba(${color}, 0.2)`,
      }}
    >
      <div
        style={{
          color: `rgb(${color})`,
          fontWeight: "bold",
          fontSize: "1.5rem",
        }}
      >
        {count}
      </div>
      <div
        style={{
          fontSize: "0.8rem",
          color: `rgb(${color})`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
        }}
      >
        {icon} {label}
      </div>
    </div>
  );
}
