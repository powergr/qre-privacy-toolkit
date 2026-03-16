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
import { usePortableVault } from "./hooks/usePortableVault";

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
  DriveInitModal,
  DriveInitSuccessModal,
  DriveUnlockModal,
} from "./components/modals/AppModals";

function App() {
  const { theme, setTheme } = useTheme();
  const auth = useAuth();
  const portable = usePortableVault();

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

  // --- PORTABLE VAULT MODAL STATE ---
  const [portableTargetPath, setPortableTargetPath] = useState<string | null>(
    null,
  );
  const [portablePassword, setPortablePassword] = useState("");
  const [portableConfirm, setPortableConfirm] = useState("");
  const [portableTier, setPortableTier] = useState<
    "Standard" | "High" | "Paranoid"
  >("Standard");
  const [portableError, setPortableError] = useState<string | null>(null);
  const [portableModal, setPortableModal] = useState<
    "init" | "unlock" | "init_success" | null
  >(null);
  const [portableInitResult, setPortableInitResult] = useState<{
    recoveryCode: string;
    vaultId: string;
  } | null>(null);
  const [acknowledgedVaults] = useState<Set<string>>(() => new Set());
  const [forceRender, setForceRender] = useState(0);

  function closePortableModal() {
    setPortableModal(null);
    setPortableTargetPath(null);
    setPortablePassword("");
    setPortableConfirm("");
    setPortableError(null);
    setPortableInitResult(null);
  }

  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [changePassError, setChangePassError] = useState<string | null>(null);
  const [backupDone, setBackupDone] = useState(false);

  useEffect(() => {
    if (auth.view !== "dashboard") return;
    invoke<boolean>("get_backup_done")
      .then((done) => setBackupDone(done))
      .catch(() => setBackupDone(false));
  }, [auth.view]);

  // --- GLOBAL HELPERS ---
  async function performBackup() {
    setShowBackupModal(false);
    setShowBackupReminder(false);

    try {
      const path = await save({
        filters: [{ name: "QRE Keychain", extensions: ["json"] }],
        defaultPath: "QRE_Backup.json",
      });

      if (path) {
        const bytes = await invoke<number[]>("get_keychain_data");
        await writeFile(path, Uint8Array.from(bytes));
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
            onShowBackupReminder={() => {
              if (!backupDone) setShowBackupReminder(true);
            }}
            portable={portable}
            onInitDrive={(path) => {
              setPortableTargetPath(path);
              setPortableModal("init");
            }}
            onUnlockDrive={(path) => {
              setPortableTargetPath(path);
              setPortableModal("unlock");
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
            if (!res.success) setChangePassError(res.msg || "Update failed");
            else {
              setChangePassError(null);
              setInfoMsg("Password updated successfully.");
              setShowChangePass(false);
            }
          }}
          onCancel={() => {
            setShowChangePass(false);
            setChangePassError(null);
            auth.setPassword("");
            auth.setConfirmPass("");
            auth.setCurrentPassword("");
          }}
        />
      )}

      {/* --- PORTABLE VAULT MODALS --- */}
      {portableModal === "init" && portableTargetPath && (
        <DriveInitModal
          driveName={
            portable.drives.find((d) => d.drive.path === portableTargetPath)
              ?.drive.name ?? portableTargetPath
          }
          password={portablePassword}
          setPassword={(v) => {
            setPortableError(null);
            setPortablePassword(v);
          }}
          confirm={portableConfirm}
          setConfirm={(v) => {
            setPortableError(null);
            setPortableConfirm(v);
          }}
          tier={portableTier}
          setTier={setPortableTier}
          error={portableError ?? undefined}
          onCancel={closePortableModal}
          onInit={async () => {
            if (!portablePassword || portablePassword !== portableConfirm) {
              setPortableError("Passwords do not match.");
              return;
            }
            const res = await portable.initVault(
              portableTargetPath,
              portablePassword,
              portableTier,
            );
            if (!res.success)
              setPortableError(res.msg ?? "Initialization failed.");
            else {
              setPortableInitResult({
                recoveryCode: res.recoveryCode!,
                vaultId: res.vaultId!,
              });
              setPortablePassword("");
              setPortableConfirm("");
              setPortableError(null);
              setPortableModal("init_success");
            }
          }}
        />
      )}

      {portableModal === "init_success" && portableInitResult && (
        <DriveInitSuccessModal
          recoveryCode={portableInitResult.recoveryCode}
          vaultUuid={portableInitResult.vaultId}
          onClose={closePortableModal}
        />
      )}

      {portableModal === "unlock" &&
        portableTargetPath &&
        (() => {
          const entry = portable.drives.find(
            (d) => d.drive.path === portableTargetPath,
          );
          const vaultUuid = entry?.drive.vault_uuid;
          const warningAcknowledged = vaultUuid
            ? acknowledgedVaults.has(vaultUuid)
            : true;
          return (
            <DriveUnlockModal
              key={forceRender}
              driveName={entry?.drive.name ?? portableTargetPath}
              vaultUuid={vaultUuid}
              password={portablePassword}
              setPassword={(v) => {
                setPortableError(null);
                setPortablePassword(v);
              }}
              error={portableError ?? undefined}
              showTrustedWarning={!warningAcknowledged}
              onAcknowledgeWarning={() => {
                if (vaultUuid) {
                  acknowledgedVaults.add(vaultUuid);
                  setForceRender((prev) => prev + 1);
                }
              }}
              onCancel={closePortableModal}
              onUnlock={async () => {
                const res = await portable.unlockVault(
                  portableTargetPath,
                  portablePassword,
                );
                if (!res.success)
                  setPortableError(res.msg ?? "Incorrect password.");
                else closePortableModal();
              }}
            />
          );
        })()}

      {infoMsg && (
        <InfoModal message={infoMsg} onClose={() => setInfoMsg(null)} />
      )}
    </div>
  );
}

export default App;
