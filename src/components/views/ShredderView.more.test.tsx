import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ShredderView } from "./ShredderView";

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockOpen = jest.fn();
const mockPlatform = jest.fn();

let mockDropCallback: ((files: string[]) => void) | undefined;
let mockIsDragging = false;

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));
jest.mock("../../hooks/useDragDrop", () => ({
  useDragDrop: (cb: (files: string[]) => void) => {
    mockDropCallback = cb;
    return { isDragging: mockIsDragging };
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Handler = (args: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
let handlers: Record<string, Handler>;
let listeners: Record<string, (e: unknown) => void>;
let unlisten: jest.Mock;

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function calls(cmd: string): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  return mockInvoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);
}

const shredResult = (over: Record<string, unknown> = {}) => ({
  success: ["/a.txt"],
  failed: [],
  total_files: 1,
  total_bytes_shredded: 2048,
  ...over,
});

const progress = (over: Record<string, unknown> = {}) => ({
  payload: {
    current_file: 1,
    total_files: 1,
    current_pass: 1,
    total_passes: 3,
    current_file_name: "a.txt",
    percentage: 40,
    bytes_processed: 1024,
    total_bytes: 2048,
    ...over,
  },
});

async function addFiles(paths: string[]) {
  mockOpen.mockResolvedValueOnce(paths);
  fireEvent.click(screen.getByText(/Select Files/i));
  await screen.findByText(paths[0].split(/[/\\]/).pop()!);
}

const clickShredFooter = async (n = 1) =>
  fireEvent.click(await screen.findByText(new RegExp(`Shred ${n} Files?`)));

async function startShred(paths = ["/a.txt"]) {
  await addFiles(paths);
  await clickShredFooter(paths.length);
  fireEvent.click(await screen.findByText("Yes, Shred Forever"));
}

const wipeBox = () => screen.getByPlaceholderText(/e\.g\. \/home/i) as HTMLInputElement;
const trimBox = () => screen.getByPlaceholderText(/e\.g\. \/ or C/i) as HTMLInputElement;
const banner = () => screen.queryByTestId("error-banner");

async function openDrive() {
  fireEvent.click(screen.getByTestId("top-tab-drive"));
  await screen.findByText("Wipe Free Space");
}

async function confirmWipe(path = "/home/user") {
  fireEvent.change(wipeBox(), { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
  fireEvent.click(await screen.findByText("Yes, Wipe Free Space"));
}

async function confirmTrim(path = "/home") {
  fireEvent.change(trimBox(), { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
  fireEvent.click(await screen.findByText("Yes, Run TRIM"));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDragging = false;
  mockDropCallback = undefined;
  mockPlatform.mockReturnValue("linux");
  listeners = {};
  unlisten = jest.fn();
  mockListen.mockImplementation((event: string, cb: (e: unknown) => void) => {
    listeners[event] = cb;
    return Promise.resolve(unlisten);
  });
  handlers = {};
  mockInvoke.mockImplementation((cmd: string, args: unknown) => {
    const h = handlers[cmd];
    return h ? Promise.resolve().then(() => h(args)) : Promise.resolve(null);
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─── Choosing files ──────────────────────────────────────────────────────────

describe("ShredderView - choosing files", () => {
  it("keeps the page header while files are chosen, and shows the drop prompt only before", async () => {
    render(<ShredderView />);
    expect(screen.getByText("Secure Shredder")).toBeInTheDocument();
    expect(screen.getByText(/Select Files/i)).toBeInTheDocument();
    await addFiles(["/a.txt"]);
    expect(screen.getByText("Secure Shredder")).toBeInTheDocument();
    expect(screen.queryByText(/Select Files/i)).not.toBeInTheDocument();
  });

  it("accepts a single path from the picker as well as a list", async () => {
    mockOpen.mockResolvedValueOnce("/only.txt");
    render(<ShredderView />);
    fireEvent.click(screen.getByText(/Select Files/i));
    expect(await screen.findByText("only.txt")).toBeInTheDocument();
  });

  it("keeps the list when the picker is cancelled", async () => {
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    mockOpen.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByText("Add More"));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
    expect(screen.getByText("a.txt")).toBeInTheDocument();
  });

  it("reports a picker that fails", async () => {
    mockOpen.mockRejectedValueOnce("no dialog");
    render(<ShredderView />);
    fireEvent.click(screen.getByText(/Select Files/i));
    await waitFor(() => expect(banner()).toHaveTextContent("Failed to open file dialog: no dialog"));
  });

  it("opens the picker when the empty drop area is clicked", async () => {
    mockOpen.mockResolvedValueOnce(null);
    render(<ShredderView />);
    fireEvent.click(screen.getByText("Drop files here or click to browse."));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
  });

  it("does not open the picker when the area is clicked while files are listed", async () => {
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText("1 File Selected"));
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it("counts the files in the right grammar", async () => {
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    expect(screen.getByText("1 File Selected")).toBeInTheDocument();
    expect(screen.getByText("Shred 1 File")).toBeInTheDocument();
    await act(async () => {
      mockDropCallback!(["/b.txt"]);
    });
    expect(screen.getByText("2 Files Selected")).toBeInTheDocument();
    expect(screen.getByText("Shred 2 Files")).toBeInTheDocument();
  });

  it("shows only the file name of a Windows path", async () => {
    render(<ShredderView />);
    await addFiles(["C:\\Users\\me\\Secret Plans.docx"]);
    expect(screen.getByText("Secret Plans.docx")).toBeInTheDocument();
  });

  it("highlights the drop area while a file is dragged over", () => {
    mockIsDragging = true;
    render(<ShredderView />);
    expect(document.querySelector(".shred-zone")).toHaveClass("active");
  });

  it("does not highlight the drop area otherwise", () => {
    render(<ShredderView />);
    expect(document.querySelector(".shred-zone")).not.toHaveClass("active");
  });

  it("deduplicates dropped files against ones already listed", async () => {
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    await act(async () => {
      mockDropCallback!(["/a.txt", "/b.txt"]);
    });
    expect(screen.getByText("2 Files Selected")).toBeInTheDocument();
  });

  it("switches to the shred tab when files are dropped on the drive tab", async () => {
    render(<ShredderView />);
    await openDrive();
    await act(async () => {
      mockDropCallback!(["/dropped.txt"]);
    });
    expect(screen.getByText("dropped.txt")).toBeInTheDocument();
  });
});

// ─── Preview ─────────────────────────────────────────────────────────────────

describe("ShredderView - preview", () => {
  const dryRun = (over: Record<string, unknown> = {}) => ({
    files: [
      { path: "/a.txt", name: "a.txt", size: 1024, is_directory: false, file_count: 1 },
      { path: "/b.txt", name: "b.txt", size: 2048, is_directory: false, file_count: 1, warning: "Read-only file" },
    ],
    total_size: 3072,
    total_file_count: 2,
    warnings: ["b.txt is read-only"],
    blocked: [],
    ...over,
  });

  it("lists the files with their sizes, totals, and per-file warnings", async () => {
    handlers.dry_run_shred = () => dryRun();
    render(<ShredderView />);
    await addFiles(["/a.txt", "/b.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    await screen.findByText("Preview: Files to be Shredded");
    expect(screen.getByText("Total Files").nextSibling).toHaveTextContent("2");
    expect(screen.getByText("Total Size").nextSibling).toHaveTextContent("3 KB");
    expect(screen.getByText("Files (2):")).toBeInTheDocument();
    expect(screen.getByText(/b.txt is read-only/)).toBeInTheDocument();
    expect(screen.getByText(/Read-only file/)).toBeInTheDocument();
  });

  it("shows no warnings box when there are none", async () => {
    handlers.dry_run_shred = () => dryRun({ warnings: [] });
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    await screen.findByText("Preview: Files to be Shredded");
    expect(screen.queryByText("Warnings:")).not.toBeInTheDocument();
  });

  it("names at most three blocked files and then says there are more", async () => {
    handlers.dry_run_shred = () =>
      dryRun({ blocked: ["/1: no", "/2: no", "/3: no", "/4: no"] });
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    await waitFor(() => expect(banner()).toHaveTextContent("4 file(s) blocked: /1: no; /2: no; /3: no…"));
    expect(banner()).not.toHaveTextContent("/4");
  });

  it("goes back to the file list, with the error, when the preview fails", async () => {
    handlers.dry_run_shred = () => {
      throw "cannot read";
    };
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    await waitFor(() => expect(banner()).toHaveTextContent("Preview failed: cannot read"));
    expect(screen.queryByText("Preview: Files to be Shredded")).not.toBeInTheDocument();
    expect(screen.getByText("a.txt")).toBeInTheDocument();
  });

  it("closes with the X and with Back", async () => {
    handlers.dry_run_shred = () => dryRun();
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    await screen.findByText("Preview: Files to be Shredded");
    fireEvent.click(document.querySelector(".icon-btn-ghost") as HTMLElement);
    expect(screen.queryByText("Preview: Files to be Shredded")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Preview"));
    await screen.findByText("Preview: Files to be Shredded");
    fireEvent.click(screen.getByText("Back"));
    expect(screen.queryByText("Preview: Files to be Shredded")).not.toBeInTheDocument();
  });

  it("goes on to the confirmation from the preview", async () => {
    handlers.dry_run_shred = () => dryRun();
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    fireEvent.click(await screen.findByText(/Confirm & Shred/));
    expect(screen.getByTestId("shred-confirm-modal")).toBeInTheDocument();
  });

  it("does not show an older preview for files that are no longer the list", async () => {
    let call = 0;
    const second = deferred<ReturnType<typeof dryRun>>();
    handlers.dry_run_shred = () => (++call === 1 ? dryRun() : second.promise);
    render(<ShredderView />);
    await addFiles(["/a.txt", "/b.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    await screen.findByText("Preview: Files to be Shredded");
    fireEvent.click(screen.getByText("Back"));

    // Change the list, then preview again; the answer for the new list is still pending.
    const row = screen.getByText("b.txt").closest("div[style]") as HTMLElement;
    const icons = row.querySelectorAll("svg");
    fireEvent.click(icons[icons.length - 1]);
    fireEvent.click(screen.getByText("Preview"));
    await waitFor(() => expect(call).toBe(2));
    expect(screen.queryByText("Files (2):")).not.toBeInTheDocument();
    expect(screen.queryByText(/Confirm & Shred/)).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(
        dryRun({ files: [dryRun().files[0]], total_file_count: 1, total_size: 1024, warnings: [] }),
      );
    });
    expect(await screen.findByText("Files (1):")).toBeInTheDocument();
  });
});

// ─── Confirming ──────────────────────────────────────────────────────────────

describe("ShredderView - confirmation", () => {
  it.each([
    ["Simple (1 pass)", "simple", "1"],
    ["DoD 3-Pass", "dod3pass", "3"],
    ["DoD 7-Pass", "dod7pass", "7"],
    ["Gutmann (35 pass)", "gutmann", "35"],
  ])("%s: names the method, the pass count and sends it", async (label, method, passes) => {
    handlers.batch_shred_files = () => shredResult();
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText(label).closest("[style]") as HTMLElement);
    await clickShredFooter();
    const modal = screen.getByTestId("shred-confirm-modal");
    expect(within(modal).getByText(new RegExp(`Using ${label.replace(/[()]/g, "\\$&")} method`))).toBeInTheDocument();
    expect(within(modal).getByText(new RegExp(`overwritten ${passes} time`))).toBeInTheDocument();
    fireEvent.click(within(modal).getByText("Yes, Shred Forever"));
    await waitFor(() => expect(calls("batch_shred_files")).toEqual([{ paths: ["/a.txt"], method }]));
  });

  it("asks about the right number of files", async () => {
    render(<ShredderView />);
    await addFiles(["/a.txt", "/b.txt"]);
    await clickShredFooter(2);
    expect(screen.getByText("Permanently destroy 2 files?")).toBeInTheDocument();
  });

  it("closes from the X, shredding nothing", async () => {
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    await clickShredFooter();
    const modal = screen.getByTestId("shred-confirm-modal");
    fireEvent.click(modal.querySelector("svg.lucide-x") as SVGElement);
    expect(screen.queryByTestId("shred-confirm-modal")).not.toBeInTheDocument();
    expect(calls("batch_shred_files")).toHaveLength(0);
    expect(screen.getByText("a.txt")).toBeInTheDocument();
  });
});

// ─── While shredding ─────────────────────────────────────────────────────────

describe("ShredderView - while shredding", () => {
  it("shows a progress card from the start, before the first progress report", async () => {
    const gate = deferred<unknown>();
    handlers.batch_shred_files = () => gate.promise;
    render(<ShredderView />);
    await startShred();
    const card = await screen.findByTestId("progress-card");
    expect(within(card).getByText("Shredding Files…")).toBeInTheDocument();
    expect(within(card).getByText("Cancel")).toBeInTheDocument();
    await act(async () => {
      gate.resolve(shredResult());
    });
  });

  it("fills in the details as progress arrives, and sizes the bar", async () => {
    const gate = deferred<unknown>();
    handlers.batch_shred_files = () => gate.promise;
    render(<ShredderView />);
    await startShred();
    await screen.findByTestId("progress-card");
    act(() => listeners["shred-progress"](progress({ percentage: 40 })));
    const card = screen.getByTestId("progress-card");
    expect(card.querySelector('div[style*="width: 40%"]')).not.toBeNull();
    expect(within(card).getByText("a.txt")).toBeInTheDocument();
    act(() => listeners["shred-progress"](progress({ percentage: 75, current_file: 2, total_files: 3 })));
    expect(screen.getByTestId("progress-counter")).toHaveTextContent("File 2 of 3");
    expect(card.querySelector('div[style*="width: 75%"]')).not.toBeNull();
    await act(async () => {
      gate.resolve(shredResult());
    });
  });

  it("disables the other tab while shredding", async () => {
    const gate = deferred<unknown>();
    handlers.batch_shred_files = () => gate.promise;
    render(<ShredderView />);
    await startShred();
    const tab = screen.getByTestId("top-tab-drive");
    expect(tab).toHaveAttribute("title", "An operation is in progress");
    fireEvent.click(tab);
    expect(screen.queryByText("Wipe Free Space")).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve(shredResult());
    });
    await waitFor(() => expect(screen.getByTestId("top-tab-drive")).not.toHaveAttribute("title"));
  });

  it("offers no way to start a second shred, and ignores files dropped meanwhile", async () => {
    const gate = deferred<unknown>();
    handlers.batch_shred_files = () => gate.promise;
    render(<ShredderView />);
    await startShred();
    await screen.findByTestId("progress-card");
    expect(screen.queryByText(/^Shred \d+ Files?$/)).not.toBeInTheDocument();
    await act(async () => {
      mockDropCallback!(["/late.txt"]);
    });
    await act(async () => {
      gate.resolve(shredResult());
    });
    await screen.findByText("Shredding Complete!");
    fireEvent.click(screen.getByText("Shred More Files"));
    expect(screen.queryByText("late.txt")).not.toBeInTheDocument();
    expect(screen.getByText("Drop files here or click to browse.")).toBeInTheDocument();
  });

  it("keeps showing progress after Cancel until the shredding really stops", async () => {
    const gate = deferred<unknown>();
    handlers.batch_shred_files = () => gate.promise;
    render(<ShredderView />);
    await startShred();
    const card = await screen.findByTestId("progress-card");
    fireEvent.click(within(card).getByText("Cancel"));
    await waitFor(() => expect(calls("cancel_shred")).toHaveLength(1));

    // The files are still being overwritten, so nothing may suggest otherwise.
    expect(screen.getByTestId("progress-card")).toBeInTheDocument();
    expect(within(card).getByText("Cancelling…")).toBeDisabled();
    expect(screen.queryByText(/^Shred \d+ Files?$/)).not.toBeInTheDocument();
    expect(screen.queryByText("Yes, Shred Forever")).not.toBeInTheDocument();

    await act(async () => {
      gate.resolve(shredResult({ success: [], total_bytes_shredded: 0 }));
    });
    await waitFor(() => expect(banner()).toHaveTextContent("Shredding cancelled by user"));
    expect(screen.queryByTestId("progress-card")).not.toBeInTheDocument();
  });

  it("does not call the next shred cancelled after one was", async () => {
    const first = deferred<unknown>();
    let call = 0;
    handlers.batch_shred_files = () => (++call === 1 ? first.promise : shredResult());
    render(<ShredderView />);
    await startShred();
    const card = await screen.findByTestId("progress-card");
    fireEvent.click(within(card).getByText("Cancel"));
    await waitFor(() => expect(calls("cancel_shred")).toHaveLength(1));
    await act(async () => {
      first.resolve(shredResult({ success: [], total_bytes_shredded: 0 }));
    });
    await waitFor(() => expect(banner()).toHaveTextContent("cancelled by user"));

    fireEvent.click(screen.getByText("Shred More Files"));
    await startShred(["/b.txt"]);
    await screen.findByText("Shredding Complete!");
    expect(banner()).toBeNull();
  });

  it("says it was cancelled, not failed, when the cancelled command reports an error", async () => {
    const gate = deferred<unknown>();
    handlers.batch_shred_files = () => gate.promise;
    render(<ShredderView />);
    await startShred();
    const card = await screen.findByTestId("progress-card");
    fireEvent.click(within(card).getByText("Cancel"));
    await waitFor(() => expect(calls("cancel_shred")).toHaveLength(1));
    await act(async () => {
      gate.reject("Operation cancelled");
    });
    await waitFor(() => expect(banner()).toHaveTextContent("Shredding cancelled by user"));
    expect(banner()).not.toHaveTextContent("Shredding failed");
  });

  it("lets the user try Cancel again if the cancel request itself failed", async () => {
    const gate = deferred<unknown>();
    handlers.batch_shred_files = () => gate.promise;
    handlers.cancel_shred = () => {
      throw "busy";
    };
    render(<ShredderView />);
    await startShred();
    const card = await screen.findByTestId("progress-card");
    fireEvent.click(within(card).getByText("Cancel"));
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    await waitFor(() => expect(within(card).getByText("Cancel")).toBeEnabled());
    await act(async () => {
      gate.resolve(shredResult());
    });
  });

  it("ignores a progress report that arrives after the shredding finished", async () => {
    handlers.batch_shred_files = () => shredResult();
    render(<ShredderView />);
    await startShred();
    await screen.findByText("Shredding Complete!");
    act(() => listeners["shred-progress"](progress()));
    expect(screen.queryByTestId("progress-card")).not.toBeInTheDocument();
  });
});

// ─── Results ─────────────────────────────────────────────────────────────────

describe("ShredderView - results", () => {
  it("shows the counts, and empties the list", async () => {
    handlers.batch_shred_files = () =>
      shredResult({ success: ["/a", "/b", "/c"], total_bytes_shredded: 3 * 1024 * 1024 });
    render(<ShredderView />);
    await startShred(["/a", "/b", "/c"]);
    await screen.findByText("Shredding Complete!");
    expect(screen.getByText("Files Destroyed").nextSibling).toHaveTextContent("3");
    expect(screen.getByText("Data Shredded").nextSibling).toHaveTextContent("3 MB");
    expect(screen.queryByText("Failed to shred", { exact: false })).not.toBeInTheDocument();
  });

  it("shows only the file name of each failure and the reason", async () => {
    handlers.batch_shred_files = () =>
      shredResult({
        success: ["/ok"],
        failed: [{ path: "C:\\docs\\locked.docx", error: "In use by another program" }],
      });
    render(<ShredderView />);
    await startShred(["/ok", "C:\\docs\\locked.docx"]);
    await screen.findByText("Partial Success");
    expect(screen.getByText("locked.docx")).toBeInTheDocument();
    expect(screen.getByText(/In use by another program/)).toBeInTheDocument();
  });

  it("lists ten failures and says how many more there are", async () => {
    const failed = Array.from({ length: 12 }, (_, i) => ({ path: `/f${i}.txt`, error: "denied" }));
    handlers.batch_shred_files = () => shredResult({ success: [], failed });
    render(<ShredderView />);
    await startShred();
    await screen.findByText("Shredding Failed");
    expect(screen.getByText("Failed to shred 12 file(s):")).toBeInTheDocument();
    expect(screen.getAllByText(/denied/)).toHaveLength(10);
    expect(screen.getByText("…and 2 more")).toBeInTheDocument();
  });

  it("does not call it complete when nothing was shredded and nothing failed", async () => {
    handlers.batch_shred_files = () => shredResult({ success: [], failed: [], total_bytes_shredded: 0 });
    render(<ShredderView />);
    await startShred();
    await screen.findByText("Nothing Was Shredded");
    expect(screen.queryByText("Shredding Complete!")).not.toBeInTheDocument();
  });

  it("shows the empty result in the warning colour", async () => {
    handlers.batch_shred_files = () => shredResult({ success: [], failed: [], total_bytes_shredded: 0 });
    render(<ShredderView />);
    await startShred();
    const title = await screen.findByText("Nothing Was Shredded");
    expect(title).toHaveStyle({ color: "#f59e0b" });
  });

  it("clears an old error when a new shred starts", async () => {
    handlers.dry_run_shred = () => {
      throw "cannot read";
    };
    handlers.batch_shred_files = () => shredResult();
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    await waitFor(() => expect(banner()).toBeInTheDocument());
    await clickShredFooter();
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));
    await screen.findByText("Shredding Complete!");
    expect(banner()).toBeNull();
  });

  it("Clear All also removes an old error and preview", async () => {
    handlers.dry_run_shred = () => {
      throw "cannot read";
    };
    render(<ShredderView />);
    await addFiles(["/a.txt"]);
    fireEvent.click(screen.getByText("Preview"));
    await waitFor(() => expect(banner()).toBeInTheDocument());
    fireEvent.click(screen.getByText("Clear All"));
    expect(banner()).toBeNull();
  });
});

// ─── Drive maintenance: free-space wipe ──────────────────────────────────────

describe("ShredderView - free-space wipe", () => {
  it.each(["/", "/etc", "/etc/", "/usr//", "/var", "/dev", "C:\\", "c:", "D:/"])(
    "refuses the system or root path %s without asking for confirmation",
    async (path) => {
      render(<ShredderView />);
      await openDrive();
      fireEvent.change(wipeBox(), { target: { value: path } });
      fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
      expect(banner()).toHaveTextContent("not supported on system drives or root paths");
      expect(screen.queryByText("Confirm Free Space Wipe")).not.toBeInTheDocument();
    },
  );

  it.each(["/home/user", "/mnt/usb", "C:\\Users\\me\\Temp", "/etc2", "/variable"])(
    "asks for confirmation for %s",
    async (path) => {
      render(<ShredderView />);
      await openDrive();
      fireEvent.change(wipeBox(), { target: { value: path } });
      fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
      expect(await screen.findByText("Confirm Free Space Wipe")).toBeInTheDocument();
      expect(banner()).toBeNull();
    },
  );

  it("treats a blank path as missing", async () => {
    render(<ShredderView />);
    await openDrive();
    fireEvent.change(wipeBox(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    expect(banner()).toHaveTextContent("Please enter a drive or folder path.");
  });

  it("sends the path without surrounding spaces", async () => {
    handlers.wipe_free_space = () => ({ bytes_wiped: 1024, target_path: "/mnt/usb" });
    render(<ShredderView />);
    await openDrive();
    await confirmWipe("  /mnt/usb  ");
    await waitFor(() => expect(calls("wipe_free_space")).toEqual([{ drivePath: "/mnt/usb" }]));
  });

  it("shows the path in the confirmation, and cancelling (button or X) wipes nothing", async () => {
    render(<ShredderView />);
    await openDrive();
    fireEvent.change(wipeBox(), { target: { value: "/mnt/usb" } });
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    await screen.findByText("Confirm Free Space Wipe");
    expect(screen.getByText("/mnt/usb", { selector: "code" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Confirm Free Space Wipe")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    const dialog = (await screen.findByText("Confirm Free Space Wipe")).closest(".auth-card") as HTMLElement;
    fireEvent.click(dialog.querySelector("svg.lucide-x") as SVGElement);
    expect(screen.queryByText("Confirm Free Space Wipe")).not.toBeInTheDocument();
    expect(calls("wipe_free_space")).toHaveLength(0);
  });

  it("shows a running state from the start, not the input form again", async () => {
    const gate = deferred<unknown>();
    handlers.wipe_free_space = () => gate.promise;
    render(<ShredderView />);
    await openDrive();
    await confirmWipe();
    await waitFor(() => expect(calls("wipe_free_space")).toHaveLength(1));
    // No second wipe may be started while the first one runs.
    expect(screen.queryByRole("button", { name: "Wipe" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByTestId("wipe-phase")).toHaveTextContent("Starting…");
    expect(screen.queryByText(/written/)).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve({ bytes_wiped: 1, target_path: "/home/user" });
    });
  });

  it("shows the phase and bytes written, and disables the other tab", async () => {
    const gate = deferred<unknown>();
    handlers.wipe_free_space = () => gate.promise;
    render(<ShredderView />);
    await openDrive();
    await confirmWipe();
    await waitFor(() => expect(calls("wipe_free_space")).toHaveLength(1));
    act(() => listeners["wipe-progress"]({ payload: { bytes_written: 3 * 1024 * 1024, phase: "Writing zeros" } }));
    expect(screen.getByTestId("wipe-phase")).toHaveTextContent("Writing zeros…");
    expect(screen.getByText("3 MB written")).toBeInTheDocument();
    expect(screen.getByTestId("top-tab-shred")).toHaveAttribute("title", "An operation is in progress");
    await act(async () => {
      gate.resolve({ bytes_wiped: 3 * 1024 * 1024, target_path: "/home/user" });
    });
  });

  it("shows the result and starts over with Run Again", async () => {
    handlers.wipe_free_space = () => ({ bytes_wiped: 2048, target_path: "/mnt/usb" });
    render(<ShredderView />);
    await openDrive();
    await confirmWipe("/mnt/usb");
    await screen.findByText("Wipe Complete");
    expect(screen.getByText("/mnt/usb", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText(/2 KB wiped/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Run Again"));
    expect(wipeBox()).toBeInTheDocument();
    expect(screen.queryByText("Wipe Complete")).not.toBeInTheDocument();
  });

  it("clears an old error when a new wipe starts", async () => {
    render(<ShredderView />);
    await openDrive();
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    expect(banner()).toBeInTheDocument();
    handlers.wipe_free_space = () => ({ bytes_wiped: 1, target_path: "/mnt/usb" });
    await confirmWipe("/mnt/usb");
    await screen.findByText("Wipe Complete");
    expect(banner()).toBeNull();
  });

  it("reports a failed wipe and dismisses the message", async () => {
    handlers.wipe_free_space = () => {
      throw "no space info";
    };
    render(<ShredderView />);
    await openDrive();
    await confirmWipe();
    await waitFor(() => expect(banner()).toHaveTextContent("Free-space wipe failed: no space info"));
    fireEvent.click(banner()!.querySelector("button") as HTMLElement);
    expect(banner()).toBeNull();
    expect(wipeBox()).toBeInTheDocument();
  });

  it("keeps showing the wipe as running after Cancel until it really stops", async () => {
    const gate = deferred<unknown>();
    handlers.wipe_free_space = () => gate.promise;
    render(<ShredderView />);
    await openDrive();
    await confirmWipe();
    await waitFor(() => expect(calls("wipe_free_space")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("cancel_shred")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Wipe" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    await act(async () => {
      gate.reject("Operation cancelled");
    });
    await waitFor(() => expect(banner()).toHaveTextContent("Wipe cancelled by user"));
    expect(banner()).not.toHaveTextContent("failed");
    expect(wipeBox()).toBeInTheDocument();
  });

  it("lets the user try Cancel again if the wipe cancel request itself failed", async () => {
    const gate = deferred<unknown>();
    handlers.wipe_free_space = () => gate.promise;
    handlers.cancel_shred = () => {
      throw "busy";
    };
    render(<ShredderView />);
    await openDrive();
    await confirmWipe();
    await waitFor(() => expect(calls("wipe_free_space")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    await act(async () => {
      gate.resolve({ bytes_wiped: 1, target_path: "/home/user" });
    });
    await screen.findByText("Wipe Complete");
  });

  it("does not call the next wipe cancelled after one was", async () => {
    const first = deferred<unknown>();
    let call = 0;
    handlers.wipe_free_space = () =>
      ++call === 1 ? first.promise : { bytes_wiped: 5, target_path: "/home/user" };
    render(<ShredderView />);
    await openDrive();
    await confirmWipe();
    await waitFor(() => expect(calls("wipe_free_space")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("cancel_shred")).toHaveLength(1));
    await act(async () => {
      first.reject("Operation cancelled");
    });
    await waitFor(() => expect(banner()).toHaveTextContent("Wipe cancelled by user"));

    await confirmWipe();
    await screen.findByText("Wipe Complete");
    expect(banner()).toBeNull();
  });

  it("does not call a cancelled wipe complete when the command still reports a result", async () => {
    const gate = deferred<unknown>();
    handlers.wipe_free_space = () => gate.promise;
    render(<ShredderView />);
    await openDrive();
    await confirmWipe();
    await waitFor(() => expect(calls("wipe_free_space")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("cancel_shred")).toHaveLength(1));
    await act(async () => {
      gate.resolve({ bytes_wiped: 1024, target_path: "/home/user" });
    });
    await waitFor(() => expect(banner()).toHaveTextContent("Wipe cancelled by user"));
    expect(screen.queryByText("Wipe Complete")).not.toBeInTheDocument();
  });

  it("keeps what was typed in both boxes when switching tabs", async () => {
    render(<ShredderView />);
    await openDrive();
    fireEvent.change(wipeBox(), { target: { value: "/mnt/usb" } });
    fireEvent.change(trimBox(), { target: { value: "/home" } });
    fireEvent.click(screen.getByTestId("top-tab-shred"));
    await openDrive();
    expect(wipeBox().value).toBe("/mnt/usb");
    expect(trimBox().value).toBe("/home");
  });
});

// ─── Drive maintenance: TRIM ─────────────────────────────────────────────────

describe("ShredderView - TRIM", () => {
  it("sends the path without surrounding spaces", async () => {
    handlers.trim_drive = () => ({ success: true, drive: "/", message: "ok" });
    render(<ShredderView />);
    await openDrive();
    await confirmTrim("  /home  ");
    await waitFor(() => expect(calls("trim_drive")).toEqual([{ drivePath: "/home" }]));
  });

  it("treats a blank path as missing", async () => {
    render(<ShredderView />);
    await openDrive();
    fireEvent.change(trimBox(), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
    expect(banner()).toHaveTextContent("Please enter a drive letter or mount point.");
    expect(screen.queryByText("Confirm TRIM")).not.toBeInTheDocument();
  });

  it("shows the path in the confirmation, and cancelling (button or X) runs nothing", async () => {
    render(<ShredderView />);
    await openDrive();
    fireEvent.change(trimBox(), { target: { value: "C" } });
    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
    const confirmDialog = (await screen.findByText("Confirm TRIM")).closest(".auth-card") as HTMLElement;
    expect(within(confirmDialog).getByText("C", { selector: "code" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Confirm TRIM")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
    const dialog = (await screen.findByText("Confirm TRIM")).closest(".auth-card") as HTMLElement;
    fireEvent.click(dialog.querySelector("svg.lucide-x") as SVGElement);
    expect(screen.queryByText("Confirm TRIM")).not.toBeInTheDocument();
    expect(calls("trim_drive")).toHaveLength(0);
  });

  it("shows a running state and locks the other tab", async () => {
    const gate = deferred<unknown>();
    handlers.trim_drive = () => gate.promise;
    render(<ShredderView />);
    await openDrive();
    await confirmTrim();
    expect(await screen.findByText("Running TRIM…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run TRIM" })).not.toBeInTheDocument();
    expect(screen.getByTestId("top-tab-shred")).toHaveAttribute("title", "An operation is in progress");
    await act(async () => {
      gate.resolve({ success: true, drive: "/", message: "done" });
    });
    await screen.findByText("TRIM Complete");
  });

  it("shows a TRIM that ran but reported failure, and starts over with Run Again", async () => {
    handlers.trim_drive = () => ({ success: false, drive: "/", message: "Needs administrator rights" });
    render(<ShredderView />);
    await openDrive();
    await confirmTrim();
    await screen.findByText("TRIM Failed");
    expect(screen.getByText("Needs administrator rights")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Run Again"));
    expect(trimBox()).toBeInTheDocument();
  });

  it("shortens a long error to its first sentence, without the repeated prefix", async () => {
    handlers.trim_drive = () => {
      throw "TRIM failed: access denied. Run the program as administrator.\nmore noise";
    };
    render(<ShredderView />);
    await openDrive();
    await confirmTrim();
    await waitFor(() => expect(banner()).toBeInTheDocument());
    expect(banner()!.querySelector("span")!.textContent).toBe("TRIM failed: access denied");
  });

  it("does not cut an error short at a dot inside a name or number", async () => {
    handlers.trim_drive = () => {
      throw "fstrim: cannot open /dev/nvme0n1.1 for access. Try again as root.";
    };
    render(<ShredderView />);
    await openDrive();
    await confirmTrim();
    await waitFor(() => expect(banner()).toHaveTextContent("/dev/nvme0n1.1 for access"));
    expect(banner()).not.toHaveTextContent("Try again");
  });

  it("falls back to the whole message when the first sentence is empty", async () => {
    handlers.trim_drive = () => {
      throw ". hidden problem";
    };
    render(<ShredderView />);
    await openDrive();
    await confirmTrim();
    await waitFor(() => expect(banner()).toHaveTextContent("TRIM failed: . hidden problem"));
  });

  it("clears an old error when a new TRIM starts", async () => {
    render(<ShredderView />);
    await openDrive();
    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
    expect(banner()).toBeInTheDocument();
    handlers.trim_drive = () => ({ success: true, drive: "/", message: "fine" });
    await confirmTrim();
    await screen.findByText("TRIM Complete");
    expect(banner()).toBeNull();
  });
});

// ─── Operations block each other ─────────────────────────────────────────────

describe("ShredderView - one operation at a time", () => {
  it.each([
    ["a wipe", "wipe_free_space"],
    ["a TRIM", "trim_drive"],
  ])("ignores files dropped on the window during %s", async (_name, cmd) => {
    const gate = deferred<unknown>();
    handlers[cmd] = () => gate.promise;
    render(<ShredderView />);
    await openDrive();
    if (cmd === "wipe_free_space") await confirmWipe();
    else await confirmTrim();
    await waitFor(() => expect(calls(cmd)).toHaveLength(1));

    await act(async () => {
      mockDropCallback!(["/late.txt"]);
    });
    // Still on the drive tab, still running.
    expect(screen.getByText(/Wipe leftover data from free space/)).toBeInTheDocument();
    expect(screen.queryByText("late.txt")).not.toBeInTheDocument();

    await act(async () => {
      gate.resolve(
        cmd === "wipe_free_space"
          ? { bytes_wiped: 1, target_path: "/home/user" }
          : { success: true, drive: "/", message: "done" },
      );
    });
    fireEvent.click(screen.getByTestId("top-tab-shred"));
    expect(screen.queryByText("late.txt")).not.toBeInTheDocument();
  });
});

// ─── Event listeners ─────────────────────────────────────────────────────────

describe("ShredderView - progress listeners", () => {
  it("listens for shred and wipe progress, and stops on unmount", async () => {
    const { unmount } = render(<ShredderView />);
    await waitFor(() => expect(Object.keys(listeners).sort()).toEqual(["shred-progress", "wipe-progress"]));
    await act(async () => {});
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("still stops listening if the screen was closed before the listeners were ready", async () => {
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    mockListen
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { unmount } = render(<ShredderView />);
    unmount();
    await act(async () => {
      first.resolve(unlisten);
      await Promise.resolve();
    });
    await act(async () => {
      second.resolve(unlisten);
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});

describe("ShredderView - keyboard shortcuts", () => {
  const ctrlO = () => fireEvent.keyDown(window, { key: "o", ctrlKey: true });

  it("Ctrl+O adds files on the shred tab", async () => {
    mockOpen.mockResolvedValueOnce(["/a.txt"]);
    render(<ShredderView />);
    ctrlO();
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
  });

  it("Ctrl+O does nothing on the drive tab", async () => {
    render(<ShredderView />);
    fireEvent.click(screen.getByTestId("top-tab-drive"));
    ctrlO();
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
