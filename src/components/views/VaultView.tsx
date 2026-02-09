import { useState, useMemo } from "react";
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
} from "lucide-react";
import { useVault, VaultEntry } from "../../hooks/useVault";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { InfoModal, EntryDeleteModal } from "../modals/AppModals";
// 1. IMPORT UTILS
import { getPasswordStrength, getStrengthColor } from "../../utils/security";

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

function generateUUID() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}

export function VaultView() {
  const { entries, loading, saveEntry, deleteEntry } = useVault();

  const [editing, setEditing] = useState<Partial<VaultEntry> | null>(null);
  const [showPass, setShowPass] = useState<string | null>(null);
  const [copyModalMsg, setCopyModalMsg] = useState<string | null>(null);
  const [itemToDelete, setItemToDelete] = useState<VaultEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // 2. CALCULATE STRENGTH FOR MODAL
  // We calculate this dynamically based on what is being typed in the 'editing' state
  const strength = editing
    ? getPasswordStrength(editing.password || "")
    : { score: 0, feedback: "" };

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
      return b.created_at - a.created_at;
    });
  }, [entries, searchQuery]);

  const handleCopy = async (text: string) => {
    await writeText(text);
    setCopyModalMsg("Password copied to clipboard.");
  };

  const generateStrongPassword = () => {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let pass = "";
    const array = new Uint32Array(20);
    crypto.getRandomValues(array);
    for (let i = 0; i < 20; i++) {
      pass += chars[array[i] % chars.length];
    }
    return pass;
  };

  const getInitial = (name: string) =>
    name ? name.charAt(0).toUpperCase() : "?";

  if (loading)
    return (
      <div style={{ padding: 40, color: "var(--text-dim)" }}>
        Loading Vault...
      </div>
    );

  return (
    <div className="vault-view">
      <div className="vault-header">
        <div>
          <h2 style={{ margin: 0 }}>Password Vault</h2>
          <p
            style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-dim)" }}
          >
            {entries.length} secure login{entries.length !== 1 ? "s" : ""}.
          </p>
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
        <button
          className="header-action-btn"
          onClick={() =>
            setEditing({
              service: "",
              username: "",
              password: "",
              notes: "",
              color: BRAND_COLORS[0],
              is_pinned: false,
            })
          }
        >
          Add New
        </button>
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
          <p>Click "Add New" to store your first secret.</p>
        </div>
      )}

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
            <div className="card-actions">
              <button
                className="icon-btn-ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  saveEntry({ ...entry, is_pinned: !entry.is_pinned });
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

      {editing && (
        <div className="modal-overlay">
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
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
                  value={editing.service}
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
                  value={editing.username}
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

              {/* Password + Strength Meter */}
              <div>
                <div className="vault-view-custom-password-wrapper">
                  <input
                    className="auth-input has-icon"
                    placeholder="Password"
                    value={editing.password}
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
                </div>

                {/* 3. STRENGTH VISUALIZATION */}
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
                        {
                          ["Very Weak", "Weak", "Okay", "Good", "Strong"][
                            strength.score
                          ]
                        }
                      </span>
                      <span>{strength.feedback}</span>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label
                  style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}
                >
                  Card Color
                </label>
                https://www.twitch.tv/therbak47
                <div className="color-picker">
                  {BRAND_COLORS.map((c) => (
                    <div
                      key={c}
                      className={`color-dot ${editing.color === c ? "selected" : ""}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setEditing({ ...editing, color: c })}
                    />
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 15 }}>
                <button
                  className="auth-btn"
                  style={{ flex: 1 }}
                  onClick={async () => {
                    try {
                      const finalId = editing.id || generateUUID();
                      await saveEntry({
                        ...editing,
                        created_at: editing.created_at || Date.now(),
                        id: finalId,
                        service: editing.service || "Untitled",
                        username: editing.username || "",
                        password: editing.password || "",
                        notes: editing.notes || "",
                        url: editing.url || "",
                        color: editing.color || BRAND_COLORS[0],
                        is_pinned: editing.is_pinned || false,
                      } as VaultEntry);
                      setEditing(null);
                    } catch (e) {
                      alert("Error saving: " + e);
                    }
                  }}
                >
                  Save
                </button>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => setEditing(null)}
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
        <InfoModal
          message={copyModalMsg}
          onClose={() => setCopyModalMsg(null)}
        />
      )}
    </div>
  );
}
