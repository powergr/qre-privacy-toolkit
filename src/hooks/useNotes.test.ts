import { renderHook, act, waitFor } from "@testing-library/react";
import { useNotes, NoteEntry } from "./useNotes";

const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

function makeNote(id: string, overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    id,
    title: `Note ${id}`,
    content: "content",
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
}

describe("useNotes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "load_notes_vault") {
        return Promise.resolve({
          entries: [makeNote("a"), makeNote("b")],
        });
      }
      return Promise.resolve(null);
    });
  });

  it("does not lose an update when two saveNote calls overlap (lost-update race regression)", async () => {
    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let saveA!: Promise<void>;
    let saveB!: Promise<void>;

    act(() => {
      saveA = result.current.saveNote(makeNote("a", { title: "A edited" }));
      saveB = result.current.saveNote(makeNote("b", { title: "B edited" }));
    });

    await act(async () => {
      await saveA;
      await saveB;
    });

    expect(result.current.entries.find((n) => n.id === "a")?.title).toBe(
      "A edited",
    );
    expect(result.current.entries.find((n) => n.id === "b")?.title).toBe(
      "B edited",
    );
  });

  it("rejects an empty title without touching the backend", async () => {
    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockInvoke.mockClear();
    await act(async () => {
      await expect(
        result.current.saveNote(makeNote("a", { title: "   " })),
      ).rejects.toThrow("Title cannot be empty");
    });
    expect(
      mockInvoke.mock.calls.some(([cmd]) => cmd === "save_notes_vault"),
    ).toBe(false);
  });
});
