import { renderHook, act, waitFor } from "@testing-library/react";
import { useTheme } from "./useTheme";

const mockGetCurrentWindow = jest.fn();

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
