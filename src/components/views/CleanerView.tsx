import { useState } from "react";
import {
  Eraser,
  ScanSearch,
  File,
  MapPin,
  User,
  Calendar,
  Camera,
  CheckCircle,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useDragDrop } from "../../hooks/useDragDrop";

interface MetaReport {
  has_gps: boolean;
  has_author: boolean;
  camera_info?: string;
  software_info?: string;
  creation_date?: string;
  file_type: string;
}

export function CleanerView() {
  const [file, setFile] = useState<string | null>(null);
  const [report, setReport] = useState<MetaReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleanedPath, setCleanedPath] = useState<string | null>(null);

  const { isDragging } = useDragDrop(async (files) => {
    if (files.length > 0) {
      const selected = files[0];
      setFile(selected);
      analyze(selected);
    }
  });

  async function analyze(path: string) {
    setLoading(true);
    setCleanedPath(null);
    try {
      const res = await invoke<MetaReport>("analyze_file_metadata", { path });
      setReport(res);
    } catch (e) {
      alert("Error analyzing file (Unsupported format?): " + e);
      setFile(null);
    } finally {
      setLoading(false);
    }
  }

  async function clean() {
    if (!file) return;
    setLoading(true);
    try {
      const res = await invoke<string>("clean_file_metadata", { path: file });
      setCleanedPath(res);
    } catch (e) {
      alert("Error cleaning file: " + e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="shredder-view">
      <div
        className={`shred-zone ${isDragging ? "active" : ""}`}
        style={{ borderColor: "var(--accent)" }}
      >
        {!file ? (
          <>
            <ScanSearch
              size={64}
              color="var(--accent)"
              style={{ marginBottom: 20 }}
            />
            <h2>Metadata Cleaner</h2>
            <p style={{ color: "var(--text-dim)" }}>
              Drag a photo or document here to scan for hidden data (GPS,
              Author, Camera).
            </p>
          </>
        ) : (
          <div style={{ width: "100%", textAlign: "left" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 20,
              }}
            >
              <File size={24} color="var(--accent)" />
              <span style={{ fontWeight: "bold" }}>
                {file.split(/[/\\]/).pop()}
              </span>
            </div>

            {loading ? (
              <p style={{ textAlign: "center" }}>Processing...</p>
            ) : report ? (
              <div
                style={{
                  background: "rgba(0,0,0,0.2)",
                  padding: 15,
                  borderRadius: 8,
                  marginBottom: 20,
                }}
              >
                <div
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text-dim)",
                    marginBottom: 10,
                  }}
                >
                  FOUND METADATA:
                </div>

                {report.has_gps && (
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      color: "#d94040",
                      marginBottom: 5,
                    }}
                  >
                    <MapPin size={16} /> <strong>GPS Location Data</strong>
                  </div>
                )}
                {report.has_author && (
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      color: "#eab308",
                      marginBottom: 5,
                    }}
                  >
                    <User size={16} /> <strong>Author / Owner Name</strong>
                  </div>
                )}
                {report.camera_info && (
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      color: "var(--text-main)",
                      marginBottom: 5,
                    }}
                  >
                    <Camera size={16} /> {report.camera_info}
                  </div>
                )}
                {report.creation_date && (
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      color: "var(--text-main)",
                      marginBottom: 5,
                    }}
                  >
                    <Calendar size={16} /> {report.creation_date}
                  </div>
                )}

                {!report.has_gps &&
                  !report.has_author &&
                  !report.camera_info && (
                    <div style={{ color: "#42b883", display: "flex", gap: 10 }}>
                      <CheckCircle size={16} /> No sensitive metadata found.
                    </div>
                  )}
              </div>
            ) : null}

            {cleanedPath ? (
              <div
                style={{ textAlign: "center", color: "#42b883", marginTop: 20 }}
              >
                <CheckCircle size={48} style={{ marginBottom: 10 }} />
                <p style={{ fontWeight: "bold" }}>Cleaned file saved!</p>
                <small
                  style={{ color: "var(--text-dim)", wordBreak: "break-all" }}
                >
                  {cleanedPath}
                </small>
                <button
                  className="secondary-btn"
                  onClick={() => setFile(null)}
                  style={{ marginTop: 15, width: "100%" }}
                >
                  Scan Another
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => setFile(null)}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn"
                  style={{ flex: 2 }}
                  onClick={clean}
                >
                  <Eraser size={18} style={{ marginRight: 8 }} />
                  Scrub Metadata
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
