import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import "./App.css";
// Load split styles
import "./styles/components.css";
import "./styles/dashboard.css";
import "./components/layout/Sidebar.css";
import "./styles/modern-cards.css";
import "./components/views/VaultView.css";
import "./components/views/NotesView.css";

// Hooks
import { useTheme } from "./hooks/useTheme";
import { useAuth } from "./hooks/useAuth";

// Components (Layout & Views)
import { Sidebar } from "./components/layout/Sidebar";
import { HomeView } from "./components/views/HomeView";
import { FilesView } from "./components/views/FilesView";
import { ShredderView } from "./components/views/ShredderView";
import { VaultView } from "./components/views/VaultView";
import { NotesView } from "./components/views/NotesView";
import { BreachView } from "./components/views/BreachView";
import { CleanerView } from "./components/views/CleanerView";
import { ClipboardView } from "./components/views/ClipboardView";
import { QrView } from "./components/views/QrView";
import { BookmarksView } from "./components/views/BookmarksView";
import { HashView } from "./components/views/HashView";
import { SystemCleanerView } from "./components/views/SystemCleanerView";
import { FileAnalyzerView } from "./components/views/FileAnalyzerView";
import { HelpView } from "./components/views/HelpView";
import { SettingsView } from "./components/views/SettingsView";
import { UniversalUpdateModal } from "./components/modals/UniversalUpdateModal";

// Auth & Modals
import { AuthOverlay } from "./components/auth/AuthOverlay";
import { HelpModal } from "./components/modals/HelpModal";
import {
  AboutModal,
  ResetConfirmModal,
  ChangePassModal,
  ThemeModal,
  BackupModal,
  BackupReminderModal,
  InfoModal,
  TimeoutWarningModal,
} from "./components/modals/AppModals";

function App() {
  const { theme, setTheme } = useTheme();
  const auth = useAuth();

  // --- GLOBAL STATE ---
  const [activeTab, setActiveTab] = useState("home");

  // Modals
  const [showAbout, setShowAbout] = useState(false);
  const [showChangePass, setShowChangePass] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showBackupReminder, setShowBackupReminder] = useState(false);

  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  // Tracks validation/backend errors from the change-password flow so they are
  // shown inline inside the modal in red, not via the green success InfoModal.
  const [changePassError, setChangePassError] = useState<string | null>(null);

  // FIX F-09: Replace localStorage with a Tauri backend flag stored in the app
  // data directory alongside the keychain itself. localStorage is a browser API
  // that can be cleared by the user or read by any JS in the same webview origin.
  // The backend uses a simple sentinel file that persists independently of browser
  // storage and is under application (not user) control.
  const [backupDone, setBackupDone] = useState(false);

  // Load the backup-done flag from the backend whenever the user reaches the dashboard.
  useEffect(() => {
    if (auth.view !== "dashboard") return;
    invoke<boolean>("get_backup_done")
      .then((done) => setBackupDone(done))
      .catch(() => {
        // If the command fails for any reason (e.g. during development without
        // Tauri), default to false so the reminder still fires.
        setBackupDone(false);
      });
  }, [auth.view]);

  // --- GLOBAL HELPERS ---

  async function performBackup() {
    setShowBackupModal(false);
    setShowBackupReminder(false); // Close reminder if it was open

    try {
      const path = await save({
        filters: [{ name: "QRE Keychain", extensions: ["json"] }],
        defaultPath: "QRE_Backup.json",
      });

      if (path) {
        // 1. Get bytes from Rust
        const bytes = await invoke<number[]>("get_keychain_data");
        // 2. Write using JS Plugin
        await writeFile(path, Uint8Array.from(bytes));

        // FIX F-09: Persist backup-done flag via the Tauri backend instead of localStorage.
        await invoke("set_backup_done");
        setBackupDone(true);

        setInfoMsg("Backup saved successfully.\nKeep it safe!");
      }
    } catch (e) {
      setInfoMsg("Backup failed: " + String(e));
    }
  }

  // --- AUTH SCREEN RENDERING ---
  if (
    [
      "loading",
      "setup",
      "login",
      "recovery_entry",
      "recovery_display",
    ].includes(auth.view)
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
            if (!res.success) setInfoMsg(res.msg || "Login failed");
          }}
          onInit={async () => {
            const res = await auth.handleInit();
            if (!res.success) setInfoMsg(res.msg || "Setup failed");
          }}
          onRecovery={async () => {
            const res = await auth.handleRecovery();
            if (!res.success) setInfoMsg(res.msg || "Recovery failed");
            else setInfoMsg("Vault recovered successfully.");
          }}
          onAckRecoveryCode={() => auth.setView("dashboard")}
          onSwitchToRecovery={() => auth.setView("recovery_entry")}
          onCancelRecovery={() => auth.setView("login")}
        />
        {infoMsg && (
          <InfoModal message={infoMsg} onClose={() => setInfoMsg(null)} />
        )}
      </>
    );
  }

  // --- MAIN APP LAYOUT ---
  return (
    <div className="app-container">
      <Sidebar
        activeTab={activeTab}
        setTab={setActiveTab}
        onOpenHelpModal={() => setShowHelpModal(true)}
        onOpenAboutModal={() => setShowAbout(true)}
        onLogout={auth.logout}
        onTheme={() => setShowThemeModal(true)}
        onBackup={() => setShowBackupModal(true)}
        onChangePassword={() => setShowChangePass(true)}
        onReset2FA={() => setShowResetConfirm(true)}
        onUpdate={() => setShowUpdateModal(true)}
      />

      <div className="content-area">
        {activeTab === "home" && <HomeView setTab={setActiveTab} />}

        {activeTab === "files" && (
          <FilesView
            // FIX F-09: Use backend-persisted `backupDone` state instead of
            // localStorage so the flag survives browser storage clears and cannot
            // be trivially tampered with from the webview.
            onShowBackupReminder={() => {
              if (!backupDone) {
                setShowBackupReminder(true);
              }
            }}
          />
        )}

        {activeTab === "shred" && <ShredderView />}
        {activeTab === "vault" && <VaultView />}
        {activeTab === "notes" && <NotesView />}
        {activeTab === "breach" && <BreachView />}
        {activeTab === "cleaner" && <CleanerView />}
        {activeTab === "clipboard" && <ClipboardView />}
        {activeTab === "qr" && <QrView />}
        {activeTab === "bookmarks" && <BookmarksView />}
        {activeTab === "hash" && <HashView />}
        {activeTab === "sysclean" && <SystemCleanerView />}
        {activeTab === "analyzer" && <FileAnalyzerView />}
        {activeTab === "help" && (
          <HelpView
            onOpenHelpModal={() => setShowHelpModal(true)}
            onOpenAboutModal={() => setShowAbout(true)}
          />
        )}
        {activeTab === "settings" && (
          <SettingsView
            onTheme={() => setShowThemeModal(true)}
            onBackup={() => setShowBackupModal(true)}
            onChangePassword={() => setShowChangePass(true)}
            onReset2FA={() => setShowResetConfirm(true)}
            onUpdate={() => setShowUpdateModal(true)}
            onLogout={auth.logout}
          />
        )}
      </div>

      {/* --- GLOBAL MODALS --- */}
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
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {showBackupModal && (
        <BackupModal
          onProceed={performBackup}
          onCancel={() => setShowBackupModal(false)}
        />
      )}

      {showBackupReminder && (
        <BackupReminderModal
          onBackup={performBackup}
          onCancel={() => setShowBackupReminder(false)}
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
            if (!res.success) setInfoMsg(res.msg || "Reset failed");
            setShowResetConfirm(false);
          }}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}

      {showUpdateModal && (
        <UniversalUpdateModal onClose={() => setShowUpdateModal(false)} />
      )}

      {showChangePass && (
        // FIX F-01: Pass currentPassword state through to ChangePassModal so the
        // user must prove knowledge of their existing password before changing it.
        <ChangePassModal
          currentPass={auth.currentPassword}
          setCurrentPass={(v) => {
            setChangePassError(null);
            auth.setCurrentPassword(v);
          }}
          pass={auth.password}
          setPass={(v) => {
            setChangePassError(null);
            auth.setPassword(v);
          }}
          confirm={auth.confirmPass}
          setConfirm={(v) => {
            setChangePassError(null);
            auth.setConfirmPass(v);
          }}
          error={changePassError ?? undefined}
          onUpdate={async () => {
            const res = await auth.handleChangePassword();
            if (!res.success) {
              // Show the error inline in red inside the modal rather than
              // surfacing it through the green success InfoModal.
              setChangePassError(res.msg || "Update failed");
            } else {
              setChangePassError(null);
              setInfoMsg("Password updated successfully.");
              setShowChangePass(false);
            }
          }}
          onCancel={() => {
            setShowChangePass(false);
            setChangePassError(null);
            // FIX F-10: Clear all password fields on cancel — don't leave the
            // current password lingering in the React state / V8 heap.
            auth.setPassword("");
            auth.setConfirmPass("");
            auth.setCurrentPassword("");
          }}
        />
      )}

      {infoMsg && (
        <InfoModal message={infoMsg} onClose={() => setInfoMsg(null)} />
      )}
    </div>
  );
}

export default App;
