import { useState, useEffect, useMemo } from "react";
import {
  Trash2,
  Bookmark,
  ExternalLink,
  Globe,
  Import,
  Search,
  Download,
  Pin,
  PinOff,
} from "lucide-react";
import { useBookmarks, BookmarkEntry } from "../../hooks/useBookmarks";
import { EntryDeleteModal, InfoModal } from "../modals/AppModals";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";

// Reuse colors from Vault for consistency
const BRAND_COLORS = [
  "#10b981", // Default Green
  "#E50914", // Red
  "#1DA1F2", // Blue
  "#F25022", // Orange
  "#8e44ad", // Purple
  "#555555", // Grey
];

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

  // --- FILTER & SORT ---
  const filteredEntries = useMemo(() => {
    let filtered = entries;

    // 1. Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = entries.filter(
        (entry) =>
          entry.title.toLowerCase().includes(q) ||
          entry.url.toLowerCase().includes(q) ||
          entry.category.toLowerCase().includes(q),
      );
    }

    // 2. Sort: Pinned First > Date Created
    return [...filtered].sort((a, b) => {
      const aPin = a.is_pinned || false;
      const bPin = b.is_pinned || false;

      if (aPin && !bPin) return -1;
      if (!aPin && bPin) return 1;
      return b.created_at - a.created_at;
    });
  }, [entries, searchQuery]);

  // --- SHARED STYLES ---
  const commonButtonStyle = {
    height: "42px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    padding: "0 20px",
    borderRadius: "8px",
    fontSize: "0.95rem",
    fontWeight: 500,
    cursor: "pointer",
    boxSizing: "border-box" as const,
    whiteSpace: "nowrap" as const,
    margin: 0,
  };

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
          flexDirection: isAndroid ? "column" : "row", // Stack vertically on Android
          alignItems: isAndroid ? "stretch" : "center",
          gap: isAndroid ? 15 : 20,
        }}
      >
        {/* Title Section */}
        <div>
          <h2 style={{ margin: 0 }}>Secure Bookmarks</h2>
          <p
            style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-dim)" }}
          >
            {entries.length} private links stored.
          </p>
        </div>

        {/* Unified Right Side: Search + Actions */}
        <div
          style={{
            display: "flex",
            gap: "10px",
            alignItems: "center",
            flexDirection: isAndroid ? "column" : "row", // Stack inputs on Android
            width: isAndroid ? "100%" : "auto",
          }}
        >
          {/* Search Bar */}
          <div
            className="search-container"
            style={{ width: isAndroid ? "100%" : "300px", margin: 0 }}
          >
            <Search size={18} className="search-icon" />
            <input
              className="search-input"
              placeholder="Search bookmarks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                height: "42px",
                boxSizing: "border-box",
                margin: 0,
              }}
            />
          </div>

          {/* Buttons Row (New container to keep buttons side-by-side on Android) */}
          <div
            style={{
              display: "flex",
              gap: 10,
              width: isAndroid ? "100%" : "auto",
            }}
          >
            {/* Import Button - HIDE ON ANDROID */}
            {!isAndroid && (
              <button
                className="secondary-btn"
                onClick={() => setShowImportModal(true)}
                title="Import from Browser"
                style={{
                  ...commonButtonStyle,
                  border: "1px solid var(--border)",
                  background: "var(--bg-card)",
                  color: "var(--text-main)",
                }}
              >
                <Import size={18} />
                <span>Import</span>
              </button>
            )}

            {/* Add Button */}
            <button
              className="header-action-btn"
              onClick={() =>
                setEditing({
                  title: "",
                  url: "",
                  category: "General",
                  color: BRAND_COLORS[0],
                  is_pinned: false,
                })
              }
              style={{
                ...commonButtonStyle,
                border: "1px solid transparent",
                flex: isAndroid ? 1 : "unset", // Fill width on Android
              }}
            >
              Add New
            </button>
          </div>
        </div>
      </div>

      {/* --- EMPTY STATE --- */}
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
          {!isAndroid && (
            <p style={{ fontSize: "0.8rem" }}>
              Click the Import button to load from Chrome/Edge.
            </p>
          )}
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
        {filteredEntries.map((entry) => {
          const isPinned = entry.is_pinned || false;
          const entryColor = entry.color || BRAND_COLORS[0];

          return (
            <div
              key={entry.id}
              className={`modern-card ${isPinned ? "pinned" : ""}`}
              style={{ height: "auto", minHeight: 160, position: "relative" }}
              onClick={() => setEditing(entry)}
            >
              {/* Pinned Icon Overlay */}
              {isPinned && (
                <Pin
                  size={16}
                  className="pinned-icon-corner"
                  fill="currentColor"
                />
              )}

              <div style={{ display: "flex", gap: 15 }}>
                {/* Visual Icon with Color */}
                <div
                  style={{
                    width: 50,
                    height: 50,
                    borderRadius: 12,
                    backgroundColor: entryColor,
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "1.4rem",
                    fontWeight: "bold",
                    flexShrink: 0,
                    boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
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

                {/* Quick Pin Toggle */}
                <button
                  className="icon-btn-ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    saveBookmark({ ...entry, is_pinned: !isPinned });
                  }}
                >
                  {isPinned ? <PinOff size={18} /> : <Pin size={18} />}
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
          );
        })}
      </div>

      {/* --- IMPORT MODAL --- */}
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
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: 20,
                marginTop: 15,
                position: "relative",
              }}
            >
              <h3 style={{ margin: 0 }}>
                {editing.id ? "Edit Bookmark" : "Add Bookmark"}
              </h3>
              {/* Pin Toggle in Editor */}
              <button
                className="icon-btn-ghost"
                title={(editing as any).is_pinned ? "Unpin" : "Pin"}
                onClick={() =>
                  setEditing({
                    ...editing,
                    is_pinned: !(editing as any).is_pinned,
                  })
                }
                style={{
                  color: (editing as any).is_pinned
                    ? "#ffd700"
                    : "var(--text-dim)",
                  position: "absolute",
                  right: 0,
                }}
              >
                <Pin
                  size={20}
                  fill={(editing as any).is_pinned ? "currentColor" : "none"}
                />
              </button>
            </div>

            <div
              className="modal-body"
              style={{ display: "flex", flexDirection: "column", gap: 15 }}
            >
              {/* Title */}
              <div style={{ position: "relative" }}>
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

              {/* URL */}
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

              {/* Category */}
              <input
                className="auth-input"
                placeholder="Category (e.g. Finance)"
                value={editing.category}
                onChange={(e) =>
                  setEditing({ ...editing, category: e.target.value })
                }
              />

              {/* Color Picker */}
              <div>
                <label
                  style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}
                >
                  Color Label
                </label>
                <div className="color-picker">
                  {BRAND_COLORS.map((c) => (
                    <div
                      key={c}
                      className={`color-dot ${(editing as any).color === c ? "selected" : ""}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setEditing({ ...editing, color: c })}
                    />
                  ))}
                </div>
              </div>

              {/* Actions */}
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
                      is_pinned: (editing as any).is_pinned || false,
                      color: (editing as any).color || BRAND_COLORS[0],
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
