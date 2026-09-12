import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FilesView } from "./FilesView";

// ─── Mock every Tauri API these components/hooks touch ─────────────────────

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockWatch = jest.fn();
const mockHomeDir = jest.fn();
const mockPlatform = jest.fn();
const mockGetCurrentWindow = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}));

jest.mock("@tauri-apps/plugin-fs", () => ({
  readFile: jest.fn(),
  watch: (...args: unknown[]) => mockWatch(...args),
}));

jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

jest.mock("@tauri-apps/api/path", () => ({
  homeDir: () => mockHomeDir(),
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
  downloadDir: () => Promise.resolve("/downloads"),
  desktopDir: () => Promise.resolve("/desktop"),
  documentDir: () => Promise.resolve("/documents"),
}));

jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockGetCurrentWindow(),
}));

jest.mock("@tauri-apps/plugin-process", () => ({
  relaunch: jest.fn(),
}));

// ─── Test setup ──────────────────────────────────────────────────────────────

const noopPortable = {
  drives: [],
  isScanning: false,
  scanDrives: jest.fn(),
  lockVault: jest.fn(),
};

function renderFilesView() {
  return render(
    <FilesView
      onShowBackupReminder={jest.fn()}
      portable={noopPortable}
      onInitDrive={jest.fn()}
      onUnlockDrive={jest.fn()}
    />,
  );
}

describe("FilesView - Paranoid Mode stale-closure regression", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatform.mockReturnValue("windows");
    mockHomeDir.mockResolvedValue("C:\\Users\\test");
    mockListen.mockResolvedValue(() => {});
    mockWatch.mockResolvedValue(() => {});
    mockGetCurrentWindow.mockReturnValue({
      listen: jest.fn().mockResolvedValue(() => {}),
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_directory") {
        return Promise.resolve([
          {
            name: "secret.txt",
            is_directory: false,
            path: "C:\\Users\\test\\secret.txt",
            size: 123,
            modified: null,
          },
        ]);
      }
      if (cmd === "get_file_timelock_status") {
        return Promise.resolve({ is_locked: false, locked_until: 0 });
      }
      return Promise.resolve(null);
    });
  });

  it("applies Paranoid Mode when toggled immediately before clicking Lock, without navigating away", async () => {
    // Regression test for the useCallback([props.portable.drives, fs.currentPath])
    // bug: requestLock/executeLock used to stay memoized against a stale
    // `crypto` closure whenever neither dependency changed, so toggling
    // Paranoid Mode right before clicking Lock (the exact real-world flow -
    // both controls live in the same Toolbar, with no navigation in between)
    // silently locked the file without the extra entropy step.
    renderFilesView();

    // Wait for the initial directory listing to render.
    await waitFor(() =>
      expect(screen.getByText("secret.txt")).toBeInTheDocument(),
    );

    // Select the file.
    fireEvent.click(screen.getByText("secret.txt"));

    // Open the Advanced settings dropdown (the gear/sliders button - the last
    // "tool-btn" in the toolbar's right-hand group) and toggle Paranoid Mode.
    const toolButtons = document.querySelectorAll("button.tool-btn");
    const advancedButton = toolButtons[toolButtons.length - 1];
    fireEvent.click(advancedButton);

    await waitFor(() =>
      expect(screen.getByText("Paranoid Mode")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Paranoid Mode"));

    // Click Lock immediately - no folder navigation, no drive-list change in
    // between, which is exactly what could leave requestLock's memoized
    // callback stale before the fix.
    fireEvent.click(screen.getByText("Lock"));

    // With Paranoid Mode correctly applied, executeLock must route through
    // the EntropyModal instead of calling lock_file directly.
    await waitFor(() =>
      expect(screen.getByText("Generating Entropy")).toBeInTheDocument(),
    );

    expect(
      mockInvoke.mock.calls.some(([cmd]) => cmd === "lock_file"),
    ).toBe(false);
  });
});
