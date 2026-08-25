import { useRef } from "react";

/**
 * Serializes async read-modify-write operations against a piece of state
 * (read current value, compute a new value, persist it to the backend, then
 * commit it back to React state).
 *
 * Without this, two overlapping calls (e.g. the user pin-toggling two
 * different entries before the first save resolves) both read the same
 * pre-mutation snapshot, and whichever finishes last silently overwrites the
 * backend file with an array that's missing the other call's change - a lost
 * update. `run()` queues each mutation behind the previous one and always
 * hands it the most recently committed value via `sync()`.
 */
export function useMutationQueue<T>(initial: T) {
  const latestRef = useRef<T>(initial);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  function sync(value: T) {
    latestRef.current = value;
  }

  function run<R>(fn: (current: T) => Promise<R>): Promise<R> {
    const result = queueRef.current.then(
      () => fn(latestRef.current),
      () => fn(latestRef.current),
    );
    // Swallow so a rejection doesn't permanently wedge the queue for calls
    // queued after this one - the caller still sees the rejection via the
    // returned `result` promise.
    queueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { sync, run };
}
