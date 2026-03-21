import { useState, useMemo, useEffect, useRef } from "react";
import {
  Copy,
  Eye,
  EyeOff,
  Trash2,
  Key,
  Globe,
  User,
  Search,
  Pin,
  PinOff,
  Link as LinkIcon,
  Download,
  Upload,
  LayoutGrid,
  List as ListIcon,
  HeartPulse,
  ShieldCheck,
} from "lucide-react";
import { useVault, VaultEntry } from "../../hooks/useVault";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  InfoModal,
  EntryDeleteModal,
  ExportWarningModal,
  ExportSuccessModal,
} from "../modals/AppModals";
import { VaultHealthModal } from "../modals/VaultHealthModal";
import { getPasswordStrength, getStrengthColor } from "../../utils/security";
import "./VaultView.css";

const BRAND_COLORS = [
  "#555555",
  "#E50914",
  "#1DA1F2",
  "#4267B2",
  "#F25022",
  "#0F9D58",
  "#8e44ad",
  "#f1c40f",
];

const CLIPBOARD_CLEAR_DELAY_MS = 30_000;

function generateUUID(): string {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}

function generateStrongPassword(length = 20): string {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const symbols = "!@#$%^&*";
  const all = upper + lower + digits + symbols;

  const unbiasedRandom = (limit: number): number => {
    const max = Math.floor(0x100000000 / limit) * limit;
    let value: number;
    do {
      value = crypto.getRandomValues(new Uint32Array(1))[0];
    } while (value >= max);
    return value % limit;
  };

  const required = [
    upper[unbiasedRandom(upper.length)],
    lower[unbiasedRandom(lower.length)],
    digits[unbiasedRandom(digits.length)],
    symbols[unbiasedRandom(symbols.length)],
  ];

  const rest = Array.from(
    { length: length - required.length },
    () => all[unbiasedRandom(all.length)],
  );

  const combined = [...required, ...rest];
  for (let i = combined.length - 1; i > 0; i--) {
    const j = unbiasedRandom(i + 1);
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }
  return combined.join("");
}

function parseCSV(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r" && raw[i + 1] === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i += 2;
      } else if (ch === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function getInitial(name: string): string {
  if (!name) return "?";
  return name
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, "")
    .charAt(0)
    .toUpperCase();
}

// -----------------------------------------------------------------------------
// TOTP Code Display Component (Live refreshing 6-digit code)
// -----------------------------------------------------------------------------
function TotpDisplay({
  secret,
  onCopy,
  compact = false,
}: {
  secret: string;
  onCopy: (code: string) => void;
  compact?: boolean;
}) {
  const [code, setCode] = useState<string>("------");
  const [timeLeft, setTimeLeft] = useState<number>(30);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;

    async function fetchCode() {
      // Allow standard 16-char and longer 32-char base32 secrets
      if (!secret || secret.trim().length < 16) {
        if (isMounted) {
          setCode("------");
          setError(false);
        }
        return;
      }

      try {
        const [newCode, remaining] = await invoke<[string, number]>(
          "generate_totp_code",
          { secret: secret.trim() }, // ← trim here too
        );
        if (isMounted) {
          setCode(newCode);
          setTimeLeft(remaining);
          setError(false);
        }
      } catch (e) {
        console.error("TOTP Error:", e);
        if (isMounted) {
          setCode("ERROR");
          setError(true);
        }
      }
    }

    fetchCode();
    const interval = setInterval(fetchCode, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [secret]);

  const radius = compact ? 6 : 8;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (timeLeft / 30) * circumference;

  const dangerColor = "var(--btn-danger)";
  const activeColor = "var(--accent)";

  return (
    <div
      className={compact ? "" : "secret-pill"}
      style={
        compact
          ? { display: "flex", alignItems: "center", gap: 8 }
          : {
              marginTop: 8,
              background: "rgba(0,0,0,0.15)",
              borderColor: "var(--highlight)",
              cursor: "pointer",
            }
      }
      // FIX: Clicking ANYWHERE on the pill copies the code
      onClick={(e) => {
        e.stopPropagation();
        if (!error && code !== "------" && code !== "ERROR") onCopy(code);
      }}
      title={error ? "Invalid Secret Key" : "Click to Copy 2FA Code"}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: compact ? 6 : 10 }}
      >
        {/* Animated Countdown Circle */}
        <svg
          width={compact ? "16" : "20"}
          height={compact ? "16" : "20"}
          style={{ transform: "rotate(-90deg)" }}
        >
          <circle
            cx={compact ? "8" : "10"}
            cy={compact ? "8" : "10"}
            r={radius}
            stroke="var(--border)"
            strokeWidth={compact ? "2" : "3"}
            fill="transparent"
          />
          <circle
            cx={compact ? "8" : "10"}
            cy={compact ? "8" : "10"}
            r={radius}
            stroke={
              error ? dangerColor : timeLeft <= 5 ? dangerColor : activeColor
            }
            strokeWidth={compact ? "2" : "3"}
            fill="transparent"
            strokeDasharray={circumference}
            strokeDashoffset={error ? 0 : strokeDashoffset}
            style={{
              transition: "stroke-dashoffset 1s linear, stroke 0.3s ease",
            }}
          />
        </svg>

        {/* The 6 Digit Code */}
        <span
          style={{
            fontWeight: "bold",
            fontSize: compact ? "0.95rem" : "1.1rem",
            letterSpacing: compact ? "1px" : "2px",
            color: error
              ? dangerColor
              : timeLeft <= 5
                ? dangerColor
                : "var(--text-main)",
          }}
        >
          {error
            ? "INVALID KEY"
            : code.length === 6
              ? `${code.slice(0, 3)} ${code.slice(3, 6)}`
              : code}
        </span>
      </div>

      {/* Visual copy icon indicator for the main grid card */}
      {!compact && (
        <button className="icon-btn-ghost" title="Copy 2FA Code">
          <Copy size={16} />
        </button>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export function VaultView() {
  const { entries, loading, saveEntry, deleteEntry, importEntries } =
    useVault();

  const [editing, setEditing] = useState<Partial<VaultEntry> | null>(null);
  const [showPass, setShowPass] = useState<string | null>(null);
  const [showEditPass, setShowEditPass] = useState(false);
  const [copyModalMsg, setCopyModalMsg] = useState<string | null>(null);
  const [itemToDelete, setItemToDelete] = useState<VaultEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [showExportWarning, setShowExportWarning] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");

  const [saveError, setSaveError] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    };
  }, []);

  const strength = editing
    ? getPasswordStrength(editing.password || "")
    : { score: 0, feedback: "", label: "", color: "" };

  const visibleEntries = useMemo(() => {
    let filtered = entries;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = entries.filter(
        (e) =>
          e.service.toLowerCase().includes(q) ||
          e.username.toLowerCase().includes(q) ||
          (e.url && e.url.toLowerCase().includes(q)),
      );
    }
    return [...filtered].sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      return a.service.localeCompare(b.service);
    });
  }, [entries, searchQuery]);

  const handleCopy = async (text: string, isTotp = false) => {
    await writeText(text);
    if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    clipboardTimerRef.current = setTimeout(async () => {
      try {
        await writeText("");
      } catch {}
    }, CLIPBOARD_CLEAR_DELAY_MS);

    // FIX: Set the exact message string so InfoModal appears
    setCopyModalMsg(
      `${isTotp ? "2FA Code" : "Password"} copied — clipboard will be cleared in 30 seconds.`,
    );
  };

  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "CSV File", extensions: ["csv"] }],
      });
      if (!selected) return;

      setIsProcessing(true);
      const contents = await invoke<string>("read_text_file_content", {
        path: selected,
      });
      const rows = parseCSV(contents);

      if (rows.length === 0) {
        setCopyModalMsg("No data found in the selected file.");
        return;
      }

      const firstRow = rows[0].map((c) => c.toLowerCase());
      const hasHeader =
        firstRow.includes("password") ||
        firstRow.includes("name") ||
        firstRow.includes("username");
      const startIdx = hasHeader ? 1 : 0;

      const newEntries: VaultEntry[] = [];
      const skipped: number[] = [];

      for (let i = startIdx; i < rows.length; i++) {
        const parts = rows[i];
        if (parts.length < 3) continue;

        const service = parts[0]?.trim() || "";
        const url = parts[1]?.trim() || "";
        const username = parts[2]?.trim() || "";
        const password = parts[3]?.trim() || "";
        const notes = parts.slice(4).join(",").trim();

        if (!service || !password) {
          skipped.push(i + 1);
          continue;
        }

        newEntries.push({
          id: generateUUID(),
          service,
          url,
          username,
          password,
          notes,
          color: BRAND_COLORS[0],
          is_pinned: false,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        });
      }

      if (newEntries.length > 0) {
        await importEntries(newEntries);
        const skippedMsg =
          skipped.length > 0 ? ` (${skipped.length} rows skipped)` : "";
        setCopyModalMsg(
          `Successfully imported ${newEntries.length} passwords.${skippedMsg}`,
        );
      } else {
        setCopyModalMsg(
          "No valid entries found. CSV must have at least Service and Password.",
        );
      }
    } catch (e) {
      setSaveError("Import failed: " + e);
    } finally {
      setIsProcessing(false);
    }
  };

  const executeExport = async () => {
    setShowExportWarning(false);
    try {
      const path = await save({
        defaultPath: "passwords_export.csv",
        filters: [{ name: "CSV File", extensions: ["csv"] }],
      });
      if (!path) return;

      const header = "name,url,username,password,note,totp_secret\n";
      const rows = entries
        .map((e) =>
          [
            csvEscape(e.service),
            csvEscape(e.url || ""),
            csvEscape(e.username),
            csvEscape(e.password),
            csvEscape(e.notes),
            csvEscape(e.totp_secret || ""),
          ].join(","),
        )
        .join("\n");

      await invoke("write_text_file_content", {
        path,
        content: header + rows + "\n",
      });
      setExportedPath(path);
    } catch (e) {
      setSaveError("Export failed: " + e);
    }
  };

  if (loading)
    return (
      <div style={{ padding: 40, color: "var(--text-dim)" }}>
        Loading Vault...
      </div>
    );

  return (
    <div className="vault-view">
      <div className="vault-header">
        <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1.5rem", lineHeight: 1 }}>
              Vault
            </h2>
            <span style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
              {entries.length} logins
            </span>
          </div>

          <div className="view-toggle">
            <button
              className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
              onClick={() => setViewMode("grid")}
              title="Grid View"
            >
              <LayoutGrid size={18} />
            </button>
            <button
              className={`view-btn ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setViewMode("list")}
              title="List View"
            >
              <ListIcon size={18} />
            </button>
          </div>
        </div>

        <div className="search-container">
          <Search size={18} className="search-icon" />
          <input
            className="search-input"
            placeholder="Search Logins..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            className="vault-action-btn"
            title="Security Health Check"
            onClick={() => setShowHealth(true)}
            style={{
              color: "var(--btn-danger)",
              borderColor: "rgba(239, 68, 68, 0.3)",
            }}
          >
            <HeartPulse size={20} />
          </button>
          <button
            className="vault-action-btn"
            title="Import CSV"
            onClick={handleImport}
            disabled={isProcessing}
          >
            <Upload size={20} />
          </button>
          <button
            className="vault-action-btn"
            title="Export CSV"
            onClick={() => setShowExportWarning(true)}
          >
            <Download size={20} />
          </button>
          <button
            className="vault-primary-btn"
            onClick={() =>
              setEditing({
                service: "",
                username: "",
                password: "",
                notes: "",
                color: BRAND_COLORS[0],
                is_pinned: false,
                totp_secret: "",
              })
            }
          >
            Add New
          </button>
        </div>
      </div>

      {entries.length === 0 && !searchQuery && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "40vh",
            color: "var(--text-dim)",
            opacity: 0.7,
          }}
        >
          <Key size={64} style={{ marginBottom: 20, color: "var(--accent)" }} />
          <h3>No Passwords Yet</h3>
          <p>Click "Add New" or use Import to get started.</p>
        </div>
      )}

      {/* LIST VIEW */}
      {viewMode === "list" && (
        <div className="vault-list">
          {visibleEntries.map((entry) => (
            <div
              key={entry.id}
              className={`vault-list-row ${entry.is_pinned ? "pinned" : ""}`}
              onClick={() => setEditing(entry)}
            >
              <div
                className="service-icon"
                style={{
                  backgroundColor: entry.color || BRAND_COLORS[0],
                  width: 36,
                  height: 36,
                  fontSize: "1rem",
                  marginRight: 15,
                }}
              >
                {getInitial(entry.service)}
              </div>
              <div className="list-info">
                <div style={{ fontWeight: 600, color: "var(--text-main)" }}>
                  {entry.service}
                </div>
                <div className="list-meta">{entry.username}</div>
              </div>
              <div
                className="list-actions"
                onClick={(e) => e.stopPropagation()}
              >
                {/* LIST 2FA BADGE */}
                {entry.totp_secret && (
                  <span
                    style={{
                      fontSize: "0.7rem",
                      background: "var(--highlight)",
                      padding: "2px 6px",
                      borderRadius: 4,
                      marginRight: 10,
                      fontWeight: "bold",
                    }}
                  >
                    2FA
                  </span>
                )}

                <button
                  className="icon-btn-ghost"
                  title="Copy Password"
                  style={{ color: "var(--text-dim)" }}
                  onClick={() => handleCopy(entry.password)}
                >
                  <Copy size={16} />
                </button>
                {entry.is_pinned && (
                  <Pin size={16} color="#ffd700" style={{ marginRight: 10 }} />
                )}
                <button
                  className="icon-btn-ghost danger"
                  onClick={() => setItemToDelete(entry)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* GRID VIEW */}
      {viewMode === "grid" && (
        <div className="modern-grid">
          {visibleEntries.map((entry) => (
            <div
              key={entry.id}
              className={`modern-card ${entry.is_pinned ? "pinned" : ""}`}
              onClick={() => setEditing(entry)}
              style={{ position: "relative" }}
            >
              {entry.is_pinned && (
                <Pin
                  size={16}
                  className="pinned-icon-corner"
                  fill="currentColor"
                />
              )}

              <div className="vault-service-row">
                <div
                  className="service-icon"
                  style={{ backgroundColor: entry.color || BRAND_COLORS[0] }}
                >
                  {getInitial(entry.service)}
                </div>
                <div className="service-info" style={{ overflow: "hidden" }}>
                  <div className="service-name" style={{ fontWeight: 600 }}>
                    {entry.service}
                  </div>
                  <div
                    className="service-user"
                    style={{
                      fontSize: "0.85rem",
                      color: "var(--text-dim)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {entry.username}
                  </div>
                </div>
              </div>

              {/* Password Copier */}
              <div className="secret-pill" onClick={(e) => e.stopPropagation()}>
                <span className="secret-text">
                  {showPass === entry.id ? entry.password : "•".repeat(12)}
                </span>
                <button
                  className="icon-btn-ghost"
                  onClick={() =>
                    setShowPass(showPass === entry.id ? null : entry.id)
                  }
                >
                  {showPass === entry.id ? (
                    <EyeOff size={16} />
                  ) : (
                    <Eye size={16} />
                  )}
                </button>
                <button
                  className="icon-btn-ghost"
                  onClick={() => handleCopy(entry.password)}
                >
                  <Copy size={16} />
                </button>
              </div>

              {/* 2FA Live Display */}
              {entry.totp_secret && (
                <TotpDisplay
                  secret={entry.totp_secret}
                  onCopy={(code) => handleCopy(code, true)}
                />
              )}

              <div className="card-actions" style={{ marginTop: 10 }}>
                <button
                  className="icon-btn-ghost"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await saveEntry({
                        ...entry,
                        is_pinned: !entry.is_pinned,
                      });
                    } catch (err) {
                      setSaveError(String(err)); // <--- SHOW THE ERROR IN THE UI
                    }
                  }}
                >
                  {entry.is_pinned ? <PinOff size={16} /> : <Pin size={16} />}
                </button>
                <button
                  className="icon-btn-ghost danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setItemToDelete(entry);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showExportWarning && (
        <ExportWarningModal
          onConfirm={executeExport}
          onCancel={() => setShowExportWarning(false)}
        />
      )}
      {showHealth && (
        <VaultHealthModal
          entries={entries}
          onClose={() => setShowHealth(false)}
          onEditEntry={(entry) => setEditing(entry)}
        />
      )}

      {/* --- EDIT / ADD MODAL --- */}
      {editing && (
        <div
          className="modal-overlay"
          style={{ zIndex: 100010 }}
          onClick={() => setEditing(null)}
        >
          <div
            className="auth-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 500, width: "100%" }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: 20,
                position: "relative",
              }}
            >
              <h3>{editing.id ? "Edit Entry" : "New Entry"}</h3>
              <button
                className="icon-btn-ghost"
                onClick={() =>
                  setEditing({ ...editing, is_pinned: !editing.is_pinned })
                }
                style={{
                  color: editing.is_pinned ? "#ffd700" : "var(--text-dim)",
                  position: "absolute",
                  right: 0,
                }}
              >
                <Pin
                  size={20}
                  fill={editing.is_pinned ? "currentColor" : "none"}
                />
              </button>
            </div>

            <div
              className="modal-body"
              style={{ display: "flex", flexDirection: "column", gap: 15 }}
            >
              <div
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <Globe
                  size={16}
                  style={{
                    position: "absolute",
                    left: 12,
                    color: "var(--text-dim)",
                  }}
                />
                <input
                  className="auth-input"
                  style={{ paddingLeft: 40 }}
                  placeholder="Service Name (e.g. Google)"
                  value={editing.service ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, service: e.target.value })
                  }
                  autoFocus
                />
              </div>

              <div
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <User
                  size={16}
                  style={{
                    position: "absolute",
                    left: 12,
                    color: "var(--text-dim)",
                  }}
                />
                <input
                  className="auth-input"
                  style={{ paddingLeft: 40 }}
                  placeholder="Username / Email"
                  value={editing.username ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, username: e.target.value })
                  }
                />
              </div>

              <div
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <LinkIcon
                  size={16}
                  style={{
                    position: "absolute",
                    left: 12,
                    color: "var(--text-dim)",
                  }}
                />
                <input
                  className="auth-input"
                  style={{ paddingLeft: 40 }}
                  placeholder="Website URL (Optional)"
                  value={editing.url || ""}
                  onChange={(e) =>
                    setEditing({ ...editing, url: e.target.value })
                  }
                />
              </div>

              <div>
                <div className="vault-view-custom-password-wrapper">
                  <input
                    type={showEditPass ? "text" : "password"}
                    className="auth-input has-icon"
                    placeholder="Password"
                    value={editing.password ?? ""}
                    onChange={(e) =>
                      setEditing({ ...editing, password: e.target.value })
                    }
                  />
                  <button
                    className="vault-view-custom-password-toggle"
                    title="Generate Strong Password"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        password: generateStrongPassword(),
                      })
                    }
                  >
                    <Key size={18} />
                  </button>
                  <button
                    type="button"
                    className="vault-view-custom-password-toggle"
                    title={showEditPass ? "Hide password" : "Show password"}
                    onClick={() => setShowEditPass(!showEditPass)}
                  >
                    {showEditPass ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>

                {editing.password && editing.password.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div
                      style={{
                        height: 4,
                        width: "100%",
                        background: "rgba(255,255,255,0.1)",
                        borderRadius: 2,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${(strength.score + 1) * 20}%`,
                          background: getStrengthColor(strength.score),
                          transition:
                            "width 0.3s ease, background-color 0.3s ease",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--text-dim)",
                        marginTop: 4,
                        textAlign: "right",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: getStrengthColor(strength.score) }}>
                        {strength.label}
                      </span>
                      <span>{strength.feedback}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 2FA SETUP FIELD */}
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  paddingTop: 15,
                  marginTop: 5,
                }}
              >
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <ShieldCheck
                    size={16}
                    style={{
                      position: "absolute",
                      left: 12,
                      color: "var(--text-dim)",
                    }}
                  />
                  <input
                    className="auth-input"
                    style={{
                      paddingLeft: 40,
                      fontFamily: "monospace",
                      textTransform: "uppercase",
                      flex: 1,
                    }}
                    placeholder="2FA Authenticator Key (e.g. JBSWY3DP...)"
                    value={editing.totp_secret || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, totp_secret: e.target.value })
                    }
                  />
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 8,
                  }}
                >
                  <p
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-dim)",
                      margin: 0,
                      flex: 1,
                    }}
                  >
                    Paste the Secret Key provided by the website.
                  </p>

                  {/* LIVE FEEDBACK: Show the generated code instantly! */}
                  {editing.totp_secret && editing.totp_secret.length >= 16 && (
                    <div
                      style={{
                        background: "var(--bg-color)",
                        border: "1px solid var(--border)",
                        padding: "4px 10px",
                        borderRadius: 6,
                      }}
                    >
                      <TotpDisplay
                        secret={editing.totp_secret}
                        compact={true}
                        onCopy={(code) => handleCopy(code, true)}
                      />
                    </div>
                  )}
                </div>
              </div>

              {saveError && (
                <div
                  style={{
                    color: "var(--btn-danger)",
                    fontSize: "0.85rem",
                    background: "rgba(239,68,68,0.1)",
                    border: "1px solid rgba(239,68,68,0.3)",
                    borderRadius: 6,
                    padding: "8px 12px",
                  }}
                >
                  {saveError}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 15 }}>
                <button
                  className="auth-btn"
                  style={{ flex: 1 }}
                  onClick={async () => {
                    setSaveError(null);
                    const trimmedService = (editing.service || "").trim();
                    const trimmedPassword = (editing.password || "").trim();
                    if (!trimmedService) {
                      setSaveError("Service name is required.");
                      return;
                    }
                    if (!trimmedPassword) {
                      setSaveError("Password must not be empty.");
                      return;
                    }

                    try {
                      const now = Math.floor(Date.now() / 1000);

                      // FIX: Properly handle the optional TOTP field
                      // If it's empty, we make it undefined so Rust parses it as None.
                      const cleanTotp =
                        editing.totp_secret && editing.totp_secret.trim() !== ""
                          ? editing.totp_secret
                              .replace(/\s+/g, "")
                              .toUpperCase()
                          : undefined;

                      await saveEntry({
                        id: editing.id || generateUUID(),
                        service: trimmedService,
                        username: editing.username || "",
                        password: trimmedPassword,
                        notes: editing.notes || "",
                        url: editing.url || "",
                        color: editing.color || BRAND_COLORS[0],
                        is_pinned: editing.is_pinned || false,
                        totp_secret: cleanTotp, // <--- Correctly passing undefined or the clean string
                        created_at: editing.created_at || now,
                        updated_at: now,
                      });
                      setEditing(null);
                    } catch (e) {
                      setSaveError("Error saving: " + e);
                    }
                  }}
                >
                  Save
                </button>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setSaveError(null);
                    setEditing(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {itemToDelete && (
        <EntryDeleteModal
          title={itemToDelete.service}
          onConfirm={() => {
            deleteEntry(itemToDelete.id);
            setItemToDelete(null);
          }}
          onCancel={() => setItemToDelete(null)}
        />
      )}
      {copyModalMsg && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200000,
            pointerEvents: "none",
          }}
        >
          <div style={{ pointerEvents: "auto" }}>
            <InfoModal
              message={copyModalMsg}
              onClose={() => setCopyModalMsg(null)}
            />
          </div>
        </div>
      )}
      {exportedPath && (
        <ExportSuccessModal
          filePath={exportedPath}
          onClose={() => setExportedPath(null)}
        />
      )}
      {saveError && !editing && (
        <InfoModal message={saveError} onClose={() => setSaveError(null)} />
      )}
    </div>
  );
}
