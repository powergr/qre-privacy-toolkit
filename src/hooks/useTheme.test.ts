import { renderHook, act, waitFor } from "@testing-library/react";
import { useTheme, isLightBackground, SYSTEM_LIGHT_QUERY } from "./useTheme";

const mockGetCurrentWindow = jest.fn();
const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockGetCurrentWindow(),
}));

describe("useTheme", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    document.body.removeAttribute("data-theme");
  });

  it("calls the native window's setTheme (regression: was previously dead code)", async () => {
    // Previously gated behind `"os" in window.navigator`, which no Tauri
    // package or standard Navigator ever defines - so appWindow.setTheme()
    // never actually ran on any platform. This asserts it now does.
    const mockSetTheme = jest.fn().mockResolvedValue(undefined);
    mockGetCurrentWindow.mockReturnValue({ setTheme: mockSetTheme });

    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme("dark");
    });

    await waitFor(() => expect(mockSetTheme).toHaveBeenCalledWith("dark"));
  });

  it("updates the DOM attribute and localStorage regardless of native theme support", async () => {
    mockGetCurrentWindow.mockReturnValue({ setTheme: jest.fn() });

    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme("light");
    });

    await waitFor(() =>
      expect(document.body.getAttribute("data-theme")).toBe("light"),
    );
    expect(localStorage.getItem("qre_theme")).toBe("light");
  });

  it("does not throw if getCurrentWindow() or setTheme() fails (e.g. on Android)", async () => {
    mockGetCurrentWindow.mockImplementation(() => {
      throw new Error("not supported on this platform");
    });

    const { result } = renderHook(() => useTheme());

    expect(() => {
      act(() => {
        result.current.setTheme("dark");
      });
    }).not.toThrow();

    await waitFor(() =>
      expect(document.body.getAttribute("data-theme")).toBe("dark"),
    );
  });
});

describe("the device appearance query", () => {
  it("asks whether the device prefers a light appearance", () => {
    expect(SYSTEM_LIGHT_QUERY).toBe("(prefers-color-scheme: light)");
  });
});

describe("isLightBackground", () => {
  it.each([
    ["light", true, true],
    ["light", false, true],
    ["dark", true, false],
    ["dark", false, false],
    ["system", true, true],
    ["system", false, false],
    ["something-else", true, true],
    ["something-else", false, false],
  ])("%s theme, device light=%s gives %s", (theme, device, expected) => {
    expect(isLightBackground(theme, device)).toBe(expected);
  });
});

describe("useTheme - Android status bar icons", () => {
  type Listener = () => void;
  let deviceLight: boolean;
  let listeners: Set<Listener>;

  function mockDevice(light: boolean) {
    deviceLight = light;
    listeners = new Set();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        get matches() {
          return query === SYSTEM_LIGHT_QUERY ? deviceLight : false;
        },
        addEventListener: (_: string, l: Listener) => listeners.add(l),
        removeEventListener: (_: string, l: Listener) => listeners.delete(l),
      }),
    });
  }
  const deviceSwitchesTo = (light: boolean) => {
    deviceLight = light;
    act(() => listeners.forEach((l) => l()));
  };
  const barCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "set_android_system_bars").map(([, args]) => args);
  const lastBars = () => barCalls().slice(-1)[0];

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    document.body.removeAttribute("data-theme");
    mockGetCurrentWindow.mockReturnValue({ setTheme: jest.fn() });
    mockInvoke.mockResolvedValue(undefined);
  });
  afterEach(() => {
    // @ts-expect-error removed again so other tests see no matchMedia
    delete window.matchMedia;
  });

  it("asks for dark icons when the app is in its light theme, even on a phone in dark mode", async () => {
    mockDevice(false);
    localStorage.setItem("qre_theme", "light");
    renderHook(() => useTheme());
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: true }));
  });

  it("asks for white icons when the app is in its dark theme, even on a phone in light mode", async () => {
    mockDevice(true);
    localStorage.setItem("qre_theme", "dark");
    renderHook(() => useTheme());
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: false }));
  });

  it("follows the phone when the theme is system", async () => {
    mockDevice(true);
    renderHook(() => useTheme());
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: true }));
  });

  it("follows the phone when its appearance changes while the theme is system", async () => {
    mockDevice(false);
    renderHook(() => useTheme());
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: false }));
    deviceSwitchesTo(true);
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: true }));
  });

  it("changes the icons as soon as the user picks another theme", async () => {
    mockDevice(false);
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: false }));
    act(() => result.current.setTheme("light"));
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: true }));
    act(() => result.current.setTheme("dark"));
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: false }));
  });

  it("does not change the icons when the phone changes but the user chose a fixed theme", async () => {
    mockDevice(false);
    localStorage.setItem("qre_theme", "dark");
    renderHook(() => useTheme());
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: false }));
    deviceSwitchesTo(true);
    await waitFor(() => expect(lastBars()).toEqual({ lightBackground: false }));
  });

  it("copes with the command failing, as it does on a computer before the app is ready", async () => {
    mockDevice(true);
    mockInvoke.mockRejectedValue(new Error("no such command"));
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(barCalls().length).toBeGreaterThan(0));
    act(() => result.current.setTheme("dark"));
    await waitFor(() => expect(document.body.getAttribute("data-theme")).toBe("dark"));
  });
});
