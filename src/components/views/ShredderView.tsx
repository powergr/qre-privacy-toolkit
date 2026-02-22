import { useState, useEffect } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  Trash2,
  AlertTriangle,
  File,
  X,
  Upload,
  Loader2,
  FileX,
  Eye,
  Flame,
  Shield,
  Zap,
  Info,
} from "lucide-react";
import { useDragDrop } from "../../hooks/useDragDrop";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";

interface ShredProgress {
  current_file: number;
  total_files: number;
  current_pass: number;
  total_passes: number;
  current_file_name: string;
  percentage: number;
  bytes_processed: number;
  total_bytes: number;
}

interface ShredResult {
  success: string[];
  failed: FailedFile[];
  total_files: number;
  total_bytes_shredded: number;
}

interface FailedFile {
  path: string;
  error: string;
}

interface FileInfo {
  path: string;
  name: string;
  size: number;
  is_directory: boolean;
  file_count: number;
  warning?: string;
}

interface DryRunResult {
  files: FileInfo[];
  total_size: number;
  total_file_count: number;
  warnings: string[];
  blocked: string[];
}

type ShredMethod = "simple" | "dod3pass" | "dod7pass" | "gutmann";

const formatSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
};

export function ShredderView() {
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const [shredding, setShredding] = useState(false);
  const [result, setResult] = useState<ShredResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAndroid, setIsAndroid] = useState(false);

  const [showConfirm, setShowConfirm] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);

  const [method, setMethod] = useState<ShredMethod>("dod3pass");
  const [progress, setProgress] = useState<ShredProgress | null>(null);

  // Drag & Drop Handler
  const { isDragging } = useDragDrop((newFiles) => {
    if (isAndroid) {
      setError("File shredding is not available on Android devices");
      return;
    }
    setDroppedFiles((prevFiles) => {
      const combined = [...prevFiles, ...newFiles];
      return [...new Set(combined)];
    });
  });

  // Progress listener
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    async function setupProgressListener() {
      unlisten = await listen<ShredProgress>("shred-progress", (event) => {
        setProgress(event.payload);
      });
    }

    setupProgressListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    try {
      const os = platform();
      if (os === "android") {
        setIsAndroid(true);
        setError("Secure file shredding is not available on Android devices due to flash memory limitations");
      }
    } catch (e) {
      /* Browser check */
    }
  }, []);

  // Handle File Picker
  async function handleBrowse() {
    if (isAndroid) {
      setError("File shredding is not available on Android devices");
      return;
    }

    try {
      const selected = await open({
        multiple: true,
        title: "Select files to shred",
      });

      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        setDroppedFiles((prev) => [...new Set([...prev, ...paths])]);
      }
    } catch (e) {
      setError("Failed to open file dialog: " + e);
    }
  }

  async function handlePreview() {
    if (droppedFiles.length === 0) return;

    setShowPreview(true);
    setError(null);

    try {
      const res = await invoke<DryRunResult>("dry_run_shred", {
        paths: droppedFiles,
      });
      setDryRunResult(res);

      if (res.blocked.length > 0) {
        setError(
          `${res.blocked.length} file(s) blocked: ${res.blocked.slice(0, 3).join("; ")}${res.blocked.length > 3 ? "..." : ""}`
        );
      }
    } catch (e) {
      setError("Preview failed: " + e);
      setShowPreview(false);
    }
  }

  function handleClear() {
    setDroppedFiles([]);
    setResult(null);
    setError(null);
    setShowPreview(false);
    setDryRunResult(null);
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
    setError(null);
    setResult(null);
    setProgress(null);
    setShowPreview(false);

    try {
      const res = await invoke<ShredResult>("batch_shred_files", {
        paths: droppedFiles,
        method: method,
      });
      setResult(res);
      setDroppedFiles([]);
    } catch (e) {
      setError("Shredding failed: " + e);
    } finally {
      setShredding(false);
      setProgress(null);
    }
  }

  async function cancelShred() {
    try {
      await invoke("cancel_shred");
      setError("Shredding cancelled by user");
      setShredding(false);
    } catch (e) {
      console.error("Failed to cancel:", e);
    }
  }

  const methodInfo = {
    simple: { name: "Simple (1 pass)", icon: Zap, time: "Fastest", security: "Low" },
    dod3pass: { name: "DoD 3-Pass", icon: Shield, time: "Fast", security: "High" },
    dod7pass: { name: "DoD 7-Pass", icon: Shield, time: "Moderate", security: "Very High" },
    gutmann: { name: "Gutmann (35 pass)", icon: Flame, time: "Slow", security: "Maximum" },
  };

  // Block all actions if Android
  if (isAndroid) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 40,
          textAlign: "center",
        }}
      >
        <div
          style={{
            background: "rgba(239, 68, 68, 0.1)",
            padding: 25,
            borderRadius: "50%",
            marginBottom: 20,
          }}
        >
          <AlertTriangle size={64} color="var(--btn-danger)" />
        </div>
        <h2>Not Available on Android</h2>
        <p style={{ color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 400 }}>
          Secure file shredding requires direct disk access and multiple overwrites,
          which is not supported on Android due to flash memory wear leveling and
          system restrictions.
        </p>
      </div>
    );
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
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "30px",
          display: "flex",
          flexDirection: "column",
          justifyContent:
            droppedFiles.length === 0 && !result ? "center" : "flex-start",
        }}
      >
        {/* HEADER */}
        <div
          style={{
            textAlign: "center",
            marginBottom: droppedFiles.length > 0 || result ? 20 : 40,
          }}
        >
          <h2 style={{ margin: 0 }}>Secure Shredder</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
            Permanently overwrite and destroy sensitive files.
          </p>
        </div>

        {/* ERROR BANNER */}
        {error && (
          <div
            style={{
              maxWidth: 700,
              margin: "0 auto 20px auto",
              padding: 12,
              background: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: 8,
              color: "var(--btn-danger)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <AlertTriangle size={18} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{error}</span>
            <button
              onClick={() => setError(null)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                padding: 4,
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* RESULT STATE */}
        {result && (
          <div style={{ maxWidth: 700, margin: "0 auto", width: "100%" }}>
            <div
              className="modern-card"
              style={{
                padding: 30,
                textAlign: "center",
                marginBottom: 20,
              }}
            >
              {(() => {
                const isTotalFailure = result.success.length === 0 && result.failed.length > 0;
                const isPartial = result.success.length > 0 && result.failed.length > 0;
                
                const titleColor = isTotalFailure ? "var(--btn-danger)" : isPartial ? "#f59e0b" : "#4ade80";
                const StatusIcon = isTotalFailure ? AlertTriangle : isPartial ? AlertTriangle : FileX;
                const titleText = isTotalFailure ? "Shredding Failed" : isPartial ? "Partial Success" : "Shredding Complete!";

                return (
                  <>
                    <StatusIcon size={64} color={titleColor} style={{ marginBottom: 20 }} />
                    <h2 style={{ color: titleColor }}>{titleText}</h2>
                  </>
                );
              })()}

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: 20,
                  marginTop: 20,
                  textAlign: "left",
                }}
              >
                <div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginBottom: 5 }}>
                    Files Destroyed:
                  </div>
                  <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: result.success.length > 0 ? "#4ade80" : "var(--text-dim)" }}>
                    {result.success.length}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-dim)", marginBottom: 5 }}>
                    Data Shredded:
                  </div>
                  <div style={{ fontSize: "1.5rem", fontWeight: "bold", color: result.success.length > 0 ? "#4ade80" : "var(--text-dim)" }}>
                    {formatSize(result.total_bytes_shredded)}
                  </div>
                </div>
              </div>

              {result.failed.length > 0 && (
                <div
                  style={{
                    marginTop: 20,
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    borderRadius: 8,
                    padding: 15,
                    textAlign: "left",
                  }}
                >
                  <h4
                    style={{
                      margin: "0 0 10px 0",
                      fontSize: "0.9rem",
                      color: "var(--btn-danger)",
                    }}
                  >
                    Failed to shred {result.failed.length} file(s):
                  </h4>
                  <div
                    style={{
                      maxHeight: 150,
                      overflowY: "auto",
                      fontSize: "0.8rem",
                      color: "var(--text-dim)",
                    }}
                  >
                    {result.failed.slice(0, 10).map((fail, i) => (
                      <div
                        key={i}
                        style={{
                          marginBottom: 8,
                          fontFamily: "monospace",
                        }}
                      >
                        <div style={{ fontWeight: "bold" }}>
                          {fail.path.split(/[/\\]/).pop()}
                        </div>
                        <div style={{ paddingLeft: 10, fontSize: "0.75rem" }}>
                          • {fail.error}
                        </div>
                      </div>
                    ))}
                    {result.failed.length > 10 && (
                      <div style={{ marginTop: 5, fontStyle: "italic" }}>
                        ... and {result.failed.length - 10} more
                      </div>
                    )}
                  </div>
                </div>
              )}

              <button
                className="auth-btn"
                onClick={handleClear}
                style={{ marginTop: 20 }}
              >
                Shred More Files
              </button>
            </div>
          </div>
        )}

        {/* SHREDDING PROGRESS */}
        {shredding && progress && (
          <div style={{ maxWidth: 600, margin: "0 auto", width: "100%" }}>
            <div
              className="modern-card"
              style={{
                padding: 30,
                textAlign: "center",
              }}
            >
              <Loader2
                size={48}
                className="spinner"
                style={{ marginBottom: 20, color: "var(--btn-danger)" }}
              />
              <h3>Shredding Files...</h3>

              <div
                style={{
                  width: "100%",
                  background: "var(--border)",
                  height: 8,
                  borderRadius: 4,
                  overflow: "hidden",
                  margin: "20px 0",
                }}
              >
                <div
                  style={{
                    width: `${progress.percentage}%`,
                    height: "100%",
                    background: "var(--btn-danger)",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>

              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                File {progress.current_file} of {progress.total_files} • Pass{" "}
                {progress.current_pass} of {progress.total_passes}
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.85rem",
                  marginTop: 10,
                  wordBreak: "break-all",
                }}
              >
                {progress.current_file_name}
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.8rem",
                  marginTop: 5,
                }}
              >
                {formatSize(progress.bytes_processed)} processed
              </p>

              <button
                className="secondary-btn"
                onClick={cancelShred}
                style={{ marginTop: 20 }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* PREVIEW STATE */}
        {showPreview && dryRunResult && !shredding && !result && (
          <div style={{ maxWidth: 700, margin: "0 auto", width: "100%" }}>
            <div
              className="modern-card"
              style={{
                padding: 20,
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 15,
                }}
              >
                <h3 style={{ margin: 0 }}>Preview: Files to be Shredded</h3>
                <button
                  onClick={() => setShowPreview(false)}
                  className="icon-btn-ghost"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Summary */}
              <div
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  borderRadius: 8,
                  padding: 15,
                  marginBottom: 15,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 10,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-dim)",
                      }}
                    >
                      Total Files:
                    </div>
                    <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                      {dryRunResult.total_file_count}
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-dim)",
                      }}
                    >
                      Total Size:
                    </div>
                    <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                      {formatSize(dryRunResult.total_size)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Warnings */}
              {dryRunResult.warnings.length > 0 && (
                <div
                  style={{
                    background: "rgba(245, 158, 11, 0.1)",
                    border: "1px solid rgba(245, 158, 11, 0.3)",
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 15,
                  }}
                >
                  <h4
                    style={{
                      margin: "0 0 8px 0",
                      fontSize: "0.9rem",
                      color: "#f59e0b",
                    }}
                  >
                    Warnings:
                  </h4>
                  {dryRunResult.warnings.map((warning, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-dim)",
                        marginBottom: 4,
                      }}
                    >
                      • {warning}
                    </div>
                  ))}
                </div>
              )}

              {/* File List */}
              <div>
                <h4 style={{ margin: "0 0 10px 0", fontSize: "0.9rem" }}>
                  Files ({dryRunResult.files.length}):
                </h4>
                <div
                  style={{
                    maxHeight: "300px",
                    overflowY: "auto",
                    background: "var(--bg-color)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                  }}
                >
                  {dryRunResult.files.map((file, i) => (
                    <div
                      key={i}
                      style={{
                        padding: "10px",
                        borderBottom:
                          i < dryRunResult.files.length - 1
                            ? "1px solid var(--border)"
                            : "none",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "0.85rem",
                            fontWeight: 500,
                          }}
                        >
                          {file.name}
                        </span>
                        <span
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-dim)",
                          }}
                        >
                          {formatSize(file.size)}
                        </span>
                      </div>
                      {file.warning && (
                        <div
                          style={{
                            fontSize: "0.75rem",
                            color: "#f59e0b",
                            marginTop: 5,
                          }}
                        >
                          ⚠️ {file.warning}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                className="secondary-btn"
                onClick={() => setShowPreview(false)}
              >
                Back
              </button>
              <button
                className="auth-btn danger-btn"
                onClick={handleRequestShred}
              >
                <FileX size={16} style={{ marginRight: 8 }} />
                Confirm & Shred
              </button>
            </div>
          </div>
        )}

        {/* FILE SELECTION STATE */}
        {!shredding && !result && !showPreview && (
          <>
            {/* DROP ZONE */}
            <div
              className={`shred-zone ${isDragging ? "active" : ""}`}
              onClick={droppedFiles.length === 0 ? handleBrowse : undefined}
              style={{
                borderColor: "var(--btn-danger)",
                width: "100%",
                maxWidth: "600px",
                margin: "0 auto",
                minHeight: droppedFiles.length === 0 ? "300px" : "auto",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                cursor: droppedFiles.length === 0 ? "pointer" : "default",
                marginBottom: 20,
              }}
            >
              {droppedFiles.length === 0 ? (
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
                    <Upload size={16} style={{ marginRight: 8 }} /> Select
                    Files
                  </button>
                </div>
              ) : (
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
                      {droppedFiles.length === 1 ? "File" : "Files"} Selected
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
                          style={{
                            cursor: "pointer",
                            color: "var(--text-dim)",
                          }}
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
                      className="secondary-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePreview();
                      }}
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                      }}
                    >
                      <Eye size={16} /> Preview
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* METHOD SELECTOR */}
            {droppedFiles.length > 0 && (
              <div
                style={{
                  maxWidth: 600,
                  margin: "0 auto 20px auto",
                  width: "100%",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  <Shield size={16} />
                  <h4 style={{ margin: 0, fontSize: "0.9rem" }}>
                    Shredding Method
                  </h4>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, 1fr)",
                    gap: 10,
                  }}
                >
                  {(Object.keys(methodInfo) as ShredMethod[]).map((m) => {
                    const info = methodInfo[m];
                    const Icon = info.icon;
                    return (
                      <div
                        key={m}
                        onClick={() => setMethod(m)}
                        style={{
                          padding: 12,
                          border: `2px solid ${method === m ? "var(--accent)" : "var(--border)"}`,
                          borderRadius: 8,
                          cursor: "pointer",
                          background:
                            method === m
                              ? "rgba(0, 122, 204, 0.05)"
                              : "var(--bg-card)",
                          transition: "all 0.2s",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 5,
                          }}
                        >
                          <Icon size={16} />
                          <span
                            style={{
                              fontWeight: 600,
                              fontSize: "0.85rem",
                            }}
                          >
                            {info.name}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--text-dim)",
                          }}
                        >
                          {info.time} • {info.security} Security
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div
                  style={{
                    marginTop: 10,
                    padding: 10,
                    background: "rgba(59, 130, 246, 0.1)",
                    border: "1px solid rgba(59, 130, 246, 0.3)",
                    borderRadius: 6,
                    fontSize: "0.8rem",
                    color: "var(--text-dim)",
                    display: "flex",
                    gap: 8,
                  }}
                >
                  <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    <strong>Recommended:</strong> DoD 3-Pass provides excellent
                    security with reasonable speed. </span> <span><strong>WARNING:</strong> If you select Gutmann, overwriting is ineffective and causes physical damage to Solid State Drives (SSDs)
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* FOOTER ACTION */}
      {droppedFiles.length > 0 && !shredding && !result && !showPreview && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            background: "var(--panel-bg)",
            padding: 20,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <button
            className="auth-btn danger-btn"
            onClick={handleRequestShred}
            style={{
              width: "100%",
              maxWidth: "300px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
            }}
          >
            <FileX size={18} /> Shred {droppedFiles.length} File
            {droppedFiles.length !== 1 ? "s" : ""}
          </button>
        </div>
      )}

      {/* CONFIRMATION MODAL */}
      {showConfirm && (
        <div className="modal-overlay" style={{ zIndex: 100000 }}>
          <div className="auth-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Trash2 size={20} color="var(--btn-danger)" />
              <h2 style={{ color: "var(--btn-danger)" }}>
                Confirm Permanent Deletion
              </h2>
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
                {droppedFiles.length === 1 ? "file" : "files"}?
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  marginTop: -10,
                  marginBottom: 20,
                }}
              >
                Using {methodInfo[method].name} method. This action cannot be
                undone.
              </p>

              <div
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 20,
                  textAlign: "left",
                  fontSize: "0.85rem",
                }}
              >
                <strong>⚠️ Warning:</strong> Files will be overwritten{" "}
                {method === "gutmann"
                  ? "35"
                  : method === "dod7pass"
                    ? "7"
                    : method === "dod3pass"
                      ? "3"
                      : "1"}{" "}
                time(s) before deletion. Recovery will be impossible.
              </div>

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
                  Yes, Shred Forever
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
