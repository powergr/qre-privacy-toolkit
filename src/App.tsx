import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, stat } from "@tauri-apps/plugin-fs";
import { documentDir } from "@tauri-apps/api/path";
import { message, open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import { FileEntry, ViewState } from "./types";
import { getPasswordScore, generateBrowserEntropy } from "./utils/security";
// Components
import { AuthOverlay } from "./components/auth/AuthOverlay";
import { Toolbar } from "./components/dashboard/Toolbar";
import { AddressBar } from "./components/dashboard/AddressBar";
import { FileGrid } from "./components/dashboard/FileGrid";
import { AboutModal, ResetConfirmModal, ChangePassModal } from "./components/modals/AppModals";
function App() {
// --- STATE ---
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
// Settings
const [keyFile, setKeyFile] = useState<string | null>(null);
const [isParanoid, setIsParanoid] = useState(false);
// Modals Visibility
const [showAbout, setShowAbout] = useState(false);
const [showChangePass, setShowChangePass] = useState(false);
const [showResetConfirm, setShowResetConfirm] = useState(false);
// --- INITIALIZATION ---
useEffect(() => {
checkAuth();
}, []);
async function checkAuth() {
try {
const status = await invoke("check_auth_status");
if (status === "unlocked") {
setView("dashboard");
loadInitialPath();
} else if (status === "setup_needed") setView("setup");
else setView("login");
} catch (e) {
console.error(e);
}
}
async function loadInitialPath() {
try {
loadDir(await documentDir());
} catch {
loadDir("");
}
}
// --- FILESYSTEM LOGIC ---
async function loadDir(path: string) {
try {
if (path === "") {
const drives = await invoke<string[]>("get_drives");
setEntries(drives.map(d => ({ name: d, isDirectory: true, path: d, isDrive: true, size: null, modified: null })));
setCurrentPath("");
setSelectedPaths([]);
setStatusMsg("Select a Drive");
return;
}
const contents = await readDir(path);
  const separator = navigator.userAgent.includes("Windows") ? "\\" : "/";
  
  const mapped = await Promise.all(contents.map(async (entry) => {
    const cleanPath = path.endsWith(separator) ? path : path + separator;
    const fullPath = `${cleanPath}${entry.name}`;
    let size = null, modified = null;

    if (!entry.isDirectory) {
      try {
        const m = await stat(fullPath);
        size = m.size;
        if (m.mtime) modified = new Date(m.mtime);
      } catch {}
    }
    return { name: entry.name, isDirectory: entry.isDirectory, path: fullPath, size, modified };
  }));

  mapped.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  setEntries(mapped);
  setCurrentPath(path);
  setSelectedPaths([]);
  setStatusMsg(`Loaded: ${path}`);
} catch (e) {
  // FIX: Display actual error message for debugging
  console.error(e);
  setStatusMsg(`Error: ${String(e)}`);
}
}
function goUp() {
    if (currentPath === "") return;
    const isWindows = navigator.userAgent.includes("Windows");
    // FIX: Double backslash required for Windows separator literal
    const separator = isWindows ? "\\" : "/";
    
    // Check if at root
    if (currentPath === "/" || (isWindows && currentPath.length <= 3 && currentPath.includes(":"))) {
      loadDir(isWindows ? "" : "/");
      return;
    }

    const parts = currentPath.split(separator).filter(p => p);
    parts.pop();
    
    // Reconstruct path
    let parent = parts.join(separator);
    
    // FIX: Linux paths must start with /
    if (!isWindows) {
      parent = "/" + parent;
    }
    // FIX: Windows drives must end with \ (e.g., C:\) if it's just the drive letter
    if (isWindows && parent.length === 2 && parent.endsWith(":")) {
      parent += separator;
    }

    // If we popped everything, go to root/drives
    if (parts.length === 0) {
       loadDir(isWindows ? "" : "/");
    } else {
       loadDir(parent);
    }
  }
// --- AUTH ACTIONS ---
async function handleInit() {
if (getPasswordScore(password) < 3) return message("Password too weak.", { kind: "warning" });
if (password !== confirmPass) return message("Mismatch.", { kind: "error" });
try {
setRecoveryCode(await invoke("init_vault", { password }) as string);
setView("recovery_display");
} catch (e) { message(String(e), { kind: "error" }); }
}
async function handleLogin() {
try {
await invoke("login", { password });
setPassword("");
setView("dashboard");
loadInitialPath();
} catch (e) { message(String(e), { kind: "error" }); }
}
async function handleRecovery() {
if (!recoveryCode || password !== confirmPass) return message("Check inputs.", { kind: "error" });
try {
await invoke("recover_vault", { recoveryCode: recoveryCode.trim(), newPassword: password });
setPassword(""); setConfirmPass(""); setRecoveryCode("");
setView("dashboard"); loadInitialPath();
message("Vault recovered.", { kind: "info" });
} catch (e) { message(String(e), { kind: "error" }); }
}
async function handleChangePassword() {
if (password !== confirmPass) return message("Mismatch.", { kind: "error" });
if (getPasswordScore(password) < 3) return message("Weak Password.", { kind: "warning" });
try {
await invoke("change_user_password", { newPassword: password });
setPassword(""); setConfirmPass(""); setShowChangePass(false);
message("Password updated.", { kind: "info" });
} catch (e) { message(String(e), { kind: "error" }); }
}
async function handleReset2FAConfirm() {
try {
setRecoveryCode(await invoke("regenerate_recovery_code") as string);
setView("recovery_display");
setShowResetConfirm(false);
} catch (e) { message(String(e), { kind: "error" }); }
}
async function handleLogout() {
await invoke("logout");
setView("login"); setPassword(""); setKeyFile(null); setIsParanoid(false); setSelectedPaths([]);
}
// --- CRYPTO ACTIONS ---
async function selectKeyFile() {
const selected = await open({ multiple: false });
if (typeof selected === "string") setKeyFile(selected);
}
async function runCrypto(cmd: "lock_file" | "unlock_file") {
if (selectedPaths.length === 0) return setStatusMsg("No files selected.");
setStatusMsg("Processing...");
try {
await invoke(cmd, {
filePaths: selectedPaths,
keyfilePath: keyFile,
extraEntropy: cmd === "lock_file" ? generateBrowserEntropy(isParanoid) : null,
});
setStatusMsg("Done.");
loadDir(currentPath);
} catch (e) {
setStatusMsg("Error: " + e);
message(String(e), { kind: "error" });
}
}
// --- RENDER ---
if (view === "loading") return <div className="auth-overlay">Loading...</div>;
if (["setup", "login", "recovery_entry", "recovery_display"].includes(view)) {
return (
<AuthOverlay
view={view}
password={password} setPassword={setPassword}
confirmPass={confirmPass} setConfirmPass={setConfirmPass}
recoveryCode={recoveryCode} setRecoveryCode={setRecoveryCode}
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
<div className="main-layout">
<Toolbar
onLock={() => runCrypto("lock_file")}
onUnlock={() => runCrypto("unlock_file")}
onRefresh={() => loadDir(currentPath)}
onLogout={handleLogout}
keyFile={keyFile} setKeyFile={setKeyFile} selectKeyFile={selectKeyFile}
isParanoid={isParanoid} setIsParanoid={setIsParanoid}
onChangePassword={() => setShowChangePass(true)}
onReset2FA={() => setShowResetConfirm(true)}
onAbout={() => setShowAbout(true)}
/>
<AddressBar currentPath={currentPath} onGoUp={goUp} />

  <FileGrid 
    entries={entries} 
    selectedPaths={selectedPaths}
    onSelect={(path, multi) => {
      if (multi) setSelectedPaths(prev => prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]);
      else setSelectedPaths([path]);
    }}
    onNavigate={loadDir}
  />

  <div className="status-bar">{statusMsg} | {selectedPaths.length} selected</div>

  {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
  {showResetConfirm && <ResetConfirmModal onConfirm={handleReset2FAConfirm} onCancel={() => setShowResetConfirm(false)} />}
  {showChangePass && (
    <ChangePassModal 
      pass={password} setPass={setPassword}
      confirm={confirmPass} setConfirm={setConfirmPass}
      onUpdate={handleChangePassword}
      onCancel={() => { setShowChangePass(false); setPassword(""); }}
    />
  )}
</div>
);
}
export default App;