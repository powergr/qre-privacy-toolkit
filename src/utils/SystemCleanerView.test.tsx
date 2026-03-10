/**
 * SystemCleanerView.test.tsx
 *
 * Test dependencies (add to package.json devDependencies if not present):
 *   @testing-library/react, @testing-library/user-event,
 *   @testing-library/jest-dom, jest, ts-jest
 *
 * Both Tauri IPC (`@tauri-apps/api/core`) and the OS plugin
 * (`@tauri-apps/plugin-os`) are mocked so these tests run in Node/jsdom
 * with zero native dependencies.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SystemCleanerView } from "../components/views/SystemCleanerView";

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
// ─────────────────────────────────────────────────────────────────────────────

const mockInvoke = jest.fn();
const mockListen = jest.fn(() => Promise.resolve(() => {})); // returns an unlisten fn
let mockPlatform = jest.fn(() => "windows");

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: Parameters<typeof mockInvoke>) => mockInvoke(...args),
}));

jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: Parameters<typeof mockListen>) => mockListen(...args),
}));

jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

// formatSize and InfoModal are internal — stub lightly
jest.mock("../utils/formatting", () => ({
  formatSize: (bytes: number) => `${bytes}B`,
}));

jest.mock("../components/modals/AppModals", () => ({
  InfoModal: ({
    message,
    onClose,
  }: {
    message: string;
    onClose: () => void;
  }) => (
    <div data-testid="info-modal">
      <span>{message}</span>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

let junkCounter = 1;
const makeJunkItem = (overrides: any = {}) => {
  const id = overrides.id || `junk-${junkCounter++}`;
  return {
    id,
    name: "Windows Temp",
    path: overrides.path || `C:\\Temp\\${id}`,
    category: "System",
    size: 1024 * 1024 * 50, // 50 MB
    description: "Temporary system files",
    elevation_required: false,
    ...overrides,
  };
};

let regCounter = 1;
const makeRegistryItem = (overrides: any = {}) => {
  const id = overrides.id || `reg-${regCounter++}`;
  return {
    id,
    name: "OldApp",
    key_path: overrides.key_path || `HKCU\\Software\\${id}`,
    value_name: null,
    category: "InvalidAppPath",
    description: "OldApp missing",
    ...overrides,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Renders the component and waits for the async platform() call to settle. */
async function renderView() {
  const result = render(<SystemCleanerView />);
  await waitFor(() => {});
  return result;
}

/** Renders and clicks Scan Now, resolving the invoke with the given items. */
async function renderAndScan(items: any[]) {
  mockInvoke.mockResolvedValueOnce(items);
  const view = await renderView();
  fireEvent.click(screen.getByText("Scan Now"));
  await waitFor(() =>
    expect(screen.queryByText("Scanning System...")).not.toBeInTheDocument(),
  );
  return view;
}

/** Utility to guarantee at least one item is selected so action buttons are enabled. */
async function ensureItemsSelected() {
  await waitFor(() => {
    const checkboxes = screen.getAllByRole("checkbox");
    if (checkboxes.length > 1) {
      const firstItem = checkboxes[1] as HTMLInputElement;
      if (!firstItem.checked) {
        fireEvent.click(firstItem);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

const originalError = console.error;
beforeAll(() => {
  // Suppress React 18 act() warnings caused by async Tauri IPC resolves
  console.error = (...args) => {
    if (/was not wrapped in act/.test(args[0])) return;
    originalError.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
});

beforeEach(() => {
  jest.resetAllMocks();
  mockPlatform = jest.fn(() => "windows");
  mockListen.mockReturnValue(Promise.resolve(() => {}));
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Initial render
// ─────────────────────────────────────────────────────────────────────────────

describe("Initial render", () => {
  it("renders the page header", async () => {
    await renderView();
    expect(screen.getByText("System Cleaner")).toBeInTheDocument();
  });

  it("shows the Scan Now button before any scan", async () => {
    await renderView();
    expect(screen.getByText("Scan Now")).toBeInTheDocument();
  });

  it("does not show tabs before a scan", async () => {
    await renderView();
    expect(screen.queryByText("Browsers")).not.toBeInTheDocument();
    expect(screen.queryByText("Developer")).not.toBeInTheDocument();
  });

  it("does not show footer action buttons before a scan", async () => {
    await renderView();
    expect(screen.queryByText(/Preview/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Clean Selected/)).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Android platform guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Android platform guard", () => {
  it("shows the desktop-only message on Android", async () => {
    mockPlatform = jest.fn(() => "android");
    await renderView();
    expect(screen.getByText("Desktop Feature")).toBeInTheDocument();
  });

  it("shows the full UI on Windows", async () => {
    mockPlatform = jest.fn(() => "windows");
    await renderView();
    expect(screen.getByText("Scan Now")).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Scanning
// ─────────────────────────────────────────────────────────────────────────────

describe("Scanning", () => {
  it("calls scan_system_junk on click", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    expect(mockInvoke).toHaveBeenCalledWith("scan_system_junk");
  });

  it("shows empty state when scan returns no items", async () => {
    await renderAndScan([]);
    expect(screen.getByText("System is Clean")).toBeInTheDocument();
  });

  it("shows item list when scan returns results", async () => {
    const item = makeJunkItem({ name: "Windows Temp" });
    await renderAndScan([item]);
    expect(screen.getByText("Windows Temp")).toBeInTheDocument();
  });

  it("does not pre-select items by default (user chooses)", async () => {
    const systemItem = makeJunkItem({ category: "System" });
    const devItem = makeJunkItem({ category: "Developer", name: "NPM Cache" });
    await renderAndScan([systemItem, devItem]);

    await waitFor(() => {
      const checkboxes = screen.getAllByRole("checkbox");
      const itemCheckboxes = checkboxes.filter((c) => c !== checkboxes[0]);
      expect(itemCheckboxes[0]).not.toBeChecked(); // System item
    });
  });

  it("shows 0 selected items in the footer initially", async () => {
    const systemItem = makeJunkItem({ category: "System" });
    const privacyItem = makeJunkItem({
      category: "Privacy",
      path: "::CLEAR::",
    });
    await renderAndScan([systemItem, privacyItem]);

    await waitFor(() => {
      expect(screen.getByText(/0 total/)).toBeInTheDocument();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tab navigation
// ─────────────────────────────────────────────────────────────────────────────

describe("Tab navigation", () => {
  it("only renders tabs for categories that have items", async () => {
    const item = makeJunkItem({ category: "System" });
    await renderAndScan([item]);
    expect(screen.queryByText("Browsers")).not.toBeInTheDocument();
  });

  it("displays selected/total count badge on each tab", async () => {
    const item = makeJunkItem({ category: "System" });
    await renderAndScan([item]);

    await ensureItemsSelected();
    await waitFor(() => expect(screen.getByText("1/1")).toBeInTheDocument());
  });

  it("shows Developer warning banner when Developer tab is active", async () => {
    const devItem = makeJunkItem({ category: "Developer", name: "NPM Cache" });
    await renderAndScan([devItem]);
    fireEvent.click(screen.getByText("Developer"));
    expect(
      screen.getByText(/excluded from the default selection/),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Item selection
// ─────────────────────────────────────────────────────────────────────────────

describe("Item selection", () => {
  it("select-all checks all visible items in the current tab", async () => {
    const items = [
      makeJunkItem({ name: "Item A" }),
      makeJunkItem({ name: "Item B" }),
    ];
    await renderAndScan(items);

    const [selectAll] = screen.getAllByRole("checkbox");
    if (!(selectAll as HTMLInputElement).checked) {
      fireEvent.click(selectAll);
    }

    const allCheckboxes = screen.getAllByRole("checkbox");
    allCheckboxes.slice(1).forEach((cb) => expect(cb).toBeChecked());
  });

  it("select-all deselects all when all are already checked", async () => {
    const item = makeJunkItem();
    await renderAndScan([item]);

    await ensureItemsSelected();

    const [selectAll, itemCheckbox] = screen.getAllByRole("checkbox");
    expect(itemCheckbox).toBeChecked();

    fireEvent.click(selectAll); // deselect all
    expect(itemCheckbox).not.toBeChecked();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Item display
// ─────────────────────────────────────────────────────────────────────────────

describe("Item display", () => {
  it("shows Admin badge when elevation_required is true", async () => {
    const item = makeJunkItem({ elevation_required: true });
    await renderAndScan([item]);
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("shows elevation warning banner when an elevated item is selected", async () => {
    const item = makeJunkItem({ elevation_required: true });
    await renderAndScan([item]);

    await ensureItemsSelected();
    await waitFor(() =>
      expect(screen.getByText(/administrator privileges/)).toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Preview (dry run)
// ─────────────────────────────────────────────────────────────────────────────

describe("Preview / dry run", () => {
  const dryRunResult = {
    total_files: 42,
    total_size: 8192,
    file_list: ["C:\\Temp\\a.tmp", "C:\\Temp\\b.tmp"],
    warnings: [],
  };

  it("calls dry_run_clean with selected paths", async () => {
    const item = makeJunkItem({ path: "C:\\Temp_DryRun" });
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(dryRunResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));

    await ensureItemsSelected();

    await waitFor(() => screen.getByText("Preview (1)"));
    fireEvent.click(screen.getByText("Preview (1)"));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("dry_run_clean", {
        paths: ["C:\\Temp_DryRun"],
      }),
    );
  });

  it("shows the preview panel after dry run", async () => {
    const item = makeJunkItem();
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(dryRunResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await ensureItemsSelected();

    await waitFor(() => screen.getByText("Preview (1)"));
    fireEvent.click(screen.getByText("Preview (1)"));

    await waitFor(() =>
      expect(
        screen.getByText("Preview: What Will Be Deleted"),
      ).toBeInTheDocument(),
    );
  });

  it("shows warnings inside the preview panel", async () => {
    const item = makeJunkItem();
    const resultWithWarning = {
      ...dryRunResult,
      warnings: ["Large operation"],
    };
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(resultWithWarning);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await ensureItemsSelected();

    await waitFor(() => screen.getByText("Preview (1)"));
    fireEvent.click(screen.getByText("Preview (1)"));

    await waitFor(() =>
      expect(screen.getByText(/Large operation/)).toBeInTheDocument(),
    );
  });

  it("returns to the list when Back to List is clicked", async () => {
    const item = makeJunkItem();
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(dryRunResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await ensureItemsSelected();

    await waitFor(() => screen.getByText("Preview (1)"));
    fireEvent.click(screen.getByText("Preview (1)"));
    await waitFor(() => screen.getByText("Back to List"));
    fireEvent.click(screen.getByText("Back to List"));

    await waitFor(() =>
      expect(
        screen.queryByText("Preview: What Will Be Deleted"),
      ).not.toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cleaning
// ─────────────────────────────────────────────────────────────────────────────

describe("Cleaning", () => {
  const cleanResult = { bytes_freed: 4096, files_deleted: 10, errors: [] };

  it("calls clean_system_junk with the correct paths", async () => {
    const item = makeJunkItem({ path: "C:\\Temp_Clean" });
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(cleanResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await ensureItemsSelected();

    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("clean_system_junk", {
        paths: ["C:\\Temp_Clean"],
      }),
    );
  });

  it("shows the success state after clean completes", async () => {
    const item = makeJunkItem();
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(cleanResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await ensureItemsSelected();

    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(screen.getByText("Cleanup Complete!")).toBeInTheDocument(),
    );
  });

  it("shows errors from the clean result", async () => {
    const item = makeJunkItem();
    const resultWithErrors = { ...cleanResult, errors: ["Failed"] };
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(resultWithErrors);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await ensureItemsSelected();

    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(screen.getByText(/Cleaned with 1 error/)).toBeInTheDocument(),
    );
  });

  it("shows the large-operation confirmation dialog for items over 10 GB", async () => {
    const bigItem = makeJunkItem({ size: 11 * 1024 * 1024 * 1024 });
    await renderAndScan([bigItem]);
    await ensureItemsSelected();

    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(screen.getByText("Large Cleanup Operation")).toBeInTheDocument(),
    );
  });

  it("disables the Confirm & Clean button until the checkbox is checked", async () => {
    const bigItem = makeJunkItem({ size: 11 * 1024 * 1024 * 1024 });
    await renderAndScan([bigItem]);
    await ensureItemsSelected();

    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));
    await waitFor(() => screen.getByText("Large Cleanup Operation"));

    const confirmBtn = screen.getAllByText("Confirm & Clean")[0];
    expect(confirmBtn).toBeDisabled();

    const checkbox = screen.getByRole("checkbox", {
      name: /permanently delete/,
    });
    fireEvent.click(checkbox);
    expect(confirmBtn).not.toBeDisabled();
  });

  it("closes the confirmation dialog when Cancel is clicked", async () => {
    const bigItem = makeJunkItem({ size: 11 * 1024 * 1024 * 1024 });
    await renderAndScan([bigItem]);
    await ensureItemsSelected();

    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));
    await waitFor(() => screen.getByText("Large Cleanup Operation"));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Large Cleanup Operation"),
      ).not.toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Registry tab
// ─────────────────────────────────────────────────────────────────────────────

describe("Registry tab (Windows only)", () => {
  beforeEach(() => {
    mockPlatform = jest.fn(() => "windows");
  });

  async function openRegistryTab() {
    const sysItem = makeJunkItem();
    mockInvoke.mockResolvedValueOnce([sysItem]);
    const view = await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() =>
      expect(screen.queryByText("Scanning System...")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Registry"));
    return view;
  }

  it("enables Clean Selected after a backup is taken", async () => {
    const regItem = makeRegistryItem();
    await openRegistryTab();
    mockInvoke.mockResolvedValueOnce([regItem]).mockResolvedValueOnce({
      backup_path: "C:\\Temp\\b.reg",
      success: true,
      error: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));
    await waitFor(() => screen.getByText("OldApp"));

    await ensureItemsSelected(); // Check the registry item

    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));
    await waitFor(() => screen.getByText("Backup saved"));

    const cleanBtns = screen.getAllByRole("button", { name: /Clean Selected/ });
    expect(cleanBtns[0]).not.toBeDisabled();
  });

  it("calls clean_registry with the correct entries", async () => {
    const regItem = makeRegistryItem({ key_path: "HKCU\\SOFTWARE\\OldApp" });
    await openRegistryTab();
    mockInvoke
      .mockResolvedValueOnce([regItem])
      .mockResolvedValueOnce({
        success: true,
        backup_path: "b.reg",
        error: null,
      })
      .mockResolvedValueOnce({ items_cleaned: 1, errors: [] });

    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));
    await waitFor(() => screen.getByText("OldApp"));

    await ensureItemsSelected();

    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));
    await waitFor(() => screen.getByText("Backup saved"));

    const cleanBtns = screen.getAllByRole("button", { name: /Clean Selected/ });
    fireEvent.click(cleanBtns[0]);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("clean_registry", {
        entries: [{ key_path: "HKCU\\SOFTWARE\\OldApp", value_name: null }],
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. InfoModal integration
// ─────────────────────────────────────────────────────────────────────────────

describe("InfoModal", () => {
  it("shows the InfoModal after a successful clean", async () => {
    const item = makeJunkItem();
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce({
      bytes_freed: 100,
      files_deleted: 1,
      errors: [],
    });

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));

    await ensureItemsSelected();

    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(screen.getByTestId("info-modal")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Cleanup completed successfully!"),
    ).toBeInTheDocument();
  });

  it("closes the InfoModal when its Close button is clicked", async () => {
    const item = makeJunkItem();
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce({
      bytes_freed: 100,
      files_deleted: 1,
      errors: [],
    });

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await ensureItemsSelected();

    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));
    await waitFor(() => screen.getByTestId("info-modal"));

    fireEvent.click(screen.getByText("Close"));
    await waitFor(() =>
      expect(screen.queryByTestId("info-modal")).not.toBeInTheDocument(),
    );
  });
});
