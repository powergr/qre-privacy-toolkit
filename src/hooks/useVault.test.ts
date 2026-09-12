import { renderHook, act, waitFor } from "@testing-library/react";
import { useVault, VaultEntry } from "./useVault";

const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

function makeEntry(id: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id,
    service: id.toUpperCase(),
    username: "user",
    password: "pass",
    notes: "",
    is_pinned: false,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
}

// ─── Suppress the expected error-path log ──────────────────────────────────
// The "surfaces a save error" test below deliberately makes invoke() reject
// to verify saveEntry's catch block, which calls
// console.error("🔥 RUST BACKEND ERROR...", e) by design. That's the correct,
// intentional behavior being tested, not a real failure - just noisy in the
// test output. Suppress only that specific message so other console.error
// calls still surface normally.

let _consoleError: typeof console.error;
beforeAll(() => {
  _consoleError = console.error.bind(console);
  jest
    .spyOn(console, "error")
    .mockImplementation((msg: unknown, ...args: unknown[]) => {
      if (typeof msg === "string" && msg.includes("RUST BACKEND ERROR")) return;
      _consoleError(msg, ...args);
    });
});

afterAll(() => {
  (console.error as jest.MockedFunction<typeof console.error>).mockRestore();
});

describe("useVault", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads entries on mount, pinned first then alphabetical", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "load_password_vault") {
        return Promise.resolve({
          entries: [makeEntry("b"), makeEntry("a", { is_pinned: true })],
        });
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("does not lose an update when two saveEntry calls overlap (regression for the lost-update race)", async () => {
    // Models the real bug: rapidly pin-toggling two different vault entries
    // before either save has committed. Before the fix, saveEntry built its
    // new array from a React-state closure captured at click time, so the
    // second call's array didn't include the first call's change yet -
    // whichever save's setEntries ran last silently discarded the other.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "load_password_vault") {
        return Promise.resolve({
          entries: [makeEntry("a"), makeEntry("b")],
        });
      }
      if (cmd === "save_password_vault") {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let saveA!: Promise<void>;
    let saveB!: Promise<void>;

    // Both calls fire from the same render, before either has committed -
    // exactly the "two quick clicks" scenario that triggered the bug.
    act(() => {
      saveA = result.current.saveEntry({
        ...result.current.entries.find((e) => e.id === "a")!,
        is_pinned: true,
      });
      saveB = result.current.saveEntry({
        ...result.current.entries.find((e) => e.id === "b")!,
        is_pinned: true,
      });
    });

    await act(async () => {
      await saveA;
      await saveB;
    });

    expect(result.current.entries.find((e) => e.id === "a")?.is_pinned).toBe(
      true,
    );
    expect(result.current.entries.find((e) => e.id === "b")?.is_pinned).toBe(
      true,
    );

    // The final backend write must also contain both changes, not just the
    // last one submitted.
    const saveCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "save_password_vault",
    );
    const lastCall = saveCalls[saveCalls.length - 1][1] as {
      vault: { entries: VaultEntry[] };
    };
    expect(
      lastCall.vault.entries.find((e) => e.id === "a")?.is_pinned,
    ).toBe(true);
    expect(
      lastCall.vault.entries.find((e) => e.id === "b")?.is_pinned,
    ).toBe(true);
  });

  it("surfaces a save error and still lets a later save succeed", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "load_password_vault") {
        return Promise.resolve({ entries: [makeEntry("a")] });
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockInvoke.mockImplementationOnce(() =>
      Promise.reject(new Error("disk full")),
    );

    await act(async () => {
      await expect(
        result.current.saveEntry(makeEntry("a", { service: "Updated" })),
      ).rejects.toThrow();
    });
    expect(result.current.error).toContain("Failed to save");

    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "save_password_vault" ? Promise.resolve(null) : Promise.resolve(null),
    );

    await act(async () => {
      await result.current.saveEntry(makeEntry("a", { service: "Retried" }));
    });
    expect(result.current.entries.find((e) => e.id === "a")?.service).toBe(
      "Retried",
    );
  });
});
