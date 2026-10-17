import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NotesView } from "./NotesView";
import { NoteEntry } from "../../hooks/useNotes";

const mockInvoke = jest.fn();
const mockOpen = jest.fn();
const mockSave = jest.fn();
const mockClipboardWrite = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
  save: (...args: unknown[]) => mockSave(...args),
}));

function makeNote(id: string, title: string, overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    id,
    title,
    content: `content of ${title}`,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    is_pinned: false,
    tags: [],
    ...overrides,
  };
}

let saveGate: Promise<void> | null;
let fileContents: string;
let writeFailure: string | null;

function backend(notes: NoteEntry[]) {
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "load_notes_vault":
        return Promise.resolve({ entries: notes.map((n) => ({ ...n })) });
      case "save_notes_vault":
        return saveGate ? saveGate.then(() => null) : Promise.resolve(null);
      case "read_text_file_content":
        return Promise.resolve(fileContents);
      case "write_text_file_content":
        return writeFailure ? Promise.reject(writeFailure) : Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
}

async function renderNotes(notes: NoteEntry[] = []) {
  backend(notes);
  const utils = render(<NotesView />);
  await waitFor(() => expect(screen.queryByText("Loading Notes…")).not.toBeInTheDocument());
  return utils;
}

function savedVaults(): NoteEntry[][] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "save_notes_vault")
    .map(([, args]) => (args as { vault: { entries: NoteEntry[] } }).vault.entries);
}
const lastSaved = () => savedVaults().slice(-1)[0];

const titleInput = () => screen.getByPlaceholderText("Untitled Note") as HTMLInputElement;
const body = () => screen.getByPlaceholderText("Write something secure…") as HTMLTextAreaElement;
const setTitle = (v: string) => fireEvent.change(titleInput(), { target: { value: v } });
const setBody = (v: string) => fireEvent.change(body(), { target: { value: v } });
const clickSaveClose = () => fireEvent.click(screen.getByRole("button", { name: "Save & Close" }));
const openNewNote = () => fireEvent.click(screen.getByRole("button", { name: "New Note" }));
const openNote = (title: string) => fireEvent.click(screen.getByText(title));
const byTitle = (t: string) => screen.getByTitle(t);

function cardTitles(): string[] {
  return Array.from(document.querySelectorAll(".note-card-modern .note-header")).map(
    (n) => n.textContent?.trim() ?? "",
  );
}
function listTitles(): string[] {
  return Array.from(document.querySelectorAll(".list-item-title")).map((n) => n.textContent ?? "");
}

beforeEach(() => {
  jest.clearAllMocks();
  saveGate = null;
  fileContents = "";
  writeFailure = null;
  mockClipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockClipboardWrite },
    configurable: true,
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─── Sorting and layout ──────────────────────────────────────────────────────

describe("NotesView - sorting", () => {
  const notes = () => [
    makeNote("a", "Banana", { created_at: 100, updated_at: 300, content: "x" }),
    makeNote("b", "Apple", { created_at: 300, updated_at: 100, content: "xxxxxx" }),
    makeNote("c", "Cherry", { created_at: 200, updated_at: 200, content: "xxx" }),
    makeNote("d", "Zed", { created_at: 50, updated_at: 50, content: "", is_pinned: true }),
  ];

  async function sortBy(label: string) {
    fireEvent.click(screen.getByText("Last Modified"));
    fireEvent.click(screen.getByText(label));
  }

  it("starts with the most recently modified, pinned notes first", async () => {
    await renderNotes(notes());
    expect(cardTitles()).toEqual(["Zed", "Banana", "Cherry", "Apple"]);
  });

  it.each([
    ["Date Created", ["Zed", "Apple", "Cherry", "Banana"]],
    ["Title A→Z", ["Zed", "Apple", "Banana", "Cherry"]],
    ["Longest First", ["Zed", "Apple", "Cherry", "Banana"]],
  ])("sorts by %s, keeping pinned notes on top", async (label, expected) => {
    await renderNotes(notes());
    await sortBy(label);
    expect(cardTitles()).toEqual(expected);
  });

  it("closes the menu after a choice and shows the chosen sort", async () => {
    await renderNotes(notes());
    await sortBy("Title A→Z");
    expect(screen.queryByText("Longest First")).not.toBeInTheDocument();
    expect(screen.getByText("Title A→Z")).toBeInTheDocument();
  });

  it("closes the menu on a click elsewhere without changing the sort", async () => {
    await renderNotes(notes());
    fireEvent.click(screen.getByText("Last Modified"));
    expect(screen.getByText("Longest First")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Longest First")).not.toBeInTheDocument();
    expect(screen.getByText("Last Modified")).toBeInTheDocument();
  });

  it("keeps the menu open on a click inside it", async () => {
    await renderNotes(notes());
    fireEvent.click(screen.getByText("Last Modified"));
    fireEvent.mouseDown(screen.getByText("Longest First"));
    expect(screen.getByText("Longest First")).toBeInTheDocument();
  });
});

describe("NotesView - cards", () => {
  it("shows the title, a plain-text preview, tags, word count and date", async () => {
    await renderNotes([
      makeNote("a", "Plan", {
        content: "# Heading\n**bold** and *italic*",
        tags: ["home", "todo"],
      }),
    ]);
    const card = document.querySelector(".note-card-modern") as HTMLElement;
    expect(card.querySelector(".note-body")).toHaveTextContent("Heading bold and italic");
    expect(card.querySelectorAll(".card-tag")).toHaveLength(2);
    expect(card).toHaveTextContent("4 words");
    expect(card).toHaveTextContent("Modified:");
  });

  it("says 'Untitled' and 'Empty note' for a note with neither", async () => {
    await renderNotes([makeNote("a", "", { content: "" })]);
    expect(cardTitles()).toEqual(["Untitled"]);
    expect(screen.getByText("Empty note…")).toBeInTheDocument();
  });

  it("marks a pinned card and offers Unpin", async () => {
    await renderNotes([makeNote("a", "Starred", { is_pinned: true })]);
    expect(document.querySelector(".note-card-modern")).toHaveClass("pinned");
    expect(byTitle("Unpin")).toBeInTheDocument();
  });

  it("unpins from the card", async () => {
    await renderNotes([makeNote("a", "Starred", { is_pinned: true })]);
    fireEvent.click(byTitle("Unpin"));
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].is_pinned).toBe(false);
  });

  it("does not open the editor when a card button is used", async () => {
    await renderNotes([makeNote("a", "Quiet")]);
    fireEvent.click(byTitle("Copy content"));
    fireEvent.click(byTitle("Pin"));
    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
  });

  it("shows the text around a search match", async () => {
    const long = "intro ".repeat(40) + "NEEDLE " + "outro ".repeat(40);
    await renderNotes([makeNote("a", "Long", { content: long })]);
    fireEvent.change(screen.getByPlaceholderText("Search notes…"), { target: { value: "needle" } });
    const text = document.querySelector(".note-body")!.textContent!;
    expect(text).toContain("NEEDLE");
    expect(text.startsWith("…")).toBe(true);
  });

  it("clears the tag filter when the active tag is clicked again", async () => {
    await renderNotes([
      makeNote("a", "One", { tags: ["home"] }),
      makeNote("b", "Two", { tags: ["work"] }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "work" }));
    expect(cardTitles()).toEqual(["Two"]);
    fireEvent.click(screen.getByRole("button", { name: "work" }));
    expect(cardTitles()).toHaveLength(2);
  });

  it("lists each tag once, in alphabetical order", async () => {
    await renderNotes([
      makeNote("a", "One", { tags: ["zeta", "alpha"] }),
      makeNote("b", "Two", { tags: ["alpha", "mid"] }),
    ]);
    const chips = Array.from(document.querySelectorAll(".tag-filter-bar .filter-chip")).map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["All", "alpha", "mid", "zeta"]);
  });

  it("shows no empty-notebook message when a search finds nothing", async () => {
    await renderNotes([makeNote("a", "One")]);
    fireEvent.change(screen.getByPlaceholderText("Search notes…"), { target: { value: "zzz" } });
    expect(cardTitles()).toEqual([]);
    expect(screen.queryByText("Your notebook is empty.")).not.toBeInTheDocument();
  });
});

describe("NotesView - list layout", () => {
  const notes = () => [
    makeNote("a", "Alpha", { tags: ["x"], content: "one two three", is_pinned: true }),
    makeNote("b", "Beta", { updated_at: 1_600_000_000 }),
  ];

  it("switches between grid and list", async () => {
    await renderNotes(notes());
    expect(document.querySelector(".modern-grid")).not.toBeNull();
    fireEvent.click(byTitle("List view"));
    expect(document.querySelector(".modern-grid")).toBeNull();
    expect(listTitles()).toEqual(["Alpha", "Beta"]);
    fireEvent.click(byTitle("Grid view"));
    expect(document.querySelector(".notes-list-view")).toBeNull();
    expect(cardTitles()).toEqual(["Alpha", "Beta"]);
  });

  it("shows words, tags and pin state per row", async () => {
    await renderNotes(notes());
    fireEvent.click(byTitle("List view"));
    const first = document.querySelector(".notes-list-item") as HTMLElement;
    expect(first).toHaveClass("pinned");
    expect(first).toHaveTextContent("3 words");
    expect(first.querySelectorAll(".card-tag")).toHaveLength(1);
    expect(first.querySelector(".pinned-icon")).not.toBeNull();
  });

  it("opens a note when its row is clicked", async () => {
    await renderNotes(notes());
    fireEvent.click(byTitle("List view"));
    fireEvent.click(screen.getByText("Beta"));
    expect(titleInput().value).toBe("Beta");
  });

  it("copies from a row without opening it, then clears the clipboard", async () => {
    jest.useFakeTimers();
    try {
      await renderNotes(notes());
      fireEvent.click(byTitle("List view"));
      await act(async () => {
        fireEvent.click(screen.getAllByTitle("Copy content")[0]);
      });
      expect(mockClipboardWrite).toHaveBeenCalledWith("one two three");
      expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(mockClipboardWrite).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("deletes from a row after confirmation, without opening it", async () => {
    await renderNotes(notes());
    fireEvent.click(byTitle("List view"));
    fireEvent.click(screen.getAllByTitle("Delete")[1]);
    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
    const dialog = screen.getByText('"Beta"').closest(".auth-card") as HTMLElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(listTitles()).toEqual(["Alpha"]));
  });

  it("names an untitled note in the delete question", async () => {
    await renderNotes([makeNote("a", "")]);
    fireEvent.click(document.querySelector('[title="Delete note"]') as HTMLElement);
    expect(screen.getByText('"Untitled Note"')).toBeInTheDocument();
  });
});

// ─── Copy ────────────────────────────────────────────────────────────────────

describe("NotesView - copy", () => {
  it("shows a tick for two seconds after the latest copy", async () => {
    jest.useFakeTimers();
    try {
      await renderNotes([makeNote("a", "One"), makeNote("b", "Two")]);
      const [first, second] = screen.getAllByTitle("Copy content");
      await act(async () => {
        fireEvent.click(first);
      });
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      await act(async () => {
        fireEvent.click(second);
      });
      await act(async () => {
        jest.advanceTimersByTime(1000); // the first copy's 2 seconds are over, the second's are not
      });
      const cards = document.querySelectorAll(".note-card-modern");
      const ticked = Array.from(cards).map((c) => c.querySelector("svg.lucide-check") !== null);
      expect(ticked.filter(Boolean)).toHaveLength(1);
      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
      expect(document.querySelector("svg.lucide-check")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("tells the user if the clipboard refused, with no tick and no wipe", async () => {
    jest.useFakeTimers();
    try {
      mockClipboardWrite.mockRejectedValue(new Error("denied"));
      await renderNotes([makeNote("a", "One")]);
      await act(async () => {
        fireEvent.click(byTitle("Copy content"));
      });
      expect(screen.getByText(/Could not copy/)).toBeInTheDocument();
      expect(document.querySelector("svg.lucide-check")).toBeNull();
      mockClipboardWrite.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(mockClipboardWrite).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── Editor basics ───────────────────────────────────────────────────────────

describe("NotesView - editor", () => {
  it("shows character and word counts as you type", async () => {
    await renderNotes([]);
    openNewNote();
    setBody("hello brave new world");
    expect(screen.getByText(/21 chars • 4 words/)).toBeInTheDocument();
  });

  it("marks unsaved changes, and a note with no title stays marked", async () => {
    jest.useFakeTimers();
    try {
      await renderNotes([]);
      openNewNote();
      expect(screen.queryByText(/Unsaved/)).not.toBeInTheDocument();
      setBody("draft");
      expect(screen.getByText(/Unsaved/)).toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(screen.getByText(/Unsaved/)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows Saving, then Saved, then nothing after an auto-save", async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      saveGate = new Promise<void>((r) => {
        release = r;
      });
      await renderNotes([]);
      openNewNote();
      setTitle("Journal");
      await act(async () => {
        jest.advanceTimersByTime(2100);
      });
      expect(screen.getByText(/Saving/)).toBeInTheDocument();
      await act(async () => {
        release();
      });
      expect(screen.getByText(/Saved/)).toBeInTheDocument();
      expect(screen.queryByText(/Unsaved/)).not.toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(2600);
      });
      expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Unsaved/)).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not create a second copy when Save & Close comes while an auto-save is still writing", async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      saveGate = new Promise<void>((r) => {
        release = r;
      });
      await renderNotes([]);
      openNewNote();
      setTitle("Journal");
      await act(async () => {
        jest.advanceTimersByTime(2100); // the auto-save starts and waits on the disk
      });
      clickSaveClose();
      await act(async () => {
        release();
      });
      await waitFor(() => expect(savedVaults().length).toBeGreaterThanOrEqual(2));
      expect(lastSaved()).toHaveLength(1);
      expect(cardTitles()).toEqual(["Journal"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps the creation time of a new note across auto-saves", async () => {
    jest.useFakeTimers();
    try {
      await renderNotes([]);
      openNewNote();
      setTitle("Journal");
      await act(async () => {
        jest.advanceTimersByTime(2100);
      });
      const created = lastSaved()[0].created_at;
      setBody("more");
      await act(async () => {
        jest.advanceTimersByTime(120_000); // two minutes later
      });
      expect(savedVaults()).toHaveLength(2);
      expect(lastSaved()[0].created_at).toBe(created);
      expect(lastSaved()[0].updated_at).toBeGreaterThan(created);
    } finally {
      jest.useRealTimers();
    }
  });

  it("pins and unpins inside the editor", async () => {
    await renderNotes([makeNote("a", "Plain")]);
    openNote("Plain");
    const editor = () => within(document.querySelector(".editor-modal-card") as HTMLElement);
    fireEvent.click(editor().getByTitle("Pin"));
    expect(editor().getByTitle("Unpin")).toBeInTheDocument();
    clickSaveClose();
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].is_pinned).toBe(true);
  });

  it("closes when the dark area is clicked, asking first if there are changes", async () => {
    await renderNotes([makeNote("a", "Plain")]);
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    openNote("Plain");
    fireEvent.click(document.querySelector(".modal-overlay") as HTMLElement);
    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    openNote("Plain");
    setBody("changed");
    fireEvent.click(document.querySelector(".modal-overlay") as HTMLElement);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(titleInput()).toBeInTheDocument();
  });

  it("ignores clicks inside the editor card", async () => {
    await renderNotes([makeNote("a", "Plain")]);
    openNote("Plain");
    fireEvent.click(document.querySelector(".editor-modal-card") as HTMLElement);
    expect(titleInput()).toBeInTheDocument();
  });

  it("starts the next note clean after one was abandoned", async () => {
    await renderNotes([makeNote("a", "Old")]);
    jest.spyOn(window, "confirm").mockReturnValue(true);
    openNew();
    function openNew() {
      openNewNote();
    }
    setTitle("Draft");
    setBody("text");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openNewNote();
    expect(titleInput().value).toBe("");
    expect(body().value).toBe("");
    expect(screen.queryByText(/Unsaved/)).not.toBeInTheDocument();
  });

  it("ignores Ctrl+S when no note is open", async () => {
    await renderNotes([makeNote("a", "Plain")]);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await act(async () => {});
    expect(savedVaults()).toHaveLength(0);
  });

  it("changes the editor font and size", async () => {
    await renderNotes([]);
    openNewNote();
    expect(body().style.fontSize).toBe("16px");
    fireEvent.click(screen.getByText("Sans"));
    fireEvent.click(screen.getByText("Mono"));
    expect(body().style.fontFamily).toContain("Consolas");
    fireEvent.click(screen.getByText("Normal"));
    fireEvent.click(screen.getByText("Huge"));
    expect(body().style.fontSize).toBe("22px");
  });
});

// ─── Tags in the editor ──────────────────────────────────────────────────────

describe("NotesView - tag field", () => {
  const tagField = () => screen.getByPlaceholderText("Add tag…") as HTMLInputElement;

  it("keeps a tag that was typed but not confirmed when the user clicks Save & Close", async () => {
    const user = userEvent.setup();
    await renderNotes([]);
    openNewNote();
    setTitle("Tagged");
    await user.click(tagField());
    await user.type(tagField(), "pending");
    await user.click(screen.getByRole("button", { name: "Save & Close" }));
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].tags).toEqual(["pending"]);
  });

  it("adds a tag on comma", async () => {
    await renderNotes([]);
    openNewNote();
    fireEvent.change(tagField(), { target: { value: "alpha" } });
    fireEvent.keyDown(tagField(), { key: "," });
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(tagField().value).toBe("");
  });

  it("does nothing on Enter with an empty field", async () => {
    await renderNotes([]);
    openNewNote();
    fireEvent.keyDown(tagField(), { key: "Enter" });
    expect(document.querySelectorAll(".editor-tag")).toHaveLength(0);
  });

  it("Backspace on an empty field removes the last tag, but not while typing", async () => {
    await renderNotes([makeNote("a", "T", { tags: ["one", "two"] })]);
    openNote("T");
    fireEvent.change(tagField(), { target: { value: "x" } });
    fireEvent.keyDown(tagField(), { key: "Backspace" });
    expect(document.querySelectorAll(".editor-tag")).toHaveLength(2);

    fireEvent.change(tagField(), { target: { value: "" } });
    fireEvent.keyDown(tagField(), { key: "Backspace" });
    expect(Array.from(document.querySelectorAll(".editor-tag")).map((t) => t.textContent)).toEqual(["one"]);
  });

  it("Backspace on an empty field with no tags does nothing", async () => {
    await renderNotes([]);
    openNewNote();
    expect(() => fireEvent.keyDown(tagField(), { key: "Backspace" })).not.toThrow();
  });

  it("ignores a tag that is only punctuation", async () => {
    await renderNotes([]);
    openNewNote();
    fireEvent.change(tagField(), { target: { value: " - , - " } });
    fireEvent.keyDown(tagField(), { key: "Enter" });
    expect(document.querySelectorAll(".editor-tag")).toHaveLength(0);
  });
});

// ─── Preview ─────────────────────────────────────────────────────────────────

describe("NotesView - preview", () => {
  async function previewOf(content: string) {
    await renderNotes([makeNote("a", "Doc", { content })]);
    openNote("Doc");
    fireEvent.click(byTitle("Preview mode"));
    return document.querySelector(".editor-preview") as HTMLElement;
  }

  it("switches between editing and previewing without losing the text", async () => {
    const preview = await previewOf("# Title");
    expect(preview).not.toBeNull();
    expect(screen.queryByPlaceholderText("Write something secure…")).not.toBeInTheDocument();
    fireEvent.click(byTitle("Edit mode"));
    expect(body().value).toBe("# Title");
  });

  it("renders the four heading levels", async () => {
    const p = await previewOf("# One\n## Two\n### Three\n#### Four");
    expect(p.querySelector(".md-h1")).toHaveTextContent("One");
    expect(p.querySelector(".md-h2")).toHaveTextContent("Two");
    expect(p.querySelector(".md-h3")).toHaveTextContent("Three");
    expect(p.querySelector(".md-h4")).toHaveTextContent("Four");
  });

  it("does not treat a hash without a space as a heading", async () => {
    const p = await previewOf("#hashtag");
    expect(p.querySelector(".md-h1")).toBeNull();
    expect(p).toHaveTextContent("#hashtag");
  });

  it("renders bold, italic, strikethrough and inline code", async () => {
    const p = await previewOf("**b** and *i* and ~~s~~ and `c`");
    expect(p.querySelector(".md-bold")).toHaveTextContent("b");
    expect(p.querySelector(".md-italic")).toHaveTextContent("i");
    expect(p.querySelector(".md-strikethrough")).toHaveTextContent("s");
    expect(p.querySelector(".md-inline-code")).toHaveTextContent("c");
    expect(p).not.toHaveTextContent("**");
  });

  it("leaves stray markers alone", async () => {
    const p = await previewOf("a ** b and ~~ c");
    expect(p.querySelector(".md-bold")).toBeNull();
    expect(p).toHaveTextContent("a ** b and ~~ c");
  });

  it("renders block quotes and both kinds of list", async () => {
    const p = await previewOf("> quoted\n- bullet\n1. first\n2. second");
    expect(p.querySelector(".md-blockquote")).toHaveTextContent("quoted");
    expect(p.querySelector(".md-list-item")).toHaveTextContent("bullet");
    const nums = Array.from(p.querySelectorAll(".md-ol-item")).map((n) => n.textContent);
    expect(nums).toEqual(["1.first", "2.second"]);
  });

  it.each(["---", "***", "___"])("renders %s as a divider", async (rule) => {
    const p = await previewOf(`above\n${rule}\nbelow`);
    expect(p.querySelector("hr.md-hr")).not.toBeNull();
  });

  it("renders a table, dropping the separator row and using the first row as the header", async () => {
    const p = await previewOf("| Name | Age |\n|---|---|\n| Ann | **30** |");
    expect(p.querySelectorAll("th")).toHaveLength(2);
    expect(p.querySelectorAll("td")).toHaveLength(2);
    expect(p.querySelector("th")).toHaveTextContent("Name");
    expect(p.querySelector("td .md-bold")).toHaveTextContent("30");
    expect(p).not.toHaveTextContent("---");
  });

  it("renders a fenced code block as is", async () => {
    const p = await previewOf("```\nconst a = **1**;\n  indented\n```\nafter");
    const pre = p.querySelector("pre.md-code-block")!;
    expect(pre.textContent).toBe("const a = **1**;\n  indented");
    expect(pre.querySelector(".md-bold")).toBeNull();
    expect(p).toHaveTextContent("after");
  });

  it("still shows the text of a code block that was never closed", async () => {
    const p = await previewOf("before\n```\nunfinished code\nmore");
    expect(p).toHaveTextContent("before");
    expect(p).toHaveTextContent("unfinished code");
    expect(p).toHaveTextContent("more");
  });

  it("keeps blank lines as spacing", async () => {
    const p = await previewOf("one\n\ntwo");
    expect(p.querySelectorAll("br")).toHaveLength(1);
  });

  it("shows a placeholder for an empty note", async () => {
    await renderNotes([makeNote("a", "Blank", { content: "" })]);
    openNote("Blank");
    fireEvent.click(byTitle("Preview mode"));
    expect(screen.getByText("*Empty Note*")).toBeInTheDocument();
  });

  it("uses the chosen font in the preview", async () => {
    const p = await previewOf("text");
    expect(p.style.fontSize).toBe("16px");
  });
});

// ─── Formatting buttons ──────────────────────────────────────────────────────

describe("NotesView - formatting toolbar", () => {
  async function format(content: string, from: number, to: number, button: string) {
    await renderNotes([makeNote("a", "Doc", { content })]);
    openNote("Doc");
    body().focus();
    body().setSelectionRange(from, to);
    fireEvent.click(byTitle(button));
    return body().value;
  }

  it.each([
    ["Bold (Ctrl+B)", "hello **world**"],
    ["Italic", "hello *world*"],
    ["Strikethrough", "hello ~~world~~"],
  ])("%s wraps the selection", async (button, expected) => {
    expect(await format("hello world", 6, 11, button)).toBe(expected);
  });

  it("wraps nothing when nothing is selected, leaving the cursor between the marks", async () => {
    expect(await format("hello", 5, 5, "Bold (Ctrl+B)")).toBe("hello****");
    await waitFor(() => expect(body().selectionStart).toBe(7));
  });

  it("keeps the selection on the same words afterwards", async () => {
    await format("hello world", 6, 11, "Bold (Ctrl+B)");
    await waitFor(() => expect(body().selectionStart).toBe(8));
    expect(body().selectionEnd).toBe(13);
  });

  it.each([
    ["Heading 1", "# "],
    ["Heading 2", "## "],
    ["Heading 3", "### "],
    ["Heading 4", "#### "],
    ["Unordered list", "- "],
  ])("%s puts its marker at the start of the line, wherever the cursor is", async (button, marker) => {
    expect(await format("first\nsecond line", 9, 9, button)).toBe(`first\n${marker}second line`);
  });

  it("puts a heading marker on the first line when the cursor is on it", async () => {
    expect(await format("title here", 6, 6, "Heading 1")).toBe("# title here");
  });

  it("puts a heading marker in an empty note", async () => {
    expect(await format("", 0, 0, "Heading 2")).toBe("## ");
  });

  it("puts the marker at the start of the line after a blank first line", async () => {
    expect(await format("\nsecond", 0, 0, "Heading 1")).toBe("# \nsecond");
  });

  it("wraps the selection in a code block on its own lines", async () => {
    expect(await format("a\nb\nc", 2, 3, "Code block")).toBe("a\n```\nb\n```\nc");
  });

  it("keeps the selection on the same text inside the code block", async () => {
    await format("a\nb\nc", 2, 3, "Code block");
    await waitFor(() => expect(body().selectionStart).toBe(6));
    expect(body().selectionEnd).toBe(7);
  });

  it("starts the code block on a new line when the selection is mid-line", async () => {
    expect(await format("say hello now", 4, 9, "Code block")).toBe("say \n```\nhello\n```\n now");
  });

  it("does nothing in preview mode, where there is no text box", async () => {
    await renderNotes([makeNote("a", "Doc", { content: "text" })]);
    openNote("Doc");
    fireEvent.click(byTitle("Preview mode"));
    fireEvent.click(byTitle("Bold (Ctrl+B)"));
    fireEvent.click(byTitle("Edit mode"));
    expect(body().value).toBe("text");
  });

  it("counts a format change as an edit", async () => {
    await format("hello", 0, 5, "Italic");
    expect(screen.getByText(/Unsaved/)).toBeInTheDocument();
  });
});

// ─── Find and replace ────────────────────────────────────────────────────────

describe("NotesView - find and replace", () => {
  async function openWith(text: string) {
    await renderNotes([makeNote("a", "Doc", { content: text })]);
    openNote("Doc");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    return screen.findByPlaceholderText("Find…");
  }
  const replaceField = () => screen.getByPlaceholderText("Replace with…") as HTMLInputElement;
  const counter = () => document.querySelector(".find-counter")!.textContent;
  const sel = () => [body().selectionStart, body().selectionEnd];

  it("opens with Ctrl+F or Ctrl+H, from the toolbar button, and closes with the X or Escape", async () => {
    await renderNotes([makeNote("a", "Doc")]);
    openNote("Doc");
    expect(screen.queryByPlaceholderText("Find…")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "h", ctrlKey: true });
    expect(screen.getByPlaceholderText("Find…")).toBeInTheDocument();
    fireEvent.click(byTitle("Close (Esc)"));
    expect(screen.queryByPlaceholderText("Find…")).not.toBeInTheDocument();

    fireEvent.click(byTitle("Find & Replace (Ctrl+F / Ctrl+H)"));
    expect(screen.getByPlaceholderText("Find…")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Find…")).not.toBeInTheDocument();
    expect(titleInput()).toBeInTheDocument(); // Escape closes the bar, not the note

    fireEvent.click(byTitle("Find & Replace (Ctrl+F / Ctrl+H)"));
    fireEvent.click(byTitle("Find & Replace (Ctrl+F / Ctrl+H)"));
    expect(screen.queryByPlaceholderText("Find…")).not.toBeInTheDocument();
  });

  it("ignores Ctrl+F when no note is open", async () => {
    await renderNotes([makeNote("a", "Doc")]);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.queryByPlaceholderText("Find…")).not.toBeInTheDocument();
  });

  it("shows nothing in the counter until something is typed", async () => {
    await openWith("a a a");
    expect(counter()).toBe("");
  });

  it("jumps to the first match on the first Enter, then the next", async () => {
    const find = await openWith("one two one two one");
    fireEvent.change(find, { target: { value: "one" } });
    expect(counter()).toBe("1/3");
    fireEvent.keyDown(find, { key: "Enter" });
    expect(sel()).toEqual([0, 3]);
    expect(counter()).toBe("1/3");
    fireEvent.keyDown(find, { key: "Enter" });
    expect(sel()).toEqual([8, 11]);
    expect(counter()).toBe("2/3");
    fireEvent.keyDown(find, { key: "Enter" });
    expect(sel()).toEqual([16, 19]);
    fireEvent.keyDown(find, { key: "Enter" });
    expect(sel()).toEqual([0, 3]); // wraps around
    expect(counter()).toBe("1/3");
  });

  it("Shift+Enter and the arrows go backwards", async () => {
    const find = await openWith("one two one two one");
    fireEvent.change(find, { target: { value: "one" } });
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    expect(sel()).toEqual([16, 19]); // wraps to the last
    expect(counter()).toBe("3/3");
    fireEvent.click(byTitle("Previous match (Shift+Enter)"));
    expect(sel()).toEqual([8, 11]);
    fireEvent.click(byTitle("Next match (Enter)"));
    expect(sel()).toEqual([16, 19]);
  });

  it("finds overlapping matches", async () => {
    const find = await openWith("aaaa");
    fireEvent.change(find, { target: { value: "aa" } });
    expect(counter()).toBe("1/3");
  });

  it("disables the arrows and Replace when nothing matches", async () => {
    const find = await openWith("hello");
    fireEvent.change(find, { target: { value: "zzz" } });
    expect(counter()).toBe("0/0");
    expect(byTitle("Previous match (Shift+Enter)")).toBeDisabled();
    expect(byTitle("Next match (Enter)")).toBeDisabled();
    expect(byTitle("Replace current match")).toBeDisabled();
    fireEvent.keyDown(find, { key: "Enter" });
    expect(counter()).toBe("0/0");
  });

  it("disables Replace All until there is something to find", async () => {
    await openWith("hello");
    expect(byTitle("Replace all matches")).toBeDisabled();
  });

  it("jumps to the first match of a new search on the first Enter", async () => {
    const find = await openWith("ab ab cd cd");
    fireEvent.change(find, { target: { value: "ab" } });
    fireEvent.keyDown(find, { key: "Enter" });
    fireEvent.keyDown(find, { key: "Enter" });
    fireEvent.change(find, { target: { value: "cd" } });
    fireEvent.keyDown(find, { key: "Enter" });
    expect(sel()).toEqual([6, 8]);
    expect(counter()).toBe("1/2");
  });

  it("starts again at the first match when the search text changes", async () => {
    const find = await openWith("ab ab cd cd");
    fireEvent.change(find, { target: { value: "ab" } });
    fireEvent.click(byTitle("Next match (Enter)"));
    fireEvent.click(byTitle("Next match (Enter)"));
    expect(counter()).toBe("2/2");
    fireEvent.change(find, { target: { value: "cd" } });
    expect(counter()).toBe("1/2");
  });

  it("replaces the match that was jumped to", async () => {
    const find = await openWith("foo bar foo");
    fireEvent.change(find, { target: { value: "foo" } });
    fireEvent.keyDown(find, { key: "Enter" }); // first
    fireEvent.keyDown(find, { key: "Enter" }); // second
    fireEvent.change(replaceField(), { target: { value: "baz" } });
    fireEvent.click(byTitle("Replace current match"));
    expect(body().value).toBe("foo bar baz");
  });

  it("replaces with the Enter key in the replace field", async () => {
    const find = await openWith("foo foo");
    fireEvent.change(find, { target: { value: "foo" } });
    fireEvent.change(replaceField(), { target: { value: "x" } });
    fireEvent.keyDown(replaceField(), { key: "Enter" });
    expect(body().value).toBe("x foo");
  });

  it("can replace with nothing", async () => {
    const find = await openWith("a-b-c");
    fireEvent.change(find, { target: { value: "-" } });
    fireEvent.click(byTitle("Replace all matches"));
    expect(body().value).toBe("abc");
  });

  it("replaces the last match without damaging the text, and keeps the counter in range", async () => {
    // Replacing while on the last of several matches used to point past the end of the
    // match list, and the next Replace then pasted the whole note into itself.
    const find = await openWith("foo foo");
    fireEvent.change(find, { target: { value: "foo" } });
    fireEvent.keyDown(find, { key: "Enter" });
    fireEvent.keyDown(find, { key: "Enter" }); // on the second (last) match
    expect(counter()).toBe("2/2");
    fireEvent.change(replaceField(), { target: { value: "bar" } });
    fireEvent.click(byTitle("Replace current match"));
    expect(body().value).toBe("foo bar");
    expect(counter()).toBe("1/1");
    fireEvent.click(byTitle("Replace current match"));
    expect(body().value).toBe("bar bar");
  });

  it("keeps the note intact when Replace is pressed again after the matches ran out", async () => {
    const find = await openWith("x x x");
    fireEvent.change(find, { target: { value: "x" } });
    fireEvent.change(replaceField(), { target: { value: "y" } });
    for (let i = 0; i < 6; i++) fireEvent.click(byTitle("Replace current match"));
    expect(body().value).toBe("y y y");
  });

  it("clears the search after Replace All", async () => {
    const find = await openWith("foo foo");
    fireEvent.change(find, { target: { value: "foo" } });
    fireEvent.change(replaceField(), { target: { value: "x" } });
    fireEvent.click(byTitle("Replace all matches"));
    expect((screen.getByPlaceholderText("Find…") as HTMLInputElement).value).toBe("");
    expect(counter()).toBe("");
  });

  it("counts replacing as an edit", async () => {
    const find = await openWith("foo");
    fireEvent.change(find, { target: { value: "foo" } });
    fireEvent.click(byTitle("Replace all matches"));
    expect(screen.getByText(/Unsaved/)).toBeInTheDocument();
  });

  it("forgets the search when another note is opened", async () => {
    await renderNotes([makeNote("a", "One", { content: "foo" }), makeNote("b", "Two", { content: "bar" })]);
    openNote("One");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.change(await screen.findByPlaceholderText("Find…"), { target: { value: "foo" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openNote("Two");
    expect(screen.queryByPlaceholderText("Find…")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect((await screen.findByPlaceholderText("Find…") as HTMLInputElement).value).toBe("");
  });
});

// ─── Import and export problems ──────────────────────────────────────────────

describe("NotesView - import and export problems", () => {
  it("names an imported note after the file, for Unix paths too", async () => {
    await renderNotes([]);
    fileContents = "hi";
    mockOpen.mockResolvedValue("/home/me/notes/ideas.md");
    fireEvent.click(byTitle("Import Text File"));
    await waitFor(() => expect(titleInput().value).toBe("ideas.md"));
    expect(body().value).toBe("hi");
  });

  it("tells the user when a file could not be imported", async () => {
    await renderNotes([]);
    mockOpen.mockResolvedValue("C:\\x.txt");
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "read_text_file_content" ? Promise.reject("not valid UTF-8") : Promise.resolve({ entries: [] }),
    );
    const alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
    fireEvent.click(byTitle("Import Text File"));
    expect(await screen.findByText(/Import failed: .*not valid UTF-8/)).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/Import failed/)).not.toBeInTheDocument();
  });

  it("offers Cancel in the export warning", async () => {
    await renderNotes([makeNote("a", "Recipe")]);
    openNote("Recipe");
    fireEvent.click(byTitle("Export as text file"));
    const warning = screen.getByText("Unencrypted Export").closest(".auth-card") as HTMLElement;
    fireEvent.click(within(warning).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Unencrypted Export")).not.toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("writes nothing when the save dialog is cancelled", async () => {
    mockSave.mockResolvedValue(null);
    await renderNotes([makeNote("a", "Recipe")]);
    openNote("Recipe");
    fireEvent.click(byTitle("Export as text file"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    await waitFor(() => expect(mockSave).toHaveBeenCalled());
    expect(mockInvoke.mock.calls.some(([c]) => c === "write_text_file_content")).toBe(false);
    expect(screen.queryByText("Export Complete")).not.toBeInTheDocument();
  });

  it("exports an untitled note as note.txt", async () => {
    mockSave.mockResolvedValue("C:\\out\\note.txt");
    await renderNotes([]);
    openNewNote();
    fireEvent.click(byTitle("Export as text file"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    await screen.findByText("Export Complete");
    expect(mockSave.mock.calls[0][0].defaultPath).toBe("note.txt");
  });

  it("tells the user when the export could not be written", async () => {
    mockSave.mockResolvedValue("C:\\out\\Recipe.txt");
    writeFailure = "disk full";
    await renderNotes([makeNote("a", "Recipe")]);
    openNote("Recipe");
    fireEvent.click(byTitle("Export as text file"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    expect(await screen.findByText(/Export failed.*disk full/)).toBeInTheDocument();
    expect(screen.queryByText("Export Complete")).not.toBeInTheDocument();
  });

  it("closes the export confirmation", async () => {
    mockSave.mockResolvedValue("C:\\out\\Recipe.txt");
    await renderNotes([makeNote("a", "Recipe")]);
    openNote("Recipe");
    fireEvent.click(byTitle("Export as text file"));
    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));
    await screen.findByText("Export Complete");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Export Complete")).not.toBeInTheDocument();
  });
});

// ─── Escape key ──────────────────────────────────────────────────────────────

describe("NotesView - Escape key", () => {
  const escape = () => fireEvent.keyDown(window, { key: "Escape" });

  it("closes an untouched note editor", async () => {
    await renderNotes([]);
    openNewNote();
    expect(titleInput()).toBeInTheDocument();

    escape();

    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
  });

  it("asks before throwing away unsaved changes, and stays open on No", async () => {
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    await renderNotes([]);
    openNewNote();
    setTitle("Draft");

    escape();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(titleInput()).toBeInTheDocument();
  });

  it("closes the find bar first, then the note", async () => {
    await renderNotes([makeNote("a", "Alpha")]);
    openNote("Alpha");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByPlaceholderText(/find/i)).toBeInTheDocument();

    escape();
    expect(screen.queryByPlaceholderText(/find/i)).not.toBeInTheDocument();
    expect(titleInput()).toBeInTheDocument();

    escape();
    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
  });

  it("does nothing on the note list", async () => {
    await renderNotes([makeNote("a", "Alpha")]);
    escape();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });
});

// ─── Keyboard shortcuts ──────────────────────────────────────────────────────

describe("NotesView - keyboard shortcuts", () => {
  const ctrl = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true });

  it("Ctrl+N starts a new note from the list", async () => {
    await renderNotes([makeNote("a", "Alpha")]);
    ctrl("n");
    expect(titleInput()).toHaveValue("");
  });

  it("Ctrl+N does not start another note while one is open", async () => {
    await renderNotes([makeNote("a", "Alpha")]);
    openNote("Alpha");
    ctrl("n");
    expect(titleInput()).toHaveValue("Alpha");
  });

  it("Ctrl+F puts the cursor in the search box on the list", async () => {
    await renderNotes([makeNote("a", "Alpha")]);
    ctrl("f");
    expect(screen.getByPlaceholderText("Search notes…")).toHaveFocus();
  });

  it("Ctrl+F inside a note still opens find, not the list search", async () => {
    await renderNotes([makeNote("a", "Alpha")]);
    openNote("Alpha");
    ctrl("f");
    expect(screen.getByPlaceholderText(/find/i)).toBeInTheDocument();
  });

  it("Ctrl+S saves the open note", async () => {
    await renderNotes([]);
    openNewNote();
    setTitle("Quick note");
    ctrl("s");
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].title).toBe("Quick note");
  });
});
