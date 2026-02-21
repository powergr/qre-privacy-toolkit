import { useState, useEffect } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  ScanSearch,
  MapPin,
  User,
  Calendar,
  Camera,
  CheckCircle,
  X,
  Upload,
  Sliders,
  FileText,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Loader2,
  AlertTriangle,
  Folder,
  Info,
  TrendingDown,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useDragDrop } from "../../hooks/useDragDrop";

interface MetaTag {
  key: string;
  value: string;
}

interface MetaReport {
  has_gps: boolean;
  has_author: boolean;
  camera_info?: string;
  software_info?: string;
  creation_date?: string;
  gps_info?: string;
  file_type: string;
  file_size: number;
  raw_tags: MetaTag[];
}

interface CleanProgress {
  current: number;
  total: number;
  current_file: string;
  percentage: number;
}

interface CleanResult {
  success: string[];
  failed: FailedFile[];
  total_files: number;
  size_before: number;
  size_after: number;
}

interface FailedFile {
  path: string;
  error: string;
}

const formatSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
};

export function CleanerView() {
  const [files, setFiles] = useState<string[]>([]);
  const [loading] = useState(false);
  const [result, setResult] = useState<CleanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewReport, setPreviewReport] = useState<MetaReport | null>(null);
  const [analyzingPreview, setAnalyzingPreview] = useState(false);

  const [showRaw, setShowRaw] = useState(false);
  const [opts, setOpts] = useState({ gps: true, author: true, date: true });

  const [outputDir, setOutputDir] = useState<string | null>(null);

  // Progress tracking
  const [cleaning, setCleaning] = useState(false);
  const [progress, setProgress] = useState<CleanProgress | null>(null);

  const { isDragging } = useDragDrop(async (newFiles) => {
    addFiles(newFiles);
  });

  // Progress event listener
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    async function setupProgressListener() {
      unlisten = await listen<CleanProgress>(
        "clean-metadata-progress",
        (event) => {
          setProgress(event.payload);
        },
      );
    }

    setupProgressListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const addFiles = (newPaths: string[]) => {
    setError(null);
    const unique = [...new Set([...files, ...newPaths])];
    setFiles(unique);
    if (files.length === 0 && newPaths.length > 0) {
      setPreviewIndex(0);
      analyze(newPaths[0]);
    }
  };

  async function handleBrowse() {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Media & Docs",
            extensions: [
              "jpg",
              "jpeg",
              "png",
              "webp",
              "tiff",
              "pdf",
              "docx",
              "xlsx",
              "pptx",
              "zip",
            ],
          },
        ],
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        addFiles(paths);
      }
    } catch (e) {
      setError("Failed to open file dialog: " + e);
    }
  }

  async function selectOutputDir() {
    try {
      const selected = await open({
        directory: true,
        title: "Select output directory for cleaned files",
      });
      if (selected && typeof selected === "string") {
        setOutputDir(selected);
      }
    } catch (e) {
      setError("Failed to select output directory: " + e);
    }
  }

  async function analyze(path: string) {
    setAnalyzingPreview(true);
    setPreviewReport(null);
    setError(null);
    try {
      const res = await invoke<MetaReport>("analyze_file_metadata", { path });
      setPreviewReport(res);
    } catch (e) {
      setError("Analysis failed: " + e);
    } finally {
      setAnalyzingPreview(false);
    }
  }

  async function cleanAll() {
    if (files.length === 0) return;

    setCleaning(true);
    setError(null);
    setResult(null);
    setProgress(null);

    try {
      const res = await invoke<CleanResult>("batch_clean_metadata", {
        paths: files,
        outputDir: outputDir,
        options: opts,
      });
      setResult(res);
      setFiles([]);
      setPreviewReport(null);
      setPreviewIndex(0);
      setShowRaw(false);
    } catch (e) {
      setError("Cleaning failed: " + e);
    } finally {
      setCleaning(false);
      setProgress(null);
    }
  }

  async function cancelClean() {
    try {
      await invoke("cancel_metadata_clean");
      setError("Cleaning cancelled by user");
      setCleaning(false);
    } catch (e) {
      console.error("Failed to cancel:", e);
    }
  }

  function removeFile(path: string) {
    const idxToRemove = files.indexOf(path);
    const newFiles = files.filter((f) => f !== path);
    setFiles(newFiles);

    if (newFiles.length === 0) {
      setPreviewReport(null);
      setPreviewIndex(0);
    } else {
      if (idxToRemove === previewIndex) {
        const newIdx =
          idxToRemove >= newFiles.length ? newFiles.length - 1 : idxToRemove;
        setPreviewIndex(newIdx);
        analyze(newFiles[newIdx]);
      } else if (idxToRemove < previewIndex) {
        setPreviewIndex(previewIndex - 1);
      }
    }
  }

  const handleNext = () => {
    if (previewIndex < files.length - 1) {
      const newIdx = previewIndex + 1;
      setPreviewIndex(newIdx);
      analyze(files[newIdx]);
    }
  };

  const handlePrev = () => {
    if (previewIndex > 0) {
      const newIdx = previewIndex - 1;
      setPreviewIndex(newIdx);
      analyze(files[newIdx]);
    }
  };

  const currentFileName = files[previewIndex]
    ? files[previewIndex].split(/[/\\]/).pop()
    : "Unknown";

  const hasMetadata =
    previewReport &&
    (previewReport.has_gps ||
      previewReport.has_author ||
      previewReport.camera_info ||
      previewReport.creation_date);

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
            files.length === 0 && !result ? "center" : "flex-start",
        }}
      >
        {/* HEADER */}
        <div
          style={{
            textAlign: "center",
            marginBottom: files.length > 0 || result ? 20 : 40,
          }}
        >
          <h2 style={{ margin: 0 }}>Metadata Cleaner</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
            Remove hidden GPS location, camera details, and personal data.
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

        {/* EMPTY STATE / DROP ZONE */}
        {files.length === 0 && !result && (
          <div
            className={`shred-zone ${isDragging ? "active" : ""}`}
            style={{
              width: "100%",
              maxWidth: "500px",
              margin: "0 auto",
              minHeight: "300px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "40px",
              cursor: "pointer",
              borderColor: isDragging ? "var(--accent)" : "var(--border)",
            }}
            onClick={handleBrowse}
          >
            <div
              style={{
                background: "rgba(234, 179, 8, 0.1)",
                padding: 20,
                borderRadius: "50%",
                marginBottom: 20,
              }}
            >
              <ScanSearch size={48} color="#eab308" />
            </div>
            <h3>Drag & Drop Files</h3>
            <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
              or click to select
            </p>
            <button className="secondary-btn">
              <Upload size={16} style={{ marginRight: 8 }} /> Select Files
            </button>
            <p
              style={{
                fontSize: "0.8rem",
                color: "var(--text-dim)",
                marginTop: 20,
              }}
            >
              Supports: JPG, PNG, PDF, DOCX, XLSX, PPTX, ZIP
            </p>
            <p
              style={{
                fontSize: "0.75rem",
                color: "var(--text-dim)",
                marginTop: 5,
              }}
            >
              Maximum file size: 100 MB
            </p>
          </div>
        )}

        {/* CLEANING PROGRESS */}
        {cleaning && progress && (
          <div
            style={{
              maxWidth: 600,
              margin: "0 auto",
              width: "100%",
            }}
          >
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
                style={{ marginBottom: 20 }}
              />
              <h3>Cleaning Metadata...</h3>

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
                    background: "var(--accent)",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>

              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                {progress.percentage}% - {progress.current} of {progress.total}{" "}
                files
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.85rem",
                  marginTop: 10,
                  wordBreak: "break-all",
                }}
              >
                {progress.current_file}
              </p>

              <button
                className="secondary-btn"
                onClick={cancelClean}
                style={{ marginTop: 20 }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* RESULT STATE */}
        {result && (
          <div
            style={{
              maxWidth: 700,
              margin: "0 auto",
              width: "100%",
            }}
          >
            <div
              className="modern-card"
              style={{
                padding: 30,
                textAlign: "center",
                marginBottom: 20,
              }}
            >
              <CheckCircle
                size={64}
                color="#4ade80"
                style={{ marginBottom: 20 }}
              />
              <h2>Cleaning Complete!</h2>

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
                  <div
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--text-dim)",
                      marginBottom: 5,
                    }}
                  >
                    Files Processed:
                  </div>
                  <div
                    style={{
                      fontSize: "1.5rem",
                      fontWeight: "bold",
                      color: "var(--text-main)",
                    }}
                  >
                    {result.success.length}
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--text-dim)",
                      marginBottom: 5,
                    }}
                  >
                    Size Reduction:
                  </div>
                  <div
                    style={{
                      fontSize: "1.5rem",
                      fontWeight: "bold",
                      color: "#4ade80",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <TrendingDown size={20} />
                    {formatSize(result.size_before - result.size_after)}
                  </div>
                </div>
              </div>

              {result.size_before > 0 && (
                <div
                  style={{
                    marginTop: 20,
                    fontSize: "0.85rem",
                    color: "var(--text-dim)",
                  }}
                >
                  Before: {formatSize(result.size_before)} → After:{" "}
                  {formatSize(result.size_after)}
                </div>
              )}

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
                    Failed to clean {result.failed.length} file(s):
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
                onClick={() => {
                  setResult(null);
                  setOutputDir(null);
                }}
                style={{ marginTop: 20 }}
              >
                Clean More Files
              </button>
            </div>
          </div>
        )}

        {/* FILE PREVIEW & OPTIONS */}
        {files.length > 0 && !cleaning && !result && (
          <div style={{ maxWidth: 900, margin: "0 auto", width: "100%" }}>
            <div style={{ display: "flex", gap: 20 }}>
              {/* LEFT: File List */}
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "1rem" }}>
                    Files ({files.length})
                  </h3>
                  <button
                    className="icon-btn-ghost"
                    onClick={() => {
                      setFiles([]);
                      setPreviewReport(null);
                      setPreviewIndex(0);
                    }}
                    title="Clear all"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div
                  className="modern-card"
                  style={{
                    padding: 0,
                    maxHeight: "400px",
                    overflowY: "auto",
                  }}
                >
                  {files.map((file, idx) => (
                    <div
                      key={file}
                      onClick={() => {
                        setPreviewIndex(idx);
                        analyze(file);
                      }}
                      style={{
                        padding: "12px 15px",
                        borderBottom:
                          idx < files.length - 1
                            ? "1px solid var(--border)"
                            : "none",
                        cursor: "pointer",
                        background:
                          idx === previewIndex
                            ? "rgba(0, 122, 204, 0.1)"
                            : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        transition: "background 0.2s",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: "0.9rem",
                            fontWeight: idx === previewIndex ? 600 : 400,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {file.split(/[/\\]/).pop()}
                        </div>
                      </div>
                      <button
                        className="icon-btn-ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFile(file);
                        }}
                        style={{ marginLeft: 10 }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  className="secondary-btn"
                  onClick={handleBrowse}
                  style={{
                    width: "100%",
                    marginTop: 10,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                >
                  <Upload size={16} /> Add More Files
                </button>
              </div>

              {/* RIGHT: Preview */}
              <div style={{ flex: 2 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "1rem" }}>Preview</h3>
                  <div style={{ display: "flex", gap: 5 }}>
                    <button
                      className="icon-btn-ghost"
                      onClick={handlePrev}
                      disabled={previewIndex === 0}
                      title="Previous"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      className="icon-btn-ghost"
                      onClick={handleNext}
                      disabled={previewIndex >= files.length - 1}
                      title="Next"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>

                <div className="modern-card" style={{ padding: 20 }}>
                  {analyzingPreview && (
                    <div
                      style={{
                        textAlign: "center",
                        padding: 40,
                      }}
                    >
                      <Loader2 size={32} className="spinner" />
                      <p
                        style={{
                          color: "var(--text-dim)",
                          marginTop: 10,
                        }}
                      >
                        Analyzing...
                      </p>
                    </div>
                  )}

                  {!analyzingPreview && previewReport && (
                    <>
                      <div style={{ marginBottom: 20 }}>
                        <div
                          style={{
                            fontSize: "0.9rem",
                            fontWeight: 600,
                            marginBottom: 5,
                            wordBreak: "break-all",
                          }}
                        >
                          {currentFileName}
                        </div>
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "var(--text-dim)",
                          }}
                        >
                          {previewReport.file_type} •{" "}
                          {formatSize(previewReport.file_size)}
                        </div>
                      </div>

                      {!hasMetadata && (
                        <div
                          style={{
                            background: "rgba(74, 222, 128, 0.1)",
                            border: "1px solid rgba(74, 222, 128, 0.3)",
                            borderRadius: 8,
                            padding: 15,
                            textAlign: "center",
                          }}
                        >
                          <CheckCircle size={32} color="#4ade80" />
                          <p
                            style={{
                              margin: "10px 0 0 0",
                              color: "#4ade80",
                              fontWeight: 600,
                            }}
                          >
                            No metadata detected
                          </p>
                        </div>
                      )}

                      {hasMetadata && (
                        <>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(2, 1fr)",
                              gap: 15,
                              marginBottom: 20,
                            }}
                          >
                            {previewReport.has_gps && (
                              <div
                                style={{
                                  background: "rgba(239, 68, 68, 0.1)",
                                  border: "1px solid rgba(239, 68, 68, 0.3)",
                                  borderRadius: 8,
                                  padding: 12,
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
                                  <MapPin size={16} color="#ef4444" />
                                  <span
                                    style={{
                                      fontSize: "0.85rem",
                                      fontWeight: 600,
                                      color: "#ef4444",
                                    }}
                                  >
                                    GPS Location
                                  </span>
                                </div>
                                {previewReport.gps_info && (
                                  <div
                                    style={{
                                      fontSize: "0.75rem",
                                      color: "var(--text-dim)",
                                      marginTop: 5,
                                    }}
                                  >
                                    {previewReport.gps_info}
                                  </div>
                                )}
                              </div>
                            )}

                            {previewReport.has_author && (
                              <div
                                style={{
                                  background: "rgba(245, 158, 11, 0.1)",
                                  border: "1px solid rgba(245, 158, 11, 0.3)",
                                  borderRadius: 8,
                                  padding: 12,
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
                                  <User size={16} color="#f59e0b" />
                                  <span
                                    style={{
                                      fontSize: "0.85rem",
                                      fontWeight: 600,
                                      color: "#f59e0b",
                                    }}
                                  >
                                    Author Info
                                  </span>
                                </div>
                              </div>
                            )}

                            {previewReport.camera_info && (
                              <div
                                style={{
                                  background: "rgba(59, 130, 246, 0.1)",
                                  border: "1px solid rgba(59, 130, 246, 0.3)",
                                  borderRadius: 8,
                                  padding: 12,
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
                                  <Camera size={16} color="#3b82f6" />
                                  <span
                                    style={{
                                      fontSize: "0.85rem",
                                      fontWeight: 600,
                                      color: "#3b82f6",
                                    }}
                                  >
                                    Camera
                                  </span>
                                </div>
                                <div
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "var(--text-dim)",
                                    marginTop: 5,
                                  }}
                                >
                                  {previewReport.camera_info}
                                </div>
                              </div>
                            )}

                            {previewReport.creation_date && (
                              <div
                                style={{
                                  background: "rgba(168, 85, 247, 0.1)",
                                  border: "1px solid rgba(168, 85, 247, 0.3)",
                                  borderRadius: 8,
                                  padding: 12,
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
                                  <Calendar size={16} color="#a855f7" />
                                  <span
                                    style={{
                                      fontSize: "0.85rem",
                                      fontWeight: 600,
                                      color: "#a855f7",
                                    }}
                                  >
                                    Created
                                  </span>
                                </div>
                                <div
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "var(--text-dim)",
                                    marginTop: 5,
                                  }}
                                >
                                  {previewReport.creation_date}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Raw Tags Toggle */}
                          {previewReport.raw_tags.length > 0 && (
                            <div style={{ marginTop: 15 }}>
                              <button
                                className="secondary-btn"
                                onClick={() => setShowRaw(!showRaw)}
                                style={{
                                  width: "100%",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  gap: 8,
                                  fontSize: "0.85rem",
                                }}
                              >
                                <FileText size={14} />
                                {showRaw ? "Hide" : "Show"} Raw Tags (
                                {previewReport.raw_tags.length})
                              </button>

                              {showRaw && (
                                <div
                                  style={{
                                    marginTop: 10,
                                    maxHeight: "200px",
                                    overflowY: "auto",
                                    background: "var(--bg-color)",
                                    border: "1px solid var(--border)",
                                    borderRadius: 6,
                                    padding: 10,
                                  }}
                                >
                                  {previewReport.raw_tags.map((tag, i) => (
                                    <div
                                      key={i}
                                      style={{
                                        fontSize: "0.75rem",
                                        marginBottom: 5,
                                        color: "var(--text-dim)",
                                        fontFamily: "monospace",
                                      }}
                                    >
                                      <span style={{ color: "var(--accent)" }}>
                                        {tag.key}:
                                      </span>{" "}
                                      {tag.value}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}

                  {!analyzingPreview && !previewReport && (
                    <div
                      style={{
                        textAlign: "center",
                        padding: 40,
                        color: "var(--text-dim)",
                      }}
                    >
                      <Info size={32} />
                      <p style={{ marginTop: 10 }}>
                        Select a file to preview metadata
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* FOOTER: Cleaning Options & Actions */}
      {files.length > 0 && !cleaning && !result && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            background: "var(--panel-bg)",
            padding: 20,
          }}
        >
          <div
            style={{
              maxWidth: 900,
              margin: "0 auto",
              display: "flex",
              gap: 20,
              alignItems: "flex-end",
            }}
          >
            {/* Options */}
            <div style={{ flex: 1 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <Sliders size={16} />
                <h4 style={{ margin: 0, fontSize: "0.9rem" }}>
                  Metadata to Remove
                </h4>
              </div>
              <div style={{ display: "flex", gap: 15, flexWrap: "wrap" }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={opts.gps}
                    onChange={(e) =>
                      setOpts({ ...opts, gps: e.target.checked })
                    }
                  />
                  <MapPin size={14} />
                  GPS Location
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={opts.author}
                    onChange={(e) =>
                      setOpts({ ...opts, author: e.target.checked })
                    }
                  />
                  <User size={14} />
                  Author Info
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={opts.date}
                    onChange={(e) =>
                      setOpts({ ...opts, date: e.target.checked })
                    }
                  />
                  <Calendar size={14} />
                  Creation Date
                </label>
              </div>

              {/* Output Directory */}
              <div style={{ marginTop: 15 }}>
                <button
                  className="secondary-btn"
                  onClick={selectOutputDir}
                  style={{
                    fontSize: "0.85rem",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Folder size={14} />
                  {outputDir ? "Change" : "Select"} Output Directory
                </button>
                {outputDir && (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-dim)",
                      marginTop: 5,
                      wordBreak: "break-all",
                    }}
                  >
                    {outputDir}
                  </div>
                )}
                {!outputDir && (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-dim)",
                      marginTop: 5,
                    }}
                  >
                    Files will be saved in same directory with "_clean" suffix
                  </div>
                )}
              </div>
            </div>

            {/* Action Button */}
            <button
              className="auth-btn"
              onClick={cleanAll}
              disabled={loading}
              style={{
                padding: "12px 30px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: "1rem",
              }}
            >
              <Eraser size={18} />
              Clean {files.length} File{files.length !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
