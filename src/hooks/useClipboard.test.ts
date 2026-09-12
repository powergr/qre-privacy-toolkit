import { renderHook, act, waitFor } from "@testing-library/react";
import { useClipboard, ClipboardEntry } from "./useClipboard";

const mockInvoke = jest.fn();
const mockWriteText = jest.fn();
const mockReadText = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: (...args: unknown[]) => mockReadText(...args),
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));

function makeEntry(
  id: string,
  overrides: Partial<ClipboardEntry> = {},
): ClipboardEntry {
  return {
    id,
    content: `content-${id}`,
    preview: `preview-${id}`,
    category: "Text",
    created_at: 1700000000,
    is_pinned: false,
    ...overrides,
  };
}

describe("useClipboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteText.mockResolvedValue(undefined);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "load_clipboard_vault") {
        return Promise.resolve({
          entries: [makeEntry("a"), makeEntry("b")],
        });
      }
      return Promise.resolve(null);
    });
  });

  it("does not lose an update when two togglePin calls overlap (lost-update race regression)", async () => {
    // The original bug report's exact scenario: pin one clipboard entry, then
    // immediately pin a second one before the first save has committed.
    const { result } = renderHook(() => useClipboard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pinA!: Promise<void>;
    let pinB!: Promise<void>;

    act(() => {
      const entryA = result.current.entries.find((e) => e.id === "a")!;
      const entryB = result.current.entries.find((e) => e.id === "b")!;
      pinA = result.current.togglePin(entryA);
      pinB = result.current.togglePin(entryB);
    });

    await act(async () => {
      await pinA;
      await pinB;
    });

    expect(result.current.entries.find((e) => e.id === "a")?.is_pinned).toBe(
      true,
    );
    expect(result.current.entries.find((e) => e.id === "b")?.is_pinned).toBe(
      true,
    );
  });

  it("wipes the system clipboard after securePaste", async () => {
    mockReadText.mockResolvedValue("some secret text");
    const { result } = renderHook(() => useClipboard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.securePaste();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "add_clipboard_entry",
      expect.objectContaining({ text: "some secret text" }),
    );
    expect(mockWriteText).toHaveBeenCalledWith("");
  });
});
