import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { UploadCloud } from "lucide-react";
import "./App.css";

// Hooks
import { useTheme } from "./hooks/useTheme";
import { useAuth } from "./hooks/useAuth";
import { useFileSystem } from "./hooks/useFileSystem";
import { useCrypto } from "./hooks/useCrypto";
import { useDragDrop } from "./hooks/useDragDrop";

// Components
import { AuthOverlay } from "./components/auth/AuthOverlay";
import { Toolbar } from "./components/dashboard/Toolbar";
import { AddressBar } from "./components/dashboard/AddressBar";
import { FileGrid } from "./components/dashboard/FileGrid";
import { ContextMenu } from "./components/dashboard/ContextMenu";
import { InputModal } from "./components/modals/InputModal";
import { HelpModal } from "./components/modals/HelpModal";
import { EntropyModal } from "./components/modals/EntropyModal";
import {
  AboutModal,
  ResetConfirmModal,
  ChangePassModal,
  DeleteConfirmModal,
  CompressionModal,
  ProcessingModal,
  ThemeModal,
  ErrorModal,
  BackupModal,
  InfoModal,
  TimeoutWarningModal,
} from "./components/modals/AppModals";

// Types
import { BatchResult } from "./types";

function App() {
  const { theme, setTheme } = useTheme();
  const auth = useAuth();
  const fs = useFileSystem(auth.view);
  const crypto = useCrypto(() => fs.loadDir(fs.currentPath));

  // --- LOCAL STATE ---
  const [showAbout, setShowAbout] = useState(false);
  const [showChangePass, setShowChangePass] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showCompression, setShowCompression] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showBackupModal, setShowBackupModal] = useState(false);

  // New: Entropy State
  const [showEntropyModal, setShowEntropyModal] = useState(false);
  const [pendingLockTargets, setPendingLockTargets] = useState<string[] | null>(
    null
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
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  // --- LOGIC: Handle Lock Request (Intercept for Paranoid Mode) ---
  const requestLock = useCallback(
    (targets: string[]) => {
      if (crypto.isParanoid) {
        setPendingLockTargets(targets);
        setShowEntropyModal(true);
      } else {
        crypto.runCrypto("lock_file", targets);
      }
    },
    [crypto]
  );

  // --- HANDLER: Entropy Collected ---
  const handleEntropyComplete = (entropy: number[]) => {
    setShowEntropyModal(false);
    if (pendingLockTargets) {
      crypto.runCrypto("lock_file", pendingLockTargets, entropy);
      setPendingLockTargets(null);
    }
  };

  // --- DROP HANDLER ---
  const handleDrop = useCallback(
    async (paths: string[]) => {
      const toUnlock = paths.filter((p) => p.endsWith(".qre"));
      const toLock = paths.filter((p) => !p.endsWith(".qre"));

      if (toUnlock.length > 0) {
        await crypto.runCrypto("unlock_file", toUnlock);
      }

      if (toLock.length > 0) {
        requestLock(toLock);
      }
    },
    [crypto, requestLock]
  );

  const { isDragging } = useDragDrop(handleDrop);

  // --- CONTEXT MENU HANDLERS ---
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
        crypto.setErrorMsg(String(e))
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
      if (mode === "create") {
        await invoke("create_dir", { path: await join(path, val) });
      } else {
        await invoke("rename_item", { path, newName: val });
      }
      fs.loadDir(fs.currentPath);
    } catch (e) {
      crypto.setErrorMsg(String(e));
    }
  }

  function handleBackupRequest() {
    setShowBackupModal(true);
  }

  async function performBackup() {
    setShowBackupModal(false);
    try {
      const path = await save({
        filters: [{ name: "QRE Keychain", extensions: ["json"] }],
        defaultPath: "QRE_Backup.json",
      });

      if (path) {
        await invoke("export_keychain", { savePath: path });
        setInfoMsg("Backup saved successfully.\nKeep it safe!");
      }
    } catch (e) {
      crypto.setErrorMsg("Backup failed: " + String(e));
    }
  }

  // --- RENDER ---
  if (auth.view === "loading")
    return <div className="auth-overlay">Loading...</div>;

  if (
    ["setup", "login", "recovery_entry", "recovery_display"].includes(auth.view)
  ) {
    return (
      <>
        {auth.sessionExpired && (
          <InfoModal
            message="Session timed out due to inactivity."
            onClose={() => auth.setSessionExpired(false)}
          />
        )}
        <AuthOverlay
          view={auth.view}
          password={auth.password}
          setPassword={auth.setPassword}
          confirmPass={auth.confirmPass}
          setConfirmPass={auth.setConfirmPass}
          recoveryCode={auth.recoveryCode}
          setRecoveryCode={auth.setRecoveryCode}
          onLogin={async () => {
            const res = await auth.handleLogin();
            if (!res.success) crypto.setErrorMsg(res.msg || "Login failed");
          }}
          onInit={async () => {
            const res = await auth.handleInit();
            if (!res.success) crypto.setErrorMsg(res.msg || "Setup failed");
          }}
          onRecovery={async () => {
            const res = await auth.handleRecovery();
            if (!res.success) crypto.setErrorMsg(res.msg || "Recovery failed");
            else setInfoMsg("Vault recovered successfully.");
          }}
          onAckRecoveryCode={() => auth.setView("dashboard")}
          onSwitchToRecovery={() => auth.setView("recovery_entry")}
          onCancelRecovery={() => auth.setView("login")}
        />
      </>
    );
  }

  return (
    <div
      className="main-layout"
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      <Toolbar
        onLock={() => requestLock(fs.selectedPaths)}
        onUnlock={() => crypto.runCrypto("unlock_file", fs.selectedPaths)}
        onRefresh={() => fs.loadDir(fs.currentPath)}
        onLogout={auth.logout}
        keyFile={crypto.keyFile}
        setKeyFile={crypto.setKeyFile}
        selectKeyFile={crypto.selectKeyFile}
        isParanoid={crypto.isParanoid}
        setIsParanoid={crypto.setIsParanoid}
        compressionMode={crypto.compressionMode}
        onOpenCompression={() => setShowCompression(true)}
        onChangePassword={() => setShowChangePass(true)}
        onReset2FA={() => setShowResetConfirm(true)}
        onTheme={() => setShowThemeModal(true)}
        onAbout={() => setShowAbout(true)}
        onHelp={() => setShowHelpModal(true)}
        onBackup={handleBackupRequest}
      />

      <AddressBar
        currentPath={fs.currentPath}
        onGoUp={fs.goUp}
        onNavigate={fs.loadDir} // <--- FIXED: Added onNavigate prop
      />

      <FileGrid
        entries={fs.entries}
        selectedPaths={fs.selectedPaths}
        onSelect={(path, multi) => {
          if (multi)
            fs.setSelectedPaths((prev) =>
              prev.includes(path)
                ? prev.filter((p) => p !== path)
                : [...prev, path]
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
          onSave={(mode: string) => {
            crypto.setCompressionMode(mode);
            setShowCompression(false);
          }}
          onCancel={() => setShowCompression(false)}
        />
      )}

      {showThemeModal && (
        <ThemeModal
          currentTheme={theme}
          onSave={(t) => {
            setTheme(t);
            setShowThemeModal(false);
          }}
          onCancel={() => setShowThemeModal(false)}
        />
      )}

      {showHelpModal && <HelpModal onClose={() => setShowHelpModal(false)} />}

      {showEntropyModal && (
        <EntropyModal
          onComplete={handleEntropyComplete}
          onCancel={() => {
            setShowEntropyModal(false);
            setPendingLockTargets(null);
          }}
        />
      )}

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {showBackupModal && (
        <BackupModal
          onProceed={performBackup}
          onCancel={() => setShowBackupModal(false)}
        />
      )}

      {auth.showTimeoutWarning && (
        <TimeoutWarningModal
          seconds={auth.countdown}
          onStay={auth.stayLoggedIn}
        />
      )}

      {showResetConfirm && (
        <ResetConfirmModal
          onConfirm={async () => {
            const res = await auth.handleReset2FA();
            if (!res.success) crypto.setErrorMsg(res.msg || "Reset failed");
            setShowResetConfirm(false);
          }}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}

      {showChangePass && (
        <ChangePassModal
          pass={auth.password}
          setPass={auth.setPassword}
          confirm={auth.confirmPass}
          setConfirm={auth.setConfirmPass}
          onUpdate={async () => {
            const res = await auth.handleChangePassword();
            if (!res.success) crypto.setErrorMsg(res.msg || "Update failed");
            else {
              setInfoMsg("Password updated successfully.");
              setShowChangePass(false);
            }
          }}
          onCancel={() => {
            setShowChangePass(false);
            auth.setPassword("");
          }}
        />
      )}

      {crypto.errorMsg && (
        <ErrorModal
          message={crypto.errorMsg}
          onClose={() => crypto.setErrorMsg(null)}
        />
      )}
      {infoMsg && (
        <InfoModal message={infoMsg} onClose={() => setInfoMsg(null)} />
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

export default App;
