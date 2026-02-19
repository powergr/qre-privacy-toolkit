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
  LayoutGrid,
  List as ListIcon,
  AlertTriangle,
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

// Manual UUID Generator
function generateUUID(): string {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => {
    const n = +c;
    const max = Math.floor(0x10 / 1) * 1;
    let value: number;
    do {
      value = crypto.getRandomValues(new Uint8Array(1))[0] & 0x0f;
    } while (value >= max);
    return (n ^ value).toString(16);
  });
}

export function BookmarksView() {
  const {
    entries,
    loading,
    error,
    saveBookmark,
    deleteBookmark,
    refreshVault,
  } = useBookmarks();

  // --- STATE ---
  const [editing, setEditing] = useState<Partial<BookmarkEntry> | null>(null);
  const [itemToDelete, setItemToDelete] = useState<BookmarkEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showImportModal, setShowImportModal] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [isAndroid, setIsAndroid] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // NEW: View Mode
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

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
      setMsg("Error opening link: " + e);
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

  // DUPLICATE CHECK
  const isDuplicate = (url: string) => {
    if (!url) return false;
    const clean = url.trim().replace(/\/$/, "").toLowerCase();
    return entries.some(
      (e) =>
        e.url.trim().replace(/\/$/, "").toLowerCase() === clean &&
        e.id !== editing?.id,
    );
  };

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

  if (error && !editing) {
    return (
      <div
        style={{
          padding: 40,
          color: "var(--btn-danger)",
          textAlign: "center",
        }}
      >
        <AlertTriangle size={48} style={{ marginBottom: 10 }} />
        <p>Failed to load bookmarks vault:</p>
        <p style={{ fontFamily: "monospace", fontSize: "0.9rem" }}>{error}</p>
      </div>
    );
  }

  return (
    <div className="vault-view">
      {/* --- HEADER --- */}
      <div
        className="vault-header"
        style={{
          flexDirection: isAndroid ? "column" : "row",
          alignItems: isAndroid ? "stretch" : "center",
          gap: isAndroid ? 15 : 20,
        }}
      >
        {/* LEFT: Title & Toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
          <div>
            <h2 style={{ margin: 0 }}>Bookmarks</h2>
            <p
              style={{
                margin: 0,
                fontSize: "0.9rem",
                color: "var(--text-dim)",
              }}
            >
              {entries.length} stored
            </p>
          </div>

          {/* View Toggle */}
          <div
            className="view-toggle"
            style={{
              height: "42px",
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
            }}
          >
            <button
              className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
              onClick={() => setViewMode("grid")}
              title="Grid View"
              style={{ height: "34px", width: "34px", padding: 0 }}
            >
              <LayoutGrid size={18} />
            </button>
            <button
              className={`view-btn ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setViewMode("list")}
              title="List View"
              style={{ height: "34px", width: "34px", padding: 0 }}
            >
              <ListIcon size={18} />
            </button>
          </div>
        </div>

        {/* RIGHT: Search + Actions */}
        <div
          style={{
            display: "flex",
            gap: "10px",
            alignItems: "center",
            flexDirection: isAndroid ? "column" : "row",
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
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                height: "42px",
                boxSizing: "border-box",
                margin: 0,
              }}
            />
          </div>

          {/* Buttons Row */}
          <div
            style={{
              display: "flex",
              gap: 10,
              width: isAndroid ? "100%" : "auto",
            }}
          >
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

            <button
              className="header-action-btn"
              onClick={() => {
                setSaveError(null);
                setEditing({
                  title: "",
                  url: "",
                  category: "General",
                  color: BRAND_COLORS[0],
                  is_pinned: false,
                });
              }}
              style={{
                ...commonButtonStyle,
                border: "1px solid transparent",
                flex: isAndroid ? 1 : "unset",
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

      {/* --- LIST VIEW --- */}
      {viewMode === "list" && (
        <div className="vault-list">
          {filteredEntries.map((entry) => (
            <div
              key={entry.id}
              className={`vault-list-row ${entry.is_pinned ? "pinned" : ""}`}
              onClick={() => {
                setSaveError(null);
                setEditing(entry);
              }}
            >
              {/* Icon */}
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
                {getInitial(entry.title)}
              </div>

              {/* Info */}
              <div className="list-info">
                <div style={{ fontWeight: 600, color: "var(--text-main)" }}>
                  {entry.title}
                </div>
                <div className="list-meta">
                  {getDomain(entry.url)}
                  <span
                    style={{
                      fontSize: "0.7rem",
                      background: "var(--highlight)",
                      padding: "1px 6px",
                      borderRadius: 4,
                    }}
                  >
                    {entry.category}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div
                className="list-actions"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="icon-btn-ghost"
                  title="Open Link"
                  style={{ color: "var(--text-dim)" }}
                  onClick={() => openLink(entry.url)}
                >
                  <ExternalLink size={16} />
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

      {/* --- GRID VIEW --- */}
      {viewMode === "grid" && (
        <div className="modern-grid">
          {filteredEntries.map((entry) => {
            const isPinned = entry.is_pinned || false;
            const entryColor = entry.color || BRAND_COLORS[0];

            return (
              <div
                key={entry.id}
                className={`modern-card ${isPinned ? "pinned" : ""}`}
                style={{ height: "auto", minHeight: 160, position: "relative" }}
                onClick={() => {
                  setSaveError(null);
                  setEditing(entry);
                }}
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
      )}

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
        <div
          className="modal-overlay"
          onClick={() => {
            setSaveError(null);
            setEditing(null);
          }}
        >
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
              <button
                className="icon-btn-ghost"
                title={editing.is_pinned ? "Unpin" : "Pin"}
                onClick={() =>
                  setEditing({
                    ...editing,
                    is_pinned: !editing.is_pinned,
                  })
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
              <div style={{ position: "relative" }}>
                <input
                  className="auth-input"
                  placeholder="Title (e.g. My Bank)"
                  value={editing.title ?? ""}
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
                  value={editing.url ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, url: e.target.value })
                  }
                />
              </div>
              {editing.url && isDuplicate(editing.url) && (
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "#f59e0b",
                    marginTop: -10,
                    display: "flex",
                    gap: 5,
                    alignItems: "center",
                  }}
                >
                  <AlertTriangle size={12} /> Warning: This URL already exists
                  in your vault.
                </div>
              )}

              <input
                className="auth-input"
                placeholder="Category (e.g. Finance)"
                value={editing.category ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, category: e.target.value })
                }
              />

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
                      className={`color-dot ${editing.color === c ? "selected" : ""}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setEditing({ ...editing, color: c })}
                    />
                  ))}
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

              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  className="auth-btn"
                  style={{ flex: 1 }}
                  onClick={async () => {
                    setSaveError(null);

                    const trimmedTitle = (editing.title || "").trim();
                    const trimmedUrl = (editing.url || "").trim();

                    if (!trimmedTitle) {
                      setSaveError("Bookmark title cannot be empty.");
                      return;
                    }
                    if (!trimmedUrl) {
                      setSaveError("Bookmark URL cannot be empty.");
                      return;
                    }

                    try {
                      const finalId = editing.id || generateUUID();
                      const now = Math.floor(Date.now() / 1000);

                      await saveBookmark({
                        id: finalId,
                        title: trimmedTitle,
                        url: trimmedUrl,
                        category: (editing.category || "General").trim(),
                        is_pinned: editing.is_pinned || false,
                        color: editing.color || BRAND_COLORS[0],
                        created_at: editing.created_at || now,
                      } as BookmarkEntry);

                      setEditing(null);
                    } catch (e) {
                      setSaveError(String(e));
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
          title={itemToDelete.title}
          onConfirm={() => {
            deleteBookmark(itemToDelete.id);
            setItemToDelete(null);
          }}
          onCancel={() => setItemToDelete(null)}
        />
      )}

      {msg && <InfoModal message={msg} onClose={() => setMsg(null)} />}
    </div>
  );
}
