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

describe("useAuth - when the app will lock", () => {
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "check_auth_status" ? Promise.resolve("unlocked") : Promise.resolve(null),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  async function signedIn() {
    const { result } = renderHook(() => useAuth(), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.view).toBe("dashboard"));
    return result;
  }

  it("is 15 minutes away, counting the 14 minute wait and the 1 minute warning", async () => {
    const result = await signedIn();
    const left = result.current.idleDeadlineRef.current - Date.now();
    expect(left).toBeGreaterThan(FIFTEEN_MINUTES - 2000);
    expect(left).toBeLessThanOrEqual(FIFTEEN_MINUTES);
  });

  it("moves back to 15 minutes whenever the user does something", async () => {
    const result = await signedIn();
    act(() => void jest.advanceTimersByTime(5 * 60 * 1000));
    expect(result.current.idleDeadlineRef.current - Date.now()).toBeLessThan(FIFTEEN_MINUTES - 4 * 60 * 1000);

    act(() => void window.dispatchEvent(new Event("mousemove")));
    const left = result.current.idleDeadlineRef.current - Date.now();
    expect(left).toBeGreaterThan(FIFTEEN_MINUTES - 2000);
  });

  it("is the same object on every render, so a ticking display never re-renders the app", async () => {
    const result = await signedIn();
    const first = result.current.idleDeadlineRef;
    act(() => void window.dispatchEvent(new Event("keydown")));
    expect(result.current.idleDeadlineRef).toBe(first);
  });

  it("is zero before sign-in", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "check_auth_status" ? Promise.resolve("locked") : Promise.resolve(null),
    );
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.view).toBe("login"));
    expect(result.current.idleDeadlineRef.current).toBe(0);
  });

  it("goes back to zero after the session ends", async () => {
    const result = await signedIn();
    expect(result.current.idleDeadlineRef.current).toBeGreaterThan(0);
    act(() => void jest.advanceTimersByTime(14 * 60 * 1000));
    await waitFor(() => expect(result.current.showTimeoutWarning).toBe(true));
    act(() => void jest.advanceTimersByTime(60 * 1000));
    await waitFor(() => expect(result.current.view).toBe("login"));
    expect(result.current.idleDeadlineRef.current).toBe(0);
  });
});

describe("useAuth - the real clock decides when the app locks", () => {
  const MIN = 60 * 1000;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "check_auth_status" ? Promise.resolve("unlocked") : Promise.resolve(null),
    );
  });
  afterEach(() => {
    jest.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  async function signedIn() {
    const hook = renderHook(() => useAuth(), { wrapper: StrictMode });
    await waitFor(() => expect(hook.result.current.view).toBe("dashboard"));
    return hook;
  }
  /** The device slept or the app sat in the background: the clock moved on, the timers did not run. */
  const timePasses = (ms: number) => jest.setSystemTime(Date.now() + ms);
  const comeBack = () => act(() => void document.dispatchEvent(new Event("visibilitychange")));
  const logouts = () => mockInvoke.mock.calls.filter(([c]) => c === "logout").length;

  it("locks when the app comes to the front after the deadline has passed", async () => {
    const { result } = await signedIn();
    timePasses(20 * MIN);
    comeBack();
    await waitFor(() => expect(result.current.view).toBe("login"));
    expect(result.current.sessionExpired).toBe(true);
    expect(logouts()).toBe(1);
  });

  it("locks when the window gets focus back, which is how a woken computer shows up", async () => {
    const { result } = await signedIn();
    timePasses(16 * MIN);
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.view).toBe("login"));
  });

  it("locks when the page is shown again from the back-forward cache", async () => {
    const { result } = await signedIn();
    timePasses(16 * MIN);
    act(() => void window.dispatchEvent(new Event("pageshow")));
    await waitFor(() => expect(result.current.view).toBe("login"));
  });

  it("shows the warning with the time that is really left when it returns during the last minute", async () => {
    const { result } = await signedIn();
    timePasses(14 * MIN + 40 * 1000);
    comeBack();
    await waitFor(() => expect(result.current.showTimeoutWarning).toBe(true));
    expect(result.current.countdown).toBe(20);
    expect(result.current.view).toBe("dashboard");
    act(() => void jest.advanceTimersByTime(20 * 1000));
    await waitFor(() => expect(result.current.view).toBe("login"));
  });

  it("counts down one second per second even if several events announce the return", async () => {
    const { result } = await signedIn();
    timePasses(14 * MIN + 40 * 1000);
    comeBack();
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void window.dispatchEvent(new Event("pageshow")));
    act(() => void jest.advanceTimersByTime(5 * 1000));
    expect(result.current.countdown).toBe(15);
  });

  it("does nothing when it returns well before the deadline", async () => {
    const { result } = await signedIn();
    timePasses(5 * MIN);
    comeBack();
    expect(result.current.showTimeoutWarning).toBe(false);
    expect(result.current.countdown).toBe(60);
    expect(result.current.view).toBe("dashboard");
    expect(logouts()).toBe(0);
  });

  it("does nothing while the app is still hidden", async () => {
    const { result } = await signedIn();
    timePasses(20 * MIN);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    comeBack();
    expect(result.current.view).toBe("dashboard");
    expect(logouts()).toBe(0);
  });

  it("locks, instead of giving another minute, when the warning timer runs late", async () => {
    const { result } = await signedIn();
    timePasses(30 * MIN);
    act(() => void jest.advanceTimersByTime(14 * MIN));
    await waitFor(() => expect(result.current.view).toBe("login"));
    expect(result.current.showTimeoutWarning).toBe(false);
    expect(result.current.sessionExpired).toBe(true);
  });

  it("still warns for a full minute when the timer fires on time", async () => {
    const { result } = await signedIn();
    act(() => void jest.advanceTimersByTime(14 * MIN));
    await waitFor(() => expect(result.current.showTimeoutWarning).toBe(true));
    expect(result.current.countdown).toBe(60);
  });

  it("does not lock a second time once it is locked", async () => {
    const { result } = await signedIn();
    timePasses(20 * MIN);
    comeBack();
    await waitFor(() => expect(result.current.view).toBe("login"));
    comeBack();
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(logouts()).toBe(1);
  });

  it("stops watching when the app is closed", async () => {
    const { unmount } = await signedIn();
    unmount();
    timePasses(20 * MIN);
    comeBack();
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void window.dispatchEvent(new Event("pageshow")));
    expect(logouts()).toBe(0);
  });

  it("rounds a part of a second up, so the count never shows zero before the app locks", async () => {
    const { result } = await signedIn();
    timePasses(14 * MIN + 40 * 1000 + 400);
    comeBack();
    await waitFor(() => expect(result.current.showTimeoutWarning).toBe(true));
    expect(result.current.countdown).toBe(20);
  });

  it("starts the 15 minutes again after the user does something", async () => {
    const { result } = await signedIn();
    timePasses(10 * MIN);
    act(() => void window.dispatchEvent(new Event("touchstart")));
    timePasses(10 * MIN);
    comeBack();
    expect(result.current.view).toBe("dashboard");
    expect(logouts()).toBe(0);
  });
});
