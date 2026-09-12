import { renderHook, act } from "@testing-library/react";
import { useMutationQueue } from "./useMutationQueue";

/** A promise you can resolve/reject from outside, to control ordering precisely. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets any already-scheduled microtasks (e.g. a .then() callback) run. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useMutationQueue", () => {
  it("serializes two overlapping run() calls instead of running them concurrently", async () => {
    const { result } = renderHook(() => useMutationQueue<number>(0));
    const order: string[] = [];
    const first = deferred<void>();

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;

    await act(async () => {
      firstPromise = result.current.run(async () => {
        order.push("first-start");
        await first.promise;
        order.push("first-end");
      });
      secondPromise = result.current.run(async () => {
        // Must not run until the first call has fully finished.
        order.push("second-start");
      });
      await flushMicrotasks();
    });

    // The second call's body must not have started yet - it's queued behind
    // the still-pending first call.
    expect(order).toEqual(["first-start"]);

    await act(async () => {
      first.resolve();
      await firstPromise;
      await secondPromise;
    });

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("hands run() the most recently sync()'d value, not a stale snapshot", async () => {
    // This is the actual bug: saveEntry/deleteEntry/etc. used to read `entries`
    // from a React-state closure captured before the previous mutation
    // committed. run() must always pass the latest value instead.
    const { result } = renderHook(() => useMutationQueue<string[]>([]));

    await act(async () => {
      await result.current.run(async (current) => {
        const next = [...current, "a"];
        result.current.sync(next);
      });
    });

    await act(async () => {
      await result.current.run(async (current) => {
        expect(current).toEqual(["a"]);
        const next = [...current, "b"];
        result.current.sync(next);
      });
    });

    let finalValue: string[] = [];
    await act(async () => {
      await result.current.run(async (current) => {
        finalValue = current;
      });
    });
    expect(finalValue).toEqual(["a", "b"]);
  });

  it("demonstrates the fixed lost-update race: two concurrent mutations against the same base state both survive", async () => {
    // Models "pin entry A, then immediately pin entry B" - two saves computed
    // from the same starting array, submitted back-to-back before either
    // commits. Without the queue, whichever save's backend call resolved
    // last would silently overwrite the other's change (a lost update).
    const { result } = renderHook(() =>
      useMutationQueue<{ id: string; pinned: boolean }[]>([
        { id: "a", pinned: false },
        { id: "b", pinned: false },
      ]),
    );

    const saveA = deferred<void>();
    const saveB = deferred<void>();
    const persisted: { id: string; pinned: boolean }[][] = [];

    let pinA!: Promise<void>;
    let pinB!: Promise<void>;

    act(() => {
      // Pin "a" - its backend write is slow (resolves second).
      pinA = result.current.run(async (current) => {
        const next = current.map((e) =>
          e.id === "a" ? { ...e, pinned: true } : e,
        );
        await saveA.promise; // simulate an in-flight backend call
        persisted.push(next);
        result.current.sync(next);
      });

      // Pin "b" immediately after, before pinA has committed.
      pinB = result.current.run(async (current) => {
        const next = current.map((e) =>
          e.id === "b" ? { ...e, pinned: true } : e,
        );
        await saveB.promise;
        persisted.push(next);
        result.current.sync(next);
      });
    });

    await act(async () => {
      // Resolve B's backend call first, then A's - the queue must still
      // apply them in submission order, not resolution order, because run()
      // doesn't even start B's callback until A's has fully finished.
      saveB.resolve();
      saveA.resolve();
      await pinA;
      await pinB;
    });

    // Both pins must be reflected in the final committed state.
    const final = persisted[persisted.length - 1];
    expect(final.find((e) => e.id === "a")?.pinned).toBe(true);
    expect(final.find((e) => e.id === "b")?.pinned).toBe(true);
  });

  it("does not get stuck after a run() callback rejects", async () => {
    const { result } = renderHook(() => useMutationQueue<number>(0));

    let failing!: Promise<void>;
    act(() => {
      failing = result.current.run(async () => {
        throw new Error("backend save failed");
      });
    });
    await expect(failing).rejects.toThrow("backend save failed");

    // A later call must still run normally, not hang behind the rejection.
    let ran = false;
    await act(async () => {
      await result.current.run(async () => {
        ran = true;
      });
    });
    expect(ran).toBe(true);
  });
});
