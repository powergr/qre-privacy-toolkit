import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

let saveFailure: string | null;
let fileContents: string;

function backend(notes: NoteEntry[]) {
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "load_notes_vault":
        return Promise.resolve({ entries: notes.map((n) => ({ ...n })) });
      case "save_notes_vault":
        return saveFailure ? Promise.reject(saveFailure) : Promise.resolve(null);
      case "read_text_file_content":
        return Promise.resolve(fileContents);
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
const bodyInput = () => screen.getByPlaceholderText("Write something secure…") as HTMLTextAreaElement;
const setTitle = (v: string) => fireEvent.change(titleInput(), { target: { value: v } });
const setBody = (v: string) => fireEvent.change(bodyInput(), { target: { value: v } });
const clickSaveClose = () => fireEvent.click(screen.getByRole("button", { name: "Save & Close" }));
const openNewNote = () => fireEvent.click(screen.getByRole("button", { name: "New Note" }));

function cardTitles(): string[] {
  return Array.from(document.querySelectorAll(".note-card-modern .note-header")).map(
    (n) => n.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  saveFailure = null;
  fileContents = "";
  mockClipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockClipboardWrite },
    configurable: true,
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("NotesView - listing", () => {
  it("shows the empty state for a new notebook", async () => {
    await renderNotes([]);
    expect(screen.getByText("Your notebook is empty.").closest(".ui-empty")).toBeInTheDocument();
    expect(screen.getByText("Write a note, or import a text file, to get started.")).toBeInTheDocument();
  });

  it("lists pinned notes first, then the most recently modified", async () => {
    await renderNotes([
      makeNote("a", "Old", { updated_at: 1_000 }),
      makeNote("b", "New", { updated_at: 3_000 }),
      makeNote("c", "Pinned", { updated_at: 500, is_pinned: true }),
    ]);
    expect(cardTitles()).toEqual(["Pinned", "New", "Old"]);
  });

  it("skips notes whose timestamp looks like milliseconds", async () => {
    await renderNotes([
      makeNote("a", "Good"),
      makeNote("b", "Corrupt", { updated_at: 1_700_000_000_000 }),
    ]);
    expect(cardTitles()).toEqual(["Good"]);
  });

  it("searches titles, content and tags", async () => {
    await renderNotes([
      makeNote("a", "Shopping", { content: "milk and eggs" }),
      makeNote("b", "Work", { content: "quarterly report", tags: ["finance"] }),
      makeNote("c", "Ideas", { content: "app ideas" }),
    ]);
    const search = screen.getByPlaceholderText("Search notes…");

    fireEvent.change(search, { target: { value: "shop" } });
    expect(cardTitles()).toEqual(["Shopping"]);
    fireEvent.change(search, { target: { value: "EGGS" } });
    expect(cardTitles()).toEqual(["Shopping"]);
    fireEvent.change(search, { target: { value: "financ" } });
    expect(cardTitles()).toEqual(["Work"]);
  });

  it("filters by tag using the tag bar", async () => {
    await renderNotes([
      makeNote("a", "One", { tags: ["home"] }),
      makeNote("b", "Two", { tags: ["work"] }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "work" }));
    expect(cardTitles()).toEqual(["Two"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(cardTitles().sort()).toEqual(["One", "Two"]);
  });
});

describe("NotesView - writing notes", () => {
  it("saves a new note with a trimmed title", async () => {
    await renderNotes([]);
    openNewNote();
    setTitle("  Passport numbers  ");
    setBody("AB123456");
    clickSaveClose();

    await waitFor(() => expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument());
    const saved = lastSaved();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: "Passport numbers", content: "AB123456", is_pinned: false });
    expect(saved[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cardTitles()).toEqual(["Passport numbers"]);
  });

  it("asks for a title instead of saving an untitled note", async () => {
    await renderNotes([]);
    openNewNote();
    setBody("no title yet");
    clickSaveClose();

    expect(await screen.findByText("Please enter a title for this note.")).toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
    expect(titleInput()).toBeInTheDocument();
  });

  it("keeps the editor open and shows the error when saving fails", async () => {
    await renderNotes([]);
    saveFailure = "disk full";
    openNewNote();
    setTitle("Doomed");
    clickSaveClose();

    expect(await screen.findByText(/Error saving note: .*disk full/)).toBeInTheDocument();
    expect(titleInput().value).toBe("Doomed");
  });

  it("edits an existing note and keeps its id and creation time", async () => {
    await renderNotes([makeNote("a", "Draft", { content: "v1", created_at: 1_600_000_000 })]);
    fireEvent.click(screen.getByText("Draft"));
    expect(titleInput().value).toBe("Draft");
    expect(bodyInput().value).toBe("v1");

    setBody("v2");
    clickSaveClose();

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()).toHaveLength(1);
    expect(lastSaved()[0]).toMatchObject({ id: "a", content: "v2", created_at: 1_600_000_000 });
    expect(lastSaved()[0].updated_at).toBeGreaterThan(1_600_000_000);
  });

  it("saves with Ctrl+S", async () => {
    await renderNotes([]);
    openNewNote();
    setTitle("Quick");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].title).toBe("Quick");
  });

  it("asks before discarding unsaved changes", async () => {
    await renderNotes([]);
    const confirmSpy = jest.spyOn(window, "confirm");
    openNewNote();
    setTitle("Unsaved");

    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(titleInput()).toBeInTheDocument();

    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
    expect(savedVaults()).toHaveLength(0);
  });

  it("closes without asking when nothing was changed", async () => {
    await renderNotes([makeNote("a", "Same")]);
    const confirmSpy = jest.spyOn(window, "confirm");
    fireEvent.click(screen.getByText("Same"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
  });
});

describe("NotesView - auto-save", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("saves a titled note two seconds after typing, then updates the same note", async () => {
    await renderNotes([]);
    openNewNote();
    setTitle("Journal");
    setBody("day one");

    await act(async () => {
      jest.advanceTimersByTime(1_900);
    });
    expect(savedVaults()).toHaveLength(0);

    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(savedVaults()).toHaveLength(1);
    expect(screen.getByText(/Saved/)).toBeInTheDocument();
    const firstId = lastSaved()[0].id;

    setBody("day one, day two");
    await act(async () => {
      jest.advanceTimersByTime(2_100);
    });
    expect(savedVaults()).toHaveLength(2);
    expect(lastSaved()).toHaveLength(1);
    expect(lastSaved()[0]).toMatchObject({ id: firstId, content: "day one, day two" });
  });

  it("does not auto-save while the note has no title", async () => {
    await renderNotes([]);
    openNewNote();
    setBody("just thoughts");
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(savedVaults()).toHaveLength(0);
    // Not even attempted: an attempt would flash a "Save failed" warning.
    expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Saving/)).not.toBeInTheDocument();
  });

  it("reports a failed auto-save", async () => {
    await renderNotes([]);
    saveFailure = "disk full";
    openNewNote();
    setTitle("Journal");
    await act(async () => {
      jest.advanceTimersByTime(2_100);
    });
    expect(screen.getByText("Save failed")).toBeInTheDocument();
  });
});

describe("NotesView - tags", () => {
  function addTag(text: string) {
    const input = screen.getByPlaceholderText("Add tag…");
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("normalises tags, ignores duplicates and saves them", async () => {
    await renderNotes([]);
    openNewNote();
    setTitle("Tagged");
    addTag("  Work Stuff ");
    addTag("work-stuff");
    addTag("Ideas,");
    clickSaveClose();

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].tags).toEqual(["work-stuff", "ideas"]);
  });

  it("allows at most ten tags", async () => {
    await renderNotes([]);
    openNewNote();
    setTitle("Many");
    for (let i = 1; i <= 12; i++) addTag(`tag${i}`);
    clickSaveClose();

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].tags).toHaveLength(10);
  });

  it("removes a tag with its x button", async () => {
    await renderNotes([makeNote("a", "Has tags", { tags: ["keep", "drop"] })]);
    fireEvent.click(screen.getByText("Has tags"));
    fireEvent.click(screen.getByTitle('Remove tag "drop"'));
    clickSaveClose();

    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].tags).toEqual(["keep"]);
  });
});

describe("NotesView - card actions", () => {
  it("pins a note from its card", async () => {
    await renderNotes([makeNote("a", "Loose")]);
    await act(async () => {
      fireEvent.click(screen.getByTitle("Pin"));
    });
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0]).toMatchObject({ id: "a", is_pinned: true });
  });

  it("tells the user when a pin change could not be saved", async () => {
    await renderNotes([makeNote("a", "Loose")]);
    saveFailure = "disk full";
    fireEvent.click(screen.getByTitle("Pin"));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(screen.getByTitle("Pin")).toBeInTheDocument();
  });

  it("copies the note and clears the clipboard after 30 seconds", async () => {
    jest.useFakeTimers();
    try {
      await renderNotes([makeNote("a", "Secret", { content: "pin 4921" })]);
      await act(async () => {
        fireEvent.click(screen.getByTitle("Copy content"));
      });
      expect(mockClipboardWrite).toHaveBeenCalledWith("pin 4921");

      await act(async () => {
        jest.advanceTimersByTime(29_999);
      });
      expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(mockClipboardWrite).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("still clears the clipboard 30 seconds after copying, even if the view is closed", async () => {
    jest.useFakeTimers();
    try {
      const { unmount } = await renderNotes([makeNote("a", "Secret", { content: "pin 4921" })]);
      await act(async () => {
        fireEvent.click(screen.getByTitle("Copy content"));
      });
      expect(mockClipboardWrite).toHaveBeenCalledTimes(1);

      unmount();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });

      expect(mockClipboardWrite).toHaveBeenLastCalledWith("");
    } finally {
      jest.useRealTimers();
    }
  });

  it("deletes only after confirmation", async () => {
    await renderNotes([makeNote("a", "Keep"), makeNote("b", "Remove")]);
    const removeCard = screen.getByText("Remove").closest(".note-card-modern") as HTMLElement;

    fireEvent.click(removeCard.querySelector('[title="Delete note"]') as HTMLElement);
    expect(screen.getByText("Delete Item")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(savedVaults()).toHaveLength(0);
    expect(cardTitles()).toHaveLength(2);

    fireEvent.click(removeCard.querySelector('[title="Delete note"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(cardTitles()).toEqual(["Keep"]));
    expect(lastSaved().map((n) => n.id)).toEqual(["a"]);
  });

  it("tells the user when a delete could not be saved", async () => {
    await renderNotes([makeNote("a", "Stubborn")]);
    saveFailure = "disk full";
    fireEvent.click(document.querySelector('[title="Delete note"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(cardTitles()).toEqual(["Stubborn"]);
  });
});

describe("NotesView - import and export", () => {
  it("opens an imported text file in the editor with normalised line endings", async () => {
    await renderNotes([]);
    fileContents = "line one\r\nline two\rline three";
    mockOpen.mockResolvedValue("C:\\notes\\todo.txt");
    fireEvent.click(screen.getByTitle("Import Text File"));

    await waitFor(() => expect(titleInput().value).toBe("todo.txt"));
    expect(savedVaults()).toHaveLength(0);

    // A textarea hides \r\n from its .value, so check what actually gets stored.
    clickSaveClose();
    await waitFor(() => expect(savedVaults()).toHaveLength(1));
    expect(lastSaved()[0].content).toBe("line one\nline two\nline three");
  });

  it("does nothing when the import picker is cancelled", async () => {
    await renderNotes([]);
    mockOpen.mockResolvedValue(null);
    fireEvent.click(screen.getByTitle("Import Text File"));
    await waitFor(() => expect(mockOpen).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText("Untitled Note")).not.toBeInTheDocument();
  });

  it("warns, then exports the note's text", async () => {
    await renderNotes([makeNote("a", "Recipe", { content: "2 eggs" })]);
    mockSave.mockResolvedValue("C:\\out\\Recipe.txt");
    fireEvent.click(screen.getByText("Recipe"));
    fireEvent.click(screen.getByTitle("Export as text file"));
    expect(screen.getByText("Unencrypted Export")).toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Export Anyway/ }));

    await screen.findByText("Export Complete");
    expect(mockSave.mock.calls[0][0].defaultPath).toBe("Recipe.txt");
    const write = mockInvoke.mock.calls.find(([cmd]) => cmd === "write_text_file_content")!;
    expect(write[1]).toEqual({ path: "C:\\out\\Recipe.txt", content: "2 eggs" });
  });
});

describe("NotesView - find and replace", () => {
  async function openWithText(text: string) {
    await renderNotes([makeNote("a", "Doc", { content: text })]);
    fireEvent.click(screen.getByText("Doc"));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    return screen.findByPlaceholderText("Find…");
  }

  it("counts matches ignoring case", async () => {
    const find = await openWithText("Foo foo FOO bar");
    fireEvent.change(find, { target: { value: "foo" } });
    expect(screen.getByText("1/3")).toBeInTheDocument();
    fireEvent.change(find, { target: { value: "zzz" } });
    expect(screen.getByText("0/0")).toBeInTheDocument();
  });

  it("replaces the current match only", async () => {
    const find = await openWithText("foo bar foo");
    fireEvent.change(find, { target: { value: "foo" } });
    fireEvent.change(screen.getByPlaceholderText("Replace with…"), { target: { value: "baz" } });
    fireEvent.click(screen.getByTitle("Replace current match"));
    expect(bodyInput().value).toBe("baz bar foo");
  });

  it("replaces every match", async () => {
    const find = await openWithText("foo bar foo");
    fireEvent.change(find, { target: { value: "foo" } });
    fireEvent.change(screen.getByPlaceholderText("Replace with…"), { target: { value: "baz" } });
    fireEvent.click(screen.getByTitle("Replace all matches"));
    expect(bodyInput().value).toBe("baz bar baz");
  });

  it("replaces every match it counted, whatever the capitalisation", async () => {
    const find = await openWithText("Foo foo FOO bar");
    fireEvent.change(find, { target: { value: "foo" } });
    expect(screen.getByText("1/3")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Replace with…"), { target: { value: "x" } });
    fireEvent.click(screen.getByTitle("Replace all matches"));
    expect(bodyInput().value).toBe("x x x bar");
  });

  it("inserts the replacement text literally, even with $ characters", async () => {
    const find = await openWithText("price: PRICE");
    fireEvent.change(find, { target: { value: "price" } });
    fireEvent.change(screen.getByPlaceholderText("Replace with…"), { target: { value: "$&-$1" } });
    fireEvent.click(screen.getByTitle("Replace all matches"));
    expect(bodyInput().value).toBe("$&-$1: $&-$1");
  });

  it("treats special characters in the search text literally", async () => {
    const find = await openWithText("a.b a+b (a)");
    fireEvent.change(find, { target: { value: "a.b" } });
    fireEvent.change(screen.getByPlaceholderText("Replace with…"), { target: { value: "X" } });
    fireEvent.click(screen.getByTitle("Replace all matches"));
    expect(bodyInput().value).toBe("X a+b (a)");
  });
});
