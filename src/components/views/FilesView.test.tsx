import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { FilesView } from "./FilesView";
import type { PortableDriveState } from "../../hooks/usePortableVault";
import { ToastProvider } from "../ui";

// ─── Mock every Tauri API these components/hooks touch ─────────────────────

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockWatch = jest.fn();
const mockHomeDir = jest.fn();
const mockPlatform = jest.fn();
const mockGetCurrentWindow = jest.fn();
const mockOpenDialog = jest.fn();
const mockRelaunch = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
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
  relaunch: () => mockRelaunch(),
}));

// ─── Fake backend ────────────────────────────────────────────────────────────

const HOME = "C:\\Users\\test";
const ANDROID_HOME = "/storage/emulated/0";
const SUB = `${HOME}\\sub`;
const SECRET = `${HOME}\\secret.txt`;
const VAULT = `${HOME}\\vault.qre`;

interface Listed {
  name: string;
  is_directory: boolean;
  path: string;
  size: number | null;
  modified: number | null;
}
const listedFile = (name: string, dir = HOME, size = 100): Listed => ({
  name,
  is_directory: false,
  path: `${dir}\\${name}`,
  size,
  modified: null,
});
const listedDir = (name: string, dir = HOME): Listed => ({
  name,
  is_directory: true,
  path: `${dir}\\${name}`,
  size: null,
  modified: null,
});

type Handler = (args: any) => unknown;
let listings: Record<string, Listed[] | Error>;
let handlers: Record<string, Handler>;
let windowEvents: Record<string, (e: unknown) => void>;
let progressHandler: ((e: unknown) => void) | undefined;

function calls(cmd: string): any[] {
  return mockInvoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);
}
const listedPaths = () => calls("list_directory").map((a) => a.path);

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const ok = (name: string) => ({ name, success: true, message: "" });
const fail = (name: string, message: string) => ({ name, success: false, message });

// ─── Rendering ───────────────────────────────────────────────────────────────

function drive(path: string, unlocked = true): PortableDriveState {
  return {
    drive: { path, name: "USB", is_qre_portable: true },
    isUnlocked: unlocked,
  } as unknown as PortableDriveState;
}

function setup(drives: PortableDriveState[] = []) {
  const props = {
    onShowBackupReminder: jest.fn(),
    portable: {
      drives,
      isScanning: false,
      scanDrives: jest.fn(),
      lockVault: jest.fn(),
    },
    onInitDrive: jest.fn(),
    onUnlockDrive: jest.fn(),
  };
  const utils = render(<FilesView {...props} />);
  return { props, ...utils };
}

async function loaded(name = "secret.txt") {
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
}

// The extract question is a dialog; its Desktop, Documents and Downloads buttons share their
// names with the places in the side list.
const extractDialog = () => screen.getByText("Extract Files").closest(".modal-overlay") as HTMLElement;
const row = (name: string) => screen.getByText(name).closest(".file-row") as HTMLElement;
const toolbarLock = () => document.querySelector(".tool-btn.success") as HTMLElement;
const toolbarUnlock = () => document.querySelector(".tool-btn.danger") as HTMLElement;
const advancedButton = () => {
  const all = document.querySelectorAll("button.tool-btn");
  return all[all.length - 1] as HTMLElement;
};
const statusBar = () => document.querySelector(".status-bar") as HTMLElement;
const menuItem = (label: string | RegExp) =>
  within(document.querySelector(".dropdown-menu") as HTMLElement).getByText(label);

async function select(...names: string[]) {
  fireEvent.click(screen.getByText(names[0]));
  for (const n of names.slice(1)) fireEvent.click(screen.getByText(n), { ctrlKey: true });
}

function rightClick(name: string) {
  fireEvent.contextMenu(screen.getByText(name));
}

// The click can start async work, such as a copy that goes on to the system clipboard. It runs
// inside an awaited act(), so the state updates that follow are finished before the test goes on.
async function runMenu(name: string, action: string | RegExp) {
  rightClick(name);
  await act(async () => {
    fireEvent.click(menuItem(action));
  });
}

// Opens the menu of the empty part of the list. Opening it asks the system clipboard if it holds
// files, which ends in a state update, so this runs inside an awaited act() too.
async function openBackgroundMenu() {
  await act(async () => {
    fireEvent.contextMenu(statusBar());
  });
}

function pressKey(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
  fireEvent.keyDown(target, { key, ...init });
}

let wiggleX = 0;
function wiggle(times: number) {
  const overlay = screen.getByText("Generating Entropy").closest(".modal-overlay")!;
  for (let i = 0; i < times; i++) {
    wiggleX += 10;
    fireEvent.mouseMove(overlay, { clientX: wiggleX, clientY: 0 });
  }
}

afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  jest.clearAllMocks();
  wiggleX = 0;
  localStorage.clear();
  mockPlatform.mockReturnValue("windows");
  mockHomeDir.mockResolvedValue(HOME);
  mockWatch.mockResolvedValue(() => {});
  mockOpenDialog.mockResolvedValue(null);
  mockRelaunch.mockResolvedValue(undefined);

  windowEvents = {};
  progressHandler = undefined;
  mockListen.mockImplementation((event: string, cb: (e: unknown) => void) => {
    if (event === "qre:progress") progressHandler = cb;
    return Promise.resolve(() => {});
  });
  mockGetCurrentWindow.mockReturnValue({
    listen: jest.fn((event: string, cb: (e: unknown) => void) => {
      windowEvents[event] = cb;
      return Promise.resolve(() => {});
    }),
  });

  listings = {
    [HOME]: [listedDir("sub"), listedFile("secret.txt"), listedFile("vault.qre", HOME, 2048)],
    [SUB]: [listedFile("inner.txt", SUB)],
    "C:\\Users": [listedDir("test", "C:\\Users")],
  };
  handlers = {
    get_file_timelock_status: () => ({ is_locked: false, locked_until: 0 }),
    lock_file: (a) => (a.filePaths as string[]).map((p) => ok(p)),
    unlock_file: (a) => (a.filePaths as string[]).map((p) => ok(p)),
    paste_items: (a) => (a.sources as string[]).map((p) => ok(p)),
    trash_items: (a) => (a.paths as string[]).map((p) => ok(p)),
    delete_items: (a) => (a.paths as string[]).map((p) => ok(p)),
  };
  mockInvoke.mockImplementation((cmd: string, args: any) => {
    if (cmd === "list_directory") {
      const r = listings[args.path];
      if (r instanceof Error) return Promise.reject(r.message);
      return Promise.resolve(r ?? []);
    }
    if (cmd === "get_drives") return Promise.resolve(["C:\\"]);
    const h = handlers[cmd];
    return h ? Promise.resolve().then(() => h(args)) : Promise.resolve(null);
  });
});

// ─── Existing regression ─────────────────────────────────────────────────────

describe("FilesView - Paranoid Mode stale-closure regression", () => {
  it("applies Paranoid Mode when toggled immediately before clicking Lock, without navigating away", async () => {
    // Regression test for the useCallback([props.portable.drives, fs.currentPath])
    // bug: requestLock/executeLock used to stay memoized against a stale
    // `crypto` closure whenever neither dependency changed, so toggling
    // Paranoid Mode right before clicking Lock (the exact real-world flow -
    // both controls live in the same Toolbar, with no navigation in between)
    // silently locked the file without the extra entropy step.
    setup();
    await loaded();
    fireEvent.click(screen.getByText("secret.txt"));

    fireEvent.click(advancedButton());
    await waitFor(() => expect(screen.getByText("Paranoid Mode")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Paranoid Mode"));

    fireEvent.click(toolbarLock());

    await waitFor(() => expect(screen.getByText("Generating Entropy")).toBeInTheDocument());
    expect(calls("lock_file")).toHaveLength(0);
  });
});

// ─── Listing and status bar ──────────────────────────────────────────────────

describe("FilesView - listing", () => {
  it("opens the home folder with folders first and shows the item count", async () => {
    setup();
    await loaded();
    expect(listedPaths()[0]).toBe(HOME);
    const names = Array.from(document.querySelectorAll(".file-row .grid-cell:nth-child(2)")).map(
      (c) => c.textContent,
    );
    expect(names).toEqual(["sub", "secret.txt", "vault.qre"]);
    expect(statusBar()).toHaveTextContent("3 items");
    expect(statusBar()).toHaveTextContent("No selection");
  });

  it("shows the selection count and total size", async () => {
    setup();
    await loaded();
    await select("secret.txt", "vault.qre");
    expect(statusBar()).toHaveTextContent("2 selected");
    expect(statusBar()).toHaveTextContent("2.1 KB");
  });

  it("opens a folder on double click and goes up with the up button", async () => {
    setup();
    await loaded();
    fireEvent.doubleClick(screen.getByText("sub"));
    await loaded("inner.txt");
    expect(listedPaths()).toContain(SUB);
    fireEvent.click(screen.getByTitle("Up One Directory"));
    await loaded("secret.txt");
  });

  it("shows a listing error in the status bar", async () => {
    listings[HOME] = new Error("disk on fire");
    setup();
    await waitFor(() => expect(statusBar()).toHaveTextContent("Error: disk on fire"));
  });

  it("blocks a system folder typed in the address bar", async () => {
    setup();
    await loaded();
    fireEvent.click(document.querySelector(".breadcrumbs")!);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "C:\\Windows" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByText("System Protection Active");
    expect(screen.getByText("C:\\Windows")).toBeInTheDocument();
    expect(listedPaths()).not.toContain("C:\\Windows");
    fireEvent.click(screen.getByText("Understood"));
    expect(screen.queryByText("System Protection Active")).not.toBeInTheDocument();
  });
});

// ─── Locking ─────────────────────────────────────────────────────────────────

describe("FilesView - locking", () => {
  it("locks the selection with the current options and reminds about a backup", async () => {
    const { props } = setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(toolbarLock());

    await waitFor(() => expect(calls("lock_file")).toHaveLength(1));
    expect(calls("lock_file")[0]).toEqual({
      filePaths: [SECRET],
      keyfilePath: null,
      keyfileBytes: null,
      extraEntropy: null,
      compressionMode: "auto",
      verifyAfter: true,
      outputDir: null,
    });
    await waitFor(() => expect(props.onShowBackupReminder).toHaveBeenCalledTimes(1));
    // The folder is listed again so the new .qre file appears.
    expect(listedPaths().filter((p) => p === HOME).length).toBeGreaterThanOrEqual(2);
  });

  it("locks every selected file", async () => {
    setup();
    await loaded();
    await select("secret.txt", "vault.qre");
    fireEvent.click(toolbarLock());
    await waitFor(() => expect(calls("lock_file")[0].filePaths).toEqual([SECRET, VAULT]));
  });

  it("lists the files that failed and skips the backup reminder", async () => {
    handlers.lock_file = () => [ok("a"), fail("secret.txt", "Disk full")];
    const { props } = setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(toolbarLock());

    await screen.findByText(/Locking failed for some items/);
    expect(screen.getByText(/secret\.txt: Disk full/)).toBeInTheDocument();
    expect(props.onShowBackupReminder).not.toHaveBeenCalled();
  });

  it("shows the error when the whole command fails", async () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    handlers.lock_file = () => {
      throw "backend exploded";
    };
    const { props } = setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(toolbarLock());
    await screen.findByText("backend exploded");
    expect(props.onShowBackupReminder).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith("Crypto Command Error (lock_file):", "backend exploded");
  });

  it("asks for a selection, and does not ask for entropy first when Paranoid Mode is on", async () => {
    // Waving the mouse around only to be told "No files selected" afterwards is useless.
    setup();
    await loaded();
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Paranoid Mode"));
    fireEvent.click(toolbarLock());

    await screen.findByText("No files selected.");
    expect(screen.queryByText("Generating Entropy")).not.toBeInTheDocument();
    expect(calls("lock_file")).toHaveLength(0);
  });

  it("asks for a selection when nothing is selected", async () => {
    setup();
    await loaded();
    fireEvent.click(toolbarLock());
    await screen.findByText("No files selected.");
    expect(calls("lock_file")).toHaveLength(0);
  });

  it("Paranoid Mode collects 32 bytes of movement and then locks with them", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Paranoid Mode"));
    fireEvent.click(toolbarLock());

    await screen.findByText("Generating Entropy");
    wiggle(70);
    await waitFor(() => expect(calls("lock_file")).toHaveLength(1), { timeout: 2000 });
    const args = calls("lock_file")[0];
    expect(args.filePaths).toEqual([SECRET]);
    expect(args.extraEntropy).toHaveLength(32);
    expect(screen.queryByText("Generating Entropy")).not.toBeInTheDocument();
  });

  it("cancelling the entropy step locks nothing", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Paranoid Mode"));
    fireEvent.click(toolbarLock());
    await screen.findByText("Generating Entropy");
    wiggle(10);
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByText("Generating Entropy")).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls("lock_file")).toHaveLength(0);
  });

  it("uses the chosen compression mode", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Zip Options"));
    fireEvent.click(screen.getByText("Fastest (Minimal)"));
    fireEvent.click(screen.getByText("Save"));
    expect(screen.queryByText("Select compression mode:")).not.toBeInTheDocument();

    fireEvent.click(toolbarLock());
    await waitFor(() => expect(calls("lock_file")[0].compressionMode).toBe("store"));
  });

  it("Cancel in the compression dialog keeps the old mode", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Zip Options"));
    fireEvent.click(screen.getByText("Fastest (Minimal)"));
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(toolbarLock());
    await waitFor(() => expect(calls("lock_file")[0].compressionMode).toBe("auto"));
  });

  it("sends the chosen keyfile and shows it in the status bar", async () => {
    mockOpenDialog.mockResolvedValue("C:\\keys\\my.key");
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Select Keyfile"));
    await waitFor(() => expect(statusBar()).toHaveTextContent("Keyfile Active"));

    fireEvent.click(toolbarLock());
    await waitFor(() => expect(calls("lock_file")[0].keyfilePath).toBe("C:\\keys\\my.key"));
  });

  it("shows progress events from the backend", async () => {
    setup();
    await loaded();
    expect(progressHandler).toBeDefined();
    act(() => {
      progressHandler!({ payload: { status: "Encrypting big.iso", percentage: 42 } });
    });
    expect(await screen.findByText(/Encrypting big\.iso/)).toBeInTheDocument();
  });
});

// ─── Unlocking ───────────────────────────────────────────────────────────────

describe("FilesView - unlocking", () => {
  it("unlocks the selection and refreshes the folder", async () => {
    setup();
    await loaded();
    await select("vault.qre");
    const before = listedPaths().length;
    fireEvent.click(toolbarUnlock());

    await waitFor(() => expect(calls("unlock_file")).toHaveLength(1));
    expect(calls("unlock_file")[0]).toMatchObject({
      filePaths: [VAULT],
      compressionMode: null,
      outputDir: null,
      extraEntropy: null,
    });
    await waitFor(() => expect(listedPaths().length).toBeGreaterThan(before));
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it("asks for a selection when nothing is selected", async () => {
    setup();
    await loaded();
    fireEvent.click(toolbarUnlock());
    await screen.findByText("No files selected.");
    expect(calls("unlock_file")).toHaveLength(0);
  });

  it("explains a time-locked file without the internal prefix", async () => {
    handlers.unlock_file = () => [
      fail("vault.qre", "TIME_LOCKED:1893456000:Locked until Jan 1, 2030, 10:30 AM"),
    ];
    setup();
    await loaded();
    await select("vault.qre");
    fireEvent.click(toolbarUnlock());

    const msg = await screen.findByText(/Locked until Jan 1, 2030, 10:30 AM/);
    expect(msg).toHaveTextContent("🔒 Locked until Jan 1, 2030, 10:30 AM");
    expect(msg).not.toHaveTextContent("TIME_LOCKED");
    expect(msg).not.toHaveTextContent("1893456000");
  });

  it("separates several time-locked files with a blank line", async () => {
    handlers.unlock_file = () => [
      fail("a.qre", "TIME_LOCKED:1:First one"),
      fail("b.qre", "TIME_LOCKED:2:Second one"),
    ];
    setup();
    await loaded();
    await select("vault.qre");
    fireEvent.click(toolbarUnlock());
    const msg = await screen.findByText(/First one/);
    expect(msg.textContent).toBe("🔒 First one\n\n🔒 Second one");
  });

  it("reports time-locked and ordinary failures together", async () => {
    handlers.unlock_file = () => [
      fail("a.qre", "TIME_LOCKED:1:Opens next week"),
      fail("b.qre", "Wrong password"),
    ];
    setup();
    await loaded();
    await select("vault.qre");
    fireEvent.click(toolbarUnlock());

    const msg = await screen.findByText(/Unlock failed/);
    expect(msg).toHaveTextContent("b.qre: Wrong password");
    // Both problems must be visible; one used to overwrite the other.
    expect(msg).toHaveTextContent("Opens next week");
  });

  it("lists ordinary failures", async () => {
    handlers.unlock_file = () => [fail("vault.qre", "Wrong password")];
    setup();
    await loaded();
    await select("vault.qre");
    fireEvent.click(toolbarUnlock());
    const msg = await screen.findByText(/Unlock failed/);
    expect(msg).toHaveTextContent("• vault.qre: Wrong password");
  });

  it("shows the error when the whole command fails", async () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    handlers.unlock_file = () => {
      throw "cannot open";
    };
    setup();
    await loaded();
    await select("vault.qre");
    fireEvent.click(toolbarUnlock());
    await screen.findByText("cannot open");
    expect(errorLog).toHaveBeenCalledWith("Crypto Command Error (unlock_file):", "cannot open");
  });
});

// ─── Portable drives ─────────────────────────────────────────────────────────

describe("FilesView - files on an unlocked USB drive", () => {
  const usbFile = (name: string): Listed => ({
    name,
    is_directory: false,
    path: `e:\\usb\\${name}`,
    size: 5,
    modified: null,
  });

  beforeEach(() => {
    listings[HOME] = [usbFile("plain.txt"), usbFile("sealed.qre")];
  });

  it("warns before encrypting on the drive, whatever the letter case", async () => {
    setup([drive("E:\\usb\\")]);
    await loaded("plain.txt");
    await select("plain.txt");
    fireEvent.click(toolbarLock());

    await screen.findByText("USB Encryption Warning");
    expect(calls("lock_file")).toHaveLength(0);
  });

  it("Cancel in the warning locks nothing", async () => {
    setup([drive("E:\\usb\\")]);
    await loaded("plain.txt");
    await select("plain.txt");
    fireEvent.click(toolbarLock());
    await screen.findByText("USB Encryption Warning");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("USB Encryption Warning")).not.toBeInTheDocument();
    expect(calls("lock_file")).toHaveLength(0);
  });

  it("I Understand locks the file", async () => {
    const { props } = setup([drive("E:\\usb\\")]);
    await loaded("plain.txt");
    await select("plain.txt");
    fireEvent.click(toolbarLock());
    await screen.findByText("USB Encryption Warning");
    fireEvent.click(screen.getByText("I Understand, Proceed"));
    await waitFor(() => expect(calls("lock_file")).toHaveLength(1));
    expect(calls("lock_file")[0].filePaths).toEqual(["e:\\usb\\plain.txt"]);
    await waitFor(() => expect(props.onShowBackupReminder).toHaveBeenCalled());
  });

  it("still collects entropy after the warning when Paranoid Mode is on", async () => {
    setup([drive("E:\\usb\\")]);
    await loaded("plain.txt");
    await select("plain.txt");
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Paranoid Mode"));
    fireEvent.click(toolbarLock());
    await screen.findByText("USB Encryption Warning");
    fireEvent.click(screen.getByText("I Understand, Proceed"));
    await screen.findByText("Generating Entropy");
    wiggle(70);
    await waitFor(() => expect(calls("lock_file")).toHaveLength(1), { timeout: 2000 });
    expect(calls("lock_file")[0].extraEntropy).toHaveLength(32);
  });

  it("does not warn when the drive is locked", async () => {
    setup([drive("E:\\usb\\", false)]);
    await loaded("plain.txt");
    await select("plain.txt");
    fireEvent.click(toolbarLock());
    await waitFor(() => expect(calls("lock_file")).toHaveLength(1));
    expect(screen.queryByText("USB Encryption Warning")).not.toBeInTheDocument();
  });

  it("does not mistake a similarly named folder for the drive", async () => {
    setup([drive("E:\\usb\\")]);
    listings[HOME] = [
      { ...usbFile("other.txt"), path: "e:\\usb2\\other.txt" },
    ];
    await loaded("other.txt");
    await select("other.txt");
    fireEvent.click(toolbarLock());
    await waitFor(() => expect(calls("lock_file")).toHaveLength(1));
    expect(screen.queryByText("USB Encryption Warning")).not.toBeInTheDocument();
  });

  it("asks where to extract, and unlocks into the chosen folder", async () => {
    setup([drive("E:\\usb\\")]);
    await loaded("sealed.qre");
    await select("sealed.qre");
    fireEvent.click(toolbarUnlock());
    await screen.findByText("Extract Files");
    expect(calls("unlock_file")).toHaveLength(0);

    fireEvent.click(within(extractDialog()).getByText("Downloads"));
    await waitFor(() => expect(calls("unlock_file")).toHaveLength(1));
    expect(calls("unlock_file")[0]).toMatchObject({
      filePaths: ["e:\\usb\\sealed.qre"],
      outputDir: "/downloads",
    });
    expect(screen.queryByText("Extract Files")).not.toBeInTheDocument();
  });

  it.each([
    ["Desktop", "/desktop"],
    ["Documents", "/documents"],
  ])("extracts to %s", async (label, dir) => {
    setup([drive("E:\\usb\\")]);
    await loaded("sealed.qre");
    await select("sealed.qre");
    fireEvent.click(toolbarUnlock());
    await screen.findByText("Extract Files");
    fireEvent.click(within(extractDialog()).getByText(label));
    await waitFor(() => expect(calls("unlock_file")[0].outputDir).toBe(dir));
  });

  it("can extract next to the file on the drive", async () => {
    setup([drive("E:\\usb\\")]);
    await loaded("sealed.qre");
    await select("sealed.qre");
    fireEvent.click(toolbarUnlock());
    await screen.findByText("Extract Files");
    fireEvent.click(screen.getByText("Extract Here (USB)"));
    await waitFor(() => expect(calls("unlock_file")).toHaveLength(1));
    expect(calls("unlock_file")[0].outputDir).toBeNull();
  });

  it("closing the extract dialog unlocks nothing", async () => {
    setup([drive("E:\\usb\\")]);
    await loaded("sealed.qre");
    await select("sealed.qre");
    fireEvent.click(toolbarUnlock());
    await screen.findByText("Extract Files");
    fireEvent.click(extractDialog().querySelector("svg.lucide-x")!);
    expect(screen.queryByText("Extract Files")).not.toBeInTheDocument();
    expect(calls("unlock_file")).toHaveLength(0);
  });

  it("reports failures from the extract step", async () => {
    handlers.unlock_file = () => [fail("sealed.qre", "Wrong password")];
    setup([drive("E:\\usb\\")]);
    await loaded("sealed.qre");
    await select("sealed.qre");
    fireEvent.click(toolbarUnlock());
    await screen.findByText("Extract Files");
    fireEvent.click(within(extractDialog()).getByText("Desktop"));
    const msg = await screen.findByText(/Unlock failed/);
    expect(msg).toHaveTextContent("sealed.qre: Wrong password");
  });
});

// ─── Drag and drop ───────────────────────────────────────────────────────────

describe("FilesView - dropping files on the window", () => {
  it("shows the drop hint while dragging and hides it again", async () => {
    setup();
    await loaded();
    await waitFor(() => expect(windowEvents["tauri://drag-enter"]).toBeDefined());
    act(() => windowEvents["tauri://drag-enter"]({}));
    expect(screen.getByText("Drop to Lock")).toBeInTheDocument();
    act(() => windowEvents["tauri://drag-leave"]({}));
    expect(screen.queryByText("Drop to Lock")).not.toBeInTheDocument();
  });

  it("locks dropped plain files and unlocks dropped .qre files", async () => {
    setup();
    await loaded();
    await waitFor(() => expect(windowEvents["tauri://drag-drop"]).toBeDefined());
    act(() => {
      windowEvents["tauri://drag-drop"]({
        payload: { paths: ["C:\\a.txt", "C:\\b.qre", "C:\\c.png"] },
      });
    });
    await waitFor(() => expect(calls("lock_file")).toHaveLength(1));
    await waitFor(() => expect(calls("unlock_file")).toHaveLength(1));
    expect(calls("lock_file")[0].filePaths).toEqual(["C:\\a.txt", "C:\\c.png"]);
    expect(calls("unlock_file")[0].filePaths).toEqual(["C:\\b.qre"]);
  });

  it("uses the current Paranoid Mode setting for a drop", async () => {
    setup();
    await loaded();
    await waitFor(() => expect(windowEvents["tauri://drag-drop"]).toBeDefined());
    fireEvent.click(advancedButton());
    fireEvent.click(screen.getByText("Paranoid Mode"));
    act(() => {
      windowEvents["tauri://drag-drop"]({ payload: { paths: ["C:\\a.txt"] } });
    });
    await screen.findByText("Generating Entropy");
    expect(calls("lock_file")).toHaveLength(0);
  });
});

// ─── Context menu, clipboard, rename, new folder ─────────────────────────────

describe("FilesView - context menu", () => {
  it("right click selects the row and opens the menu", async () => {
    setup();
    await loaded();
    rightClick("secret.txt");
    expect(menuItem("Rename")).toBeInTheDocument();
    expect(row("secret.txt")).toHaveClass("selected");
  });

  it("right click on empty space opens the background menu", async () => {
    setup();
    await loaded();
    await openBackgroundMenu();
    expect(menuItem("New Folder")).toBeInTheDocument();
    expect(menuItem("Refresh")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
  });

  it("Refresh lists the folder again", async () => {
    setup();
    await loaded();
    const before = listedPaths().length;
    await openBackgroundMenu();
    fireEvent.click(menuItem("Refresh"));
    await waitFor(() => expect(listedPaths().length).toBe(before + 1));
    expect(screen.queryByText("Refresh")).not.toBeInTheDocument();
  });

  it("Lock and Unlock from the menu use the clicked file", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Lock");
    await waitFor(() => expect(calls("lock_file")[0].filePaths).toEqual([SECRET]));
    await runMenu("vault.qre", "Unlock");
    await waitFor(() => expect(calls("unlock_file")[0].filePaths).toEqual([VAULT]));
  });

  it("acts on the whole selection when the clicked file is part of it", async () => {
    setup();
    await loaded();
    await select("secret.txt", "vault.qre");
    rightClick("secret.txt");
    fireEvent.click(menuItem("Lock"));
    await waitFor(() => expect(calls("lock_file")[0].filePaths).toEqual([SECRET, VAULT]));
  });

  it("acts only on the clicked file when it is outside the selection", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    rightClick("vault.qre");
    fireEvent.click(menuItem("Unlock"));
    await waitFor(() => expect(calls("unlock_file")[0].filePaths).toEqual([VAULT]));
  });

  it("Reveal in Explorer asks the backend to show the file", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Reveal in Explorer");
    await waitFor(() => expect(calls("show_in_folder")).toEqual([{ path: SECRET }]));
  });

  it("shows a failure to reveal the file", async () => {
    handlers.show_in_folder = () => {
      throw "no explorer";
    };
    setup();
    await loaded();
    await runMenu("secret.txt", "Reveal in Explorer");
    await screen.findByText("no explorer");
  });

  it("opens the file on Android and shows a failure", async () => {
    mockPlatform.mockReturnValue("android");
    listings[ANDROID_HOME] = listings[HOME];
    handlers.open_file_android = () => {
      throw "no app for that";
    };
    setup();
    await loaded();
    await runMenu("secret.txt", "Open File");
    await waitFor(() => expect(calls("open_file_android")).toEqual([{ path: SECRET }]));
    await screen.findByText("no app for that");
  });

  it("clicking outside closes the menu without acting", async () => {
    setup();
    await loaded();
    rightClick("secret.txt");
    fireEvent.click(document.querySelector(".modal-overlay")!);
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
    expect(calls("lock_file")).toHaveLength(0);
  });
});

describe("FilesView - new folder and rename", () => {
  it("creates a folder in the current directory", async () => {
    setup();
    await loaded();
    const before = listedPaths().length;
    await openBackgroundMenu();
    fireEvent.click(menuItem("New Folder"));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Photos" } });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(calls("create_dir")).toEqual([{ path: `${HOME}/Photos` }]));
    await waitFor(() => expect(listedPaths().length).toBeGreaterThan(before));
    expect(screen.queryByText("Create")).not.toBeInTheDocument();
  });

  it("ignores spaces around the new folder name", async () => {
    setup();
    await loaded();
    await openBackgroundMenu();
    fireEvent.click(menuItem("New Folder"));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "  Photos  " } });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(calls("create_dir")).toEqual([{ path: `${HOME}/Photos` }]));
  });

  it("does nothing for an empty or blank name", async () => {
    setup();
    await loaded();
    await openBackgroundMenu();
    fireEvent.click(menuItem("New Folder"));
    const input = await screen.findByRole("textbox");
    fireEvent.click(screen.getByText("Create"));
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Create"));
    expect(calls("create_dir")).toHaveLength(0);
  });

  it("shows a failure to create the folder", async () => {
    handlers.create_dir = () => {
      throw "already exists";
    };
    setup();
    await loaded();
    await openBackgroundMenu();
    fireEvent.click(menuItem("New Folder"));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Dup" } });
    fireEvent.click(screen.getByText("Create"));
    await screen.findByText("already exists");
  });

  it("renames starting from the current name", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Rename");
    const input = (await screen.findByRole("textbox")) as HTMLInputElement;
    expect(input.value).toBe("secret.txt");
    fireEvent.change(input, { target: { value: "plan.txt" } });
    fireEvent.click(screen.getByText("Rename", { selector: "button" }));
    await waitFor(() =>
      expect(calls("rename_item")).toEqual([{ path: SECRET, newName: "plan.txt" }]),
    );
  });

  it("ignores spaces around the new name", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Rename");
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: " plan.txt " } });
    fireEvent.click(screen.getByText("Rename", { selector: "button" }));
    await waitFor(() =>
      expect(calls("rename_item")).toEqual([{ path: SECRET, newName: "plan.txt" }]),
    );
  });

  it("shows a failure to rename", async () => {
    handlers.rename_item = () => {
      throw "name taken";
    };
    setup();
    await loaded();
    await runMenu("secret.txt", "Rename");
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "x.txt" } });
    fireEvent.click(screen.getByText("Rename", { selector: "button" }));
    await screen.findByText("name taken");
  });

  it("Cancel closes the dialog without renaming", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Rename");
    fireEvent.click(await screen.findByText("Cancel"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(calls("rename_item")).toHaveLength(0);
  });
});

describe("FilesView - cut, copy and paste", () => {
  async function copyThenPasteHere(name: string, action: "Copy" | "Cut") {
    await runMenu(name, action);
    await openBackgroundMenu();
    fireEvent.click(menuItem("Paste Here"));
  }

  it("shows what is on the clipboard", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Copy");
    expect(statusBar()).toHaveTextContent("1 item(s) copied");
    await select("secret.txt", "vault.qre");
    await runMenu("vault.qre", "Cut");
    expect(statusBar()).toHaveTextContent("2 item(s) cut");
  });

  it("offers Paste Here only when something was copied", async () => {
    setup();
    await loaded();
    await openBackgroundMenu();
    expect(screen.queryByText("Paste Here")).not.toBeInTheDocument();
    const listings = calls("list_directory").length;
    // Refresh reloads the folder and then the time-lock state; let both finish before going on.
    await act(async () => {
      fireEvent.click(menuItem("Refresh"));
    });
    await waitFor(() => expect(calls("list_directory").length).toBe(listings + 1));
    await loaded();
    await runMenu("secret.txt", "Copy");
    await openBackgroundMenu();
    expect(menuItem("Paste Here")).toBeInTheDocument();
  });

  it("pastes a copy into the current folder and keeps the clipboard", async () => {
    setup();
    await loaded();
    await copyThenPasteHere("secret.txt", "Copy");
    await waitFor(() =>
      expect(calls("paste_items")).toEqual([
        { sources: [SECRET], destDir: HOME, isCut: false },
      ]),
    );
    await waitFor(() => expect(statusBar()).toHaveTextContent("1 item(s) copied"));
  });

  it("pastes a cut and then empties the clipboard", async () => {
    setup();
    await loaded();
    await copyThenPasteHere("secret.txt", "Cut");
    await waitFor(() => expect(calls("paste_items")[0].isCut).toBe(true));
    await waitFor(() => expect(statusBar()).not.toHaveTextContent("cut"));
  });

  it("pastes into the folder that is open now, not the one it was copied from", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Copy");
    fireEvent.doubleClick(screen.getByText("sub"));
    await loaded("inner.txt");
    await openBackgroundMenu();
    fireEvent.click(menuItem("Paste Here"));
    await waitFor(() => expect(calls("paste_items")[0].destDir).toBe(SUB));
  });

  it("lists the items that could not be pasted", async () => {
    handlers.paste_items = () => [fail("secret.txt", "Access denied")];
    setup();
    await loaded();
    await copyThenPasteHere("secret.txt", "Copy");
    const msg = await screen.findByText(/Paste failed/);
    expect(msg).toHaveTextContent("• secret.txt: Access denied");
  });

  it("shows an error when the paste command itself fails, and keeps the clipboard", async () => {
    handlers.paste_items = () => {
      throw "backend down";
    };
    setup();
    await loaded();
    await copyThenPasteHere("secret.txt", "Cut");
    await screen.findByText("backend down");
    expect(statusBar()).toHaveTextContent("1 item(s) cut");
  });

  it("Escape empties the clipboard and the selection", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Copy");
    expect(statusBar()).toHaveTextContent("1 item(s) copied");
    pressKey("Escape");
    expect(statusBar()).not.toHaveTextContent("copied");
    expect(statusBar()).toHaveTextContent("No selection");
  });
});

// ─── Deleting ────────────────────────────────────────────────────────────────

describe("FilesView - deleting", () => {
  it("moves the selection to the trash and refreshes", async () => {
    setup();
    await loaded();
    await select("secret.txt", "vault.qre");
    pressKey("Delete");
    await screen.findByText("Delete Items");
    expect(screen.getByText("2 items")).toBeInTheDocument();
    const before = listedPaths().length;
    fireEvent.click(screen.getByText("Move to Trash"));

    await waitFor(() => expect(calls("trash_items")).toEqual([{ paths: [SECRET, VAULT] }]));
    expect(calls("delete_items")).toHaveLength(0);
    await waitFor(() => expect(listedPaths().length).toBeGreaterThan(before));
    await waitFor(() => expect(statusBar()).toHaveTextContent("No selection"));
    expect(screen.queryByText("Delete Items")).not.toBeInTheDocument();
  });

  it("shreds when asked to", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", "Delete");
    await screen.findByText("Delete Item");
    fireEvent.click(screen.getByText(/Shred/));
    await waitFor(() => expect(calls("delete_items")).toEqual([{ paths: [SECRET] }]));
    expect(calls("trash_items")).toHaveLength(0);
  });

  it("Cancel deletes nothing", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    pressKey("Delete");
    await screen.findByText("Delete Item");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Delete Item")).not.toBeInTheDocument();
    expect(calls("trash_items")).toHaveLength(0);
    expect(calls("delete_items")).toHaveLength(0);
  });

  it("lists items that could not be deleted", async () => {
    handlers.trash_items = () => [fail("secret.txt", "In use")];
    setup();
    await loaded();
    await runMenu("secret.txt", "Delete");
    fireEvent.click(await screen.findByText("Move to Trash"));
    const msg = await screen.findByText(/Errors occurred/);
    expect(msg).toHaveTextContent("• secret.txt: In use");
  });

  it("shows an error when the delete command fails and keeps the selection", async () => {
    handlers.trash_items = () => {
      throw "trash unavailable";
    };
    setup();
    await loaded();
    await runMenu("secret.txt", "Delete");
    fireEvent.click(await screen.findByText("Move to Trash"));
    await screen.findByText("trash unavailable");
    expect(statusBar()).toHaveTextContent("1 selected");
  });
});

// ─── Keyboard ────────────────────────────────────────────────────────────────

describe("FilesView - keyboard shortcuts", () => {
  it("Ctrl+A and Cmd+A select everything", async () => {
    setup();
    await loaded();
    pressKey("a", { ctrlKey: true });
    expect(statusBar()).toHaveTextContent("3 selected");
    pressKey("Escape");
    pressKey("a", { metaKey: true });
    expect(statusBar()).toHaveTextContent("3 selected");
  });

  it("Delete opens the delete dialog only when something is selected", async () => {
    setup();
    await loaded();
    pressKey("Delete");
    expect(screen.queryByText("Delete Item")).not.toBeInTheDocument();
    await select("secret.txt");
    pressKey("Delete");
    expect(await screen.findByText("Delete Item")).toBeInTheDocument();
  });

  it("Escape clears the selection", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    pressKey("Escape");
    expect(statusBar()).toHaveTextContent("No selection");
  });

  it("Backspace goes up a folder", async () => {
    setup();
    await loaded();
    pressKey("Backspace");
    await waitFor(() => expect(listedPaths()).toContain("C:\\Users"));
  });

  it("Enter opens a selected folder but not a selected file", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    pressKey("Enter");
    expect(listedPaths()).not.toContain(SUB);

    await select("sub");
    pressKey("Enter");
    await loaded("inner.txt");
    expect(listedPaths()).toContain(SUB);
  });

  it("Enter does nothing with several items selected", async () => {
    setup();
    await loaded();
    await select("sub", "secret.txt");
    pressKey("Enter");
    expect(listedPaths()).not.toContain(SUB);
  });

  it("ignores keys typed into a text field", async () => {
    setup();
    await loaded();
    const stray = document.createElement("input");
    document.body.appendChild(stray);
    pressKey("a", { ctrlKey: true }, stray);
    expect(statusBar()).toHaveTextContent("No selection");
    pressKey("Backspace", {}, stray);
    expect(listedPaths()).not.toContain("C:\\Users");
    stray.remove();
  });

  it("ignores shortcuts while a dialog is open", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    pressKey("Delete");
    await screen.findByText("Delete Item");
    pressKey("a", { ctrlKey: true });
    pressKey("Escape");
    expect(statusBar()).toHaveTextContent("1 selected");
  });

  it("ignores shortcuts while the context menu is open", async () => {
    setup();
    await loaded();
    rightClick("secret.txt");
    pressKey("a", { ctrlKey: true });
    expect(statusBar()).toHaveTextContent("1 selected");
  });

  it("does not go up a folder while an error dialog is showing", async () => {
    // Backspace is the "go up" key; pressing it to dismiss or correct something must not
    // silently navigate away behind the dialog.
    jest.spyOn(console, "error").mockImplementation(() => {});
    handlers.lock_file = () => {
      throw "backend exploded";
    };
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(toolbarLock());
    await screen.findByText("backend exploded");
    pressKey("Backspace");
    expect(listedPaths()).not.toContain("C:\\Users");
  });

  it("does not go up a folder while the access-denied dialog is showing", async () => {
    setup();
    await loaded();
    fireEvent.click(document.querySelector(".breadcrumbs")!);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "C:\\Windows" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("System Protection Active");
    pressKey("Backspace");
    expect(listedPaths()).not.toContain("C:\\Users");
  });

  it("stops listening for keys after it is closed", async () => {
    const { unmount } = setup();
    await loaded();
    unmount();
    const before = listedPaths().length;
    pressKey("Backspace");
    expect(listedPaths()).toHaveLength(before);
  });
});

// ─── Time-lock badges and dialog ─────────────────────────────────────────────

describe("FilesView - time-lock badges", () => {
  const future = () => Math.floor(Date.now() / 1000) + 2 * 86400 + 3600;

  it("marks only files that are still locked", async () => {
    listings[HOME] = [listedFile("a.qre"), listedFile("b.qre"), listedFile("c.txt")];
    handlers.get_file_timelock_status = (a) =>
      a.qrePath.endsWith("a.qre")
        ? { is_locked: true, locked_until: future() }
        : { is_locked: false, locked_until: 0 };
    setup();
    await loaded("a.qre");
    await waitFor(() => expect(row("a.qre")).toHaveTextContent("🔒"));
    expect(row("a.qre")).toHaveTextContent("2d 1h");
    expect(row("b.qre")).not.toHaveTextContent("🔒");
    expect(row("c.txt")).not.toHaveTextContent("🔒");
  });

  it("asks only about .qre files, not folders or other files", async () => {
    listings[HOME] = [listedDir("x.qre"), listedFile("a.qre"), listedFile("c.txt")];
    setup();
    await loaded("a.qre");
    await waitFor(() => expect(calls("get_file_timelock_status")).toHaveLength(1));
    expect(calls("get_file_timelock_status")[0]).toEqual({ qrePath: `${HOME}\\a.qre` });
  });

  it("does not ask when the folder has no .qre files", async () => {
    setup();
    await loaded("secret.txt");
    await waitFor(() => expect(calls("get_file_timelock_status")).toHaveLength(1));
    // Only vault.qre from the default listing.
    expect(calls("get_file_timelock_status")[0].qrePath).toBe(VAULT);

    fireEvent.doubleClick(screen.getByText("sub"));
    await loaded("inner.txt");
    expect(calls("get_file_timelock_status")).toHaveLength(1);
  });

  it("skips a file whose status cannot be read and still marks the others", async () => {
    listings[HOME] = [listedFile("a.qre"), listedFile("b.qre")];
    handlers.get_file_timelock_status = (a) => {
      if (a.qrePath.endsWith("a.qre")) throw "corrupt header";
      return { is_locked: true, locked_until: future() };
    };
    setup();
    await loaded("a.qre");
    await waitFor(() => expect(row("b.qre")).toHaveTextContent("🔒"));
    expect(row("a.qre")).not.toHaveTextContent("🔒");
  });

  it("clears the badges after moving to a folder without .qre files", async () => {
    listings[HOME] = [listedDir("sub"), listedFile("a.qre")];
    handlers.get_file_timelock_status = () => ({ is_locked: true, locked_until: future() });
    setup();
    await loaded("a.qre");
    await waitFor(() => expect(row("a.qre")).toHaveTextContent("🔒"));
    fireEvent.doubleClick(screen.getByText("sub"));
    await loaded("inner.txt");
    fireEvent.click(screen.getByTitle("Up One Directory"));
    await loaded("a.qre");
    await waitFor(() => expect(row("a.qre")).toHaveTextContent("🔒"));
  });

  it("ignores a slow answer for a folder the user already left", async () => {
    listings[HOME] = [listedDir("sub"), listedFile("a.qre")];
    listings[SUB] = [listedFile("b.qre", SUB)];
    const slow = deferred<{ is_locked: boolean; locked_until: number }>();
    handlers.get_file_timelock_status = (a) =>
      a.qrePath.endsWith("a.qre")
        ? slow.promise
        : { is_locked: true, locked_until: future() };
    setup();
    await loaded("a.qre");
    await waitFor(() => expect(calls("get_file_timelock_status")).toHaveLength(1));

    fireEvent.doubleClick(screen.getByText("sub"));
    await loaded("b.qre");
    await waitFor(() => expect(row("b.qre")).toHaveTextContent("🔒"));

    // The answer for the old folder arrives last. It must not wipe the new folder's badge.
    await act(async () => {
      slow.resolve({ is_locked: false, locked_until: 0 });
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(row("b.qre")).toHaveTextContent("🔒");
  });
});

describe("FilesView - time-lock dialog", () => {
  it("opens from the menu for the clicked file", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", /Time-Lock/);
    expect(await screen.findByText("Time-Lock Encryption")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
  });

  it("is not offered for a .qre file", async () => {
    setup();
    await loaded();
    rightClick("vault.qre");
    expect(screen.queryByText(/Time-Lock/)).not.toBeInTheDocument();
  });

  it("closes with Cancel", async () => {
    setup();
    await loaded();
    await runMenu("secret.txt", /Time-Lock/);
    await screen.findByText("Time-Lock Encryption");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Time-Lock Encryption")).not.toBeInTheDocument();
  });
});

// ─── Corrupted file-browser scope ────────────────────────────────────────────

describe("FilesView - corrupted file-browser scope", () => {
  const GLOB = "invalid glob pattern: unmatched [";

  beforeEach(() => {
    listings[HOME] = new Error(GLOB);
  });

  it("explains the problem and offers a restart", async () => {
    setup();
    await screen.findByText("File Browser Needs a Restart");
    expect(screen.getByText("Restart App")).toBeInTheDocument();
    // The raw error is not repeated in the status bar behind the dialog.
    expect(statusBar()).not.toHaveTextContent("invalid glob pattern");
  });

  it("Restart App restarts the app", async () => {
    setup();
    fireEvent.click(await screen.findByText("Restart App"));
    await waitFor(() => expect(mockRelaunch).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Restarting…")).toBeInTheDocument();
  });

  it("lets the user try again if the restart fails", async () => {
    mockRelaunch.mockRejectedValue(new Error("nope"));
    setup();
    fireEvent.click(await screen.findByText("Restart App"));
    await waitFor(() => expect(screen.getByText("Restart App")).toBeEnabled());
    expect(screen.queryByText("Restarting…")).not.toBeInTheDocument();
  });

  it("on Android gives manual steps and never tries to relaunch", async () => {
    mockPlatform.mockReturnValue("android");
    listings[ANDROID_HOME] = new Error(GLOB);
    setup();
    await screen.findByText("File Browser Needs a Restart");
    expect(screen.queryByText("Restart App")).not.toBeInTheDocument();
    expect(screen.getByText(/needs a manual restart/)).toBeInTheDocument();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("Dismiss leaves a reminder instead of an empty list, and it can be reopened", async () => {
    setup();
    fireEvent.click(await screen.findByText("Dismiss for now"));
    expect(screen.queryByText("File Browser Needs a Restart")).not.toBeInTheDocument();
    expect(screen.getByText("File browsing is still stuck")).toBeInTheDocument();
    expect(screen.getByText("Restart the app to fix this.")).toBeInTheDocument();
    expect(document.querySelector(".file-view")).toBeNull();

    fireEvent.click(screen.getByText("Show details again"));
    expect(screen.getByText("File Browser Needs a Restart")).toBeInTheDocument();
    expect(document.querySelector(".file-view")).not.toBeNull();
  });

  it("tells Android users to force-close the app", async () => {
    mockPlatform.mockReturnValue("android");
    listings[ANDROID_HOME] = new Error(GLOB);
    setup();
    fireEvent.click(await screen.findByText("Dismiss for now"));
    expect(screen.getByText(/Force-close the app/)).toBeInTheDocument();
  });
});

// ─── Places, selection bar and details ───────────────────────────────────────

describe("FilesView - places", () => {
  const rail = () => screen.queryByRole("navigation", { name: "Places" });

  it("lists the usual folders beside the files", async () => {
    setup();
    await loaded();
    const places = await screen.findByRole("navigation", { name: "Places" });
    expect(within(places).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Home",
      "Desktop",
      "Documents",
      "Downloads",
    ]);
  });

  it("opens a place when it is pressed", async () => {
    setup();
    await loaded();
    const places = await screen.findByRole("navigation", { name: "Places" });
    fireEvent.click(within(places).getByRole("button", { name: "Documents" }));
    await waitFor(() => expect(listedPaths()).toContain("/documents"));
  });

  it("marks Home while the home folder is open", async () => {
    setup();
    await loaded();
    const places = await screen.findByRole("navigation", { name: "Places" });
    expect(within(places).getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });

  it("has no list of places on a phone", async () => {
    mockPlatform.mockReturnValue("android");
    listings[ANDROID_HOME] = listings[HOME];
    setup();
    await loaded();
    expect(rail()).not.toBeInTheDocument();
  });
});

describe("FilesView - selection bar", () => {
  const bar = () => screen.queryByRole("region", { name: "Selection" });

  it("is not shown while nothing is selected", async () => {
    setup();
    await loaded();
    expect(bar()).not.toBeInTheDocument();
  });

  it("names a single selected item", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    expect(bar()).toHaveTextContent("Selected: secret.txt");
  });

  it("counts several selected items and adds up their size", async () => {
    setup();
    await loaded();
    await select("secret.txt", "vault.qre");
    expect(bar()).toHaveTextContent("2 items selected, ");
  });

  it("asks before deleting the selection", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete Item")).toBeInTheDocument();
  });

  it("clears the selection and goes away", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Clear selection" }));
    expect(statusBar()).toHaveTextContent("No selection");
    expect(bar()).not.toBeInTheDocument();
  });
});

describe("FilesView - details panel", () => {
  const panel = () => screen.queryByRole("complementary", { name: "Details" });
  const toggle = () =>
    fireEvent.click(within(screen.getByRole("region", { name: "Selection" })).getByRole("button", { name: "Details" }));

  it("is closed until asked for", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    expect(panel()).not.toBeInTheDocument();
  });

  it("describes the selected file when opened", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    toggle();
    expect(within(panel()!).getByText("secret.txt")).toBeInTheDocument();
    expect(within(panel()!).getByText("Type")).toBeInTheDocument();
    expect(within(panel()!).getByText(HOME)).toBeInTheDocument();
  });

  it("follows the selection", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    toggle();
    fireEvent.click(screen.getByText("vault.qre"));
    expect(within(panel()!).getByText("QRE encrypted file")).toBeInTheDocument();
  });

  it("closes with its own button and with the Details button again", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    toggle();
    fireEvent.click(within(panel()!).getByRole("button", { name: "Close details" }));
    expect(panel()).not.toBeInTheDocument();
    toggle();
    expect(panel()).toBeInTheDocument();
    toggle();
    expect(panel()).not.toBeInTheDocument();
  });

  it("stays open, asking for a selection, when the selection is cleared", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    toggle();
    pressKey("Escape");
    expect(within(panel()!).getByText("Select a file or folder to see its details.")).toBeInTheDocument();
  });
});

describe("FilesView - drop hint", () => {
  it("tells what a drop does, as a status message", async () => {
    setup();
    await loaded();
    await waitFor(() => expect(windowEvents["tauri://drag-enter"]).toBeDefined());
    act(() => windowEvents["tauri://drag-enter"]({}));
    const hint = screen.getByRole("status");
    expect(hint).toHaveTextContent("Drop to Lock");
    expect(hint).toHaveTextContent("Dropped files are encrypted with your current settings.");
  });
});

describe("FilesView - verify after locking", () => {
  const optionsMenu = () => fireEvent.click(advancedButton());
  const verifyItem = () => screen.getByRole("menuitemcheckbox", { name: /Verify After Locking/ });

  it("asks the backend to check the new file by default", async () => {
    setup();
    await loaded();
    await select("secret.txt");
    fireEvent.click(toolbarLock());
    await waitFor(() => expect(calls("lock_file")).toHaveLength(1));
    expect(calls("lock_file")[0].verifyAfter).toBe(true);
  });

  it("turns the check off from the options menu, and sends that", async () => {
    setup();
    await loaded();
    optionsMenu();
    expect(verifyItem()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(verifyItem());
    expect(verifyItem()).toHaveAttribute("aria-checked", "false");
    await select("secret.txt");
    fireEvent.click(toolbarLock());
    await waitFor(() => expect(calls("lock_file")).toHaveLength(1));
    expect(calls("lock_file")[0].verifyAfter).toBe(false);
  });

  it("also tells the time-lock command", async () => {
    handlers.lock_file_with_timelock = () => ({ name: "secret.txt", success: true, message: "Time-locked for 1 hour and verified" });
    setup();
    await loaded();
    await runMenu("secret.txt", /Time-Lock/);
    fireEvent.click(await screen.findByText("1 Hour"));
    fireEvent.click(screen.getByRole("button", { name: /Lock File/ }));
    await waitFor(() => expect(calls("lock_file_with_timelock")).toHaveLength(1));
    expect(calls("lock_file_with_timelock")[0].verifyAfter).toBe(true);
  });
});

// ─── Upgrading locked files made by older versions ───────────────────────────

describe("FilesView - upgrading older locked files", () => {
  const OLD_A = `${HOME}\\old-a.qre`;
  const OLD_B = `${HOME}\\sub\\old-b.qre`;
  const oldFile = (path: string) => ({ path, name: path.split("\\").pop(), version: 6, locked_until: null });
  const openUpgrade = async () => {
    fireEvent.click(advancedButton());
    fireEvent.click(await screen.findByText("Upgrade Older Locked Files…"));
  };

  beforeEach(() => {
    handlers.find_old_format_files = () => [oldFile(OLD_A), oldFile(OLD_B)];
    handlers.relock_file = (a) =>
      (a.filePaths as string[]).map((p) => ({ name: p.split("\\").pop(), success: true, message: "Upgraded to the current format" }));
  });

  it("is in the options menu and scans the folder that is open", async () => {
    setup();
    await loaded();
    await openUpgrade();
    expect(await screen.findByText("2 locked files")).toBeInTheDocument();
    expect(calls("find_old_format_files")).toEqual([{ folder: HOME, recursive: true }]);
  });

  it("scans the folder the user has moved into", async () => {
    setup();
    await loaded();
    fireEvent.doubleClick(screen.getByText("sub"));
    await loaded("inner.txt");
    await openUpgrade();
    await screen.findByText("2 locked files");
    expect(calls("find_old_format_files")[0].folder).toBe(SUB);
  });

  it("upgrades the files it found, then shows the result and refreshes the list", async () => {
    setup();
    await loaded();
    await openUpgrade();
    await screen.findByText("2 locked files");
    const listingsBefore = listedPaths().length;

    fireEvent.click(screen.getByRole("button", { name: "Upgrade 2 files" }));

    expect(await screen.findByText(/2 files were upgraded to the current format/)).toBeInTheDocument();
    expect(calls("relock_file")).toHaveLength(1);
    expect(calls("relock_file")[0].filePaths).toEqual([OLD_A, OLD_B]);
    expect(listedPaths().length).toBeGreaterThan(listingsBefore);
  });

  it("sends the selected key file with the request", async () => {
    mockOpenDialog.mockResolvedValue("C:\\keys\\mine.key");
    setup();
    await loaded();
    fireEvent.click(advancedButton());
    fireEvent.click(await screen.findByText("Select Keyfile"));
    await waitFor(() => expect(mockOpenDialog).toHaveBeenCalled());
    await openUpgrade();
    await screen.findByText("2 locked files");
    expect(screen.getByText(/The key file you selected will be used/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Upgrade 2 files" }));
    await screen.findByText(/were upgraded/);
    expect(calls("relock_file")[0].keyfilePath).toBe("C:\\keys\\mine.key");
  });

  it("sends no key file when none was chosen", async () => {
    setup();
    await loaded();
    await openUpgrade();
    await screen.findByText("2 locked files");
    fireEvent.click(screen.getByRole("button", { name: "Upgrade 2 files" }));
    await screen.findByText(/were upgraded/);
    expect(calls("relock_file")[0].keyfilePath).toBeNull();
    expect(calls("relock_file")[0].keyfileBytes).toBeNull();
  });

  it("lists the files that could not be upgraded and why", async () => {
    handlers.relock_file = (a) =>
      (a.filePaths as string[]).map((_p, i) =>
        i === 0
          ? { name: "old-a.qre", success: false, message: "Decryption Denied. If it was locked with a key file, select that key file and try again." }
          : { name: "old-b.qre", success: true, message: "Upgraded to the current format" },
      );
    setup();
    await loaded();
    await openUpgrade();
    await screen.findByText("2 locked files");
    fireEvent.click(screen.getByRole("button", { name: "Upgrade 2 files" }));
    expect(await screen.findByText(/old-a\.qre: Decryption Denied/)).toBeInTheDocument();
    expect(screen.getByText(/1 file was upgraded/)).toBeInTheDocument();
  });

  it("says so when there is nothing to upgrade, and never calls the upgrade", async () => {
    handlers.find_old_format_files = () => [];
    setup();
    await loaded();
    await openUpgrade();
    expect(await screen.findByText(/No locked files in an older format were found here/)).toBeInTheDocument();
    expect(calls("relock_file")).toHaveLength(0);
  });

  it("closes without doing anything on Cancel", async () => {
    setup();
    await loaded();
    await openUpgrade();
    await screen.findByText("2 locked files");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("2 locked files")).not.toBeInTheDocument();
    expect(calls("relock_file")).toHaveLength(0);
  });

  it("shows the working overlay on top of the dialog while the upgrade runs", async () => {
    const run = deferred<unknown>();
    handlers.relock_file = () => run.promise;
    setup();
    await loaded();
    await openUpgrade();
    await screen.findByText("2 locked files");
    fireEvent.click(screen.getByRole("button", { name: "Upgrade 2 files" }));
    await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
    await act(async () => progressHandler?.({ payload: { status: "Upgrading: old-a.qre", percentage: 20 } }));
    expect(screen.getByText("Upgrading: old-a.qre")).toBeInTheDocument();
    await act(async () => run.resolve([ok("old-a.qre"), ok("old-b.qre")]));
  });
});

// ─── Upgrading one file from the menu, and upgrading when unlocking ──────────

// The format of each .qre file arrives a moment after the listing. Wait for it before acting.
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

describe("FilesView - the format of each locked file", () => {
  const OLD = `${HOME}\\old.qre`;
  const OLD2 = `${HOME}\\old2.qre`;
  const NEW = `${HOME}\\new.qre`;
  let formats: Record<string, number>;

  beforeEach(() => {
    formats = { [OLD]: 6, [OLD2]: 7, [NEW]: 8 };
    listings[HOME] = [listedFile("secret.txt"), listedFile("old.qre"), listedFile("old2.qre"), listedFile("new.qre")];
    handlers.get_file_timelock_status = (a) => ({ is_locked: false, locked_until: 0, format_version: formats[a.qrePath] ?? 0 });
    handlers.relock_file = (a) =>
      (a.filePaths as string[]).map((p) => {
        formats[p] = 8; // what the backend does, so the next listing shows the new format
        return { name: p.split("\\").pop(), success: true, message: "Upgraded to the current format" };
      });
  });

  const upgradeItem = () => screen.queryByText("Upgrade Format");

  describe("the menu entry", () => {
    it.each([
      ["old.qre", true],
      ["old2.qre", true],
      ["new.qre", false],
      ["secret.txt", false],
    ])("%s: offers Upgrade Format = %s", async (name, offered) => {
      setup();
      await loaded(name);
      await waitFor(() => expect(calls("get_file_timelock_status").length).toBeGreaterThan(0));
      await settle();
      rightClick(name);
      if (offered) expect(upgradeItem()).toBeInTheDocument();
      else expect(upgradeItem()).not.toBeInTheDocument();
    });

    it("treats only versions 5, 6 and 7 as old", async () => {
      formats = { [OLD]: 5, [OLD2]: 4, [NEW]: 0 };
      setup();
      await loaded("old.qre");
      await settle();
      rightClick("old.qre");
      expect(upgradeItem()).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.click(document.querySelector(".modal-overlay") as HTMLElement);
      rightClick("old2.qre");
      expect(upgradeItem()).not.toBeInTheDocument();
    });

    it("does not offer it when the status could not be read", async () => {
      handlers.get_file_timelock_status = () => {
        throw new Error("unreadable");
      };
      setup();
      await loaded("old.qre");
      await settle();
      rightClick("old.qre");
      expect(upgradeItem()).not.toBeInTheDocument();
    });
  });

  describe("upgrading from the menu", () => {
    async function openMenuOn(name: string) {
      setup();
      await loaded(name);
      await settle();
      rightClick(name);
    }

    it("upgrades that one file and refreshes the folder", async () => {
      await openMenuOn("old.qre");
      const before = listedPaths().length;
      fireEvent.click(screen.getByText("Upgrade Format"));
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].filePaths).toEqual([OLD]);
      expect(calls("unlock_file")).toHaveLength(0);
      await waitFor(() => expect(listedPaths().length).toBeGreaterThan(before));
    });

    it("stops offering it once the file is in the current format", async () => {
      await openMenuOn("old.qre");
      fireEvent.click(screen.getByText("Upgrade Format"));
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      await settle();
      // Not inside waitFor: a right-click changes the page, and waitFor re-runs on every change.
      rightClick("old.qre");
      expect(upgradeItem()).not.toBeInTheDocument();
    });

    it("upgrades the old files of a selection and leaves the others out", async () => {
      setup();
      await loaded("old.qre");
      await settle();
      await select("old.qre", "old2.qre", "new.qre");
      rightClick("old.qre");
      fireEvent.click(screen.getByText("Upgrade Format"));
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].filePaths).toEqual([OLD, OLD2]);
    });

    it("sends no key file when none was chosen", async () => {
      await openMenuOn("old.qre");
      fireEvent.click(screen.getByText("Upgrade Format"));
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].keyfilePath).toBeNull();
    });

    it("sends the selected key file", async () => {
      mockOpenDialog.mockResolvedValue("C:\\keys\\mine.key");
      setup();
      await loaded("old.qre");
      await settle();
      fireEvent.click(advancedButton());
      fireEvent.click(await screen.findByText("Select Keyfile"));
      await waitFor(() => expect(mockOpenDialog).toHaveBeenCalled());
      fireEvent.click(document.body);
      rightClick("old.qre");
      fireEvent.click(screen.getByText("Upgrade Format"));
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].keyfilePath).toBe("C:\\keys\\mine.key");
    });

    it("shows why a file could not be upgraded", async () => {
      handlers.relock_file = () => [fail("old.qre", "Local Vault is locked.")];
      await openMenuOn("old.qre");
      fireEvent.click(screen.getByText("Upgrade Format"));
      const msg = await screen.findByText(/Upgrade failed for some items/);
      expect(msg).toHaveTextContent("old.qre: Local Vault is locked.");
    });

    it("does not call the backend when nothing in the selection is old", async () => {
      // Right-clicking an old file while a new one is the only thing selected targets the old file.
      setup();
      await loaded("new.qre");
      await settle();
      await select("new.qre");
      rightClick("old.qre");
      fireEvent.click(screen.getByText("Upgrade Format"));
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].filePaths).toEqual([OLD]);
    });
  });

  describe("upgrading when unlocking", () => {
    const unlockSelected = async (...names: string[]) => {
      await select(...names);
      fireEvent.click(toolbarUnlock());
    };
    const order = () => mockInvoke.mock.calls.map(([c]) => c).filter((c) => c === "unlock_file" || c === "relock_file");

    async function ready(on: boolean) {
      if (on) localStorage.setItem("qre_upgrade_when_unlocking", "1");
      setup();
      await loaded("old.qre");
      await settle();
    }

    it("is off by default: unlocking an old file changes nothing else", async () => {
      await ready(false);
      await unlockSelected("old.qre");
      await waitFor(() => expect(calls("unlock_file")).toHaveLength(1));
      await settle();
      expect(calls("relock_file")).toHaveLength(0);
    });

    it("when on, upgrades the locked copy after it unlocked, in that order", async () => {
      await ready(true);
      await unlockSelected("old.qre");
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].filePaths).toEqual([OLD]);
      expect(order()).toEqual(["unlock_file", "relock_file"]);
    });

    it("leaves a file that is already current alone", async () => {
      await ready(true);
      await unlockSelected("new.qre");
      await waitFor(() => expect(calls("unlock_file")).toHaveLength(1));
      await settle();
      expect(calls("relock_file")).toHaveLength(0);
    });

    it("upgrades only the old files of a mixed selection", async () => {
      await ready(true);
      await unlockSelected("old.qre", "new.qre", "old2.qre");
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].filePaths).toEqual([OLD, OLD2]);
    });

    it("never upgrades a file that did not unlock", async () => {
      handlers.unlock_file = (a) =>
        (a.filePaths as string[]).map((p) => (p === OLD ? fail("old.qre", "Wrong password") : ok(p.split("\\").pop() as string)));
      await ready(true);
      await unlockSelected("old.qre", "old2.qre");
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].filePaths).toEqual([OLD2]);
      expect(await screen.findByText(/old.qre: Wrong password/)).toBeInTheDocument();
    });

    it("does not start an upgrade for a time-locked file that stayed locked", async () => {
      handlers.unlock_file = () => [fail("old.qre", "TIME_LOCKED:1893456000:Locked for 3 days")];
      await ready(true);
      await unlockSelected("old.qre");
      await screen.findByText(/Locked for 3 days/);
      expect(calls("relock_file")).toHaveLength(0);
    });

    it("shows unlock problems and upgrade problems together", async () => {
      handlers.unlock_file = (a) =>
        (a.filePaths as string[]).map((p) => (p === OLD ? fail("old.qre", "Wrong password") : ok(p.split("\\").pop() as string)));
      handlers.relock_file = () => [fail("old2.qre", "Could not replace the old file.")];
      await ready(true);
      await unlockSelected("old.qre", "old2.qre");
      const msg = await screen.findByText(/Upgrade failed for some items/);
      expect(msg).toHaveTextContent("old.qre: Wrong password");
      expect(msg).toHaveTextContent("old2.qre: Could not replace the old file.");
    });

    it("does not report an upgrade as a problem when it works", async () => {
      await ready(true);
      await unlockSelected("old.qre");
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      await settle();
      expect(screen.queryByText(/Upgrade failed/)).not.toBeInTheDocument();
      expect(screen.queryByText("Error")).not.toBeInTheDocument();
    });

    it("sends the same key file to the upgrade as to the unlock", async () => {
      mockOpenDialog.mockResolvedValue("C:\\keys\\mine.key");
      await ready(true);
      fireEvent.click(advancedButton());
      fireEvent.click(await screen.findByText("Select Keyfile"));
      await waitFor(() => expect(mockOpenDialog).toHaveBeenCalled());
      fireEvent.click(document.body);
      await unlockSelected("old.qre");
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("unlock_file")[0].keyfilePath).toBe("C:\\keys\\mine.key");
      expect(calls("relock_file")[0].keyfilePath).toBe("C:\\keys\\mine.key");
    });

    it("also works when a file is dropped on the window to unlock it", async () => {
      await ready(true);
      await waitFor(() => expect(windowEvents["tauri://drag-drop"]).toBeDefined());
      await act(async () => windowEvents["tauri://drag-drop"]({ payload: { paths: [OLD] } }));
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].filePaths).toEqual([OLD]);
    });

    it("is switched on and off in the options menu, and remembered", async () => {
      await ready(false);
      fireEvent.click(advancedButton());
      const item = () => screen.getByRole("menuitemcheckbox", { name: /Upgrade Older Files When Unlocking/ });
      expect(item()).toHaveAttribute("aria-checked", "false");
      fireEvent.click(item());
      expect(localStorage.getItem("qre_upgrade_when_unlocking")).toBe("1");
      expect(item()).toHaveAttribute("aria-checked", "true");

      fireEvent.click(item());
      expect(localStorage.getItem("qre_upgrade_when_unlocking")).toBe("0");
      expect(item()).toHaveAttribute("aria-checked", "false");
    });

    it("takes effect on the very next unlock after it is switched on", async () => {
      await ready(false);
      fireEvent.click(advancedButton());
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Upgrade Older Files When Unlocking/ }));
      fireEvent.click(document.body);
      await unlockSelected("old.qre");
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
    });
  });

  describe("upgrading after extracting from a USB drive", () => {
    const SEALED = "e:\\usb\\sealed.qre";

    beforeEach(() => {
      listings[HOME] = [{ name: "sealed.qre", is_directory: false, path: SEALED, size: 100, modified: null }];
      formats[SEALED] = 6;
    });

    async function extract(on: boolean) {
      if (on) localStorage.setItem("qre_upgrade_when_unlocking", "1");
      setup([drive("E:\\usb\\")]);
      await loaded("sealed.qre");
      await settle();
      await select("sealed.qre");
      fireEvent.click(toolbarUnlock());
      await screen.findByText("Extract Files");
      fireEvent.click(within(extractDialog()).getByText("Desktop"));
      await waitFor(() => expect(calls("unlock_file")).toHaveLength(1));
    }

    it("upgrades the file on the drive when the setting is on", async () => {
      await extract(true);
      await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
      expect(calls("relock_file")[0].filePaths).toEqual([SEALED]);
    });

    it("does nothing extra when the setting is off", async () => {
      await extract(false);
      await settle();
      expect(calls("relock_file")).toHaveLength(0);
    });

    it("reports an unlock problem and an upgrade problem together", async () => {
      handlers.unlock_file = () => [ok("sealed.qre")];
      handlers.relock_file = () => [fail("sealed.qre", "Could not replace the old file.")];
      await extract(true);
      expect(await screen.findByText(/sealed.qre: Could not replace the old file./)).toBeInTheDocument();
    });
  });
});

describe("FilesView - telling the user an upgrade worked", () => {
  const OLD = `${HOME}\\old.qre`;
  const OLD2 = `${HOME}\\old2.qre`;

  beforeEach(() => {
    listings[HOME] = [listedFile("secret.txt"), listedFile("old.qre"), listedFile("old2.qre")];
    handlers.get_file_timelock_status = (a) => ({ is_locked: false, locked_until: 0, format_version: a.qrePath === OLD || a.qrePath === OLD2 ? 6 : 8 });
    handlers.relock_file = (a) =>
      (a.filePaths as string[]).map((p) => ({ name: p.split("\\").pop(), success: true, message: "Upgraded to the current format" }));
  });

  function setupWithToasts() {
    const props = {
      onShowBackupReminder: jest.fn(),
      portable: { drives: [] as PortableDriveState[], isScanning: false, scanDrives: jest.fn(), lockVault: jest.fn() },
      onInitDrive: jest.fn(),
      onUnlockDrive: jest.fn(),
    };
    return render(
      <ToastProvider>
        <FilesView {...props} />
      </ToastProvider>,
    );
  }

  it("says so after one file is upgraded from the menu", async () => {
    setupWithToasts();
    await loaded("old.qre");
    await settle();
    rightClick("old.qre");
    fireEvent.click(screen.getByText("Upgrade Format"));
    const toast = (await screen.findByText("Upgraded 1 file to the current format.")).closest(".ui-toast");
    expect(toast).toHaveClass("ui-toast--success");
  });

  it("gives the number when several files are upgraded", async () => {
    setupWithToasts();
    await loaded("old.qre");
    await settle();
    await select("old.qre", "old2.qre");
    rightClick("old.qre");
    fireEvent.click(screen.getByText("Upgrade Format"));
    expect(await screen.findByText("Upgraded 2 files to the current format.")).toBeInTheDocument();
  });

  it("says so after the upgrade that follows an unlock", async () => {
    localStorage.setItem("qre_upgrade_when_unlocking", "1");
    setupWithToasts();
    await loaded("old.qre");
    await settle();
    await select("old.qre");
    fireEvent.click(toolbarUnlock());
    expect(await screen.findByText("Upgraded 1 file to the current format.")).toBeInTheDocument();
  });

  it("says nothing of success when nothing was upgraded", async () => {
    handlers.relock_file = () => [fail("old.qre", "Local Vault is locked.")];
    setupWithToasts();
    await loaded("old.qre");
    await settle();
    rightClick("old.qre");
    fireEvent.click(screen.getByText("Upgrade Format"));
    await screen.findByText(/Upgrade failed for some items/);
    expect(screen.queryByText(/Upgraded \d+ files? to the current format/)).not.toBeInTheDocument();
  });

  it("does not call a file that was already current a success", async () => {
    handlers.relock_file = () => [{ name: "old.qre", success: true, message: "Already in the current format" }];
    setupWithToasts();
    await loaded("old.qre");
    await settle();
    rightClick("old.qre");
    fireEvent.click(screen.getByText("Upgrade Format"));
    await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
    await settle();
    expect(screen.queryByText(/Upgraded \d+ files? to the current format/)).not.toBeInTheDocument();
  });
});

describe("FilesView - the format badge in the details panel", () => {
  const panel = () => screen.getByRole("complementary", { name: "Details" });
  const toggle = () =>
    fireEvent.click(within(screen.getByRole("region", { name: "Selection" })).getByRole("button", { name: "Details" }));
  const OLD = `${HOME}\\old.qre`;
  const NEW = `${HOME}\\new.qre`;
  let formats: Record<string, number>;

  beforeEach(() => {
    formats = { [OLD]: 6, [NEW]: 8, [`${HOME}\\old2.qre`]: 7 };
    listings[HOME] = [listedFile("secret.txt"), listedFile("old.qre"), listedFile("old2.qre"), listedFile("new.qre")];
    handlers.get_file_timelock_status = (a) => ({ is_locked: false, locked_until: 0, format_version: formats[a.qrePath] ?? 0 });
  });

  it("marks a file made by an older version, with its version number", async () => {
    setup();
    await loaded("old.qre");
    await settle();
    await select("old.qre");
    toggle();
    expect(within(panel()).getByText("Older format (version 6)")).toHaveClass("ui-badge--warn");
    expect(within(panel()).getByText(/Right-click it and choose Upgrade Format/)).toBeInTheDocument();
  });

  it("marks a current file as current", async () => {
    setup();
    await loaded("new.qre");
    await settle();
    await select("new.qre");
    toggle();
    expect(within(panel()).getByText("Current format")).toHaveClass("ui-badge--ok");
  });

  it("follows the selection from an old file to a current one", async () => {
    setup();
    await loaded("old.qre");
    await settle();
    await select("old.qre");
    toggle();
    expect(within(panel()).getByText("Older format (version 6)")).toBeInTheDocument();
    fireEvent.click(screen.getByText("new.qre"));
    expect(within(panel()).queryByText(/Older format/)).not.toBeInTheDocument();
    expect(within(panel()).getByText("Current format")).toBeInTheDocument();
  });

  it("shows no format for a plain file", async () => {
    setup();
    await loaded("old.qre");
    await settle();
    await select("secret.txt");
    toggle();
    expect(within(panel()).queryByText("Format")).not.toBeInTheDocument();
  });

  it("counts the older files when several are selected", async () => {
    setup();
    await loaded("old.qre");
    await settle();
    await select("old.qre", "old2.qre", "new.qre");
    toggle();
    expect(within(panel()).getByText("2 files")).toHaveClass("ui-badge--warn");
  });

  it("shows nothing about the format until the version has arrived", async () => {
    const answer = deferred<unknown>();
    handlers.get_file_timelock_status = () => answer.promise;
    setup();
    await loaded("old.qre");
    await select("old.qre");
    toggle();
    expect(within(panel()).queryByText("Format")).not.toBeInTheDocument();
    await act(async () => answer.resolve({ is_locked: false, locked_until: 0, format_version: 6 }));
    expect(await within(panel()).findByText("Older format (version 6)")).toBeInTheDocument();
  });

  it("updates after the file is upgraded", async () => {
    handlers.relock_file = (a) =>
      (a.filePaths as string[]).map((p) => {
        formats[p] = 8;
        return { name: p.split("\\").pop(), success: true, message: "Upgraded to the current format" };
      });
    setup();
    await loaded("old.qre");
    await settle();
    await select("old.qre");
    toggle();
    expect(within(panel()).getByText("Older format (version 6)")).toBeInTheDocument();

    // The name is in the list and in the panel; the list comes first.
    fireEvent.contextMenu(screen.getAllByText("old.qre")[0]);
    fireEvent.click(screen.getByText("Upgrade Format"));
    await waitFor(() => expect(calls("relock_file")).toHaveLength(1));
    // Reloading the folder clears the selection, so pick the file again: its format has been re-read.
    await settle();
    fireEvent.click(screen.getByText("old.qre"));
    expect(await within(panel()).findByText("Current format")).toBeInTheDocument();
    expect(within(panel()).queryByText(/Older format/)).not.toBeInTheDocument();
  });
});

// ─── Cancelling a job that is running ────────────────────────────────────────

describe("FilesView - cancelling a lock, unlock or upgrade", () => {
  const cancelCalls = () => calls("cancel_operation");
  const cancelled = (name: string) => ({ name, success: false, message: "Cancelled." });
  const notStarted = (n: number) => ({ name: n === 1 ? "1 more file" : `${n} more files`, success: false, message: "Cancelled. Not started." });
  const overlay = () => screen.queryByRole("dialog", { name: "Processing" });
  const cancelButton = () => within(overlay()!).getByRole("button", { name: "Cancel" });
  const escape = () => fireEvent.keyDown(window, { key: "Escape" });

  function renderWithToasts() {
    const props = {
      onShowBackupReminder: jest.fn(),
      portable: { drives: [] as PortableDriveState[], isScanning: false, scanDrives: jest.fn(), lockVault: jest.fn() },
      onInitDrive: jest.fn(),
      onUnlockDrive: jest.fn(),
    };
    render(
      <ToastProvider>
        <FilesView {...props} />
      </ToastProvider>,
    );
    return props;
  }

  async function startLock(names: string[] = ["secret.txt"]) {
    const run = deferred<unknown>();
    handlers.lock_file = () => run.promise;
    const props = renderWithToasts();
    await loaded();
    await select(...names);
    fireEvent.click(toolbarLock());
    await waitFor(() => expect(overlay()).toBeInTheDocument());
    return { run, props };
  }

  describe("the overlay", () => {
    it("offers Cancel while a lock runs, and says Esc does the same", async () => {
      await startLock();
      expect(cancelButton()).toBeEnabled();
      expect(within(overlay()!).getByText(/Or press Esc/)).toBeInTheDocument();
    });

    it("Cancel asks the backend to stop, once, and the overlay says it is stopping", async () => {
      const { run } = await startLock();
      fireEvent.click(cancelButton());
      await waitFor(() => expect(cancelCalls()).toHaveLength(1));
      expect(await within(overlay()!).findByRole("heading", { name: "Cancelling..." })).toBeInTheDocument();
      expect(within(overlay()!).getByRole("button", { name: "Stopping..." })).toBeDisabled();
      await act(async () => run.resolve([cancelled("secret.txt")]));
    });

    it("Escape does the same as the button", async () => {
      const { run } = await startLock();
      escape();
      await waitFor(() => expect(cancelCalls()).toHaveLength(1));
      escape();
      await act(async () => {});
      expect(cancelCalls()).toHaveLength(1);
      await act(async () => run.resolve([cancelled("secret.txt")]));
    });

    it("goes away when the job has stopped, and a new job can be started and cancelled", async () => {
      const { run } = await startLock();
      escape();
      await act(async () => run.resolve([cancelled("secret.txt")]));
      await waitFor(() => expect(overlay()).not.toBeInTheDocument());

      const second = deferred<unknown>();
      handlers.lock_file = () => second.promise;
      // The folder reload that follows a job clears the selection, so pick the file again.
      await select("secret.txt");
      fireEvent.click(toolbarLock());
      await waitFor(() => expect(overlay()).toBeInTheDocument());
      expect(within(overlay()!).queryByRole("heading", { name: "Cancelling..." })).not.toBeInTheDocument();
      escape();
      await waitFor(() => expect(cancelCalls()).toHaveLength(2));
      await act(async () => second.resolve([cancelled("secret.txt")]));
    });

    it("Escape with nothing running asks for nothing", async () => {
      renderWithToasts();
      await loaded();
      escape();
      await act(async () => {});
      expect(cancelCalls()).toHaveLength(0);
    });

    it("shows no Cancel for progress that is not a lock, unlock or upgrade", async () => {
      renderWithToasts();
      await loaded();
      await act(async () => progressHandler?.({ payload: { status: "Deleting: old.txt", percentage: 40 } }));
      expect(overlay()).toBeInTheDocument();
      expect(within(overlay()!).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      escape();
      await act(async () => {});
      expect(cancelCalls()).toHaveLength(0);
    });
  });

  describe("after a lock was cancelled", () => {
    it("says so and does not call it a failure or ask for a backup", async () => {
      const { run, props } = await startLock();
      escape();
      await act(async () => run.resolve([cancelled("secret.txt")]));
      expect(await screen.findByText("Cancelled. Nothing was changed.")).toBeInTheDocument();
      expect(screen.queryByText(/Locking failed/)).not.toBeInTheDocument();
      expect(screen.queryByText("Error")).not.toBeInTheDocument();
      expect(props.onShowBackupReminder).not.toHaveBeenCalled();
    });

    it("says how many files were finished before the stop", async () => {
      const { run } = await startLock(["secret.txt", "vault.qre"]);
      escape();
      await act(async () => run.resolve([ok("secret.txt"), cancelled("vault.qre"), notStarted(2)]));
      expect(
        await screen.findByText("Cancelled. 1 file was locked before you stopped. The rest were left as they were."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Locking failed/)).not.toBeInTheDocument();
    });

    it("still reports a real failure, without the cancelled lines", async () => {
      const { run } = await startLock(["secret.txt", "vault.qre"]);
      escape();
      await act(async () => run.resolve([fail("secret.txt", "Local Vault is locked."), cancelled("vault.qre"), notStarted(1)]));
      const msg = await screen.findByText(/Locking failed for some items/);
      expect(msg).toHaveTextContent("secret.txt: Local Vault is locked.");
      expect(msg).not.toHaveTextContent("Cancelled");
      expect(msg).not.toHaveTextContent("more file");
    });

    it("refreshes the folder so the finished files show", async () => {
      const { run } = await startLock();
      const before = listedPaths().length;
      escape();
      await act(async () => run.resolve([cancelled("secret.txt")]));
      await waitFor(() => expect(listedPaths().length).toBeGreaterThan(before));
    });

    it("a lock that finished normally still asks for a backup", async () => {
      const { run, props } = await startLock();
      await act(async () => run.resolve([ok("secret.txt")]));
      await waitFor(() => expect(props.onShowBackupReminder).toHaveBeenCalledTimes(1));
    });
  });

  describe("after an unlock was cancelled", () => {
    const OLD = `${HOME}\\old.qre`;

    async function startUnlock(autoUpgrade: boolean) {
      if (autoUpgrade) localStorage.setItem("qre_upgrade_when_unlocking", "1");
      listings[HOME] = [listedFile("secret.txt"), listedFile("old.qre")];
      handlers.get_file_timelock_status = (a) => ({ is_locked: false, locked_until: 0, format_version: a.qrePath === OLD ? 6 : 0 });
      const run = deferred<unknown>();
      handlers.unlock_file = () => run.promise;
      renderWithToasts();
      await loaded("old.qre");
      await settle();
      await select("old.qre");
      fireEvent.click(toolbarUnlock());
      await waitFor(() => expect(overlay()).toBeInTheDocument());
      return run;
    }

    it("says so, and does not call it an unlock failure", async () => {
      const run = await startUnlock(false);
      escape();
      await act(async () => run.resolve([cancelled("old.qre")]));
      expect(await screen.findByText("Cancelled. Nothing was changed.")).toBeInTheDocument();
      expect(screen.queryByText(/Unlock failed/)).not.toBeInTheDocument();
      expect(screen.queryByText("Error")).not.toBeInTheDocument();
    });

    it("does not start the automatic upgrade after the user stopped the unlock", async () => {
      const run = await startUnlock(true);
      escape();
      await act(async () => run.resolve([ok("old.qre"), cancelled("old.qre")].slice(1)));
      await screen.findByText("Cancelled. Nothing was changed.");
      await act(async () => {});
      expect(calls("relock_file")).toHaveLength(0);
    });

    it("counts a file that was unlocked before the stop, and does not upgrade after the stop", async () => {
      const run = await startUnlock(true);
      escape();
      await act(async () => run.resolve([ok("old.qre"), notStarted(1)]));
      expect(
        await screen.findByText("Cancelled. 1 file was unlocked before you stopped. The rest were left as they were."),
      ).toBeInTheDocument();
      expect(calls("relock_file")).toHaveLength(0);
    });

    it("still shows a real unlock failure next to the stop", async () => {
      const run = await startUnlock(false);
      escape();
      await act(async () => run.resolve([fail("old.qre", "Wrong password"), notStarted(1)]));
      const msg = await screen.findByText(/Unlock failed/);
      expect(msg).toHaveTextContent("old.qre: Wrong password");
      expect(msg).not.toHaveTextContent("Cancelled");
    });
  });

  describe("after an upgrade was cancelled", () => {
    const OLD = `${HOME}\\old.qre`;

    async function startUpgrade() {
      listings[HOME] = [listedFile("secret.txt"), listedFile("old.qre")];
      handlers.get_file_timelock_status = (a) => ({ is_locked: false, locked_until: 0, format_version: a.qrePath === OLD ? 6 : 0 });
      const run = deferred<unknown>();
      handlers.relock_file = () => run.promise;
      renderWithToasts();
      await loaded("old.qre");
      await settle();
      rightClick("old.qre");
      fireEvent.click(screen.getByText("Upgrade Format"));
      await waitFor(() => expect(overlay()).toBeInTheDocument());
      return run;
    }

    it("says so and shows no failure", async () => {
      const run = await startUpgrade();
      escape();
      await waitFor(() => expect(cancelCalls()).toHaveLength(1));
      await act(async () =>
        run.resolve([{ name: "old.qre", success: false, message: "Cancelled. The old file was not changed." }]),
      );
      expect(await screen.findByText("Cancelled. Nothing was changed.")).toBeInTheDocument();
      expect(screen.queryByText(/Upgrade failed/)).not.toBeInTheDocument();
    });

    it("says how many were upgraded before the stop", async () => {
      const run = await startUpgrade();
      escape();
      await act(async () =>
        run.resolve([{ name: "a.qre", success: true, message: "Upgraded to the current format" }, cancelled("old.qre")]),
      );
      expect(
        await screen.findByText("Cancelled. 1 file was upgraded before you stopped. The rest were left as they were."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Upgraded 1 file to the current format/)).not.toBeInTheDocument();
    });
  });

  describe("an unlock to a chosen folder (USB vault)", () => {
    it("says so when it was stopped, and does not start the automatic upgrade", async () => {
      localStorage.setItem("qre_upgrade_when_unlocking", "1");
      listings[HOME] = [{ name: "sealed.qre", is_directory: false, path: "e:\\usb\\sealed.qre", size: 100, modified: null }];
      handlers.get_file_timelock_status = () => ({ is_locked: false, locked_until: 0, format_version: 6 });
      const run = deferred<unknown>();
      handlers.unlock_file = () => run.promise;
      render(
        <ToastProvider>
          <FilesView
            onShowBackupReminder={jest.fn()}
            portable={{ drives: [drive("E:\\usb\\")], isScanning: false, scanDrives: jest.fn(), lockVault: jest.fn() }}
            onInitDrive={jest.fn()}
            onUnlockDrive={jest.fn()}
          />
        </ToastProvider>,
      );
      await loaded("sealed.qre");
      await settle();
      await select("sealed.qre");
      fireEvent.click(toolbarUnlock());
      await screen.findByText("Extract Files");
      fireEvent.click(within(extractDialog()).getByText("Desktop"));
      await waitFor(() => expect(overlay()).toBeInTheDocument());
      escape();
      await act(async () => run.resolve([cancelled("sealed.qre")]));
      expect(await screen.findByText("Cancelled. Nothing was changed.")).toBeInTheDocument();
      expect(screen.queryByText(/Unlock failed/)).not.toBeInTheDocument();
      expect(calls("relock_file")).toHaveLength(0);
    });
  });
});

// ─── Copy and paste with other programs ──────────────────────────────────────

describe("FilesView - the system clipboard", () => {
  const OTHER = "D:\\from explorer\\photo.jpg";
  const OTHER2 = "D:\\from explorer\\notes.txt";
  const NOT_SUPPORTED = "Copying files to the system clipboard is not supported on this system.";
  let osClip: { supported: boolean; paths: string[]; cut: boolean };
  const emptyClip = () => ({ supported: true, paths: [] as string[], cut: false });

  /** A Windows-like clipboard: what the app sets is what it reads back, and another program can replace it. */
  function windowsClipboard() {
    osClip = emptyClip();
    handlers.set_clipboard_files = (a) => {
      osClip = { supported: true, paths: a.paths, cut: a.cut };
      return null;
    };
    handlers.get_clipboard_files = () => osClip;
    handlers.clear_clipboard_files = () => {
      osClip = emptyClip();
      return null;
    };
  }

  /** What the other systems do: the calls say "not supported" and the screen keeps its own list. */
  function noSystemClipboard() {
    handlers.set_clipboard_files = () => {
      throw NOT_SUPPORTED;
    };
    handlers.get_clipboard_files = () => ({ supported: false, paths: [], cut: false });
  }

  function renderWithToasts() {
    render(
      <ToastProvider>
        <FilesView
          onShowBackupReminder={jest.fn()}
          portable={{ drives: [], isScanning: false, scanDrives: jest.fn(), lockVault: jest.fn() }}
          onInitDrive={jest.fn()}
          onUnlockDrive={jest.fn()}
        />
      </ToastProvider>,
    );
  }

  // A shortcut can start async work (the copy goes on to the system clipboard), so it runs in act.
  const ctrl = async (key: string, init: KeyboardEventInit = {}) => {
    await act(async () => {
      pressKey(key, { ctrlKey: true, ...init });
    });
  };
  const pasteCalls = () => calls("paste_items");

  beforeEach(() => windowsClipboard());

  describe("copying and cutting", () => {
    it("Copy in the menu puts the file on the system clipboard", async () => {
      setup();
      await loaded();
      await runMenu("secret.txt", "Copy");
      await waitFor(() => expect(calls("set_clipboard_files")).toEqual([{ paths: [SECRET], cut: false }]));
    });

    it("Cut in the menu puts the whole selection there, marked as a cut", async () => {
      setup();
      await loaded();
      await select("secret.txt", "vault.qre");
      await runMenu("vault.qre", "Cut");
      await waitFor(() => expect(calls("set_clipboard_files")).toEqual([{ paths: [SECRET, VAULT], cut: true }]));
    });

    it("Ctrl+C copies the selection", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await waitFor(() => expect(calls("set_clipboard_files")).toEqual([{ paths: [SECRET], cut: false }]));
      expect(statusBar()).toHaveTextContent("1 item(s) copied");
    });

    it("Ctrl+X cuts the selection", async () => {
      setup();
      await loaded();
      await select("secret.txt", "vault.qre");
      await ctrl("x");
      await waitFor(() => expect(calls("set_clipboard_files")).toEqual([{ paths: [SECRET, VAULT], cut: true }]));
      expect(statusBar()).toHaveTextContent("2 item(s) cut");
    });

    it("Cmd+C works the same on a Mac, and capital letters count (Caps Lock)", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      pressKey("c", { metaKey: true });
      await waitFor(() => expect(calls("set_clipboard_files")).toHaveLength(1));
      pressKey("C", { ctrlKey: true });
      await waitFor(() => expect(calls("set_clipboard_files")).toHaveLength(2));
    });

    it("Ctrl+C with nothing selected does nothing", async () => {
      setup();
      await loaded();
      await ctrl("c");
      await ctrl("x");
      await act(async () => {});
      expect(calls("set_clipboard_files")).toHaveLength(0);
      expect(statusBar()).not.toHaveTextContent("copied");
    });

    it("leaves Ctrl+C alone when the user has marked text on the page", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      jest.spyOn(window, "getSelection").mockReturnValue({ toString: () => "marked words" } as unknown as Selection);
      const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      await act(async () => {});
      expect(calls("set_clipboard_files")).toHaveLength(0);
      expect(event.defaultPrevented).toBe(false);
    });

    it("leaves Ctrl+C, X and V to a text box", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      const box = document.createElement("input");
      document.body.appendChild(box);
      for (const key of ["c", "x", "v"]) pressKey(key, { ctrlKey: true }, box);
      await act(async () => {});
      box.remove();
      expect(calls("set_clipboard_files")).toHaveLength(0);
      expect(calls("get_clipboard_files")).toHaveLength(0);
    });

    it("ignores other combinations such as Ctrl+Shift+C and Ctrl+Alt+V", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c", { shiftKey: true });
      await ctrl("v", { altKey: true });
      await act(async () => {});
      expect(calls("set_clipboard_files")).toHaveLength(0);
      expect(calls("get_clipboard_files")).toHaveLength(0);
    });

    it("ignores the shortcuts while a menu or a dialog is open", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      rightClick("secret.txt");
      await ctrl("c");
      await ctrl("v");
      await act(async () => {});
      expect(calls("set_clipboard_files")).toHaveLength(0);
      expect(pasteCalls()).toHaveLength(0);
    });

    it("tells the user when the file reached only the list inside QRE", async () => {
      handlers.set_clipboard_files = () => {
        throw "The clipboard is in use by another program. Try again.";
      };
      renderWithToasts();
      await loaded();
      await runMenu("secret.txt", "Copy");
      expect(await screen.findByText(/Copied inside QRE only/)).toHaveTextContent("in use by another program");
      expect(statusBar()).toHaveTextContent("1 item(s) copied");
    });

    it("says nothing extra where the system clipboard is simply not supported", async () => {
      noSystemClipboard();
      renderWithToasts();
      await loaded();
      await runMenu("secret.txt", "Copy");
      await act(async () => {});
      expect(screen.queryByText(/Copied inside QRE only/)).not.toBeInTheDocument();
      expect(statusBar()).toHaveTextContent("1 item(s) copied");
    });
  });

  describe("pasting what QRE copied", () => {
    it("Ctrl+V pastes the copied file into the open folder", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await waitFor(() => expect(calls("set_clipboard_files")).toHaveLength(1));
      fireEvent.doubleClick(screen.getByText("sub"));
      await loaded("inner.txt");
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()).toEqual([{ sources: [SECRET], destDir: SUB, isCut: false }]));
    });

    it("a copy stays on the clipboard after pasting, a cut does not", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await waitFor(() => expect(calls("set_clipboard_files")).toHaveLength(1));
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()).toHaveLength(1));
      await act(async () => {});
      expect(calls("clear_clipboard_files")).toHaveLength(0);
      expect(osClip.paths).toEqual([SECRET]);

      await loaded();
      await select("secret.txt");
      await ctrl("x");
      await waitFor(() => expect(osClip.cut).toBe(true));
      await ctrl("v");
      await waitFor(() => expect(calls("clear_clipboard_files")).toHaveLength(1));
      expect(osClip.paths).toEqual([]);
      await waitFor(() => expect(statusBar()).not.toHaveTextContent("cut"));
    });

    it("a cut that failed to paste stays on both clipboards", async () => {
      handlers.paste_items = () => {
        throw "backend down";
      };
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("x");
      await waitFor(() => expect(calls("set_clipboard_files")).toHaveLength(1));
      await ctrl("v");
      await screen.findByText("backend down");
      expect(calls("clear_clipboard_files")).toHaveLength(0);
      expect(osClip.paths).toEqual([SECRET]);
      expect(statusBar()).toHaveTextContent("1 item(s) cut");
    });

    it("a second Ctrl+V while the first paste runs does not paste twice", async () => {
      const run = deferred<unknown>();
      handlers.paste_items = () => run.promise;
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await waitFor(() => expect(calls("set_clipboard_files")).toHaveLength(1));
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()).toHaveLength(1));
      await ctrl("v");
      await act(async () => {});
      expect(pasteCalls()).toHaveLength(1);
      await act(async () => run.resolve([ok(SECRET)]));
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()).toHaveLength(2));
    });

    it("Paste Here in the menu does the same as Ctrl+V", async () => {
      setup();
      await loaded();
      await runMenu("secret.txt", "Copy");
      await waitFor(() => expect(calls("set_clipboard_files")).toHaveLength(1));
      await openBackgroundMenu();
      fireEvent.click(await within(document.querySelector(".dropdown-menu") as HTMLElement).findByText("Paste Here"));
      await waitFor(() => expect(pasteCalls()).toEqual([{ sources: [SECRET], destDir: HOME, isCut: false }]));
    });

    it("Escape drops the copy on the system clipboard too", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await waitFor(() => expect(osClip.paths).toEqual([SECRET]));
      pressKey("Escape");
      await waitFor(() => expect(osClip.paths).toEqual([]));
      expect(statusBar()).not.toHaveTextContent("copied");
    });

    it("Escape does not touch the system clipboard when QRE never put anything there", async () => {
      setup();
      await loaded();
      osClip = { supported: true, paths: [OTHER], cut: false };
      pressKey("Escape");
      await act(async () => {});
      expect(calls("clear_clipboard_files")).toHaveLength(0);
      expect(osClip.paths).toEqual([OTHER]);
    });
  });

  describe("pasting what another program copied", () => {
    it("Ctrl+V pastes files copied in Explorer", async () => {
      setup();
      await loaded();
      osClip = { supported: true, paths: [OTHER, OTHER2], cut: false };
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()).toEqual([{ sources: [OTHER, OTHER2], destDir: HOME, isCut: false }]));
    });

    it("moves them when they were cut in Explorer, and empties the clipboard after", async () => {
      setup();
      await loaded();
      osClip = { supported: true, paths: [OTHER], cut: true };
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()).toEqual([{ sources: [OTHER], destDir: HOME, isCut: true }]));
      await waitFor(() => expect(calls("clear_clipboard_files")).toHaveLength(1));
    });

    it("pastes what Explorer copied last, not what QRE copied before", async () => {
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await waitFor(() => expect(osClip.paths).toEqual([SECRET]));
      osClip = { supported: true, paths: [OTHER], cut: false };
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()[0].sources).toEqual([OTHER]));
    });

    it("says so when the clipboard holds no files (the user copied text since)", async () => {
      renderWithToasts();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await waitFor(() => expect(osClip.paths).toEqual([SECRET]));
      osClip = emptyClip();
      await ctrl("v");
      expect(await screen.findByText("There are no copied files to paste.")).toBeInTheDocument();
      expect(pasteCalls()).toHaveLength(0);
      expect(statusBar()).not.toHaveTextContent("copied");
    });

    it("says so when nothing was ever copied", async () => {
      renderWithToasts();
      await loaded();
      await ctrl("v");
      expect(await screen.findByText("There are no copied files to paste.")).toBeInTheDocument();
      expect(pasteCalls()).toHaveLength(0);
    });

    it("offers Paste Here for files copied in another program", async () => {
      setup();
      await loaded();
      osClip = { supported: true, paths: [OTHER], cut: false };
      await openBackgroundMenu();
      expect(await within(document.querySelector(".dropdown-menu") as HTMLElement).findByText("Paste Here")).toBeInTheDocument();
      fireEvent.click(menuItem("Paste Here"));
      await waitFor(() => expect(pasteCalls()[0].sources).toEqual([OTHER]));
    });

    it("offers no Paste Here when the clipboard holds no files", async () => {
      setup();
      await loaded();
      await openBackgroundMenu();
      await waitFor(() => expect(calls("get_clipboard_files")).toHaveLength(1));
      await act(async () => {});
      expect(screen.queryByText("Paste Here")).not.toBeInTheDocument();
    });

    it("offers no Paste Here when asking the clipboard fails", async () => {
      handlers.get_clipboard_files = () => {
        throw "The clipboard is in use by another program. Try again.";
      };
      setup();
      await loaded();
      await openBackgroundMenu();
      await waitFor(() => expect(calls("get_clipboard_files")).toHaveLength(1));
      await act(async () => {});
      expect(screen.queryByText("Paste Here")).not.toBeInTheDocument();
    });
  });

  describe("when the system clipboard cannot be used", () => {
    it("Copy and paste still work inside QRE", async () => {
      noSystemClipboard();
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await act(async () => {});
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()).toEqual([{ sources: [SECRET], destDir: HOME, isCut: false }]));
    });

    it("a cut is moved and the list is emptied", async () => {
      noSystemClipboard();
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("x");
      await act(async () => {});
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()[0].isCut).toBe(true));
      await waitFor(() => expect(statusBar()).not.toHaveTextContent("cut"));
    });

    it("a copy that never reached the system clipboard is still pasted, even though it reports no files", async () => {
      handlers.set_clipboard_files = () => {
        throw "Could not put the files on the clipboard.";
      };
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await act(async () => {});
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()).toEqual([{ sources: [SECRET], destDir: HOME, isCut: false }]));
    });

    it("falls back to the list inside QRE when reading the clipboard fails", async () => {
      handlers.get_clipboard_files = () => {
        throw "The clipboard is in use by another program. Try again.";
      };
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await waitFor(() => expect(calls("set_clipboard_files")).toHaveLength(1));
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()[0].sources).toEqual([SECRET]));
    });

    it("an old backend that knows none of these commands still gets the list inside QRE", async () => {
      // The fake backend answers null to commands it has no handler for.
      delete handlers.set_clipboard_files;
      delete handlers.get_clipboard_files;
      delete handlers.clear_clipboard_files;
      setup();
      await loaded();
      await select("secret.txt");
      await ctrl("c");
      await act(async () => {});
      await ctrl("v");
      await waitFor(() => expect(pasteCalls()[0].sources).toEqual([SECRET]));
    });
  });

  describe("on Android", () => {
    it("never calls the system clipboard, and copy and paste stay inside the app", async () => {
      mockPlatform.mockReturnValue("android");
      listings[ANDROID_HOME] = listings[HOME];
      setup();
      await loaded();
      await runMenu("secret.txt", "Copy");
      await openBackgroundMenu();
      fireEvent.click(menuItem("Paste Here"));
      await waitFor(() => expect(pasteCalls()).toHaveLength(1));
      expect(calls("set_clipboard_files")).toHaveLength(0);
      expect(calls("get_clipboard_files")).toHaveLength(0);
      expect(calls("clear_clipboard_files")).toHaveLength(0);
    });
  });
});
