import { renderHook, act, waitFor } from "@testing-library/react";
import { useFileSystem } from "./useFileSystem";

const mockInvoke = jest.fn();
const mockWatch = jest.fn();
const mockHomeDir = jest.fn();
const mockPlatform = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/plugin-fs", () => ({
  watch: (...args: unknown[]) => mockWatch(...args),
}));
jest.mock("@tauri-apps/api/path", () => ({
  homeDir: () => mockHomeDir(),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

interface Listed {
  name: string;
  is_directory: boolean;
  path: string;
  size: number | null;
  modified: number | null;
}

function file(name: string, size: number | null = 1, dir = "/d"): Listed {
  return { name, is_directory: false, path: `${dir}/${name}`, size, modified: 1000 };
}
function folder(name: string, dir = "/d"): Listed {
  return { name, is_directory: true, path: `${dir}/${name}`, size: null, modified: 1000 };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function listedPaths(): string[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "list_directory")
    .map(([, args]) => (args as { path: string }).path);
}

function mockListing(map: Record<string, Listed[]>) {
  mockInvoke.mockImplementation((cmd: string, args?: { path?: string }) => {
    if (cmd === "list_directory") return Promise.resolve(map[args!.path!] ?? []);
    if (cmd === "get_drives") return Promise.resolve(["C:\\", "D:\\"]);
    return Promise.resolve(null);
  });
}

async function renderLoaded(path: string, entries: Listed[], view = "login") {
  mockListing({ [path]: entries });
  const hook = renderHook(() => useFileSystem(view));
  await act(async () => {
    await hook.result.current.loadDir(path);
  });
  return hook;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.mockReturnValue("linux");
  mockHomeDir.mockResolvedValue("/home/me");
  mockWatch.mockResolvedValue(jest.fn());
});

describe("useFileSystem - loading", () => {
  it("maps the Rust listing into file entries", async () => {
    const { result } = await renderLoaded("/d", [file("a.txt", 5), folder("sub")]);

    expect(result.current.currentPath).toBe("/d");
    expect(result.current.statusMsg).toBe("Loaded");
    const a = result.current.entries.find((e) => e.name === "a.txt")!;
    expect(a).toMatchObject({ isDirectory: false, size: 5, path: "/d/a.txt" });
    expect(a.modified).toEqual(new Date(1000));
  });

  it("keeps a missing modified time as null instead of an invalid Date", async () => {
    const { result } = await renderLoaded("/d", [{ ...file("a.txt"), modified: null }]);
    expect(result.current.entries[0].modified).toBeNull();
  });

  it("shows the drive list for the empty path", async () => {
    const { result } = await renderLoaded("", []);
    expect(result.current.entries.map((e) => e.name)).toEqual(["C:\\", "D:\\"]);
    expect(result.current.entries.every((e) => e.isDrive)).toBe(true);
    expect(result.current.statusMsg).toBe("Select a Drive");
  });

  it("reports an error and keeps the old folder when listing fails", async () => {
    const { result } = await renderLoaded("/d", [file("a.txt")]);
    mockInvoke.mockRejectedValueOnce("Cannot read directory: denied");

    await act(async () => {
      await result.current.loadDir("/locked");
    });

    expect(result.current.statusMsg).toContain("Cannot read directory");
    expect(result.current.currentPath).toBe("/d");
    expect(result.current.entries).toHaveLength(1);
  });

  it("does not let a slow earlier listing overwrite a newer one", async () => {
    // Two quick navigations: the first listing resolves AFTER the second.
    const slow = deferred<Listed[]>();
    const fast = deferred<Listed[]>();
    mockInvoke.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd !== "list_directory") return Promise.resolve(null);
      return args!.path === "/slow" ? slow.promise : fast.promise;
    });
    const { result } = renderHook(() => useFileSystem("login"));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.loadDir("/slow");
      second = result.current.loadDir("/fast");
    });
    await act(async () => {
      fast.resolve([file("fast.txt", 1, "/fast")]);
      await second;
    });
    await act(async () => {
      slow.resolve([file("slow.txt", 1, "/slow")]);
      await first;
    });

    expect(result.current.currentPath).toBe("/fast");
    expect(result.current.entries.map((e) => e.name)).toEqual(["fast.txt"]);
  });
});

describe("useFileSystem - blocked system paths", () => {
  it.each([
    "C:\\Windows\\System32",
    "c:\\windows",
    "C:/Windows/System32",
    "C:\\Program Files\\App",
    "/etc/passwd",
    "/usr/bin",
    "/proc/1",
  ])("refuses to open %s", async (blocked) => {
    const { result } = await renderLoaded("/d", [file("a.txt")]);
    mockInvoke.mockClear();

    await act(async () => {
      await result.current.loadDir(blocked);
    });

    expect(result.current.accessDenied).toBe(blocked);
    expect(listedPaths()).toEqual([]);
    expect(result.current.currentPath).toBe("/d");
  });

  it("opens ordinary folders and can dismiss the access-denied state", async () => {
    const { result } = await renderLoaded("/home/me", []);
    expect(result.current.accessDenied).toBeNull();

    await act(async () => {
      await result.current.loadDir("/etc");
    });
    expect(result.current.accessDenied).toBe("/etc");
    act(() => result.current.setAccessDenied(null));
    expect(result.current.accessDenied).toBeNull();
  });
});

describe("useFileSystem - sorting", () => {
  const mixed = [
    file("b.txt", 300),
    file("a.txt", 100),
    folder("zeta"),
    folder("alpha"),
    file("c.txt", null),
  ];

  it("puts folders first, then sorts by name ascending by default", async () => {
    const { result } = await renderLoaded("/d", mixed);
    expect(result.current.entries.map((e) => e.name)).toEqual([
      "alpha",
      "zeta",
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
  });

  it("toggles direction when the same column is clicked again", async () => {
    const { result } = await renderLoaded("/d", mixed);
    act(() => result.current.handleSort("name"));
    expect(result.current.sortDirection).toBe("desc");
    expect(result.current.entries.map((e) => e.name)).toEqual([
      "zeta",
      "alpha",
      "c.txt",
      "b.txt",
      "a.txt",
    ]);
  });

  it("sorts by size and resets to ascending on a new column", async () => {
    const { result } = await renderLoaded("/d", mixed);
    act(() => result.current.handleSort("name")); // now desc
    act(() => result.current.handleSort("size"));
    expect(result.current.sortField).toBe("size");
    expect(result.current.sortDirection).toBe("asc");
    const files = result.current.entries.filter((e) => !e.isDirectory).map((e) => e.name);
    expect(files.slice(0, 2)).toEqual(["a.txt", "b.txt"]);
    expect(files[2]).toBe("c.txt"); // unknown size goes last
  });
});

describe("useFileSystem - selection", () => {
  const items = [file("a"), file("b"), file("c"), file("d")];

  it("selects one item, replacing the previous selection", async () => {
    const { result } = await renderLoaded("/d", items);
    act(() => result.current.handleSelection("/d/a", 0, false, false));
    act(() => result.current.handleSelection("/d/c", 2, false, false));
    expect(result.current.selectedPaths).toEqual(["/d/c"]);
  });

  it("toggles items with ctrl/cmd", async () => {
    const { result } = await renderLoaded("/d", items);
    act(() => result.current.handleSelection("/d/a", 0, true, false));
    act(() => result.current.handleSelection("/d/c", 2, true, false));
    expect(result.current.selectedPaths).toEqual(["/d/a", "/d/c"]);
    act(() => result.current.handleSelection("/d/a", 0, true, false));
    expect(result.current.selectedPaths).toEqual(["/d/c"]);
  });

  it("selects a range with shift from the last clicked item", async () => {
    const { result } = await renderLoaded("/d", items);
    act(() => result.current.handleSelection("/d/b", 1, false, false));
    act(() => result.current.handleSelection("/d/d", 3, false, true));
    expect(result.current.selectedPaths).toEqual(["/d/b", "/d/c", "/d/d"]);
  });

  it("extends an existing selection with ctrl+shift without duplicates", async () => {
    const { result } = await renderLoaded("/d", items);
    act(() => result.current.handleSelection("/d/a", 0, true, false));
    act(() => result.current.handleSelection("/d/d", 3, true, false));
    // Range b..d overlaps d and must keep a, which lies outside the range.
    act(() => result.current.handleSelection("/d/b", 1, true, true));
    expect([...result.current.selectedPaths].sort()).toEqual([
      "/d/a",
      "/d/b",
      "/d/c",
      "/d/d",
    ]);
  });

  it("treats shift-click with no anchor as a plain click", async () => {
    const { result } = await renderLoaded("/d", items);
    act(() => result.current.handleSelection("/d/c", 2, false, true));
    expect(result.current.selectedPaths).toEqual(["/d/c"]);
  });

  it("selectAll and clearSelection work", async () => {
    const { result } = await renderLoaded("/d", items);
    act(() => result.current.selectAll());
    expect(result.current.selectedPaths).toHaveLength(4);
    act(() => result.current.clearSelection());
    expect(result.current.selectedPaths).toEqual([]);
  });

  it("totals the size of selected files and ignores unknown sizes", async () => {
    const { result } = await renderLoaded("/d", [
      file("a", 100),
      file("b", 250),
      file("c", null),
      folder("sub"),
    ]);
    act(() => result.current.setSelectedPaths(["/d/a", "/d/b", "/d/c", "/d/sub"]));
    expect(result.current.selectionSize).toBe(350);
  });

  it("clears the selection when moving to another folder", async () => {
    const { result } = await renderLoaded("/d", items);
    act(() => result.current.handleSelection("/d/a", 0, false, false));
    mockListing({ "/e": [file("x", 1, "/e")] });
    await act(async () => {
      await result.current.loadDir("/e");
    });
    expect(result.current.selectedPaths).toEqual([]);
  });
});

describe("useFileSystem - goUp", () => {
  async function goUpFrom(path: string, os: string) {
    mockPlatform.mockReturnValue(os);
    const hook = await renderLoaded(path, []);
    mockInvoke.mockClear();
    await act(async () => {
      hook.result.current.goUp();
    });
    return hook;
  }

  it("goes to the parent folder on Linux and stops at the root", async () => {
    await goUpFrom("/home/me", "linux");
    expect(listedPaths()).toEqual(["/home"]);

    await goUpFrom("/home", "linux");
    expect(listedPaths()).toEqual(["/"]);

    await goUpFrom("/", "linux");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("goes to the parent folder on Windows, then the drive list from a drive root", async () => {
    await goUpFrom("C:\\Users\\me", "windows");
    expect(listedPaths()).toEqual(["C:\\Users"]);

    await goUpFrom("C:\\Users", "windows");
    expect(listedPaths()).toEqual(["C:\\"]);

    await goUpFrom("C:\\", "windows");
    expect(mockInvoke).toHaveBeenCalledWith("get_drives");
    expect(listedPaths()).toEqual([]);
  });

  it("never climbs above the Android storage root", async () => {
    await goUpFrom("/storage/emulated/0/DCIM", "android");
    expect(listedPaths()).toEqual(["/storage/emulated/0"]);

    await goUpFrom("/storage/emulated/0", "android");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("does nothing from the drive list", async () => {
    await goUpFrom("", "windows");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("useFileSystem - startup", () => {
  it("opens the home folder when the dashboard appears", async () => {
    mockListing({ "/home/me": [file("a", 1, "/home/me")] });
    const { result } = renderHook(() => useFileSystem("dashboard"));
    await waitFor(() => expect(result.current.currentPath).toBe("/home/me"));
  });

  it("does nothing before the dashboard is shown", async () => {
    renderHook(() => useFileSystem("login"));
    await act(async () => {});
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockHomeDir).not.toHaveBeenCalled();
  });

  it("opens shared storage on Android without asking for a home dir", async () => {
    mockPlatform.mockReturnValue("android");
    mockListing({ "/storage/emulated/0": [] });
    const { result } = renderHook(() => useFileSystem("dashboard"));
    await waitFor(() => expect(result.current.currentPath).toBe("/storage/emulated/0"));
    expect(mockHomeDir).not.toHaveBeenCalled();
  });

  it("falls back to the drive list when the home dir can't be found", async () => {
    mockHomeDir.mockRejectedValue(new Error("no home"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockListing({});
    const { result } = renderHook(() => useFileSystem("dashboard"));
    await waitFor(() => expect(result.current.statusMsg).toBe("Select a Drive"));
    spy.mockRestore();
  });

  it("goHome returns to the home folder", async () => {
    const { result } = await renderLoaded("/d", []);
    mockListing({ "/home/me": [] });
    await act(async () => {
      await result.current.goHome();
    });
    await waitFor(() => expect(result.current.currentPath).toBe("/home/me"));
  });
});

describe("useFileSystem - folder watcher", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("watches the open folder and reloads (keeping surviving selection) after a change", async () => {
    let onChange: () => void = () => {};
    mockWatch.mockImplementation((_path: string, cb: () => void) => {
      onChange = cb;
      return Promise.resolve(jest.fn());
    });
    const { result } = await renderLoaded("/d", [file("keep"), file("gone")]);
    await flush();
    expect(mockWatch).toHaveBeenCalledWith("/d", expect.any(Function), { recursive: false });

    act(() => result.current.setSelectedPaths(["/d/keep", "/d/gone"]));
    mockListing({ "/d": [file("keep"), file("new")] });
    mockInvoke.mockClear();

    act(() => {
      onChange();
      onChange(); // a burst of events must collapse into one reload
    });
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    await flush();

    expect(listedPaths()).toEqual(["/d"]);
    expect(result.current.entries.map((e) => e.name).sort()).toEqual(["keep", "new"]);
    expect(result.current.selectedPaths).toEqual(["/d/keep"]);
  });

  it("stops watching the old folder when navigating away", async () => {
    const unlistenFirst = jest.fn();
    mockWatch.mockResolvedValueOnce(unlistenFirst).mockResolvedValue(jest.fn());
    const { result } = await renderLoaded("/d", []);
    await flush();

    mockListing({ "/e": [] });
    await act(async () => {
      await result.current.loadDir("/e");
    });
    await flush();

    expect(unlistenFirst).toHaveBeenCalledTimes(1);
    expect(mockWatch).toHaveBeenLastCalledWith("/e", expect.any(Function), { recursive: false });
  });

  it("does not start a watcher on Android", async () => {
    mockPlatform.mockReturnValue("android");
    await renderLoaded("/storage/emulated/0", []);
    await flush();
    expect(mockWatch).not.toHaveBeenCalled();
  });

  it("survives the watcher failing to start", async () => {
    mockWatch.mockRejectedValue(new Error("watch unsupported"));
    const { result } = await renderLoaded("/d", [file("a")]);
    await flush();
    expect(result.current.entries).toHaveLength(1);
  });
});

describe("useFileSystem - macOS", () => {
  it("opens the home folder under /Users", async () => {
    mockPlatform.mockReturnValue("macos");
    mockHomeDir.mockResolvedValue("/Users/alice");
    mockListing({ "/Users/alice": [] });
    const { result } = renderHook(() => useFileSystem("dashboard"));
    await waitFor(() => expect(result.current.currentPath).toBe("/Users/alice"));
  });

  it("goes up one folder at a time and stops at the root, like Linux", async () => {
    mockPlatform.mockReturnValue("macos");
    const { result } = await renderLoaded("/Users/alice/Documents", []);
    mockListing({ "/Users/alice": [] });
    mockInvoke.mockClear();
    await act(async () => {
      result.current.goUp();
    });
    expect(listedPaths()).toEqual(["/Users/alice"]);

    const volume = await renderLoaded("/Volumes", []);
    mockInvoke.mockClear();
    await act(async () => {
      volume.result.current.goUp();
    });
    expect(listedPaths()).toEqual(["/"]);

    const root = await renderLoaded("/", []);
    mockInvoke.mockClear();
    await act(async () => {
      root.result.current.goUp();
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("watches the open folder, unlike Android", async () => {
    mockPlatform.mockReturnValue("macos");
    await renderLoaded("/Users/alice", []);
    await waitFor(() =>
      expect(mockWatch).toHaveBeenCalledWith("/Users/alice", expect.any(Function), { recursive: false }),
    );
  });
});
