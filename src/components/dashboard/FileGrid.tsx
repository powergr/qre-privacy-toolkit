import { useState, useEffect } from "react";
import { FileEntry } from "../../types";
import { formatSize, formatDate } from "../../utils/formatting";
import { Folder, File, HardDrive, CornerLeftUp } from "lucide-react";

interface FileGridProps {
  entries: FileEntry[];
  selectedPaths: string[];
  onSelect: (path: string, multi: boolean) => void;
  onNavigate: (path: string) => void;
  onGoUp: () => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
}

export function FileGrid({
  entries,
  selectedPaths,
  onSelect,
  onNavigate,
  onGoUp,
  onContextMenu,
}: FileGridProps) {
  // --- COLUMN RESIZING STATE ---
  // Default widths: Icon(30px) Name(40%) Type(15%) Size(15%) Modified(Remaining)
  // We use percentages or fr units mostly, but for resizing usually pixel widths are safer or specific flex ratios.
  // Let's use CSS Grid templates.
  const [colWidths, setColWidths] = useState({
    name: 300,
    type: 100,
    size: 100,
  });

  const [isResizing, setIsResizing] = useState<string | null>(null);

  // Calculate grid template string
  // Col 1: Icon (fixed 30px)
  // Col 2: Name (dynamic px)
  // Col 3: Type (dynamic px)
  // Col 4: Size (dynamic px)
  // Col 5: Modified (1fr - takes rest)
  const gridTemplate = `30px ${colWidths.name}px ${colWidths.type}px ${colWidths.size}px 1fr`;

  // --- MOUSE HANDLERS FOR RESIZE ---
  const startResize = (col: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(col);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Logic relies on movement delta would be complex.
      // Simpler: Just track X position? No, easier to add movementX
      setColWidths((prev) => {
        const delta = e.movementX;
        const newWidth = prev[isResizing as keyof typeof prev] + delta;
        // Min width 50px
        return { ...prev, [isResizing]: Math.max(50, newWidth) };
      });
    };

    const handleMouseUp = () => {
      setIsResizing(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // --- CONTEXT MENU HANDLER (SELECTION FIX) ---
  const handleRightClick = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();

    // UX Fix: If right-clicking a file NOT in selection, select ONLY that file.
    // If clicking a file ALREADY in selection, keep selection as is.
    if (!selectedPaths.includes(path)) {
      onSelect(path, false); // false = single selection (replaces others)
    }

    // Pass event to parent to open menu
    onContextMenu(e, path);
  };

  return (
    <div className="file-view">
      {/* HEADER */}
      <div
        className="file-header grid-row-layout"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div></div> {/* Icon Col */}
        <div className="header-cell">
          Name
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
        <div className="header-cell">
          Size
          <div
            className="resize-handle"
            onMouseDown={startResize("size")}
          ></div>
        </div>
        <div className="header-cell">
          Modified
          {/* Last col usually auto-fills, no resize handle needed on right edge usually */}
        </div>
      </div>

      {/* GO UP ROW */}
      <div
        className="file-row grid-row-layout"
        onClick={onGoUp}
        style={{ color: "#aaa", gridTemplateColumns: gridTemplate }}
      >
        <div className="icon">
          <CornerLeftUp size={16} />
        </div>
        <div className="name">...</div>
        <div className="details">Parent</div>
        <div className="details"></div>
        <div className="details"></div>
      </div>

      {/* ITEMS */}
      {entries.map((e, i) => (
        <div
          key={i}
          className={`file-row grid-row-layout ${
            selectedPaths.includes(e.path) ? "selected" : ""
          }`}
          style={{ gridTemplateColumns: gridTemplate }}
          onClick={(ev) => onSelect(e.path, ev.ctrlKey)}
          onDoubleClick={() => e.isDirectory && onNavigate(e.path)}
          onContextMenu={(ev) => handleRightClick(ev, e.path)} // UPDATED HANDLER
        >
          <div className="icon">
            {e.isDrive ? (
              <HardDrive size={16} stroke="#7aa2f7" />
            ) : e.isDirectory ? (
              <Folder size={16} stroke="#e0af68" />
            ) : (
              <File size={16} />
            )}
          </div>
          <div className="name" title={e.name}>
            {e.name}
          </div>
          <div className="details">
            {e.isDirectory ? "Folder" : e.name.split(".").pop()?.toUpperCase()}
          </div>
          <div className="details">{formatSize(e.size)}</div>
          <div className="details">{formatDate(e.modified)}</div>
        </div>
      ))}
    </div>
  );
}
