import { useState, useEffect } from "react";
import {
  Trash2,
  AlertTriangle,
  File,
  X,
  Upload,
  Loader2,
  FileX,
} from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import { BatchResult } from "../../types";

export function ShredderView() {
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const [shredding, setShredding] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isAndroid, setIsAndroid] = useState(false);

  const [showConfirm, setShowConfirm] = useState(false);

  // Drag & Drop Handler
  const { isDragging } = useDragDrop((newFiles) => {
    setDroppedFiles((prevFiles) => {
      const combined = [...prevFiles, ...newFiles];
      return [...new Set(combined)];
    });
  });

  useEffect(() => {
    try {
      const os = platform();
      setIsAndroid(os === "android");
    } catch (e) {
      /* Browser check */
    }
  }, []);

  // Handle File Picker
  async function handleBrowse() {
    try {
      const selected = await open({
        multiple: true,
        recursive: true,
      });

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        setDroppedFiles((prev) => [...new Set([...prev, ...paths])]);
      }
    } catch (e) {
      console.error("Picker failed", e);
    }
  }

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
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Scrollable Content Area */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "30px",
          display: "flex",
          flexDirection: "column",
          // Center vertically if empty, top align if has files
          justifyContent: droppedFiles.length === 0 ? "center" : "flex-start",
        }}
      >
        {/* HEADER */}
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <h2 style={{ margin: 0 }}>Secure Shredder</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
            Permanently overwrite and destroy sensitive files.
          </p>
        </div>

        {/* DROP ZONE */}
        <div
          className={`shred-zone ${isDragging ? "active" : ""}`}
          // Clickable only if empty
          onClick={droppedFiles.length === 0 ? handleBrowse : undefined}
          style={{
            borderColor: shredding ? "var(--text-dim)" : "var(--btn-danger)", // Red border for shredder
            width: "100%",
            maxWidth: "600px",
            margin: "0 auto",
            minHeight: droppedFiles.length === 0 ? "300px" : "auto", // Taller when empty
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            cursor: droppedFiles.length === 0 ? "pointer" : "default",
            marginBottom: 20,
          }}
        >
          {shredding ? (
            <div style={{ textAlign: "center" }}>
              <Loader2
                size={48}
                className="spinner"
                style={{ marginBottom: 15, color: "var(--btn-danger)" }}
              />
              <h3>Destroying Data...</h3>
              <p style={{ color: "var(--text-dim)" }}>Do not close the app.</p>
            </div>
          ) : droppedFiles.length === 0 ? (
            // EMPTY STATE
            <div style={{ textAlign: "center", opacity: 0.9 }}>
              <div
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  padding: 20,
                  borderRadius: "50%",
                  marginBottom: 20,
                  display: "inline-block",
                }}
              >
                <Trash2 size={48} color="var(--btn-danger)" />
              </div>
              <h3>Drag & Drop Files</h3>
              <p style={{ marginBottom: 20, color: "var(--text-dim)" }}>
                Files cannot be recovered after shredding.
              </p>
              <button
                className="secondary-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleBrowse();
                }}
              >
                <Upload size={16} style={{ marginRight: 8 }} /> Select Files
              </button>
            </div>
          ) : (
            // FILES SELECTED STATE
            <div style={{ width: "100%", textAlign: "left" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 15,
                  alignItems: "center",
                }}
              >
                <span style={{ fontWeight: "bold", fontSize: "1.1rem" }}>
                  {droppedFiles.length}{" "}
                  {droppedFiles.length === 1 ? "Item" : "Items"} Selected
                </span>
                <button
                  className="icon-btn-ghost"
                  onClick={handleClear}
                  style={{ fontSize: "0.8rem" }}
                >
                  Clear All
                </button>
              </div>

              <div
                style={{
                  maxHeight: "200px",
                  overflowY: "auto",
                  width: "100%",
                  marginBottom: 20,
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
                      padding: "8px 12px",
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      marginBottom: 5,
                    }}
                  >
                    <File
                      size={16}
                      style={{ flexShrink: 0, color: "var(--text-dim)" }}
                    />
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
                    <X
                      size={16}
                      style={{ cursor: "pointer", color: "var(--text-dim)" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveItem(f);
                      }}
                    />
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="secondary-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBrowse();
                  }}
                  style={{ flex: 1 }}
                >
                  Add More
                </button>
                <button
                  className="auth-btn danger-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRequestShred();
                  }}
                  disabled={shredding}
                  style={{
                    flex: 2,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                >
                  <FileX size={18} /> Shred Forever
                </button>
              </div>
            </div>
          )}

          {result && (
            <div
              style={{
                marginTop: 20,
                padding: "10px 15px",
                borderRadius: 6,
                background: result.startsWith("Error")
                  ? "rgba(239, 68, 68, 0.1)"
                  : "rgba(34, 197, 94, 0.1)",
                color: result.startsWith("Error")
                  ? "var(--btn-danger)"
                  : "#4ade80",
                fontWeight: "bold",
                fontSize: "0.9rem",
              }}
            >
              {result}
            </div>
          )}
        </div>

        {isAndroid && (
          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 10,
              color: "var(--warning)",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(234, 179, 8, 0.1)",
              padding: "10px",
              borderRadius: 8,
              maxWidth: 600,
              margin: "0 auto",
            }}
          >
            <AlertTriangle size={18} />
            <span style={{ fontSize: "0.85rem" }}>
              Android performs standard deletion due to flash memory limits.
            </span>
          </div>
        )}
      </div>

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
              <p
                style={{
                  fontSize: "1.1rem",
                  fontWeight: "bold",
                  color: "var(--text-main)",
                }}
              >
                Permanently destroy {droppedFiles.length}{" "}
                {droppedFiles.length === 1 ? "item" : "items"}?
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  marginTop: -10,
                  marginBottom: 20,
                }}
              >
                This action uses a 3-pass overwrite. It cannot be undone.
              </p>

              <div style={{ display: "flex", gap: 10 }}>
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
