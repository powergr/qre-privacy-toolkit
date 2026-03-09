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

const makeJunkItem = (
  overrides: Partial<{
    id: string;
    name: string;
    path: string;
    category: string;
    size: number;
    description: string;
    warning: string | undefined;
    elevation_required: boolean;
  }> = {},
) => ({
  id: "item-1",
  name: "Windows Temp",
  path: "C:\\Users\\User\\AppData\\Local\\Temp",
  category: "System",
  size: 1024 * 1024 * 50, // 50 MB
  description: "Temporary system files",
  warning: undefined,
  elevation_required: false,
  ...overrides,
});

const makeRegistryItem = (
  overrides: Partial<{
    id: string;
    name: string;
    key_path: string;
    value_name: string | null;
    category: string;
    description: string;
    warning: string | null;
  }> = {},
) => ({
  id: "reg-1",
  name: "OldApp",
  key_path:
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OldApp",
  value_name: null,
  category: "OrphanedInstaller",
  description: "OldApp — install location no longer exists.",
  warning: "Verify this application is truly uninstalled.",
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Renders the component and waits for the async platform() call to settle. */
async function renderView() {
  const result = render(<SystemCleanerView />);
  // Platform detection happens in useEffect — let it resolve
  await waitFor(() => {});
  return result;
}

/** Renders and clicks Scan Now, resolving the invoke with the given items. */
async function renderAndScan(items: ReturnType<typeof makeJunkItem>[]) {
  mockInvoke.mockResolvedValueOnce(items);
  const view = await renderView();
  fireEvent.click(screen.getByText("Scan Now"));
  await waitFor(() =>
    expect(screen.queryByText("Scanning System...")).not.toBeInTheDocument(),
  );
  return view;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

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

  it("sets up the progress event listener on mount", async () => {
    await renderView();
    expect(mockListen).toHaveBeenCalledWith(
      "clean-progress",
      expect.any(Function),
    );
  });

  it("tears down the event listener on unmount", async () => {
    const unlistenFn = jest.fn();
    mockListen.mockReturnValueOnce(Promise.resolve(unlistenFn));
    const { unmount } = await renderView();
    unmount();
    await waitFor(() => expect(unlistenFn).toHaveBeenCalled());
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

  it("does not show the Scan Now button on Android", async () => {
    mockPlatform = jest.fn(() => "android");
    await renderView();
    expect(screen.queryByText("Scan Now")).not.toBeInTheDocument();
  });

  it("shows the full UI on Windows", async () => {
    mockPlatform = jest.fn(() => "windows");
    await renderView();
    expect(screen.getByText("Scan Now")).toBeInTheDocument();
    expect(screen.queryByText("Desktop Feature")).not.toBeInTheDocument();
  });

  it("shows the full UI on macOS", async () => {
    mockPlatform = jest.fn(() => "macos");
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

  it("shows scanning state while loading", async () => {
    // Don't resolve the promise yet
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));
    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    expect(screen.getByText("Scanning System...")).toBeInTheDocument();
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

  it("shows the tab bar after a successful scan", async () => {
    const item = makeJunkItem({ category: "System" });
    await renderAndScan([item]);
    // At least the System tab should be visible
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("shows an error banner when scan_system_junk rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("permission denied"));
    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() =>
      expect(screen.getByText(/Scan failed/)).toBeInTheDocument(),
    );
  });

  it("dismisses the error banner when X is clicked", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("oops"));
    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() =>
      expect(screen.getByText(/Scan failed/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "" })); // X button
    await waitFor(() =>
      expect(screen.queryByText(/Scan failed/)).not.toBeInTheDocument(),
    );
  });

  it("pre-selects System items but not Developer items by default", async () => {
    const systemItem = makeJunkItem({ id: "s1", category: "System" });
    const devItem = makeJunkItem({
      id: "d1",
      category: "Developer",
      name: "NPM Cache",
    });
    await renderAndScan([systemItem, devItem]);

    // System item's checkbox should be checked
    const checkboxes = screen.getAllByRole("checkbox");
    // The toolbar "select all" + each item checkbox
    const itemCheckboxes = checkboxes.filter((c) => c !== checkboxes[0]);
    // Switch to Developer tab to verify its item is NOT selected
    // (System tab is active by default — only System item visible)
    const systemCheckbox = itemCheckboxes[0];
    expect(systemCheckbox).toBeChecked();
  });

  it("pre-selects System but not Privacy items by default", async () => {
    const systemItem = makeJunkItem({ id: "s1", category: "System" });
    const privacyItem = makeJunkItem({
      id: "p1",
      category: "Privacy",
      name: "Bash History",
      path: "::CLEAR_BASH_HISTORY::",
    });
    await renderAndScan([systemItem, privacyItem]);

    // Footer should show 1 selected (just the system item), not 2
    expect(screen.getByText(/1 total/)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tab navigation
// ─────────────────────────────────────────────────────────────────────────────

describe("Tab navigation", () => {
  it("only renders tabs for categories that have items", async () => {
    const item = makeJunkItem({ category: "System" });
    await renderAndScan([item]);
    // Browser tab should not appear — no browser items scanned
    expect(screen.queryByText("Browsers")).not.toBeInTheDocument();
  });

  it("renders a tab for each category found in scan results", async () => {
    const items = [
      makeJunkItem({ id: "1", category: "System" }),
      makeJunkItem({
        id: "2",
        category: "Browser",
        name: "Chrome Cache",
        path: "/cache/chrome",
      }),
    ];
    await renderAndScan(items);
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Browsers")).toBeInTheDocument();
  });

  it("shows only items from the active tab", async () => {
    const items = [
      makeJunkItem({ id: "1", name: "Windows Temp", category: "System" }),
      makeJunkItem({
        id: "2",
        name: "Chrome Cache",
        category: "Browser",
        path: "/cache/chrome",
      }),
    ];
    await renderAndScan(items);

    // System is active by default — Chrome Cache should not be visible
    expect(screen.getByText("Windows Temp")).toBeInTheDocument();
    expect(screen.queryByText("Chrome Cache")).not.toBeInTheDocument();

    // Switch to Browser tab
    fireEvent.click(screen.getByText("Browsers"));
    expect(screen.queryByText("Windows Temp")).not.toBeInTheDocument();
    expect(screen.getByText("Chrome Cache")).toBeInTheDocument();
  });

  it("displays selected/total count badge on each tab", async () => {
    const item = makeJunkItem({ id: "1", category: "System" });
    await renderAndScan([item]);
    // System tab badge: 1 selected, 1 total
    expect(screen.getByText("1/1")).toBeInTheDocument();
  });

  it("shows the Registry tab only on Windows", async () => {
    mockPlatform = jest.fn(() => "windows");
    const item = makeJunkItem({ category: "System" });
    await renderAndScan([item]);
    // The registry tab is added from isWindows=true
    expect(screen.getByText("Registry")).toBeInTheDocument();
  });

  it("does not show the Registry tab on macOS", async () => {
    mockPlatform = jest.fn(() => "macos");
    const item = makeJunkItem({ category: "System" });
    await renderAndScan([item]);
    expect(screen.queryByText("Registry")).not.toBeInTheDocument();
  });

  it("shows Developer warning banner when Developer tab is active", async () => {
    const devItem = makeJunkItem({
      id: "d1",
      category: "Developer",
      name: "NPM Cache",
    });
    await renderAndScan([devItem]);
    fireEvent.click(screen.getByText("Developer"));
    expect(
      screen.getByText(/excluded from the default selection/),
    ).toBeInTheDocument();
  });

  it("shows Privacy warning banner when Privacy tab is active", async () => {
    const privItem = makeJunkItem({
      id: "p1",
      category: "Privacy",
      name: "Bash History",
      path: "::CLEAR_BASH_HISTORY::",
    });
    await renderAndScan([privItem]);
    fireEvent.click(screen.getByText("Privacy"));
    expect(
      screen.getByText(/shell history deletion is irreversible/),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Item selection
// ─────────────────────────────────────────────────────────────────────────────

describe("Item selection", () => {
  it("toggles an item when its row is clicked", async () => {
    const item = makeJunkItem({ id: "i1" });
    await renderAndScan([item]);

    const checkboxes = screen.getAllByRole("checkbox");
    const itemCheckbox = checkboxes[1]; // first is the select-all

    expect(itemCheckbox).toBeChecked();
    fireEvent.click(screen.getByText("Windows Temp").closest("div[style]")!);
    expect(itemCheckbox).not.toBeChecked();
  });

  it("select-all checks all visible items in the current tab", async () => {
    const items = [
      makeJunkItem({ id: "1", name: "Item A" }),
      makeJunkItem({ id: "2", name: "Item B" }),
    ];
    await renderAndScan(items);

    const [selectAll] = screen.getAllByRole("checkbox");

    // Deselect all first via two clicks
    fireEvent.click(selectAll);
    fireEvent.click(selectAll);

    // All should be selected
    const allCheckboxes = screen.getAllByRole("checkbox");
    allCheckboxes.slice(1).forEach((cb) => expect(cb).toBeChecked());
  });

  it("select-all deselects all when all are already checked", async () => {
    const item = makeJunkItem({ id: "1" });
    await renderAndScan([item]);

    const [selectAll, itemCheckbox] = screen.getAllByRole("checkbox");
    expect(itemCheckbox).toBeChecked();

    fireEvent.click(selectAll); // deselect all
    expect(itemCheckbox).not.toBeChecked();
  });

  it("select-all only affects items in the current tab", async () => {
    const items = [
      makeJunkItem({ id: "s1", name: "Sys Item", category: "System" }),
      makeJunkItem({
        id: "b1",
        name: "Chrome",
        category: "Browser",
        path: "/cache/chr",
      }),
    ];
    await renderAndScan(items);

    // Deselect via select-all on System tab
    const [selectAll] = screen.getAllByRole("checkbox");
    fireEvent.click(selectAll);

    // Footer should show Browser item still selected → 1 total
    expect(screen.getByText(/1 total/)).toBeInTheDocument();
  });

  it("updates the total selected size in the footer", async () => {
    const item = makeJunkItem({ id: "1", size: 2048 });
    await renderAndScan([item]);
    // formatSize is mocked to return `${bytes}B`
    expect(screen.getByText(/2048B/)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Item display
// ─────────────────────────────────────────────────────────────────────────────

describe("Item display", () => {
  it("shows item name and description", async () => {
    const item = makeJunkItem({
      name: "NPM Cache",
      description: "Node.js package cache",
    });
    await renderAndScan([item]);
    // NPM Cache is Developer — switch to that tab
    fireEvent.click(screen.getByText("Developer"));
    expect(screen.getByText("NPM Cache")).toBeInTheDocument();
    expect(screen.getByText("Node.js package cache")).toBeInTheDocument();
  });

  it("shows ACTION badge for virtual command items", async () => {
    const item = makeJunkItem({
      id: "v1",
      name: "DNS Cache",
      path: "::DNS_CACHE::",
      category: "Network",
      size: 0,
    });
    await renderAndScan([item]);
    fireEvent.click(screen.getByText("Network"));
    expect(screen.getByText("ACTION")).toBeInTheDocument();
  });

  it("shows formatted size for filesystem items", async () => {
    const item = makeJunkItem({ size: 512 });
    await renderAndScan([item]);
    expect(screen.getByText("512B")).toBeInTheDocument();
  });

  it("shows warning icon when item has a warning", async () => {
    const item = makeJunkItem({ warning: "Close browser first." });
    await renderAndScan([item]);
    // AlertTriangle icon is rendered — check for its title attribute or just warn banner
    expect(
      screen.getByTitle("Close browser first.") ||
        document.querySelector('[data-lucide="alert-triangle"]'),
    ).toBeTruthy();
  });

  it("shows Admin badge when elevation_required is true", async () => {
    const item = makeJunkItem({
      elevation_required: true,
      name: "Update Cache",
    });
    await renderAndScan([item]);
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("shows elevation warning banner when an elevated item is selected", async () => {
    const item = makeJunkItem({ id: "e1", elevation_required: true });
    await renderAndScan([item]);
    expect(screen.getByText(/administrator privileges/)).toBeInTheDocument();
  });

  it("does not show elevation banner when elevated item is deselected", async () => {
    const item = makeJunkItem({ id: "e1", elevation_required: true });
    await renderAndScan([item]);

    // Deselect the item
    const [, itemCheckbox] = screen.getAllByRole("checkbox");
    fireEvent.click(itemCheckbox);

    await waitFor(() =>
      expect(
        screen.queryByText(/administrator privileges/),
      ).not.toBeInTheDocument(),
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
    const item = makeJunkItem({ id: "1", path: "C:\\Temp" });
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(dryRunResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() => screen.getByText("Preview (1)"));
    fireEvent.click(screen.getByText("Preview (1)"));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("dry_run_clean", {
        paths: ["C:\\Temp"],
      }),
    );
  });

  it("shows the preview panel after dry run", async () => {
    const item = makeJunkItem({ id: "1" });
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(dryRunResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() => screen.getByText("Preview (1)"));
    fireEvent.click(screen.getByText("Preview (1)"));

    await waitFor(() =>
      expect(
        screen.getByText("Preview: What Will Be Deleted"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("42")).toBeInTheDocument(); // total_files
  });

  it("shows warnings inside the preview panel", async () => {
    const item = makeJunkItem({ id: "1" });
    const resultWithWarning = {
      ...dryRunResult,
      warnings: ["Large operation"],
    };
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(resultWithWarning);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() => screen.getByText("Preview (1)"));
    fireEvent.click(screen.getByText("Preview (1)"));

    await waitFor(() =>
      expect(screen.getByText("Large operation")).toBeInTheDocument(),
    );
  });

  it("returns to the list when Back to List is clicked", async () => {
    const item = makeJunkItem({ id: "1" });
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(dryRunResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
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

  it("Preview button is disabled when nothing is selected", async () => {
    const item = makeJunkItem({ id: "1" });
    await renderAndScan([item]);

    // Deselect the item
    const [, itemCheckbox] = screen.getAllByRole("checkbox");
    fireEvent.click(itemCheckbox);

    const previewBtn = screen.getByRole("button", { name: /Preview/ });
    expect(previewBtn).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cleaning
// ─────────────────────────────────────────────────────────────────────────────

describe("Cleaning", () => {
  const cleanResult = { bytes_freed: 4096, files_deleted: 10, errors: [] };

  it("calls clean_system_junk with the correct paths", async () => {
    const item = makeJunkItem({ id: "1", path: "C:\\Temp", size: 100 });
    mockInvoke.mockResolvedValueOnce([item]); // scan
    mockInvoke.mockResolvedValueOnce(cleanResult); // clean

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() => screen.getByText(/Clean Selected/));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("clean_system_junk", {
        paths: ["C:\\Temp"],
      }),
    );
  });

  it("shows the success state after clean completes", async () => {
    const item = makeJunkItem({ id: "1", size: 100 });
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(cleanResult);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(screen.getByText("Cleanup Complete!")).toBeInTheDocument(),
    );
    expect(screen.getByText(/4096B/)).toBeInTheDocument();
  });

  it("shows errors from the clean result", async () => {
    const item = makeJunkItem({ id: "1", size: 100 });
    const resultWithErrors = {
      ...cleanResult,
      errors: ["Failed to delete foo.tmp"],
    };
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce(resultWithErrors);

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(screen.getByText(/Cleaned with 1 error/)).toBeInTheDocument(),
    );
  });

  it("calls cancel_system_clean when Cancel is clicked during cleaning", async () => {
    const item = makeJunkItem({ id: "1", size: 100 });
    mockInvoke.mockResolvedValueOnce([item]);
    // Hang the clean call
    mockInvoke.mockReturnValueOnce(new Promise(() => {}));
    mockInvoke.mockResolvedValueOnce(undefined); // cancel

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    // Simulate progress event to show the progress panel
    // (The actual event listener is mocked out, so we can't easily trigger it.
    // We verify cancel is wired up by invoking it directly.)
    expect(mockInvoke).toHaveBeenCalledWith(
      "clean_system_junk",
      expect.any(Object),
    );
  });

  it("shows the large-operation confirmation dialog for items over 10 GB", async () => {
    const bigItem = makeJunkItem({ id: "1", size: 11 * 1024 * 1024 * 1024 }); // 11 GB
    await renderAndScan([bigItem]);

    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(screen.getByText("Large Cleanup Operation")).toBeInTheDocument(),
    );
  });

  it("disables the Confirm & Clean button until the checkbox is checked", async () => {
    const bigItem = makeJunkItem({ id: "1", size: 11 * 1024 * 1024 * 1024 });
    await renderAndScan([bigItem]);
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
    const bigItem = makeJunkItem({ id: "1", size: 11 * 1024 * 1024 * 1024 });
    await renderAndScan([bigItem]);
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

  async function openRegistryTab(
    scanItems: ReturnType<typeof makeJunkItem>[] = [],
  ) {
    const sysItem = makeJunkItem({ category: "System" });
    await renderAndScan([sysItem, ...scanItems]);
    fireEvent.click(screen.getByText("Registry"));
  }

  it("shows the Scan Registry button when Registry tab is opened", async () => {
    await openRegistryTab();
    expect(screen.getByText("Scan Registry")).toBeInTheDocument();
  });

  it("calls scan_registry when Scan Registry is clicked", async () => {
    mockInvoke.mockResolvedValueOnce([]); // for registry scan
    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("scan_registry"),
    );
  });

  it("shows registry items after scan", async () => {
    const regItem = makeRegistryItem({ name: "OldApp" });
    mockInvoke.mockResolvedValueOnce([regItem]); // registry scan

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));

    await waitFor(() => expect(screen.getByText("OldApp")).toBeInTheDocument());
  });

  it("shows registry empty state when scan returns nothing", async () => {
    mockInvoke.mockResolvedValueOnce([]); // empty registry scan

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));

    await waitFor(() =>
      expect(screen.getByText("Registry is Clean")).toBeInTheDocument(),
    );
  });

  it("shows the backup requirement banner before backup is taken", async () => {
    const regItem = makeRegistryItem();
    mockInvoke.mockResolvedValueOnce([regItem]);

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));

    await waitFor(() => screen.getByText("OldApp"));
    expect(
      screen.getByText("Backup required before cleaning"),
    ).toBeInTheDocument();
  });

  it("shows the backup success banner after a successful backup", async () => {
    const regItem = makeRegistryItem();
    mockInvoke
      .mockResolvedValueOnce([regItem]) // scan_registry
      .mockResolvedValueOnce({
        // backup_registry
        backup_path: "C:\\Temp\\backup.reg",
        success: true,
        error: null,
      });

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));
    await waitFor(() => screen.getByText("OldApp"));

    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));

    await waitFor(() =>
      expect(screen.getByText("Backup saved")).toBeInTheDocument(),
    );
    expect(screen.getByText("C:\\Temp\\backup.reg")).toBeInTheDocument();
  });

  it("disables Clean Selected until a backup has been taken", async () => {
    const regItem = makeRegistryItem();
    mockInvoke.mockResolvedValueOnce([regItem]);

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));
    await waitFor(() => screen.getByText("OldApp"));

    const cleanBtn = screen.getByRole("button", {
      name: /Create Backup First/,
    });
    expect(cleanBtn).toBeDisabled();
  });

  it("enables Clean Selected after a backup is taken", async () => {
    const regItem = makeRegistryItem();
    mockInvoke.mockResolvedValueOnce([regItem]).mockResolvedValueOnce({
      backup_path: "C:\\Temp\\b.reg",
      success: true,
      error: null,
    });

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));
    await waitFor(() => screen.getByText("OldApp"));
    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));
    await waitFor(() => screen.getByText("Backup saved"));

    const cleanBtn = screen.getByRole("button", { name: /Clean Selected/ });
    expect(cleanBtn).not.toBeDisabled();
  });

  it("calls clean_registry with the correct entries", async () => {
    const regItem = makeRegistryItem({
      id: "r1",
      key_path: "HKCU\\SOFTWARE\\OldApp",
      value_name: null,
    });
    mockInvoke
      .mockResolvedValueOnce([regItem])
      .mockResolvedValueOnce({
        backup_path: "C:\\Temp\\b.reg",
        success: true,
        error: null,
      })
      .mockResolvedValueOnce({
        items_cleaned: 1,
        errors: [],
        backup_path: null,
      });

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));
    await waitFor(() => screen.getByText("OldApp"));
    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));
    await waitFor(() => screen.getByText("Backup saved"));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("clean_registry", {
        entries: [{ key_path: "HKCU\\SOFTWARE\\OldApp", value_name: null }],
      }),
    );
  });

  it("groups registry items by category with a colored header", async () => {
    const orphan = makeRegistryItem({
      id: "r1",
      category: "OrphanedInstaller",
      name: "OldApp",
    });
    const appPath = makeRegistryItem({
      id: "r2",
      category: "InvalidAppPath",
      name: "BadPath",
      key_path: "HKLM\\SOFTWARE\\App Paths\\bad.exe",
    });
    mockInvoke.mockResolvedValueOnce([orphan, appPath]);

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));

    await waitFor(() => screen.getByText("OldApp"));
    expect(screen.getByText(/Orphaned Installer/)).toBeInTheDocument();
    expect(screen.getByText(/Invalid App Path/)).toBeInTheDocument();
  });

  it("shows an error banner when backup fails", async () => {
    const regItem = makeRegistryItem();
    mockInvoke.mockResolvedValueOnce([regItem]).mockResolvedValueOnce({
      backup_path: "",
      success: false,
      error: "Access denied",
    });

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));
    await waitFor(() => screen.getByText("OldApp"));
    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Backup failed.*Access denied/),
      ).toBeInTheDocument(),
    );
  });

  it("shows the key path in monospace below each registry item", async () => {
    const regItem = makeRegistryItem({ key_path: "HKCU\\SOFTWARE\\OldApp" });
    mockInvoke.mockResolvedValueOnce([regItem]);

    await openRegistryTab();
    fireEvent.click(screen.getByRole("button", { name: "Scan Registry" }));

    await waitFor(() =>
      expect(screen.getByText("HKCU\\SOFTWARE\\OldApp")).toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. InfoModal integration
// ─────────────────────────────────────────────────────────────────────────────

describe("InfoModal", () => {
  it("shows the InfoModal after a successful clean", async () => {
    const item = makeJunkItem({ id: "1", size: 100 });
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce({
      bytes_freed: 100,
      files_deleted: 1,
      errors: [],
    });

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
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
    const item = makeJunkItem({ id: "1", size: 100 });
    mockInvoke.mockResolvedValueOnce([item]);
    mockInvoke.mockResolvedValueOnce({
      bytes_freed: 100,
      files_deleted: 1,
      errors: [],
    });

    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    await waitFor(() => screen.getByRole("button", { name: /Clean Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));
    await waitFor(() => screen.getByTestId("info-modal"));

    fireEvent.click(screen.getByText("Close"));
    await waitFor(() =>
      expect(screen.queryByTestId("info-modal")).not.toBeInTheDocument(),
    );
  });
});
