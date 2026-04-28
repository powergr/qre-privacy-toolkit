// --- START OF FILE src/components/dashboard/FileGrid.tsx ---
// Changes from previous version:
//   1. `timeLockPaths` prop type changed from Set<string> to Map<string, number>
//      so the badge can display the actual remaining time (not just "time-locked").
//   2. Badge tooltip now shows e.g. "Locked for 3 days, 2 hours".
//   3. No sidecar logic anywhere — status comes from the embedded V6 header.

import { useState, useEffect } from "react";
import { FileEntry } from "../../types";
import { formatSize, formatDate } from "../../utils/formatting";
import {
  Folder,
  HardDrive,
  File,
  FileText,
  FileCode,
  Image as ImageIcon,
  Film,
  Music,
  Archive,
  Lock,
  ChevronUp,
  ChevronDown,
  AppWindow,
  Cpu,
  Disc,
  FileCog,
  Sheet,
  CalendarClock,
} from "lucide-react";
import { SortField, SortDirection } from "../../hooks/useFileSystem";

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Formats remaining seconds into a short human-readable string for the badge. */
function formatRemaining(lockedUntil: number): string {
  const secs = lockedUntil - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "expired";
  if (secs < 3600) {
    const m = Math.ceil(secs / 60);
    return `${m}m`;
  }
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Full human-readable tooltip string. */
function formatTooltip(lockedUntil: number): string {
  const date = new Date(lockedUntil * 1000).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Time-locked until ${date}`;
}

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface FileGridProps {
  entries: FileEntry[];
  selectedPaths: string[];
  onSelect: (
    path: string,
    index: number,
    multi: boolean,
    range: boolean,
  ) => void;
  onNavigate: (path: string) => void;
  onGoUp: () => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  /**
   * Map of .qre path → locked_until Unix timestamp.
   * Only entries whose timestamp is still in the future are included.
   * Populated by FilesView via get_file_timelock_status (reads plaintext header).
   */
  timeLockPaths?: Set<string>;
  /**
   * Full map with timestamps for rich badge display.
   * If provided, used for tooltip + remaining time label.
   */
  timeLockInfo?: Map<string, number>;
}

interface ColWidths {
  name: number;
  type: number;
  size: number;
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export function FileGrid({
  entries,
  selectedPaths,
  onSelect,
  onNavigate,
  onContextMenu,
  sortField,
  sortDirection,
  onSort,
  timeLockPaths,
  timeLockInfo,
}: FileGridProps) {
  const [colWidths, setColWidths] = useState<ColWidths>(() => {
    const saved = localStorage.getItem("qre-grid-layout");
    return saved ? JSON.parse(saved) : { name: 400, type: 100, size: 100 };
  });

  const [isResizing, setIsResizing] = useState<keyof ColWidths | null>(null);

  useEffect(() => {
    localStorage.setItem("qre-grid-layout", JSON.stringify(colWidths));
  }, [colWidths]);

  const gridTemplate = `40px ${colWidths.name}px ${colWidths.type}px ${colWidths.size}px 1fr`;

  const startResize = (col: keyof ColWidths) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(col);
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      setColWidths((prev) => ({
        ...prev,
        [isResizing]: Math.max(50, prev[isResizing] + e.movementX),
      }));
    };
    const handleMouseUp = () => setIsResizing(null);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // ─── ICON SET ─────────────────────────────────────────────────────────────

  const getIcon = (e: FileEntry) => {
    if (e.isDrive) return <HardDrive size={18} color="#94a3b8" />;
    if (e.isDirectory)
      return <Folder size={18} fill="#fcd34d" stroke="#b45309" />;

    const ext = e.name.split(".").pop()?.toLowerCase() || "";

    if (ext === "qre") return <Lock size={18} color="#eab308" fill="#fef08a" />;

    if (
      ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"].includes(ext)
    )
      return <ImageIcon size={18} color="#c084fc" />;
    if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext))
      return <Film size={18} color="#f472b6" />;
    if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext))
      return <Music size={18} color="#22d3ee" />;
    if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext))
      return <Archive size={18} color="#fb923c" />;
    if (ext === "pdf") return <FileText size={18} color="#f87171" />;
    if (["doc", "docx", "rtf"].includes(ext))
      return <FileText size={18} color="#60a5fa" />;
    if (["xls", "xlsx", "csv", "ods"].includes(ext))
      return <Sheet size={18} color="#4ade80" />;
    if (["ppt", "pptx"].includes(ext))
      return <FileText size={18} color="#fb923c" />;
    if (["txt", "md", "log"].includes(ext))
      return <FileText size={18} color="#94a3b8" />;
    if (["exe", "msi", "bat", "cmd", "sh"].includes(ext))
      return <AppWindow size={18} color="#3b82f6" />;
    if (["dll", "sys", "ini", "inf"].includes(ext))
      return <Cpu size={18} color="#64748b" />;
    if (["iso", "img", "dmg"].includes(ext))
      return <Disc size={18} color="#a855f7" />;
    if (["cfg", "conf", "json", "xml", "yaml", "toml"].includes(ext))
      return <FileCog size={18} color="#eab308" />;
    if (
      [
        "js",
        "ts",
        "jsx",
        "tsx",
        "rs",
        "py",
        "html",
        "css",
        "java",
        "cpp",
        "c",
        "php",
      ].includes(ext)
    )
      return <FileCode size={18} color="#a3e635" />;

    return <File size={18} color="#94a3b8" />;
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDirection === "asc" ? (
      <ChevronUp size={14} />
    ) : (
      <ChevronDown size={14} />
    );
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <div className="file-view">
      {/* HEADER */}
      <div
        className="file-header grid-row-layout"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div className="header-cell" />
        <div className="header-cell" onClick={() => onSort("name")}>
          Name <SortIcon field="name" />
          <div className="resize-handle" onMouseDown={startResize("name")} />
        </div>
        <div className="header-cell">
          Type
          <div className="resize-handle" onMouseDown={startResize("type")} />
        </div>
        <div className="header-cell" onClick={() => onSort("size")}>
          Size <SortIcon field="size" />
          <div className="resize-handle" onMouseDown={startResize("size")} />
        </div>
        <div
          className="header-cell"
          style={{ borderRight: "none" }}
          onClick={() => onSort("modified")}
        >
          Date Modified <SortIcon field="modified" />
        </div>
      </div>

      {/* ROWS */}
      {entries.map((e, i) => {
        const isTimeLocked =
          e.name.endsWith(".qre") &&
          timeLockPaths != null &&
          timeLockPaths.has(e.path);

        // Resolve the locked_until timestamp for rich badge display
        const lockedUntil =
          isTimeLocked && timeLockInfo ? (timeLockInfo.get(e.path) ?? 0) : 0;

        const badgeLabel =
          lockedUntil > 0 ? formatRemaining(lockedUntil) : "locked";
        const tooltipLabel =
          lockedUntil > 0 ? formatTooltip(lockedUntil) : "Time-locked";

        return (
          <div
            key={i}
            className={`file-row grid-row-layout ${
              selectedPaths.includes(e.path) ? "selected" : ""
            }`}
            style={{ gridTemplateColumns: gridTemplate }}
            onClick={(ev) => onSelect(e.path, i, ev.ctrlKey, ev.shiftKey)}
            onDoubleClick={() => e.isDirectory && onNavigate(e.path)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (!selectedPaths.includes(e.path))
                onSelect(e.path, i, false, false);
              onContextMenu(ev, e.path);
            }}
          >
            {/* ICON CELL — CalendarClock overlay for time-locked .qre files */}
            <div
              className="grid-cell icon"
              style={{ position: "relative" }}
              title={isTimeLocked ? tooltipLabel : undefined}
            >
              {getIcon(e)}
              {isTimeLocked && (
                <span
                  style={{
                    position: "absolute",
                    bottom: -2,
                    right: -4,
                    background: "var(--bg-color, #1e1e2e)",
                    borderRadius: "50%",
                    lineHeight: 0,
                    padding: 1,
                  }}
                >
                  <CalendarClock size={10} color="var(--accent)" />
                </span>
              )}
            </div>

            {/* NAME CELL — inline badge with remaining time */}
            <div
              className="grid-cell"
              style={{ fontWeight: e.isDirectory ? 500 : 400 }}
            >
              {e.name}
              {isTimeLocked && (
                <span
                  title={tooltipLabel}
                  style={{
                    marginLeft: 8,
                    fontSize: "0.7rem",
                    color: "var(--accent)",
                    background: "rgba(var(--accent-rgb, 79,142,247), 0.1)",
                    border:
                      "1px solid rgba(var(--accent-rgb, 79,142,247), 0.25)",
                    borderRadius: 4,
                    padding: "1px 5px",
                    verticalAlign: "middle",
                    fontWeight: 500,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  🔒 {badgeLabel}
                </span>
              )}
            </div>

            <div className="grid-cell details">
              {e.isDirectory
                ? "Folder"
                : e.name.split(".").pop()?.toUpperCase()}
            </div>
            <div
              className="grid-cell details"
              style={{ textAlign: "right", fontFamily: "monospace" }}
            >
              {e.isDirectory ? "" : formatSize(e.size)}
            </div>
            <div className="grid-cell details">{formatDate(e.modified)}</div>
          </div>
        );
      })}
    </div>
  );
}

// --- END OF FILE src/components/dashboard/FileGrid.tsx ---
