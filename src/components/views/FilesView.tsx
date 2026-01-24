import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { UploadCloud } from "lucide-react";

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

// Types
import { BatchResult } from "../../types";

interface FilesViewProps {
  onShowBackupReminder: () => void; // <--- ADDED PROP
}

export function FilesView(props: FilesViewProps) {
  const fs = useFileSystem("dashboard");
  const crypto = useCrypto(() => fs.loadDir(fs.currentPath));

  // --- LOCAL STATE ---
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

  // --- LOGIC: Lock Request ---
  const requestLock = useCallback(
    async (targets: string[]) => {
      if (crypto.isParanoid) {
        setPendingLockTargets(targets);
        setShowEntropyModal(true);
      } else {
        // Run Encryption
        await crypto.runCrypto("lock_file", targets);
        // Trigger Reminder Check
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
      // Trigger Reminder Check
      props.onShowBackupReminder();
    }
  };

  // --- DROP HANDLER ---
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

  // --- CONTEXT MENU ---
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

  // --- FILE OPS ---
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
        crypto.setErrorMsg(`Operation completed with errors:\n\n${report}`);
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
        onSelect={(path, multi) => {
          if (multi)
            fs.setSelectedPaths((prev) =>
              prev.includes(path)
                ? prev.filter((p) => p !== path)
                : [...prev, path],
            );
          else fs.setSelectedPaths([path]);
        }}
        onNavigate={fs.loadDir}
        onGoUp={fs.goUp}
        onContextMenu={handleContextMenu}
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
        {fs.statusMsg} | {fs.selectedPaths.length} selected
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
