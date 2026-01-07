import { useState } from "react";
import { X, FolderPlus, Edit } from "lucide-react";

interface InputModalProps {
  mode: "rename" | "create";
  initialValue: string;
  onConfirm: (val: string) => void;
  onCancel: () => void;
}

export function InputModal({
  mode,
  initialValue,
  onConfirm,
  onCancel,
}: InputModalProps) {
  const [val, setVal] = useState(initialValue);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {mode === "create" ? (
            <FolderPlus size={20} color="var(--accent)" />
          ) : (
            <Edit size={20} color="var(--accent)" />
          )}
          <h2>{mode === "create" ? "New Folder" : "Rename Item"}</h2>
          <div style={{ flex: 1 }}></div>
          <X size={20} style={{ cursor: "pointer" }} onClick={onCancel} />
        </div>
        <div className="modal-body">
          <input
            className="auth-input"
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onConfirm(val)}
          />
          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="auth-btn"
              style={{ flex: 1 }}
              onClick={() => onConfirm(val)}
            >
              {mode === "create" ? "Create" : "Rename"}
            </button>
            <button
              className="secondary-btn"
              style={{ flex: 1 }}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
