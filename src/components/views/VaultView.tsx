import { useState } from "react";
import { Copy, Eye, EyeOff, Trash2 } from "lucide-react";
import { useVault, VaultEntry } from "../../hooks/useVault";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { InfoModal, EntryDeleteModal } from "../modals/AppModals"; // Import new modal

export function VaultView() {
  const { entries, loading, saveEntry, deleteEntry } = useVault();
  const [editing, setEditing] = useState<Partial<VaultEntry> | null>(null);
  const [showPass, setShowPass] = useState<string | null>(null);
  const [copyModalMsg, setCopyModalMsg] = useState<string | null>(null);

  // NEW: State for deletion
  const [itemToDelete, setItemToDelete] = useState<VaultEntry | null>(null);

  const handleCopy = async (text: string) => {
    await writeText(text);
    setCopyModalMsg("Password copied to clipboard.");
  };

  // Helper to get initials
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

      <div className="modern-grid">
        {entries.map((entry) => (
          <div key={entry.id} className="modern-card">
            {/* Row 1: Icon + Name + Delete */}
            <div className="vault-service-row">
              <div className="service-icon">{getInitial(entry.service)}</div>
              <div className="service-info">
                <div className="service-name">{entry.service}</div>
                <div className="service-user">{entry.username}</div>
              </div>
              <div className="card-actions">
                <button
                  className="icon-btn-ghost danger"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    setItemToDelete(entry); // Trigger Modal
                  }}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>

            {/* Row 2: Password Pill */}
            <div className="secret-pill">
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
          </div>
        ))}
      </div>

      {/* EDIT MODAL */}
      {editing && (
        <div className="modal-overlay">
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <h3>{editing.id ? "Edit Entry" : "Add New Entry"}</h3>
            <div
              className="modal-body"
              style={{ display: "flex", flexDirection: "column", gap: 15 }}
            >
              <input
                className="auth-input"
                placeholder="Service (e.g. Google)"
                value={editing.service}
                onChange={(e) =>
                  setEditing({ ...editing, service: e.target.value })
                }
                autoFocus
              />
              <input
                className="auth-input"
                placeholder="Username / Email"
                value={editing.username}
                onChange={(e) =>
                  setEditing({ ...editing, username: e.target.value })
                }
              />
              <div className="password-wrapper">
                <input
                  className="auth-input has-icon"
                  placeholder="Password"
                  value={editing.password}
                  onChange={(e) =>
                    setEditing({ ...editing, password: e.target.value })
                  }
                />
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  className="auth-btn"
                  onClick={() => {
                    // FIX: Generate ID here to prevent overwrites
                    const finalId = editing.id || crypto.randomUUID();
                    saveEntry({
                      ...editing,
                      created_at: editing.created_at || Date.now(),
                      id: finalId,
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

      {/* DELETE CONFIRMATION MODAL */}
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
