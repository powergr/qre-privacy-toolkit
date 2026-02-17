import { useState, useMemo } from "react";
import {
  X,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  ArrowRight,
  Lock,
  Repeat,
  Loader2,
} from "lucide-react";
import { VaultEntry } from "../../hooks/useVault";
import { getPasswordStrength } from "../../utils/security";
import { invoke } from "@tauri-apps/api/core";

interface VaultHealthModalProps {
  entries: VaultEntry[];
  onClose: () => void;
  onEditEntry: (entry: VaultEntry) => void;
}

export function VaultHealthModal({
  entries,
  onClose,
  onEditEntry,
}: VaultHealthModalProps) {
  const [pwnedIds, setPwnedIds] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);

  // --- 1. DETECT REUSED (Instant) ---
  const reusedIds = useMemo(() => {
    const counts: Record<string, string[]> = {};
    entries.forEach((e) => {
      if (!counts[e.password]) counts[e.password] = [];
      counts[e.password].push(e.id);
    });

    const reused = new Set<string>();
    Object.values(counts).forEach((ids) => {
      if (ids.length > 1) ids.forEach((id) => reused.add(id));
    });
    return reused;
  }, [entries]);

  // --- 2. DETECT WEAK (Instant) ---
  const weakIds = useMemo(() => {
    const weak = new Set<string>();
    entries.forEach((e) => {
      if (getPasswordStrength(e.password).score < 3) weak.add(e.id);
    });
    return weak;
  }, [entries]);

  // --- 3. DETECT COMPROMISED (Async) ---
  async function scanBreaches() {
    if (isScanning) return;
    setIsScanning(true);
    setPwnedIds(new Set());
    setScanProgress(0);

    let completed = 0;
    const total = entries.length;
    const newPwned = new Set<string>();

    // Process in chunks to avoid UI freeze, but sequentially to be polite to API
    for (const entry of entries) {
      try {
        // Returns { found: boolean, count: number }
        const res = await invoke<{ found: boolean }>("check_password_breach", {
          password: entry.password,
        });
        if (res.found) {
          newPwned.add(entry.id);
          // Update state incrementally so user sees red popping up
          setPwnedIds((prev) => new Set(prev).add(entry.id));
        }
      } catch (e) {
        console.error("Scan error", e);
      }
      completed++;
      setScanProgress(Math.round((completed / total) * 100));
    }

    setIsScanning(false);
  }

  // --- AGGREGATE ISSUES ---
  // Combine all issues into a list, prioritize Pwned > Reused > Weak
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

  // Sort: Pwned first, then Reused, then Weak
  const sortedIssues = issues.sort((a, b) => {
    const scoreA =
      (a.issues.some((i) => i.type === "pwned") ? 10 : 0) +
      (a.issues.some((i) => i.type === "reused") ? 5 : 0);
    const scoreB =
      (b.issues.some((i) => i.type === "pwned") ? 10 : 0) +
      (b.issues.some((i) => i.type === "reused") ? 5 : 0);
    return scoreB - scoreA;
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
          <div style={{ flex: 1 }}></div>
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
          <div
            style={{
              background: "rgba(239, 68, 68, 0.1)",
              padding: 15,
              borderRadius: 8,
              textAlign: "center",
              border: "1px solid rgba(239, 68, 68, 0.2)",
            }}
          >
            <div
              style={{
                color: "var(--btn-danger)",
                fontWeight: "bold",
                fontSize: "1.5rem",
              }}
            >
              {pwnedIds.size}
            </div>
            <div
              style={{
                fontSize: "0.8rem",
                color: "var(--btn-danger)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
            >
              <ShieldAlert size={14} /> Compromised
            </div>
          </div>

          <div
            style={{
              background: "rgba(249, 115, 22, 0.1)",
              padding: 15,
              borderRadius: 8,
              textAlign: "center",
              border: "1px solid rgba(249, 115, 22, 0.2)",
            }}
          >
            <div
              style={{
                color: "#f97316",
                fontWeight: "bold",
                fontSize: "1.5rem",
              }}
            >
              {reusedIds.size}
            </div>
            <div
              style={{
                fontSize: "0.8rem",
                color: "#f97316",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
            >
              <Repeat size={14} /> Reused
            </div>
          </div>

          <div
            style={{
              background: "rgba(234, 179, 8, 0.1)",
              padding: 15,
              borderRadius: 8,
              textAlign: "center",
              border: "1px solid rgba(234, 179, 8, 0.2)",
            }}
          >
            <div
              style={{
                color: "#eab308",
                fontWeight: "bold",
                fontSize: "1.5rem",
              }}
            >
              {weakIds.size}
            </div>
            <div
              style={{
                fontSize: "0.8rem",
                color: "#eab308",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
            >
              <Lock size={14} /> Weak
            </div>
          </div>
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
          }}
        >
          <button
            className="auth-btn"
            onClick={scanBreaches}
            disabled={isScanning}
            style={{
              display: "flex",
              gap: 10,
              padding: "8px 16px",
              fontSize: "0.9rem",
            }}
          >
            {isScanning ? (
              <Loader2 size={16} className="spinner" />
            ) : (
              <RefreshCw size={16} />
            )}
            {isScanning ? `Scanning ${scanProgress}%` : "Scan for Breaches"}
          </button>
          <span style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
            {isScanning
              ? "Checking passwords against known leaks..."
              : "Passwords are hashed locally (k-Anonymity) before checking."}
          </span>
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
                    }}
                  >
                    {item.entry.service.charAt(0).toUpperCase()}
                  </div>

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, color: "var(--text-main)" }}>
                      {item.entry.service}
                    </div>
                    <div
                      style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}
                    >
                      {item.entry.username}
                    </div>
                  </div>

                  {/* BADGES */}
                  <div style={{ display: "flex", gap: 5 }}>
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
