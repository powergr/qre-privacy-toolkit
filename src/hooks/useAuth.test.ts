import { StrictMode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAuth } from "./useAuth";

const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}));

describe("useAuth - idle timeout logout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // isTauri() gates the real invoke() calls on this marker Tauri injects
    // into window at runtime; without it, useAuth falls back to its
    // browser-dev-mode path and never calls check_auth_status/logout at all.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "check_auth_status") return Promise.resolve("unlocked");
      if (cmd === "logout") return Promise.resolve(null);
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  async function renderLoggedIn() {
    // StrictMode matters here: React 18 deliberately double-invokes a
    // setState functional updater in development to help catch impure ones.
    // performLogout() used to run inside exactly such an updater; without
    // StrictMode this test would pass even against the old, buggy code.
    const { result } = renderHook(() => useAuth(), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.view).toBe("dashboard"));
    return result;
  }

  it("logs out exactly once when the idle countdown reaches zero", async () => {
    // Regression test: performLogout() (an invoke() call plus several
    // setState calls) used to run inside the setCountdown functional
    // updater, which React can invoke more than once per tick. Moving the
    // actual logout to a separate effect keyed on countdown === 0 means it
    // must fire exactly once, not zero or two times.
    const result = await renderLoggedIn();

    // Let the 14-minute idle timer elapse to show the warning.
    act(() => {
      jest.advanceTimersByTime(14 * 60 * 1000);
    });
    await waitFor(() => expect(result.current.showTimeoutWarning).toBe(true));
    expect(result.current.countdown).toBe(60);

    // Let the 60-second countdown run out.
    act(() => {
      jest.advanceTimersByTime(60 * 1000);
    });

    await waitFor(() => expect(result.current.view).toBe("login"));
    expect(result.current.sessionExpired).toBe(true);

    const logoutCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "logout",
    );
    expect(logoutCalls).toHaveLength(1);
  });

  it("does not log out while the countdown is still running", async () => {
    const result = await renderLoggedIn();

    act(() => {
      jest.advanceTimersByTime(14 * 60 * 1000);
    });
    await waitFor(() => expect(result.current.showTimeoutWarning).toBe(true));

    act(() => {
      jest.advanceTimersByTime(30 * 1000); // halfway through the 60s countdown
    });

    expect(result.current.view).toBe("dashboard");
    expect(
      mockInvoke.mock.calls.some(([cmd]) => cmd === "logout"),
    ).toBe(false);
  });

  it("stayLoggedIn() resets the countdown and cancels the pending logout", async () => {
    const result = await renderLoggedIn();

    act(() => {
      jest.advanceTimersByTime(14 * 60 * 1000);
    });
    await waitFor(() => expect(result.current.showTimeoutWarning).toBe(true));

    act(() => {
      result.current.stayLoggedIn();
    });
    expect(result.current.showTimeoutWarning).toBe(false);
    expect(result.current.countdown).toBe(60);

    // Even after the old countdown's duration passes, no logout should fire
    // since the timer was reset.
    act(() => {
      jest.advanceTimersByTime(60 * 1000);
    });
    expect(result.current.view).toBe("dashboard");
  });
});
