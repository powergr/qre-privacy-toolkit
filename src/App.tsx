import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, stat } from "@tauri-apps/plugin-fs";
import { homeDir, join } from "@tauri-apps/api/path";
import { message, open } from "@tauri-apps/plugin-dialog";
import "./App.css";

import { FileEntry, ViewState } from "./types";
import { getPasswordScore, generateBrowserEntropy } from "./utils/security";

// Components
import { AuthOverlay } from "./components/auth/AuthOverlay";
import { Toolbar } from "./components/dashboard/Toolbar";
import { AddressBar } from "./components/dashboard/AddressBar";
import { FileGrid } from "./components/dashboard/FileGrid";
import {
  AboutModal,
  ResetConfirmModal,
  ChangePassModal,
  DeleteConfirmModal,
  CompressionModal,
  ProcessingModal,
  ThemeModal,
} from "./components/modals/AppModals";
import { ContextMenu } from "./components/dashboard/ContextMenu";
import { InputModal } from "./components/modals/InputModal";

function App() {
  const [view, setView] = useState<ViewState>("loading");

  // Auth Data
  const [password, setPassword] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");

  // Filesystem Data
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [statusMsg, setStatusMsg] = useState("Ready");

  // Context Menu State
  const [menuData, setMenuData] = useState<{
    x: number;
    y: number;
    path: string;
    isBg: boolean;
  } | null>(null);

  // Input Modal State (Rename/Create)
  const [inputModal, setInputModal] = useState<{
    mode: "rename" | "create";
    path: string;
  } | null>(null);

  // Delete Modal State
  const [itemsToDelete, setItemsToDelete] = useState<string[] | null>(null);

  // Startup File State
  const [pendingFile, setPendingFile] = useState<string | null>(null);

  // Settings
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [isParanoid, setIsParanoid] = useState(false);
  const [compressionMode, setCompressionMode] = useState("normal"); // fast, normal, best

  // Theme State
  const [theme, setTheme] = useState(
    () => localStorage.getItem("qre-theme") || "system"
  );

  // Modals Visibility
  const [showAbout, setShowAbout] = useState(false);
  const [showChangePass, setShowChangePass] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showCompression, setShowCompression] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);

  // PROGRESS STATE
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    filename: string;
  } | null>(null);

  // --- THEME EFFECT ---
  useEffect(() => {
    // Apply theme
    if (theme === "system") {
      delete document.body.dataset.theme;
    } else {
      document.body.dataset.theme = theme;
    }
    localStorage.setItem("qre-theme", theme);
  }, [theme]);

  useEffect(() => {
    checkAuthAndStartup();
  }, []);

  async function checkAuthAndStartup() {
    try {
      const startupFile = await invoke<string | null>("get_startup_file");
      if (startupFile) setPendingFile(startupFile);

      const status = await invoke("check_auth_status");
      if (status === "unlocked") {
        setView("dashboard");
        if (startupFile) handleStartupNavigation(startupFile);
        else loadInitialPath();
      } else if (status === "setup_needed") setView("setup");
      else setView("login");
    } catch (e) {
      console.error(e);
    }
  }

  async function handleStartupNavigation(path: string) {
    const sep = navigator.userAgent.includes("Windows") ? "\\" : "/";
    const parts = path.split(sep);
    parts.pop();
    let parent = parts.join(sep);

    if (!navigator.userAgent.includes("Windows") && !parent.startsWith("/"))
      parent = "/" + parent;
    if (navigator.userAgent.includes("Windows") && parent.endsWith(":"))
      parent += sep;
    if (parent === "")
      parent = navigator.userAgent.includes("Windows") ? "" : "/";

    await loadDir(parent);
    setSelectedPaths([path]);
    setStatusMsg(`Opened: ${path}`);
  }

  async function loadInitialPath() {
    try {
      loadDir(await homeDir());
    } catch {
      loadDir("");
    }
  }

  async function loadDir(path: string) {
    try {
      if (path === "") {
        const drives = await invoke<string[]>("get_drives");
        setEntries(
          drives.map((d) => ({
            name: d,
            isDirectory: true,
            path: d,
            isDrive: true,
            size: null,
            modified: null,
          }))
        );
        setCurrentPath("");
        setSelectedPaths([]);
        setStatusMsg("Select a Drive");
        return;
      }
      const contents = await readDir(path);
      const separator = navigator.userAgent.includes("Windows") ? "\\" : "/";
      const mapped = await Promise.all(
        contents.map(async (entry) => {
          const cleanPath = path.endsWith(separator) ? path : path + separator;
          const fullPath = `${cleanPath}${entry.name}`;
          let size = null,
            modified = null;
          try {
            const m = await stat(fullPath);
            size = m.size;
            if (m.mtime) modified = new Date(m.mtime);
          } catch {}
          return {
            name: entry.name,
            isDirectory: entry.isDirectory,
            path: fullPath,
            size,
            modified,
          };
        })
      );
      mapped.sort((a, b) =>
        a.isDirectory === b.isDirectory
          ? a.name.localeCompare(b.name)
          : a.isDirectory
          ? -1
          : 1
      );
      setEntries(mapped);
      setCurrentPath(path);
      setSelectedPaths([]);
      setStatusMsg(`Loaded: ${path}`);
    } catch (e) {
      console.error(e);
      setStatusMsg(`Error: ${String(e)}`);
    }
  }

  function goUp() {
    if (currentPath === "") return;
    const isWindows = navigator.userAgent.includes("Windows");
    const separator = isWindows ? "\\" : "/";
    if (
      currentPath === "/" ||
      (isWindows && currentPath.length <= 3 && currentPath.includes(":"))
    ) {
      loadDir(isWindows ? "" : "/");
      return;
    }
    const parts = currentPath.split(separator).filter((p) => p);
    parts.pop();
    let parent = parts.join(separator);
    if (!isWindows) parent = "/" + parent;
    if (isWindows && parent.length === 2 && parent.endsWith(":"))
      parent += separator;
    loadDir(parts.length === 0 ? (isWindows ? "" : "/") : parent);
  }

  // --- ACTIONS ---
  async function handleInit() {
    if (getPasswordScore(password) < 3)
      return message("Password too weak.", { kind: "warning" });
    if (password !== confirmPass)
      return message("Mismatch.", { kind: "error" });
    try {
      setRecoveryCode((await invoke("init_vault", { password })) as string);
      setView("recovery_display");
    } catch (e) {
      message(String(e), { kind: "error" });
    }
  }

  async function handleLogin() {
    try {
      await invoke("login", { password });
      setPassword("");
      setView("dashboard");

      if (pendingFile) {
        handleStartupNavigation(pendingFile);
        setPendingFile(null);
      } else {
        loadInitialPath();
      }
    } catch (e) {
      message(String(e), { kind: "error" });
    }
  }

  async function handleRecovery() {
    if (!recoveryCode || password !== confirmPass)
      return message("Check inputs.", { kind: "error" });
    try {
      await invoke("recover_vault", {
        recoveryCode: recoveryCode.trim(),
        newPassword: password,
      });
      setPassword("");
      setConfirmPass("");
      setRecoveryCode("");
      setView("dashboard");
      loadInitialPath();
      message("Vault recovered.", { kind: "info" });
    } catch (e) {
      message(String(e), { kind: "error" });
    }
  }

  async function handleChangePassword() {
    if (password !== confirmPass)
      return message("Mismatch.", { kind: "error" });
    if (getPasswordScore(password) < 3)
      return message("Weak Password.", { kind: "warning" });
    try {
      await invoke("change_user_password", { newPassword: password });
      setPassword("");
      setConfirmPass("");
      setShowChangePass(false);
      message("Password updated.", { kind: "info" });
    } catch (e) {
      message(String(e), { kind: "error" });
    }
  }

  async function handleReset2FAConfirm() {
    try {
      setRecoveryCode((await invoke("regenerate_recovery_code")) as string);
      setView("recovery_display");
      setShowResetConfirm(false);
    } catch (e) {
      message(String(e), { kind: "error" });
    }
  }

  async function handleLogout() {
    await invoke("logout");
    setView("login");
    setPassword("");
    setKeyFile(null);
    setIsParanoid(false);
    setSelectedPaths([]);
  }

  async function selectKeyFile() {
    const selected = await open({ multiple: false });
    if (typeof selected === "string") setKeyFile(selected);
  }

  async function runCrypto(
    cmd: "lock_file" | "unlock_file",
    specificPath?: string
  ) {
    const targets = specificPath ? [specificPath] : selectedPaths;
    if (targets.length === 0) return setStatusMsg("No files selected.");

    // START PROGRESS
    setProgress({
      current: 0,
      total: targets.length,
      filename: "Initializing...",
    });
    setStatusMsg("Processing...");

    try {
      for (let i = 0; i < targets.length; i++) {
        const filePath = targets[i];

        // Update progress
        const filename = filePath.split(/[/\\]/).pop() || "file";
        setProgress({ current: i, total: targets.length, filename: filename });

        await invoke(cmd, {
          filePaths: [filePath],
          keyfilePath: keyFile,
          extraEntropy:
            cmd === "lock_file" ? generateBrowserEntropy(isParanoid) : null,
          compressionMode: cmd === "lock_file" ? compressionMode : null,
        });
      }

      // Complete state
      setProgress({
        current: targets.length,
        total: targets.length,
        filename: "Finished",
      });
      setStatusMsg("Done.");
      loadDir(currentPath);
    } catch (e) {
      setStatusMsg("Error: " + e);
      message(String(e), { kind: "error" });
    } finally {
      setTimeout(() => setProgress(null), 500);
    }
  }

  // --- CONTEXT MENU LOGIC ---
  function handleContextMenu(e: React.MouseEvent, path: string | null) {
    e.preventDefault();
    e.stopPropagation();
    setMenuData({
      x: e.clientX,
      y: e.clientY,
      path: path || currentPath,
      isBg: !path,
    });
  }

  async function handleContextAction(action: string) {
    if (!menuData) return;
    const { path, isBg } = menuData;
    setMenuData(null);

    if (action === "refresh") {
      loadDir(currentPath);
      return;
    }
    if (action === "new_folder") {
      setInputModal({ mode: "create", path: currentPath });
      return;
    }

    if (isBg && action !== "refresh" && action !== "new_folder") return;

    if (action === "lock") {
      if (selectedPaths.includes(path)) runCrypto("lock_file");
      else runCrypto("lock_file", path);
    }

    if (action === "unlock") {
      if (selectedPaths.includes(path)) runCrypto("unlock_file");
      else runCrypto("unlock_file", path);
    }

    if (action === "share") {
      try {
        await invoke("show_in_folder", { path });
      } catch (e) {
        message(String(e));
      }
    }
    if (action === "rename") setInputModal({ mode: "rename", path: path });

    if (action === "delete") {
      if (selectedPaths.includes(path)) {
        setItemsToDelete(selectedPaths);
      } else {
        setItemsToDelete([path]);
      }
    }
  }

  async function handleInputConfirm(val: string) {
    if (!inputModal || !val.trim()) return;
    const { mode, path } = inputModal;
    setInputModal(null);
    try {
      if (mode === "create") {
        const newPath = await join(path, val);
        await invoke("create_dir", { path: newPath });
      } else {
        await invoke("rename_item", { path, newName: val });
      }
      loadDir(currentPath);
    } catch (e) {
      message(String(e), { kind: "error" });
    }
  }

  async function performDelete() {
    if (!itemsToDelete) return;
    try {
      await invoke("delete_items", { paths: itemsToDelete });
      loadDir(currentPath);
      setSelectedPaths([]);
    } catch (e) {
      message(String(e), { kind: "error" });
    }
    setItemsToDelete(null);
  }

  // --- RENDER ---
  if (view === "loading") return <div className="auth-overlay">Loading...</div>;

  if (["setup", "login", "recovery_entry", "recovery_display"].includes(view)) {
    return (
      <AuthOverlay
        view={view}
        password={password}
        setPassword={setPassword}
        confirmPass={confirmPass}
        setConfirmPass={setConfirmPass}
        recoveryCode={recoveryCode}
        setRecoveryCode={setRecoveryCode}
        onLogin={handleLogin}
        onInit={handleInit}
        onRecovery={handleRecovery}
        onAckRecoveryCode={() => setView("dashboard")}
        onSwitchToRecovery={() => setView("recovery_entry")}
        onCancelRecovery={() => setView("login")}
      />
    );
  }

  return (
    <div
      className="main-layout"
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      <Toolbar
        onLock={() => runCrypto("lock_file")}
        onUnlock={() => runCrypto("unlock_file")}
        onRefresh={() => loadDir(currentPath)}
        onLogout={handleLogout}
        keyFile={keyFile}
        setKeyFile={setKeyFile}
        selectKeyFile={selectKeyFile}
        isParanoid={isParanoid}
        setIsParanoid={setIsParanoid}
        compressionMode={compressionMode}
        onOpenCompression={() => setShowCompression(true)}
        onChangePassword={() => setShowChangePass(true)}
        onReset2FA={() => setShowResetConfirm(true)}
        onTheme={() => setShowThemeModal(true)} // Added Handler
        onAbout={() => setShowAbout(true)}
      />

      <AddressBar currentPath={currentPath} onGoUp={goUp} />

      <FileGrid
        entries={entries}
        selectedPaths={selectedPaths}
        onSelect={(path, multi) => {
          if (multi)
            setSelectedPaths((prev) =>
              prev.includes(path)
                ? prev.filter((p) => p !== path)
                : [...prev, path]
            );
          else setSelectedPaths([path]);
        }}
        onNavigate={loadDir}
        onGoUp={goUp}
        onContextMenu={handleContextMenu}
      />

      <div className="status-bar">
        {statusMsg} | {selectedPaths.length} selected
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
          onConfirm={performDelete}
          onCancel={() => setItemsToDelete(null)}
        />
      )}

      {showCompression && (
        <CompressionModal
          current={compressionMode}
          onSave={(mode) => {
            setCompressionMode(mode);
            setShowCompression(false);
          }}
          onCancel={() => setShowCompression(false)}
        />
      )}

      {/* THEME MODAL */}
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

      {progress && (
        <ProcessingModal
          current={progress.current}
          total={progress.total}
          filename={progress.filename}
        />
      )}

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {showResetConfirm && (
        <ResetConfirmModal
          onConfirm={handleReset2FAConfirm}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
      {showChangePass && (
        <ChangePassModal
          pass={password}
          setPass={setPassword}
          confirm={confirmPass}
          setConfirm={setConfirmPass}
          onUpdate={handleChangePassword}
          onCancel={() => {
            setShowChangePass(false);
            setPassword("");
          }}
        />
      )}
    </div>
  );
}

export default App;
