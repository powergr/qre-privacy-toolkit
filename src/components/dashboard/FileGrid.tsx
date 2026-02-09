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
} from "lucide-react";
import { SortField, SortDirection } from "../../hooks/useFileSystem";

interface FileGridProps {
  entries: FileEntry[];
  selectedPaths: string[];
  // Updated Signature for Shift Click
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
}

interface ColWidths {
  name: number;
  type: number;
  size: number;
}

export function FileGrid({
  entries,
  selectedPaths,
  onSelect,
  onNavigate,
  onContextMenu,
  sortField,
  sortDirection,
  onSort,
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

  // --- EXPANDED ICON SET ---
  const getIcon = (e: FileEntry) => {
    if (e.isDrive) return <HardDrive size={18} color="#94a3b8" />;
    if (e.isDirectory)
      return <Folder size={18} fill="#fcd34d" stroke="#b45309" />;

    const ext = e.name.split(".").pop()?.toLowerCase() || "";

    // QRE
    if (ext === "qre") return <Lock size={18} color="#eab308" fill="#fef08a" />;

    // Media
    if (
      ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"].includes(ext)
    )
      return <ImageIcon size={18} color="#c084fc" />;
    if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext))
      return <Film size={18} color="#f472b6" />;
    if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext))
      return <Music size={18} color="#22d3ee" />;

    // Archives
    if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext))
      return <Archive size={18} color="#fb923c" />;

    // Documents
    if (["pdf"].includes(ext)) return <FileText size={18} color="#f87171" />; // Red
    if (["doc", "docx", "rtf"].includes(ext))
      return <FileText size={18} color="#60a5fa" />; // Blue
    if (["xls", "xlsx", "csv", "ods"].includes(ext))
      return <Sheet size={18} color="#4ade80" />; // Green
    if (["ppt", "pptx"].includes(ext))
      return <FileText size={18} color="#fb923c" />; // Orange
    if (["txt", "md", "log"].includes(ext))
      return <FileText size={18} color="#94a3b8" />; // Gray

    // Executables & System
    if (["exe", "msi", "bat", "cmd", "sh"].includes(ext))
      return <AppWindow size={18} color="#3b82f6" />;
    if (["dll", "sys", "ini", "inf"].includes(ext))
      return <Cpu size={18} color="#64748b" />;
    if (["iso", "img", "dmg"].includes(ext))
      return <Disc size={18} color="#a855f7" />;
    if (["cfg", "conf", "json", "xml", "yaml", "toml"].includes(ext))
      return <FileCog size={18} color="#eab308" />;

    // Code
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

  return (
    <div className="file-view">
      {/* HEADER */}
      <div
        className="file-header grid-row-layout"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div className="header-cell"></div>
        <div className="header-cell" onClick={() => onSort("name")}>
          Name <SortIcon field="name" />
          <div
            className="resize-handle"
            onMouseDown={startResize("name")}
          ></div>
        </div>
        <div className="header-cell">
          Type
          <div
            className="resize-handle"
            onMouseDown={startResize("type")}
          ></div>
        </div>
        <div className="header-cell" onClick={() => onSort("size")}>
          Size <SortIcon field="size" />
          <div
            className="resize-handle"
            onMouseDown={startResize("size")}
          ></div>
        </div>
        <div
          className="header-cell"
          style={{ borderRight: "none" }}
          onClick={() => onSort("modified")}
        >
          Date Modified <SortIcon field="modified" />
        </div>
      </div>

      {/* ITEMS */}
      {entries.map((e, i) => (
        <div
          key={i}
          className={`file-row grid-row-layout ${selectedPaths.includes(e.path) ? "selected" : ""}`}
          style={{ gridTemplateColumns: gridTemplate }}
          // Pass Shift/Ctrl keys
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
          <div className="grid-cell icon">{getIcon(e)}</div>
          <div
            className="grid-cell"
            style={{ fontWeight: e.isDirectory ? 500 : 400 }}
          >
            {e.name}
          </div>
          <div className="grid-cell details">
            {e.isDirectory ? "Folder" : e.name.split(".").pop()?.toUpperCase()}
          </div>
          <div
            className="grid-cell details"
            style={{ textAlign: "right", fontFamily: "monospace" }}
          >
            {e.isDirectory ? "" : formatSize(e.size)}
          </div>
          <div className="grid-cell details">{formatDate(e.modified)}</div>
        </div>
      ))}
    </div>
  );
}
