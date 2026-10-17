import { renderHook, act } from "@testing-library/react";
import { useIsPhone, PHONE_QUERY } from "./useIsPhone";

type Listener = () => void;

function mockMedia(matches: boolean, modern = true) {
  const listeners = new Set<Listener>();
  const mql: Record<string, unknown> = {
    matches,
    addListener: jest.fn((l: Listener) => listeners.add(l)),
    removeListener: jest.fn((l: Listener) => listeners.delete(l)),
  };
  if (modern) {
    mql.addEventListener = jest.fn((_: string, l: Listener) => listeners.add(l));
    mql.removeEventListener = jest.fn((_: string, l: Listener) => listeners.delete(l));
  }
  const matchMedia = jest.fn(() => mql);
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
  return {
    mql,
    matchMedia,
    listeners,
    change(next: boolean) {
      mql.matches = next;
      act(() => listeners.forEach((l) => l()));
    },
  };
}

afterEach(() => {
  // @ts-expect-error the property is removed again so other tests see no matchMedia
  delete window.matchMedia;
});

describe("useIsPhone", () => {
  it("asks about the phone width, the same one the style sheets use", () => {
    const m = mockMedia(true);
    renderHook(() => useIsPhone());
    expect(m.matchMedia).toHaveBeenCalledWith("(max-width: 600px)");
    expect(PHONE_QUERY).toBe("(max-width: 600px)");
  });

  it("is right from the very first render, not only after an effect", () => {
    mockMedia(true);
    const seen: boolean[] = [];
    renderHook(() => {
      const value = useIsPhone();
      seen.push(value);
      return value;
    });
    expect(seen[0]).toBe(true);
  });

  it("is true on a narrow window and false on a wide one", () => {
    mockMedia(true);
    expect(renderHook(() => useIsPhone()).result.current).toBe(true);
    mockMedia(false);
    expect(renderHook(() => useIsPhone()).result.current).toBe(false);
  });

  it("follows the window as it is resized", () => {
    const m = mockMedia(false);
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(false);
    m.change(true);
    expect(result.current).toBe(true);
    m.change(false);
    expect(result.current).toBe(false);
  });

  it("stops listening when it is no longer used", () => {
    const m = mockMedia(false);
    const { unmount } = renderHook(() => useIsPhone());
    expect(m.listeners.size).toBe(1);
    unmount();
    expect(m.listeners.size).toBe(0);
  });

  it("works with the old listener calls on older browsers", () => {
    const m = mockMedia(false, false);
    const { result, unmount } = renderHook(() => useIsPhone());
    expect(m.mql.addListener).toHaveBeenCalledTimes(1);
    m.change(true);
    expect(result.current).toBe(true);
    unmount();
    expect(m.mql.removeListener).toHaveBeenCalledTimes(1);
  });

  it("means the desktop layout where the browser cannot say", () => {
    expect(typeof window.matchMedia).toBe("undefined");
    expect(renderHook(() => useIsPhone()).result.current).toBe(false);
  });

  it("means the desktop layout if asking fails", () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => {
        throw new Error("no");
      },
      configurable: true,
      writable: true,
    });
    expect(renderHook(() => useIsPhone()).result.current).toBe(false);
  });
});
