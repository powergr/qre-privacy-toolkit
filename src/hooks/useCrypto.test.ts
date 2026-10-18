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
      verifyAfter: true,
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

describe("useCrypto - verify after locking", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is on by default", async () => {
    const { result } = await renderCrypto();
    expect(result.current.verifyAfterLock).toBe(true);
  });

  it("sends the choice with every lock request", async () => {
    const { result } = await renderCrypto();
    await act(async () => {
      await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    expect(mockInvoke.mock.calls.find(([c]) => c === "lock_file")![1].verifyAfter).toBe(true);

    act(() => result.current.setVerifyAfterLock(false));
    mockInvoke.mockClear();
    await act(async () => {
      await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    expect(mockInvoke.mock.calls.find(([c]) => c === "lock_file")![1].verifyAfter).toBe(false);
  });

  it("sends nothing about it when unlocking", async () => {
    const { result } = await renderCrypto();
    await act(async () => {
      await result.current.runCrypto("unlock_file", ["/d/a.txt.qre"], "/d");
    });
    expect(mockInvoke.mock.calls.find(([c]) => c === "unlock_file")![1].verifyAfter).toBeNull();
  });

  it("remembers the choice for next time", async () => {
    const first = await renderCrypto();
    act(() => first.result.current.setVerifyAfterLock(false));
    expect(localStorage.getItem("qre_verify_after_lock")).toBe("0");
    first.unmount();

    const second = await renderCrypto();
    expect(second.result.current.verifyAfterLock).toBe(false);
    act(() => second.result.current.setVerifyAfterLock(true));
    expect(localStorage.getItem("qre_verify_after_lock")).toBe("1");
  });

  it("stays on when the browser cannot store anything", async () => {
    const spy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = await renderCrypto();
    expect(result.current.verifyAfterLock).toBe(true);
    spy.mockRestore();
  });

  it("still changes for this session when the choice cannot be saved", async () => {
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = await renderCrypto();
    act(() => result.current.setVerifyAfterLock(false));
    expect(result.current.verifyAfterLock).toBe(false);
    spy.mockRestore();
  });
});

describe("useCrypto - upgrading older files when unlocking", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is off by default", async () => {
    const { result } = await renderCrypto();
    expect(result.current.upgradeWhenUnlocking).toBe(false);
  });

  it("can run the upgrade command with the same key file fields as the others", async () => {
    mockOpen.mockResolvedValue("/keys/mine.key");
    const { result } = await renderCrypto();
    await act(async () => {
      await result.current.selectKeyFile();
    });
    await act(async () => {
      await result.current.runCrypto("relock_file", ["/d/a.qre"], "/d");
    });
    const args = mockInvoke.mock.calls.find(([c]) => c === "relock_file")![1];
    expect(args.filePaths).toEqual(["/d/a.qre"]);
    expect(args.keyfilePath).toBe("/keys/mine.key");
    // Nothing that belongs to locking is sent.
    expect(args.verifyAfter).toBeNull();
    expect(args.compressionMode).toBeNull();
    expect(args.extraEntropy).toBeNull();
    expect(loadDir).toHaveBeenCalledWith("/d");
  });

  it("remembers the choice for next time", async () => {
    const first = await renderCrypto();
    act(() => first.result.current.setUpgradeWhenUnlocking(true));
    expect(localStorage.getItem("qre_upgrade_when_unlocking")).toBe("1");
    first.unmount();

    const second = await renderCrypto();
    expect(second.result.current.upgradeWhenUnlocking).toBe(true);
    act(() => second.result.current.setUpgradeWhenUnlocking(false));
    expect(localStorage.getItem("qre_upgrade_when_unlocking")).toBe("0");
  });

  it("ignores anything but an explicit yes in the saved value", async () => {
    localStorage.setItem("qre_upgrade_when_unlocking", "true");
    const { result } = await renderCrypto();
    expect(result.current.upgradeWhenUnlocking).toBe(false);
  });

  it("stays off when the browser cannot store anything", async () => {
    const spy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = await renderCrypto();
    expect(result.current.upgradeWhenUnlocking).toBe(false);
    spy.mockRestore();
  });

  it("still changes for this session when the choice cannot be saved", async () => {
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = await renderCrypto();
    act(() => result.current.setUpgradeWhenUnlocking(true));
    expect(result.current.upgradeWhenUnlocking).toBe(true);
    spy.mockRestore();
  });

  it("is kept apart from the verify setting", async () => {
    const { result } = await renderCrypto();
    act(() => result.current.setUpgradeWhenUnlocking(true));
    expect(result.current.verifyAfterLock).toBe(true);
    expect(localStorage.getItem("qre_verify_after_lock")).toBeNull();
  });
});


describe("useCrypto - cancelling a running job", () => {
  const cancelCalls = () => mockInvoke.mock.calls.filter(([c]) => c === "cancel_operation");

  function slowJob() {
    let finish!: (v: unknown) => void;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "cancel_operation") return Promise.resolve(null);
      return new Promise((r) => {
        finish = r;
      });
    });
    return (v: unknown) => finish(v);
  }

  it("cannot be cancelled when nothing is running, and asking does nothing", async () => {
    const { result } = await renderCrypto();
    expect(result.current.canCancel).toBe(false);
    expect(result.current.cancelling).toBe(false);
    await act(async () => {
      await result.current.cancel();
    });
    expect(cancelCalls()).toHaveLength(0);
    expect(result.current.cancelling).toBe(false);
  });

  it("can be cancelled from the moment a job starts until it ends", async () => {
    const finish = slowJob();
    const { result } = await renderCrypto();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    expect(result.current.canCancel).toBe(true);
    await act(async () => {
      finish([]);
      await run;
    });
    expect(result.current.canCancel).toBe(false);
  });

  it("asks the backend to stop, once, and reports that it is stopping", async () => {
    const finish = slowJob();
    const { result } = await renderCrypto();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    await act(async () => {
      await result.current.cancel();
      await result.current.cancel();
    });
    expect(cancelCalls()).toHaveLength(1);
    expect(result.current.cancelling).toBe(true);
    await act(async () => {
      finish([{ name: "a.txt", success: false, message: "Cancelled." }]);
      await run;
    });
    expect(result.current.cancelling).toBe(false);
    expect(result.current.canCancel).toBe(false);
  });

  it.each(["lock_file", "unlock_file", "relock_file"] as const)("%s can be cancelled", async (cmd) => {
    const finish = slowJob();
    const { result } = await renderCrypto();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.runCrypto(cmd, ["/d/a.qre"], "/d");
    });
    expect(result.current.canCancel).toBe(true);
    await act(async () => {
      finish([]);
      await run;
    });
  });

  it("returns what the job answered when it was stopped, so the screen can say so", async () => {
    const finish = slowJob();
    const { result } = await renderCrypto();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    await act(async () => {
      await result.current.cancel();
      finish([{ name: "a.txt", success: false, message: "Cancelled." }]);
    });
    await expect(run).resolves.toEqual([{ name: "a.txt", success: false, message: "Cancelled." }]);
    expect(loadDir).toHaveBeenCalledWith("/d");
  });

  it("a new job does not start out cancelled", async () => {
    let finish = slowJob();
    const { result } = await renderCrypto();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    await act(async () => {
      await result.current.cancel();
      finish([]);
      await run;
    });
    finish = slowJob();
    act(() => {
      run = result.current.runCrypto("lock_file", ["/d/b.txt"], "/d");
    });
    expect(result.current.cancelling).toBe(false);
    expect(result.current.canCancel).toBe(true);
    await act(async () => {
      finish([]);
      await run;
    });
  });

  it("goes back to normal if the stop request itself fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockImplementation((cmd: string) => (cmd === "cancel_operation" ? Promise.reject("no") : new Promise(() => {})));
    const { result } = await renderCrypto();
    act(() => {
      void result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.cancelling).toBe(false);
    expect(result.current.canCancel).toBe(true);
    spy.mockRestore();
  });

  it("is also cleared when the job itself fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockRejectedValue("backend down");
    const { result } = await renderCrypto();
    await act(async () => {
      await result.current.runCrypto("lock_file", ["/d/a.txt"], "/d");
    });
    expect(result.current.canCancel).toBe(false);
    expect(result.current.cancelling).toBe(false);
    spy.mockRestore();
  });
});
