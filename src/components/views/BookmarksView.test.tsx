import { render, screen, fireEvent, waitFor, within } from "../../test-support/rtl";
import "@testing-library/jest-dom";
import { BookmarksView } from "./BookmarksView";
import { BookmarkEntry } from "../../hooks/useBookmarks";

const mockInvoke = jest.fn();
const mockOpenUrl = jest.fn();
const mockPlatform = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

function makeBookmark(id: string, title: string, overrides: Partial<BookmarkEntry> = {}): BookmarkEntry {
  return {
    id,
    title,
    url: `https://${id}.example.com`,
    category: "General",
    created_at: 1_700_000_000,
    is_pinned: false,
    ...overrides,
  };
}

let saveFailure: string | null;
let loadFailure: string | null;
let importResult: number | string;
let loadCount: number;

function backend(entries: BookmarkEntry[]) {
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "load_bookmarks_vault":
        loadCount += 1;
        return loadFailure
          ? Promise.reject(loadFailure)
          : Promise.resolve({ entries: entries.map((e) => ({ ...e })) });
      case "save_bookmarks_vault":
        return saveFailure ? Promise.reject(saveFailure) : Promise.resolve(null);
      case "import_browser_bookmarks":
        return typeof importResult === "string" ? Promise.reject(importResult) : Promise.resolve(importResult);
      default:
        return Promise.resolve(null);
    }
  });
}

async function renderBookmarks(entries: BookmarkEntry[] = []) {
  backend(entries);
  const utils = render(<BookmarksView />);
  await waitFor(() => expect(screen.queryByText("Loading Bookmarks...")).not.toBeInTheDocument());
  return utils;
}

function savedVaults(): BookmarkEntry[][] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "save_bookmarks_vault")
    .map(([, args]) => (args as { vault: { entries: BookmarkEntry[] } }).vault.entries);
}
const lastSaved = () => savedVaults().slice(-1)[0];

function cardOf(title: string): HTMLElement {
  return screen.getByText(title).closest(".modern-card") as HTMLElement;
}

function titlesInOrder(): string[] {
  return Array.from(document.querySelectorAll(".modern-card")).map(
    (c) => (c.querySelector("div[style*='font-weight']") as HTMLElement | null)?.textContent ?? c.textContent ?? "",
  );
}

const fill = (placeholder: string, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
const clickAddNew = () => fireEvent.click(screen.getByRole("button", { name: "Add New" }));
const clickSave = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

beforeEach(() => {
  jest.clearAllMocks();
  saveFailure = null;
  loadFailure = null;
  importResult = 0;
  loadCount = 0;
  mockPlatform.mockReturnValue("windows");
  mockOpenUrl.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("BookmarksView - listing", () => {
  it("shows the empty state", async () => {
    await renderBookmarks([]);
    expect(screen.getByText("No bookmarks yet.")).toBeInTheDocument();
    expect(screen.getByText("0 stored")).toBeInTheDocument();
  });

  it("shows pinned bookmarks first, then the newest", async () => {
    await renderBookmarks([
      makeBookmark("old", "Old", { created_at: 1_000 }),
      makeBookmark("new", "New", { created_at: 3_000 }),
      makeBookmark("pin", "Pinned", { created_at: 500, is_pinned: true }),
    ]);
    const order = Array.from(document.querySelectorAll(".modern-card")).map((c) => c.textContent ?? "");
    expect(order[0]).toContain("Pinned");
    expect(order[1]).toContain("New");
    expect(order[2]).toContain("Old");
    expect(screen.getByText("3 stored")).toBeInTheDocument();
    expect(titlesInOrder()).toHaveLength(3);
  });

  it("shows the site name rather than the whole URL", async () => {
    await renderBookmarks([makeBookmark("a", "Docs", { url: "https://www.rust-lang.org/learn?x=1" })]);
    expect(within(cardOf("Docs")).getByText("rust-lang.org")).toBeInTheDocument();
  });

  it("searches title, URL and category", async () => {
    await renderBookmarks([
      makeBookmark("a", "My Bank", { category: "Finance" }),
      makeBookmark("b", "Recipes", { url: "https://cooking.test" }),
      makeBookmark("c", "News"),
    ]);
    const search = screen.getByPlaceholderText("Search...");

    fireEvent.change(search, { target: { value: "bank" } });
    expect(screen.getByText("My Bank")).toBeInTheDocument();
    expect(screen.queryByText("Recipes")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "COOKING" } });
    expect(screen.getByText("Recipes")).toBeInTheDocument();
    expect(screen.queryByText("My Bank")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "financ" } });
    expect(screen.getByText("My Bank")).toBeInTheDocument();
  });

  it("explains a vault that cannot be read", async () => {
    loadFailure = "wrong key";
    backend([]);
    render(<BookmarksView />);
    expect(await screen.findByText("Failed to load bookmarks vault:")).toBeInTheDocument();
    expect(screen.getByText(/wrong key/)).toBeInTheDocument();
  });
});

describe("BookmarksView - adding and editing", () => {
  it("saves a new bookmark and shows it", async () => {
    await renderBookmarks([]);
    clickAddNew();
    expect(screen.getByText("Add Bookmark")).toBeInTheDocument();
    fill("Title (e.g. My Bank)", "  Example  ");
    fill("URL (https://...)", "https://example.com/path");
    fill("Category (e.g. Finance)", "Reading");
    clickSave();

    await waitFor(() => expect(screen.queryByText("Add Bookmark")).not.toBeInTheDocument());
    expect(lastSaved()).toHaveLength(1);
    expect(lastSaved()[0]).toMatchObject({
      title: "Example",
      url: "https://example.com/path",
      category: "Reading",
      is_pinned: false,
    });
    expect(lastSaved()[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByText("Example")).toBeInTheDocument();
    expect(screen.getByText("1 stored")).toBeInTheDocument();
  });

  it("adds https:// to a URL typed without a scheme", async () => {
    await renderBookmarks([]);
    clickAddNew();
    fill("Title (e.g. My Bank)", "Bare");
    fill("URL (https://...)", "example.com");
    clickSave();

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].url).toBe("https://example.com");
  });

  it("requires a title and a URL", async () => {
    await renderBookmarks([]);
    clickAddNew();
    fill("URL (https://...)", "example.com");
    clickSave();
    expect(await screen.findByText("Bookmark title cannot be empty.")).toBeInTheDocument();

    fill("Title (e.g. My Bank)", "Has title");
    fill("URL (https://...)", "   ");
    clickSave();
    expect(await screen.findByText("Bookmark URL cannot be empty.")).toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it.each(["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "vbscript:msgbox(1)"])(
    "refuses to store %s",
    async (url) => {
      await renderBookmarks([]);
      clickAddNew();
      fill("Title (e.g. My Bank)", "Sneaky");
      fill("URL (https://...)", url);
      clickSave();

      expect(await screen.findByText(/Dangerous URL scheme/)).toBeInTheDocument();
      expect(savedVaults()).toHaveLength(0);
    },
  );

  it("warns when the URL is already saved, ignoring case and a trailing slash", async () => {
    await renderBookmarks([makeBookmark("a", "Existing", { url: "https://Example.com/" })]);
    clickAddNew();
    fill("URL (https://...)", "https://example.com");
    expect(screen.getByText(/already exists in your vault/)).toBeInTheDocument();
  });

  it("does not warn about duplicates when editing the bookmark itself", async () => {
    await renderBookmarks([makeBookmark("a", "Existing", { url: "https://example.com" })]);
    fireEvent.click(screen.getByText("Existing"));
    expect(screen.getByText("Edit Bookmark")).toBeInTheDocument();
    expect(screen.queryByText(/already exists in your vault/)).not.toBeInTheDocument();
  });

  it("edits a bookmark and keeps its id and creation time", async () => {
    await renderBookmarks([makeBookmark("a", "Old title", { created_at: 1_600_000_000, category: "Misc" })]);
    fireEvent.click(screen.getByText("Old title"));
    fill("Title (e.g. My Bank)", "New title");
    clickSave();

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()).toHaveLength(1);
    expect(lastSaved()[0]).toMatchObject({ id: "a", title: "New title", created_at: 1_600_000_000, category: "Misc" });
  });

  it("shows the error and keeps the editor open when saving fails", async () => {
    await renderBookmarks([]);
    saveFailure = "disk full";
    clickAddNew();
    fill("Title (e.g. My Bank)", "Doomed");
    fill("URL (https://...)", "doomed.test");
    clickSave();

    expect(await screen.findByText(/Failed to save: .*disk full/)).toBeInTheDocument();
    expect(screen.getByText("Add Bookmark")).toBeInTheDocument();
  });

  it("keeps showing the bookmarks after a failed save is cancelled", async () => {
    await renderBookmarks([makeBookmark("a", "Still here")]);
    clickAddNew();
    fill("Title (e.g. My Bank)", "Bad");
    fill("URL (https://...)", "javascript:alert(1)");
    clickSave();
    await screen.findByText(/Dangerous URL scheme/);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Failed to load bookmarks vault:")).not.toBeInTheDocument();
    expect(screen.getByText("Still here")).toBeInTheDocument();
  });
});

describe("BookmarksView - opening links", () => {
  function clickOpen(title: string) {
    fireEvent.click(within(cardOf(title)).getByRole("button", { name: /Open/ }));
  }

  it("opens a normal link in the browser", async () => {
    await renderBookmarks([makeBookmark("a", "Site", { url: "https://example.com/page" })]);
    clickOpen("Site");
    await waitFor(() => expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/page"));
  });

  it("adds https:// to an older bookmark that was stored without a scheme", async () => {
    await renderBookmarks([makeBookmark("a", "Legacy", { url: "example.com/old" })]);
    clickOpen("Legacy");
    await waitFor(() => expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/old"));
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "file:///C:/secret.txt", "VBScript:run"])(
    "blocks a stored %s link and explains why",
    async (url) => {
      await renderBookmarks([makeBookmark("a", "Bad", { url })]);
      clickOpen("Bad");

      expect(await screen.findByText(/blocked URL scheme/)).toBeInTheDocument();
      expect(mockOpenUrl).not.toHaveBeenCalled();
    },
  );

  it("shows an error if the system cannot open the link", async () => {
    await renderBookmarks([makeBookmark("a", "Site")]);
    mockOpenUrl.mockRejectedValue("no browser");
    clickOpen("Site");
    expect(await screen.findByText(/Error opening link: .*no browser/)).toBeInTheDocument();
  });

  it("warns before opening a direct download and respects Cancel", async () => {
    await renderBookmarks([makeBookmark("a", "Installer", { url: "https://dl.test/setup.exe?v=2" })]);
    clickOpen("Installer");

    expect(screen.getByText("Download Warning")).toBeInTheDocument();
    expect(mockOpenUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Download Warning")).not.toBeInTheDocument();
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("opens the download only after 'Open Anyway'", async () => {
    await renderBookmarks([makeBookmark("a", "Installer", { url: "https://dl.test/tool.zip" })]);
    clickOpen("Installer");
    fireEvent.click(screen.getByRole("button", { name: "Open Anyway" }));
    await waitFor(() => expect(mockOpenUrl).toHaveBeenCalledWith("https://dl.test/tool.zip"));
  });
});

describe("BookmarksView - pin and delete", () => {
  it("pins a bookmark from its card", async () => {
    await renderBookmarks([makeBookmark("a", "Site")]);
    const card = cardOf("Site");
    const pinBtn = Array.from(card.querySelectorAll("button.icon-btn-ghost")).find(
      (b) => !(b as HTMLElement).title,
    ) as HTMLElement;
    fireEvent.click(pinBtn);

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0]).toMatchObject({ id: "a", is_pinned: true });
  });

  it("keeps the list and explains the problem when pinning cannot be saved", async () => {
    await renderBookmarks([makeBookmark("a", "Site")]);
    saveFailure = "disk full";
    const card = cardOf("Site");
    const pinBtn = Array.from(card.querySelectorAll("button.icon-btn-ghost")).find(
      (b) => !(b as HTMLElement).title,
    ) as HTMLElement;
    fireEvent.click(pinBtn);

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to load bookmarks vault:")).not.toBeInTheDocument();
    expect(screen.getByText("Site")).toBeInTheDocument();
  });

  it("deletes only after confirmation", async () => {
    await renderBookmarks([makeBookmark("a", "Keep"), makeBookmark("b", "Remove")]);
    fireEvent.click(within(cardOf("Remove")).getByTitle("Delete Bookmark"));
    expect(screen.getByText("Delete Item")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(savedVaults()).toHaveLength(0);

    fireEvent.click(within(cardOf("Remove")).getByTitle("Delete Bookmark"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Remove")).not.toBeInTheDocument());
    expect(lastSaved().map((b) => b.id)).toEqual(["a"]);
  });

  it("keeps the list and explains the problem when a delete cannot be saved", async () => {
    await renderBookmarks([makeBookmark("a", "Stubborn")]);
    saveFailure = "disk full";
    fireEvent.click(within(cardOf("Stubborn")).getByTitle("Delete Bookmark"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to load bookmarks vault:")).not.toBeInTheDocument();
    expect(screen.getByText("Stubborn")).toBeInTheDocument();
  });
});

describe("BookmarksView - import from browser", () => {
  it("asks first, then imports and reloads the list", async () => {
    await renderBookmarks([]);
    importResult = 3;
    fireEvent.click(screen.getByTitle("Import from Browser"));
    expect(screen.getByText("Import Bookmarks")).toBeInTheDocument();
    expect(mockInvoke.mock.calls.some(([c]) => c === "import_browser_bookmarks")).toBe(false);

    const loadsBefore = loadCount;
    fireEvent.click(screen.getByRole("button", { name: "Yes, Import" }));

    expect(await screen.findByText("Successfully imported 3 bookmarks.")).toBeInTheDocument();
    await waitFor(() => expect(loadCount).toBe(loadsBefore + 1));
  });

  it("can be cancelled", async () => {
    await renderBookmarks([]);
    fireEvent.click(screen.getByTitle("Import from Browser"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Import Bookmarks")).not.toBeInTheDocument();
    expect(mockInvoke.mock.calls.some(([c]) => c === "import_browser_bookmarks")).toBe(false);
  });

  it("reports an import failure", async () => {
    await renderBookmarks([]);
    importResult = "No bookmarks found.";
    fireEvent.click(screen.getByTitle("Import from Browser"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, Import" }));
    expect(await screen.findByText(/Import failed: No bookmarks found\./)).toBeInTheDocument();
  });

  it("hides browser import on Android", async () => {
    mockPlatform.mockReturnValue("android");
    await renderBookmarks([]);
    expect(screen.queryByTitle("Import from Browser")).not.toBeInTheDocument();
  });
});

// ─── Escape key ──────────────────────────────────────────────────────────────

describe("BookmarksView - Escape key", () => {
  const escape = () => fireEvent.keyDown(window, { key: "Escape" });

  it("closes the add/edit dialog without saving", async () => {
    await renderBookmarks([]);
    clickAddNew();
    fill("Title (e.g. My Bank)", "Draft");
    expect(screen.getByText("Add Bookmark")).toBeInTheDocument();

    escape();

    expect(screen.queryByText("Add Bookmark")).not.toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("closes the import dialog", async () => {
    await renderBookmarks([]);
    fireEvent.click(screen.getByTitle("Import from Browser"));
    escape();
    expect(screen.queryByText("Import Bookmarks")).not.toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("import_browser_bookmarks", expect.anything());
  });

  it("does nothing when no dialog is open", async () => {
    await renderBookmarks([makeBookmark("a", "Alpha")]);
    escape();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });
});

// ─── Keyboard shortcuts ──────────────────────────────────────────────────────

describe("BookmarksView - keyboard shortcuts", () => {
  const ctrl = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true });

  it("Ctrl+N opens an empty editor", async () => {
    await renderBookmarks([]);
    ctrl("n");
    expect(screen.getByText("Add Bookmark")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Title (e.g. My Bank)")).toHaveValue("");
  });

  it("Ctrl+F puts the cursor in the search box", async () => {
    await renderBookmarks([makeBookmark("a", "Alpha")]);
    ctrl("f");
    expect(screen.getByPlaceholderText("Search...")).toHaveFocus();
  });

  it("Ctrl+S saves the open bookmark", async () => {
    await renderBookmarks([]);
    ctrl("n");
    fill("Title (e.g. My Bank)", "Shortcut");
    fireEvent.change(screen.getByPlaceholderText(/https?:\/\//i), { target: { value: "https://example.org" } });
    ctrl("s");

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0]).toMatchObject({ title: "Shortcut", url: "https://example.org" });
    expect(screen.queryByText("Add Bookmark")).not.toBeInTheDocument();
  });

  it("Ctrl+S with an empty title shows the same error as the button", async () => {
    await renderBookmarks([]);
    ctrl("n");
    ctrl("s");
    expect(await screen.findByText("Bookmark title cannot be empty.")).toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("Ctrl+S does nothing when no editor is open", async () => {
    await renderBookmarks([makeBookmark("a", "Alpha")]);
    ctrl("s");
    expect(savedVaults()).toHaveLength(0);
  });

  it("Ctrl+N does not open an editor behind the import dialog", async () => {
    await renderBookmarks([]);
    fireEvent.click(screen.getByTitle("Import from Browser"));
    ctrl("n");
    expect(screen.queryByText("Add Bookmark")).not.toBeInTheDocument();
  });
});
