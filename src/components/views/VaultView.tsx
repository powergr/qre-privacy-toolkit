import { useState } from "react";
import { Copy, Eye, EyeOff, Trash2, Key, Globe, User } from "lucide-react";
import { useVault, VaultEntry } from "../../hooks/useVault";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { InfoModal, EntryDeleteModal } from "../modals/AppModals";

export function VaultView() {
  const { entries, loading, saveEntry, deleteEntry } = useVault();

  // State for modals and interaction
  const [editing, setEditing] = useState<Partial<VaultEntry> | null>(null);
  const [showPass, setShowPass] = useState<string | null>(null); // ID of entry to show password for
  const [copyModalMsg, setCopyModalMsg] = useState<string | null>(null);
  const [itemToDelete, setItemToDelete] = useState<VaultEntry | null>(null);

  const handleCopy = async (text: string) => {
    await writeText(text);
    setCopyModalMsg("Password copied to clipboard.");
  };

  // Helper to get initials (e.g. "Google" -> "G")
  const getInitial = (name: string) =>
    name ? name.charAt(0).toUpperCase() : "?";

  // --- LOADING STATE ---
  if (loading)
    return (
      <div style={{ padding: 40, color: "var(--text-dim)" }}>
        Loading Vault...
      </div>
    );

  return (
    <div className="vault-view">
      {/* --- HEADER --- */}
      <div className="vault-header">
        <div>
          <h2 style={{ margin: 0 }}>Password Vault</h2>
          <p
            style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-dim)" }}
          >
            {entries.length} {entries.length === 1 ? "secret" : "secrets"}{" "}
            stored securely.
          </p>
        </div>
        <button
          className="header-action-btn"
          onClick={() =>
            setEditing({ service: "", username: "", password: "", notes: "" })
          }
        >
          Add New
        </button>
      </div>

      {/* --- EMPTY STATE --- */}
      {entries.length === 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "50vh",
            color: "var(--text-dim)",
            opacity: 0.7,
          }}
        >
          <div
            style={{
              background: "var(--panel-bg)",
              padding: 30,
              borderRadius: "50%",
              marginBottom: 20,
              border: "1px solid var(--border)",
            }}
          >
            <Key size={64} style={{ color: "var(--accent)" }} />
          </div>
          <h3 style={{ margin: "0 0 10px 0", color: "var(--text-main)" }}>
            No Passwords Yet
          </h3>
          <p>Click "Add New" to store your first secret.</p>
        </div>
      )}

      {/* --- GRID OF CARDS --- */}
      <div className="modern-grid">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="modern-card"
            onClick={() => setEditing(entry)}
          >
            {/* Top Row: Icon + Info + Delete */}
            <div className="vault-service-row">
              <div className="service-icon">{getInitial(entry.service)}</div>
              <div className="service-info">
                <div className="service-name">{entry.service}</div>
                <div className="service-user">{entry.username}</div>
              </div>

              {/* Actions (visible on hover via CSS) */}
              <div className="card-actions">
                <button
                  className="icon-btn-ghost danger"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    setItemToDelete(entry);
                  }}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>

            {/* Bottom Row: Password Pill */}
            <div className="secret-pill" onClick={(e) => e.stopPropagation()}>
              <span className="secret-text">
                {showPass === entry.id ? entry.password : "•".repeat(12)}
              </span>

              <button
                className="icon-btn-ghost"
                title={showPass === entry.id ? "Hide" : "Show"}
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
                title="Copy"
                onClick={() => handleCopy(entry.password)}
              >
                <Copy size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* --- EDIT / ADD MODAL --- */}
      {editing && (
        <div className="modal-overlay">
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <h3
              style={{ textAlign: "center", width: "100%", marginBottom: 20 }}
            >
              {editing.id ? "Edit Entry" : "Add New Entry"}
            </h3>

            <div
              className="modal-body"
              style={{ display: "flex", flexDirection: "column", gap: 15 }}
            >
              {/* Service Input */}
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
                  placeholder="Service (e.g. Google)"
                  value={editing.service}
                  onChange={(e) =>
                    setEditing({ ...editing, service: e.target.value })
                  }
                  autoFocus
                />
              </div>

              {/* Username Input */}
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

              {/* Password Input + Gen Button */}
              <div className="password-wrapper">
                <input
                  className="auth-input has-icon"
                  placeholder="Password"
                  value={editing.password}
                  onChange={(e) =>
                    setEditing({ ...editing, password: e.target.value })
                  }
                />
                <button
                  className="password-toggle"
                  title="Generate Random Password"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      password: crypto.randomUUID().slice(0, 18),
                    })
                  } // Simple random gen
                >
                  <Key size={18} />
                </button>
              </div>

              {/* Buttons */}
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  className="auth-btn"
                  onClick={() => {
                    // Force ID generation here if new
                    const finalId = editing.id || crypto.randomUUID();
                    saveEntry({
                      ...editing,
                      created_at: editing.created_at || Date.now(),
                      id: finalId,
                      service: editing.service || "Untitled",
                      username: editing.username || "",
                      password: editing.password || "",
                      notes: editing.notes || "",
                    } as VaultEntry);
                    setEditing(null);
                  }}
                >
                  Save
                </button>

                <button
                  className="secondary-btn"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- CONFIRM DELETE MODAL --- */}
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

      {/* --- INFO MODAL (Copy Success) --- */}
      {copyModalMsg && (
        <InfoModal
          message={copyModalMsg}
          onClose={() => setCopyModalMsg(null)}
        />
      )}
    </div>
  );
}
