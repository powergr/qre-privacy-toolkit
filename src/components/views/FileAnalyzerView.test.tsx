import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FileAnalyzerView } from "./FileAnalyzerView";

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockWindowListen = jest.fn();
const mockOpen = jest.fn();
const mockOpenUrl = jest.fn();
const mockPlatform = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: (...args: unknown[]) => mockWindowListen(...args) }),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));
jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

interface Result {
  path: string;
  filename: string;
  extension: string;
  real_type: string;
  risk_level: "DANGER" | "WARNING" | "SAFE";
  description: string;
}

function result(filename: string, risk: Result["risk_level"], overrides: Partial<Result> = {}): Result {
  return {
    path: `C:\\scan\\${filename}`,
    filename,
    extension: "pdf",
    real_type: "exe",
    risk_level: risk,
    description: `${filename} is suspicious`,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let scanImpl: (path: string | null) => Promise<Result[]>;
let locateFailure: string | null;
let progress: (e: { payload: string }) => void;
let windowHandlers: Record<string, (e: unknown) => void>;

function backend() {
  mockInvoke.mockImplementation((cmd: string, args: { path?: string | null }) => {
    if (cmd === "scan_directory_targets") return scanImpl(args.path ?? null);
    if (cmd === "show_in_folder") return locateFailure ? Promise.reject(locateFailure) : Promise.resolve(null);
    return Promise.resolve(null);
  });
}

async function renderAnalyzer(os = "windows") {
  mockPlatform.mockReturnValue(os);
  const utils = render(<FileAnalyzerView />);
  await waitFor(() => {
    expect(progress).toBeDefined();
    expect(windowHandlers["tauri://drag-drop"]).toBeDefined();
  });
  return utils;
}

const scans = () => mockInvoke.mock.calls.filter(([c]) => c === "scan_directory_targets");
const clickTarget = () => fireEvent.click(screen.getByRole("button", { name: /Select\s+Target/ }));
const clickSmart = () =>
  fireEvent.click(screen.getByRole("button", { name: /Or run a Smart System Scan/ }));

beforeEach(() => {
  jest.clearAllMocks();
  scanImpl = () => Promise.resolve([]);
  locateFailure = null;
  progress = undefined as unknown as typeof progress;
  windowHandlers = {};
  mockListen.mockImplementation((_e: string, handler: typeof progress) => {
    progress = handler;
    return Promise.resolve(() => {});
  });
  mockWindowListen.mockImplementation((event: string, handler: (e: unknown) => void) => {
    windowHandlers[event] = handler;
    return Promise.resolve(() => {});
  });
  mockOpenUrl.mockResolvedValue(undefined);
  backend();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("FileAnalyzerView - starting a scan on desktop", () => {
  it("offers a folder scan and a smart scan", async () => {
    await renderAnalyzer();
    expect(screen.getByText("Drag & Drop a File or Folder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Select\s+Target/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Or run a Smart System Scan/ })).toBeInTheDocument();
  });

  it("scans the folder the user picks", async () => {
    await renderAnalyzer();
    mockOpen.mockResolvedValue("C:\\Users\\me\\Downloads");
    clickTarget();
    await screen.findByText("No malicious files found");
    expect(scans()[0][1]).toEqual({ path: "C:\\Users\\me\\Downloads" });
  });

  it("does nothing if the picker is cancelled", async () => {
    await renderAnalyzer();
    mockOpen.mockResolvedValue(null);
    clickTarget();
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(scans()).toHaveLength(0);
  });

  it("reports a picker failure", async () => {
    await renderAnalyzer();
    mockOpen.mockRejectedValue("dialog crashed");
    clickTarget();
    expect(await screen.findByText(/Failed to open file dialog: .*dialog crashed/)).toBeInTheDocument();
  });

  it("runs a smart scan without a path", async () => {
    await renderAnalyzer();
    clickSmart();
    await screen.findByText("No malicious files found");
    expect(scans()[0][1]).toEqual({ path: null });
  });

  it("scans a file or folder dropped on the window", async () => {
    await renderAnalyzer();
    act(() => windowHandlers["tauri://drag-enter"]({}));
    expect(document.querySelector(".shred-zone.active")).not.toBeNull();
    act(() => windowHandlers["tauri://drag-drop"]({ payload: { paths: ["C:\\drop\\a.zip", "C:\\drop\\b.zip"] } }));

    await screen.findByText("No malicious files found");
    expect(scans()).toHaveLength(1);
    expect(scans()[0][1]).toEqual({ path: "C:\\drop\\a.zip" });
  });
});

describe("FileAnalyzerView - while scanning", () => {
  it("shows the target, the three most recent log lines, and can be cancelled", async () => {
    const pending = deferred<Result[]>();
    scanImpl = () => pending.promise;
    await renderAnalyzer();
    mockOpen.mockResolvedValue("C:\\Users\\me\\Downloads");
    clickTarget();

    expect(await screen.findByText("Deep Scanning...")).toBeInTheDocument();
    expect(screen.getByText("Downloads")).toBeInTheDocument();
    for (const line of ["one", "two", "three", "four"]) act(() => progress({ payload: line }));
    expect(screen.getByText("> four")).toBeInTheDocument();
    expect(screen.getByText("> three")).toBeInTheDocument();
    expect(screen.getByText("> two")).toBeInTheDocument();
    expect(screen.queryByText("> one")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel Scan" }));
    expect(screen.queryByText("Deep Scanning...")).not.toBeInTheDocument();
    expect(screen.getByText("Drag & Drop a File or Folder")).toBeInTheDocument();

    act(() => progress({ payload: "after cancel" }));
    await act(async () => {
      pending.resolve([result("late.pdf", "DANGER")]);
    });
    expect(screen.queryByText("late.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("Drag & Drop a File or Folder")).toBeInTheDocument();
  });

  it("names the smart scan while it runs", async () => {
    scanImpl = () => new Promise(() => {});
    await renderAnalyzer();
    clickSmart();
    expect(await screen.findByText("Smart Scan (Downloads, Documents, and Desktop)")).toBeInTheDocument();
  });

  it("ignores files dropped while a scan is already running", async () => {
    scanImpl = () => new Promise(() => {});
    await renderAnalyzer();
    clickSmart();
    await screen.findByText("Deep Scanning...");
    act(() => windowHandlers["tauri://drag-drop"]({ payload: { paths: ["C:\\second"] } }));
    expect(scans()).toHaveLength(1);
  });

  it("is not disturbed by a cancelled scan finishing after a new one started", async () => {
    const first = deferred<Result[]>();
    const second = deferred<Result[]>();
    scanImpl = (path) => (path === "/first" ? first.promise : second.promise);
    await renderAnalyzer();

    mockOpen.mockResolvedValueOnce("/first");
    clickTarget();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel Scan" }));

    mockOpen.mockResolvedValueOnce("/second");
    clickTarget();
    await waitFor(() => expect(scans()).toHaveLength(2));
    await screen.findByText("Deep Scanning...");

    await act(async () => {
      first.resolve([result("from-first.pdf", "DANGER")]);
    });
    expect(screen.queryByText("from-first.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("Deep Scanning...")).toBeInTheDocument();

    await act(async () => {
      second.resolve([result("from-second.pdf", "DANGER")]);
    });
    expect(await screen.findByText("from-second.pdf")).toBeInTheDocument();
    expect(screen.queryByText("from-first.pdf")).not.toBeInTheDocument();
  });

  it("shows a scan error and returns to the start, where it can be dismissed", async () => {
    scanImpl = () => Promise.reject("disk unreadable");
    await renderAnalyzer();
    clickSmart();

    const banner = await screen.findByText(/Scan Error: .*disk unreadable/);
    expect(screen.getByText("Drag & Drop a File or Folder")).toBeInTheDocument();
    fireEvent.click(banner.parentElement!.querySelector("button")!);
    expect(screen.queryByText(/Scan Error/)).not.toBeInTheDocument();
  });
});

describe("FileAnalyzerView - results", () => {
  const mixed = () => [
    result("zeta.pdf", "WARNING", { description: "Double extension" }),
    result("beta.doc", "DANGER", { extension: "doc", real_type: "exe", description: "Executable disguised as a document" }),
    result("alpha.png", "WARNING"),
    result("omega.txt", "DANGER"),
  ];

  async function scanWith(results: Result[]) {
    scanImpl = () => Promise.resolve(results);
    await renderAnalyzer();
    clickSmart();
    await screen.findByText("New Scan");
  }

  it("lists dangers first, then alphabetically, with counts", async () => {
    await scanWith(mixed());
    const names = Array.from(document.querySelectorAll("[title]"))
      .map((n) => n.getAttribute("title"))
      .filter((t) => t && /\.(pdf|doc|png|txt)$/.test(t));
    expect(names).toEqual(["beta.doc", "omega.txt", "alpha.png", "zeta.pdf"]);
    expect(screen.getByText(/2\s+Dangers/)).toBeInTheDocument();
    expect(screen.getByText(/2\s+Warnings/)).toBeInTheDocument();
  });

  it("shows the claimed and the real type with the explanation", async () => {
    await scanWith(mixed());
    expect(screen.getByText("Executable disguised as a document")).toBeInTheDocument();
    expect(screen.getAllByText(".exe").length).toBeGreaterThan(0);
    expect(screen.getByText(".doc")).toBeInTheDocument();
  });

  it("says so when nothing suspicious was found", async () => {
    await scanWith([]);
    expect(screen.getByText("No malicious files found")).toBeInTheDocument();
    expect(screen.queryByText("FILENAME")).not.toBeInTheDocument();
  });

  it("locates a file in the system file manager", async () => {
    await scanWith([result("beta.doc", "DANGER", { path: "C:\\scan\\beta.doc" })]);
    fireEvent.click(screen.getByRole("button", { name: "Locate" }));
    expect(mockInvoke).toHaveBeenCalledWith("show_in_folder", { path: "C:\\scan\\beta.doc" });
  });

  it("tells the user when the file manager could not be opened", async () => {
    await scanWith([result("beta.doc", "DANGER")]);
    locateFailure = "Reveal in Explorer is not supported on Android";
    fireEvent.click(screen.getByRole("button", { name: "Locate" }));
    expect(await screen.findByText(/not supported on Android/)).toBeInTheDocument();
  });

  it("opens a web search about the mismatch", async () => {
    await scanWith([result("beta.doc", "DANGER", { extension: "doc", real_type: "exe" })]);
    fireEvent.click(screen.getByTitle("Search this mismatch online"));
    const url = mockOpenUrl.mock.calls[0][0] as string;
    expect(url.startsWith("https://www.google.com/search?q=")).toBe(true);
    expect(decodeURIComponent(url.split("q=")[1])).toBe("file extension .doc detected as exe malware indicator");
  });

  it("starts over with New Scan and ignores drops while results are showing", async () => {
    await scanWith([result("beta.doc", "DANGER")]);
    act(() => windowHandlers["tauri://drag-drop"]({ payload: { paths: ["C:\\other"] } }));
    expect(scans()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /New Scan/ }));
    expect(screen.getByText("Drag & Drop a File or Folder")).toBeInTheDocument();
    expect(screen.queryByText("beta.doc")).not.toBeInTheDocument();
  });
});

describe("FileAnalyzerView - on a phone", () => {
  it("offers only the smart scan", async () => {
    await renderAnalyzer("android");
    expect(screen.getByText("Scan Your Device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Select\s+Target/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Or run a Smart System Scan/ })).not.toBeInTheDocument();
  });

  it("runs the smart scan without opening a folder picker", async () => {
    await renderAnalyzer("android");
    fireEvent.click(screen.getByRole("button", { name: /Start\s+Smart Scan/ }));
    await screen.findByText("No malicious files found");
    expect(scans()[0][1]).toEqual({ path: null });
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("does not open a folder picker when the panel itself is tapped", async () => {
    await renderAnalyzer("ios");
    fireEvent.click(screen.getByText("Scan Your Device"));
    expect(mockOpen).not.toHaveBeenCalled();
    expect(scans()).toHaveLength(0);
  });
});

describe("FileAnalyzerView - keyboard shortcuts", () => {
  it("Ctrl+O opens the folder picker", async () => {
    await renderAnalyzer();
    mockOpen.mockResolvedValue(null);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    expect(mockOpen.mock.calls[0][0]).toMatchObject({ directory: true });
  });
});
