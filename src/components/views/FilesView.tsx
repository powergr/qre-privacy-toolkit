import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { UploadCloud } from "lucide-react";
import { formatSize } from "../../utils/formatting";

// Hooks
import { useFileSystem } from "../../hooks/useFileSystem";
import { useCrypto } from "../../hooks/useCrypto";
import { useDragDrop } from "../../hooks/useDragDrop";

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
}

export function FilesView(props: FilesViewProps) {
  const fs = useFileSystem("dashboard");
  const crypto = useCrypto(() => fs.loadDir(fs.currentPath));

  // State
  const [showCompression, setShowCompression] = useState(false);
  const [showEntropyModal, setShowEntropyModal] = useState(false);
  const [pendingLockTargets, setPendingLockTargets] = useState<string[] | null>(
    null,
  );
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
      // Ignore if modals are open or typing in inputs
      if (inputModal || itemsToDelete || showEntropyModal || showCompression)
        return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      // Select All (Ctrl+A / Cmd+A)
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        fs.selectAll();
      }

      // Delete
      if (e.key === "Delete" && fs.selectedPaths.length > 0) {
        e.preventDefault();
        setItemsToDelete(fs.selectedPaths);
      }

      // Escape (Clear Selection)
      if (e.key === "Escape") {
        e.preventDefault();
        fs.clearSelection();
      }

      // Backspace (Go Up)
      if (e.key === "Backspace") {
        fs.goUp();
      }

      // Enter (Open if 1 item selected and is dir)
      if (e.key === "Enter" && fs.selectedPaths.length === 1) {
        const entry = fs.entries.find((en) => en.path === fs.selectedPaths[0]);
        if (entry && entry.isDirectory) {
          fs.loadDir(entry.path);
        }
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

  // --- LOGIC ---
  const requestLock = useCallback(
    async (targets: string[]) => {
      if (crypto.isParanoid) {
        setPendingLockTargets(targets);
        setShowEntropyModal(true);
      } else {
        await crypto.runCrypto("lock_file", targets);
        props.onShowBackupReminder();
      }
    },
    [crypto, props],
  );

  const handleEntropyComplete = async (entropy: number[]) => {
    setShowEntropyModal(false);
    if (pendingLockTargets) {
      await crypto.runCrypto("lock_file", pendingLockTargets, entropy);
      setPendingLockTargets(null);
      props.onShowBackupReminder();
    }
  };

  const handleDrop = useCallback(
    async (paths: string[]) => {
      const toUnlock = paths.filter((p) => p.endsWith(".qre"));
      const toLock = paths.filter((p) => !p.endsWith(".qre"));
      if (toUnlock.length > 0) await crypto.runCrypto("unlock_file", toUnlock);
      if (toLock.length > 0) requestLock(toLock);
    },
    [crypto, requestLock],
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
    if (isBg) return;

    let targets = [path];
    if (fs.selectedPaths.includes(path)) targets = fs.selectedPaths;

    if (action === "lock") requestLock(targets);
    if (action === "unlock") crypto.runCrypto("unlock_file", targets);
    if (action === "share")
      invoke("show_in_folder", { path }).catch((e) =>
        crypto.setErrorMsg(String(e)),
      );
    if (action === "rename") setInputModal({ mode: "rename", path });
    if (action === "delete") setItemsToDelete(targets);
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
        onUnlock={() => crypto.runCrypto("unlock_file", fs.selectedPaths)}
        onRefresh={() => fs.loadDir(fs.currentPath)}
        keyFile={crypto.keyFile}
        setKeyFile={crypto.setKeyFile}
        selectKeyFile={crypto.selectKeyFile}
        isParanoid={crypto.isParanoid}
        setIsParanoid={crypto.setIsParanoid}
        compressionMode={crypto.compressionMode}
        onOpenCompression={() => setShowCompression(true)}
      />

      <AddressBar
        currentPath={fs.currentPath}
        onGoUp={fs.goUp}
        onNavigate={fs.loadDir}
      />

      <FileGrid
        entries={fs.entries}
        selectedPaths={fs.selectedPaths}
        // Updated Signature:
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

      {/* Modern Status Bar */}
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
      {!showEntropyModal && crypto.progress && (
        <ProcessingModal
          status={crypto.progress.status}
          percentage={crypto.progress.percentage}
        />
      )}
    </div>
  );
}
