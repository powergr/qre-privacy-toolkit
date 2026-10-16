import { render, screen, fireEvent, waitFor, act, within } from "./test-support/rtl";
import "@testing-library/jest-dom";
import { useRef, useState } from "react";
import App from "./App";

// ─── Backend and plugins ─────────────────────────────────────────────────────

const mockInvoke = jest.fn();
const mockSave = jest.fn();
const mockWriteFile = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockSave(...args),
}));
jest.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));
jest.mock("@tauri-apps/plugin-opener", () => ({ openUrl: jest.fn() }));

// ─── Hooks: a controllable sign-in state, drives and theme ───────────────────

const mockAuthFns = {
  handleLogin: jest.fn(),
  handleInit: jest.fn(),
  handleRestoreBackup: jest.fn(),
  handleRecovery: jest.fn(),
  handleChangePassword: jest.fn(),
  handleReset2FA: jest.fn(),
  logout: jest.fn(),
  stayLoggedIn: jest.fn(),
};
let mockInitialView = "login";
let mockInitialExpired = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockLatest: any;

function mockUseAuth() {
  const [view, setView] = useState(mockInitialView);
  const [sessionExpired, setSessionExpired] = useState(mockInitialExpired);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const idleDeadlineRef = useRef(0);
  const api = {
    view,
    setView,
    password,
    setPassword,
    confirmPass,
    setConfirmPass,
    currentPassword,
    setCurrentPassword,
    recoveryCode,
    setRecoveryCode,
    sessionExpired,
    setSessionExpired,
    showTimeoutWarning,
    setShowTimeoutWarning,
    countdown: 42,
    stayLoggedIn: () => mockAuthFns.stayLoggedIn(),
    idleDeadlineRef,
    handleLogin: () => mockAuthFns.handleLogin(),
    handleInit: () => mockAuthFns.handleInit(),
    handleRestoreBackup: () => mockAuthFns.handleRestoreBackup(),
    handleRecovery: () => mockAuthFns.handleRecovery(),
    handleChangePassword: () => mockAuthFns.handleChangePassword(),
    handleReset2FA: () => mockAuthFns.handleReset2FA(),
    logout: () => mockAuthFns.logout(),
  };
  mockLatest = api;
  return api;
}
jest.mock("./hooks/useAuth", () => ({ useAuth: () => mockUseAuth() }));

const mockPortable = {
  drives: [] as unknown[],
  isScanning: false,
  scanDrives: jest.fn(),
  initVault: jest.fn(),
  unlockVault: jest.fn(),
  lockVault: jest.fn(),
};
jest.mock("./hooks/usePortableVault", () => ({
  usePortableVault: () => mockPortable,
}));

const mockSetTheme = jest.fn();
jest.mock("./hooks/useTheme", () => ({
  useTheme: () => ({ theme: "light", setTheme: mockSetTheme }),
}));

// ─── Screens and heavy dialogs are replaced by small stand-ins ───────────────
// Each stand-in shows its name and exposes a button per callback App gives it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockFilesProps: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockOverlayProps: any;

const mockTabIds = [
  "home",
  "files",
  "shred",
  "vault",
  "notes",
  "breach",
  "cleaner",
  "clipboard",
  "qr",
  "bookmarks",
  "hash",
  "sysclean",
  "analyzer",
  "help",
  "settings",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockButtons(prefix: string, actions: Record<string, () => void>) {
  return Object.entries(actions).map(([label, fn]) => (
    <button key={label} onClick={fn}>
      {prefix}: {label}
    </button>
  ));
}
function mockView(id: string) {
  return <div data-testid={`view-${id}`}>view {id}</div>;
}
jest.mock("./components/layout/Sidebar", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Sidebar: (p: any) => (
    <div data-testid="sidebar">
      <span data-testid="active-tab">{p.activeTab}</span>
      {mockTabIds.map((id) => (
        <button key={id} onClick={() => p.setTab(id)}>
          tab: {id}
        </button>
      ))}
      {mockButtons("sb", {
        help: p.onOpenHelpModal,
        about: p.onOpenAboutModal,
        logout: p.onLogout,
        theme: p.onTheme,
        backup: p.onBackup,
        password: p.onChangePassword,
        reset: p.onReset2FA,
        update: p.onUpdate,
      })}
    </div>
  ),
}));
jest.mock("./components/views/HomeView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HomeView: (p: any) => (
    <div
      data-testid="view-home"
      data-recent={(p.recent ?? []).join(",")}
      data-backup={String(p.backupDone)}
    >
      <button onClick={() => p.setTab("files")}>home: go files</button>
      <button onClick={() => p.setTab("settings")}>home: go settings</button>
      <button onClick={() => p.onBackup()}>home: backup</button>
      <button onClick={() => p.onOpenPalette()}>home: jump</button>
    </div>
  ),
}));
jest.mock("./components/views/FilesView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FilesView: (p: any) => {
    mockFilesProps = p;
    return (
      <div data-testid="view-files">
        {mockButtons("files", {
          reminder: p.onShowBackupReminder,
          "init drive": () => p.onInitDrive("E:\\"),
          "unlock drive": () => p.onUnlockDrive("E:\\"),
          "init unknown": () => p.onInitDrive("Z:\\"),
        })}
      </div>
    );
  },
}));
jest.mock("./components/views/HelpView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HelpView: (p: any) => (
    <div data-testid="view-help">
      {mockButtons("hv", { help: p.onOpenHelpModal, about: p.onOpenAboutModal })}
    </div>
  ),
}));
jest.mock("./components/views/SettingsView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SettingsView: (p: any) => (
    <div data-testid="view-settings">
      {mockButtons("st", {
        theme: p.onTheme,
        backup: p.onBackup,
        password: p.onChangePassword,
        reset: p.onReset2FA,
        update: p.onUpdate,
        logout: p.onLogout,
      })}
    </div>
  ),
}));
jest.mock("./components/views/ShredderView", () => ({ ShredderView: () => mockView("shred") }));
jest.mock("./components/views/VaultView", () => ({ VaultView: () => mockView("vault") }));
jest.mock("./components/views/NotesView", () => ({ NotesView: () => mockView("notes") }));
jest.mock("./components/views/BreachView", () => ({ BreachView: () => mockView("breach") }));
jest.mock("./components/views/CleanerView", () => ({ CleanerView: () => mockView("cleaner") }));
jest.mock("./components/views/ClipboardView", () => ({ ClipboardView: () => mockView("clipboard") }));
jest.mock("./components/views/QrView", () => ({ QrView: () => mockView("qr") }));
jest.mock("./components/views/BookmarksView", () => ({ BookmarksView: () => mockView("bookmarks") }));
jest.mock("./components/views/HashView", () => ({ HashView: () => mockView("hash") }));
jest.mock("./components/views/SystemCleanerView", () => ({ SystemCleanerView: () => mockView("sysclean") }));
jest.mock("./components/views/FileAnalyzerView", () => ({ FileAnalyzerView: () => mockView("analyzer") }));
jest.mock("./components/modals/HelpModal", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HelpModal: (p: any) => (
    <div data-testid="help-modal">
      <button onClick={p.onClose}>help-modal: close</button>
    </div>
  ),
}));
jest.mock("./components/modals/UniversalUpdateModal", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UniversalUpdateModal: (p: any) => (
    <div data-testid="update-modal">
      <button onClick={p.onClose}>update-modal: close</button>
    </div>
  ),
}));
jest.mock("./components/auth/AuthOverlay", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AuthOverlay: (p: any) => {
    mockOverlayProps = p;
    return (
      <div data-testid="auth-overlay">
        <span data-testid="auth-view">{p.view}</span>
        {mockButtons("auth", {
          login: p.onLogin,
          init: p.onInit,
          restore: p.onRestoreBackup,
          recovery: p.onRecovery,
          ack: p.onAckRecoveryCode,
          "to recovery": p.onSwitchToRecovery,
          "cancel recovery": p.onCancelRecovery,
        })}
      </div>
    );
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const click = (label: string) => fireEvent.click(screen.getByText(label));
const tab = (id: string) => click(`tab: ${id}`);
const activeTab = () => screen.getByTestId("active-tab").textContent;

function renderApp(view = "dashboard", expired = false) {
  mockInitialView = view;
  mockInitialExpired = expired;
  return render(<App />);
}

function drive(path: string, name: string, uuid?: string) {
  return {
    drive: { path, name, vault_uuid: uuid, is_qre_portable: true },
    isLocked: true,
    isUnlocked: false,
  };
}

let backupDone: boolean | Error;

beforeEach(() => {
  jest.clearAllMocks();
  backupDone = false;
  mockPortable.drives = [];
  mockFilesProps = undefined;
  mockOverlayProps = undefined;
  mockSave.mockResolvedValue("C:\\backup\\QRE_Backup.json");
  mockWriteFile.mockResolvedValue(undefined);
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "get_backup_done")
      return backupDone instanceof Error ? Promise.reject(backupDone) : Promise.resolve(backupDone);
    if (cmd === "get_keychain_data") return Promise.resolve([1, 2, 3]);
    return Promise.resolve(null);
  });
  mockAuthFns.handleLogin.mockResolvedValue({ success: true });
  mockAuthFns.handleInit.mockResolvedValue({ success: true });
  mockAuthFns.handleRestoreBackup.mockResolvedValue({ success: true });
  mockAuthFns.handleRecovery.mockResolvedValue({ success: true });
  mockAuthFns.handleChangePassword.mockResolvedValue({ success: true });
  mockAuthFns.handleReset2FA.mockResolvedValue({ success: true });
  mockPortable.initVault.mockResolvedValue({
    success: true,
    recoveryCode: "AAAA-BBBB",
    vaultId: "uuid-1",
  });
  mockPortable.unlockVault.mockResolvedValue({ success: true });
});

// ─── Sign-in screens ─────────────────────────────────────────────────────────

describe("App - sign-in screens", () => {
  it.each(["loading", "setup", "login", "recovery_entry", "recovery_display"])(
    "shows the %s screen and none of the app",
    (view) => {
      renderApp(view);
      expect(screen.getByTestId("auth-view")).toHaveTextContent(view);
      expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
      expect(mockInvoke).not.toHaveBeenCalledWith("get_backup_done");
    },
  );

  it("shows the app once signed in", () => {
    renderApp("dashboard");
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-overlay")).not.toBeInTheDocument();
  });

  it("passes the password fields through to the sign-in screen", () => {
    renderApp("login");
    act(() => mockOverlayProps.setPassword("pw"));
    expect(mockOverlayProps.password).toBe("pw");
    act(() => mockOverlayProps.setConfirmPass("pw2"));
    expect(mockOverlayProps.confirmPass).toBe("pw2");
    act(() => mockOverlayProps.setRecoveryCode("CODE"));
    expect(mockOverlayProps.recoveryCode).toBe("CODE");
  });

  it("moves between login and recovery", () => {
    renderApp("login");
    click("auth: to recovery");
    expect(screen.getByTestId("auth-view")).toHaveTextContent("recovery_entry");
    click("auth: cancel recovery");
    expect(screen.getByTestId("auth-view")).toHaveTextContent("login");
  });

  it("enters the app after the recovery code is acknowledged", () => {
    renderApp("recovery_display");
    click("auth: ack");
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  });

  it("says nothing after a successful login", async () => {
    renderApp("login");
    click("auth: login");
    await waitFor(() => expect(mockAuthFns.handleLogin).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it.each([
    ["login", "handleLogin", "Login failed"],
    ["init", "handleInit", "Setup failed"],
    ["recovery", "handleRecovery", "Recovery failed"],
    ["restore", "handleRestoreBackup", "Restore failed"],
  ] as const)("%s: shows the reason, or a default, when it fails", async (button, fn, fallback) => {
    renderApp("login");
    mockAuthFns[fn].mockResolvedValueOnce({ success: false, msg: "Wrong password" });
    click(`auth: ${button}`);
    expect(await screen.findByText("Wrong password")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    click("OK");
    expect(screen.queryByText("Wrong password")).not.toBeInTheDocument();

    mockAuthFns[fn].mockResolvedValueOnce({ success: false });
    click(`auth: ${button}`);
    expect(await screen.findByText(fallback)).toBeInTheDocument();
  });

  it("confirms a successful recovery", async () => {
    renderApp("recovery_entry");
    click("auth: recovery");
    const toast = (await screen.findByText("Vault recovered successfully.")).closest(".ui-toast");
    expect(toast).toHaveClass("ui-toast--success");
    // A toast, not a dialog: nothing needs a click.
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
  });

  it("confirms a restored backup, but stays quiet when the file picker was cancelled", async () => {
    renderApp("login");
    mockAuthFns.handleRestoreBackup.mockResolvedValueOnce({ success: true });
    click("auth: restore");
    await waitFor(() => expect(mockAuthFns.handleRestoreBackup).toHaveBeenCalled());
    await act(async () => {}); // let the result be handled before looking
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    mockAuthFns.handleRestoreBackup.mockResolvedValueOnce({
      success: true,
      msg: "Backup restored. Log in with your password.",
    });
    click("auth: restore");
    const toast = (await screen.findByText("Backup restored. Log in with your password.")).closest(".ui-toast");
    expect(toast).toHaveClass("ui-toast--success");
  });

  it("tells the user when the session timed out, and lets them dismiss it", () => {
    renderApp("login", true);
    expect(screen.getByText("Session timed out due to inactivity.")).toBeInTheDocument();
    click("OK");
    expect(screen.queryByText("Session timed out due to inactivity.")).not.toBeInTheDocument();
    expect(mockLatest.sessionExpired).toBe(false);
  });
});

// ─── Navigation ──────────────────────────────────────────────────────────────

describe("App - navigation", () => {
  it("starts on Home", () => {
    renderApp();
    expect(activeTab()).toBe("home");
    expect(screen.getByTestId("view-home")).toBeInTheDocument();
  });

  it.each(mockTabIds)("opens the %s screen and no other", (id) => {
    renderApp();
    tab(id);
    expect(activeTab()).toBe(id);
    expect(screen.getByTestId(`view-${id}`)).toBeInTheDocument();
    for (const other of mockTabIds.filter((t) => t !== id)) {
      expect(screen.queryByTestId(`view-${other}`)).not.toBeInTheDocument();
    }
  });

  it("lets Home jump to Files", () => {
    renderApp();
    click("home: go files");
    expect(screen.getByTestId("view-files")).toBeInTheDocument();
    expect(activeTab()).toBe("files");
  });

  it("opens the password and recovery-code dialogs from Settings", () => {
    renderApp();
    tab("settings");
    click("st: password");
    expect(screen.getByText("Change Password")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    click("st: reset");
    expect(screen.getByText("Reset Recovery Code?")).toBeInTheDocument();
  });

  it("logs out from the sidebar and from Settings", () => {
    renderApp();
    click("sb: logout");
    tab("settings");
    click("st: logout");
    expect(mockAuthFns.logout).toHaveBeenCalledTimes(2);
  });
});

// ─── Dialogs opened from the sidebar, Help and Settings ──────────────────────

describe("App - help, about, theme and update dialogs", () => {
  it.each([
    ["sidebar", "sb"],
    ["Help screen", "hv"],
  ])("opens and closes the help dialog from the %s", (_where, prefix) => {
    renderApp();
    if (prefix === "hv") tab("help");
    click(`${prefix}: help`);
    expect(screen.getByTestId("help-modal")).toBeInTheDocument();
    click("help-modal: close");
    expect(screen.queryByTestId("help-modal")).not.toBeInTheDocument();
  });

  it.each([
    ["sidebar", "sb"],
    ["Help screen", "hv"],
  ])("opens and closes About from the %s", (_where, prefix) => {
    renderApp();
    if (prefix === "hv") tab("help");
    click(`${prefix}: about`);
    expect(document.querySelector('[style*="200000"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector('[style*="200000"]')).toBeNull();
  });

  it.each([
    ["sidebar", "sb"],
    ["Settings", "st"],
  ])("opens and closes the update dialog from %s", (_where, prefix) => {
    renderApp();
    if (prefix === "st") tab("settings");
    click(`${prefix}: update`);
    expect(screen.getByTestId("update-modal")).toBeInTheDocument();
    click("update-modal: close");
    expect(screen.queryByTestId("update-modal")).not.toBeInTheDocument();
  });

  it("saves the chosen theme and closes the dialog", () => {
    renderApp();
    click("sb: theme");
    click("Dark Mode");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("cancelling the theme dialog changes nothing", () => {
    renderApp();
    tab("settings");
    click("st: theme");
    click("Dark Mode");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockSetTheme).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});

// ─── Inactivity warning ──────────────────────────────────────────────────────

describe("App - inactivity warning", () => {
  it("shows the countdown and stays signed in on request", () => {
    renderApp();
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    act(() => mockLatest.setShowTimeoutWarning(true));
    expect(screen.getByText("42")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I'm still here" }));
    expect(mockAuthFns.stayLoggedIn).toHaveBeenCalledTimes(1);
  });
});

// ─── Keychain backup ─────────────────────────────────────────────────────────

describe("App - keychain backup", () => {
  const startBackup = () => {
    click("sb: backup");
    fireEvent.click(screen.getByRole("button", { name: "Save Backup..." }));
  };

  it("asks the backend whether a backup exists, only once signed in", async () => {
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_backup_done"));
  });

  it("writes the keychain to the chosen file and records that a backup was made", async () => {
    renderApp();
    startBackup();
    expect(await screen.findByText(/Backup saved successfully/)).toBeInTheDocument();

    expect(mockSave).toHaveBeenCalledWith({
      filters: [{ name: "QRE Keychain", extensions: ["json"] }],
      defaultPath: "QRE_Backup.json",
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      "C:\\backup\\QRE_Backup.json",
      Uint8Array.from([1, 2, 3]),
    );
    expect(mockInvoke).toHaveBeenCalledWith("set_backup_done");
    expect(screen.queryByText("Backup Keychain")).not.toBeInTheDocument();
  });

  it("does nothing more when the file picker is cancelled", async () => {
    mockSave.mockResolvedValue(null);
    renderApp();
    startBackup();
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("set_backup_done");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it("reports a failed write and does not mark the backup as done", async () => {
    mockWriteFile.mockRejectedValue("disk full");
    renderApp();
    startBackup();
    expect(await screen.findByText("Backup failed: disk full")).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("set_backup_done");

    // Still not done, so the reminder still appears after the next lock.
    click("OK");
    tab("files");
    click("files: reminder");
    expect(screen.getByText("Security Reminder")).toBeInTheDocument();
  });

  it("reports a failure to read the keychain", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "get_keychain_data" ? Promise.reject("locked") : Promise.resolve(false),
    );
    renderApp();
    startBackup();
    expect(await screen.findByText("Backup failed: locked")).toBeInTheDocument();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("cancelling the backup dialog saves nothing", () => {
    renderApp();
    click("sb: backup");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Backup Keychain")).not.toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("works from the Settings screen too", async () => {
    renderApp();
    tab("settings");
    click("st: backup");
    fireEvent.click(screen.getByRole("button", { name: "Save Backup..." }));
    expect(await screen.findByText(/Backup saved successfully/)).toBeInTheDocument();
  });
});

describe("App - backup reminder", () => {
  async function openFilesAndLock() {
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_backup_done"));
    tab("files");
    click("files: reminder");
  }

  it("appears after locking files when no backup exists", async () => {
    await openFilesAndLock();
    expect(screen.getByText("Security Reminder")).toBeInTheDocument();
  });

  it("stays away when a backup already exists", async () => {
    backupDone = true;
    renderApp();
    tab("files");
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_backup_done"));
    await act(async () => {});
    click("files: reminder");
    expect(screen.queryByText("Security Reminder")).not.toBeInTheDocument();
  });

  it("appears when the backend cannot say", async () => {
    backupDone = new Error("no backend");
    await openFilesAndLock();
    expect(screen.getByText("Security Reminder")).toBeInTheDocument();
  });

  it("Later dismisses it without a backup", async () => {
    await openFilesAndLock();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText("Security Reminder")).not.toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("Backup Now makes the backup, and the reminder does not return", async () => {
    await openFilesAndLock();
    fireEvent.click(screen.getByRole("button", { name: "Backup Now" }));
    expect(await screen.findByText(/Backup saved successfully/)).toBeInTheDocument();
    expect(screen.queryByText("Security Reminder")).not.toBeInTheDocument();
    click("files: reminder");
    expect(screen.queryByText("Security Reminder")).not.toBeInTheDocument();
  });
});

// ─── Re-creating the recovery code ───────────────────────────────────────────

describe("App - reset recovery code", () => {
  it("asks first, and Cancel does nothing", () => {
    renderApp();
    click("sb: reset");
    expect(screen.getByText("Reset Recovery Code?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Reset Recovery Code?")).not.toBeInTheDocument();
    expect(mockAuthFns.handleReset2FA).not.toHaveBeenCalled();
  });

  it("resets, closes the dialog and shows nothing else on success", async () => {
    renderApp();
    click("sb: reset");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Reset" }));
    await waitFor(() => expect(mockAuthFns.handleReset2FA).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Reset Recovery Code?")).not.toBeInTheDocument());
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it("shows the reason when the reset fails, or a default", async () => {
    renderApp();
    mockAuthFns.handleReset2FA.mockResolvedValueOnce({ success: false, msg: "Backend down" });
    click("sb: reset");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Reset" }));
    expect(await screen.findByText("Backend down")).toBeInTheDocument();
    expect(screen.queryByText("Reset Recovery Code?")).not.toBeInTheDocument();
    click("OK");

    mockAuthFns.handleReset2FA.mockResolvedValueOnce({ success: false });
    click("sb: reset");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Reset" }));
    expect(await screen.findByText("Reset failed")).toBeInTheDocument();
  });

  it("makes the keychain count as not backed up again", async () => {
    backupDone = true;
    renderApp();
    tab("files");
    await act(async () => {});
    click("files: reminder");
    expect(screen.queryByText("Security Reminder")).not.toBeInTheDocument();

    click("sb: reset");
    fireEvent.click(screen.getByRole("button", { name: "Confirm Reset" }));
    await waitFor(() => expect(screen.queryByText("Reset Recovery Code?")).not.toBeInTheDocument());
    click("files: reminder");
    expect(screen.getByText("Security Reminder")).toBeInTheDocument();
  });
});

// ─── Changing the password ───────────────────────────────────────────────────

describe("App - change password", () => {
  const field = (placeholder: string) =>
    screen.getByPlaceholderText(placeholder) as HTMLInputElement;
  const open = () => click("sb: password");
  const update = () => fireEvent.click(screen.getByRole("button", { name: "Update" }));

  it("fills the three fields and passes them on", () => {
    renderApp();
    open();
    fireEvent.change(field("Current Password"), { target: { value: "old" } });
    fireEvent.change(field("New Password"), { target: { value: "new" } });
    fireEvent.change(field("Confirm New Password"), { target: { value: "new" } });
    expect(mockLatest.currentPassword).toBe("old");
    expect(mockLatest.password).toBe("new");
    expect(mockLatest.confirmPass).toBe("new");
    expect(field("New Password").value).toBe("new");
  });

  it("shows a failure inline and keeps the dialog open", async () => {
    mockAuthFns.handleChangePassword.mockResolvedValueOnce({ success: false, msg: "Too weak" });
    renderApp();
    open();
    update();
    expect(await screen.findByText(/Password change failed: Too weak/)).toBeInTheDocument();
    expect(screen.getByText("Change Password")).toBeInTheDocument();
  });

  it("uses a default message when the failure has none", async () => {
    mockAuthFns.handleChangePassword.mockResolvedValueOnce({ success: false });
    renderApp();
    open();
    update();
    expect(await screen.findByText(/Password change failed: Update failed/)).toBeInTheDocument();
  });

  it.each(["Current Password", "New Password", "Confirm New Password"])(
    "clears the failure as soon as %s is edited",
    async (placeholder) => {
      mockAuthFns.handleChangePassword.mockResolvedValueOnce({ success: false, msg: "Too weak" });
      renderApp();
      open();
      update();
      await screen.findByText(/Too weak/);
      fireEvent.change(field(placeholder), { target: { value: "x" } });
      expect(screen.queryByText(/Too weak/)).not.toBeInTheDocument();
    },
  );

  it("confirms success, closes, and counts the keychain as not backed up", async () => {
    backupDone = true;
    renderApp();
    tab("files");
    await act(async () => {});
    open();
    update();
    const toast = (await screen.findByText("Password updated successfully.")).closest(".ui-toast");
    expect(toast).toHaveClass("ui-toast--success");
    expect(screen.queryByText("Change Password")).not.toBeInTheDocument();
    click("files: reminder");
    expect(screen.getByText("Security Reminder")).toBeInTheDocument();
  });

  it("Cancel closes the dialog and empties all three fields and the failure", async () => {
    mockAuthFns.handleChangePassword.mockResolvedValueOnce({ success: false, msg: "Too weak" });
    renderApp();
    open();
    fireEvent.change(field("Current Password"), { target: { value: "old" } });
    fireEvent.change(field("New Password"), { target: { value: "new" } });
    fireEvent.change(field("Confirm New Password"), { target: { value: "new" } });
    update();
    await screen.findByText(/Too weak/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Change Password")).not.toBeInTheDocument();
    expect(mockLatest.currentPassword).toBe("");
    expect(mockLatest.password).toBe("");
    expect(mockLatest.confirmPass).toBe("");

    open();
    expect(screen.queryByText(/Too weak/)).not.toBeInTheDocument();
    expect(field("New Password").value).toBe("");
  });
});

// ─── Portable USB vaults ─────────────────────────────────────────────────────

describe("App - formatting a USB drive", () => {
  const password = () => screen.getByPlaceholderText("Vault Password") as HTMLInputElement;
  const confirm = () => screen.getByPlaceholderText("Confirm Password") as HTMLInputElement;
  const format = () => fireEvent.click(screen.getByRole("button", { name: "Format Drive" }));
  function type(pw: string, again = pw) {
    fireEvent.change(password(), { target: { value: pw } });
    fireEvent.change(confirm(), { target: { value: again } });
  }

  beforeEach(() => {
    mockPortable.drives = [drive("E:\\", "Kingston (E:)")];
  });

  function openInit(button = "files: init drive") {
    renderApp();
    tab("files");
    click(button);
  }

  it("hands the Files screen the drive list and the drive actions", () => {
    openInit("files: init drive");
    expect(mockFilesProps.portable).toBe(mockPortable);
  });

  it("names the drive, or shows its path when it is not in the list", () => {
    openInit();
    expect(screen.getByText("Kingston (E:)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    click("files: init unknown");
    expect(screen.getByText("Z:\\")).toBeInTheDocument();
  });

  it("refuses an empty password or one that does not match, without calling the backend", async () => {
    openInit();
    format();
    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    type("abc", "abd");
    expect(screen.queryByText("Passwords do not match.")).not.toBeInTheDocument();
    format();
    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(mockPortable.initVault).not.toHaveBeenCalled();
  });

  it("formats with the chosen security level (Standard by default)", async () => {
    openInit();
    type("correct horse");
    format();
    await waitFor(() => expect(mockPortable.initVault).toHaveBeenCalledTimes(1));
    expect(mockPortable.initVault).toHaveBeenCalledWith("E:\\", "correct horse", "Standard");
  });

  it("passes the level the user picked", async () => {
    openInit();
    fireEvent.click(screen.getByText("Paranoid"));
    type("correct horse");
    format();
    await waitFor(() => expect(mockPortable.initVault).toHaveBeenCalled());
    expect(mockPortable.initVault.mock.calls[0][2]).toBe("Paranoid");
  });

  it("shows the recovery code and vault ID once, and empties the password fields", async () => {
    openInit();
    type("correct horse");
    format();
    expect(await screen.findByText("AAAA-BBBB")).toBeInTheDocument();
    expect(screen.getByText("uuid-1")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Vault Password")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /I have saved both/ }));
    expect(screen.queryByText("AAAA-BBBB")).not.toBeInTheDocument();

    click("files: init drive");
    expect(password().value).toBe("");
    expect(confirm().value).toBe("");
  });

  it("shows the reason when formatting fails, or a default, and keeps the dialog", async () => {
    mockPortable.initVault.mockResolvedValueOnce({ success: false, msg: "Drive is read-only" });
    openInit();
    type("correct horse");
    format();
    expect(await screen.findByText("Drive is read-only")).toBeInTheDocument();
    expect(password().value).toBe("correct horse");

    mockPortable.initVault.mockResolvedValueOnce({ success: false });
    format();
    expect(await screen.findByText("Initialization failed.")).toBeInTheDocument();
  });

  it("clears the message as soon as either password is edited", async () => {
    openInit();
    format();
    await screen.findByText("Passwords do not match.");
    fireEvent.change(password(), { target: { value: "a" } });
    expect(screen.queryByText("Passwords do not match.")).not.toBeInTheDocument();

    format();
    await screen.findByText("Passwords do not match.");
    fireEvent.change(confirm(), { target: { value: "b" } });
    expect(screen.queryByText("Passwords do not match.")).not.toBeInTheDocument();
  });

  it("Cancel closes the dialog and forgets what was typed", () => {
    openInit();
    type("correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("Vault Password")).not.toBeInTheDocument();
    click("files: init drive");
    expect(password().value).toBe("");
  });
});

describe("App - unlocking a USB drive", () => {
  const password = () => screen.getByPlaceholderText("Vault Password") as HTMLInputElement;
  const unlock = () => fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  const trust = () => fireEvent.click(screen.getByRole("button", { name: "This is my trusted device" }));

  beforeEach(() => {
    mockPortable.drives = [drive("E:\\", "Kingston (E:)", "vault-uuid-1")];
  });

  function openUnlock() {
    renderApp();
    tab("files");
    click("files: unlock drive");
  }

  it("first asks the user to confirm the computer is trusted, then shows the vault ID", () => {
    openUnlock();
    expect(screen.getByText("Trusted Computer Only")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Vault Password")).not.toBeInTheDocument();
    trust();
    expect(screen.getByText("vault-uuid-1")).toBeInTheDocument();
    expect(password()).toBeInTheDocument();
  });

  it("does not ask again for the same vault later in the session", () => {
    openUnlock();
    trust();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    click("files: unlock drive");
    expect(screen.queryByText("Trusted Computer Only")).not.toBeInTheDocument();
    expect(password()).toBeInTheDocument();
  });

  it("asks again for a different vault", () => {
    openUnlock();
    trust();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    mockPortable.drives = [drive("E:\\", "Other", "vault-uuid-2")];
    click("tab: home");
    click("tab: files");
    click("files: unlock drive");
    expect(screen.getByText("Trusted Computer Only")).toBeInTheDocument();
  });

  it("goes straight to the password for a drive with no vault ID", () => {
    mockPortable.drives = [drive("E:\\", "Old vault")];
    openUnlock();
    expect(screen.queryByText("Trusted Computer Only")).not.toBeInTheDocument();
    expect(password()).toBeInTheDocument();
  });

  it("keeps a typed password through the trusted-device step", () => {
    mockPortable.drives = [drive("E:\\", "Kingston (E:)", "vault-uuid-1")];
    openUnlock();
    trust();
    fireEvent.change(password(), { target: { value: "secret" } });
    expect(password().value).toBe("secret");
  });

  it("unlocks with the typed password and closes", async () => {
    openUnlock();
    trust();
    fireEvent.change(password(), { target: { value: "secret" } });
    unlock();
    await waitFor(() => expect(mockPortable.unlockVault).toHaveBeenCalledWith("E:\\", "secret"));
    await waitFor(() => expect(screen.queryByPlaceholderText("Vault Password")).not.toBeInTheDocument());
  });

  it("shows the reason for a failure, or a default, and keeps the dialog open", async () => {
    mockPortable.unlockVault.mockResolvedValueOnce({ success: false, msg: "Vault file is damaged" });
    openUnlock();
    trust();
    unlock();
    expect(await screen.findByText("Vault file is damaged")).toBeInTheDocument();

    mockPortable.unlockVault.mockResolvedValueOnce({ success: false });
    unlock();
    expect(await screen.findByText("Incorrect password.")).toBeInTheDocument();
    expect(password()).toBeInTheDocument();
  });

  it("clears the message when the password is edited", async () => {
    mockPortable.unlockVault.mockResolvedValueOnce({ success: false });
    openUnlock();
    trust();
    unlock();
    await screen.findByText("Incorrect password.");
    fireEvent.change(password(), { target: { value: "x" } });
    expect(screen.queryByText("Incorrect password.")).not.toBeInTheDocument();
  });

  it("Cancel forgets the typed password", () => {
    openUnlock();
    trust();
    fireEvent.change(password(), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    click("files: unlock drive");
    expect(password().value).toBe("");
  });
});

// ─── Leaving the app ─────────────────────────────────────────────────────────

describe("App - when the session ends", () => {
  function endAndResumeSession() {
    act(() => mockLatest.setView("login"));
    act(() => mockLatest.setView("dashboard"));
  }

  it.each([
    ["theme", "sb: theme", "Dark Mode"],
    ["backup", "sb: backup", "Backup Keychain"],
    ["reset", "sb: reset", "Reset Recovery Code?"],
    ["change password", "sb: password", "Change Password"],
  ])("closes the %s dialog", (_n, button, marker) => {
    renderApp();
    click(button);
    expect(screen.getByText(marker)).toBeInTheDocument();
    endAndResumeSession();
    expect(screen.queryByText(marker)).not.toBeInTheDocument();
  });

  it("closes the help, about and update dialogs", () => {
    renderApp();
    click("sb: help");
    click("sb: about");
    click("sb: update");
    endAndResumeSession();
    expect(screen.queryByTestId("help-modal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-modal")).not.toBeInTheDocument();
    expect(document.querySelector('[style*="200000"]')).toBeNull();
  });

  it("closes the backup reminder", async () => {
    renderApp();
    tab("files");
    click("files: reminder");
    expect(screen.getByText("Security Reminder")).toBeInTheDocument();
    endAndResumeSession();
    expect(screen.queryByText("Security Reminder")).not.toBeInTheDocument();
  });

  it("does not show an old change-password failure in the next session", async () => {
    mockAuthFns.handleChangePassword.mockResolvedValueOnce({ success: false, msg: "Too weak" });
    renderApp();
    click("sb: password");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await screen.findByText(/Too weak/);
    endAndResumeSession();
    click("sb: password");
    expect(screen.queryByText(/Too weak/)).not.toBeInTheDocument();
  });

  it("forgets a USB vault password typed before the session ended", () => {
    mockPortable.drives = [drive("E:\\", "Kingston (E:)")];
    renderApp();
    tab("files");
    click("files: init drive");
    fireEvent.change(screen.getByPlaceholderText("Vault Password"), { target: { value: "usb-secret" } });
    endAndResumeSession();
    tab("files");
    expect(screen.queryByPlaceholderText("Vault Password")).not.toBeInTheDocument();
    click("files: init drive");
    expect((screen.getByPlaceholderText("Vault Password") as HTMLInputElement).value).toBe("");
  });

  it("does not leave an unlock prompt or its password behind", () => {
    mockPortable.drives = [drive("E:\\", "Kingston (E:)")];
    renderApp();
    tab("files");
    click("files: unlock drive");
    fireEvent.change(screen.getByPlaceholderText("Vault Password"), { target: { value: "usb-secret" } });
    endAndResumeSession();
    tab("files");
    expect(screen.queryByPlaceholderText("Vault Password")).not.toBeInTheDocument();
    click("files: unlock drive");
    expect((screen.getByPlaceholderText("Vault Password") as HTMLInputElement).value).toBe("");
  });

  it("does not show the recovery code of a vault that was just formatted", async () => {
    mockPortable.drives = [drive("E:\\", "Kingston (E:)")];
    renderApp();
    tab("files");
    click("files: init drive");
    fireEvent.change(screen.getByPlaceholderText("Vault Password"), { target: { value: "pw" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Format Drive" }));
    await screen.findByText("AAAA-BBBB");
    endAndResumeSession();
    expect(screen.queryByText("AAAA-BBBB")).not.toBeInTheDocument();
  });

  it("keeps a login error visible on the sign-in screen", async () => {
    renderApp("login");
    mockAuthFns.handleLogin.mockResolvedValueOnce({ success: false, msg: "Wrong password" });
    click("auth: login");
    expect(await screen.findByText("Wrong password")).toBeInTheDocument();
  });
});

describe("App - jump bar", () => {
  const ctrlK = () => fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const palette = () => screen.queryByRole("dialog", { name: "Jump to a tool or action" });
  const search = () => screen.getByRole("combobox", { name: "Jump to a tool or action" });
  const type = (text: string) => fireEvent.change(search(), { target: { value: text } });

  it("opens with Ctrl K on the dashboard", () => {
    renderApp();
    expect(palette()).not.toBeInTheDocument();
    ctrlK();
    expect(palette()).toBeInTheDocument();
    expect(search()).toHaveFocus();
  });

  it("does not open on the sign-in screens", () => {
    renderApp("login");
    ctrlK();
    expect(palette()).not.toBeInTheDocument();
  });

  it("does not wait there and pop up after the next sign-in", () => {
    renderApp("login");
    ctrlK();
    act(() => mockLatest.setView("dashboard"));
    expect(screen.getByRole("region", { name: "Vault status" })).toBeInTheDocument();
    expect(palette()).not.toBeInTheDocument();
  });

  it("closes with Ctrl K, with Escape, and after a choice", () => {
    renderApp();
    ctrlK();
    ctrlK();
    expect(palette()).not.toBeInTheDocument();

    ctrlK();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(palette()).not.toBeInTheDocument();

    ctrlK();
    type("notes");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(palette()).not.toBeInTheDocument();
  });

  it("opens the tool that is chosen", () => {
    renderApp();
    ctrlK();
    type("shred");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(activeTab()).toBe("shred");
  });

  it("finds a tool by a word that is not in its name", () => {
    renderApp();
    ctrlK();
    type("wifi");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(activeTab()).toBe("qr");
  });

  it("lists every tool and Home", () => {
    renderApp();
    ctrlK();
    const tools = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    for (const name of ["Home", "Encrypt Files", "Secure Notes", "Passwords Vault", "Bookmarks Vault", "Secure Clipboard", "Privacy Check", "Integrity Check", "File Analyzer", "System Clean", "Metadata Cleaner", "Shredder", "QR Generator"]) {
      expect(tools.some((t) => t.startsWith(name))).toBe(true);
    }
  });

  it("locks the app from the jump bar", () => {
    renderApp();
    ctrlK();
    type("lock");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(mockAuthFns.logout).toHaveBeenCalledTimes(1);
  });

  it("opens the dialog an action needs, without closing it along with the bar", () => {
    renderApp();
    ctrlK();
    type("theme");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(palette()).not.toBeInTheDocument();
    expect(screen.getByText("App Theme")).toBeInTheDocument();
  });

  it.each([
    ["backup", "Backup Keychain"],
    ["master password", "Change Password"],
    ["recovery code", "Reset Recovery Code?"],
  ])("runs the %s action", (text, heading) => {
    renderApp();
    ctrlK();
    type(text);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(screen.getByText(heading)).toBeInTheDocument();
  });

  it("opens Settings, Help and the other pages and dialogs", () => {
    renderApp();
    ctrlK();
    type("settings");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(activeTab()).toBe("settings");

    ctrlK();
    type("updates");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(screen.getByTestId("update-modal")).toBeInTheDocument();
  });

  it("does not open over another dialog", () => {
    renderApp();
    click("sb: theme");
    expect(screen.getByText("App Theme")).toBeInTheDocument();
    ctrlK();
    expect(palette()).not.toBeInTheDocument();
  });

  it("goes away when the session ends", () => {
    renderApp();
    ctrlK();
    expect(palette()).toBeInTheDocument();
    act(() => mockLatest.setView("login"));
    expect(palette()).not.toBeInTheDocument();
    act(() => mockLatest.setView("dashboard"));
    expect(palette()).not.toBeInTheDocument();
  });
});

describe("App - status bar", () => {
  const strip = () => screen.queryByRole("region", { name: "Vault status" });

  it("shows on the dashboard and not on the sign-in screens", () => {
    const { unmount } = renderApp();
    expect(strip()).toBeInTheDocument();
    unmount();
    renderApp("login");
    expect(strip()).not.toBeInTheDocument();
  });

  it("warns that the keychain is not backed up, and opens the backup dialog", async () => {
    backupDone = false;
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_backup_done"));
    fireEvent.click(screen.getByRole("button", { name: /Keychain not backed up/ }));
    expect(screen.getByText("Backup Keychain")).toBeInTheDocument();
  });

  it("confirms a backup once there is one", async () => {
    backupDone = true;
    renderApp();
    expect(await screen.findByText("Keychain backed up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Keychain not backed up/ })).not.toBeInTheDocument();
  });

  it("flips to backed up after a backup is made from the bar", async () => {
    backupDone = false;
    mockSave.mockResolvedValue("C:\\out\\QRE_Backup.json");
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_backup_done"));
    fireEvent.click(screen.getByRole("button", { name: /Keychain not backed up/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save Backup..." }));
    expect(await screen.findByText("Keychain backed up")).toBeInTheDocument();
  });

  it("locks from its Lock button", () => {
    renderApp();
    fireEvent.click(within(strip()!).getByRole("button", { name: "Lock" }));
    expect(mockAuthFns.logout).toHaveBeenCalledTimes(1);
  });

  it("shows no countdown until the sign-in hook reports a lock time", () => {
    renderApp();
    expect(within(strip()!).queryByRole("timer")).not.toBeInTheDocument();
  });

  it("shows the time left before the app locks itself", () => {
    jest.useFakeTimers();
    try {
      renderApp();
      mockLatest.idleDeadlineRef.current = Date.now() + 90_000;
      act(() => void jest.advanceTimersByTime(1000));
      expect(within(strip()!).getByRole("timer")).toHaveTextContent("Auto-lock in 1:29");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("App - Home screen", () => {
  const recent = () => screen.getByTestId("view-home").getAttribute("data-recent");

  it("knows whether the keychain is backed up", async () => {
    backupDone = true;
    renderApp();
    await waitFor(() => expect(screen.getByTestId("view-home")).toHaveAttribute("data-backup", "true"));
  });

  it("opens the backup dialog and the jump bar from Home", () => {
    renderApp();
    click("home: backup");
    expect(screen.getByText("Backup Keychain")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    click("home: jump");
    expect(screen.getByRole("dialog", { name: "Jump to a tool or action" })).toBeInTheDocument();
  });

  it("starts with no recent tools", () => {
    renderApp();
    expect(recent()).toBe("");
  });

  it("remembers the tools opened, newest first", () => {
    renderApp();
    tab("vault");
    tab("notes");
    tab("home");
    expect(recent()).toBe("notes,vault");
  });

  it("moves a tool that is opened again to the front instead of listing it twice", () => {
    renderApp();
    tab("vault");
    tab("notes");
    tab("vault");
    tab("home");
    expect(recent()).toBe("vault,notes");
  });

  it("keeps only the last four", () => {
    renderApp();
    for (const id of ["vault", "notes", "qr", "hash", "shred"]) tab(id);
    tab("home");
    expect(recent()).toBe("shred,hash,qr,notes");
  });

  it("does not list Home, Settings or Help, which are not tools", () => {
    renderApp();
    tab("settings");
    tab("help");
    tab("home");
    expect(recent()).toBe("");
  });

  it("counts a tool opened from the jump bar too", () => {
    renderApp();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Jump to a tool or action" }), { target: { value: "shred" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Jump to a tool or action" }), { key: "Enter" });
    tab("home");
    expect(recent()).toBe("shred");
  });

  it("forgets them when the session ends", () => {
    renderApp();
    tab("vault");
    tab("home");
    expect(recent()).toBe("vault");
    act(() => mockLatest.setView("login"));
    act(() => mockLatest.setView("dashboard"));
    expect(recent()).toBe("");
  });
});
