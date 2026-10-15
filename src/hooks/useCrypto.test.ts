import { renderHook, act } from "@testing-library/react";
import { useCrypto } from "./useCrypto";

const mockInvoke = jest.fn();
const mockListen = jest.fn();
const mockOpen = jest.fn();
const mockReadFile = jest.fn();
const mockPlatform = jest.fn();
const mockEntropy = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));
jest.mock("@tauri-apps/plugin-fs", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));
jest.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));
jest.mock("../utils/security", () => ({
  generateBrowserEntropy: () => mockEntropy(),
}));

let progressHandler: (event: { payload: { status: string; percentage: number } }) => void;
let unlisten: jest.Mock;
let loadDir: jest.Mock;

async function renderCrypto(os = "windows") {
  mockPlatform.mockReturnValue(os);
  const hook = renderHook(() => useCrypto(loadDir));
  await act(async () => {}); // let the platform effect settle
  return hook;
}

function lastInvokeArgs() {
  const calls = mockInvoke.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  unlisten = jest.fn();
  loadDir = jest.fn().mockResolvedValue(undefined);
  mockListen.mockImplementation((_event: string, cb: typeof progressHandler) => {
    progressHandler = cb;
    return Promise.resolve(unlisten);
  });
  mockInvoke.mockResolvedValue([{ name: "a.txt", success: true, message: "Locked" }]);
  mockEntropy.mockReturnValue([1, 2, 3]);
});

describe("useCrypto - running lock and unlock", () => {
  it("refuses to run with nothing selected", async () => {
    const { result } = await renderCrypto();
    let out: unknown;
    await act(async () => {
      out = await result.current.runCrypto("lock_file", [], "/d");
    });
    expect(out).toBeNull();
    expect(result.current.errorMsg).toBe("No files selected.");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("locks files with the chosen compression mode and reloads the same folder", async () => {
    const { result } = await renderCrypto();
    act(() => result.current.setCompressionMode("extreme"));

    let out: unknown;
    await act(async () => {
      out = await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });

    expect(mockInvoke).toHaveBeenCalledWith("lock_file", {
      filePaths: ["/d/a.txt"],
      keyfilePath: null,
      keyfileBytes: null,
      extraEntropy: null,
      compressionMode: "extreme",
      outputDir: null,
    });
    expect(loadDir).toHaveBeenCalledWith("/d");
    expect(out).toEqual([{ name: "a.txt", success: true, message: "Locked" }]);
  });

  it("unlocks with an output folder and sends no compression mode or entropy", async () => {
    const { result } = await renderCrypto();
    act(() => result.current.setIsParanoid(true));

    await act(async () => {
      await result.current.runCrypto("unlock_file", ["/d/a.txt.qre"], "/d", undefined, "/out");
    });

    const args = lastInvokeArgs();
    expect(args.compressionMode).toBeNull();
    expect(args.outputDir).toBe("/out");
    expect(args.extraEntropy).toBeNull();
    expect(mockEntropy).not.toHaveBeenCalled();
  });

  it("turns an empty output folder into null", async () => {
    const { result } = await renderCrypto();
    await act(async () => {
      await result.current.runCrypto("unlock_file", ["/d/a.qre"], "/d", undefined, "");
    });
    expect(lastInvokeArgs().outputDir).toBeNull();
  });

  it("adds browser entropy in paranoid mode, clamped to byte values", async () => {
    mockEntropy.mockReturnValue([300, -5, 12.7, 255, 0]);
    const { result } = await renderCrypto();
    act(() => result.current.setIsParanoid(true));

    await act(async () => {
      await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });

    expect(lastInvokeArgs().extraEntropy).toEqual([255, 0, 12, 255, 0]);
  });

  it("prefers explicitly supplied entropy over generated entropy", async () => {
    const { result } = await renderCrypto();
    act(() => result.current.setIsParanoid(true));

    await act(async () => {
      await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d", [9, 999, -1]);
    });

    expect(lastInvokeArgs().extraEntropy).toEqual([9, 255, 0]);
    expect(mockEntropy).not.toHaveBeenCalled();
  });

  it("sends no entropy when paranoid mode is off", async () => {
    const { result } = await renderCrypto();
    await act(async () => {
      await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    expect(lastInvokeArgs().extraEntropy).toBeNull();
  });

  it("reports a backend error, returns null and does not reload", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockRejectedValue("Vault is locked.");
    const { result } = await renderCrypto();

    let out: unknown = "unset";
    await act(async () => {
      out = await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });

    expect(out).toBeNull();
    expect(result.current.errorMsg).toBe("Vault is locked.");
    expect(loadDir).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("useCrypto - progress", () => {
  it("shows progress events from the backend", async () => {
    const { result } = await renderCrypto();
    act(() => progressHandler({ payload: { status: "Encrypting: a.txt", percentage: 42 } }));
    expect(result.current.progress).toEqual({ status: "Encrypting: a.txt", percentage: 42 });
  });

  it("clears the progress bar shortly after a run finishes", async () => {
    jest.useFakeTimers();
    try {
      const { result } = await renderCrypto();
      await act(async () => {
        await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
      });
      expect(result.current.progress).not.toBeNull();

      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(result.current.progress).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops listening when unmounted", async () => {
    const { unmount } = await renderCrypto();
    unmount();
    await act(async () => {});
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("useCrypto - key file", () => {
  it("on desktop, remembers only the path and lets the backend read the file", async () => {
    mockOpen.mockResolvedValue("C:\\keys\\my.key");
    const { result } = await renderCrypto("windows");

    await act(async () => {
      await result.current.selectKeyFile();
    });
    expect(result.current.keyFile).toBe("C:\\keys\\my.key");
    expect(mockReadFile).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    const args = lastInvokeArgs();
    expect(args.keyfilePath).toBe("C:\\keys\\my.key");
    expect(args.keyfileBytes).toBeNull();
  });

  it("on Android, reads the key file bytes and sends them along", async () => {
    mockOpen.mockResolvedValue("content://keys/my.key");
    mockReadFile.mockResolvedValue(new Uint8Array([7, 8, 9]));
    const { result } = await renderCrypto("android");

    await act(async () => {
      await result.current.selectKeyFile();
    });
    await act(async () => {
      await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });

    expect(lastInvokeArgs().keyfileBytes).toEqual([7, 8, 9]);
  });

  it("on Android, drops the selection if the key file can't be read", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockOpen.mockResolvedValue("content://keys/my.key");
    mockReadFile.mockRejectedValue(new Error("permission denied"));
    const { result } = await renderCrypto("android");

    await act(async () => {
      await result.current.selectKeyFile();
    });

    expect(result.current.keyFile).toBeNull();
    expect(result.current.errorMsg).toBe("Failed to load keyfile data.");
    spy.mockRestore();
  });

  it("ignores a cancelled picker and reports a picker failure", async () => {
    const { result } = await renderCrypto();
    mockOpen.mockResolvedValueOnce(null);
    await act(async () => {
      await result.current.selectKeyFile();
    });
    expect(result.current.keyFile).toBeNull();
    expect(result.current.errorMsg).toBeNull();

    mockOpen.mockRejectedValueOnce(new Error("dialog crashed"));
    await act(async () => {
      await result.current.selectKeyFile();
    });
    expect(result.current.errorMsg).toContain("Failed to select keyfile");
  });

  it("overwrites key file bytes with zeros when cleared", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockOpen.mockResolvedValue("content://keys/my.key");
    mockReadFile.mockResolvedValue(bytes);
    const { result } = await renderCrypto("android");

    await act(async () => {
      await result.current.selectKeyFile();
    });
    act(() => result.current.setKeyFile());

    expect(Array.from(bytes)).toEqual([0, 0, 0, 0]);
    expect(result.current.keyFile).toBeNull();
  });
});
