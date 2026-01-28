import { useState, useEffect } from "react";
import {
  Trash2,
  Bookmark,
  ExternalLink,
  Globe,
  Import,
  Search,
  Download,
  X,
} from "lucide-react";
import { useBookmarks, BookmarkEntry } from "../../hooks/useBookmarks";
import { EntryDeleteModal, InfoModal } from "../modals/AppModals";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";

export function BookmarksView() {
  const { entries, loading, saveBookmark, deleteBookmark, refreshVault } =
    useBookmarks();

  // --- STATE ---
  const [editing, setEditing] = useState<Partial<BookmarkEntry> | null>(null);
  const [itemToDelete, setItemToDelete] = useState<BookmarkEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showImportModal, setShowImportModal] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [isAndroid, setIsAndroid] = useState(false);

  useEffect(() => {
    try {
      const os = platform();
      setIsAndroid(os === "android");
    } catch {
      /* Ignore */
    }
  }, []);

  // --- ACTIONS ---

  const openLink = async (url: string) => {
    try {
      let target = url;
      if (!target.startsWith("http")) target = "https://" + target;
      await openUrl(target);
    } catch (e) {
      alert("Error opening link: " + e);
    }
  };

  const executeImport = async () => {
    setImportLoading(true);
    try {
      const count = await invoke<number>("import_browser_bookmarks");
      setShowImportModal(false);
      setMsg(`Successfully imported ${count} bookmarks.`);
      refreshVault();
    } catch (e) {
      setShowImportModal(false);
      setMsg("Import failed: " + e);
    } finally {
      setImportLoading(false);
    }
  };

  // Helper: Domain display
  const getDomain = (url: string) => {
    try {
      const hostname = new URL(url.startsWith("http") ? url : `https://${url}`)
        .hostname;
      return hostname.replace("www.", "");
    } catch {
      return "link";
    }
  };

  // Helper: Initial
  const getInitial = (title: string) =>
    title ? title.charAt(0).toUpperCase() : "?";

  // --- FILTERING ---
  const filteredEntries = entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.url.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.category.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  if (loading)
    return (
      <div style={{ padding: 40, color: "var(--text-dim)" }}>
        Loading Bookmarks...
      </div>
    );

  return (
    <div className="vault-view">
      {/* --- HEADER --- */}
      <div
        className="vault-header"
        style={{
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 15,
          marginBottom: 20,
        }}
      >
        {/* Top Row: Title + Stats */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            width: "100%",
            alignItems: "center",
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Secure Bookmarks</h2>
            <p
              style={{
                margin: 0,
                fontSize: "0.9rem",
                color: "var(--text-dim)",
              }}
            >
              {entries.length} private links stored.
            </p>
          </div>
        </div>

        {/* Bottom Row: Search + Actions */}
        <div style={{ display: "flex", gap: 10, width: "100%" }}>
          {/* Search Input */}
          <div
            style={{
              flex: 1,
              position: "relative",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Search
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
                paddingLeft: 38,
                height: 42,
                background: "var(--panel-bg)",
              }}
              placeholder="Search bookmarks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <X
                size={16}
                style={{
                  position: "absolute",
                  right: 12,
                  cursor: "pointer",
                  color: "var(--text-dim)",
                }}
                onClick={() => setSearchQuery("")}
              />
            )}
          </div>

          {/* Import Button - HIDE ON ANDROID */}
          {!isAndroid && (
            <button
              className="secondary-btn"
              onClick={() => setShowImportModal(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 0,
                height: 42,
                borderRadius: "8px",
                padding: "0 20px",
              }}
            >
              <Import size={18} /> <span className="hide-mobile">Import</span>
            </button>
          )}

          {/* Add Button */}
          <button
            className="header-action-btn"
            onClick={() =>
              setEditing({ title: "", url: "", category: "General" })
            }
            style={{ marginTop: 0, height: 42 }}
          >
            Add New
          </button>
        </div>
      </div>

      {/* --- EMPTY STATE (Search or Total) --- */}
      {entries.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            marginTop: 80,
            color: "var(--text-dim)",
            opacity: 0.7,
          }}
        >
          <div
            style={{
              background: "var(--panel-bg)",
              padding: 30,
              borderRadius: "50%",
              display: "inline-block",
              marginBottom: 20,
            }}
          >
            <Bookmark size={48} style={{ opacity: 0.5 }} />
          </div>
          <p>No bookmarks yet.</p>
          <p style={{ fontSize: "0.8rem" }}>
            Click "Import" to load from Chrome/Edge.
          </p>
        </div>
      ) : filteredEntries.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            marginTop: 40,
            color: "var(--text-dim)",
          }}
        >
          <p>No results found for "{searchQuery}"</p>
        </div>
      ) : null}

      {/* --- GRID --- */}
      <div className="modern-grid">
        {filteredEntries.map((entry) => (
          <div
            key={entry.id}
            className="modern-card"
            style={{ height: "auto", minHeight: 160 }}
            onClick={() => setEditing(entry)}
          >
            <div style={{ display: "flex", gap: 15 }}>
              {/* Visual Icon */}
              <div
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: 12,
                  background:
                    "linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(16, 185, 129, 0.05))",
                  color: "#10b981",
                  border: "1px solid rgba(16, 185, 129, 0.2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "1.4rem",
                  fontWeight: "bold",
                  flexShrink: 0,
                }}
              >
                {getInitial(entry.title)}
              </div>

              <div style={{ flex: 1, overflow: "hidden" }}>
                <div
                  style={{
                    fontWeight: "bold",
                    fontSize: "1.05rem",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "var(--text-main)",
                  }}
                >
                  {entry.title}
                </div>
                <div
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--text-dim)",
                    marginTop: 2,
                  }}
                >
                  {getDomain(entry.url)}
                </div>
                <div style={{ marginTop: 8 }}>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      background: "var(--highlight)",
                      padding: "3px 8px",
                      borderRadius: 4,
                      color: "var(--text-dim)",
                      textTransform: "uppercase",
                      fontWeight: "bold",
                    }}
                  >
                    {entry.category}
                  </span>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
              <button
                className="auth-btn"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  fontSize: "0.9rem",
                  padding: "8px",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  openLink(entry.url);
                }}
              >
                <ExternalLink size={16} /> Open
              </button>
              <button
                className="icon-btn-ghost danger"
                title="Delete Bookmark"
                onClick={(e) => {
                  e.stopPropagation();
                  setItemToDelete(entry);
                }}
              >
                <Trash2 size={18} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* --- IMPORT CONFIRMATION MODAL (CUSTOM) --- */}
      {showImportModal && (
        <div className="modal-overlay" style={{ zIndex: 100005 }}>
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Download size={20} color="var(--accent)" />
              <h2>Import Bookmarks</h2>
            </div>
            <div className="modal-body">
              <p style={{ textAlign: "center", color: "var(--text-main)" }}>
                Import bookmarks from Chrome, Edge, or Brave?
              </p>
              <p
                style={{
                  textAlign: "center",
                  fontSize: "0.85rem",
                  color: "var(--text-dim)",
                }}
              >
                This will copy your browser bookmarks into your encrypted vault.
                Your original bookmarks are not affected.
              </p>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowImportModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn"
                  style={{ flex: 1 }}
                  onClick={executeImport}
                  disabled={importLoading}
                >
                  {importLoading ? "Importing..." : "Yes, Import"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- EDIT MODAL --- */}
      {editing && (
        <div className="modal-overlay">
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <h3
              style={{
                textAlign: "center",
                width: "100%",
                marginBottom: 20,
                marginTop: 0,
              }}
            >
              {editing.id ? "Edit Bookmark" : "Add Bookmark"}
            </h3>

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
                <input
                  className="auth-input"
                  placeholder="Title (e.g. My Bank)"
                  value={editing.title}
                  onChange={(e) =>
                    setEditing({ ...editing, title: e.target.value })
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
                  placeholder="URL (https://...)"
                  value={editing.url}
                  onChange={(e) =>
                    setEditing({ ...editing, url: e.target.value })
                  }
                />
              </div>

              <input
                className="auth-input"
                placeholder="Category (e.g. Finance)"
                value={editing.category}
                onChange={(e) =>
                  setEditing({ ...editing, category: e.target.value })
                }
              />

              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  className="auth-btn"
                  style={{ flex: 1 }}
                  onClick={() => {
                    const finalId = editing.id || crypto.randomUUID();
                    let finalUrl = editing.url || "";
                    if (finalUrl && !finalUrl.startsWith("http")) {
                      finalUrl = "https://" + finalUrl;
                    }
                    saveBookmark({
                      ...editing,
                      created_at: editing.created_at || Date.now(),
                      id: finalId,
                      url: finalUrl,
                      title: editing.title || "New Link",
                      category: editing.category || "General",
                    } as BookmarkEntry);
                    setEditing(null);
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

      {/* --- DELETE MODAL --- */}
      {itemToDelete && (
        <EntryDeleteModal
          title={itemToDelete.title}
          onConfirm={() => {
            deleteBookmark(itemToDelete.id);
            setItemToDelete(null);
          }}
          onCancel={() => setItemToDelete(null)}
        />
      )}

      {/* --- INFO MSG --- */}
      {msg && <InfoModal message={msg} onClose={() => setMsg(null)} />}
    </div>
  );
}
