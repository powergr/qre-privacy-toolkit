import {
  Lock,
  Unlock,
  FolderPlus,
  Edit,
  Trash2,
  RefreshCw,
  Share2,
} from "lucide-react";

interface ContextMenuProps {
  x: number;
  y: number;
  targetPath: string; // The file right-clicked, or current dir if background
  isBackground: boolean;
  onClose: () => void;
  onAction: (action: string) => void;
}

export function ContextMenu({
  x,
  y,
  targetPath,
  isBackground,
  onClose,
  onAction,
}: ContextMenuProps) {
  const isQre = targetPath.endsWith(".qre");

  // --- SMART POSITIONING ---
  // We must explicitly initialize top/left/right/bottom to "auto"
  // to override the default .dropdown-menu CSS (which has top: 100%)
  const style: React.CSSProperties = {
    position: "fixed",
    width: 200,
    zIndex: 1000,
    display: "block",
    top: "auto",
    bottom: "auto",
    left: "auto",
    right: "auto",
  };

  // 1. Horizontal: If click is near right edge (within 200px), grow to the Left
  if (x + 200 > window.innerWidth) {
    // Anchor to the right side
    style.right = window.innerWidth - x;
  } else {
    // Anchor to the left side
    style.left = x;
  }

  // 2. Vertical: If click is in bottom half, grow Upwards
  if (y > window.innerHeight / 2) {
    // Anchor to the bottom
    style.bottom = window.innerHeight - y;
  } else {
    // Anchor to the top
    style.top = y;
  }

  return (
    <>
      <div
        className="modal-overlay"
        style={{ background: "transparent", zIndex: 999 }}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="dropdown-menu"
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {!isBackground && (
          <>
            <div className="dropdown-item" onClick={() => onAction("lock")}>
              <Lock size={16} color="var(--btn-success)" /> Lock
            </div>
            {isQre && (
              <div className="dropdown-item" onClick={() => onAction("unlock")}>
                <Unlock size={16} color="var(--btn-danger)" /> Unlock
              </div>
            )}
            <div className="dropdown-divider"></div>
            <div className="dropdown-item" onClick={() => onAction("rename")}>
              <Edit size={16} /> Rename
            </div>
            <div
              className="dropdown-item danger"
              onClick={() => onAction("delete")}
            >
              <Trash2 size={16} /> Delete
            </div>
            <div className="dropdown-divider"></div>
          </>
        )}

        <div className="dropdown-item" onClick={() => onAction("new_folder")}>
          <FolderPlus size={16} /> New Folder
        </div>
        <div className="dropdown-item" onClick={() => onAction("refresh")}>
          <RefreshCw size={16} /> Refresh
        </div>
        {!isBackground && (
          <div className="dropdown-item" onClick={() => onAction("share")}>
            <Share2 size={16} /> Reveal in Explorer
          </div>
        )}
      </div>
    </>
  );
}
