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
  Heading3,
  Heading4,
  ChevronDown,
  Tag,
  X,
  LayoutGrid,
  LayoutList,
  Replace,
  ChevronLeft,
  ChevronRight,
  Strikethrough,
  Save,
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

// ─── UUID ───────────────────────────────────────────────────────────────────
function generateUUID() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}

// ─── STRIP MARKDOWN for card previews ────────────────────────────────────────
function stripMarkdownForPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/^#{1,4} /gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^\- /gm, "• ")
    .replace(/^\d+\. /gm, "")
    .replace(/^> /gm, "")
    .replace(/\|[-: ]+\|[-: |]+/g, "")
    .replace(/\|/g, " ")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── CONTEXTUAL SNIPPET for search results ───────────────────────────────────
// When a search query is active, show the text *around* the first match instead
// of always showing the top of the note. This tells the user exactly why the
// note was returned.
function getCardSnippet(
  note: { title: string; content: string; tags?: string[] },
  query: string,
): string {
  const stripped = stripMarkdownForPreview(note.content);
  if (!query.trim()) return stripped;

  const q = query.toLowerCase();

  // Check if match is in the stripped body
  const strippedLower = stripped.toLowerCase();
  const bodyIdx = strippedLower.indexOf(q);
  if (bodyIdx !== -1) {
    // Show a window of text centred on the match
    const BEFORE = 50;
    const AFTER = 120;
    const start = Math.max(0, bodyIdx - BEFORE);
    const end = Math.min(stripped.length, bodyIdx + AFTER);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < stripped.length ? "…" : "";
    return prefix + stripped.substring(start, end) + suffix;
  }

  // Match is in raw markdown syntax (e.g. a URL or a heading marker that
  // stripped away) or in the title/tags — fall back to the top of the body.
  return stripped;
}

// ─── WORD COUNT — strips markdown before counting ────────────────────────────
// Splits on whitespace only: URLs, emails, and hyphenated-words each count as
// one word. Markdown syntax characters are stripped first so `**bold**` counts
// as 1 word, not 2, and table separators (`|---|---|`) count as 0 words.
function countWords(content: string): number {
  if (!content) return 0;
  const stripped = stripMarkdownForPreview(content);
  return stripped.split(/\s+/).filter((w) => w.length > 0).length;
}

interface DropdownOption {
  label: string;
  value: string | number;
  // Add other properties as needed
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

  const selectedLabel =
    options.find((o) => o.value === value)?.label ?? String(value);

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

// ─── INLINE PARSER ───────────────────────────────────────────────────────────
// Order: ** (bold) before * (italic), ~~ (strike), ` (inline code)
const INLINE_RE = /(\*\*[^*\n]+?\*\*|~~[^~\n]+?~~|`[^`\n]+`|\*[^*\n]+?\*)/g;

function parseInline(text: string): React.ReactNode[] {
  const parts = text.split(INLINE_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return (
        <span key={i} className="md-bold">
          {part.slice(2, -2)}
        </span>
      );
    if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4)
      return (
        <span key={i} className="md-strikethrough">
          {part.slice(2, -2)}
        </span>
      );
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <span key={i} className="md-inline-code">
          {part.slice(1, -1)}
        </span>
      );
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return (
        <span key={i} className="md-italic">
          {part.slice(1, -1)}
        </span>
      );
    return part;
  });
}

// ─── MARKDOWN RENDERER ───────────────────────────────────────────────────────
const SimpleMarkdownRenderer = ({ content }: { content: string }) => {
  if (!content) return <span style={{ opacity: 0.5 }}>*Empty Note*</span>;

  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  let inCodeBlock = false;
  let codeAccum: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // ── Code fence ──
    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeAccum = [];
      } else {
        inCodeBlock = false;
        elements.push(
          <pre key={`code-${i}`} className="md-code-block">
            {codeAccum.join("\n")}
          </pre>,
        );
        codeAccum = [];
      }
      i++;
      continue;
    }
    if (inCodeBlock) {
      codeAccum.push(line);
      i++;
      continue;
    }

    // ── Table: collect consecutive | lines ──
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim().startsWith("|") &&
        lines[i].trim().endsWith("|")
      ) {
        tableLines.push(lines[i]);
        i++;
      }
      // Filter separator rows (e.g. |---|---|)
      const dataRows = tableLines.filter(
        (l) => !/^\s*\|[\s\-:|]+\|\s*$/.test(l),
      );
      if (dataRows.length > 0) {
        elements.push(
          <table key={`table-${i}`} className="md-table">
            <tbody>
              {dataRows.map((row, ri) => {
                const rawCells = row.split("|");
                const cells = rawCells.slice(1, rawCells.length - 1);
                return (
                  <tr key={ri}>
                    {cells.map((cell, ci) =>
                      ri === 0 ? (
                        <th key={ci}>{parseInline(cell.trim())}</th>
                      ) : (
                        <td key={ci}>{parseInline(cell.trim())}</td>
                      ),
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>,
        );
      }
      continue;
    }

    // ── Horizontal rule ──
    if (/^(---+|\*\*\*+|___+)$/.test(line.trim())) {
      elements.push(<hr key={i} className="md-hr" />);
      i++;
      continue;
    }

    // ── Headings (most-specific first to avoid prefix collisions) ──
    if (line.startsWith("#### ")) {
      elements.push(
        <div key={i} className="md-h4">
          {parseInline(line.substring(5))}
        </div>,
      );
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      elements.push(
        <div key={i} className="md-h3">
          {parseInline(line.substring(4))}
        </div>,
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(
        <div key={i} className="md-h2">
          {parseInline(line.substring(3))}
        </div>,
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      elements.push(
        <div key={i} className="md-h1">
          {parseInline(line.substring(2))}
        </div>,
      );
      i++;
      continue;
    }

    // ── Blockquote ──
    if (line.startsWith("> ")) {
      elements.push(
        <div key={i} className="md-blockquote">
          {parseInline(line.substring(2))}
        </div>,
      );
      i++;
      continue;
    }

    // ── Ordered list ──
    if (/^\d+\. /.test(line)) {
      const match = line.match(/^(\d+)\. (.*)/);
      if (match) {
        elements.push(
          <div key={i} className="md-ol-item">
            <span className="md-ol-num">{match[1]}.</span>
            {parseInline(match[2])}
          </div>,
        );
      }
      i++;
      continue;
    }

    // ── Unordered list ──
    if (line.startsWith("- ")) {
      elements.push(
        <div key={i} className="md-list-item">
          {parseInline(line.substring(2))}
        </div>,
      );
      i++;
      continue;
    }

    // ── Empty line ──
    if (line.trim() === "") {
      elements.push(<br key={i} />);
      i++;
      continue;
    }

    // ── Normal paragraph ──
    elements.push(
      <div key={i} style={{ marginBottom: 4 }}>
        {parseInline(line)}
      </div>,
    );
    i++;
  }

  return <>{elements}</>;
};

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
type AutoSaveStatus = "idle" | "saving" | "saved" | "error";
type SortBy = "modified" | "created" | "title" | "length";
type CardLayout = "grid" | "list";
type EditorMode = "edit" | "preview";

export function NotesView() {
  const { entries, loading, saveNote, deleteNote } = useNotes();

  // ── Editor state ──
  const [editing, setEditing] = useState<Partial<NoteEntry> | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>("idle");
  const [fontSize, setFontSize] = useState<number>(16);
  const [fontFamily, setFontFamily] = useState<string>("Segoe UI, sans-serif");

  // ── Tag state ──
  const [tagInput, setTagInput] = useState("");
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);

  // ── Find & Replace state ──
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);

  // ── View / sort state ──
  const [cardLayout, setCardLayout] = useState<CardLayout>("grid");
  const [sortBy, setSortBy] = useState<SortBy>("modified");
  const [searchQuery, setSearchQuery] = useState("");

  // ── Delete / export modal state ──
  const [itemToDelete, setItemToDelete] = useState<NoteEntry | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [showExportWarning, setShowExportWarning] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ── Refs ──
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRef = useRef<Partial<NoteEntry> | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Keep ref in sync for use inside timer closures
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  // ── All unique tags across entries ──
  const allTags = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((n) => n.tags?.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [entries]);

  // ── Filtered + sorted entries ──
  const visibleEntries = useMemo(() => {
    let filtered = entries;

    if (activeTagFilter) {
      filtered = filtered.filter((n) => n.tags?.includes(activeTagFilter));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (n) =>
          (n.title?.toLowerCase() || "").includes(q) ||
          (n.content?.toLowerCase() || "").includes(q) ||
          n.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }

    return [...filtered].sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      switch (sortBy) {
        case "created":
          return b.created_at - a.created_at;
        case "title":
          return (a.title || "").localeCompare(b.title || "");
        case "length":
          return (b.content?.length || 0) - (a.content?.length || 0);
        default:
          return b.updated_at - a.updated_at;
      }
    });
  }, [entries, searchQuery, activeTagFilter, sortBy]);

  // ── Find matches (computed) ──
  // Case-insensitive search. Positions are based on the raw content string
  // (which is always \n-normalised after openEditor) so they match the
  // textarea's internal character offsets for setSelectionRange.
  const findMatches = useMemo(() => {
    if (!findQuery || !editing?.content) return [];
    const text = editing.content.toLowerCase();
    const query = findQuery.toLowerCase();
    const indices: number[] = [];
    let idx = 0;
    while (idx < text.length) {
      const found = text.indexOf(query, idx);
      if (found === -1) break;
      indices.push(found);
      idx = found + 1;
    }
    return indices;
  }, [findQuery, editing?.content]);

  // Reset the match counter whenever the query changes.
  // Do NOT call navigateToMatch here — it calls textareaRef.focus() which
  // steals focus back to the editor after every single keystroke, making
  // it impossible to type more than one character in the find box.
  // The user presses Enter or clicks ‹ › to jump to a match.
  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [findQuery]);

  // Navigate to current match in textarea
  const navigateToMatch = useCallback(
    (idx: number) => {
      if (!textareaRef.current || findMatches.length === 0) return;
      const start = findMatches[idx];
      const end = start + findQuery.length;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(start, end);
      // Scroll to show the selection
      const ta = textareaRef.current;
      const lines = ta.value.substring(0, start).split("\n");
      const lineNum = lines.length;
      const lineHeight =
        parseFloat(window.getComputedStyle(ta).lineHeight) || 22;
      ta.scrollTop = Math.max(0, (lineNum - 4) * lineHeight);
    },
    [findMatches, findQuery],
  );

  // ── Auto-save (Obsidian-style) ──
  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      const note = editingRef.current;
      if (!note) return;
      const cleanTitle = (note.title || "").trim();
      if (!cleanTitle) return; // Need a title to auto-save

      setAutoSaveStatus("saving");
      try {
        const finalId = note.id || generateUUID();
        const now = Math.floor(Date.now() / 1000);
        const toSave: NoteEntry = {
          title: cleanTitle,
          content: note.content || "",
          is_pinned: note.is_pinned || false,
          tags: note.tags || [],
          created_at: note.created_at || now,
          updated_at: now,
          id: finalId,
        };
        await saveNote(toSave);
        // Assign ID for brand-new notes so subsequent saves update in-place
        if (!note.id) {
          setEditing((prev) =>
            prev
              ? { ...prev, id: finalId, created_at: toSave.created_at }
              : prev,
          );
        }
        setIsDirty(false);
        setAutoSaveStatus("saved");
        setTimeout(
          () => setAutoSaveStatus((s) => (s === "saved" ? "idle" : s)),
          2500,
        );
      } catch {
        setAutoSaveStatus("error");
      }
    }, 2000);
  }, [saveNote]);

  // Wrapper: mark dirty & schedule save
  const markDirty = useCallback(() => {
    setIsDirty(true);
    setAutoSaveStatus("idle");
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  // ── Editor change handlers ──
  const handleContentChange = (newContent: string) => {
    setEditing((prev) => (prev ? { ...prev, content: newContent } : prev));
    markDirty();
  };

  const handleTitleChange = (newTitle: string) => {
    setEditing((prev) => (prev ? { ...prev, title: newTitle } : prev));
    markDirty();
  };

  // ── Open / close editor ──
  const openEditor = (note: Partial<NoteEntry>) => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    // Normalize line endings to \n. Imported files from Windows may have \r\n.
    // The browser textarea normalizes its value to \n internally, so
    // findMatches (which searches editing.content) must use the same encoding
    // or setSelectionRange will land on the wrong character.
    const normalizedContent = (note.content || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    setEditing({ ...note, content: normalizedContent });
    setEditorMode("edit");
    setSaveError(null);
    setIsDirty(false);
    setAutoSaveStatus("idle");
    setShowFindReplace(false);
    setFindQuery("");
    setReplaceText("");
    setTagInput("");
  };

  const closeEditor = useCallback(() => {
    if (isDirty) {
      if (
        !window.confirm(
          "You have unsaved changes (auto-save pending). Close anyway?",
        )
      )
        return;
    }
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    setEditing(null);
    setIsDirty(false);
    setAutoSaveStatus("idle");
    setShowFindReplace(false);
    setTagInput("");
  }, [isDirty]);

  // ── Manual save & close ──
  const saveCurrentNote = useCallback(async () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    setSaveError(null);
    // Always read from the ref — it's kept in sync after every render,
    // so it's never a stale closure value even if called immediately after
    // a state update (e.g. adding a tag then clicking Save & Close).
    const latest = editingRef.current;
    if (!latest) return;

    const cleanTitle = (latest.title || "").trim();
    if (!cleanTitle) {
      setSaveError("Please enter a title for this note.");
      return;
    }

    try {
      const finalId = latest.id || generateUUID();
      const now = Math.floor(Date.now() / 1000);
      await saveNote({
        ...latest,
        title: cleanTitle,
        created_at: latest.created_at || now,
        updated_at: now,
        id: finalId,
        content: latest.content || "",
        is_pinned: latest.is_pinned || false,
        tags: latest.tags || [],
      } as NoteEntry);
      setEditing(null);
      setIsDirty(false);
      setAutoSaveStatus("idle");
      setShowFindReplace(false);
      setTagInput("");
    } catch (e) {
      setSaveError("Error saving note: " + e);
    }
  }, [saveNote]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "s") {
        e.preventDefault();
        if (editing) saveCurrentNote();
      }
      if (ctrl && e.key === "f" && editing) {
        e.preventDefault();
        setShowFindReplace(true);
        setTimeout(() => findInputRef.current?.focus(), 50);
      }
      if (ctrl && e.key === "h" && editing) {
        e.preventDefault();
        setShowFindReplace(true);
        setTimeout(() => findInputRef.current?.focus(), 50);
      }
      if (e.key === "Escape" && showFindReplace) {
        setShowFindReplace(false);
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, saveCurrentNote, showFindReplace]);

  // ── Format insertion ──
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
    markDirty();
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(
        start + prefix.length,
        end + prefix.length,
      );
    }, 10);
  };

  // ── Tag management ──
  const addTag = (tag: string) => {
    const clean = tag
      .trim()
      .toLowerCase()
      .replace(/[,\s]+/g, "-");
    if (!clean) return;
    const current = editing?.tags || [];
    if (current.includes(clean) || current.length >= 10) return;
    const updated = [...current, clean];
    setEditing((prev) => (prev ? { ...prev, tags: updated } : prev));
    markDirty();
  };

  const removeTag = (tag: string) => {
    const updated = (editing?.tags || []).filter((t) => t !== tag);
    setEditing((prev) => (prev ? { ...prev, tags: updated } : prev));
    markDirty();
  };

  // ── Find & Replace actions ──
  const findNext = () => {
    if (findMatches.length === 0) return;
    const next = (currentMatchIdx + 1) % findMatches.length;
    setCurrentMatchIdx(next);
    navigateToMatch(next);
  };

  const findPrev = () => {
    if (findMatches.length === 0) return;
    const prev =
      (currentMatchIdx - 1 + findMatches.length) % findMatches.length;
    setCurrentMatchIdx(prev);
    navigateToMatch(prev);
  };

  const handleReplace = () => {
    if (!editing || findMatches.length === 0 || !findQuery) return;
    const start = findMatches[currentMatchIdx];
    const content = editing.content || "";
    const newContent =
      content.substring(0, start) +
      replaceText +
      content.substring(start + findQuery.length);
    handleContentChange(newContent);
  };

  const handleReplaceAll = () => {
    if (!editing || !findQuery) return;
    const newContent = (editing.content || "")
      .split(findQuery)
      .join(replaceText);
    handleContentChange(newContent);
    setFindQuery("");
  };

  // ── Export ──
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

  // ── Import ──
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

      openEditor({ title: filename, content, is_pinned: false, tags: [] });
    } catch (e) {
      alert("Import failed: " + e);
    }
  };

  // ── Copy ──
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

  // ── Auto-save status label ──
  const autoSaveLabel = () => {
    if (autoSaveStatus === "saving")
      return (
        <span className="autosave-status saving">
          <Save size={11} /> Saving…
        </span>
      );
    if (autoSaveStatus === "saved")
      return (
        <span className="autosave-status saved">
          <Check size={11} /> Saved
        </span>
      );
    if (autoSaveStatus === "error")
      return <span className="autosave-status error">Save failed</span>;
    if (isDirty)
      return <span className="autosave-status dirty">● Unsaved</span>;
    return null;
  };

  if (loading)
    return (
      <div style={{ padding: 40, color: "var(--text-dim)" }}>
        Loading Notes…
      </div>
    );

  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div className="notes-view">
      {/* ── HEADER ── */}
      <div className="notes-header">
        <div>
          <h2 style={{ margin: 0 }}>Encrypted Notes</h2>
          <p
            style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-dim)" }}
          >
            Secure thoughts, PINs, and keys.
          </p>
        </div>

        {/* Search */}
        <div className="search-container" style={{ height: 40 }}>
          <Search size={18} className="search-icon" />
          <input
            className="search-input"
            placeholder="Search notes…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ height: "100%", boxSizing: "border-box" }}
          />
        </div>

        {/* Right-side controls */}
        <div className="notes-controls-row">
          {/* Sort dropdown */}
          <EditorDropdown
            value={sortBy}
            onChange={(v) => setSortBy(v as SortBy)}
            options={[
              { value: "modified", label: "Last Modified" },
              { value: "created", label: "Date Created" },
              { value: "title", label: "Title A→Z" },
              { value: "length", label: "Longest First" },
            ]}
          />

          {/* Grid / List toggle */}
          <div className="view-toggle">
            <button
              className={`view-toggle-btn ${cardLayout === "grid" ? "active" : ""}`}
              onClick={() => setCardLayout("grid")}
              title="Grid view"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-toggle-btn ${cardLayout === "list" ? "active" : ""}`}
              onClick={() => setCardLayout("list")}
              title="List view"
            >
              <LayoutList size={16} />
            </button>
          </div>

          {/* Import */}
          <button
            className="notes-icon-btn"
            onClick={handleImport}
            title="Import Text File"
          >
            <Upload size={16} />
          </button>

          {/* New Note */}
          <button
            className="header-action-btn"
            onClick={() =>
              openEditor({ title: "", content: "", is_pinned: false, tags: [] })
            }
            style={{
              height: 40,
              padding: "0 20px",
              borderRadius: 8,
              fontWeight: 600,
              fontSize: "0.9rem",
              display: "flex",
              alignItems: "center",
              cursor: "pointer",
              border: "1px solid transparent",
            }}
          >
            New Note
          </button>
        </div>
      </div>

      {/* ── TAG FILTER BAR ── */}
      {allTags.length > 0 && (
        <div className="tag-filter-bar">
          <Tag size={13} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
          <button
            className={`tag-chip filter-chip ${activeTagFilter === null ? "active" : ""}`}
            onClick={() => setActiveTagFilter(null)}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`tag-chip filter-chip ${activeTagFilter === tag ? "active" : ""}`}
              onClick={() =>
                setActiveTagFilter(activeTagFilter === tag ? null : tag)
              }
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* ── EMPTY STATE ── */}
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

      {/* ── GRID / LIST VIEW ── */}
      {cardLayout === "grid" ? (
        <div className="modern-grid">
          {visibleEntries.map((note) => (
            <div
              key={note.id}
              className={`modern-card note-card-modern ${note.is_pinned ? "pinned" : ""}`}
              onClick={() => {
                openEditor(note);
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
                  style={{ display: "flex", alignItems: "center", gap: 5 }}
                >
                  {note.is_pinned && (
                    <Pin
                      size={14}
                      className="pinned-icon"
                      fill="currentColor"
                    />
                  )}
                  {note.title || "Untitled"}
                </div>
                <div className="card-actions">
                  <button
                    className={`icon-btn-ghost ${note.is_pinned ? "active" : ""}`}
                    onClick={(e) => handleTogglePin(e, note)}
                    title={note.is_pinned ? "Unpin" : "Pin"}
                  >
                    {note.is_pinned ? <PinOff size={16} /> : <Pin size={16} />}
                  </button>
                  <button
                    className="icon-btn-ghost"
                    title="Copy content"
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
                    title="Delete note"
                    onClick={(e) => {
                      e.stopPropagation();
                      setItemToDelete(note);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <div className="note-body">
                {getCardSnippet(note, searchQuery) || "Empty note…"}
              </div>

              {/* Tags on card */}
              {note.tags && note.tags.length > 0 && (
                <div className="note-card-tags">
                  {note.tags.map((t) => (
                    <span key={t} className="tag-chip card-tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}

              <div className="note-footer">
                <StickyNote size={14} />
                <span
                  title={`Modified: ${new Date(note.updated_at * 1000).toLocaleString()}`}
                >
                  Modified:{" "}
                  {new Date(note.updated_at * 1000).toLocaleDateString()}
                </span>
                <span style={{ marginLeft: "auto", fontSize: "0.75rem" }}>
                  {countWords(note.content)} words
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ── LIST VIEW ── */
        <div className="notes-list-view">
          {visibleEntries.map((note) => (
            <div
              key={note.id}
              className={`notes-list-item ${note.is_pinned ? "pinned" : ""}`}
              onClick={() => openEditor(note)}
            >
              <div className="list-item-left">
                {note.is_pinned && (
                  <Pin
                    size={13}
                    className="pinned-icon"
                    fill="currentColor"
                    style={{ flexShrink: 0 }}
                  />
                )}
                <span className="list-item-title">
                  {note.title || "Untitled"}
                </span>
                {note.tags && note.tags.length > 0 && (
                  <div className="list-item-tags">
                    {note.tags.map((t) => (
                      <span key={t} className="tag-chip card-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="list-item-right">
                <span className="list-item-meta">
                  {countWords(note.content)} words
                </span>
                <span
                  className="list-item-meta"
                  title={`Modified: ${new Date(note.updated_at * 1000).toLocaleString()}`}
                >
                  Modified:{" "}
                  {new Date(note.updated_at * 1000).toLocaleDateString()}
                </span>
                <div
                  className="card-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="icon-btn-ghost"
                    title="Copy content"
                    onClick={(e) => handleCopy(e, note.content, note.id)}
                  >
                    {copiedId === note.id ? (
                      <Check size={14} color="var(--success)" />
                    ) : (
                      <Copy size={14} />
                    )}
                  </button>
                  <button
                    className="icon-btn-ghost danger"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setItemToDelete(note);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────
          EDITOR MODAL
      ───────────────────────────────────────────────────────────────────── */}
      {editing && (
        <div
          className="modal-overlay"
          style={{ zIndex: 100000 }}
          onClick={closeEditor}
        >
          <div
            className="auth-card editor-modal-card"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 860, maxWidth: "95vw" }}
          >
            {/* ── Title row ── */}
            <div className="editor-title-row">
              <div style={{ width: 76, flexShrink: 0 }} />
              <input
                className="auth-input editor-title-input"
                placeholder="Untitled Note"
                value={editing.title ?? ""}
                autoFocus
                onChange={(e) => handleTitleChange(e.target.value)}
              />
              <div className="editor-header-actions">
                <button
                  className="icon-btn-ghost"
                  onClick={() =>
                    setEditing({ ...editing, is_pinned: !editing.is_pinned })
                  }
                  style={{
                    color: editing.is_pinned ? "#ffd700" : "var(--text-dim)",
                  }}
                  title={editing.is_pinned ? "Unpin" : "Pin"}
                >
                  <Pin
                    size={18}
                    fill={editing.is_pinned ? "currentColor" : "none"}
                  />
                </button>
                <button
                  className="icon-btn-ghost"
                  onClick={() => setShowExportWarning(true)}
                  title="Export as text file"
                >
                  <Download size={18} />
                </button>
              </div>
            </div>

            {/* ── Tag editor row ── */}
            <div className="tag-editor-row">
              <Tag
                size={13}
                style={{ color: "var(--text-dim)", flexShrink: 0 }}
              />
              {(editing.tags || []).map((tag) => (
                <span key={tag} className="tag-chip editor-tag">
                  {tag}
                  <button
                    className="tag-remove-btn"
                    onClick={() => removeTag(tag)}
                    title={`Remove tag "${tag}"`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                className="tag-input-field"
                placeholder="Add tag…"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onBlur={() => {
                  // Commit any typed-but-not-confirmed tag when focus leaves
                  // the input (e.g. user types "hello" then clicks Save & Close
                  // without pressing Enter — without this the tag is lost).
                  if (tagInput.trim()) {
                    addTag(tagInput);
                    setTagInput("");
                  }
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === ",") && tagInput.trim()) {
                    e.preventDefault();
                    addTag(tagInput);
                    setTagInput("");
                  }
                  if (
                    e.key === "Backspace" &&
                    !tagInput &&
                    (editing.tags?.length ?? 0) > 0
                  ) {
                    removeTag(editing.tags![editing.tags!.length - 1]);
                  }
                }}
              />
            </div>

            {/* ── Toolbar ── */}
            <div className="editor-toolbar">
              {/* Edit / Preview toggle */}
              <button
                className={`toolbar-btn ${editorMode === "edit" ? "active" : ""}`}
                onClick={() => setEditorMode("edit")}
                title="Edit mode"
              >
                <Type size={16} />
              </button>
              <button
                className={`toolbar-btn ${editorMode === "preview" ? "active" : ""}`}
                onClick={() => setEditorMode("preview")}
                title="Preview mode"
              >
                {editorMode === "edit" ? (
                  <Eye size={16} />
                ) : (
                  <EyeOff size={16} />
                )}
              </button>

              <div className="toolbar-separator" />

              {/* Format buttons */}
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("**", "**")}
                title="Bold (Ctrl+B)"
              >
                <Bold size={15} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("*", "*")}
                title="Italic"
              >
                <Italic size={15} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("~~", "~~")}
                title="Strikethrough"
              >
                <Strikethrough size={15} />
              </button>

              <div className="toolbar-separator" />

              <button
                className="toolbar-btn"
                onClick={() => insertFormat("# ", "")}
                title="Heading 1"
              >
                <Heading1 size={15} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("## ", "")}
                title="Heading 2"
              >
                <Heading2 size={15} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("### ", "")}
                title="Heading 3"
              >
                <Heading3 size={15} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("#### ", "")}
                title="Heading 4"
              >
                <Heading4 size={15} />
              </button>

              <div className="toolbar-separator" />

              <button
                className="toolbar-btn"
                onClick={() => insertFormat("- ", "")}
                title="Unordered list"
              >
                <List size={15} />
              </button>
              <button
                className="toolbar-btn"
                onClick={() => insertFormat("```\n", "\n```")}
                title="Code block"
              >
                <Code size={15} />
              </button>

              <div className="toolbar-separator" />

              {/* Find & Replace toggle */}
              <button
                className={`toolbar-btn ${showFindReplace ? "active" : ""}`}
                onClick={() => {
                  setShowFindReplace(!showFindReplace);
                  if (!showFindReplace) {
                    setTimeout(() => findInputRef.current?.focus(), 50);
                  }
                }}
                title="Find & Replace (Ctrl+F / Ctrl+H)"
              >
                <Replace size={15} />
              </button>

              <div style={{ flex: 1 }} />

              {/* Font controls */}
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
                  { value: 13, label: "Small" },
                  { value: 16, label: "Normal" },
                  { value: 18, label: "Large" },
                  { value: 22, label: "Huge" },
                ]}
              />
            </div>

            {/* ── Find & Replace bar ── */}
            {showFindReplace && (
              <div className="find-replace-bar">
                <div className="find-replace-row">
                  <Search
                    size={13}
                    style={{ color: "var(--text-dim)", flexShrink: 0 }}
                  />
                  <input
                    ref={findInputRef}
                    className="find-input"
                    placeholder="Find…"
                    value={findQuery}
                    onChange={(e) => setFindQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.shiftKey ? findPrev() : findNext();
                      }
                    }}
                  />
                  <span className="find-counter">
                    {findMatches.length > 0
                      ? `${currentMatchIdx + 1}/${findMatches.length}`
                      : findQuery
                        ? "0/0"
                        : ""}
                  </span>
                  <button
                    className="toolbar-btn"
                    onClick={findPrev}
                    disabled={findMatches.length === 0}
                    title="Previous match (Shift+Enter)"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    className="toolbar-btn"
                    onClick={findNext}
                    disabled={findMatches.length === 0}
                    title="Next match (Enter)"
                  >
                    <ChevronRight size={14} />
                  </button>
                  <button
                    className="toolbar-btn"
                    onClick={() => {
                      setShowFindReplace(false);
                    }}
                    title="Close (Esc)"
                  >
                    <X size={14} />
                  </button>
                </div>

                {/* Replace row — shown when mode is replace */}
                <div className="find-replace-row">
                  <Replace
                    size={13}
                    style={{ color: "var(--text-dim)", flexShrink: 0 }}
                  />
                  <input
                    className="find-input"
                    placeholder="Replace with…"
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleReplace();
                    }}
                  />
                  <button
                    className="find-action-btn"
                    onClick={handleReplace}
                    disabled={findMatches.length === 0}
                    title="Replace current match"
                  >
                    Replace
                  </button>
                  <button
                    className="find-action-btn"
                    onClick={handleReplaceAll}
                    disabled={!findQuery}
                    title="Replace all matches"
                  >
                    All
                  </button>
                </div>
              </div>
            )}

            {/* ── Editor container ── */}
            <div className="editor-container">
              {editorMode === "edit" ? (
                <textarea
                  ref={textareaRef}
                  className="editor-textarea"
                  placeholder="Write something secure…"
                  value={editing.content ?? ""}
                  onChange={(e) => handleContentChange(e.target.value)}
                  style={{ fontSize: `${fontSize}px`, fontFamily }}
                />
              ) : (
                <div
                  className="editor-preview"
                  style={{ fontSize: `${fontSize}px`, fontFamily }}
                >
                  <SimpleMarkdownRenderer content={editing.content || ""} />
                </div>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="editor-footer">
              <span>
                {editing.content?.length || 0} chars •{" "}
                {countWords(editing.content || "")} words
              </span>
              <span style={{ marginLeft: "auto" }}>{autoSaveLabel()}</span>
            </div>

            {/* ── Inline error ── */}
            {saveError && <div className="save-error-banner">{saveError}</div>}

            {/* ── Action buttons ── */}
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
                onClick={closeEditor}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
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
