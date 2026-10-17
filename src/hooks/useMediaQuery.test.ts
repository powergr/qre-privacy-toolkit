import { renderHook, act } from "@testing-library/react";
import { useMediaQuery } from "./useMediaQuery";

type Listener = () => void;

function mockMedia(initial: Record<string, boolean>) {
  const state = { ...initial };
  const listeners = new Map<string, Set<Listener>>();
  const asked: string[] = [];
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      asked.push(query);
      const set = listeners.get(query) ?? new Set<Listener>();
      listeners.set(query, set);
      return {
        get matches() {
          return state[query] ?? false;
        },
        addEventListener: (_: string, l: Listener) => set.add(l),
        removeEventListener: (_: string, l: Listener) => set.delete(l),
      };
    },
  });
  return {
    asked,
    listenerCount: (query: string) => listeners.get(query)?.size ?? 0,
    set(query: string, value: boolean) {
      state[query] = value;
      act(() => listeners.get(query)?.forEach((l) => l()));
    },
  };
}

afterEach(() => {
  // @ts-expect-error removed again so other tests see no matchMedia
  delete window.matchMedia;
});

describe("useMediaQuery", () => {
  it("answers for the query it was given", () => {
    const m = mockMedia({ "(a)": true, "(b)": false });
    expect(renderHook(() => useMediaQuery("(a)")).result.current).toBe(true);
    expect(renderHook(() => useMediaQuery("(b)")).result.current).toBe(false);
    expect(m.asked).toContain("(a)");
  });

  it("follows the query as it changes, and stops listening afterwards", () => {
    const m = mockMedia({ "(a)": false });
    const { result, unmount } = renderHook(() => useMediaQuery("(a)"));
    m.set("(a)", true);
    expect(result.current).toBe(true);
    m.set("(a)", false);
    expect(result.current).toBe(false);
    expect(m.listenerCount("(a)")).toBe(1);
    unmount();
    expect(m.listenerCount("(a)")).toBe(0);
  });

  it("switches to a new query when the query changes", () => {
    const m = mockMedia({ "(a)": true, "(b)": false });
    const { result, rerender } = renderHook(({ q }) => useMediaQuery(q), { initialProps: { q: "(a)" } });
    expect(result.current).toBe(true);
    rerender({ q: "(b)" });
    expect(result.current).toBe(false);
    expect(m.listenerCount("(a)")).toBe(0);
    expect(m.listenerCount("(b)")).toBe(1);
  });

  it("is false where the browser cannot say", () => {
    expect(typeof window.matchMedia).toBe("undefined");
    expect(renderHook(() => useMediaQuery("(a)")).result.current).toBe(false);
  });
});
