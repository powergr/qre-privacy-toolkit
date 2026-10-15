import { renderHook, act, waitFor } from "@testing-library/react";
import { useDragDrop } from "./useDragDrop";

const mockWindowListen = jest.fn();

jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: (...args: unknown[]) => mockWindowListen(...args) }),
}));

let handlers: Record<string, (e: unknown) => void>;
let unlisteners: jest.Mock[];

const drop = (paths?: string[]) =>
  act(() => handlers["tauri://drag-drop"]({ payload: { paths } }));

async function setup(cb: (paths: string[]) => void = jest.fn()) {
  const hook = renderHook(({ fn }) => useDragDrop(fn), { initialProps: { fn: cb } });
  await waitFor(() => expect(Object.keys(handlers)).toHaveLength(3));
  return hook;
}

beforeEach(() => {
  jest.clearAllMocks();
  handlers = {};
  unlisteners = [];
  mockWindowListen.mockImplementation((event: string, handler: (e: unknown) => void) => {
    handlers[event] = handler;
    const un = jest.fn();
    unlisteners.push(un);
    return Promise.resolve(un);
  });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("useDragDrop", () => {
  it("listens for drag enter, leave and drop", async () => {
    await setup();
    expect(Object.keys(handlers).sort()).toEqual(["tauri://drag-drop", "tauri://drag-enter", "tauri://drag-leave"]);
  });

  it("reports dragging while a file is over the window", async () => {
    const { result } = await setup();
    expect(result.current.isDragging).toBe(false);
    act(() => handlers["tauri://drag-enter"]({}));
    expect(result.current.isDragging).toBe(true);
    act(() => handlers["tauri://drag-leave"]({}));
    expect(result.current.isDragging).toBe(false);
  });

  it("passes the dropped paths to the callback and stops showing the drag state", async () => {
    const cb = jest.fn();
    const { result } = await setup(cb);
    act(() => handlers["tauri://drag-enter"]({}));
    drop(["/a.txt", "/b.txt"]);
    expect(cb).toHaveBeenCalledWith(["/a.txt", "/b.txt"]);
    expect(result.current.isDragging).toBe(false);
  });

  it.each([[[]], [undefined]])("ignores a drop with no files (%p)", async (paths) => {
    const cb = jest.fn();
    await setup(cb);
    drop(paths as string[] | undefined);
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores a duplicate drop event within half a second", async () => {
    const cb = jest.fn();
    await setup(cb);
    const now = jest.spyOn(Date, "now");

    now.mockReturnValue(10_000);
    drop(["/a.txt"]);
    now.mockReturnValue(10_400);
    drop(["/a.txt"]);
    expect(cb).toHaveBeenCalledTimes(1);

    now.mockReturnValue(10_501);
    drop(["/b.txt"]);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(["/b.txt"]);
  });

  it("always calls the newest callback", async () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = await setup(first);
    rerender({ fn: second });
    drop(["/a.txt"]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(["/a.txt"]);
  });

  it("stops listening when unmounted", async () => {
    const { unmount } = await setup();
    unmount();
    expect(unlisteners).toHaveLength(3);
    for (const un of unlisteners) expect(un).toHaveBeenCalledTimes(1);
  });

  it("keeps working if one listener cannot be attached", async () => {
    mockWindowListen.mockImplementation((event: string, handler: (e: unknown) => void) => {
      if (event === "tauri://drag-enter") return Promise.reject(new Error("no events"));
      handlers[event] = handler;
      return Promise.resolve(jest.fn());
    });
    const cb = jest.fn();
    renderHook(() => useDragDrop(cb));
    await waitFor(() => expect(handlers["tauri://drag-drop"]).toBeDefined());
    drop(["/a.txt"]);
    expect(cb).toHaveBeenCalledWith(["/a.txt"]);
  });
});
