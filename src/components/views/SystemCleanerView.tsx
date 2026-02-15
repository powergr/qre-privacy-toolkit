import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import {
  Trash2,
  HardDrive,
  Chrome,
  AppWindow,
  RefreshCw,
  CheckCircle,
  Smartphone,
  Brush, // <--- Changed Broom to Brush
} from "lucide-react";
import { formatSize } from "../../utils/formatting";
import { InfoModal } from "../modals/AppModals";

interface JunkItem {
  id: string;
  name: string;
  path: string;
  category: string;
  size: number;
  description: string;
}

export function SystemCleanerView() {
  const [isAndroid, setIsAndroid] = useState(false);
  const [items, setItems] = useState<JunkItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [cleanedAmount, setCleanedAmount] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null); // <--- Added for InfoModal

  useEffect(() => {
    try {
      if (platform() === "android") setIsAndroid(true);
    } catch {
      /* ignore */
    }
  }, []);

  // --- ACTIONS ---

  async function scan() {
    setLoading(true);
    setCleanedAmount(null);
    try {
      const res = await invoke<JunkItem[]>("scan_system_junk");
      setItems(res);
      // Select all by default
      setSelectedIds(new Set(res.map((i) => i.id)));
      setScanned(true);
    } catch (e) {
      setMsg("Scan failed: " + e); // Use InfoModal
    } finally {
      setLoading(false);
    }
  }

  async function clean() {
    if (selectedIds.size === 0) return;
    setLoading(true);

    // Get paths
    const paths = items.filter((i) => selectedIds.has(i.id)).map((i) => i.path);

    try {
      const bytesFreed = await invoke<number>("clean_system_junk", { paths });
      setCleanedAmount(bytesFreed);
      setItems([]);
      setScanned(false);
    } catch (e) {
      setMsg("Clean failed: " + e); // Use InfoModal
    } finally {
      setLoading(false);
    }
  }

  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  };

  const totalSelectedSize = items
    .filter((i) => selectedIds.has(i.id))
    .reduce((acc, i) => acc + i.size, 0);

  // --- ICONS ---
  const getIcon = (cat: string) => {
    if (cat === "Browser") return <Chrome size={20} color="#f97316" />; // Orange
    if (cat === "System") return <HardDrive size={20} color="#3b82f6" />; // Blue
    return <AppWindow size={20} color="#a855f7" />; // Purple
  };

  // --- ANDROID VIEW ---
  if (isAndroid) {
    return (
      <div
        style={{
          padding: 40,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <div
          style={{
            background: "rgba(234, 179, 8, 0.1)",
            padding: 25,
            borderRadius: "50%",
            marginBottom: 20,
          }}
        >
          <Smartphone size={64} color="#eab308" />
        </div>
        <h2>Desktop Feature</h2>
        <p style={{ color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 300 }}>
          System cleaning is restricted on Android due to OS sandboxing.
          <br />
          <br />
          Please use the <strong>Shredder</strong> to delete specific files
          manually.
        </p>
      </div>
    );
  }

  // --- DESKTOP VIEW ---
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "30px 30px 10px 30px", textAlign: "center" }}>
        <h2 style={{ margin: 0 }}>System Cleaner</h2>
        <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
          Clear temporary files, caches, and recent file history.
        </p>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 30px" }}>
        {/* START STATE */}
        {!scanned && !cleanedAmount && (
          <div
            style={{
              border: "2px dashed var(--border)",
              borderRadius: 12,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "300px",
              cursor: "pointer",
              transition: "all 0.2s",
              background: "rgba(255,255,255,0.02)",
            }}
            onClick={scan}
          >
            <Brush
              size={64}
              color="var(--accent)"
              style={{ marginBottom: 20, opacity: loading ? 0.5 : 1 }}
            />
            {loading ? <h3>Scanning System...</h3> : <h3>Start Scan</h3>}
          </div>
        )}

        {/* SUCCESS STATE */}
        {cleanedAmount !== null && (
          <div style={{ textAlign: "center", marginTop: 50 }}>
            <CheckCircle
              size={64}
              color="#4ade80"
              style={{ marginBottom: 20 }}
            />
            <h2>Cleanup Complete!</h2>
            <p style={{ fontSize: "1.2rem", color: "var(--text-main)" }}>
              Freed <strong>{formatSize(cleanedAmount)}</strong> of space.
            </p>
            <button
              className="secondary-btn"
              onClick={scan}
              style={{ marginTop: 20 }}
            >
              Scan Again
            </button>
          </div>
        )}

        {/* LIST STATE */}
        {scanned && items.length > 0 && (
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 15,
              }}
            >
              <span style={{ fontWeight: "bold" }}>
                Found {items.length} items ({formatSize(totalSelectedSize)})
              </span>
              <button
                className="secondary-btn"
                onClick={scan}
                style={{ fontSize: "0.8rem", padding: "6px 12px" }}
              >
                <RefreshCw size={14} style={{ marginRight: 6 }} /> Rescan
              </button>
            </div>

            <div
              style={{
                background: "var(--bg-card)",
                borderRadius: 10,
                border: "1px solid var(--border)",
                overflow: "hidden",
              }}
            >
              {items.map((item) => (
                <div
                  key={item.id}
                  onClick={() => toggleSelect(item.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "15px",
                    borderBottom: "1px solid var(--border)",
                    cursor: "pointer",
                    background: selectedIds.has(item.id)
                      ? "rgba(var(--accent-rgb), 0.05)"
                      : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    onChange={() => {}}
                    style={{ marginRight: 15, transform: "scale(1.2)" }}
                  />
                  <div style={{ marginRight: 15 }}>
                    {getIcon(item.category)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{item.name}</div>
                    <div
                      style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}
                    >
                      {item.description}
                    </div>
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: "0.9rem" }}>
                    {formatSize(item.size)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {scanned && items.length === 0 && (
          <div style={{ textAlign: "center", marginTop: 50 }}>
            <CheckCircle size={48} color="#4ade80" />
            <h3>System is Clean</h3>
            <p style={{ color: "var(--text-dim)" }}>
              No temporary files found.
            </p>
            <button
              className="secondary-btn"
              onClick={scan}
              style={{ marginTop: 20 }}
            >
              Scan Again
            </button>
          </div>
        )}
      </div>

      {/* FOOTER ACTIONS */}
      {scanned && items.length > 0 && (
        <div
          style={{
            padding: 20,
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "center",
            background: "var(--panel-bg)",
          }}
        >
          <button
            className="auth-btn"
            onClick={clean}
            disabled={loading || selectedIds.size === 0}
            style={{
              width: "100%",
              maxWidth: "300px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
            }}
          >
            {loading ? (
              "Cleaning..."
            ) : (
              <>
                <Trash2 size={18} /> Clean Selected (
                {formatSize(totalSelectedSize)})
              </>
            )}
          </button>
        </div>
      )}

      {/* ERROR / INFO MODAL */}
      {msg && <InfoModal message={msg} onClose={() => setMsg(null)} />}
    </div>
  );
}
