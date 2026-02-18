import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  Trash2,
  StickyNote,
  Search,
  Pin,
  PinOff,
  Copy,
  Check,
  Bold,
  Italic,
  List,
  Type,
  Code,
  Eye,
  EyeOff,
  Download,
  Upload,
  Heading1,
  Heading2,
  ChevronDown,
} from "lucide-react";
import { useNotes, NoteEntry } from "../../hooks/useNotes";
import {
  EntryDeleteModal,
  ExportSuccessModal,
  ExportWarningModal,
} from "../modals/AppModals";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import "./NotesView.css";

// Manual UUID Generator
function generateUUID() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}

// --- CUSTOM COMPONENTS ---
interface DropdownOption {
  value: string | number;
  label: string;
}
function EditorDropdown({
  options,
  value,
  onChange,
}: {
  options: DropdownOption[];
  value: string | number;
  onChange: (v: any) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    if (isOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const selectedLabel = options.find((o) => o.value === value)?.label || value;

  return (
    <div className="custom-select-container" ref={containerRef}>
      <div className="custom-select-trigger" onClick={() => setIsOpen(!isOpen)}>
        <span>{selectedLabel}</span>
        <ChevronDown size={14} style={{ opacity: 0.7 }} />
      </div>
      {isOpen && (
        <div className="custom-select-options">
          {options.map((opt) => (
            <div
              key={opt.value}
              className={`custom-option ${opt.value === value ? "selected" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SimpleMarkdownRenderer = ({ content }: { content: string }) => {
  if (!content) return <span style={{ opacity: 0.5 }}>*Empty Note*</span>;
  const lines = content.split("\n");
  let inCodeBlock = false;
  return (
    <>
      {lines.map((line, index) => {
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          return null;
        }
        if (inCodeBlock)
          return (
            <div key={index} className="md-code-block">
              {line}
            </div>
          );
        if (line.startsWith("# "))
          return (
            <div key={index} className="md-h1">
              {line.substring(2)}
            </div>
          );
        if (line.startsWith("## "))
          return (
            <div key={index} className="md-h2">
              {line.substring(3)}
            </div>
          );
        if (line.startsWith("- "))
          return (
            <div key={index} className="md-list-item">
              {parseInline(line.substring(2))}
            </div>
          );
        if (line.trim() === "") return <br key={index} />;
        return (
          <div key={index} style={{ marginBottom: 4 }}>
            {parseInline(line)}
          </div>
        );
      })}
    </>
  );
};

const parseInline = (text: string) => {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <span key={i} className="md-bold">
          {part.slice(2, -2)}
        </span>
      );
    }
    const subParts = part.split(/(\*.*?\*)/g);
    return subParts.map((sub, j) => {
      if (sub.startsWith("*") && sub.endsWith("*")) {
        return (
          <span key={`${i}-${j}`} className="md-italic">
            {sub.slice(1, -1)}
          </span>
        );
      }
      return sub;
    });
  });
};

export function NotesView() {
  const { entries, loading, saveNote, deleteNote } = useNotes();

  const [editing, setEditing] = useState<Partial<NoteEntry> | null>(null);
  const [itemToDelete, setItemToDelete] = useState<NoteEntry | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [showExportWarning, setShowExportWarning] = useState(false);

  const [saveError, setSaveError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<"edit" | "preview">("edit");
  const [fontSize, setFontSize] = useState<number>(16);
  const [fontFamily, setFontFamily] = useState<string>("Segoe UI, sans-serif");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    };
  }, []);

  const visibleEntries = useMemo(() => {
    let filtered = entries;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = entries.filter(
        (n) =>
          (n.title?.toLowerCase() || "").includes(q) ||
          (n.content?.toLowerCase() || "").includes(q),
      );
    }
    return [...filtered].sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      return b.updated_at - a.updated_at;
    });
  }, [entries, searchQuery]);

  // --- SAVE LOGIC ---
  const saveCurrentNote = useCallback(async () => {
    setSaveError(null);
    if (!editing) return;

    // FIX: Enforce Title. Do not allow "Untitled" or empty.
    const cleanTitle = (editing.title || "").trim();
    if (!cleanTitle) {
      setSaveError("Please enter a title for this note.");
      return;
    }

    try {
      const finalId = editing.id || generateUUID();
      const now = Math.floor(Date.now() / 1000);
      await saveNote({
        ...editing,
        title: cleanTitle, // Use cleaned title
        created_at: editing.created_at || now,
        updated_at: now,
        id: finalId,
        content: editing.content || "",
        is_pinned: editing.is_pinned || false,
      } as NoteEntry);
      setEditing(null);
    } catch (e) {
      setSaveError("Error saving note: " + e);
    }
  }, [editing, saveNote]);

  // --- SHORTCUTS ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (editing) {
          saveCurrentNote();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, saveCurrentNote]);

  const insertFormat = (prefix: string, suffix: string = "") => {
    if (!textareaRef.current || !editing) return;
    const start = textareaRef.current.selectionStart;
    const end = textareaRef.current.selectionEnd;
    const text = editing.content || "";
    const newContent =
      text.substring(0, start) +
      prefix +
      text.substring(start, end) +
      suffix +
      text.substring(end);
    setEditing({ ...editing, content: newContent });
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(
        start + prefix.length,
        end + prefix.length,
      );
    }, 10);
  };

  const handleExportConfirm = async () => {
    setShowExportWarning(false);
    if (!editing) return;
    try {
      const path = await save({
        defaultPath: `${editing.title || "note"}.txt`,
        filters: [{ name: "Text File", extensions: ["txt", "md"] }],
      });
      if (path) {
        await invoke("write_text_file_content", {
          path,
          content: editing.content || "",
        });
        setExportedPath(path);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // --- IMPORT LOGIC ---
  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Text File", extensions: ["txt", "md", "json"] }],
      });
      if (!selected) return;

      const content = await invoke<string>("read_text_file_content", {
        path: selected,
      });
      const filename =
        (selected as string).split(/[/\\]/).pop() || "Imported Note";

      setEditing({
        title: filename,
        content: content,
        is_pinned: false,
      });
      setViewMode("edit");
      setSaveError(null);
    } catch (e) {
      alert("Import failed: " + e);
    }
  };

  const handleCopy = (e: React.MouseEvent, content: string, id: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopiedId(id);

    if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    clipboardTimerRef.current = setTimeout(async () => {
      try {
        await navigator.clipboard.writeText("");
      } catch {}
    }, 30000);

    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleTogglePin = (e: React.MouseEvent, note: NoteEntry) => {
    e.stopPropagation();
    saveNote({
      ...note,
      is_pinned: !note.is_pinned,
      updated_at: Math.floor(Date.now() / 1000),
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
      {/* --- HEADER --- */}
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
        <div className="search-container" style={{ height: "40px" }}>
          <Search size={18} className="search-icon" />
          <input
            className="search-input"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ height: "100%", boxSizing: "border-box" }}
          />
        </div>

        {/* Buttons (Alignment Fixed) */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Import Button */}
          <button
            className="secondary-btn"
            onClick={handleImport}
            title="Import Text File"
            style={{
              height: "40px",
              width: "40px",
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "8px",
              border: "1px solid var(--border)",
              background: "var(--bg-card)",
              color: "var(--text-main)",
              cursor: "pointer",
              boxSizing: "border-box",
            }}
          >
            <Upload size={20} />
          </button>

          {/* New Note Button */}
          <button
            className="header-action-btn"
            onClick={() => {
              setEditing({ title: "", content: "", is_pinned: false });
              setViewMode("edit");
              setSaveError(null);
            }}
            style={{
              height: "40px",
              padding: "0 20px",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "0.9rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxSizing: "border-box",
              border: "1px solid transparent",
            }}
          >
            New Note
          </button>
        </div>
      </div>

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

      {/* GRID */}
      <div className="modern-grid">
        {visibleEntries.map((note) => (
          <div
            key={note.id}
            className={`modern-card note-card-modern ${note.is_pinned ? "pinned" : ""}`}
            onClick={() => {
              setEditing(note);
              setViewMode("edit");
              setSaveError(null);
            }}
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
                <button
                  className={`icon-btn-ghost ${note.is_pinned ? "active" : ""}`}
                  onClick={(e) => handleTogglePin(e, note)}
                >
                  {note.is_pinned ? <PinOff size={16} /> : <Pin size={16} />}
                </button>
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
            <div className="note-body">{note.content || "Empty note..."}</div>
            <div className="note-footer">
              <StickyNote size={14} />
              <span>
                {new Date(note.updated_at * 1000).toLocaleDateString()}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* --- EDITOR MODAL --- */}
      {editing && (
        <div
          className="modal-overlay"
          style={{ zIndex: 100000 }}
          onClick={() => setEditing(null)}
        >
          <div
            className="auth-card"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 800, maxWidth: "95vw" }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 15,
              }}
            >
              <div style={{ width: 60 }}></div>
              <input
                className="auth-input"
                style={{
                  fontSize: "1.2rem",
                  fontWeight: "bold",
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  textAlign: "center",
                  flex: 1,
                }}
                placeholder="Untitled Note"
                value={editing.title}
                autoFocus
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
              />
              <div
                style={{
                  display: "flex",
                  gap: 5,
                  width: 60,
                  justifyContent: "flex-end",
                }}
              >
                <button
                  className="icon-btn-ghost"
                  onClick={() =>
                    setEditing({ ...editing, is_pinned: !editing.is_pinned })
                  }
                  style={{
                    color: editing.is_pinned ? "#ffd700" : "var(--text-dim)",
                  }}
                >
                  <Pin
                    size={20}
                    fill={editing.is_pinned ? "currentColor" : "none"}
                  />
                </button>
                <button
                  className="icon-btn-ghost"
                  onClick={() => setShowExportWarning(true)}
                  title="Export as Text"
                >
                  <Download size={20} />
                </button>
              </div>
            </div>

            <div className="editor-toolbar">
              <button
                className={`toolbar-btn ${viewMode === "edit" ? "active" : ""}`}
                onClick={() => setViewMode("edit")}
                title="Edit"
              >
                <Type size={18} />
              </button>
              <button
                className={`toolbar-btn ${viewMode === "preview" ? "active" : ""}`}
                onClick={() => setViewMode("preview")}
                title="Preview"
              >
                {viewMode === "edit" ? <Eye size={18} /> : <EyeOff size={18} />}
              </button>
              <div className="toolbar-separator"></div>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("**", "**")}
                title="Bold"
              >
                <Bold size={16} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("*", "*")}
                title="Italic"
              >
                <Italic size={16} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("# ", "")}
                title="H1"
              >
                <Heading1 size={16} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("## ", "")}
                title="H2"
              >
                <Heading2 size={16} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("- ", "")}
                title="List"
              >
                <List size={16} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("```\n", "\n```")}
                title="Code"
              >
                <Code size={16} />
              </button>
              <div style={{ flex: 1 }}></div>
              <EditorDropdown
                value={fontFamily}
                onChange={setFontFamily}
                options={[
                  { value: "Segoe UI, sans-serif", label: "Sans" },
                  { value: "Consolas, monospace", label: "Mono" },
                  { value: "Georgia, serif", label: "Serif" },
                ]}
              />
              <EditorDropdown
                value={fontSize}
                onChange={setFontSize}
                options={[
                  { value: 14, label: "Small" },
                  { value: 16, label: "Normal" },
                  { value: 18, label: "Large" },
                  { value: 24, label: "Huge" },
                ]}
              />
            </div>

            <div className="editor-container">
              {viewMode === "edit" ? (
                <textarea
                  ref={textareaRef}
                  className="editor-textarea"
                  placeholder="Write something secure..."
                  value={editing.content}
                  onChange={(e) =>
                    setEditing({ ...editing, content: e.target.value })
                  }
                  style={{ fontSize: `${fontSize}px`, fontFamily: fontFamily }}
                />
              ) : (
                <div
                  className="editor-preview"
                  style={{ fontSize: `${fontSize}px`, fontFamily: fontFamily }}
                >
                  <SimpleMarkdownRenderer content={editing.content || ""} />
                </div>
              )}
            </div>

            <div className="editor-footer">
              {editing.content?.length || 0} chars •{" "}
              {
                (editing.content?.split(/\s+/) || []).filter(
                  (w) => w.length > 0,
                ).length
              }{" "}
              words
            </div>

            {/* INLINE ERROR */}
            {saveError && (
              <div
                style={{
                  marginBottom: 10,
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
                onClick={saveCurrentNote}
              >
                Save & Close
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
      )}

      {showExportWarning && (
        <ExportWarningModal
          onConfirm={handleExportConfirm}
          onCancel={() => setShowExportWarning(false)}
          type="note"
        />
      )}

      {exportedPath && (
        <ExportSuccessModal
          filePath={exportedPath}
          onClose={() => setExportedPath(null)}
        />
      )}

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
