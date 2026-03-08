import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { platform } from "@tauri-apps/plugin-os";
import {
  Trash2,
  HardDrive,
  Chrome,
  AppWindow,
  RefreshCw,
  CheckCircle,
  Smartphone,
  Brush,
  FileText,
  AlertTriangle,
  Code2,
  Globe,
  Eye,
  X,
  Loader2,
  Wifi,
  ShieldAlert,
  Lock,
  Database,
  BookKey,
  Search,
  History,
} from "lucide-react";
import { formatSize } from "../../utils/formatting";
import { InfoModal } from "../modals/AppModals";

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

interface JunkItem {
  id: string;
  name: string;
  path: string;
  category: string;
  size: number;
  description: string;
  warning?: string;
  elevation_required: boolean;
}

interface CleanProgress {
  files_processed: number;
  total_files: number;
  bytes_freed: number;
  current_file: string;
  percentage: number;
}

interface CleanResult {
  bytes_freed: number;
  files_deleted: number;
  errors: string[];
}

interface DryRunResult {
  total_files: number;
  total_size: number;
  file_list: string[];
  warnings: string[];
}

interface RegistryItem {
  id: string;
  name: string;
  key_path: string;
  value_name: string | null;
  category: string;
  description: string;
  warning: string | null;
}

interface RegistryBackupResult {
  backup_path: string;
  success: boolean;
  error: string | null;
}

interface RegistryCleanResult {
  items_cleaned: number;
  errors: string[];
  backup_path: string | null;
}

interface RegistryCleanEntry {
  key_path: string;
  value_name: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const LARGE_SIZE_WARNING = 10 * 1024 * 1024 * 1024; // 10 GB

const REGISTRY_CATEGORY_META: Record<string, { label: string; color: string }> =
  {
    OrphanedInstaller: { label: "Orphaned Installer", color: "#f97316" },
    InvalidAppPath: { label: "Invalid App Path", color: "#06b6d4" },
    MUICache: { label: "MUI Cache Entry", color: "#a855f7" },
    StartupEntry: { label: "Startup Entry", color: "#ef4444" },
  };

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function SystemCleanerView() {
  // ── Platform detection ──────────────────────────────────────────────────
  const [isAndroid, setIsAndroid] = useState(false);
  const [isWindows, setIsWindows] = useState(false);

  // ── Junk cleaner state ──────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState("System");
  const [items, setItems] = useState<JunkItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Dry-run / preview ───────────────────────────────────────────────────
  const [showPreview, setShowPreview] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);

  // ── Confirmation dialog ─────────────────────────────────────────────────
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);

  // ── Cleaning progress ───────────────────────────────────────────────────
  const [cleaning, setCleaning] = useState(false);
  const [progress, setProgress] = useState<CleanProgress | null>(null);
  const [cleanResult, setCleanResult] = useState<CleanResult | null>(null);

  // ── Registry state ──────────────────────────────────────────────────────
  const [registryItems, setRegistryItems] = useState<RegistryItem[]>([]);
  const [selectedRegistryIds, setSelectedRegistryIds] = useState<Set<string>>(
    new Set(),
  );
  const [registryScanned, setRegistryScanned] = useState(false);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryCleaning, setRegistryCleaning] = useState(false);
  const [registryBackupPath, setRegistryBackupPath] = useState<string | null>(
    null,
  );
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [registryBackingUp, setRegistryBackingUp] = useState(false);

  // ── Platform init ───────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const p = platform();
      if (p === "android") setIsAndroid(true);
      if (p === "windows") setIsWindows(true);
    } catch {
      /* ignore */
    }
  }, []);

  // ── Progress listener ───────────────────────────────────────────────────
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    (async () => {
      unlisten = await listen<CleanProgress>("clean-progress", (e) =>
        setProgress(e.payload),
      );
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // ═════════════════════════════════════════════════════════════════════════
  // JUNK CLEANER ACTIONS
  // ═════════════════════════════════════════════════════════════════════════

  async function scan() {
    setLoading(true);
    setError(null);
    setCleanResult(null);
    setShowPreview(false);
    setDryRunResult(null);
    try {
      const res = await invoke<JunkItem[]>("scan_system_junk");
      setItems(res);
      // Pre-select everything except Developer (high-risk) — Privacy also excluded by default
      const safeIds = res
        .filter((i) => i.category !== "Developer" && i.category !== "Privacy")
        .map((i) => i.id);
      setSelectedIds(new Set(safeIds));
      setScanned(true);
    } catch (e) {
      setError("Scan failed: " + e);
    } finally {
      setLoading(false);
    }
  }

  async function previewClean() {
    if (selectedIds.size === 0) return;
    setLoading(true);
    setError(null);
    const paths = items.filter((i) => selectedIds.has(i.id)).map((i) => i.path);
    try {
      const result = await invoke<DryRunResult>("dry_run_clean", { paths });
      setDryRunResult(result);
      setShowPreview(true);
    } catch (e) {
      setError("Preview failed: " + e);
    } finally {
      setLoading(false);
    }
  }

  async function initiateClean() {
    const totalSize = items
      .filter((i) => selectedIds.has(i.id))
      .reduce((acc, i) => acc + i.size, 0);
    if (totalSize > LARGE_SIZE_WARNING) {
      setShowConfirmation(true);
    } else {
      performClean();
    }
  }

  async function performClean() {
    if (selectedIds.size === 0) return;
    setCleaning(true);
    setError(null);
    setShowConfirmation(false);
    setConfirmChecked(false);
    setProgress(null);
    const paths = items.filter((i) => selectedIds.has(i.id)).map((i) => i.path);
    try {
      const result = await invoke<CleanResult>("clean_system_junk", { paths });
      setCleanResult(result);
      setItems([]);
      setScanned(false);
      setShowPreview(false);
      if (result.errors.length > 0) {
        setError(
          `Cleaned with ${result.errors.length} error(s). See details above.`,
        );
      } else {
        setMsg("Cleanup completed successfully!");
      }
    } catch (e) {
      setError("Clean failed: " + e);
    } finally {
      setCleaning(false);
      setProgress(null);
    }
  }

  async function cancelClean() {
    try {
      await invoke("cancel_system_clean");
      setError("Cleanup cancelled by user.");
      setCleaning(false);
    } catch (e) {
      console.error("Failed to cancel:", e);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // REGISTRY ACTIONS
  // ═════════════════════════════════════════════════════════════════════════

  async function scanRegistry() {
    setRegistryLoading(true);
    setRegistryError(null);
    setRegistryBackupPath(null);
    try {
      const res = await invoke<RegistryItem[]>("scan_registry");
      setRegistryItems(res);
      // Pre-select only low-risk categories by default
      const safeIds = res
        .filter(
          (i) => i.category === "InvalidAppPath" || i.category === "MUICache",
        )
        .map((i) => i.id);
      setSelectedRegistryIds(new Set(safeIds));
      setRegistryScanned(true);
    } catch (e) {
      setRegistryError("Registry scan failed: " + e);
    } finally {
      setRegistryLoading(false);
    }
  }

  async function backupRegistry() {
    setRegistryBackingUp(true);
    setRegistryError(null);
    try {
      const result = await invoke<RegistryBackupResult>("backup_registry");
      if (result.success) {
        setRegistryBackupPath(result.backup_path);
        setMsg(`Registry backup saved to: ${result.backup_path}`);
      } else {
        setRegistryError("Backup failed: " + (result.error ?? "Unknown error"));
      }
    } catch (e) {
      setRegistryError("Backup failed: " + e);
    } finally {
      setRegistryBackingUp(false);
    }
  }

  async function cleanRegistry() {
    if (selectedRegistryIds.size === 0 || !registryBackupPath) return;
    setRegistryCleaning(true);
    setRegistryError(null);
    const entries: RegistryCleanEntry[] = registryItems
      .filter((i) => selectedRegistryIds.has(i.id))
      .map((i) => ({ key_path: i.key_path, value_name: i.value_name }));
    try {
      const result = await invoke<RegistryCleanResult>("clean_registry", {
        entries,
      });
      setRegistryItems((prev) =>
        prev.filter((i) => !selectedRegistryIds.has(i.id)),
      );
      setSelectedRegistryIds(new Set());
      if (result.errors.length > 0) {
        setRegistryError(
          `Cleaned ${result.items_cleaned} entries with ${result.errors.length} error(s).`,
        );
      } else {
        setMsg(`Registry cleaned: ${result.items_cleaned} entries removed.`);
      }
    } catch (e) {
      setRegistryError("Registry clean failed: " + e);
    } finally {
      setRegistryCleaning(false);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SELECTION HELPERS
  // ═════════════════════════════════════════════════════════════════════════

  const visibleItems = items.filter((i) => i.category === activeTab);

  const toggleSelect = (id: string) => {
    const s = new Set(selectedIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedIds(s);
  };

  const toggleAll = () => {
    const visibleIds = visibleItems.map((i) => i.id);
    const allSelected = visibleIds.every((id) => selectedIds.has(id));
    const s = new Set(selectedIds);
    allSelected
      ? visibleIds.forEach((id) => s.delete(id))
      : visibleIds.forEach((id) => s.add(id));
    setSelectedIds(s);
  };

  const toggleRegistrySelect = (id: string) => {
    const s = new Set(selectedRegistryIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedRegistryIds(s);
  };

  const toggleAllRegistry = () => {
    if (selectedRegistryIds.size === registryItems.length) {
      setSelectedRegistryIds(new Set());
    } else {
      setSelectedRegistryIds(new Set(registryItems.map((i) => i.id)));
    }
  };

  const totalSelectedSize = items
    .filter((i) => selectedIds.has(i.id))
    .reduce((acc, i) => acc + i.size, 0);

  const hasWarnings = visibleItems
    .filter((i) => selectedIds.has(i.id))
    .some((i) => i.warning);
  const hasElevationRequired = visibleItems
    .filter((i) => selectedIds.has(i.id))
    .some((i) => i.elevation_required);

  // ═════════════════════════════════════════════════════════════════════════
  // TABS CONFIG
  // ═════════════════════════════════════════════════════════════════════════

  const ALL_TABS = [
    { id: "System", label: "System", icon: <HardDrive size={14} /> },
    { id: "Browser", label: "Browsers", icon: <Chrome size={14} /> },
    { id: "Network", label: "Network", icon: <Wifi size={14} /> },
    { id: "Developer", label: "Developer", icon: <Code2 size={14} /> },
    { id: "Privacy", label: "Privacy", icon: <ShieldAlert size={14} /> },
    // Registry tab only shown on Windows
    ...(isWindows
      ? [{ id: "Registry", label: "Registry", icon: <Database size={14} /> }]
      : []),
  ];

  // ═════════════════════════════════════════════════════════════════════════
  // ICONS
  // ═════════════════════════════════════════════════════════════════════════

  const getIcon = (cat: string) => {
    const props = { size: 20 };
    if (cat === "Browser") return <Chrome {...props} color="#f97316" />;
    if (cat === "System") return <HardDrive {...props} color="#3b82f6" />;
    if (cat === "Logs") return <FileText {...props} color="#10b981" />;
    if (cat === "Developer") return <Code2 {...props} color="#ef4444" />;
    if (cat === "Network") return <Wifi {...props} color="#06b6d4" />;
    if (cat === "Privacy") return <ShieldAlert {...props} color="#a855f7" />;
    return <AppWindow {...props} color="#a855f7" />;
  };

  const getRegistryIcon = (cat: string) => {
    if (cat === "OrphanedInstaller")
      return <Trash2 size={18} color="#f97316" />;
    if (cat === "InvalidAppPath") return <Search size={18} color="#06b6d4" />;
    if (cat === "MUICache") return <Globe size={18} color="#a855f7" />;
    if (cat === "StartupEntry") return <History size={18} color="#ef4444" />;
    return <BookKey size={18} color="#6b7280" />;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // ANDROID GUARD
  // ═════════════════════════════════════════════════════════════════════════

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
            background: "rgba(234,179,8,0.1)",
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
        </p>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════════

  const isRegistryTab = activeTab === "Registry";

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* ── Main scroll area ─────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "30px",
          display: "flex",
          flexDirection: "column",
          justifyContent:
            !scanned && !cleanResult && !registryScanned
              ? "center"
              : "flex-start",
        }}
      >
        {/* Header */}
        <div
          style={{
            textAlign: "center",
            marginBottom: scanned || cleanResult || registryScanned ? 20 : 40,
          }}
        >
          <h2 style={{ margin: 0 }}>System Cleaner</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 5 }}>
            Clear caches, browser data, developer artifacts, privacy traces, and
            registry leftovers.
          </p>
        </div>

        {/* Error banner — junk cleaner */}
        {error && (
          <div
            style={{
              maxWidth: 700,
              margin: "0 auto 20px auto",
              padding: 12,
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
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

        {/* Error banner — registry */}
        {registryError && activeTab === "Registry" && (
          <div
            style={{
              maxWidth: 700,
              margin: "0 auto 20px auto",
              padding: 12,
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              color: "var(--btn-danger)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <AlertTriangle size={18} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{registryError}</span>
            <button
              onClick={() => setRegistryError(null)}
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

        {/* ── TAB BAR ─────────────────────────────────────────────────── */}
        {(scanned || registryScanned) && !showPreview && !cleaning && (
          <div
            style={{
              display: "flex",
              gap: 4,
              maxWidth: 700,
              width: "100%",
              margin: "0 auto 20px auto",
              background: "var(--panel-bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 4,
            }}
          >
            {ALL_TABS.map((tab) => {
              const isReg = tab.id === "Registry";
              const tabCount = isReg
                ? registryItems.length
                : items.filter((i) => i.category === tab.id).length;
              const selCount = isReg
                ? selectedRegistryIds.size
                : items.filter(
                    (i) => i.category === tab.id && selectedIds.has(i.id),
                  ).length;

              if (tabCount === 0 && tab.id !== "Registry") return null;

              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 3,
                    padding: "7px 4px",
                    border: "none",
                    borderRadius: 7,
                    cursor: "pointer",
                    background: isActive ? "var(--accent)" : "transparent",
                    color: isActive ? "#fff" : "var(--text-dim)",
                    fontSize: "0.72rem",
                    fontWeight: isActive ? 700 : 400,
                    transition: "background 0.15s, color 0.15s",
                  }}
                >
                  <span style={{ opacity: isActive ? 1 : 0.7 }}>
                    {tab.icon}
                  </span>
                  <span>{tab.label}</span>
                  {tabCount > 0 && (
                    <span
                      style={{
                        fontSize: "0.62rem",
                        borderRadius: 10,
                        padding: "1px 5px",
                        fontWeight: 600,
                        background: isActive
                          ? "rgba(255,255,255,0.25)"
                          : "var(--border)",
                        color: isActive ? "#fff" : "var(--text-dim)",
                      }}
                    >
                      {selCount}/{tabCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* ── START STATE ─────────────────────────────────────────────── */}
        {!scanned && !cleanResult && !registryScanned && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              width: "100%",
            }}
          >
            <div
              className="shred-zone"
              style={{
                width: "100%",
                maxWidth: 400,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: 40,
                cursor: loading ? "wait" : "pointer",
                borderColor: loading ? "var(--text-dim)" : "var(--accent)",
              }}
              onClick={!loading ? scan : undefined}
            >
              <Brush
                size={64}
                color="var(--accent)"
                className={loading ? "spinner" : ""}
                style={{ marginBottom: 20 }}
              />
              {loading ? (
                <>
                  <h3>Scanning System...</h3>
                  <p style={{ color: "var(--text-dim)" }}>
                    Analyzing caches and temp files
                  </p>
                </>
              ) : (
                <>
                  <h3>Start Scan</h3>
                  <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
                    Click to analyze junk files across all categories
                  </p>
                  <button className="auth-btn" style={{ padding: "10px 30px" }}>
                    Scan Now
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── CLEAN SUCCESS STATE ──────────────────────────────────────── */}
        {cleanResult && (
          <div
            style={{
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 40,
              maxWidth: 600,
              margin: "0 auto",
            }}
          >
            <CheckCircle
              size={64}
              color="#4ade80"
              style={{ marginBottom: 20 }}
            />
            <h2>Cleanup Complete!</h2>
            <p
              style={{
                fontSize: "1.2rem",
                color: "var(--text-main)",
                marginBottom: 10,
              }}
            >
              Freed <strong>{formatSize(cleanResult.bytes_freed)}</strong> of
              space.
            </p>
            <p
              style={{
                fontSize: "0.9rem",
                color: "var(--text-dim)",
                marginBottom: 20,
              }}
            >
              Deleted {cleanResult.files_deleted.toLocaleString()} file(s)
            </p>
            {cleanResult.errors.length > 0 && (
              <div
                style={{
                  width: "100%",
                  maxWidth: 500,
                  marginBottom: 20,
                  background: "rgba(239,68,68,0.1)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 8,
                  padding: 15,
                  textAlign: "left",
                }}
              >
                <h4 style={{ margin: "0 0 10px 0", fontSize: "0.9rem" }}>
                  Errors ({cleanResult.errors.length}):
                </h4>
                <div
                  style={{
                    maxHeight: 150,
                    overflowY: "auto",
                    fontSize: "0.8rem",
                    color: "var(--text-dim)",
                  }}
                >
                  {cleanResult.errors.slice(0, 10).map((err, i) => (
                    <div
                      key={i}
                      style={{ marginBottom: 5, fontFamily: "monospace" }}
                    >
                      • {err}
                    </div>
                  ))}
                  {cleanResult.errors.length > 10 && (
                    <div style={{ marginTop: 5, fontStyle: "italic" }}>
                      …and {cleanResult.errors.length - 10} more
                    </div>
                  )}
                </div>
              </div>
            )}
            <button
              className="secondary-btn"
              onClick={scan}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <RefreshCw size={16} /> Scan Again
            </button>
          </div>
        )}

        {/* ── RESULTS LIST (all tabs except Registry) ──────────────────── */}
        {scanned && items.length > 0 && !showPreview && !isRegistryTab && (
          <div style={{ maxWidth: 700, margin: "0 auto", width: "100%" }}>
            {/* Toolbar */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 15,
                background: "var(--panel-bg)",
                padding: "10px 15px",
                borderRadius: 8,
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="checkbox"
                  checked={
                    visibleItems.length > 0 &&
                    visibleItems.every((i) => selectedIds.has(i.id))
                  }
                  onChange={toggleAll}
                  style={{ cursor: "pointer" }}
                />
                <span style={{ fontWeight: "bold", fontSize: "0.9rem" }}>
                  {visibleItems.filter((i) => selectedIds.has(i.id)).length}/
                  {visibleItems.length} in tab &nbsp;·&nbsp;{selectedIds.size}{" "}
                  total ({formatSize(totalSelectedSize)})
                </span>
              </div>
              <button
                className="icon-btn-ghost"
                onClick={scan}
                title="Rescan"
                disabled={loading}
              >
                <RefreshCw size={16} className={loading ? "spinner" : ""} />
              </button>
            </div>

            {/* Warning banners */}
            {hasWarnings && (
              <div
                style={{
                  marginBottom: 12,
                  padding: 12,
                  background: "rgba(245,158,11,0.1)",
                  border: "1px solid rgba(245,158,11,0.3)",
                  borderRadius: 8,
                  color: "#f59e0b",
                  fontSize: "0.85rem",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                <span>
                  Selected items include warnings. Review carefully before
                  cleaning.
                </span>
              </div>
            )}

            {hasElevationRequired && (
              <div
                style={{
                  marginBottom: 12,
                  padding: 12,
                  background: "rgba(139,92,246,0.1)",
                  border: "1px solid rgba(139,92,246,0.3)",
                  borderRadius: 8,
                  color: "#8b5cf6",
                  fontSize: "0.85rem",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <Lock size={16} style={{ flexShrink: 0 }} />
                <span>
                  Some selected items require administrator privileges. Run as
                  admin or those items will fail with a permissions error.
                </span>
              </div>
            )}

            {activeTab === "Developer" && (
              <div
                style={{
                  marginBottom: 12,
                  padding: 12,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.25)",
                  borderRadius: 8,
                  color: "#ef4444",
                  fontSize: "0.85rem",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <Code2 size={16} style={{ flexShrink: 0 }} />
                <span>
                  Developer caches are excluded from the default selection.
                  Cleaning them will require re-downloading packages on next
                  build.
                </span>
              </div>
            )}

            {activeTab === "Privacy" && (
              <div
                style={{
                  marginBottom: 12,
                  padding: 12,
                  background: "rgba(139,92,246,0.08)",
                  border: "1px solid rgba(139,92,246,0.25)",
                  borderRadius: 8,
                  color: "#a855f7",
                  fontSize: "0.85rem",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <ShieldAlert size={16} style={{ flexShrink: 0 }} />
                <span>
                  Privacy items are excluded from the default selection. These
                  remove activity traces — shell history deletion is
                  irreversible.
                </span>
              </div>
            )}

            {/* Empty tab state */}
            {visibleItems.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  padding: 40,
                  color: "var(--text-dim)",
                }}
              >
                <CheckCircle
                  size={32}
                  color="#4ade80"
                  style={{ marginBottom: 10 }}
                />
                <p>No junk found in this category.</p>
              </div>
            )}

            {/* Item list */}
            {visibleItems.length > 0 && (
              <div
                style={{
                  background: "var(--bg-card)",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  overflow: "hidden",
                }}
              >
                {visibleItems.map((item, index) => (
                  <div
                    key={item.id}
                    onClick={() => toggleSelect(item.id)}
                    title={item.warning ?? item.description}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "15px",
                      borderBottom:
                        index < visibleItems.length - 1
                          ? "1px solid var(--border)"
                          : "none",
                      cursor: "pointer",
                      background: selectedIds.has(item.id)
                        ? "rgba(0,122,204,0.05)"
                        : "transparent",
                      transition: "background 0.2s",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => {}}
                      style={{ marginRight: 15, transform: "scale(1.2)" }}
                    />
                    <div
                      style={{
                        marginRight: 15,
                        padding: 8,
                        background: "rgba(255,255,255,0.05)",
                        borderRadius: 8,
                      }}
                    >
                      {getIcon(item.category)}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: "0.95rem",
                            color: item.warning
                              ? "#f59e0b"
                              : "var(--text-main)",
                          }}
                        >
                          {item.name}
                        </span>
                        {item.warning && (
                          <AlertTriangle size={13} color="#f59e0b" />
                        )}
                        {item.elevation_required && (
                          <span
                            title="Requires administrator privileges"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 3,
                              fontSize: "0.68rem",
                              fontWeight: 600,
                              color: "#8b5cf6",
                              background: "rgba(139,92,246,0.12)",
                              border: "1px solid rgba(139,92,246,0.3)",
                              borderRadius: 4,
                              padding: "1px 5px",
                            }}
                          >
                            <Lock size={9} /> Admin
                          </span>
                        )}
                      </div>
                      <div
                        style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}
                      >
                        {item.description}
                      </div>
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        fontSize: "0.85rem",
                        fontWeight: "bold",
                        color: item.path.startsWith("::")
                          ? "var(--text-dim)"
                          : "var(--accent)",
                        border: item.path.startsWith("::")
                          ? "1px solid var(--border)"
                          : "none",
                        padding: item.path.startsWith("::") ? "2px 6px" : "0",
                        borderRadius: 4,
                        opacity: item.path.startsWith("::") ? 0.8 : 1,
                        textAlign: "right",
                        minWidth: 70,
                      }}
                    >
                      {item.path.startsWith("::")
                        ? "ACTION"
                        : formatSize(item.size)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── PREVIEW / DRY RUN ────────────────────────────────────────── */}
        {showPreview && dryRunResult && (
          <div style={{ maxWidth: 700, margin: "0 auto", width: "100%" }}>
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 10,
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
                <h3 style={{ margin: 0 }}>Preview: What Will Be Deleted</h3>
                <button
                  onClick={() => setShowPreview(false)}
                  className="icon-btn-ghost"
                >
                  <X size={18} />
                </button>
              </div>
              <div
                style={{
                  background: "rgba(59,130,246,0.1)",
                  border: "1px solid rgba(59,130,246,0.3)",
                  borderRadius: 8,
                  padding: 15,
                  marginBottom: 15,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
                    Total Files:
                  </div>
                  <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                    {dryRunResult.total_files.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-dim)" }}>
                    Total Size:
                  </div>
                  <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                    {formatSize(dryRunResult.total_size)}
                  </div>
                </div>
              </div>
              {dryRunResult.warnings.length > 0 && (
                <div
                  style={{
                    background: "rgba(245,158,11,0.1)",
                    border: "1px solid rgba(245,158,11,0.3)",
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
                  {dryRunResult.warnings.map((w, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-dim)",
                        marginBottom: 4,
                      }}
                    >
                      • {w}
                    </div>
                  ))}
                </div>
              )}
              <h4 style={{ margin: "0 0 10px 0", fontSize: "0.9rem" }}>
                Files to be deleted:
              </h4>
              <div
                style={{
                  maxHeight: 300,
                  overflowY: "auto",
                  background: "var(--bg-color)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 10,
                }}
              >
                {dryRunResult.file_list.map((file, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: "0.75rem",
                      fontFamily: "monospace",
                      color: "var(--text-dim)",
                      marginBottom: 4,
                      wordBreak: "break-all",
                    }}
                  >
                    {file}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                className="secondary-btn"
                onClick={() => setShowPreview(false)}
              >
                Back to List
              </button>
              <button className="auth-btn danger-btn" onClick={initiateClean}>
                <Trash2 size={16} style={{ marginRight: 8 }} />
                Confirm & Clean
              </button>
            </div>
          </div>
        )}

        {/* ── CLEANING PROGRESS ────────────────────────────────────────── */}
        {cleaning && progress && (
          <div style={{ maxWidth: 600, margin: "0 auto", width: "100%" }}>
            <div
              className="modern-card"
              style={{ padding: 30, textAlign: "center" }}
            >
              <Loader2
                size={48}
                className="spinner"
                style={{ marginBottom: 20 }}
              />
              <h3>Cleaning in Progress...</h3>
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
                {progress.percentage}% — {progress.files_processed} of{" "}
                {progress.total_files} files
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.8rem",
                  marginTop: 10,
                  wordBreak: "break-all",
                }}
              >
                {formatSize(progress.bytes_freed)} freed
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

        {/* ── EMPTY STATE ──────────────────────────────────────────────── */}
        {scanned && items.length === 0 && !isRegistryTab && (
          <div
            style={{
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 40,
            }}
          >
            <CheckCircle size={64} color="#4ade80" />
            <h3 style={{ marginTop: 20 }}>System is Clean</h3>
            <p style={{ color: "var(--text-dim)" }}>
              No temporary files or junk found.
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

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* REGISTRY TAB CONTENT                                           */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {isRegistryTab && (
          <div style={{ maxWidth: 700, margin: "0 auto", width: "100%" }}>
            {/* Registry start state */}
            {!registryScanned && !registryCleaning && (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <div
                  className="shred-zone"
                  style={{
                    width: "100%",
                    maxWidth: 420,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    padding: 40,
                    cursor: registryLoading ? "wait" : "pointer",
                    borderColor: registryLoading
                      ? "var(--text-dim)"
                      : "var(--accent)",
                  }}
                  onClick={!registryLoading ? scanRegistry : undefined}
                >
                  <Database
                    size={64}
                    color="var(--accent)"
                    className={registryLoading ? "spinner" : ""}
                    style={{ marginBottom: 20 }}
                  />
                  {registryLoading ? (
                    <>
                      <h3>Scanning Registry...</h3>
                      <p style={{ color: "var(--text-dim)" }}>
                        Checking for orphaned entries
                      </p>
                    </>
                  ) : (
                    <>
                      <h3>Scan Registry</h3>
                      <p
                        style={{
                          color: "var(--text-dim)",
                          marginBottom: 16,
                          textAlign: "center",
                        }}
                      >
                        Find orphaned installers, invalid app paths, MUI cache
                        leftovers, and broken startup entries.
                      </p>
                      <button
                        className="auth-btn"
                        style={{ padding: "10px 30px" }}
                      >
                        Scan Registry
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Registry results */}
            {registryScanned &&
              registryItems.length > 0 &&
              !registryCleaning && (
                <>
                  {/* Backup requirement banner */}
                  <div
                    style={{
                      marginBottom: 15,
                      padding: 14,
                      background: registryBackupPath
                        ? "rgba(74,222,128,0.08)"
                        : "rgba(245,158,11,0.1)",
                      border: `1px solid ${registryBackupPath ? "rgba(74,222,128,0.3)" : "rgba(245,158,11,0.3)"}`,
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      {registryBackupPath ? (
                        <CheckCircle size={18} color="#4ade80" />
                      ) : (
                        <AlertTriangle
                          size={18}
                          color="#f59e0b"
                          style={{ flexShrink: 0 }}
                        />
                      )}
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: "0.9rem",
                            color: registryBackupPath ? "#4ade80" : "#f59e0b",
                          }}
                        >
                          {registryBackupPath
                            ? "Backup saved"
                            : "Backup required before cleaning"}
                        </div>
                        <div
                          style={{
                            fontSize: "0.78rem",
                            color: "var(--text-dim)",
                            marginTop: 2,
                          }}
                        >
                          {registryBackupPath
                            ? registryBackupPath
                            : "A .reg backup will be created so you can restore if anything goes wrong."}
                        </div>
                      </div>
                    </div>
                    {!registryBackupPath && (
                      <button
                        className="secondary-btn"
                        onClick={backupRegistry}
                        disabled={registryBackingUp}
                        style={{
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          fontSize: "0.85rem",
                          padding: "6px 14px",
                        }}
                      >
                        {registryBackingUp ? (
                          <>
                            <Loader2 size={13} className="spinner" /> Backing
                            up…
                          </>
                        ) : (
                          <>
                            <BookKey size={13} /> Create Backup
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Toolbar */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 15,
                      background: "var(--panel-bg)",
                      padding: "10px 15px",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <input
                        type="checkbox"
                        checked={
                          selectedRegistryIds.size === registryItems.length &&
                          registryItems.length > 0
                        }
                        onChange={toggleAllRegistry}
                        style={{ cursor: "pointer" }}
                      />
                      <span style={{ fontWeight: "bold", fontSize: "0.9rem" }}>
                        {selectedRegistryIds.size}/{registryItems.length}{" "}
                        selected
                      </span>
                    </div>
                    <button
                      className="icon-btn-ghost"
                      onClick={scanRegistry}
                      title="Re-scan"
                      disabled={registryLoading}
                    >
                      <RefreshCw
                        size={16}
                        className={registryLoading ? "spinner" : ""}
                      />
                    </button>
                  </div>

                  {/* Group items by category */}
                  {(
                    [
                      "OrphanedInstaller",
                      "InvalidAppPath",
                      "MUICache",
                      "StartupEntry",
                    ] as const
                  ).map((cat) => {
                    const catItems = registryItems.filter(
                      (i) => i.category === cat,
                    );
                    if (catItems.length === 0) return null;
                    const meta = REGISTRY_CATEGORY_META[cat];
                    return (
                      <div key={cat} style={{ marginBottom: 16 }}>
                        <div
                          style={{
                            fontSize: "0.78rem",
                            fontWeight: 700,
                            color: meta.color,
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            marginBottom: 6,
                            paddingLeft: 4,
                          }}
                        >
                          {meta.label} ({catItems.length})
                        </div>
                        <div
                          style={{
                            background: "var(--bg-card)",
                            borderRadius: 10,
                            border: "1px solid var(--border)",
                            overflow: "hidden",
                          }}
                        >
                          {catItems.map((item, index) => (
                            <div
                              key={item.id}
                              onClick={() => toggleRegistrySelect(item.id)}
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                padding: "13px 15px",
                                borderBottom:
                                  index < catItems.length - 1
                                    ? "1px solid var(--border)"
                                    : "none",
                                cursor: "pointer",
                                background: selectedRegistryIds.has(item.id)
                                  ? "rgba(0,122,204,0.05)"
                                  : "transparent",
                                transition: "background 0.2s",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={selectedRegistryIds.has(item.id)}
                                onChange={() => {}}
                                style={{
                                  marginRight: 13,
                                  marginTop: 2,
                                  transform: "scale(1.1)",
                                }}
                              />
                              <div
                                style={{
                                  marginRight: 12,
                                  padding: 7,
                                  background: "rgba(255,255,255,0.05)",
                                  borderRadius: 7,
                                }}
                              >
                                {getRegistryIcon(item.category)}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                  }}
                                >
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      fontSize: "0.9rem",
                                      color: item.warning
                                        ? "#f59e0b"
                                        : "var(--text-main)",
                                    }}
                                  >
                                    {item.name}
                                  </span>
                                  {item.warning && (
                                    <AlertTriangle size={13} color="#f59e0b" />
                                  )}
                                </div>
                                <div
                                  style={{
                                    fontSize: "0.78rem",
                                    color: "var(--text-dim)",
                                    marginTop: 2,
                                  }}
                                >
                                  {item.description}
                                </div>
                                <div
                                  style={{
                                    fontSize: "0.7rem",
                                    color: "var(--text-dim)",
                                    fontFamily: "monospace",
                                    marginTop: 4,
                                    opacity: 0.7,
                                    wordBreak: "break-all",
                                  }}
                                >
                                  {item.key_path}
                                  {item.value_name && ` → "${item.value_name}"`}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

            {/* Registry empty state */}
            {registryScanned &&
              registryItems.length === 0 &&
              !registryCleaning && (
                <div
                  style={{
                    textAlign: "center",
                    padding: 40,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <CheckCircle size={64} color="#4ade80" />
                  <h3 style={{ marginTop: 20 }}>Registry is Clean</h3>
                  <p style={{ color: "var(--text-dim)" }}>
                    No orphaned or invalid registry entries found.
                  </p>
                  <button
                    className="secondary-btn"
                    onClick={scanRegistry}
                    style={{ marginTop: 20 }}
                  >
                    Scan Again
                  </button>
                </div>
              )}

            {/* Registry cleaning progress */}
            {registryCleaning && (
              <div
                className="modern-card"
                style={{ padding: 30, textAlign: "center" }}
              >
                <Loader2
                  size={48}
                  className="spinner"
                  style={{ marginBottom: 20 }}
                />
                <h3>Cleaning Registry...</h3>
                <p style={{ color: "var(--text-dim)" }}>
                  Removing selected entries
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      {/* end scroll area */}

      {/* ── FOOTER ACTIONS — junk cleaner ────────────────────────────── */}
      {scanned &&
        items.length > 0 &&
        !showPreview &&
        !cleaning &&
        !isRegistryTab && (
          <div
            style={{
              padding: 20,
              borderTop: "1px solid var(--border)",
              display: "flex",
              justifyContent: "center",
              gap: 10,
              background: "var(--panel-bg)",
            }}
          >
            <button
              className="secondary-btn"
              onClick={previewClean}
              disabled={loading || selectedIds.size === 0}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <Eye size={18} /> Preview ({selectedIds.size})
            </button>
            <button
              className="auth-btn danger-btn"
              onClick={initiateClean}
              disabled={loading || selectedIds.size === 0}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <Trash2 size={18} /> Clean Selected (
              {formatSize(totalSelectedSize)})
            </button>
          </div>
        )}

      {/* ── FOOTER ACTIONS — registry ─────────────────────────────────── */}
      {isRegistryTab &&
        registryScanned &&
        registryItems.length > 0 &&
        !registryCleaning && (
          <div
            style={{
              padding: 20,
              borderTop: "1px solid var(--border)",
              display: "flex",
              justifyContent: "center",
              gap: 10,
              background: "var(--panel-bg)",
            }}
          >
            <button
              className="secondary-btn"
              onClick={scanRegistry}
              disabled={registryLoading}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <RefreshCw size={18} /> Re-scan
            </button>
            <button
              className="auth-btn danger-btn"
              onClick={cleanRegistry}
              disabled={
                !registryBackupPath ||
                selectedRegistryIds.size === 0 ||
                registryCleaning
              }
              title={
                !registryBackupPath
                  ? "Create a backup first before cleaning"
                  : undefined
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: !registryBackupPath ? 0.5 : 1,
              }}
            >
              <Trash2 size={18} />
              {registryBackupPath
                ? `Clean Selected (${selectedRegistryIds.size})`
                : "Create Backup First"}
            </button>
          </div>
        )}

      {/* ── CONFIRMATION MODAL ───────────────────────────────────────── */}
      {showConfirmation && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowConfirmation(false)}
        >
          <div
            className="modern-card"
            style={{ maxWidth: 500, width: "90%", padding: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <AlertTriangle size={48} color="#f59e0b" />
            </div>
            <h3 style={{ textAlign: "center", marginBottom: 15 }}>
              Large Cleanup Operation
            </h3>
            <p style={{ color: "var(--text-dim)", marginBottom: 20 }}>
              You're about to delete{" "}
              <strong>{formatSize(totalSelectedSize)}</strong> of data. This
              operation cannot be undone.
            </p>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 20,
                cursor: "pointer",
                fontSize: "0.9rem",
              }}
            >
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />
              <span>
                I understand this will permanently delete the selected files
              </span>
            </label>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="secondary-btn"
                style={{ flex: 1 }}
                onClick={() => {
                  setShowConfirmation(false);
                  setConfirmChecked(false);
                }}
              >
                Cancel
              </button>
              <button
                className="auth-btn danger-btn"
                style={{ flex: 1 }}
                onClick={performClean}
                disabled={!confirmChecked}
              >
                Confirm & Clean
              </button>
            </div>
          </div>
        </div>
      )}

      {msg && <InfoModal message={msg} onClose={() => setMsg(null)} />}
    </div>
  );
}
