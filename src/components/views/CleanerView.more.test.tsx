import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CleanerView, formatSize } from "./CleanerView";

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockOpen = jest.fn();

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

const report = (over: Record<string, unknown> = {}) => ({
  has_gps: false,
  has_author: false,
  file_type: "Image",
  file_size: 2048,
  raw_tags: [],
  ...over,
});

const cleanResult = (over: Record<string, unknown> = {}) => ({
  success: ["/out/a_clean.jpg"],
  failed: [],
  total_files: 1,
  size_before: 5000,
  size_after: 3000,
  ...over,
});

const stego = (over: Record<string, unknown> = {}) => ({
  filename: "pic.png",
  path: "/pic.png",
  entropy_score: 7.9123,
  probability: 93,
  is_suspicious: true,
  extracted_text: null,
  error: null,
  ...over,
});

async function addFiles(paths: string[]) {
  mockOpen.mockResolvedValueOnce(paths);
  fireEvent.click(screen.getByText(/Select Files|Add More Files/));
  await screen.findAllByText(paths[0].split(/[/\\]/).pop()!);
}

async function startClean(paths = ["/a.jpg"]) {
  await addFiles(paths);
  fireEvent.click(screen.getByRole("button", { name: /Clean \d+ Files?/ }));
}

const goStego = () => fireEvent.click(screen.getByText("Steganography Scan"));

async function scanStego(paths = ["/pic.png"]) {
  goStego();
  mockOpen.mockResolvedValueOnce(paths);
  fireEvent.click(screen.getByText("Scan for Hidden Data (Steganography)"));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDragging = false;
  mockDropCallback = undefined;
  listeners = {};
  unlisten = jest.fn();
  mockListen.mockImplementation((event: string, cb: (e: unknown) => void) => {
    listeners[event] = cb;
    return Promise.resolve(unlisten);
  });
  handlers = { analyze_file_metadata: () => report() };
  mockInvoke.mockImplementation((cmd: string, args: unknown) => {
    const h = handlers[cmd];
    return h ? Promise.resolve().then(() => h(args)) : Promise.resolve(null);
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─── formatSize ──────────────────────────────────────────────────────────────

describe("formatSize - negative sizes", () => {
  it("keeps the sign when the cleaned file came out larger", () => {
    expect(formatSize(-1536)).toBe("-1.5 KB");
    expect(formatSize(-5)).toBe("-5 Bytes");
    expect(formatSize(-3 * 1024 * 1024)).toBe("-3 MB");
  });
});

// ─── Adding and removing files ───────────────────────────────────────────────

describe("CleanerView - adding files", () => {
  it("offers the supported formats to the file picker", async () => {
    mockOpen.mockResolvedValueOnce(null);
    render(<CleanerView />);
    fireEvent.click(screen.getByText("Select Files"));
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    const options = mockOpen.mock.calls[0][0];
    expect(options.multiple).toBe(true);
    expect(options.filters[0].extensions).toEqual(
      expect.arrayContaining(["jpg", "pdf", "docx", "mp3", "mp4", "cr2", "dng"]),
    );
  });

  it("accepts a single path from the picker", async () => {
    mockOpen.mockResolvedValueOnce("/only.jpg");
    render(<CleanerView />);
    fireEvent.click(screen.getByText("Select Files"));
    expect((await screen.findAllByText("only.jpg")).length).toBeGreaterThan(0);
  });

  it("does nothing when the picker is cancelled", async () => {
    mockOpen.mockResolvedValueOnce(null);
    render(<CleanerView />);
    fireEvent.click(screen.getByText("Select Files"));
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(screen.getByText("Drag & Drop Files")).toBeInTheDocument();
    expect(calls("analyze_file_metadata")).toHaveLength(0);
  });

  it("adds files dropped on the window", async () => {
    render(<CleanerView />);
    await act(async () => {
      mockDropCallback!(["/dropped.jpg"]);
    });
    expect((await screen.findAllByText("dropped.jpg")).length).toBeGreaterThan(0);
    expect(calls("analyze_file_metadata")).toEqual([{ path: "/dropped.jpg" }]);
  });

  it("highlights the scanner drop area while dragging", () => {
    mockIsDragging = true;
    render(<CleanerView />);
    goStego();
    expect(document.querySelector(".shred-zone")).toHaveClass("active");
  });

  it("highlights the drop area while dragging", () => {
    mockIsDragging = true;
    render(<CleanerView />);
    expect(document.querySelector(".shred-zone")).toHaveClass("active");
  });

  it("analyses a first file only once, even where React runs updaters twice", async () => {
    mockOpen.mockResolvedValueOnce(["/a.jpg"]);
    render(
      <StrictMode>
        <CleanerView />
      </StrictMode>,
    );
    fireEvent.click(screen.getByText("Select Files"));
    await screen.findAllByText("a.jpg");
    await act(async () => {});
    expect(calls("analyze_file_metadata")).toHaveLength(1);
  });

  it("keeps showing the report of the file being looked at when more files are added", async () => {
    handlers.analyze_file_metadata = (a) =>
      a.path === "/a.jpg" ? report({ camera_info: "Camera A" }) : report({ camera_info: "Camera B" });
    render(<CleanerView />);
    await addFiles(["/a.jpg", "/b.jpg"]);
    fireEvent.click(screen.getByText("b.jpg"));
    await screen.findByText("Camera B");

    await addFiles(["/c.jpg"]);
    // The preview must still be about b.jpg, under b.jpg's own name.
    const preview = screen.getByText("Metadata Preview").parentElement!.parentElement!;
    expect(within(preview).getByText("b.jpg")).toBeInTheDocument();
    expect(within(preview).getByText("Camera B")).toBeInTheDocument();
    expect(within(preview).getByText("2 / 3")).toBeInTheDocument();
  });

  it("does not add files dropped during a cleaning that then fails", async () => {
    const gate = deferred<unknown>();
    handlers.batch_clean_metadata = () => gate.promise;
    render(<CleanerView />);
    await startClean(["/a.jpg"]);
    await waitFor(() => expect(calls("batch_clean_metadata")).toHaveLength(1));
    await act(async () => {
      mockDropCallback!(["/late.jpg"]);
    });
    await act(async () => {
      gate.reject("disk full");
    });
    await screen.findByText(/Cleaning failed: disk full/);
    expect(screen.queryByText("late.jpg")).not.toBeInTheDocument();
  });

  it("keeps a file dropped while the file picker was open", async () => {
    const picker = deferred<string[] | null>();
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    mockOpen.mockReturnValueOnce(picker.promise);
    fireEvent.click(screen.getByText("Add More Files"));
    await act(async () => {
      mockDropCallback!(["/dropped.jpg"]);
    });
    await screen.findAllByText("dropped.jpg");
    await act(async () => {
      picker.resolve(["/picked.jpg"]);
    });
    expect(await screen.findAllByText("picked.jpg")).not.toHaveLength(0);
    expect(screen.getAllByText("a.jpg").length).toBeGreaterThan(0);
    expect(screen.getAllByText("dropped.jpg").length).toBeGreaterThan(0);
    expect(screen.getByText("Files (3)")).toBeInTheDocument();
  });

  it("clears an error when more files are added", async () => {
    handlers.analyze_file_metadata = () => {
      throw "corrupt";
    };
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    await screen.findByText(/Analysis failed: corrupt/);
    handlers.analyze_file_metadata = () => report();
    await addFiles(["/b.jpg"]);
    expect(screen.queryByText(/Analysis failed/)).not.toBeInTheDocument();
  });

  it("ignores files dropped while cleaning is running", async () => {
    const gate = deferred<unknown>();
    handlers.batch_clean_metadata = () => gate.promise;
    render(<CleanerView />);
    await startClean(["/a.jpg"]);
    await waitFor(() => expect(calls("batch_clean_metadata")).toHaveLength(1));
    await act(async () => {
      mockDropCallback!(["/late.jpg"]);
    });
    await act(async () => {
      gate.resolve(cleanResult());
    });
    await screen.findByText("Cleaning Complete!");
    fireEvent.click(screen.getByText("Clean More Files"));
    expect(screen.queryByText("late.jpg")).not.toBeInTheDocument();
    expect(screen.getByText("Drag & Drop Files")).toBeInTheDocument();
  });
});

describe("CleanerView - removing and moving between files", () => {
  async function three() {
    handlers.analyze_file_metadata = (a) => report({ camera_info: `cam of ${a.path}` });
    render(<CleanerView />);
    await addFiles(["/a.jpg", "/b.jpg", "/c.jpg"]);
    await screen.findByText("cam of /a.jpg");
  }
  // The file name also appears in the preview, so pick the copy that is in the list.
  const removeButton = (name: string) => {
    const row = screen
      .getAllByText(name)
      .map((el) => el.closest("div[style*='cursor: pointer']"))
      .find(Boolean) as HTMLElement;
    return within(row).getByTitle("Remove");
  };

  it("steps forward and back, and disables the arrows at the ends", async () => {
    await three();
    const prev = () => document.querySelectorAll(".icon-btn-ghost svg.lucide-chevron-left")[0].closest("button")!;
    const next = () => document.querySelectorAll(".icon-btn-ghost svg.lucide-chevron-right")[0].closest("button")!;
    expect(prev()).toBeDisabled();
    fireEvent.click(next());
    await screen.findByText("cam of /b.jpg");
    fireEvent.click(next());
    await screen.findByText("cam of /c.jpg");
    expect(next()).toBeDisabled();
    fireEvent.click(prev());
    await screen.findByText("cam of /b.jpg");
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("moves to the next file when the one being viewed is removed", async () => {
    await three();
    fireEvent.click(screen.getByText("b.jpg"));
    await screen.findByText("cam of /b.jpg");
    fireEvent.click(removeButton("b.jpg"));
    await screen.findByText("cam of /c.jpg");
    expect(screen.queryByText("b.jpg")).not.toBeInTheDocument();
  });

  it("moves to the previous file when the last one being viewed is removed", async () => {
    await three();
    fireEvent.click(screen.getByText("c.jpg"));
    await screen.findByText("cam of /c.jpg");
    fireEvent.click(removeButton("c.jpg"));
    await screen.findByText("cam of /b.jpg");
  });

  it("keeps looking at the same file when an earlier one is removed", async () => {
    await three();
    fireEvent.click(screen.getByText("c.jpg"));
    await screen.findByText("cam of /c.jpg");
    fireEvent.click(removeButton("a.jpg"));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByText("cam of /c.jpg")).toBeInTheDocument();
  });

  it("leaves the preview alone when a later file is removed", async () => {
    await three();
    fireEvent.click(removeButton("c.jpg"));
    expect(screen.getByText("cam of /a.jpg")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("returns to the start screen when the last file is removed", async () => {
    handlers.analyze_file_metadata = () => report();
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    fireEvent.click(screen.getByTitle("Remove"));
    expect(screen.getByText("Drag & Drop Files")).toBeInTheDocument();
  });

  it("Clear all forgets earlier analyses", async () => {
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    fireEvent.click(screen.getByTitle("Clear all"));
    expect(screen.getByText("Drag & Drop Files")).toBeInTheDocument();
    await addFiles(["/a.jpg"]);
    await waitFor(() => expect(calls("analyze_file_metadata")).toHaveLength(2));
  });
});

// ─── Analysis ────────────────────────────────────────────────────────────────

describe("CleanerView - analysing a file", () => {
  it("ignores a slow answer for a file the user has already moved away from", async () => {
    const slowA = deferred<ReturnType<typeof report>>();
    handlers.analyze_file_metadata = (a) =>
      a.path === "/a.jpg" ? slowA.promise : report({ camera_info: "Camera B" });
    render(<CleanerView />);
    await addFiles(["/a.jpg", "/b.jpg"]);
    fireEvent.click(screen.getByText("b.jpg"));
    await screen.findByText("Camera B");

    await act(async () => {
      slowA.resolve(report({ camera_info: "Camera A" }));
    });
    expect(screen.queryByText("Camera A")).not.toBeInTheDocument();
    expect(screen.getByText("Camera B")).toBeInTheDocument();
  });

  it("keeps showing 'Analyzing' while the newest file is still being analysed", async () => {
    const slowA = deferred<ReturnType<typeof report>>();
    const slowB = deferred<ReturnType<typeof report>>();
    handlers.analyze_file_metadata = (a) => (a.path === "/a.jpg" ? slowA.promise : slowB.promise);
    render(<CleanerView />);
    await addFiles(["/a.jpg", "/b.jpg"]);
    fireEvent.click(screen.getByText("b.jpg"));
    await waitFor(() => expect(calls("analyze_file_metadata")).toHaveLength(2));
    await act(async () => {
      slowA.resolve(report({ camera_info: "Camera A" }));
    });
    expect(screen.getByText("Analyzing...")).toBeInTheDocument();
    await act(async () => {
      slowB.resolve(report({ camera_info: "Camera B" }));
    });
    expect(await screen.findByText("Camera B")).toBeInTheDocument();
    expect(screen.queryByText("Analyzing...")).not.toBeInTheDocument();
  });

  it("does not leave 'Analyzing' on screen when a file that is already known is chosen", async () => {
    const slowB = deferred<ReturnType<typeof report>>();
    handlers.analyze_file_metadata = (a) =>
      a.path === "/a.jpg" ? report({ camera_info: "Camera A" }) : slowB.promise;
    render(<CleanerView />);
    await addFiles(["/a.jpg", "/b.jpg"]);
    await screen.findByText("Camera A");
    fireEvent.click(screen.getByText("b.jpg"));
    await screen.findByText("Analyzing...");
    // Back to a.jpg, whose report is already known, while b.jpg is still being read.
    const rowA = screen.getAllByText("a.jpg").map((el) => el.closest("div[style*='cursor: pointer']")).find(Boolean) as HTMLElement;
    fireEvent.click(rowA);
    expect(await screen.findByText("Camera A")).toBeInTheDocument();
    expect(screen.queryByText("Analyzing...")).not.toBeInTheDocument();
    await act(async () => {
      slowB.resolve(report());
    });
  });

  it("does not show an old failure over a newer file's report", async () => {
    const slowA = deferred<ReturnType<typeof report>>();
    handlers.analyze_file_metadata = (a) =>
      a.path === "/a.jpg" ? slowA.promise : report({ camera_info: "Camera B" });
    render(<CleanerView />);
    await addFiles(["/a.jpg", "/b.jpg"]);
    fireEvent.click(screen.getByText("b.jpg"));
    await screen.findByText("Camera B");
    await act(async () => {
      slowA.reject("unreadable");
    });
    expect(screen.queryByText(/Analysis failed/)).not.toBeInTheDocument();
  });

  it("shows a prompt instead of a report when analysis failed", async () => {
    handlers.analyze_file_metadata = () => {
      throw "corrupt";
    };
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    expect(await screen.findByText(/Analysis failed: corrupt/)).toBeInTheDocument();
    expect(screen.getByText("Select a file to preview metadata")).toBeInTheDocument();
  });

  it.each([
    [{ has_gps: true }, "High", "High risk"],
    [{ has_author: true }, "Medium", "Medium risk"],
    [{ camera_info: "X100" }, "Low", "Low risk"],
    [{ creation_date: "2020-01-01" }, "Low", "Low risk"],
    [{}, "Clean", "Clean risk"],
  ])("rates %j as %s", async (extra, label, text) => {
    handlers.analyze_file_metadata = () => report(extra);
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByTitle(`Risk: ${label}`)).toBeInTheDocument();
  });

  it("shows the highest risk when several kinds of data are present", async () => {
    handlers.analyze_file_metadata = () =>
      report({ has_gps: true, has_author: true, camera_info: "X" });
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    expect(await screen.findByText("High risk")).toBeInTheDocument();
  });

  it("shows the file type and size", async () => {
    handlers.analyze_file_metadata = () => report({ file_type: "Image", file_size: 1536 });
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    expect(await screen.findByText(/Image • 1.5 KB/)).toBeInTheDocument();
  });

  it("resets the raw-tag filter when the panel is closed and reopened", async () => {
    handlers.analyze_file_metadata = () =>
      report({ has_gps: true, raw_tags: [{ key: "GPS", value: "1" }, { key: "Make", value: "X" }] });
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    fireEvent.click(await screen.findByText(/Show Raw Tags/));
    fireEvent.change(screen.getByPlaceholderText("Filter tags…"), { target: { value: "gps" } });
    expect(screen.queryByText("Make:")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Hide Raw Tags/));
    fireEvent.click(screen.getByText(/Show Raw Tags/));
    expect((screen.getByPlaceholderText("Filter tags…") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Make:")).toBeInTheDocument();
  });

  it("matches raw tags by value as well as by name", async () => {
    handlers.analyze_file_metadata = () =>
      report({ has_gps: true, raw_tags: [{ key: "Make", value: "Canon" }, { key: "Lens", value: "50mm" }] });
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    fireEvent.click(await screen.findByText(/Show Raw Tags/));
    fireEvent.change(screen.getByPlaceholderText("Filter tags…"), { target: { value: "CANON" } });
    expect(screen.getByText("Make:")).toBeInTheDocument();
    expect(screen.queryByText("Lens:")).not.toBeInTheDocument();
  });

  it("shows the GPS details only when there are some", async () => {
    handlers.analyze_file_metadata = () => report({ has_gps: true, gps_info: "51.5 N, 0.1 W" });
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    expect(await screen.findByText("51.5 N, 0.1 W")).toBeInTheDocument();
  });
});

// ─── Output folder and options ───────────────────────────────────────────────

describe("CleanerView - output folder and options", () => {
  async function ready() {
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
  }

  it("keeps the old folder when the folder picker is cancelled", async () => {
    await ready();
    mockOpen.mockResolvedValueOnce("/chosen");
    fireEvent.click(screen.getByText(/Select Output/));
    await screen.findByText("/chosen");
    mockOpen.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByText(/Change Output/));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(3));
    expect(screen.getByText("/chosen")).toBeInTheDocument();
  });

  it("ignores a non-text answer from the folder picker", async () => {
    await ready();
    mockOpen.mockResolvedValueOnce(["/a", "/b"]);
    fireEvent.click(screen.getByText(/Select Output/));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByText(/saved in same directory/)).toBeInTheDocument();
  });

  it("reports a folder picker that fails", async () => {
    await ready();
    mockOpen.mockRejectedValueOnce("no dialog");
    fireEvent.click(screen.getByText(/Select Output/));
    expect(await screen.findByText(/Failed to select output directory: no dialog/)).toBeInTheDocument();
  });

  it("sends the cover-art choice", async () => {
    await ready();
    fireEvent.click(screen.getByLabelText(/Cover Art/));
    handlers.batch_clean_metadata = () => cleanResult();
    fireEvent.click(screen.getByRole("button", { name: /Clean 1 File/ }));
    await waitFor(() => expect(calls("batch_clean_metadata")).toHaveLength(1));
    expect(calls("batch_clean_metadata")[0].options).toEqual({
      gps: true,
      author: true,
      date: true,
      removeCoverArt: true,
    });
  });

  it("forgets the chosen folder after 'Clean More Files'", async () => {
    handlers.batch_clean_metadata = () => cleanResult();
    await ready();
    mockOpen.mockResolvedValueOnce("/chosen");
    fireEvent.click(screen.getByText(/Select Output/));
    await screen.findByText("/chosen");
    fireEvent.click(screen.getByRole("button", { name: /Clean 1 File/ }));
    await screen.findByText("Cleaning Complete!");
    fireEvent.click(screen.getByText("Clean More Files"));
    await addFiles(["/b.jpg"]);
    expect(screen.queryByText("/chosen")).not.toBeInTheDocument();
    expect(screen.getByText(/saved in same directory/)).toBeInTheDocument();
  });
});

// ─── Cleaning ────────────────────────────────────────────────────────────────

describe("CleanerView - while cleaning", () => {
  it("shows a progress card from the start, before the first progress report", async () => {
    const gate = deferred<unknown>();
    handlers.batch_clean_metadata = () => gate.promise;
    render(<CleanerView />);
    await startClean();
    expect(await screen.findByText("Cleaning Metadata...")).toBeInTheDocument();
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    await act(async () => {
      gate.resolve(cleanResult());
    });
  });

  it("fills in the progress as it arrives", async () => {
    const gate = deferred<unknown>();
    handlers.batch_clean_metadata = () => gate.promise;
    render(<CleanerView />);
    await startClean(["/a.jpg", "/b.jpg"]);
    await screen.findByText("Cleaning Metadata...");
    act(() =>
      listeners["clean-metadata-progress"]({
        payload: { current: 1, total: 2, current_file: "/photos/a.jpg", percentage: 50 },
      }),
    );
    expect(screen.getByText("1 of 2 files")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Cleaning Metadata..." })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("/photos/a.jpg")).toBeInTheDocument();
    expect(document.querySelector('div[style*="width: 50%"]')).not.toBeNull();
    await act(async () => {
      gate.resolve(cleanResult());
    });
  });

  it("sends every file and the choices", async () => {
    handlers.batch_clean_metadata = () => cleanResult();
    render(<CleanerView />);
    await startClean(["/a.jpg", "/b.jpg"]);
    await waitFor(() => expect(calls("batch_clean_metadata")).toHaveLength(1));
    expect(calls("batch_clean_metadata")[0]).toEqual({
      paths: ["/a.jpg", "/b.jpg"],
      outputDir: null,
      options: { gps: true, author: true, date: true, removeCoverArt: false },
    });
  });

  it("keeps showing the cleaning after Cancel until it really stops", async () => {
    const gate = deferred<unknown>();
    handlers.batch_clean_metadata = () => gate.promise;
    render(<CleanerView />);
    await startClean();
    await screen.findByText("Cleaning Metadata...");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(calls("cancel_metadata_clean")).toHaveLength(1));

    // The files are still being rewritten, so nothing may offer to start another run.
    expect(screen.getByText("Cleaning Metadata...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Clean \d+ Files?/ })).not.toBeInTheDocument();

    await act(async () => {
      gate.resolve(cleanResult({ success: [], size_before: 0, size_after: 0 }));
    });
    await screen.findByText(/Cleaning cancelled by user/);
  });

  it("says it was cancelled, not failed, when the cancelled command reports an error", async () => {
    const gate = deferred<unknown>();
    handlers.batch_clean_metadata = () => gate.promise;
    render(<CleanerView />);
    await startClean();
    await screen.findByText("Cleaning Metadata...");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(calls("cancel_metadata_clean")).toHaveLength(1));
    await act(async () => {
      gate.reject("Operation cancelled");
    });
    await screen.findByText(/Cleaning cancelled by user/);
    expect(screen.queryByText(/Cleaning failed/)).not.toBeInTheDocument();
  });

  it("lets the user try Cancel again if the cancel request failed", async () => {
    const gate = deferred<unknown>();
    handlers.batch_clean_metadata = () => gate.promise;
    handlers.cancel_metadata_clean = () => {
      throw "busy";
    };
    render(<CleanerView />);
    await startClean();
    await screen.findByText("Cleaning Metadata...");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    await act(async () => {
      gate.resolve(cleanResult());
    });
  });

  it("does not call the next run cancelled after one was", async () => {
    const first = deferred<unknown>();
    let call = 0;
    handlers.batch_clean_metadata = () => (++call === 1 ? first.promise : cleanResult());
    render(<CleanerView />);
    await startClean();
    await screen.findByText("Cleaning Metadata...");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(calls("cancel_metadata_clean")).toHaveLength(1));
    await act(async () => {
      first.resolve(cleanResult({ success: [] }));
    });
    await screen.findByText(/cancelled by user/);

    fireEvent.click(screen.getByText("Clean More Files"));
    await startClean(["/b.jpg"]);
    await waitFor(() => expect(call).toBe(2));
    await screen.findByText("Cleaning Complete!");
    expect(screen.queryByText(/cancelled by user/)).not.toBeInTheDocument();
  });

  it("ignores a progress report that arrives after the cleaning finished", async () => {
    handlers.batch_clean_metadata = () => cleanResult();
    render(<CleanerView />);
    await startClean();
    await screen.findByText("Cleaning Complete!");
    act(() =>
      listeners["clean-metadata-progress"]({
        payload: { current: 1, total: 1, current_file: "a.jpg", percentage: 100 },
      }),
    );
    expect(screen.queryByText("Cleaning Metadata...")).not.toBeInTheDocument();
  });

  it("returns to the file list with the error when cleaning fails", async () => {
    handlers.batch_clean_metadata = () => {
      throw "disk full";
    };
    render(<CleanerView />);
    await startClean();
    expect(await screen.findByText(/Cleaning failed: disk full/)).toBeInTheDocument();
    expect(screen.getAllByText("a.jpg").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Clean 1 File/ })).toBeEnabled();
  });
});

// ─── Results ─────────────────────────────────────────────────────────────────

describe("CleanerView - results", () => {
  async function cleaned(res: Record<string, unknown>, paths = ["/a.jpg"]) {
    handlers.batch_clean_metadata = () => res;
    render(<CleanerView />);
    await startClean(paths);
    await screen.findByText("Cleaning Complete!");
  }

  it("calls a larger result a size change, not a reduction", async () => {
    await cleaned(cleanResult({ size_before: 1000, size_after: 2536 }));
    expect(screen.getByText("Size Change:")).toBeInTheDocument();
    expect(screen.getByText(/-1.5 KB/)).toBeInTheDocument();
    expect(screen.queryByText("Size Reduction:")).not.toBeInTheDocument();
  });

  it("calls an unchanged size a reduction of zero", async () => {
    await cleaned(cleanResult({ size_before: 1000, size_after: 1000 }));
    expect(screen.getByText("Size Reduction:")).toBeInTheDocument();
    expect(screen.getAllByText(/0 Bytes/).length).toBeGreaterThan(0);
  });

  it("hides the before and after line when the original sizes are unknown", async () => {
    await cleaned(cleanResult({ size_before: 0, size_after: 0 }));
    expect(screen.queryByText(/Before:/)).not.toBeInTheDocument();
  });

  it("lists ten failures and says how many more there are, naming each by file only", async () => {
    const failed = Array.from({ length: 12 }, (_, i) => ({ path: `C:\\pics\\f${i}.jpg`, error: "unsupported" }));
    await cleaned(cleanResult({ success: [], failed }));
    expect(screen.getByText("Failed to clean 12 file(s):")).toBeInTheDocument();
    expect(screen.getAllByText(/unsupported/)).toHaveLength(10);
    expect(screen.getByText("f0.jpg")).toBeInTheDocument();
    expect(screen.getByText("... and 2 more")).toBeInTheDocument();
  });

  it("shows no list of cleaned files when none succeeded", async () => {
    await cleaned(cleanResult({ success: [], failed: [{ path: "/a.jpg", error: "bad" }] }));
    expect(screen.queryByText("Cleaned Files")).not.toBeInTheDocument();
  });

  it("compares the right original even when an earlier file failed", async () => {
    handlers.compare_metadata_files = () => ({
      original_size: 10,
      cleaned_size: 5,
      removed_tags: ["GPS"],
      size_reduction: 5,
    });
    await cleaned(
      cleanResult({
        success: ["/out/a_clean.jpg", "/out/c_clean.jpg"],
        failed: [{ path: "/b.jpg", error: "bad" }],
      }),
      ["/a.jpg", "/b.jpg", "/c.jpg"],
    );
    fireEvent.click(screen.getAllByText("What was removed?")[1]);
    await waitFor(() => expect(calls("compare_metadata_files")).toHaveLength(1));
    expect(calls("compare_metadata_files")[0]).toEqual({
      original: "/c.jpg",
      cleaned: "/out/c_clean.jpg",
    });
  });

  it("says '1 tag removed' for one and 'N tags removed' for several, with the saving", async () => {
    handlers.compare_metadata_files = (a) =>
      a.cleaned.includes("one")
        ? { original_size: 10, cleaned_size: 9, removed_tags: ["GPS"], size_reduction: 0 }
        : { original_size: 2048, cleaned_size: 1024, removed_tags: ["GPS", "Make"], size_reduction: 1024 };
    await cleaned(cleanResult({ success: ["/out/one_clean.jpg", "/out/two_clean.jpg"] }), ["/one.jpg", "/two.jpg"]);
    const [first, second] = screen.getAllByText("What was removed?");
    fireEvent.click(first);
    expect(await screen.findByText(/^1 tag\s+removed/)).toBeInTheDocument();
    expect(screen.queryByText(/saved/)).not.toBeInTheDocument();
    fireEvent.click(second);
    expect(await screen.findByText(/2 tags\s+removed\s+·\s+saved 1 KB/)).toBeInTheDocument();
    expect(screen.getByText("• Make")).toBeInTheDocument();
  });

  it("asks only once while a comparison is loading, and tells the user if it fails", async () => {
    const gate = deferred<unknown>();
    handlers.compare_metadata_files = () => gate.promise;
    await cleaned(cleanResult());
    const button = screen.getByText("What was removed?");
    fireEvent.click(button);
    await waitFor(() => expect(calls("compare_metadata_files")).toHaveLength(1));
    expect(button.closest("button")).toBeDisabled();
    fireEvent.click(button.closest("button")!);
    expect(calls("compare_metadata_files")).toHaveLength(1);

    await act(async () => {
      gate.reject("original is gone");
    });
    expect(await screen.findByText(/Comparison failed: original is gone/)).toBeInTheDocument();
    expect(screen.getByText("What was removed?").closest("button")).toBeEnabled();
  });

  it("does not ask again for a comparison it already has", async () => {
    handlers.compare_metadata_files = () => ({
      original_size: 1,
      cleaned_size: 1,
      removed_tags: [],
      size_reduction: 0,
    });
    await cleaned(cleanResult());
    fireEvent.click(screen.getByText("What was removed?"));
    await screen.findByText("✓ No tags found to remove");
    expect(screen.queryByText("What was removed?")).not.toBeInTheDocument();
    expect(calls("compare_metadata_files")).toHaveLength(1);
  });

  it("clears the old comparisons when a new cleaning starts", async () => {
    handlers.compare_metadata_files = () => ({
      original_size: 1,
      cleaned_size: 1,
      removed_tags: ["GPS"],
      size_reduction: 0,
    });
    await cleaned(cleanResult());
    fireEvent.click(screen.getByText("What was removed?"));
    await screen.findByText("• GPS");
    fireEvent.click(screen.getByText("Clean More Files"));
    await startClean(["/b.jpg"]);
    await screen.findByText("Cleaning Complete!");
    expect(screen.queryByText("• GPS")).not.toBeInTheDocument();
    expect(screen.getByText("What was removed?")).toBeInTheDocument();
  });
});

// ─── Steganography scan ──────────────────────────────────────────────────────

describe("CleanerView - steganography scan", () => {
  it("switches tabs and shows the scanner's drop area", () => {
    render(<CleanerView />);
    goStego();
    expect(screen.getByText("Scan for Hidden Data (Steganography)")).toBeInTheDocument();
    expect(screen.getByText("Supports: JPG, PNG, BMP, WebP")).toBeInTheDocument();
    expect(screen.queryByText("Drag & Drop Files")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Metadata Cleaner", { selector: "button" }));
    expect(screen.getByText("Drag & Drop Files")).toBeInTheDocument();
  });

  it("keeps the metadata files while the other tab is open", async () => {
    render(<CleanerView />);
    await addFiles(["/a.jpg"]);
    goStego();
    fireEvent.click(screen.getByText("Metadata Cleaner", { selector: "button" }));
    expect(screen.getAllByText("a.jpg").length).toBeGreaterThan(0);
  });

  it("asks the picker for images only, and scans what was chosen", async () => {
    handlers.detect_steganography = () => [stego()];
    render(<CleanerView />);
    await scanStego(["/pic.png", "/pic2.jpg"]);
    await screen.findByText("Scan Results");
    expect(mockOpen.mock.calls[0][0].filters[0].extensions).toEqual(["jpg", "jpeg", "png", "bmp", "webp"]);
    expect(calls("detect_steganography")).toEqual([{ paths: ["/pic.png", "/pic2.jpg"] }]);
  });

  it("accepts a single path from the picker", async () => {
    handlers.detect_steganography = () => [stego()];
    render(<CleanerView />);
    goStego();
    mockOpen.mockResolvedValueOnce("/one.png");
    fireEvent.click(screen.getByText("Scan for Hidden Data (Steganography)"));
    await screen.findByText("Scan Results");
    expect(calls("detect_steganography")).toEqual([{ paths: ["/one.png"] }]);
  });

  it("does nothing when the picker is cancelled", async () => {
    render(<CleanerView />);
    goStego();
    mockOpen.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByText("Scan for Hidden Data (Steganography)"));
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(calls("detect_steganography")).toHaveLength(0);
    expect(screen.getByText("Supports: JPG, PNG, BMP, WebP")).toBeInTheDocument();
  });

  it("reports a picker that fails", async () => {
    render(<CleanerView />);
    goStego();
    mockOpen.mockRejectedValueOnce("no dialog");
    fireEvent.click(screen.getByText("Scan for Hidden Data (Steganography)"));
    expect(await screen.findByText(/Failed to open file dialog: no dialog/)).toBeInTheDocument();
  });

  it("scans images dropped on the window while this tab is open", async () => {
    handlers.detect_steganography = () => [stego()];
    render(<CleanerView />);
    goStego();
    await act(async () => {
      mockDropCallback!(["/dropped.png"]);
    });
    await screen.findByText("Scan Results");
    expect(calls("detect_steganography")).toEqual([{ paths: ["/dropped.png"] }]);
  });

  it("does not add dropped files to the metadata list while the scanner is open", async () => {
    handlers.detect_steganography = () => [stego()];
    render(<CleanerView />);
    goStego();
    await act(async () => {
      mockDropCallback!(["/dropped.png"]);
    });
    await screen.findByText("Scan Results");
    expect(calls("analyze_file_metadata")).toHaveLength(0);
  });

  it("shows a progress card while scanning, with the progress reports", async () => {
    const gate = deferred<unknown>();
    handlers.detect_steganography = () => gate.promise;
    render(<CleanerView />);
    await scanStego();
    expect(await screen.findByText("Analyzing Pixel Entropy...")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Analyzing Pixel Entropy..." })).not.toHaveAttribute("aria-valuenow");
    act(() =>
      listeners["stego-progress"]({
        payload: { current: 1, total: 2, current_file: "pic.png", percentage: 45 },
      }),
    );
    expect(screen.getByText("pic.png")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Analyzing Pixel Entropy..." })).toHaveAttribute("aria-valuenow", "45");
    await act(async () => {
      gate.resolve([stego()]);
    });
    await screen.findByText("Scan Results");
    expect(screen.queryByText("Analyzing Pixel Entropy...")).not.toBeInTheDocument();
  });

  it("shows each image's score, confidence and verdict", async () => {
    handlers.detect_steganography = () => [
      stego(),
      stego({
        filename: "calm.jpg",
        entropy_score: 3.5,
        probability: 4,
        is_suspicious: false,
      }),
    ];
    render(<CleanerView />);
    await scanStego();
    await screen.findByText("Scan Results");
    expect(screen.getByText("Entropy Score: 7.912 / 8.000")).toBeInTheDocument();
    expect(screen.getByText("93% Confidence")).toBeInTheDocument();
    expect(screen.getByText("Entropy Score: 3.500 / 8.000")).toBeInTheDocument();
    expect(screen.getByText("4% Confidence")).toBeInTheDocument();
    const suspicious = screen.getByText("93% Confidence");
    const calm = screen.getByText("4% Confidence");
    expect(suspicious.querySelector("svg.lucide-triangle-alert, svg.lucide-alert-triangle")).not.toBeNull();
    expect(calm.querySelector("svg.lucide-circle-check, svg.lucide-check-circle, svg.lucide-circle-check-big")).not.toBeNull();
  });

  it("shows hidden text that was recovered", async () => {
    handlers.detect_steganography = () => [stego({ extracted_text: "meet at noon" })];
    render(<CleanerView />);
    await scanStego();
    expect(await screen.findByText("Hidden text recovered — meet at noon")).toBeInTheDocument();
  });

  it("shows the reason for an image that could not be scanned, with no confidence badge", async () => {
    handlers.detect_steganography = () => [
      stego({ filename: "bad.png", error: "Unsupported image", probability: 0, is_suspicious: false }),
    ];
    render(<CleanerView />);
    await scanStego();
    expect(await screen.findByText("Unsupported image")).toBeInTheDocument();
    expect(screen.queryByText(/Confidence/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Entropy Score/)).not.toBeInTheDocument();
  });

  it("explains how to read the score", async () => {
    handlers.detect_steganography = () => [stego()];
    render(<CleanerView />);
    await scanStego();
    expect(await screen.findByText(/entropy score approaching 8.000/)).toBeInTheDocument();
  });

  it("scans new images after 'Scan New Images', replacing the old results", async () => {
    let call = 0;
    handlers.detect_steganography = () => (++call === 1 ? [stego({ filename: "first.png" })] : [stego({ filename: "second.png" })]);
    render(<CleanerView />);
    await scanStego();
    await screen.findByText("first.png");
    fireEvent.click(screen.getByText("Scan New Images"));
    expect(screen.getByText("Supports: JPG, PNG, BMP, WebP")).toBeInTheDocument();
    mockOpen.mockResolvedValueOnce(["/second.png"]);
    fireEvent.click(screen.getByText("Scan for Hidden Data (Steganography)"));
    await screen.findByText("second.png");
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
  });

  it("returns to the start screen with an error when the scan fails", async () => {
    handlers.detect_steganography = () => {
      throw "out of memory";
    };
    render(<CleanerView />);
    await scanStego();
    expect(await screen.findByText(/Steganography scan failed: out of memory/)).toBeInTheDocument();
    expect(screen.getByText("Supports: JPG, PNG, BMP, WebP")).toBeInTheDocument();
    expect(screen.queryByText("Analyzing Pixel Entropy...")).not.toBeInTheDocument();
  });

  it("replaces old results with a clean start screen when a new scan fails", async () => {
    let call = 0;
    handlers.detect_steganography = () => {
      if (++call === 1) return [stego({ filename: "first.png" })];
      throw "boom";
    };
    render(<CleanerView />);
    await scanStego();
    await screen.findByText("first.png");
    await act(async () => {
      mockDropCallback!(["/second.png"]);
    });
    await screen.findByText(/Steganography scan failed: boom/);
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
    expect(screen.getByText("Supports: JPG, PNG, BMP, WebP")).toBeInTheDocument();
  });

  it("clears an old error when a new scan starts", async () => {
    let call = 0;
    handlers.detect_steganography = () => {
      if (++call === 1) throw "boom";
      return [stego()];
    };
    render(<CleanerView />);
    await scanStego();
    await screen.findByText(/Steganography scan failed/);
    mockOpen.mockResolvedValueOnce(["/b.png"]);
    fireEvent.click(screen.getByText("Scan for Hidden Data (Steganography)"));
    await screen.findByText("Scan Results");
    expect(screen.queryByText(/Steganography scan failed/)).not.toBeInTheDocument();
  });

  it("ignores files dropped on the window while a scan is running", async () => {
    const gate = deferred<unknown>();
    let call = 0;
    handlers.detect_steganography = () => (++call === 1 ? gate.promise : [stego({ filename: "late.png" })]);
    render(<CleanerView />);
    await scanStego();
    await screen.findByText("Analyzing Pixel Entropy...");
    await act(async () => {
      mockDropCallback!(["/late.png"]);
    });
    expect(calls("detect_steganography")).toHaveLength(1);
    await act(async () => {
      gate.resolve([stego({ filename: "first.png" })]);
    });
    await screen.findByText("first.png");
    expect(screen.queryByText("late.png")).not.toBeInTheDocument();
  });
});

// ─── Event listeners ─────────────────────────────────────────────────────────

describe("CleanerView - progress listeners", () => {
  it("listens for cleaning and scan progress, and stops on unmount", async () => {
    const { unmount } = render(<CleanerView />);
    await waitFor(() =>
      expect(Object.keys(listeners).sort()).toEqual(["clean-metadata-progress", "stego-progress"]),
    );
    await act(async () => {});
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("still stops listening if the screen was closed before the listeners were ready", async () => {
    const first = deferred<() => void>();
    const second = deferred<() => void>();
    mockListen.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { unmount } = render(<CleanerView />);
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

describe("CleanerView - keyboard shortcuts", () => {
  const ctrlO = () => fireEvent.keyDown(window, { key: "o", ctrlKey: true });

  it("Ctrl+O picks files on the metadata tab", async () => {
    mockOpen.mockResolvedValueOnce(["/a.jpg"]);
    render(<CleanerView />);
    ctrlO();
    expect((await screen.findAllByText("a.jpg")).length).toBeGreaterThan(0);
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0].filters[0].name).toBe("Media & Docs");
  });

  it("Ctrl+O picks images on the steganography tab", async () => {
    mockOpen.mockResolvedValueOnce(null);
    render(<CleanerView />);
    goStego();
    ctrlO();
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    expect(mockOpen.mock.calls[0][0].filters[0].name).toBe("Images");
  });
});

// ─── Shared parts ────────────────────────────────────────────────────────────

describe("CleanerView - shared parts", () => {
  it("shows the start screen of both tabs in the shared drop zone", () => {
    render(<CleanerView />);
    expect(document.querySelector(".ui-drop")).toBeInTheDocument();
    expect(screen.getByText("or click to select")).toBeInTheDocument();
    expect(screen.getByText(/Maximum file size: 100 MB/)).toBeInTheDocument();
    goStego();
    expect(document.querySelector(".ui-drop")).toBeInTheDocument();
    expect(screen.getByText("Supports: JPG, PNG, BMP, WebP")).toBeInTheDocument();
  });

  it("opens the file picker from the drop zone button, once", async () => {
    mockOpen.mockResolvedValueOnce(null);
    render(<CleanerView />);
    fireEvent.click(screen.getByRole("button", { name: /Select Files/ }));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
  });

  it("opens the image picker from the drop zone button on the scanner tab", async () => {
    mockOpen.mockResolvedValueOnce(null);
    render(<CleanerView />);
    goStego();
    fireEvent.click(screen.getByRole("button", { name: /Select Images/ }));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
  });

  it("shows a failure in an error banner you can dismiss", async () => {
    handlers.analyze_file_metadata = () => {
      throw "unreadable";
    };
    render(<CleanerView />);
    mockOpen.mockResolvedValueOnce(["/a.jpg"]);
    fireEvent.click(screen.getByText("Select Files"));
    const message = await screen.findByText(/Analysis failed: unreadable/);
    expect(message.closest(".ui-banner")).toHaveClass("ui-banner--error");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByText(/Analysis failed/)).not.toBeInTheDocument();
  });

  it("starts the cleaning progress card at 0% and hides the drop zone", async () => {
    const gate = deferred<unknown>();
    handlers.batch_clean_metadata = () => gate.promise;
    render(<CleanerView />);
    await startClean();
    await screen.findByText("Cleaning Metadata...");
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(document.querySelector(".ui-drop")).toBeNull();
    await act(async () => {
      gate.resolve(cleanResult());
    });
  });

  it("shows the scanner as a card that cannot be cancelled and has no drop zone", async () => {
    const gate = deferred<unknown>();
    handlers.detect_steganography = () => gate.promise;
    render(<CleanerView />);
    await scanStego();
    await screen.findByText("Analyzing Pixel Entropy...");
    expect(document.querySelector(".ui-drop")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve([stego()]);
    });
  });
});
