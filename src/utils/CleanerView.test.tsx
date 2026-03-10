/**
 * CleanerView.test.tsx
 *
 * Jest + React Testing Library test suite for the Metadata Cleaner UI.
 *
 * Run with:  npm test -- --testPathPattern=CleanerView
 *
 * Dependencies required in package.json:
 *   @testing-library/react
 *   @testing-library/user-event
 *   @testing-library/jest-dom
 *   jest-environment-jsdom
 */

import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { CleanerView, formatSize } from "../components/views/CleanerView";

// ─── Mock: Tauri core (invoke) ────────────────────────────────────────────────

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}));

// ─── Mock: Tauri event (listen) ───────────────────────────────────────────────

// Expose a handle so tests can manually fire progress events.
let progressCallback: ((event: { payload: unknown }) => void) | null = null;

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn((eventName: string, cb: (e: unknown) => void) => {
    if (eventName === "clean-metadata-progress") {
      progressCallback = cb as (event: { payload: unknown }) => void;
    }
    // Return a mock unlisten function wrapped in a Promise
    return Promise.resolve(jest.fn());
  }),
}));

// ─── Mock: Tauri dialog (open) ────────────────────────────────────────────────

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}));

// ─── Mock: useDragDrop hook ───────────────────────────────────────────────────

jest.mock("../hooks/useDragDrop", () => ({
  useDragDrop: jest.fn().mockReturnValue({ isDragging: false }),
}));

// ─── Typed helpers ────────────────────────────────────────────────────────────

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const mockInvoke = invoke as jest.MockedFunction<typeof invoke>;
const mockOpen = open as jest.MockedFunction<typeof open>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_REPORT_CLEAN = {
  has_gps: false,
  has_author: false,
  camera_info: undefined,
  software_info: undefined,
  creation_date: undefined,
  gps_info: undefined,
  file_type: "Image",
  file_size: 204800,
  raw_tags: [],
  app_info: undefined,
};

const MOCK_REPORT_WITH_GPS = {
  has_gps: true,
  has_author: true,
  camera_info: "Canon EOS R5",
  software_info: "Adobe Lightroom",
  creation_date: "2023-10-25T14:30:00",
  gps_info: "51.5074 N, 0.1278 W",
  file_type: "Image",
  file_size: 5242880,
  raw_tags: [
    { key: "GPSLatitude", value: "51.5074 N" },
    { key: "GPSLongitude", value: "0.1278 W" },
    { key: "Model", value: "Canon EOS R5" },
    { key: "Software", value: "Adobe Lightroom" },
    { key: "DateTime", value: "2023:10:25 14:30:00" },
  ],
  app_info: undefined,
};

const MOCK_REPORT_OFFICE = {
  has_gps: false,
  has_author: true,
  camera_info: undefined,
  software_info: "Microsoft Office / OpenXML",
  creation_date: "2023-10-25T14:30:00Z",
  gps_info: undefined,
  file_type: "Office Document",
  file_size: 102400,
  raw_tags: [
    { key: "Creator", value: "Jane Doe" },
    { key: "Company", value: "ACME Corp" },
    { key: "Created", value: "2023-10-25T14:30:00Z" },
  ],
  app_info: "Microsoft Office Word",
};

const MOCK_CLEAN_RESULT: {
  success: string[];
  failed: { path: string; error: string }[];
  total_files: number;
  size_before: number;
  size_after: number;
} = {
  success: ["/output/photo_clean.jpg"],
  failed: [],
  total_files: 1,
  size_before: 5242880,
  size_after: 5200000,
};

const MOCK_COMPARISON = {
  original_size: 5242880,
  cleaned_size: 5200000,
  removed_tags: [
    "GPSLatitude: 51.5074 N",
    "GPSLongitude: 0.1278 W",
    "Model: Canon EOS R5",
  ],
  size_reduction: 42880,
};

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  progressCallback = null;
  // Default: analyze returns a clean report; batch_clean returns a clean success
  mockInvoke.mockImplementation((cmd) => {
    if (cmd === "analyze_file_metadata")
      return Promise.resolve(MOCK_REPORT_CLEAN);
    if (cmd === "batch_clean_metadata")
      return Promise.resolve(MOCK_CLEAN_RESULT);
    return Promise.resolve(null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: formatSize
// ═════════════════════════════════════════════════════════════════════════════

describe("formatSize", () => {
  test("formats 0 bytes", () => {
    expect(formatSize(0)).toBe("0 Bytes");
  });

  test("formats bytes", () => {
    expect(formatSize(512)).toBe("512 Bytes");
  });

  test("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(2048)).toBe("2 KB");
  });

  test("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1 MB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5 MB");
  });

  test("formats gigabytes", () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe("1 GB");
  });

  test("rounds to 2 decimal places", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENT TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe("CleanerView", () => {
  // ─── Initial render ────────────────────────────────────────────────────

  describe("initial render", () => {
    test("shows drop zone when no files are loaded", () => {
      render(<CleanerView />);
      expect(screen.getByText("Drag & Drop Files")).toBeInTheDocument();
      expect(screen.getByText("Select Files")).toBeInTheDocument();
    });

    test("shows supported file types in the drop zone", () => {
      render(<CleanerView />);
      expect(
        screen.getByText(/JPG, PNG, WebP, TIFF, PDF, DOCX, XLSX, PPTX, ZIP/i),
      ).toBeInTheDocument();
    });

    test("does not show file list or footer before files are added", () => {
      render(<CleanerView />);
      expect(screen.queryByText(/Files \(/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Clean \d+ File/)).not.toBeInTheDocument();
    });

    test("does not show result panel initially", () => {
      render(<CleanerView />);
      expect(screen.queryByText("Cleaning Complete!")).not.toBeInTheDocument();
    });
  });

  // ─── File addition ─────────────────────────────────────────────────────

  describe("file management", () => {
    test("adds files from browse dialog", async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);

      await userEvent.click(screen.getByText("Select Files"));

      await waitFor(() => {
        expect(screen.getAllByText("photo.jpg").length).toBeGreaterThan(0);
      });
    });

    test("deduplicates files added via multiple browse sessions", async () => {
      render(<CleanerView />);

      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));

      // Add the same file again via "Add More Files"
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Add More Files"));
      await waitFor(() => {
        // The file-list header shows the count — should stay at 1, not become 2.
        expect(screen.getByText("Files (1)")).toBeInTheDocument();
      });
    });

    test("triggers analysis for the first file added", async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);

      await userEvent.click(screen.getByText("Select Files"));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("analyze_file_metadata", {
          path: "/home/user/photo.jpg",
        });
      });
    });

    test("can remove a file from the list", async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce([
        "/home/user/photo.jpg",
        "/home/user/doc.docx",
      ]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));

      // Click the remove button on the first file
      const removeButtons = screen.getAllByTitle("Remove");
      await userEvent.click(removeButtons[0]);

      expect(screen.queryByText("photo.jpg")).not.toBeInTheDocument();
      expect(screen.getAllByText("doc.docx")[0]).toBeInTheDocument();
    });

    test("returns to empty state when all files are removed via clear-all", async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));

      await userEvent.click(screen.getByTitle("Clear all"));

      await waitFor(() => {
        expect(screen.getByText("Drag & Drop Files")).toBeInTheDocument();
      });
    });

    test("shows file counter in header", async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce([
        "/home/user/a.jpg",
        "/home/user/b.jpg",
        "/home/user/c.jpg",
      ]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getByText("Files (3)")).toBeInTheDocument();
      });
    });
  });

  // ─── Navigation ────────────────────────────────────────────────────────

  describe("file navigation", () => {
    beforeEach(async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/a.jpg", "/home/user/b.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("a.jpg"));
    });

    test("shows navigation controls when multiple files are loaded", () => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    test("next button advances preview and re-triggers analysis", async () => {
      // Scope to the pagination container (the parent of the "1 / 2" counter)
      // so we don't accidentally match Remove or Clear All icon buttons.
      const paginationContainer = screen.getByText("1 / 2").parentElement!;
      const [, nextButton] = within(paginationContainer).getAllByRole("button");

      await userEvent.click(nextButton);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("analyze_file_metadata", {
          path: "/home/user/b.jpg",
        });
      });
    });

    test("clicking a file in the list triggers its analysis", async () => {
      const docItem = screen.getAllByText("b.jpg")[0];
      await userEvent.click(docItem);
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("analyze_file_metadata", {
          path: "/home/user/b.jpg",
        });
      });
    });

    test("does not re-analyze a cached file", async () => {
      // First analyze b.jpg
      await userEvent.click(screen.getAllByText("b.jpg")[0]);
      await waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith("analyze_file_metadata", {
          path: "/home/user/b.jpg",
        }),
      );

      const callCountAfterFirst = mockInvoke.mock.calls.length;

      // Navigate back to a.jpg then back to b.jpg
      await userEvent.click(screen.getAllByText("a.jpg")[0]);
      await userEvent.click(screen.getAllByText("b.jpg")[0]);

      // Should NOT have called analyze_file_metadata for b.jpg again
      const newCalls = mockInvoke.mock.calls.slice(callCountAfterFirst);
      const reAnalyseCalls = newCalls.filter(
        ([cmd, args]) =>
          cmd === "analyze_file_metadata" &&
          (args as { path: string }).path === "/home/user/b.jpg",
      );
      expect(reAnalyseCalls).toHaveLength(0);
    });
  });

  // ─── Metadata preview ──────────────────────────────────────────────────

  describe("metadata preview", () => {
    test("shows 'No metadata detected' for a clean file", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_CLEAN);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/clean.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getByText("No metadata detected")).toBeInTheDocument();
      });
    });

    test("displays GPS badge for files with location data", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_WITH_GPS);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getAllByText("GPS Location")[0]).toBeInTheDocument();
        expect(screen.getByText("51.5074 N, 0.1278 W")).toBeInTheDocument();
      });
    });

    test("displays Author Info badge", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_WITH_GPS);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getAllByText("Author Info")[0]).toBeInTheDocument();
      });
    });

    test("displays Camera badge with model name", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_WITH_GPS);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getByText("Camera")).toBeInTheDocument();
        expect(screen.getByText("Canon EOS R5")).toBeInTheDocument();
      });
    });

    test("displays Created date badge", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_WITH_GPS);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getByText("Created")).toBeInTheDocument();
        expect(screen.getByText("2023-10-25T14:30:00")).toBeInTheDocument();
      });
    });

    test("displays Application badge for Office files", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_OFFICE);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/doc.docx"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getByText("Application")).toBeInTheDocument();
        expect(screen.getByText("Microsoft Office Word")).toBeInTheDocument();
      });
    });

    test("shows and hides raw tags panel", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_WITH_GPS);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("GPS Location"));

      // Raw tags initially hidden
      expect(screen.queryByText("GPSLatitude:")).not.toBeInTheDocument();

      // Open raw tags
      await userEvent.click(screen.getByText(/Show Raw Tags/));
      await waitFor(() => {
        expect(screen.getByText("GPSLatitude:")).toBeInTheDocument();
      });

      // Close raw tags
      await userEvent.click(screen.getByText(/Hide Raw Tags/));
      await waitFor(() => {
        expect(screen.queryByText("GPSLatitude:")).not.toBeInTheDocument();
      });
    });

    test("raw tag filter narrows displayed tags", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_WITH_GPS);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("GPS Location"));

      await userEvent.click(screen.getByText(/Show Raw Tags/));
      await waitFor(() => screen.getByText("GPSLatitude:"));

      const filterInput = screen.getByPlaceholderText("Filter tags…");
      await userEvent.type(filterInput, "GPS");

      // Should show GPS tags but not Model or DateTime
      expect(screen.getByText("GPSLatitude:")).toBeInTheDocument();
      expect(screen.getByText("GPSLongitude:")).toBeInTheDocument();
      expect(screen.queryByText("Model:")).not.toBeInTheDocument();
    });

    test("shows 'no tags match' message when filter has no results", async () => {
      mockInvoke.mockResolvedValue(MOCK_REPORT_WITH_GPS);
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("GPS Location"));

      await userEvent.click(screen.getByText(/Show Raw Tags/));
      const filterInput = screen.getByPlaceholderText("Filter tags…");
      await userEvent.type(filterInput, "xyzzy_does_not_exist");

      await waitFor(() => {
        expect(
          screen.getByText(/No tags match "xyzzy_does_not_exist"/),
        ).toBeInTheDocument();
      });
    });
  });

  // ─── Cleaning options ──────────────────────────────────────────────────

  describe("cleaning options", () => {
    beforeEach(async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));
    });

    test("all checkboxes are checked by default", () => {
      const checkboxes = screen.getAllByRole("checkbox");
      checkboxes.forEach((cb) => expect(cb).toBeChecked());
    });

    test("can uncheck GPS option", async () => {
      const checkboxes = screen.getAllByRole("checkbox");
      await userEvent.click(checkboxes[0]); // GPS
      expect(checkboxes[0]).not.toBeChecked();
    });

    test("can uncheck Author option", async () => {
      const checkboxes = screen.getAllByRole("checkbox");
      await userEvent.click(checkboxes[1]); // Author
      expect(checkboxes[1]).not.toBeChecked();
    });

    test("can uncheck Date option", async () => {
      const checkboxes = screen.getAllByRole("checkbox");
      await userEvent.click(checkboxes[2]); // Date
      expect(checkboxes[2]).not.toBeChecked();
    });

    test("passes selected options to batch_clean_metadata", async () => {
      const checkboxes = screen.getAllByRole("checkbox");
      await userEvent.click(checkboxes[0]); // Uncheck GPS

      await userEvent.click(screen.getByText(/^Clean \d+ File/));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          "batch_clean_metadata",
          expect.objectContaining({
            options: { gps: false, author: true, date: true },
          }),
        );
      });
    });
  });

  // ─── Output directory ──────────────────────────────────────────────────

  describe("output directory", () => {
    beforeEach(async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));
    });

    test("shows default directory hint when no output dir selected", () => {
      expect(
        screen.getByText(
          /Files will be saved in same directory with "_clean" suffix/,
        ),
      ).toBeInTheDocument();
    });

    test("shows selected output directory path", async () => {
      mockOpen.mockResolvedValueOnce("/home/user/output");
      await userEvent.click(screen.getByText("Select Output Directory"));
      await waitFor(() => {
        expect(screen.getByText("/home/user/output")).toBeInTheDocument();
      });
    });

    test("passes output directory to batch_clean_metadata", async () => {
      mockOpen.mockResolvedValueOnce("/home/user/output");
      await userEvent.click(screen.getByText("Select Output Directory"));
      await waitFor(() => screen.getByText("/home/user/output"));

      await userEvent.click(screen.getByText(/^Clean \d+ File/));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          "batch_clean_metadata",
          expect.objectContaining({ outputDir: "/home/user/output" }),
        );
      });
    });
  });

  // ─── Cleaning progress ─────────────────────────────────────────────────

  describe("cleaning progress", () => {
    test("shows progress UI while cleaning is in flight", async () => {
      // Make batch_clean hang so we can inspect the in-progress state
      let resolveClean!: (v: unknown) => void;
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === "analyze_file_metadata")
          return Promise.resolve(MOCK_REPORT_CLEAN);
        if (cmd === "batch_clean_metadata")
          return new Promise((res) => {
            resolveClean = res;
          });
        return Promise.resolve(null);
      });

      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));

      await userEvent.click(screen.getByText(/^Clean \d+ File/));

      // Manually fire a progress event
      act(() => {
        progressCallback?.({
          payload: {
            current: 1,
            total: 2,
            current_file: "photo.jpg",
            percentage: 50,
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Cleaning Metadata...")).toBeInTheDocument();
        expect(screen.getByText(/50%/)).toBeInTheDocument();
        expect(screen.getAllByText("photo.jpg").length).toBeGreaterThan(0);
      });

      // Clean up: resolve the hanging promise
      act(() => resolveClean(MOCK_CLEAN_RESULT));
    });

    test("shows Cancel button during cleaning and calls cancel command", async () => {
      let resolveClean!: (v: unknown) => void;
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === "analyze_file_metadata")
          return Promise.resolve(MOCK_REPORT_CLEAN);
        if (cmd === "batch_clean_metadata")
          return new Promise((res) => {
            resolveClean = res;
          });
        if (cmd === "cancel_metadata_clean") return Promise.resolve(null);
        return Promise.resolve(null);
      });

      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));

      await userEvent.click(screen.getByText(/^Clean \d+ File/));

      act(() => {
        progressCallback?.({
          payload: {
            current: 0,
            total: 1,
            current_file: "photo.jpg",
            percentage: 0,
          },
        });
      });

      await waitFor(() => screen.getByText("Cancel"));
      await userEvent.click(screen.getByText("Cancel"));

      expect(mockInvoke).toHaveBeenCalledWith("cancel_metadata_clean");

      act(() => resolveClean(MOCK_CLEAN_RESULT));
    });
  });

  // ─── Cleaning result ───────────────────────────────────────────────────

  describe("cleaning result", () => {
    async function runCleanAndWaitForResult(
      paths = ["/home/user/photo.jpg"],
      result = MOCK_CLEAN_RESULT,
    ) {
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === "analyze_file_metadata")
          return Promise.resolve(MOCK_REPORT_CLEAN);
        if (cmd === "batch_clean_metadata") return Promise.resolve(result);
        return Promise.resolve(null);
      });
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(paths);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText(paths[0].split("/").pop()!));
      await userEvent.click(screen.getByText(/^Clean \d+ File/));
      await waitFor(() => screen.getByText("Cleaning Complete!"));
    }

    test("shows success count and size reduction", async () => {
      await runCleanAndWaitForResult();
      expect(screen.getByText("1")).toBeInTheDocument();
      // Size reduction = 5242880 - 5200000 = 42880 bytes = 41.88 KB
      expect(screen.getByText(/KB/)).toBeInTheDocument();
    });

    test("shows before/after sizes", async () => {
      await runCleanAndWaitForResult();
      expect(screen.getByText(/Before:/)).toBeInTheDocument();
      expect(screen.getByText(/After:/)).toBeInTheDocument();
    });

    test("shows cleaned filenames list", async () => {
      await runCleanAndWaitForResult();
      expect(screen.getByText("photo_clean.jpg")).toBeInTheDocument();
    });

    test("shows failure details when some files fail", async () => {
      const resultWithFailure = {
        ...MOCK_CLEAN_RESULT,
        failed: [
          { path: "/home/user/broken.jpg", error: "Invalid JPEG structure" },
        ],
      };
      await runCleanAndWaitForResult(
        ["/home/user/photo.jpg"],
        resultWithFailure,
      );
      expect(
        screen.getByText("Failed to clean 1 file(s):"),
      ).toBeInTheDocument();
      expect(screen.getByText("broken.jpg")).toBeInTheDocument();
      expect(screen.getByText("• Invalid JPEG structure")).toBeInTheDocument();
    });

    test('"Clean More Files" returns to the empty state', async () => {
      await runCleanAndWaitForResult();
      await userEvent.click(screen.getByText("Clean More Files"));
      await waitFor(() => {
        expect(screen.getByText("Drag & Drop Files")).toBeInTheDocument();
      });
    });

    test("lazy-loads comparison data when 'What was removed?' is clicked", async () => {
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === "analyze_file_metadata")
          return Promise.resolve(MOCK_REPORT_CLEAN);
        if (cmd === "batch_clean_metadata")
          return Promise.resolve(MOCK_CLEAN_RESULT);
        if (cmd === "compare_file_metadata")
          return Promise.resolve(MOCK_COMPARISON);
        return Promise.resolve(null);
      });

      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));
      await userEvent.click(screen.getByText(/^Clean \d+ File/));
      await waitFor(() => screen.getByText("Cleaning Complete!"));

      await userEvent.click(screen.getByText("What was removed?"));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith(
          "compare_file_metadata",
          expect.objectContaining({
            original: "/home/user/photo.jpg",
            cleaned: "/output/photo_clean.jpg",
          }),
        );
        expect(screen.getByText(/3 tags removed/)).toBeInTheDocument();
        expect(
          screen.getByText("• GPSLatitude: 51.5074 N"),
        ).toBeInTheDocument();
      });
    });

    test("shows '✓ No tags found' when comparison returns empty removed_tags", async () => {
      const emptyCmp = {
        ...MOCK_COMPARISON,
        removed_tags: [],
        size_reduction: 0,
      };
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === "analyze_file_metadata")
          return Promise.resolve(MOCK_REPORT_CLEAN);
        if (cmd === "batch_clean_metadata")
          return Promise.resolve(MOCK_CLEAN_RESULT);
        if (cmd === "compare_file_metadata") return Promise.resolve(emptyCmp);
        return Promise.resolve(null);
      });

      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));
      await userEvent.click(screen.getByText(/^Clean \d+ File/));
      await waitFor(() => screen.getByText("Cleaning Complete!"));

      await userEvent.click(screen.getByText("What was removed?"));
      await waitFor(() => {
        expect(
          screen.getByText("✓ No tags found to remove"),
        ).toBeInTheDocument();
      });
    });
  });

  // ─── Error handling ────────────────────────────────────────────────────

  describe("error handling", () => {
    test("shows error banner when analysis fails", async () => {
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === "analyze_file_metadata")
          return Promise.reject("File not found");
        return Promise.resolve(null);
      });

      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));

      await waitFor(() => {
        expect(
          screen.getByText(/Analysis failed: File not found/),
        ).toBeInTheDocument();
      });
    });

    test("shows error banner when cleaning fails", async () => {
      mockInvoke.mockImplementation((cmd) => {
        if (cmd === "analyze_file_metadata")
          return Promise.resolve(MOCK_REPORT_CLEAN);
        if (cmd === "batch_clean_metadata")
          return Promise.reject("Disk write error");
        return Promise.resolve(null);
      });

      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));
      await userEvent.click(screen.getByText(/^Clean \d+ File/));

      await waitFor(() => {
        expect(
          screen.getByText(/Cleaning failed: Disk write error/),
        ).toBeInTheDocument();
      });
    });

    test("error banner can be dismissed", async () => {
      mockInvoke.mockRejectedValueOnce("oops"); // analysis fails

      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));

      await waitFor(() => screen.getByText(/Analysis failed: oops/));

      // The dismiss X button is inside the error banner
      const errorBanner =
        screen.getByText(/Analysis failed/).parentElement!.parentElement!;
      const xButton = within(errorBanner).getAllByRole("button")[0];
      await userEvent.click(xButton);

      await waitFor(() => {
        expect(screen.queryByText(/Analysis failed/)).not.toBeInTheDocument();
      });
    });

    test("shows error when browse dialog throws", async () => {
      mockOpen.mockRejectedValueOnce(new Error("Dialog cancelled"));

      render(<CleanerView />);
      await userEvent.click(screen.getByText("Select Files"));

      await waitFor(() => {
        expect(
          screen.getByText(/Failed to open file dialog/),
        ).toBeInTheDocument();
      });
    });
  });

  // ─── Clean button state ────────────────────────────────────────────────

  describe("clean button state", () => {
    test("Clean button is enabled when files are loaded and not cleaning", async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/photo.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => screen.getAllByText("photo.jpg"));

      const cleanButton = screen
        .getByText(/^Clean \d+ File/)
        .closest("button")!;
      expect(cleanButton).not.toBeDisabled();
    });

    test("Clean button label reflects file count", async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce([
        "/home/user/a.jpg",
        "/home/user/b.jpg",
        "/home/user/c.jpg",
      ]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getByText("Clean 3 Files")).toBeInTheDocument();
      });
    });

    test("Clean button is singular for one file", async () => {
      render(<CleanerView />);
      mockOpen.mockResolvedValueOnce(["/home/user/a.jpg"]);
      await userEvent.click(screen.getByText("Select Files"));
      await waitFor(() => {
        expect(screen.getByText("Clean 1 File")).toBeInTheDocument();
      });
    });
  });
});
