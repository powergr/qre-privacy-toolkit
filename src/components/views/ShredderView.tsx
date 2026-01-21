import { useState, useEffect } from "react";
import { Trash2, AlertTriangle, File, X } from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { BatchResult } from "../../types";

export function ShredderView() {
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const [shredding, setShredding] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isAndroid, setIsAndroid] = useState(false);

  const [showConfirm, setShowConfirm] = useState(false);

  // FIX: Append new files to the list instead of overwriting
  const { isDragging } = useDragDrop((newFiles) => {
    setDroppedFiles((prevFiles) => {
      // Combine old list + new files
      const combined = [...prevFiles, ...newFiles];
      // Remove duplicates (using Set) and return
      return [...new Set(combined)];
    });
  });

  useEffect(() => {
    try {
      const os = platform();
      setIsAndroid(os === "android");
    } catch (e) {
      /* Ignore browser dev mode */
    }
  }, []);

  function handleClear() {
    setDroppedFiles([]);
    setResult(null);
  }

  function handleRemoveItem(pathToRemove: string) {
    setDroppedFiles((prev) => prev.filter((p) => p !== pathToRemove));
  }

  function handleRequestShred() {
    if (droppedFiles.length === 0) return;
    setShowConfirm(true);
  }

  async function executeShred() {
    setShowConfirm(false);
    setShredding(true);
    setResult(null);

    try {
      await invoke<BatchResult[]>("delete_items", { paths: droppedFiles });
      setResult("Files destroyed successfully.");
      setDroppedFiles([]);
    } catch (e) {
      setResult("Error: " + String(e));
    } finally {
      setShredding(false);
      setTimeout(() => setResult(null), 3000);
    }
  }

  return (
    <div className="shredder-view">
      <div className={`shred-zone ${isDragging ? "active" : ""}`}>
        <Trash2
          size={64}
          color="var(--btn-danger)"
          style={{ marginBottom: 20 }}
        />
        <h2>Secure Shredder</h2>
        <p style={{ color: "var(--text-dim)" }}>
          Drag files here to permanently destroy them.
        </p>

        {droppedFiles.length > 0 && (
          <div
            style={{
              margin: "20px 0",
              textAlign: "left",
              maxHeight: "150px",
              overflowY: "auto",
              width: "100%",
            }}
          >
            {droppedFiles.map((f, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  fontSize: "0.9rem",
                  padding: "4px 10px",
                  background: "rgba(0,0,0,0.2)",
                  borderRadius: 4,
                  marginBottom: 2,
                }}
              >
                <File size={14} style={{ flexShrink: 0 }} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                  }}
                >
                  {f.split(/[/\\]/).pop()}
                </span>
                {/* Small X button to remove individual items */}
                <X
                  size={14}
                  style={{ cursor: "pointer", color: "var(--text-dim)" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveItem(f);
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {droppedFiles.length > 0 && (
          <div
            style={{ display: "flex", gap: 10, marginTop: 20, width: "100%" }}
          >
            <button
              className="secondary-btn"
              onClick={handleClear}
              style={{ flex: 1 }}
            >
              Clear List
            </button>
            <button
              className="auth-btn danger-btn"
              onClick={handleRequestShred}
              disabled={shredding}
              style={{ flex: 2 }}
            >
              {shredding ? "Shredding..." : "Shred Forever"}
            </button>
          </div>
        )}

        {result && (
          <p
            style={{
              color: result.startsWith("Error")
                ? "var(--btn-danger)"
                : "var(--btn-success)",
              marginTop: 20,
              fontWeight: "bold",
            }}
          >
            {result}
          </p>
        )}
      </div>

      {isAndroid && (
        <div
          style={{
            marginTop: 30,
            display: "flex",
            gap: 10,
            color: "var(--warning)",
            alignItems: "center",
          }}
        >
          <AlertTriangle size={18} />
          <span style={{ fontSize: "0.8rem" }}>
            On Android, this performs standard deletion due to hardware limits.
          </span>
        </div>
      )}

      {/* CONFIRMATION MODAL */}
      {showConfirm && (
        <div className="modal-overlay" style={{ zIndex: 100000 }}>
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Trash2 size={20} color="var(--btn-danger)" />
              <h2 style={{ color: "var(--btn-danger)" }}>Confirm Deletion</h2>
              <div style={{ flex: 1 }}></div>
              <X
                size={20}
                style={{ cursor: "pointer" }}
                onClick={() => setShowConfirm(false)}
              />
            </div>
            <div className="modal-body" style={{ textAlign: "center" }}>
              <p style={{ fontSize: "1.1rem", fontWeight: "bold" }}>
                Permanently destroy {droppedFiles.length} files?
              </p>
              <p style={{ color: "var(--text-dim)", marginTop: -10 }}>
                This action cannot be undone.
              </p>

              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => setShowConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn danger-btn"
                  style={{ flex: 1 }}
                  onClick={executeShred}
                >
                  Yes, Shred
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
