// --- START OF FILE src/components/dashboard/ContextMenu.tsx ---
// Changes from original:
//   1. Added `CalendarClock` import from lucide-react.
//   2. Added "Time-Lock…" menu item for non-.qre files (between Lock and the divider).
//   3. Added `onTimeLock` optional prop — kept optional so existing call sites
//      that haven't wired it yet don't break at compile time.

import {
  Lock,
  Unlock,
  FolderPlus,
  Edit,
  Trash2,
  RefreshCw,
  Share2,
  Scissors,
  Copy,
  ClipboardPaste,
  CalendarClock,
} from "lucide-react";

interface ContextMenuProps {
  x: number;
  y: number;
  targetPath: string;
  isBackground: boolean;
  onClose: () => void;
  onAction: (action: string) => void;
  canPaste?: boolean;
  /** Called when the user clicks "Time-Lock…" — parent opens TimeLockModal. */
  onTimeLock?: (filePath: string) => void;
}

export function ContextMenu({
  x,
  y,
  targetPath,
  isBackground,
  onClose,
  onAction,
  canPaste,
  onTimeLock,
}: ContextMenuProps) {
  const isQre = targetPath.endsWith(".qre");

  // --- SMART POSITIONING ---
  const style: React.CSSProperties = {
    position: "fixed",
    width: 210,
    zIndex: 1000,
    display: "block",
    top: "auto",
    bottom: "auto",
    left: "auto",
    right: "auto",
  };

  if (x + 210 > window.innerWidth) {
    style.right = window.innerWidth - x;
  } else {
    style.left = x;
  }

  if (y > window.innerHeight / 2) {
    style.bottom = window.innerHeight - y;
  } else {
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
        {isBackground ? (
          <>
            <div className="dropdown-item" onClick={() => onAction("refresh")}>
              <RefreshCw size={16} /> Refresh
            </div>
            <div
              className="dropdown-item"
              onClick={() => onAction("new_folder")}
            >
              <FolderPlus size={16} /> New Folder
            </div>
            {canPaste && (
              <>
                <div className="dropdown-divider"></div>
                <div
                  className="dropdown-item"
                  onClick={() => onAction("paste")}
                >
                  <ClipboardPaste size={16} color="var(--accent)" /> Paste Here
                </div>
              </>
            )}
          </>
        ) : (
          <>
            {isQre ? (
              <div className="dropdown-item" onClick={() => onAction("unlock")}>
                <Unlock size={16} color="var(--btn-danger)" /> Unlock
              </div>
            ) : (
              <>
                <div className="dropdown-item" onClick={() => onAction("lock")}>
                  <Lock size={16} color="var(--btn-success)" /> Lock
                </div>

                {/* TIME-LOCK entry — only for plaintext (non-.qre) files */}
                {onTimeLock && (
                  <div
                    className="dropdown-item"
                    onClick={() => {
                      onClose();
                      onTimeLock(targetPath);
                    }}
                  >
                    <CalendarClock size={16} color="var(--accent)" />
                    Time-Lock…
                  </div>
                )}
              </>
            )}

            <div className="dropdown-divider"></div>
            <div className="dropdown-item" onClick={() => onAction("cut")}>
              <Scissors size={16} /> Cut
            </div>
            <div className="dropdown-item" onClick={() => onAction("copy")}>
              <Copy size={16} /> Copy
            </div>
            <div className="dropdown-divider"></div>
            <div className="dropdown-item" onClick={() => onAction("rename")}>
              <Edit size={16} /> Rename
            </div>
            <div className="dropdown-item" onClick={() => onAction("share")}>
              <Share2 size={16} /> Reveal in Explorer
            </div>
            <div className="dropdown-divider"></div>
            <div
              className="dropdown-item danger"
              onClick={() => onAction("delete")}
            >
              <Trash2 size={16} /> Delete
            </div>
          </>
        )}
      </div>
    </>
  );
}

// --- END OF FILE src/components/dashboard/ContextMenu.tsx ---
