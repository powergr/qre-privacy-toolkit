/**
 * ShredderView.test.tsx
 *
 * Test suite for the ShredderView component.
 *
 * Dependencies assumed to be installed:
 *   @testing-library/react
 *   @testing-library/jest-dom
 *   @testing-library/user-event
 *   jest (with jsdom environment)
 *   jest-environment-jsdom
 */

import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mock Tauri APIs ────────────────────────────────────────────────────────

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockOpen = jest.fn();
const mockPlatform = jest.fn();
const mockUseDragDrop = jest.fn();

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

jest.mock("../hooks/useDragDrop", () => ({
  useDragDrop: (cb: (files: string[]) => void) => {
    mockUseDragDrop.mockImplementation(cb);
    return { isDragging: false };
  },
}));

// ─── Import component after mocks ──────────────────────────────────────────

import { ShredderView } from "../components/views/ShredderView";

// ─── Suppress act() warnings ────────────────────────────────────────────────
// executeShred / executeWipeFreeSpace / executeTrim are called from onClick
// without await, so their post-resolve setState calls land outside React's
// tracked act() boundary. The tests are structured correctly (all assertions
// use waitFor) and every test passes — this is a React 18 async-handler quirk.
// We suppress only the specific warning so other console.error calls still
// surface normally.

let _consoleError: typeof console.error;
beforeAll(() => {
  _consoleError = console.error.bind(console);
  jest
    .spyOn(console, "error")
    .mockImplementation((msg: unknown, ...args: unknown[]) => {
      if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
      _consoleError(msg, ...args);
    });
});

afterAll(() => {
  (console.error as jest.MockedFunction<typeof console.error>).mockRestore();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Default: desktop (non-Android), listen returns a no-op unlisten. */
function setupDefaults() {
  jest.clearAllMocks();
  mockPlatform.mockReturnValue("linux");
  mockListen.mockResolvedValue(() => {});
  mockInvoke.mockResolvedValue(null);
}

function renderShredder() {
  return render(<ShredderView />);
}

/**
 * Switch to the Drive Maintenance tab and wait for the Wipe Free Space card
 * to be visible. Both sections 8 and 9 call this at the start of each test
 * because the component defaults to the Shred Files tab.
 */
async function switchToDriveMaintenance() {
  fireEvent.click(screen.getByTestId("top-tab-drive"));
  await waitFor(() =>
    expect(screen.getByText("Wipe Free Space")).toBeInTheDocument(),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// SECTION 1 — formatSize utility (via UI rendering)
// ───────────────────────────────────────────────────────────────────────────

describe("formatSize (via UI rendering)", () => {
  beforeEach(setupDefaults);

  it("shows formatted size in the dry-run preview", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "dry_run_shred") {
        return Promise.resolve({
          files: [
            {
              name: "report.pdf",
              size: 1536,
              is_directory: false,
              file_count: 1,
              warning: null,
              path: "/home/user/report.pdf",
            },
          ],
          total_size: 1536,
          total_file_count: 1,
          warnings: [],
          blocked: [],
        });
      }
      return Promise.resolve(null);
    });

    renderShredder();
    act(() => mockUseDragDrop(["/home/user/report.pdf"]));
    fireEvent.click(await screen.findByText("Preview"));

    // 1536 bytes = 1.5 KB — appears in both the Total Size stat and the file
    // row; just assert at least one instance is in the document.
    await waitFor(() => {
      expect(screen.getAllByText("1.5 KB").length).toBeGreaterThan(0);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 2 — Platform detection
// ───────────────────────────────────────────────────────────────────────────

describe("Platform detection", () => {
  beforeEach(() => {
    mockListen.mockResolvedValue(() => {});
  });

  it("renders the normal UI on desktop", async () => {
    mockPlatform.mockReturnValue("linux");
    renderShredder();
    await waitFor(() => {
      expect(screen.getByText("Secure Shredder")).toBeInTheDocument();
      expect(
        screen.queryByText("Not Available on Android"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows the Android unavailable screen on Android", async () => {
    mockPlatform.mockReturnValue("android");
    renderShredder();
    await waitFor(() => {
      expect(screen.getByText("Not Available on Android")).toBeInTheDocument();
    });
  });

  it("handles a Promise-based async platform() call correctly", async () => {
    mockPlatform.mockReturnValue(Promise.resolve("android"));
    renderShredder();
    await waitFor(() => {
      expect(screen.getByText("Not Available on Android")).toBeInTheDocument();
    });
  });

  it("handles platform() throwing without crashing the component", async () => {
    // platform() throws synchronously — the component now wraps the call in
    // try/catch so a browser/test environment doesn't crash the render.
    mockPlatform.mockImplementation(() => {
      throw new Error("no OS context");
    });
    renderShredder();
    await waitFor(() => {
      expect(screen.getByText("Secure Shredder")).toBeInTheDocument();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 3 — File Selection
// ───────────────────────────────────────────────────────────────────────────

describe("File selection", () => {
  beforeEach(setupDefaults);

  it("renders the drop zone when no files are selected", async () => {
    renderShredder();
    await waitFor(() => {
      // Actual component text (not "Drag & Drop Files")
      expect(
        screen.getByText("Drop files here or click to browse."),
      ).toBeInTheDocument();
    });
  });

  it("adds files via the file picker", async () => {
    mockOpen.mockResolvedValue([
      "/home/user/secret.txt",
      "/home/user/keys.pem",
    ]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));

    await waitFor(() => {
      expect(screen.getByText("secret.txt")).toBeInTheDocument();
      expect(screen.getByText("keys.pem")).toBeInTheDocument();
    });
  });

  it("adds files via drag and drop", async () => {
    renderShredder();
    act(() => mockUseDragDrop(["/home/user/dropped.docx"]));
    await waitFor(() => {
      expect(screen.getByText("dropped.docx")).toBeInTheDocument();
    });
  });

  it("deduplicates files when the same path is added twice", async () => {
    mockOpen
      .mockResolvedValueOnce(["/home/user/dup.txt"])
      .mockResolvedValueOnce(["/home/user/dup.txt"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    await waitFor(() =>
      expect(screen.getByText("dup.txt")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText(/Add More/i));
    await waitFor(() => {
      expect(screen.getAllByText("dup.txt")).toHaveLength(1);
    });
  });

  it("removes individual files from the list", async () => {
    mockOpen.mockResolvedValue([
      "/home/user/keep.txt",
      "/home/user/remove.txt",
    ]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    await waitFor(() =>
      expect(screen.getByText("remove.txt")).toBeInTheDocument(),
    );

    // Find the file row for "remove.txt" then click its last SVG (the X icon).
    const removeSpan = screen.getByText("remove.txt");
    const row = removeSpan.closest("div[style]")!;
    const allSvgs = Array.from(row.querySelectorAll("svg"));
    fireEvent.click(allSvgs[allSvgs.length - 1]);

    await waitFor(() => {
      expect(screen.queryByText("remove.txt")).not.toBeInTheDocument();
      expect(screen.getByText("keep.txt")).toBeInTheDocument();
    });
  });

  it("clears all files with Clear All", async () => {
    mockOpen.mockResolvedValue(["/a.txt", "/b.txt"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    await waitFor(() =>
      expect(screen.getByText("Clear All")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Clear All"));
    await waitFor(() => {
      expect(
        screen.getByText("Drop files here or click to browse."),
      ).toBeInTheDocument();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 4 — Method Selection
// ───────────────────────────────────────────────────────────────────────────

describe("Shredding method selection", () => {
  beforeEach(setupDefaults);

  it("shows the method selector when files are selected", async () => {
    mockOpen.mockResolvedValue(["/file.bin"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));

    await waitFor(() => {
      expect(screen.getByText("Shredding Method")).toBeInTheDocument();
      expect(screen.getByText("DoD 3-Pass")).toBeInTheDocument();
      expect(screen.getByText("Simple (1 pass)")).toBeInTheDocument();
      expect(screen.getByText("DoD 7-Pass")).toBeInTheDocument();
      expect(screen.getByText("Gutmann (35 pass)")).toBeInTheDocument();
    });
  });

  it("allows selecting Gutmann method", async () => {
    mockOpen.mockResolvedValue(["/file.bin"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    await waitFor(() =>
      expect(screen.getByText("Gutmann (35 pass)")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Gutmann (35 pass)").closest("[style]")!);
    fireEvent.click(screen.getByText(/Shred 1 File/i));

    // Scope to the modal to avoid matching "Gutmann (35 pass)" on the card
    // that remains visible behind the overlay.
    await waitFor(() => {
      const modal = screen.getByTestId("shred-confirm-modal");
      expect(
        within(modal).getByText(/overwritten 35 time/i),
      ).toBeInTheDocument();
    });
  });

  it("confirmation modal reports the correct pass count for DoD 7-Pass", async () => {
    mockOpen.mockResolvedValue(["/classified.txt"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    await waitFor(() =>
      expect(screen.getByText("DoD 7-Pass")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("DoD 7-Pass").closest("[style]")!);
    fireEvent.click(screen.getByText(/Shred 1 File/i));

    // Scope to the modal to avoid matching "DoD 7-Pass" on the method card.
    await waitFor(() => {
      const modal = screen.getByTestId("shred-confirm-modal");
      expect(
        within(modal).getByText(/overwritten 7 time/i),
      ).toBeInTheDocument();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 5 — Dry Run / Preview
// ───────────────────────────────────────────────────────────────────────────

describe("Dry run preview", () => {
  beforeEach(setupDefaults);

  const mockDryRun = {
    files: [
      {
        name: "invoice.pdf",
        size: 204800,
        is_directory: false,
        file_count: 1,
        path: "/docs/invoice.pdf",
        warning: null,
      },
      {
        name: "huge.iso",
        size: 2 * 1024 * 1024 * 1024,
        is_directory: false,
        file_count: 1,
        path: "/docs/huge.iso",
        warning: "Large file: 2.00 GB - may take several minutes",
      },
    ],
    total_size: 2 * 1024 * 1024 * 1024 + 204800,
    total_file_count: 2,
    warnings: ["huge.iso: Large file: 2.00 GB - may take several minutes"],
    blocked: [],
  };

  it("calls dry_run_shred and displays file list", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "dry_run_shred"
        ? Promise.resolve(mockDryRun)
        : Promise.resolve(null),
    );
    mockOpen.mockResolvedValue(["/docs/invoice.pdf", "/docs/huge.iso"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    await waitFor(() =>
      expect(screen.getByText("Preview")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Preview"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("dry_run_shred", {
        paths: ["/docs/invoice.pdf", "/docs/huge.iso"],
      });
      expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
      expect(screen.getByText("huge.iso")).toBeInTheDocument();
    });
  });

  it("shows file warnings from the dry run", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "dry_run_shred"
        ? Promise.resolve(mockDryRun)
        : Promise.resolve(null),
    );
    mockOpen.mockResolvedValue(["/docs/huge.iso"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText("Preview"));

    await waitFor(() => {
      // "Large file" text appears in both the top-level warnings box and the
      // per-file warning row; just assert at least one is present.
      expect(screen.getAllByText(/Large file/).length).toBeGreaterThan(0);
    });
  });

  it("shows blocked files in the error banner", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "dry_run_shred"
        ? Promise.resolve({
            ...mockDryRun,
            blocked: ["/etc/passwd: protected system directory"],
          })
        : Promise.resolve(null),
    );
    mockOpen.mockResolvedValue(["/etc/passwd"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText("Preview"));

    await waitFor(() => {
      const banner = screen.getByTestId("error-banner");
      expect(banner.textContent).toMatch(/1 file\(s\) blocked/i);
    });
  });

  it("can go back from preview without shredding", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "dry_run_shred"
        ? Promise.resolve(mockDryRun)
        : Promise.resolve(null),
    );
    mockOpen.mockResolvedValue(["/docs/invoice.pdf"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText("Preview"));
    await waitFor(() => expect(screen.getByText("Back")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Back"));

    await waitFor(() => {
      expect(
        screen.queryByText("Preview: Files to be Shredded"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 6 — Shred Execution
// ───────────────────────────────────────────────────────────────────────────

describe("Shred execution", () => {
  beforeEach(setupDefaults);

  it("shows confirmation modal before shredding", async () => {
    mockOpen.mockResolvedValue(["/private/key.pem"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));

    await waitFor(() => {
      expect(
        screen.getByText("Confirm Permanent Deletion"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Permanently destroy 1 file\?/i),
      ).toBeInTheDocument();
    });
  });

  it("calls batch_shred_files with correct arguments on confirm", async () => {
    mockOpen.mockResolvedValue(["/private/key.pem"]);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "batch_shred_files"
        ? Promise.resolve({
            success: ["/private/key.pem"],
            failed: [],
            total_files: 1,
            total_bytes_shredded: 4096,
          })
        : Promise.resolve(null),
    );
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    await waitFor(() =>
      expect(screen.getByText("Yes, Shred Forever")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Shred Forever"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("batch_shred_files", {
        paths: ["/private/key.pem"],
        method: "dod3pass",
      });
    });
  });

  it("dismisses confirmation modal on Cancel", async () => {
    mockOpen.mockResolvedValue(["/private/key.pem"]);
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    await waitFor(() =>
      expect(
        screen.getByText("Confirm Permanent Deletion"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByText("Confirm Permanent Deletion"),
      ).not.toBeInTheDocument();
    });
  });

  it("displays the success result screen", async () => {
    mockOpen.mockResolvedValue(["/tmp/data.bin"]);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "batch_shred_files"
        ? Promise.resolve({
            success: ["/tmp/data.bin"],
            failed: [],
            total_files: 1,
            total_bytes_shredded: 1048576,
          })
        : Promise.resolve(null),
    );
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));

    await waitFor(() => {
      expect(screen.getByText("Shredding Complete!")).toBeInTheDocument();
      expect(screen.getByText("1 MB")).toBeInTheDocument();
    });
  });

  it("displays partial success when some files fail", async () => {
    mockOpen.mockResolvedValue(["/tmp/ok.txt", "/tmp/bad.txt"]);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "batch_shred_files"
        ? Promise.resolve({
            success: ["/tmp/ok.txt"],
            failed: [{ path: "/tmp/bad.txt", error: "File is read-only" }],
            total_files: 2,
            total_bytes_shredded: 512,
          })
        : Promise.resolve(null),
    );
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 2 Files/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));

    await waitFor(() => {
      expect(screen.getByText("Partial Success")).toBeInTheDocument();
      expect(screen.getByText(/Failed to shred 1 file/i)).toBeInTheDocument();
      // The error div renders "• File is read-only" — match with regex
      expect(screen.getByText(/File is read-only/)).toBeInTheDocument();
    });
  });

  it("displays a total failure state", async () => {
    mockOpen.mockResolvedValue(["/system/protected.bin"]);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "batch_shred_files"
        ? Promise.resolve({
            success: [],
            failed: [
              {
                path: "/system/protected.bin",
                error: "protected system directory",
              },
            ],
            total_files: 1,
            total_bytes_shredded: 0,
          })
        : Promise.resolve(null),
    );
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));

    await waitFor(() => {
      expect(screen.getByText("Shredding Failed")).toBeInTheDocument();
    });
  });

  it("shows an error banner when invoke throws", async () => {
    mockOpen.mockResolvedValue(["/tmp/file.txt"]);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "batch_shred_files"
        ? Promise.reject(new Error("permission denied"))
        : Promise.resolve(null),
    );
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));

    await waitFor(() => {
      expect(screen.getByText(/Shredding failed/i)).toBeInTheDocument();
    });
  });

  it("calls cancel_shred when Cancel is clicked during shredding", async () => {
    let resolveShred!: (v: unknown) => void;
    mockOpen.mockResolvedValue(["/tmp/slow.bin"]);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "batch_shred_files")
        return new Promise((res) => {
          resolveShred = res;
        });
      return Promise.resolve(null);
    });

    renderShredder();
    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));

    const progressListener = mockListen.mock.calls.find(
      ([event]: [string]) => event === "shred-progress",
    )?.[1];

    act(() => {
      progressListener?.({
        payload: {
          current_file: 1,
          total_files: 1,
          current_pass: 1,
          total_passes: 3,
          current_file_name: "slow.bin",
          percentage: 10,
          bytes_processed: 1000,
          total_bytes: 10000,
        },
      });
    });

    // Use getByRole to reliably find the Cancel button (avoids any ambiguity
    // with text matching when "Cancel" might appear in multiple contexts).
    const progressCard = await screen.findByTestId("progress-card");
    await waitFor(() =>
      expect(within(progressCard).getByText("Cancel")).toBeInTheDocument(),
    );
    fireEvent.click(within(progressCard).getByText("Cancel"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("cancel_shred");
    });

    resolveShred({
      success: [],
      failed: [],
      total_files: 1,
      total_bytes_shredded: 0,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 7 — Progress Display
// ───────────────────────────────────────────────────────────────────────────

describe("Progress display", () => {
  beforeEach(setupDefaults);

  it("renders pass and file counters from progress event", async () => {
    let resolveShred!: (v: unknown) => void;
    mockOpen.mockResolvedValue(["/tmp/large.bin"]);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "batch_shred_files")
        return new Promise((res) => {
          resolveShred = res;
        });
      return Promise.resolve(null);
    });

    renderShredder();
    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));

    const progressListener = mockListen.mock.calls.find(
      ([event]: [string]) => event === "shred-progress",
    )?.[1];

    act(() => {
      progressListener?.({
        payload: {
          current_file: 1,
          total_files: 1,
          current_pass: 2,
          total_passes: 3,
          current_file_name: "large.bin",
          percentage: 66,
          bytes_processed: 6600,
          total_bytes: 10000,
        },
      });
    });

    // The component renders progress as a single template-literal text node:
    // "File 1 of 1 · Pass 2 of 3"
    await waitFor(() => {
      const counter = screen.getByTestId("progress-counter");
      expect(counter.textContent).toMatch(/File 1 of 1/);
      expect(counter.textContent).toMatch(/Pass 2 of 3/);
      expect(screen.getByText("large.bin")).toBeInTheDocument();
    });

    resolveShred({
      success: [],
      failed: [],
      total_files: 1,
      total_bytes_shredded: 0,
    });
  });

  it("shows cumulative bytes_processed (not per-file reset)", async () => {
    let resolveShred!: (v: unknown) => void;
    mockOpen.mockResolvedValue(["/tmp/a.bin", "/tmp/b.bin"]);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "batch_shred_files")
        return new Promise((res) => {
          resolveShred = res;
        });
      return Promise.resolve(null);
    });

    renderShredder();
    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 2 Files/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));

    const progressListener = mockListen.mock.calls.find(
      ([event]: [string]) => event === "shred-progress",
    )?.[1];

    act(() => {
      progressListener?.({
        payload: {
          current_file: 2,
          total_files: 2,
          current_pass: 1,
          total_passes: 3,
          current_file_name: "b.bin",
          percentage: 55,
          bytes_processed: 4000, // formatSize(4000) = "3.91 KB"
          total_bytes: 6000, // formatSize(6000) = "5.86 KB"
        },
      });
    });

    await waitFor(() => {
      const bytes = screen.getByTestId("progress-bytes");
      expect(bytes.textContent).toMatch(/3.91 KB of 5.86 KB processed/);
    });

    resolveShred({
      success: [],
      failed: [],
      total_files: 2,
      total_bytes_shredded: 0,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 8 — Drive Maintenance (Wipe Free Space)
// ───────────────────────────────────────────────────────────────────────────

describe("Drive Maintenance — Wipe Free Space", () => {
  beforeEach(setupDefaults);

  it("renders the Drive Maintenance section", async () => {
    renderShredder();
    await switchToDriveMaintenance();
    expect(screen.getByText("Wipe Free Space")).toBeInTheDocument();
  });

  it("shows path input for wipe free space", async () => {
    renderShredder();
    await switchToDriveMaintenance();
    // Placeholder in component: "e.g. /home  or  C:\\"
    expect(screen.getByPlaceholderText(/e\.g\. \/home/i)).toBeInTheDocument();
  });

  it("shows an error if wipe is clicked without a path", async () => {
    renderShredder();
    await switchToDriveMaintenance();

    // The button label is "Wipe", not "Wipe Free Space"
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));

    await waitFor(() => {
      const banner = screen.getByTestId("error-banner");
      expect(banner.textContent).toMatch(
        /Please enter a drive or folder path/i,
      );
    });
  });

  it("shows confirmation modal before wiping", async () => {
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/home/i), {
      target: { value: "/home/user" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));

    await waitFor(() => {
      expect(screen.getByText("Confirm Free Space Wipe")).toBeInTheDocument();
      expect(screen.getByText("/home/user")).toBeInTheDocument();
    });
  });

  it("calls wipe_free_space with correct path on confirm", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "wipe_free_space"
        ? Promise.resolve({
            bytes_wiped: 10 * 1024 * 1024 * 1024,
            target_path: "/home/user",
          })
        : Promise.resolve(null),
    );
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/home/i), {
      target: { value: "/home/user" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    await waitFor(() =>
      expect(screen.getByText("Confirm Free Space Wipe")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Wipe Free Space"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("wipe_free_space", {
        drivePath: "/home/user",
      });
    });
  });

  it("displays the wipe result on success", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "wipe_free_space"
        ? Promise.resolve({
            bytes_wiped: 5 * 1024 * 1024 * 1024,
            target_path: "/mnt/hdd",
          })
        : Promise.resolve(null),
    );
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/home/i), {
      target: { value: "/mnt/hdd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    await waitFor(() =>
      expect(screen.getByText("Confirm Free Space Wipe")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Wipe Free Space"));

    await waitFor(() => {
      expect(screen.getByText("Wipe Complete")).toBeInTheDocument();
      expect(screen.getByText(/5 GB/)).toBeInTheDocument();
    });
  });

  it("shows a wipe error when invoke throws", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "wipe_free_space"
        ? Promise.reject(new Error("path not found"))
        : Promise.resolve(null),
    );
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/home/i), {
      target: { value: "/nonexistent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    await waitFor(() =>
      expect(screen.getByText("Confirm Free Space Wipe")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Wipe Free Space"));

    await waitFor(() => {
      expect(screen.getByText(/Free-space wipe failed/i)).toBeInTheDocument();
    });
  });

  it("shows indeterminate wipe progress during operation", async () => {
    let resolveWipe!: (v: unknown) => void;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "wipe_free_space")
        return new Promise((res) => {
          resolveWipe = res;
        });
      return Promise.resolve(null);
    });
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/home/i), {
      target: { value: "/home" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Wipe" }));
    await waitFor(() =>
      expect(screen.getByText("Confirm Free Space Wipe")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Wipe Free Space"));

    const wipeListener = mockListen.mock.calls.find(
      ([event]: [string]) => event === "wipe-progress",
    )?.[1];

    act(() => {
      wipeListener?.({
        payload: { bytes_written: 500 * 1024 * 1024, phase: "Writing" },
      });
    });

    await waitFor(() => {
      const phase = screen.getByTestId("wipe-phase");
      expect(phase.textContent).toMatch(/Writing/i);
      expect(screen.getByText(/500 MB written/i)).toBeInTheDocument();
    });

    resolveWipe({ bytes_wiped: 500 * 1024 * 1024, target_path: "/home" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 9 — Drive Maintenance (TRIM)
// ───────────────────────────────────────────────────────────────────────────

describe("Drive Maintenance — TRIM", () => {
  beforeEach(setupDefaults);

  // NOTE: "TRIM Drive" is a card heading on the Drive Maintenance tab, NOT a
  // sub-tab. The old sub-tab design was replaced with two side-by-side cards.
  // All tests switch to Drive Maintenance first, then interact with the TRIM card.

  it("shows the TRIM Drive card on the Drive Maintenance tab", async () => {
    renderShredder();
    await switchToDriveMaintenance();

    expect(
      screen.getByRole("heading", { name: "TRIM Drive" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Run TRIM" }),
    ).toBeInTheDocument();
  });

  it("shows an error if TRIM is clicked without a path", async () => {
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));

    await waitFor(() => {
      const banner = screen.getByTestId("error-banner");
      expect(banner.textContent).toMatch(
        /Please enter a drive letter or mount point/i,
      );
    });
  });

  it("shows the TRIM confirmation modal", async () => {
    renderShredder();
    await switchToDriveMaintenance();

    // Placeholder in component: "e.g. /  or  C"
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/ or C/i), {
      target: { value: "/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));

    await waitFor(() => {
      expect(screen.getByText("Confirm TRIM")).toBeInTheDocument();
    });
  });

  it("calls trim_drive with the correct path on confirm", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "trim_drive"
        ? Promise.resolve({
            success: true,
            drive: "/",
            message: "TRIM completed successfully.",
          })
        : Promise.resolve(null),
    );
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/ or C/i), {
      target: { value: "/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
    await waitFor(() =>
      expect(screen.getByText("Confirm TRIM")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Run TRIM"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("trim_drive", { drivePath: "/" });
    });
  });

  it("displays the TRIM result message on success", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "trim_drive"
        ? Promise.resolve({
            success: true,
            drive: "/",
            message: "TRIM completed successfully.",
          })
        : Promise.resolve(null),
    );
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/ or C/i), {
      target: { value: "/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
    await waitFor(() =>
      expect(screen.getByText("Confirm TRIM")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Run TRIM"));

    await waitFor(() => {
      expect(screen.getByText("TRIM Complete")).toBeInTheDocument();
      expect(
        screen.getByText("TRIM completed successfully."),
      ).toBeInTheDocument();
    });
  });

  it("displays macOS automatic TRIM message", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "trim_drive"
        ? Promise.resolve({
            success: true,
            drive: "/",
            message:
              "macOS manages TRIM automatically for compatible SSDs. No manual action is required.",
          })
        : Promise.resolve(null),
    );
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/ or C/i), {
      target: { value: "/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
    await waitFor(() =>
      expect(screen.getByText("Confirm TRIM")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Run TRIM"));

    await waitFor(() => {
      expect(
        screen.getByText(/macOS manages TRIM automatically/i),
      ).toBeInTheDocument();
    });
  });

  it("shows a TRIM error when invoke throws", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "trim_drive"
        ? Promise.reject(new Error("fstrim failed: operation not permitted"))
        : Promise.resolve(null),
    );
    renderShredder();
    await switchToDriveMaintenance();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/ or C/i), {
      target: { value: "/home" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run TRIM" }));
    await waitFor(() =>
      expect(screen.getByText("Confirm TRIM")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Yes, Run TRIM"));

    await waitFor(() => {
      expect(screen.getByText(/TRIM failed/i)).toBeInTheDocument();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 10 — Error Banner
// ───────────────────────────────────────────────────────────────────────────

describe("Error banner", () => {
  beforeEach(setupDefaults);

  it("can be dismissed by clicking X", async () => {
    mockOpen.mockResolvedValue(["/tmp/file.txt"]);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "batch_shred_files"
        ? Promise.reject(new Error("disk error"))
        : Promise.resolve(null),
    );
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));

    await waitFor(() =>
      expect(screen.getByText(/Shredding failed/i)).toBeInTheDocument(),
    );

    // ErrorBanner has a <button> wrapping the X icon — click the button,
    // not the SVG itself (which is not the interactive element).
    const banner = screen.getByTestId("error-banner");
    fireEvent.click(banner.querySelector("button")!);

    await waitFor(() => {
      expect(screen.queryByText(/Shredding failed/i)).not.toBeInTheDocument();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SECTION 11 — "Shred More Files" resets state
// ───────────────────────────────────────────────────────────────────────────

describe("Post-shred reset", () => {
  beforeEach(setupDefaults);

  it("returns to the drop zone after clicking 'Shred More Files'", async () => {
    mockOpen.mockResolvedValue(["/tmp/done.txt"]);
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "batch_shred_files"
        ? Promise.resolve({
            success: ["/tmp/done.txt"],
            failed: [],
            total_files: 1,
            total_bytes_shredded: 100,
          })
        : Promise.resolve(null),
    );
    renderShredder();

    fireEvent.click(screen.getByText(/Select Files/i));
    fireEvent.click(await screen.findByText(/Shred 1 File/i));
    fireEvent.click(await screen.findByText("Yes, Shred Forever"));
    await waitFor(() =>
      expect(screen.getByText("Shredding Complete!")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Shred More Files"));

    await waitFor(() => {
      expect(
        screen.getByText("Drop files here or click to browse."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Shredding Complete!")).not.toBeInTheDocument();
    });
  });
});
