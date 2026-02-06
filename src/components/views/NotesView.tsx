import { useState, useMemo } from "react";
import {
  Trash2,
  StickyNote,
  Search,
  Pin,
  PinOff,
  Copy,
  Check,
} from "lucide-react";
import { useNotes, NoteEntry } from "../../hooks/useNotes";
import { EntryDeleteModal } from "../modals/AppModals"; // Custom Modal

// Manual UUID Generator (Safe for all environments)
function generateUUID() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}

export function NotesView() {
  const { entries, loading, saveNote, deleteNote } = useNotes();

  // UI States
  const [editing, setEditing] = useState<Partial<NoteEntry> | null>(null);
  const [itemToDelete, setItemToDelete] = useState<NoteEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // --- FILTER & SORT LOGIC ---
  const visibleEntries = useMemo(() => {
    let filtered = entries;

    // 1. Filter by Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = entries.filter(
        (n) =>
          (n.title?.toLowerCase() || "").includes(q) ||
          (n.content?.toLowerCase() || "").includes(q),
      );
    }

    // 2. Sort: Pinned First > Updated At Descending
    return [...filtered].sort((a, b) => {
      // If one is pinned and other isn't
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;

      // Otherwise sort by date (newest first)
      return b.updated_at - a.updated_at;
    });
  }, [entries, searchQuery]);

  // --- HANDLERS ---
  const handleCopy = (e: React.MouseEvent, content: string, id: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleTogglePin = (e: React.MouseEvent, note: NoteEntry) => {
    e.stopPropagation();
    saveNote({
      ...note,
      is_pinned: !note.is_pinned,
      updated_at: Date.now(),
    });
  };

  if (loading)
    return (
      <div style={{ padding: 40, color: "var(--text-dim)" }}>
        Loading Notes...
      </div>
    );

  return (
    <div className="notes-view">
      {/* HEADER WITH SEARCH */}
      <div className="notes-header">
        <div>
          <h2 style={{ margin: 0 }}>Encrypted Notes</h2>
          <p
            style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-dim)" }}
          >
            Secure thoughts, PINs, and keys.
          </p>
        </div>

        {/* Search Bar */}
        <div className="search-container">
          <Search size={18} className="search-icon" />
          <input
            className="search-input"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <button
          className="header-action-btn"
          onClick={() =>
            setEditing({ title: "", content: "", is_pinned: false })
          }
        >
          New Note
        </button>
      </div>

      {/* EMPTY STATE */}
      {entries.length === 0 && !searchQuery && (
        <div
          style={{
            textAlign: "center",
            marginTop: 50,
            color: "var(--text-dim)",
          }}
        >
          <StickyNote size={48} style={{ marginBottom: 10, opacity: 0.5 }} />
          <p>Your notebook is empty.</p>
        </div>
      )}

      {/* NO RESULTS STATE */}
      {entries.length > 0 && visibleEntries.length === 0 && (
        <div
          style={{
            textAlign: "center",
            marginTop: 50,
            color: "var(--text-dim)",
          }}
        >
          <p>No notes found for "{searchQuery}"</p>
        </div>
      )}

      {/* NOTES GRID */}
      <div className="modern-grid">
        {visibleEntries.map((note) => (
          <div
            key={note.id}
            className={`modern-card note-card-modern ${note.is_pinned ? "pinned" : ""}`}
            onClick={() => setEditing(note)}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "start",
                marginBottom: 10,
              }}
            >
              <div
                className="note-header"
                style={{ display: "flex", alignItems: "center" }}
              >
                {note.is_pinned && (
                  <Pin size={14} className="pinned-icon" fill="currentColor" />
                )}
                {note.title || "Untitled"}
              </div>

              <div className="card-actions">
                {/* Pin Button */}
                <button
                  className={`icon-btn-ghost ${note.is_pinned ? "active" : ""}`}
                  title={note.is_pinned ? "Unpin Note" : "Pin to Top"}
                  onClick={(e) => handleTogglePin(e, note)}
                >
                  {note.is_pinned ? <PinOff size={16} /> : <Pin size={16} />}
                </button>

                {/* Copy Button */}
                <button
                  className="icon-btn-ghost"
                  title="Copy Content"
                  onClick={(e) => handleCopy(e, note.content, note.id)}
                >
                  {copiedId === note.id ? (
                    <Check size={16} color="var(--success)" />
                  ) : (
                    <Copy size={16} />
                  )}
                </button>

                {/* Delete Button */}
                <button
                  className="icon-btn-ghost danger"
                  title="Delete Note"
                  onClick={(e) => {
                    e.stopPropagation();
                    setItemToDelete(note);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            {/* Content Preview with Line Clamp */}
            <div className="note-body">{note.content || "Empty note..."}</div>

            <div className="note-footer">
              <StickyNote size={14} />
              <span>{new Date(note.updated_at).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>

      {/* EDITOR MODAL */}
      {editing && (
        <div className="modal-overlay">
          <div
            className="auth-card"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 600, maxWidth: "95vw" }}
          >
            {/* HEADER */}
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                marginBottom: 15,
                position: "relative",
              }}
            >
              <h3 style={{ margin: 0 }}>
                {editing.id ? "Edit Note" : "New Note"}
              </h3>

              {/* Pin Toggle */}
              <button
                className="icon-btn-ghost"
                title={editing.is_pinned ? "Unpin" : "Pin"}
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
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 15,
                padding: 0,
              }}
            >
              <input
                className="auth-input"
                placeholder="Title"
                value={editing.title}
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
                autoFocus
              />
              <textarea
                className="editor-textarea"
                placeholder="Write something secure..."
                value={editing.content}
                onChange={(e) =>
                  setEditing({ ...editing, content: e.target.value })
                }
              />

              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  className="auth-btn"
                  style={{ flex: 1 }}
                  // FIX: Use async/await and manual UUID
                  onClick={async () => {
                    try {
                      const finalId = editing.id || generateUUID();
                      const now = Date.now();

                      await saveNote({
                        ...editing,
                        created_at: editing.created_at || now,
                        updated_at: now,
                        id: finalId,
                        title: editing.title || "Untitled",
                        content: editing.content || "",
                        is_pinned: editing.is_pinned || false,
                      } as NoteEntry);

                      setEditing(null);
                    } catch (e) {
                      alert("Error saving note: " + e);
                      console.error(e);
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

      {/* DELETE CONFIRMATION MODAL */}
      {itemToDelete && (
        <EntryDeleteModal
          title={itemToDelete.title || "Untitled Note"}
          onConfirm={() => {
            deleteNote(itemToDelete.id);
            setItemToDelete(null);
          }}
          onCancel={() => setItemToDelete(null)}
        />
      )}
    </div>
  );
}
