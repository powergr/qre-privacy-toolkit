import { renderHook, act, waitFor } from "@testing-library/react";
import { useBookmarks, BookmarkEntry } from "./useBookmarks";

const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

function makeBookmark(
  id: string,
  overrides: Partial<BookmarkEntry> = {},
): BookmarkEntry {
  return {
    id,
    title: `Bookmark ${id}`,
    url: `https://example.com/${id}`,
    category: "General",
    created_at: 1700000000,
    ...overrides,
  };
}

describe("useBookmarks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "load_bookmarks_vault") {
        return Promise.resolve({
          entries: [makeBookmark("a"), makeBookmark("b")],
        });
      }
      return Promise.resolve(null);
    });
  });

  it("does not lose an update when two saveBookmark calls overlap (lost-update race regression)", async () => {
    const { result } = renderHook(() => useBookmarks());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let saveA!: Promise<void>;
    let saveB!: Promise<void>;

    act(() => {
      saveA = result.current.saveBookmark(
        makeBookmark("a", { is_pinned: true }),
      );
      saveB = result.current.saveBookmark(
        makeBookmark("b", { is_pinned: true }),
      );
    });

    await act(async () => {
      await saveA;
      await saveB;
    });

    expect(result.current.entries.find((b) => b.id === "a")?.is_pinned).toBe(
      true,
    );
    expect(result.current.entries.find((b) => b.id === "b")?.is_pinned).toBe(
      true,
    );
  });

  it("rejects a dangerous URL scheme", async () => {
    const { result } = renderHook(() => useBookmarks());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(
        result.current.saveBookmark(
          makeBookmark("c", { url: "javascript:alert(1)" }),
        ),
      ).rejects.toThrow("Dangerous URL scheme");
    });
  });
});
