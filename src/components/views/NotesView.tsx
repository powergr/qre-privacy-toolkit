import { useState } from "react";
import { Trash2, StickyNote } from "lucide-react";
import { useNotes, NoteEntry } from "../../hooks/useNotes";
import { EntryDeleteModal } from "../modals/AppModals"; // Import new modal

export function NotesView() {
  const { entries, loading, saveNote, deleteNote } = useNotes();
  const [editing, setEditing] = useState<Partial<NoteEntry> | null>(null);

  // NEW: State for deletion
  const [itemToDelete, setItemToDelete] = useState<NoteEntry | null>(null);

  if (loading)
    return (
      <div style={{ padding: 40, color: "var(--text-dim)" }}>
        Loading Notes...
      </div>
    );

  return (
    <div className="notes-view">
      <div className="notes-header">
        <div>
          <h2 style={{ margin: 0 }}>Encrypted Notes</h2>
          <p
            style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-dim)" }}
          >
            Secure thoughts, PINs, and keys.
          </p>
        </div>
        <button
          className="header-action-btn"
          onClick={() => setEditing({ title: "", content: "" })}
        >
          New Note
        </button>
      </div>

      <div className="modern-grid">
        {entries.map((note) => (
          <div
            key={note.id}
            className="modern-card note-card-modern"
            onClick={() => setEditing(note)}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "start",
              }}
            >
              <div className="note-header">{note.title || "Untitled"}</div>
              <div className="card-actions">
                <button
                  className="icon-btn-ghost danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setItemToDelete(note); // Trigger Modal
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

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
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 15,
                alignItems: "center",
              }}
            >
              <h3 style={{ margin: 0 }}>
                {editing.id ? "Edit Note" : "New Note"}
              </h3>
              {editing.id && (
                <Trash2
                  size={20}
                  color="var(--btn-danger)"
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    setItemToDelete({
                      id: editing.id!,
                      title: editing.title || "Note",
                      content: "",
                      created_at: 0,
                      updated_at: 0,
                    });
                    setEditing(null);
                  }}
                />
              )}
            </div>

            <div
              className="modal-body"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
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
                  onClick={() => {
                    // FIX: Generate ID here to prevent overwrites
                    const finalId = editing.id || crypto.randomUUID();
                    const now = Date.now();
                    saveNote({
                      ...editing,
                      created_at: editing.created_at || now,
                      updated_at: now,
                      id: finalId,
                    } as NoteEntry);
                    setEditing(null);
                  }}
                >
                  Save Note
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
