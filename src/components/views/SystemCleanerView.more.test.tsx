import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SystemCleanerView } from "./SystemCleanerView";

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockPlatform = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
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

const MB = 1024 * 1024;
const GB = 1024 * MB;

function junk(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Item ${id}`,
    path: `C:\\Temp\\${id}`,
    category: "System",
    size: 5 * MB,
    description: `About ${id}`,
    elevation_required: false,
    ...over,
  };
}

function reg(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Entry ${id}`,
    key_path: `HKCU\\Software\\${id}`,
    value_name: null,
    category: "InvalidAppPath",
    description: `Registry ${id}`,
    warning: null,
    elevation_required: false,
    ...over,
  };
}

const cleanOk = (over: Record<string, unknown> = {}) => ({
  bytes_freed: 10 * MB,
  files_deleted: 1234,
  errors: [],
  ...over,
});

async function renderView() {
  const utils = render(<SystemCleanerView />);
  await act(async () => {});
  return utils;
}

async function scanWith(items: unknown[]) {
  handlers.scan_system_junk = () => items;
  const utils = await renderView();
  fireEvent.click(screen.getByText("Scan Now"));
  await waitFor(() => expect(screen.queryByText("Scanning System...")).not.toBeInTheDocument());
  return utils;
}

const rowOf = (name: string) =>
  screen.getByText(name).closest("div[style*='cursor: pointer']") as HTMLElement;
const pick = (...names: string[]) => names.forEach((n) => fireEvent.click(rowOf(n)));
const tabButton = (label: string) => screen.getByText(label, { selector: "span" }).closest("button")!;
const cleanButton = () => screen.getByRole("button", { name: /Clean Selected/ });
const previewButton = () => screen.getByRole("button", { name: /Preview/ });

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.mockReturnValue("windows");
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

// ─── Platform ────────────────────────────────────────────────────────────────

describe("SystemCleanerView - platform", () => {
  it("copes with platform() failing", async () => {
    mockPlatform.mockImplementation(() => {
      throw new Error("no os plugin");
    });
    await renderView();
    expect(screen.getByText("Start Scan")).toBeInTheDocument();
  });

  it("shows the registry tab only on Windows", async () => {
    await scanWith([junk("a")]);
    expect(tabButton("Registry")).toBeInTheDocument();
  });

  it("has no registry tab, and no admin relaunch button, on Linux", async () => {
    mockPlatform.mockReturnValue("linux");
    await scanWith([junk("a", { elevation_required: true })]);
    expect(screen.queryByText("Registry", { selector: "span" })).not.toBeInTheDocument();
    pick("Item a");
    expect(screen.getByText(/require administrator privileges/)).toBeInTheDocument();
    expect(screen.queryByText("Relaunch as Administrator")).not.toBeInTheDocument();
  });

  it("stops listening for progress on unmount", async () => {
    const { unmount } = await renderView();
    expect(Object.keys(listeners)).toEqual(["clean-progress"]);
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("still stops listening if the screen was closed before the listener was ready", async () => {
    const gate = deferred<() => void>();
    mockListen.mockImplementationOnce(() => gate.promise);
    const { unmount } = render(<SystemCleanerView />);
    unmount();
    await act(async () => {
      gate.resolve(unlisten);
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

// ─── Scanning ────────────────────────────────────────────────────────────────

describe("SystemCleanerView - scanning", () => {
  it("starts a scan from a click anywhere on the start card", async () => {
    handlers.scan_system_junk = () => [junk("a")];
    await renderView();
    fireEvent.click(screen.getByText("Start Scan"));
    await screen.findByText("Item a");
    expect(calls("scan_system_junk")).toHaveLength(1);
  });

  it("shows a scanning state and does not start a second scan", async () => {
    const gate = deferred<unknown[]>();
    handlers.scan_system_junk = () => gate.promise;
    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    expect(await screen.findByText("Scanning System...")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Scanning System..."));
    expect(calls("scan_system_junk")).toHaveLength(1);
    await act(async () => {
      gate.resolve([]);
    });
  });

  it("reports a failed scan, returns to the start card, and the message can be dismissed", async () => {
    handlers.scan_system_junk = () => {
      throw "access denied";
    };
    await renderView();
    fireEvent.click(screen.getByText("Scan Now"));
    expect(await screen.findByText("Scan failed: access denied")).toBeInTheDocument();
    expect(screen.getByText("Start Scan")).toBeInTheDocument();
    fireEvent.click(document.querySelector("button svg.lucide-x")!.closest("button")!);
    expect(screen.queryByText(/Scan failed/)).not.toBeInTheDocument();
  });

  it("says the system is clean when nothing is found, and scans again from there", async () => {
    await scanWith([]);
    expect(screen.getByText("System is Clean")).toBeInTheDocument();
    handlers.scan_system_junk = () => [junk("a")];
    fireEvent.click(screen.getByText("Scan Again"));
    expect(await screen.findByText("Item a")).toBeInTheDocument();
  });

  it("opens on a category that has something in it, when the first one is empty", async () => {
    await scanWith([junk("b1", { category: "Browser" }), junk("b2", { category: "Browser" })]);
    expect(screen.getByText("Item b1")).toBeInTheDocument();
    expect(screen.queryByText("No junk found in this category.")).not.toBeInTheDocument();
  });

  it("stays on the current category after a rescan if it still has items", async () => {
    await scanWith([junk("a"), junk("n1", { category: "Network" })]);
    fireEvent.click(tabButton("Network"));
    expect(screen.getByText("Item n1")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Rescan"));
    await waitFor(() => expect(calls("scan_system_junk")).toHaveLength(2));
    expect(await screen.findByText("Item n1")).toBeInTheDocument();
  });

  it("moves to a category with items when a rescan empties the current one", async () => {
    await scanWith([junk("a"), junk("n1", { category: "Network" })]);
    fireEvent.click(tabButton("Network"));
    handlers.scan_system_junk = () => [junk("a")];
    fireEvent.click(screen.getByTitle("Rescan"));
    expect(await screen.findByText("Item a")).toBeInTheDocument();
  });

  it("forgets the old selection after a rescan", async () => {
    await scanWith([junk("a"), junk("b")]);
    pick("Item a");
    expect(screen.getByText(/1 total/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Rescan"));
    await waitFor(() => expect(calls("scan_system_junk")).toHaveLength(2));
    await waitFor(() => expect(screen.getByText(/0 total/)).toBeInTheDocument());
  });

  it("disables Rescan while a scan is running", async () => {
    await scanWith([junk("a")]);
    const gate = deferred<unknown[]>();
    handlers.scan_system_junk = () => gate.promise;
    fireEvent.click(screen.getByTitle("Rescan"));
    await waitFor(() => expect(screen.getByTitle("Rescan")).toBeDisabled());
    await act(async () => {
      gate.resolve([junk("a")]);
    });
  });
});

// ─── Tabs, selection and banners ─────────────────────────────────────────────

describe("SystemCleanerView - categories and selection", () => {
  const sample = () => [
    junk("s1"),
    junk("s2", { size: 10 * MB }),
    junk("b1", { category: "Browser", name: "Chrome cache" }),
    junk("d1", { category: "Developer", name: "npm cache" }),
    junk("p1", { category: "Privacy", name: "Shell history" }),
    junk("n1", { category: "Network", name: "DNS cache" }),
  ];

  it("shows a tab with counts for each category that has items", async () => {
    await scanWith(sample());
    for (const [label, count] of [["System", "0/2"], ["Browsers", "0/1"], ["Network", "0/1"], ["Developer", "0/1"], ["Privacy", "0/1"]]) {
      expect(within(tabButton(label)).getByText(count)).toBeInTheDocument();
    }
  });

  it("hides the tab of a category with no items", async () => {
    await scanWith([junk("s1")]);
    expect(screen.queryByText("Browsers", { selector: "span" })).not.toBeInTheDocument();
    expect(screen.queryByText("Developer", { selector: "span" })).not.toBeInTheDocument();
  });

  it("shows the explanatory banner for Developer and Privacy only", async () => {
    await scanWith(sample());
    expect(screen.queryByText(/Developer caches are excluded/)).not.toBeInTheDocument();
    fireEvent.click(tabButton("Developer"));
    expect(screen.getByText(/Developer caches are excluded/)).toBeInTheDocument();
    expect(screen.queryByText(/Privacy items are excluded/)).not.toBeInTheDocument();
    fireEvent.click(tabButton("Privacy"));
    expect(screen.getByText(/Privacy items are excluded/)).toBeInTheDocument();
    expect(screen.queryByText(/Developer caches are excluded/)).not.toBeInTheDocument();
  });

  it("counts the selection per tab and in total, with the combined size", async () => {
    await scanWith(sample());
    pick("Item s1", "Item s2");
    expect(screen.getByText(/2\/2 in tab\s+·\s+2 total \(15 MB\)/)).toBeInTheDocument();
    fireEvent.click(tabButton("Browsers"));
    expect(screen.getByText(/0\/1 in tab\s+·\s+2 total \(15 MB\)/)).toBeInTheDocument();
    pick("Chrome cache");
    expect(screen.getByText(/1\/1 in tab\s+·\s+3 total \(20 MB\)/)).toBeInTheDocument();
    expect(within(tabButton("Browsers")).getByText("1/1")).toBeInTheDocument();
  });

  it("selects and clears only the current tab with the top checkbox", async () => {
    await scanWith(sample());
    pick("Item s1");
    fireEvent.click(tabButton("Browsers"));
    const all = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    expect(all.checked).toBe(false);
    fireEvent.click(all);
    expect(screen.getByText(/2 total/)).toBeInTheDocument();
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    expect(screen.getByText(/1 total/)).toBeInTheDocument();
  });

  it("unticks an item that was ticked", async () => {
    await scanWith(sample());
    pick("Item s1");
    pick("Item s1");
    expect(screen.getByText(/0 total/)).toBeInTheDocument();
  });

  it("keeps the footer buttons off until something is selected", async () => {
    await scanWith(sample());
    expect(previewButton()).toBeDisabled();
    expect(cleanButton()).toBeDisabled();
    pick("Item s1");
    expect(previewButton()).toBeEnabled();
    expect(cleanButton()).toBeEnabled();
    expect(cleanButton()).toHaveTextContent("5 MB");
  });

  it("warns when a selected item has a warning, using the item's own text as its tooltip", async () => {
    await scanWith([junk("w", { warning: "Signs you out of sites", name: "Cookies" })]);
    expect(screen.queryByText(/Selected items include warnings/)).not.toBeInTheDocument();
    pick("Cookies");
    expect(screen.getByText(/Selected items include warnings/)).toBeInTheDocument();
    expect(rowOf("Cookies")).toHaveAttribute("title", "Signs you out of sites");
  });

  it("uses the description as the tooltip when there is no warning", async () => {
    await scanWith([junk("a")]);
    expect(rowOf("Item a")).toHaveAttribute("title", "About a");
  });

  it("marks items that need administrator rights, and warns only once one is selected", async () => {
    await scanWith([junk("e", { elevation_required: true, name: "Windows Update cache" })]);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.queryByText(/Some selected items require/)).not.toBeInTheDocument();
    pick("Windows Update cache");
    expect(screen.getByText(/Some selected items require/)).toBeInTheDocument();
  });

  it("shows actions, not sizes, for items that run a command", async () => {
    await scanWith([junk("dns", { path: "::flush-dns", name: "DNS cache", size: 0 })]);
    expect(screen.getByText("ACTION")).toBeInTheDocument();
    expect(screen.queryByText("0 B")).not.toBeInTheDocument();
  });
});

describe("SystemCleanerView - relaunching as administrator", () => {
  async function ready() {
    await scanWith([junk("e", { elevation_required: true, name: "Update cache" })]);
    pick("Update cache");
    fireEvent.click(screen.getByText("Relaunch as Administrator"));
  }

  it("asks first, and Cancel does nothing", async () => {
    await ready();
    expect(screen.getByText(/The app will close and reopen/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/The app will close and reopen/)).not.toBeInTheDocument();
    expect(calls("relaunch_as_admin")).toHaveLength(0);
  });

  it("closes without relaunching when the dark area is clicked", async () => {
    await ready();
    fireEvent.click(screen.getByText(/The app will close and reopen/).closest("div[style*='position: fixed']")!);
    expect(screen.queryByText(/The app will close and reopen/)).not.toBeInTheDocument();
    expect(calls("relaunch_as_admin")).toHaveLength(0);
  });

  it("relaunches after confirmation", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    await waitFor(() => expect(calls("relaunch_as_admin")).toHaveLength(1));
    expect(screen.queryByText(/The app will close and reopen/)).not.toBeInTheDocument();
  });

  it("shows a failed relaunch once, in the banner", async () => {
    handlers.relaunch_as_admin = () => {
      throw "user declined";
    };
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    await screen.findByText("Could not relaunch as Administrator: user declined");
    expect(screen.getAllByText(/Could not relaunch as Administrator/)).toHaveLength(1);
  });

  it("reports a relaunch that fails", async () => {
    handlers.relaunch_as_admin = () => {
      throw "user declined";
    };
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    expect(await screen.findByText("Could not relaunch as Administrator: user declined")).toBeInTheDocument();
  });
});

// ─── Preview ─────────────────────────────────────────────────────────────────

describe("SystemCleanerView - preview", () => {
  const dry = (over: Record<string, unknown> = {}) => ({
    total_files: 1234,
    total_size: 15 * MB,
    file_list: ["C:\\Temp\\one.tmp", "C:\\Temp\\two.tmp"],
    warnings: ["Browser must be closed"],
    ...over,
  });

  async function openPreview(over: Record<string, unknown> = {}) {
    handlers.dry_run_clean = () => dry(over);
    await scanWith([junk("a"), junk("b")]);
    pick("Item a", "Item b");
    fireEvent.click(previewButton());
    await screen.findByText("Preview: What Will Be Deleted");
  }

  it("sends the selected paths and shows totals, warnings and the file list", async () => {
    await openPreview();
    expect(calls("dry_run_clean")).toEqual([{ paths: ["C:\\Temp\\a", "C:\\Temp\\b"] }]);
    expect(screen.getByText("Total Files:").nextSibling).toHaveTextContent("1,234");
    expect(screen.getByText("Total Size:").nextSibling).toHaveTextContent("15 MB");
    expect(screen.getByText(/Browser must be closed/)).toBeInTheDocument();
    expect(screen.getByText("C:\\Temp\\one.tmp")).toBeInTheDocument();
  });

  it("has no warnings box when there are none", async () => {
    await openPreview({ warnings: [] });
    expect(screen.queryByText("Warnings:")).not.toBeInTheDocument();
  });

  it("hides the list and footer while the preview is open", async () => {
    await openPreview();
    expect(screen.queryByRole("button", { name: /Clean Selected/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Item a")).not.toBeInTheDocument();
  });

  it("goes back to the list with the selection kept, from Back and from the X", async () => {
    await openPreview();
    fireEvent.click(screen.getByText("Back to List"));
    expect(screen.getByText(/2 total/)).toBeInTheDocument();
    fireEvent.click(previewButton());
    await screen.findByText("Preview: What Will Be Deleted");
    fireEvent.click(screen.getByText("Preview: What Will Be Deleted").parentElement!.querySelector("button")!);
    expect(screen.getByText(/2 total/)).toBeInTheDocument();
  });

  it("reports a failed preview and stays on the list", async () => {
    handlers.dry_run_clean = () => {
      throw "cannot read";
    };
    await scanWith([junk("a")]);
    pick("Item a");
    fireEvent.click(previewButton());
    expect(await screen.findByText("Preview failed: cannot read")).toBeInTheDocument();
    expect(screen.getByText("Item a")).toBeInTheDocument();
  });

  it("cleans from the preview", async () => {
    handlers.clean_system_junk = () => cleanOk();
    await openPreview();
    fireEvent.click(screen.getByText(/Confirm & Clean/));
    await screen.findByText("Cleanup Complete!");
    expect(calls("clean_system_junk")).toEqual([{ paths: ["C:\\Temp\\a", "C:\\Temp\\b"] }]);
  });

  it("leaves the preview for the progress card as soon as cleaning starts, so it cannot be started twice", async () => {
    const gate = deferred<unknown>();
    handlers.clean_system_junk = () => gate.promise;
    await openPreview();
    fireEvent.click(screen.getByText(/Confirm & Clean/));
    await waitFor(() => expect(calls("clean_system_junk")).toHaveLength(1));
    expect(screen.queryByText(/Confirm & Clean/)).not.toBeInTheDocument();
    expect(screen.queryByText("Preview: What Will Be Deleted")).not.toBeInTheDocument();
    expect(screen.getByText("Cleaning in Progress...")).toBeInTheDocument();
    await act(async () => {
      gate.resolve(cleanOk());
    });
  });
});

// ─── Cleaning ────────────────────────────────────────────────────────────────

describe("SystemCleanerView - cleaning", () => {
  async function ready(items = [junk("a"), junk("b")]) {
    await scanWith(items);
    pick(...items.map((i) => i.name as string));
  }
  const clean = () => fireEvent.click(cleanButton());

  it("cleans straight away below the 10 GB limit, even exactly at it", async () => {
    handlers.clean_system_junk = () => cleanOk();
    await ready([junk("a", { size: 10 * GB, name: "Big" })]);
    clean();
    await screen.findByText("Cleanup Complete!");
    expect(screen.queryByText("Large Cleanup Operation")).not.toBeInTheDocument();
  });

  it("asks for confirmation above 10 GB, naming the size", async () => {
    await ready([junk("a", { size: 10 * GB + 1, name: "Huge" })]);
    clean();
    expect(await screen.findByText("Large Cleanup Operation")).toBeInTheDocument();
    expect(screen.getByText("10 GB", { selector: "strong" })).toBeInTheDocument();
    expect(calls("clean_system_junk")).toHaveLength(0);
  });

  it("adds up the sizes of several items for the limit", async () => {
    await ready([
      junk("a", { size: 6 * GB, name: "Half one" }),
      junk("b", { size: 6 * GB, name: "Half two" }),
    ]);
    clean();
    expect(await screen.findByText("Large Cleanup Operation")).toBeInTheDocument();
  });

  it("needs the tick box before the confirmation can be used, then cleans", async () => {
    handlers.clean_system_junk = () => cleanOk();
    await ready([junk("a", { size: 11 * GB, name: "Huge" })]);
    clean();
    const confirm = await screen.findByRole("button", { name: "Confirm & Clean" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await screen.findByText("Cleanup Complete!");
    expect(calls("clean_system_junk")).toHaveLength(1);
  });

  it("starts with the tick box clear again after the dialog was closed from outside", async () => {
    await ready([junk("a", { size: 11 * GB, name: "Huge" })]);
    clean();
    fireEvent.click(await screen.findByRole("checkbox", { name: /I understand/ }));
    fireEvent.click(screen.getByText("Large Cleanup Operation").closest("div[style*='position: fixed']")!);
    expect(screen.queryByText("Large Cleanup Operation")).not.toBeInTheDocument();
    clean();
    expect((await screen.findByRole("checkbox", { name: /I understand/ })) as HTMLInputElement).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Confirm & Clean" })).toBeDisabled();
  });

  it("shows a progress card from the start, before the first progress report", async () => {
    const gate = deferred<unknown>();
    handlers.clean_system_junk = () => gate.promise;
    await ready();
    clean();
    expect(await screen.findByText("Cleaning in Progress...")).toBeInTheDocument();
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await act(async () => {
      gate.resolve(cleanOk());
    });
  });

  it("hides the list and its buttons while cleaning", async () => {
    const gate = deferred<unknown>();
    handlers.clean_system_junk = () => gate.promise;
    await ready();
    clean();
    await screen.findByText("Cleaning in Progress...");
    expect(screen.queryByText("Item a")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Rescan")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clean Selected/ })).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve(cleanOk());
    });
  });

  it("fills in the details as progress arrives", async () => {
    const gate = deferred<unknown>();
    handlers.clean_system_junk = () => gate.promise;
    await ready();
    clean();
    await screen.findByText("Cleaning in Progress...");
    act(() =>
      listeners["clean-progress"]({
        payload: { files_processed: 3, total_files: 12, bytes_freed: 3 * MB, current_file: "x", percentage: 25 },
      }),
    );
    expect(screen.getByText("25% — 3 of 12 files")).toBeInTheDocument();
    expect(screen.getByText("3 MB freed")).toBeInTheDocument();
    expect(document.querySelector('div[style*="width: 25%"]')).not.toBeNull();
    await act(async () => {
      gate.resolve(cleanOk());
    });
  });

  it("keeps showing the cleaning after Cancel until it really stops", async () => {
    const gate = deferred<unknown>();
    handlers.clean_system_junk = () => gate.promise;
    await ready();
    clean();
    await screen.findByText("Cleaning in Progress...");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("cancel_system_clean")).toHaveLength(1));
    expect(screen.getByText("Cleaning in Progress...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Clean Selected/ })).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve(cleanOk({ files_deleted: 5 }));
    });
    expect(await screen.findByText("Cleanup cancelled by user.")).toBeInTheDocument();
  });

  it("says it was cancelled, not failed, when the cancelled command reports an error", async () => {
    const gate = deferred<unknown>();
    handlers.clean_system_junk = () => gate.promise;
    await ready();
    clean();
    await screen.findByText("Cleaning in Progress...");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("cancel_system_clean")).toHaveLength(1));
    await act(async () => {
      gate.reject("Operation cancelled");
    });
    expect(await screen.findByText("Cleanup cancelled by user.")).toBeInTheDocument();
    expect(screen.queryByText(/Clean failed/)).not.toBeInTheDocument();
  });

  it("lets the user try Cancel again if the cancel request failed", async () => {
    const gate = deferred<unknown>();
    handlers.clean_system_junk = () => gate.promise;
    handlers.cancel_system_clean = () => {
      throw "busy";
    };
    await ready();
    clean();
    await screen.findByText("Cleaning in Progress...");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    await act(async () => {
      gate.resolve(cleanOk());
    });
  });

  it("does not call the next cleaning cancelled after one was", async () => {
    const first = deferred<unknown>();
    let call = 0;
    handlers.clean_system_junk = () => (++call === 1 ? first.promise : cleanOk());
    await ready();
    clean();
    await screen.findByText("Cleaning in Progress...");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("cancel_system_clean")).toHaveLength(1));
    await act(async () => {
      first.resolve(cleanOk());
    });
    await screen.findByText("Cleanup cancelled by user.");

    handlers.scan_system_junk = () => [junk("c")];
    fireEvent.click(screen.getByText("Scan Again"));
    await screen.findByText("Item c");
    pick("Item c");
    clean();
    await waitFor(() => expect(call).toBe(2));
    await screen.findByText("Cleanup Complete!");
    expect(screen.queryByText("Cleanup cancelled by user.")).not.toBeInTheDocument();
  });

  it("ignores a progress report that arrives after the cleaning finished", async () => {
    handlers.clean_system_junk = () => cleanOk();
    await ready();
    clean();
    await screen.findByText("Cleanup Complete!");
    act(() =>
      listeners["clean-progress"]({
        payload: { files_processed: 1, total_files: 1, bytes_freed: 1, current_file: "x", percentage: 100 },
      }),
    );
    expect(screen.queryByText("Cleaning in Progress...")).not.toBeInTheDocument();
  });

  it("shows what was freed, and a pop-up when there were no errors", async () => {
    handlers.clean_system_junk = () => cleanOk({ bytes_freed: 2 * GB, files_deleted: 98765 });
    await ready();
    clean();
    await screen.findByText("Cleanup Complete!");
    expect(screen.getByText("2 GB", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Deleted 98,765 file(s)")).toBeInTheDocument();
    expect(screen.getByText("Cleanup completed successfully!")).toBeInTheDocument();
    expect(screen.queryByText(/Errors \(/)).not.toBeInTheDocument();
  });

  it("lists up to ten errors with a count, and no success pop-up", async () => {
    const errors = Array.from({ length: 12 }, (_, i) => `locked file ${i}`);
    handlers.clean_system_junk = () => cleanOk({ errors });
    await ready();
    clean();
    await screen.findByText("Cleanup Complete!");
    expect(screen.getByText("Errors (12):")).toBeInTheDocument();
    expect(screen.getByText(/locked file 0/)).toBeInTheDocument();
    expect(screen.queryByText(/locked file 10/)).not.toBeInTheDocument();
    expect(screen.getByText("…and 2 more")).toBeInTheDocument();
    expect(screen.getByText("Cleaned with 12 error(s). See details below.")).toBeInTheDocument();
    expect(screen.queryByText("Cleanup completed successfully!")).not.toBeInTheDocument();
  });

  it("closes the success pop-up", async () => {
    handlers.clean_system_junk = () => cleanOk();
    await ready();
    clean();
    await screen.findByText("Cleanup completed successfully!");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText("Cleanup completed successfully!")).not.toBeInTheDocument();
  });

  it("returns to the list with the error when cleaning fails", async () => {
    handlers.clean_system_junk = () => {
      throw "disk error";
    };
    await ready();
    clean();
    expect(await screen.findByText("Clean failed: disk error")).toBeInTheDocument();
    expect(screen.getByText("Item a")).toBeInTheDocument();
    expect(cleanButton()).toBeEnabled();
  });

  it("scans again from the result screen", async () => {
    handlers.clean_system_junk = () => cleanOk();
    await ready();
    clean();
    await screen.findByText("Cleanup Complete!");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    handlers.scan_system_junk = () => [junk("fresh")];
    fireEvent.click(screen.getByText("Scan Again"));
    expect(await screen.findByText("Item fresh")).toBeInTheDocument();
    expect(screen.queryByText("Cleanup Complete!")).not.toBeInTheDocument();
  });

  it("does nothing if cleaning is started with nothing selected", async () => {
    await scanWith([junk("a")]);
    expect(cleanButton()).toBeDisabled();
    fireEvent.click(cleanButton());
    expect(calls("clean_system_junk")).toHaveLength(0);
  });
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe("SystemCleanerView - registry", () => {
  async function openRegistry() {
    await scanWith([junk("a")]);
    fireEvent.click(tabButton("Registry"));
  }
  async function scanRegistry(items: unknown[]) {
    handlers.scan_registry = () => items;
    await openRegistry();
    fireEvent.click(screen.getByText("Scan Registry", { selector: "button" }));
    await waitFor(() => expect(screen.queryByText("Scanning Registry...")).not.toBeInTheDocument());
  }
  const regRow = (name: string) => screen.getByText(name).closest("div[style*='cursor: pointer']") as HTMLElement;
  const backup = async () => {
    handlers.backup_registry = () => ({ backup_path: "C:\\backup\\reg.reg", success: true, error: null });
    fireEvent.click(screen.getByText("Create Backup"));
    await screen.findByText("Backup saved");
  };

  it("starts with a scan card, from a click anywhere on it", async () => {
    handlers.scan_registry = () => [reg("r1")];
    await openRegistry();
    fireEvent.click(screen.getByText("Scan Registry", { selector: "h3" }));
    expect(await screen.findByText("Entry r1")).toBeInTheDocument();
  });

  it("shows a scanning state and does not start a second scan", async () => {
    const gate = deferred<unknown[]>();
    handlers.scan_registry = () => gate.promise;
    await openRegistry();
    fireEvent.click(screen.getByText("Scan Registry", { selector: "button" }));
    expect(await screen.findByText("Scanning Registry...")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Scanning Registry..."));
    expect(calls("scan_registry")).toHaveLength(1);
    await act(async () => {
      gate.resolve([]);
    });
  });

  it("reports a failed scan on this tab", async () => {
    handlers.scan_registry = () => {
      throw "no access";
    };
    await openRegistry();
    fireEvent.click(screen.getByText("Scan Registry", { selector: "button" }));
    expect(await screen.findByText("Registry scan failed: no access")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Registry scan failed: no access").parentElement!.querySelector("button")!);
    expect(screen.queryByText(/Registry scan failed/)).not.toBeInTheDocument();
  });

  it("does not show the registry error on the other tabs", async () => {
    handlers.scan_registry = () => {
      throw "no access";
    };
    await openRegistry();
    fireEvent.click(screen.getByText("Scan Registry", { selector: "button" }));
    await screen.findByText(/Registry scan failed/);
    fireEvent.click(tabButton("System"));
    expect(screen.queryByText(/Registry scan failed/)).not.toBeInTheDocument();
  });

  it("says the registry is clean when nothing is found, and scans again from there", async () => {
    await scanRegistry([]);
    expect(screen.getByText("Registry is Clean")).toBeInTheDocument();
    handlers.scan_registry = () => [reg("r1")];
    fireEvent.click(screen.getByText("Scan Again"));
    expect(await screen.findByText("Entry r1")).toBeInTheDocument();
  });

  it("groups entries by kind, with counts and each entry's key path and value", async () => {
    await scanRegistry([
      reg("r1", { category: "OrphanedInstaller", name: "Old installer" }),
      reg("r2", { category: "StartupEntry", name: "Dead startup", value_name: "Updater" }),
      reg("r3", { category: "StartupEntry", name: "Other startup" }),
      reg("r4", { category: "MUICache", name: "MUI thing" }),
    ]);
    expect(screen.getByText("Orphaned Installer (1)")).toBeInTheDocument();
    expect(screen.getByText("Startup Entry (2)")).toBeInTheDocument();
    expect(screen.getByText("MUI Cache Entry (1)")).toBeInTheDocument();
    expect(screen.queryByText(/Invalid App Path/)).not.toBeInTheDocument();
    expect(screen.getByText(/HKCU\\Software\\r2 → "Updater"/)).toBeInTheDocument();
    expect(screen.getByText("HKCU\\Software\\r3")).toBeInTheDocument();
  });

  it("selects entries one by one and all at once", async () => {
    await scanRegistry([reg("r1"), reg("r2")]);
    expect(screen.getByText("0/2 selected")).toBeInTheDocument();
    fireEvent.click(regRow("Entry r1"));
    expect(screen.getByText("1/2 selected")).toBeInTheDocument();
    fireEvent.click(regRow("Entry r1"));
    expect(screen.getByText("0/2 selected")).toBeInTheDocument();
    const all = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    fireEvent.click(all);
    expect(screen.getByText("2/2 selected")).toBeInTheDocument();
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    expect(screen.getByText("0/2 selected")).toBeInTheDocument();
  });

  it("asks for a backup before anything can be cleaned", async () => {
    await scanRegistry([reg("r1")]);
    fireEvent.click(regRow("Entry r1"));
    expect(screen.getByText("Backup required before cleaning")).toBeInTheDocument();
    const clean = screen.getByRole("button", { name: "Create Backup First" });
    expect(clean).toBeDisabled();
    expect(clean).toHaveAttribute("title", "Create a backup first before cleaning");
  });

  it("creates the backup, shows where it went, and unlocks cleaning", async () => {
    await scanRegistry([reg("r1")]);
    await backup();
    expect(screen.getByText("C:\\backup\\reg.reg")).toBeInTheDocument();
    expect(screen.queryByText("Create Backup")).not.toBeInTheDocument();
    expect(screen.getByText("Registry backup saved to: C:\\backup\\reg.reg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clean Selected \(0\)/ })).toBeDisabled();
    fireEvent.click(regRow("Entry r1"));
    expect(screen.getByRole("button", { name: /Clean Selected \(1\)/ })).toBeEnabled();
  });

  it("shows a backing-up state, and only one backup can run", async () => {
    const gate = deferred<unknown>();
    handlers.backup_registry = () => gate.promise;
    await scanRegistry([reg("r1")]);
    fireEvent.click(screen.getByText("Create Backup"));
    const button = (await screen.findByText("Backing up…")).closest("button")!;
    expect(button).toBeDisabled();
    await act(async () => {
      gate.resolve({ backup_path: "C:\\b.reg", success: true, error: null });
    });
    await screen.findByText("Backup saved");
  });

  it("reports a backup the system refused, with its reason or a default", async () => {
    await scanRegistry([reg("r1")]);
    handlers.backup_registry = () => ({ backup_path: "", success: false, error: "reg.exe failed" });
    fireEvent.click(screen.getByText("Create Backup"));
    expect(await screen.findByText("Backup failed: reg.exe failed")).toBeInTheDocument();
    handlers.backup_registry = () => ({ backup_path: "", success: false, error: null });
    fireEvent.click(screen.getByText("Create Backup"));
    await waitFor(() => expect(screen.getByText("Backup failed: Unknown error")).toBeInTheDocument());
    expect(screen.getByText("Backup required before cleaning")).toBeInTheDocument();
  });

  it("reports a backup command that throws", async () => {
    await scanRegistry([reg("r1")]);
    handlers.backup_registry = () => {
      throw "denied";
    };
    fireEvent.click(screen.getByText("Create Backup"));
    expect(await screen.findByText("Backup failed: denied")).toBeInTheDocument();
  });

  it("sends the chosen entries, and removes them from the list when they were deleted", async () => {
    handlers.clean_registry = (a) => ({
      items_cleaned: a.entries.length,
      errors: [],
      backup_path: "C:\\backup\\reg.reg",
      results: a.entries.map((e: { id: string }) => ({ id: e.id, success: true, error: null })),
    });
    await scanRegistry([reg("r1", { value_name: "V" }), reg("r2"), reg("r3")]);
    await backup();
    fireEvent.click(regRow("Entry r1"));
    fireEvent.click(regRow("Entry r3"));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected \(2\)/ }));
    expect(await screen.findByText("Registry cleaned: 2 entries removed.")).toBeInTheDocument();
    expect(calls("clean_registry")).toEqual([
      {
        entries: [
          { id: "r1", key_path: "HKCU\\Software\\r1", value_name: "V" },
          { id: "r3", key_path: "HKCU\\Software\\r3", value_name: null },
        ],
      },
    ]);
    expect(screen.queryByText("Entry r1")).not.toBeInTheDocument();
    expect(screen.queryByText("Entry r3")).not.toBeInTheDocument();
    expect(screen.getByText("Entry r2")).toBeInTheDocument();
    expect(screen.getByText("0/1 selected")).toBeInTheDocument();
  });

  it("keeps entries that could not be removed, and says why more can be done", async () => {
    handlers.clean_registry = () => ({
      items_cleaned: 1,
      errors: ["Access denied: HKLM\\..."],
      backup_path: "C:\\backup\\reg.reg",
      results: [
        { id: "r1", success: true, error: null },
        { id: "r2", success: false, error: "Access denied" },
      ],
    });
    await scanRegistry([reg("r1"), reg("r2", { elevation_required: true })]);
    await backup();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected \(2\)/ }));
    const message = await screen.findByText(/Cleaned 1 entries with 1 error\(s\)\./);
    expect(message).toHaveTextContent("need Administrator privileges");
    expect(screen.queryByText("Entry r1")).not.toBeInTheDocument();
    expect(screen.getByText("Entry r2")).toBeInTheDocument();
    expect(screen.getByText("1/1 selected")).toBeInTheDocument();
  });

  it("does not suggest administrator rights because of an entry that was removed", async () => {
    // The protected entry was removed (the app already runs as administrator); the one
    // that failed has an ordinary cause.
    handlers.clean_registry = () => ({
      items_cleaned: 1,
      errors: ["Key is in use"],
      backup_path: "b",
      results: [
        { id: "r1", success: true, error: null },
        { id: "r2", success: false, error: "Key is in use" },
      ],
    });
    await scanRegistry([reg("r1", { elevation_required: true }), reg("r2")]);
    await backup();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));
    const message = await screen.findByText(/Cleaned 1 entries with 1 error\(s\)\./);
    expect(message).not.toHaveTextContent("Administrator");
  });

  it("does not suggest administrator rights when the failure had another cause", async () => {
    handlers.clean_registry = () => ({
      items_cleaned: 0,
      errors: ["Key is in use"],
      backup_path: "b",
      results: [{ id: "r1", success: false, error: "Key is in use" }],
    });
    await scanRegistry([reg("r1")]);
    await backup();
    fireEvent.click(regRow("Entry r1"));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));
    const message = await screen.findByText(/Cleaned 0 entries with 1 error\(s\)\./);
    expect(message).not.toHaveTextContent("Administrator");
  });

  it("reports a clean that throws, and keeps the entries", async () => {
    handlers.clean_registry = () => {
      throw "registry locked";
    };
    await scanRegistry([reg("r1")]);
    await backup();
    fireEvent.click(regRow("Entry r1"));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));
    expect(await screen.findByText("Registry clean failed: registry locked")).toBeInTheDocument();
    expect(screen.getByText("Entry r1")).toBeInTheDocument();
  });

  it("shows a cleaning state while entries are being removed", async () => {
    const gate = deferred<unknown>();
    handlers.clean_registry = () => gate.promise;
    await scanRegistry([reg("r1")]);
    await backup();
    fireEvent.click(regRow("Entry r1"));
    fireEvent.click(screen.getByRole("button", { name: /Clean Selected/ }));
    expect(await screen.findByText("Cleaning Registry...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clean Selected/ })).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve({ items_cleaned: 1, errors: [], backup_path: "b", results: [{ id: "r1", success: true, error: null }] });
    });
  });

  it("asks for a new backup after a re-scan", async () => {
    await scanRegistry([reg("r1")]);
    await backup();
    fireEvent.click(screen.getByText("Re-scan"));
    await waitFor(() => expect(screen.getByText("Backup required before cleaning")).toBeInTheDocument());
  });

  it("warns about administrator rights when a protected entry is selected, with a relaunch button", async () => {
    await scanRegistry([reg("r1", { elevation_required: true }), reg("r2")]);
    expect(screen.queryByText(/under HKLM/)).not.toBeInTheDocument();
    fireEvent.click(regRow("Entry r1"));
    expect(screen.getByText(/under HKLM/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Relaunch as Administrator"));
    fireEvent.click(await screen.findByRole("button", { name: "Relaunch" }));
    await waitFor(() => expect(calls("relaunch_as_admin")).toHaveLength(1));
  });

  it("shows a failed relaunch once, on the registry tab", async () => {
    handlers.relaunch_as_admin = () => {
      throw "user declined";
    };
    await scanRegistry([reg("r1", { elevation_required: true })]);
    fireEvent.click(regRow("Entry r1"));
    fireEvent.click(screen.getByText("Relaunch as Administrator"));
    fireEvent.click(await screen.findByRole("button", { name: "Relaunch" }));
    await screen.findByText("Could not relaunch as Administrator: user declined");
    expect(screen.getAllByText(/Could not relaunch as Administrator/)).toHaveLength(1);
  });

  it("stays on the registry tab when the junk scan is repeated from the result screen", async () => {
    handlers.scan_registry = () => [reg("r1")];
    handlers.clean_system_junk = () => cleanOk();
    await scanWith([junk("a")]);
    fireEvent.click(tabButton("Registry"));
    fireEvent.click(screen.getByText("Scan Registry", { selector: "button" }));
    await screen.findByText("Entry r1");
    fireEvent.click(tabButton("System"));
    pick("Item a");
    fireEvent.click(cleanButton());
    await screen.findByText("Cleanup Complete!");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    fireEvent.click(tabButton("Registry"));
    handlers.scan_system_junk = () => [junk("fresh")];
    fireEvent.click(screen.getByText("Scan Again"));
    await waitFor(() => expect(calls("scan_system_junk")).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByText("Entry r1")).toBeInTheDocument();
    expect(screen.queryByText("Item fresh")).not.toBeInTheDocument();
  });

  it("marks protected and warned entries", async () => {
    await scanRegistry([reg("r1", { elevation_required: true, warning: "Careful" })]);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("Entry r1")).toHaveStyle({ color: "#f59e0b" });
  });
});
