import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  join,
  downloadDir,
  desktopDir,
  documentDir,
  homeDir,
} from "@tauri-apps/api/path";
import {
  UploadCloud,
  ShieldAlert,
  FolderOpen,
  AlertTriangle,
  X,
} from "lucide-react";
import { formatSize } from "../../utils/formatting";

// Hooks
import { useFileSystem } from "../../hooks/useFileSystem";
import { useCrypto } from "../../hooks/useCrypto";
import { useDragDrop } from "../../hooks/useDragDrop";
import type { PortableDriveState } from "../../hooks/usePortableVault";

// Components
import { Toolbar } from "../dashboard/Toolbar";
import { AddressBar } from "../dashboard/AddressBar";
import { FileGrid } from "../dashboard/FileGrid";
import { ContextMenu } from "../dashboard/ContextMenu";
import { InputModal } from "../modals/InputModal";
import { EntropyModal } from "../modals/EntropyModal";
import {
  DeleteConfirmModal,
  CompressionModal,
  ProcessingModal,
  ErrorModal,
} from "../modals/AppModals";

import { BatchResult } from "../../types";

interface FilesViewProps {
  onShowBackupReminder: () => void;
  portable: {
    drives: PortableDriveState[];
    isScanning: boolean;
    scanDrives: () => void;
    lockVault: (p: string) => void;
  };
  onInitDrive: (path: string) => void;
  onUnlockDrive: (path: string) => void;
}

export function FilesView(props: FilesViewProps) {
  const fs = useFileSystem("dashboard");
  const crypto = useCrypto(fs.loadDir);

  // State
  const [showCompression, setShowCompression] = useState(false);
  const [showEntropyModal, setShowEntropyModal] = useState(false);
  const [pendingLockTargets, setPendingLockTargets] = useState<string[] | null>(
    null,
  );

  // Custom Modal States
  const [showGhostWarning, setShowGhostWarning] = useState(false);
  const [showExtractModal, setShowExtractModal] = useState(false);
  const [pendingUnlockTargets, setPendingUnlockTargets] = useState<
    string[] | null
  >(null);

  // Clipboard State for Cut/Copy/Paste functionality
  const [fileClipboard, setFileClipboard] = useState<{
    paths: string[];
    isCut: boolean;
  } | null>(null);

  const [menuData, setMenuData] = useState<{
    x: number;
    y: number;
    path: string;
    isBg: boolean;
  } | null>(null);
  const [inputModal, setInputModal] = useState<{
    mode: "rename" | "create";
    path: string;
  } | null>(null);
  const [itemsToDelete, setItemsToDelete] = useState<string[] | null>(null);

  // --- KEYBOARD SHORTCUTS ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (inputModal || itemsToDelete || showEntropyModal || showCompression)
        return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        fs.selectAll();
      }
      if (e.key === "Delete" && fs.selectedPaths.length > 0) {
        e.preventDefault();
        setItemsToDelete(fs.selectedPaths);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        fs.clearSelection();
        setFileClipboard(null);
      }
      if (e.key === "Backspace") {
        fs.goUp();
      }

      if (e.key === "Enter" && fs.selectedPaths.length === 1) {
        const entry = fs.entries.find((en) => en.path === fs.selectedPaths[0]);
        if (entry && entry.isDirectory) fs.loadDir(entry.path);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    fs.selectedPaths,
    fs.entries,
    inputModal,
    itemsToDelete,
    showEntropyModal,
    showCompression,
  ]);

  // --- CUSTOM UX ROUTING LOGIC ---
  const isPortableTarget = (targets: string[]) => {
    const portableMountPaths = props.portable.drives
      .filter((d) => d.isUnlocked)
      .map((d) => d.drive.path);
    return targets.some((t) =>
      portableMountPaths.some((mount) =>
        t.toLowerCase().startsWith(mount.toLowerCase()),
      ),
    );
  };

  const requestLock = useCallback(
    async (targets: string[]) => {
      if (isPortableTarget(targets)) {
        setPendingLockTargets(targets);
        setShowGhostWarning(true);
      } else {
        executeLock(targets);
      }
    },
    [props.portable.drives],
  );

  const executeLock = async (targets: string[], explicitEntropy?: number[]) => {
    if (crypto.isParanoid && !explicitEntropy) {
      setPendingLockTargets(targets);
      setShowEntropyModal(true);
    } else {
      // FIX 1: Corrected if (results) statement
      const results = await crypto.runCrypto(
        "lock_file",
        targets,
        fs.currentPath,
        explicitEntropy,
      );
      if (results) {
        const failures = results.filter((r) => !r.success);
        if (failures.length > 0) {
          crypto.setErrorMsg(
            "Locking failed for some items:\n" +
              failures.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
          );
        } else {
          props.onShowBackupReminder();
        }
      }
    }
  };

  const requestUnlock = useCallback(
    async (targets: string[]) => {
      if (isPortableTarget(targets)) {
        setPendingUnlockTargets(targets);
        setShowExtractModal(true);
      } else {
        // FIX 2: Added fs.currentPath to the function call
        const results = await crypto.runCrypto(
          "unlock_file",
          targets,
          fs.currentPath,
        );
        if (results) {
          const failures = results.filter((r) => !r.success);
          if (failures.length > 0) {
            crypto.setErrorMsg(
              "Unlock failed:\n" +
                failures.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
            );
          }
        }
      }
    },
    [props.portable.drives, fs.currentPath],
  );

  const handleEntropyComplete = async (entropy: number[]) => {
    setShowEntropyModal(false);
    if (pendingLockTargets) {
      await executeLock(pendingLockTargets, entropy);
      setPendingLockTargets(null);
    }
  };

  const handleDrop = useCallback(
    async (paths: string[]) => {
      const toUnlock = paths.filter((p) => p.endsWith(".qre"));
      const toLock = paths.filter((p) => !p.endsWith(".qre"));
      if (toUnlock.length > 0) requestUnlock(toUnlock);
      if (toLock.length > 0) requestLock(toLock);
    },
    [requestLock, requestUnlock],
  );

  const { isDragging } = useDragDrop(handleDrop);

  function handleContextMenu(e: React.MouseEvent, path: string | null) {
    e.preventDefault();
    e.stopPropagation();
    setMenuData({
      x: e.clientX,
      y: e.clientY,
      path: path || fs.currentPath,
      isBg: !path,
    });
  }

  async function handleContextAction(action: string) {
    if (!menuData) return;
    const { path, isBg } = menuData;
    setMenuData(null);

    if (action === "refresh") return fs.loadDir(fs.currentPath);
    if (action === "new_folder")
      return setInputModal({ mode: "create", path: fs.currentPath });

    if (action === "paste" && fileClipboard) {
      try {
        crypto.setErrorMsg(null);
        const results = await invoke<BatchResult[]>("paste_items", {
          sources: fileClipboard.paths,
          destDir: fs.currentPath,
          isCut: fileClipboard.isCut,
        });

        const failures = results.filter((r) => !r.success);
        if (failures.length > 0) {
          crypto.setErrorMsg(
            "Paste failed:\n" +
              failures.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
          );
        }

        if (fileClipboard.isCut) setFileClipboard(null);
        fs.loadDir(fs.currentPath);
      } catch (e) {
        crypto.setErrorMsg(String(e));
      } finally {
        crypto.clearProgress(500);
      }
      return;
    }

    if (isBg) return;

    let targets = [path];
    if (fs.selectedPaths.includes(path)) targets = fs.selectedPaths;

    if (action === "lock") requestLock(targets);
    if (action === "unlock") requestUnlock(targets);
    if (action === "share")
      invoke("show_in_folder", { path }).catch((e) =>
        crypto.setErrorMsg(String(e)),
      );
    if (action === "rename") setInputModal({ mode: "rename", path });
    if (action === "delete") setItemsToDelete(targets);

    if (action === "cut") setFileClipboard({ paths: targets, isCut: true });
    if (action === "copy") setFileClipboard({ paths: targets, isCut: false });
  }

  async function performDeleteAction(mode: "trash" | "shred") {
    if (!itemsToDelete) return;
    crypto.setErrorMsg(null);
    const targets = [...itemsToDelete];
    setItemsToDelete(null);
    const command = mode === "shred" ? "delete_items" : "trash_items";

    try {
      const results = await invoke<BatchResult[]>(command, { paths: targets });
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        const report = failures
          .map((f) => `• ${f.name}: ${f.message}`)
          .join("\n");
        crypto.setErrorMsg(`Errors occurred:\n\n${report}`);
      }
      fs.loadDir(fs.currentPath);
      fs.setSelectedPaths([]);
    } catch (e) {
      crypto.setErrorMsg(String(e));
    } finally {
      crypto.clearProgress(500);
    }
  }

  async function handleInputConfirm(val: string) {
    if (!inputModal || !val.trim()) return;
    const { mode, path } = inputModal;
    setInputModal(null);
    try {
      if (mode === "create")
        await invoke("create_dir", { path: await join(path, val) });
      else await invoke("rename_item", { path, newName: val });
      fs.loadDir(fs.currentPath);
    } catch (e) {
      crypto.setErrorMsg(String(e));
    }
  }

  const executeExtract = async (dir: string | undefined) => {
    setShowExtractModal(false);
    if (!pendingUnlockTargets) return;

    // FIX 3: Added fs.currentPath to the function call
    const results = await crypto.runCrypto(
      "unlock_file",
      pendingUnlockTargets,
      fs.currentPath,
      undefined,
      dir,
    );
    if (results) {
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        crypto.setErrorMsg(
          "Unlock failed:\n" +
            failures.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
        );
      }
    }
    setPendingUnlockTargets(null);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative",
      }}
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      <Toolbar
        onLock={() => requestLock(fs.selectedPaths)}
        onUnlock={() => requestUnlock(fs.selectedPaths)}
        onNavigate={fs.loadDir}
        // FIX 4: Removed onRefresh from the Toolbar component props here
        keyFile={crypto.keyFile}
        setKeyFile={crypto.setKeyFile}
        selectKeyFile={crypto.selectKeyFile}
        isParanoid={crypto.isParanoid}
        setIsParanoid={crypto.setIsParanoid}
        compressionMode={crypto.compressionMode}
        onOpenCompression={() => setShowCompression(true)}
        portable={props.portable}
        onInitDrive={props.onInitDrive}
        onUnlockDrive={props.onUnlockDrive}
      />
      <AddressBar
        currentPath={fs.currentPath}
        onGoUp={fs.goUp}
        onNavigate={fs.loadDir}
        onGoHome={async () => {
          try {
            const dir = await homeDir();
            fs.loadDir(dir);
          } catch (e) {
            console.error("Failed to resolve Home dir", e);
          }
        }}
      />
      <FileGrid
        entries={fs.entries}
        selectedPaths={fs.selectedPaths}
        onSelect={(path, idx, multi, range) =>
          fs.handleSelection(path, idx, multi, range)
        }
        onNavigate={fs.loadDir}
        onGoUp={fs.goUp}
        onContextMenu={handleContextMenu}
        sortField={fs.sortField}
        sortDirection={fs.sortDirection}
        onSort={fs.handleSort}
      />

      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-content">
            <UploadCloud />
            <span>Drop to Lock</span>
          </div>
        </div>
      )}

      <div className="status-bar">
        <span>{fs.entries.length} items</span>
        <div
          style={{
            width: 1,
            height: 14,
            background: "var(--border)",
            margin: "0 10px",
          }}
        ></div>
        <span>
          {fs.selectedPaths.length > 0
            ? `${fs.selectedPaths.length} selected (${formatSize(fs.selectionSize)})`
            : "No selection"}
        </span>
        <div style={{ flex: 1 }}></div>

        {fileClipboard && (
          <span
            style={{
              color: "var(--accent)",
              fontSize: "0.75rem",
              marginRight: 15,
            }}
          >
            {fileClipboard.paths.length} item(s){" "}
            {fileClipboard.isCut ? "cut" : "copied"}
          </span>
        )}

        {crypto.keyFile && (
          <span style={{ color: "var(--btn-success)", fontSize: "0.75rem" }}>
            Keyfile Active
          </span>
        )}
      </div>

      {menuData && (
        <ContextMenu
          x={menuData.x}
          y={menuData.y}
          targetPath={menuData.path}
          isBackground={menuData.isBg}
          onClose={() => setMenuData(null)}
          onAction={handleContextAction}
          canPaste={fileClipboard !== null}
        />
      )}

      {inputModal && (
        <InputModal
          mode={inputModal.mode}
          initialValue={
            inputModal.mode === "rename"
              ? inputModal.path.split(/[/\\]/).pop() || ""
              : ""
          }
          onConfirm={handleInputConfirm}
          onCancel={() => setInputModal(null)}
        />
      )}

      {itemsToDelete && (
        <DeleteConfirmModal
          items={itemsToDelete}
          onTrash={() => performDeleteAction("trash")}
          onShred={() => performDeleteAction("shred")}
          onCancel={() => setItemsToDelete(null)}
        />
      )}

      {showCompression && (
        <CompressionModal
          current={crypto.compressionMode}
          onSave={(mode) => {
            crypto.setCompressionMode(mode);
            setShowCompression(false);
          }}
          onCancel={() => setShowCompression(false)}
        />
      )}

      {/* GHOST WARNING MODAL */}
      {showGhostWarning && pendingLockTargets && (
        <div className="modal-overlay" style={{ zIndex: 100005 }}>
          <div className="auth-card">
            <div
              className="modal-header"
              style={{ borderBottomColor: "var(--warning)" }}
            >
              <AlertTriangle size={24} color="var(--warning)" />
              <h2 style={{ color: "var(--warning)" }}>
                USB Encryption Warning
              </h2>
            </div>
            <div className="modal-body">
              <p
                style={{
                  color: "var(--text-main)",
                  fontSize: "0.95rem",
                  lineHeight: 1.5,
                }}
              >
                You are about to encrypt a file directly on a USB drive.
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.85rem",
                  lineHeight: 1.5,
                  background: "rgba(245, 158, 11, 0.1)",
                  padding: 15,
                  borderRadius: 8,
                }}
              >
                <strong>Hardware Risk:</strong> USB Flash memory uses
                "wear-leveling". When QRE deletes the original unencrypted file,
                the USB hardware might leave a hidden ghost copy of the
                plaintext intact.
                <br />
                <br />
                <strong>Best Practice:</strong> Encrypt the file on your PC
                first, then copy the locked <code>.qre</code> file to the USB.
              </p>
              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setShowGhostWarning(false);
                    setPendingLockTargets(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn"
                  style={{
                    flex: 1,
                    background: "var(--warning)",
                    color: "#000",
                  }}
                  onClick={() => {
                    setShowGhostWarning(false);
                    executeLock(pendingLockTargets);
                  }}
                >
                  I Understand, Proceed
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EXTRACT LOCATION MODAL */}
      {showExtractModal && pendingUnlockTargets && (
        <div className="modal-overlay" style={{ zIndex: 100005 }}>
          <div className="auth-card" style={{ width: 400 }}>
            <div className="modal-header">
              <FolderOpen size={24} color="var(--accent)" />
              <h2>Extract Files</h2>
              <div style={{ flex: 1 }}></div>
              <X
                size={20}
                style={{ cursor: "pointer" }}
                onClick={() => {
                  setShowExtractModal(false);
                  setPendingUnlockTargets(null);
                }}
              />
            </div>
            <div className="modal-body">
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.9rem",
                  marginBottom: 20,
                }}
              >
                Select where to save the decrypted files. Saving them back to
                the USB is not recommended.
              </p>

              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                <ExtractOption
                  label="Downloads"
                  onClick={async () => executeExtract(await downloadDir())}
                />
                <ExtractOption
                  label="Desktop"
                  onClick={async () => executeExtract(await desktopDir())}
                />
                <ExtractOption
                  label="Documents"
                  onClick={async () => executeExtract(await documentDir())}
                />
                <div
                  style={{
                    height: 1,
                    background: "var(--border)",
                    margin: "5px 0",
                  }}
                ></div>
                <ExtractOption
                  label="Extract Here (USB)"
                  color="var(--warning)"
                  onClick={() => executeExtract(undefined)}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {showEntropyModal && (
        <EntropyModal
          onComplete={handleEntropyComplete}
          onCancel={() => {
            setShowEntropyModal(false);
            setPendingLockTargets(null);
          }}
        />
      )}

      {crypto.errorMsg && (
        <ErrorModal
          message={crypto.errorMsg}
          onClose={() => crypto.setErrorMsg(null)}
        />
      )}

      {fs.accessDenied && (
        <div className="modal-overlay" style={{ zIndex: 99999 }}>
          <div
            className="auth-card"
            style={{ borderColor: "var(--btn-danger)" }}
          >
            <div
              className="modal-header"
              style={{ borderBottomColor: "var(--btn-danger)" }}
            >
              <ShieldAlert size={24} color="var(--btn-danger)" />
              <h2 style={{ color: "var(--btn-danger)" }}>Access Denied</h2>
            </div>
            <div className="modal-body" style={{ textAlign: "center" }}>
              <p
                style={{
                  fontSize: "1.1rem",
                  marginBottom: 10,
                  fontWeight: "bold",
                }}
              >
                System Protection Active
              </p>
              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                For your security, QRE Privacy Toolkit blocks access to critical
                operating system folders.
              </p>
              <div
                style={{
                  background: "rgba(217, 64, 64, 0.1)",
                  padding: 10,
                  borderRadius: 6,
                  margin: "15px 0",
                  fontFamily: "monospace",
                  fontSize: "0.85rem",
                  wordBreak: "break-all",
                }}
              >
                {fs.accessDenied}
              </div>
              <button
                className="auth-btn danger-btn"
                style={{ width: "100%" }}
                onClick={() => fs.setAccessDenied(null)}
              >
                Understood
              </button>
            </div>
          </div>
        </div>
      )}

      {!showEntropyModal && crypto.progress && (
        <ProcessingModal
          status={crypto.progress.status}
          percentage={crypto.progress.percentage}
        />
      )}
    </div>
  );
}

function ExtractOption({ label, onClick, color }: any) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "12px 15px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-color)",
        color: color || "var(--text-main)",
        fontSize: "0.95rem",
        fontWeight: "bold",
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.2s",
      }}
      onMouseOver={(e) =>
        (e.currentTarget.style.background = "var(--highlight)")
      }
      onMouseOut={(e) => (e.currentTarget.style.background = "var(--bg-color)")}
    >
      {label}
    </button>
  );
}
