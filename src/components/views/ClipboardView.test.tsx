import { render, screen, fireEvent, waitFor, within, act } from "../../test-support/rtl";
import "@testing-library/jest-dom";
import { ClipboardView } from "./ClipboardView";
import { ClipboardEntry } from "../../hooks/useClipboard";

const mockInvoke = jest.fn();
const mockReadText = jest.fn();
const mockWriteText = jest.fn();
const mockOpenUrl = jest.fn();
const mockPlatform = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: (...args: unknown[]) => mockReadText(...args),
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));
jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

function makeClip(id: string, overrides: Partial<ClipboardEntry> = {}): ClipboardEntry {
  return {
    id,
    content: `content-${id}`,
    preview: `preview-${id}`,
    category: "Text",
    created_at: 1_700_000_000,
    is_pinned: false,
    ...overrides,
  };
}

let stored: ClipboardEntry[];
let failing: Set<string>;
let loadFailure: string | null;

function backend() {
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (failing.has(cmd)) return Promise.reject("disk full");
    switch (cmd) {
      case "load_clipboard_vault":
        return loadFailure
          ? Promise.reject(loadFailure)
          : Promise.resolve({ entries: stored.map((e) => ({ ...e })) });
      case "save_clipboard_vault":
        stored = (args.vault as { entries: ClipboardEntry[] }).entries;
        return Promise.resolve(null);
      case "add_clipboard_entry":
        stored = [makeClip("pasted", { content: args.text as string, preview: args.text as string, created_at: 1_800_000_000 }), ...stored];
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
}

async function renderClipboard(entries: ClipboardEntry[] = []) {
  stored = entries;
  backend();
  const utils = render(<ClipboardView />);
  await waitFor(() => expect(screen.queryByText("Loading Clipboard History...")).not.toBeInTheDocument());
  return utils;
}

function cardOf(preview: string): HTMLElement {
  return screen.getByText(preview).closest(".clipboard-card") as HTMLElement;
}

function saves(): ClipboardEntry[][] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "save_clipboard_vault")
    .map(([, args]) => (args as { vault: { entries: ClipboardEntry[] } }).vault.entries);
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  failing = new Set();
  loadFailure = null;
  mockPlatform.mockReturnValue("windows");
  mockWriteText.mockResolvedValue(undefined);
  mockReadText.mockResolvedValue("");
  mockOpenUrl.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("ClipboardView - listing", () => {
  it("shows the empty state and hides the Clear button", async () => {
    await renderClipboard([]);
    expect(screen.getByText("Clipboard history is empty.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(screen.getByText(/0 items/)).toBeInTheDocument();
  });

  it("lists pinned items first, then newest, with the count and retention", async () => {
    await renderClipboard([
      makeClip("old", { created_at: 1_000 }),
      makeClip("new", { created_at: 3_000 }),
      makeClip("pin", { created_at: 500, is_pinned: true }),
    ]);
    const order = Array.from(document.querySelectorAll(".clip-preview")).map((n) => n.textContent);
    expect(order).toEqual(["preview-pin", "preview-new", "preview-old"]);
    expect(screen.getByText(/3 items/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-clears every 24h/)).toBeInTheDocument();
  });

  it("hides sensitive items until Show is pressed, and plain text never", async () => {
    await renderClipboard([
      makeClip("pw", { category: "Password", preview: "p••••rd", content: "hunter2" }),
      makeClip("txt", { category: "Text", preview: "just text" }),
    ]);
    expect(screen.queryByText("p••••rd")).not.toBeInTheDocument();
    expect(screen.getByText("just text")).toBeInTheDocument();
    expect(within(cardOf("just text")).queryByTitle("Show")).not.toBeInTheDocument();

    const pwCard = document.querySelectorAll(".clipboard-card")[0] as HTMLElement;
    expect(within(pwCard).getByText("•••• •••• •••• ••••")).toBeInTheDocument();
    fireEvent.click(within(pwCard).getByTitle("Show"));
    expect(screen.getByText("p••••rd")).toBeInTheDocument();
    fireEvent.click(within(pwCard).getByTitle("Hide"));
    expect(screen.queryByText("p••••rd")).not.toBeInTheDocument();
  });

  it.each(["Credit Card", "Bank Account", "API Key", "Secret"])("treats %s as sensitive", async (category) => {
    await renderClipboard([makeClip("a", { category, preview: "visible-preview" })]);
    expect(screen.queryByText("visible-preview")).not.toBeInTheDocument();
    expect(screen.getByTitle("Show")).toBeInTheDocument();
  });

  it("searches content and category", async () => {
    await renderClipboard([
      makeClip("a", { content: "alpha text", preview: "preview-a" }),
      makeClip("b", { content: "beta", preview: "preview-b", category: "Link" }),
    ]);
    const search = screen.getByPlaceholderText("Search history...");

    fireEvent.change(search, { target: { value: "ALPHA" } });
    expect(screen.getByText("preview-a")).toBeInTheDocument();
    expect(screen.queryByText("preview-b")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "link" } });
    expect(screen.getByText("preview-b")).toBeInTheDocument();
    expect(screen.queryByText("preview-a")).not.toBeInTheDocument();
  });

  it("explains a vault that cannot be read", async () => {
    loadFailure = "wrong key";
    stored = [];
    backend();
    render(<ClipboardView />);
    expect(await screen.findByText("Failed to load clipboard vault:")).toBeInTheDocument();
    expect(screen.getByText(/wrong key/)).toBeInTheDocument();
  });
});

describe("ClipboardView - retention", () => {
  it("changes the retention window, remembers it and reloads with it", async () => {
    await renderClipboard([makeClip("a")]);
    fireEvent.click(screen.getByText("24 Hours"));
    fireEvent.click(screen.getByText("1 Week"));

    await waitFor(() => expect(screen.getByText(/Auto-clears every 168h/)).toBeInTheDocument());
    expect(localStorage.getItem("qre_clip_retention_v1")).toBe("168");
    const loads = mockInvoke.mock.calls.filter(([c]) => c === "load_clipboard_vault");
    expect(loads[loads.length - 1][1]).toEqual({ retentionHours: 168, vaultId: "local" });
  });

  it("starts with the remembered retention", async () => {
    localStorage.setItem("qre_clip_retention_v1", "4");
    await renderClipboard([]);
    expect(screen.getByText(/Auto-clears every 4h/)).toBeInTheDocument();
    expect(screen.getByText("4 Hours")).toBeInTheDocument();
  });
});

describe("ClipboardView - copy", () => {
  it("copies an item and clears the system clipboard after 30 seconds", async () => {
    jest.useFakeTimers();
    try {
      await renderClipboard([makeClip("a", { content: "secret-value" })]);
      await act(async () => {
        fireEvent.click(screen.getByTitle("Copy"));
      });

      expect(mockWriteText).toHaveBeenCalledWith("secret-value");
      expect(screen.getByText(/Copied to clipboard/)).toBeInTheDocument();

      await act(async () => {
        jest.advanceTimersByTime(29_999);
      });
      expect(mockWriteText).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(mockWriteText).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("still clears the clipboard 30 seconds after copying, even if the view is closed", async () => {
    jest.useFakeTimers();
    try {
      const { unmount } = await renderClipboard([makeClip("a", { content: "secret-value" })]);
      await act(async () => {
        fireEvent.click(screen.getByTitle("Copy"));
      });
      unmount();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(mockWriteText).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("still clears the clipboard if the retention setting is changed in the meantime", async () => {
    jest.useFakeTimers();
    try {
      await renderClipboard([makeClip("a", { content: "secret-value" })]);
      await act(async () => {
        fireEvent.click(screen.getByTitle("Copy"));
      });
      await act(async () => {
        fireEvent.click(screen.getByText("24 Hours"));
      });
      await act(async () => {
        fireEvent.click(screen.getByText("1 Week"));
      });
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(mockWriteText).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not say it copied when the system clipboard refused", async () => {
    await renderClipboard([makeClip("a")]);
    mockWriteText.mockRejectedValue("clipboard locked");
    fireEvent.click(screen.getByTitle("Copy"));

    expect(await screen.findByText(/clipboard locked/)).toBeInTheDocument();
    expect(screen.queryByText(/Copied to clipboard/)).not.toBeInTheDocument();
    expect(screen.queryByText("Failed to load clipboard vault:")).not.toBeInTheDocument();
    expect(screen.getByText("preview-a")).toBeInTheDocument();
  });
});

describe("ClipboardView - secure paste", () => {
  it("stores the clipboard text, wipes the system clipboard and refreshes the list", async () => {
    await renderClipboard([]);
    mockReadText.mockResolvedValue("my new secret");
    fireEvent.click(screen.getByRole("button", { name: /Paste/ }));

    expect(await screen.findByText(/securely pasted/)).toBeInTheDocument();
    const add = mockInvoke.mock.calls.find(([c]) => c === "add_clipboard_entry")!;
    expect(add[1]).toEqual({ text: "my new secret", retentionHours: 24, vaultId: "local" });
    expect(mockWriteText).toHaveBeenCalledWith("");
    expect(await screen.findByText("my new secret")).toBeInTheDocument();
  });

  it("explains an empty clipboard and keeps the screen usable", async () => {
    await renderClipboard([makeClip("a")]);
    mockReadText.mockResolvedValue("   ");
    fireEvent.click(screen.getByRole("button", { name: /Paste/ }));

    expect(await screen.findByText(/Clipboard is empty/)).toBeInTheDocument();
    expect(mockInvoke.mock.calls.some(([c]) => c === "add_clipboard_entry")).toBe(false);
    expect(screen.queryByText("Failed to load clipboard vault:")).not.toBeInTheDocument();
    expect(screen.getByText("preview-a")).toBeInTheDocument();
  });

  it("works again after an earlier failed paste", async () => {
    await renderClipboard([]);
    mockReadText.mockResolvedValueOnce("");
    fireEvent.click(screen.getByRole("button", { name: /Paste/ }));
    await screen.findByText(/Clipboard is empty/);

    mockReadText.mockResolvedValue("second try");
    fireEvent.click(screen.getByRole("button", { name: /Paste/ }));

    expect(await screen.findByText(/securely pasted/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to load clipboard vault:")).not.toBeInTheDocument();
    expect(await screen.findByText("second try")).toBeInTheDocument();
  });

  it("refuses content over 1 MB", async () => {
    await renderClipboard([]);
    mockReadText.mockResolvedValue("x".repeat(1_000_001));
    fireEvent.click(screen.getByRole("button", { name: /Paste/ }));

    expect(await screen.findByText(/too large/)).toBeInTheDocument();
    expect(mockInvoke.mock.calls.some(([c]) => c === "add_clipboard_entry")).toBe(false);
  });

  it("does not wipe the system clipboard if storing failed", async () => {
    await renderClipboard([]);
    failing.add("add_clipboard_entry");
    mockReadText.mockResolvedValue("precious");
    fireEvent.click(screen.getByRole("button", { name: /Paste/ }));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(mockWriteText).not.toHaveBeenCalledWith("");
  });
});

describe("ClipboardView - delete, pin and clear", () => {
  it("deletes one item and saves the rest", async () => {
    await renderClipboard([makeClip("a"), makeClip("b", { created_at: 1 })]);
    fireEvent.click(within(cardOf("preview-a")).getByTitle("Delete Entry"));

    await waitFor(() => expect(screen.queryByText("preview-a")).not.toBeInTheDocument());
    expect(saves().pop()!.map((e) => e.id)).toEqual(["b"]);
  });

  it("keeps the item and shows an error when a delete cannot be saved", async () => {
    await renderClipboard([makeClip("a")]);
    failing.add("save_clipboard_vault");
    fireEvent.click(screen.getByTitle("Delete Entry"));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to load clipboard vault:")).not.toBeInTheDocument();
    expect(screen.getByText("preview-a")).toBeInTheDocument();
  });

  it("pins and unpins an item", async () => {
    await renderClipboard([makeClip("a")]);
    fireEvent.click(screen.getByTitle("Pin to Top"));
    await waitFor(() => expect(screen.getByTitle("Unpin")).toBeInTheDocument());
    expect(saves().pop()![0]).toMatchObject({ id: "a", is_pinned: true });

    fireEvent.click(screen.getByTitle("Unpin"));
    await waitFor(() => expect(screen.getByTitle("Pin to Top")).toBeInTheDocument());
    expect(saves().pop()![0]).toMatchObject({ id: "a", is_pinned: false });
  });

  it("shows an error and keeps the list when pinning cannot be saved", async () => {
    await renderClipboard([makeClip("a")]);
    failing.add("save_clipboard_vault");
    fireEvent.click(screen.getByTitle("Pin to Top"));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to load clipboard vault:")).not.toBeInTheDocument();
    expect(screen.getByTitle("Pin to Top")).toBeInTheDocument();
  });

  it("asks before clearing everything and can be cancelled", async () => {
    await renderClipboard([makeClip("a"), makeClip("b")]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Clear History?")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Clear History?")).not.toBeInTheDocument();
    expect(saves()).toHaveLength(0);
  });

  it("clears every item once confirmed", async () => {
    await renderClipboard([makeClip("a"), makeClip("b")]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, Clear All" }));

    expect(await screen.findByText("All clipboard history cleared.")).toBeInTheDocument();
    expect(saves().pop()).toEqual([]);
    expect(screen.getByText("Clipboard history is empty.")).toBeInTheDocument();
  });

  it("does not claim the history was cleared when it could not be saved", async () => {
    await renderClipboard([makeClip("a")]);
    failing.add("save_clipboard_vault");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, Clear All" }));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(screen.queryByText("All clipboard history cleared.")).not.toBeInTheDocument();
    expect(screen.getByText("preview-a")).toBeInTheDocument();
  });
});

describe("ClipboardView - links", () => {
  it("offers Open Link only for links and opens the stored URL", async () => {
    await renderClipboard([
      makeClip("l", { category: "Link", content: "https://example.com/x", preview: "link-preview" }),
      makeClip("t", { preview: "text-preview", created_at: 1 }),
    ]);
    expect(within(cardOf("text-preview")).queryByTitle("Open Link")).not.toBeInTheDocument();

    fireEvent.click(within(cardOf("link-preview")).getByTitle("Open Link"));
    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/x");
  });
});

describe("ClipboardView - keyboard shortcuts", () => {
  it("Ctrl+F puts the cursor in the search box", async () => {
    await renderClipboard([]);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByPlaceholderText("Search history...")).toHaveFocus();
  });
});

describe("ClipboardView - on Android", () => {
  const header = () => document.querySelector(".clipboard-header") as HTMLElement;

  it("stacks the header controls in a column", async () => {
    mockPlatform.mockReturnValue("android");
    await renderClipboard([]);
    await waitFor(() => expect(header().style.flexDirection).toBe("column"));
  });

  it("lays the header out in a row on a computer", async () => {
    mockPlatform.mockReturnValue("macos");
    await renderClipboard([]);
    expect(header().style.flexDirection).toBe("row");
  });
});
