import { renderHook, act } from "@testing-library/react";
import { usePortableVault } from "./usePortableVault";
import { DriveInfo } from "../types";

const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

function drive(path: string, uuid: string | null = null): DriveInfo {
  return {
    path,
    name: `Drive ${path}`,
    free_space: 100,
    total_space: 200,
    is_qre_portable: uuid !== null,
    vault_uuid: uuid ?? undefined,
  };
}

function commandCalls(cmd: string) {
  return mockInvoke.mock.calls.filter(([c]) => c === cmd);
}

function mockDrives(list: DriveInfo[]) {
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "enumerate_removable_drives" ? Promise.resolve(list) : Promise.resolve(null),
  );
}

async function scanned(list: DriveInfo[]) {
  mockDrives(list);
  const hook = renderHook(() => usePortableVault());
  await act(async () => {
    await hook.result.current.scanDrives();
  });
  return hook;
}

beforeEach(() => {
  mockInvoke.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("usePortableVault - scanning", () => {
  it("lists found drives as locked", async () => {
    const { result } = await scanned([drive("D:\\", "uuid-d"), drive("E:\\")]);
    expect(result.current.drives).toHaveLength(2);
    expect(result.current.drives.every((d) => d.isLocked && !d.isUnlocked)).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.isScanning).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("keeps an unlocked drive unlocked across a rescan, with fresh drive info", async () => {
    const { result } = await scanned([drive("D:\\", "uuid-d")]);
    await act(async () => {
      await result.current.unlockVault("D:\\", "pw");
    });
    expect(result.current.drives[0].isUnlocked).toBe(true);

    mockDrives([{ ...drive("D:\\", "uuid-d"), free_space: 5 }]);
    await act(async () => {
      await result.current.scanDrives();
    });

    expect(result.current.drives[0].isUnlocked).toBe(true);
    expect(result.current.drives[0].isLocked).toBe(false);
    expect(result.current.drives[0].drive.free_space).toBe(5);
  });

  it("drops drives that were unplugged", async () => {
    const { result } = await scanned([drive("D:\\"), drive("E:\\")]);
    mockDrives([drive("E:\\")]);
    await act(async () => {
      await result.current.scanDrives();
    });
    expect(result.current.drives.map((d) => d.drive.path)).toEqual(["E:\\"]);
  });

  it("ignores a second scan while one is already running", async () => {
    let finish!: (v: DriveInfo[]) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise<DriveInfo[]>((r) => {
          finish = r;
        }),
    );
    const { result } = renderHook(() => usePortableVault());

    let first!: Promise<void>;
    act(() => {
      first = result.current.scanDrives();
    });
    expect(result.current.isScanning).toBe(true);
    await act(async () => {
      await result.current.scanDrives();
    });
    expect(commandCalls("enumerate_removable_drives")).toHaveLength(1);

    await act(async () => {
      finish([drive("D:\\")]);
      await first;
    });
    expect(result.current.isScanning).toBe(false);
  });

  it("reports a scan error and allows scanning again", async () => {
    mockInvoke.mockRejectedValueOnce("device query failed");
    const { result } = renderHook(() => usePortableVault());
    await act(async () => {
      await result.current.scanDrives();
    });
    expect(result.current.error).toContain("device query failed");
    expect(result.current.isScanning).toBe(false);

    mockDrives([drive("D:\\")]);
    await act(async () => {
      await result.current.scanDrives();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.drives).toHaveLength(1);
  });
});

describe("usePortableVault - creating a vault", () => {
  it("creates, unlocks, rescans and returns the recovery code", async () => {
    const order: string[] = [];
    mockInvoke.mockImplementation((cmd: string) => {
      order.push(cmd);
      if (cmd === "init_portable_vault") return Promise.resolve(["REC-CODE", "new-uuid"]);
      if (cmd === "enumerate_removable_drives") return Promise.resolve([drive("D:\\", "new-uuid")]);
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => usePortableVault());

    let out: unknown;
    await act(async () => {
      out = await result.current.initVault("D:\\", "pw", "High");
    });

    expect(out).toEqual({ success: true, recoveryCode: "REC-CODE", vaultId: "new-uuid" });
    expect(order).toEqual(["init_portable_vault", "unlock_portable_vault", "enumerate_removable_drives"]);
    expect(commandCalls("init_portable_vault")[0][1]).toEqual({
      drivePath: "D:\\",
      password: "pw",
      tier: "High",
    });
    expect(commandCalls("unlock_portable_vault")[0][1]).toEqual({
      drivePath: "D:\\",
      password: "pw",
    });
    expect(result.current.loading).toBe(false);
  });

  it("reports the failure and never tries to unlock when creation fails", async () => {
    mockInvoke.mockRejectedValue("Drive is read-only");
    const { result } = renderHook(() => usePortableVault());

    let out: unknown;
    await act(async () => {
      out = await result.current.initVault("D:\\", "pw", "Standard");
    });

    expect(out).toEqual({ success: false, msg: "Drive is read-only" });
    expect(result.current.error).toBe("Drive is read-only");
    expect(commandCalls("unlock_portable_vault")).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });
});

describe("usePortableVault - unlock and lock", () => {
  it("marks only the unlocked drive as unlocked", async () => {
    const { result } = await scanned([drive("D:\\", "uuid-d"), drive("E:\\", "uuid-e")]);

    let out: unknown;
    await act(async () => {
      out = await result.current.unlockVault("E:\\", "pw");
    });

    expect(out).toEqual({ success: true });
    const byPath = Object.fromEntries(result.current.drives.map((d) => [d.drive.path, d]));
    expect(byPath["E:\\"].isUnlocked).toBe(true);
    expect(byPath["D:\\"].isUnlocked).toBe(false);
  });

  it("leaves the drive locked and reports the error on a wrong password", async () => {
    const { result } = await scanned([drive("D:\\", "uuid-d")]);
    mockInvoke.mockRejectedValueOnce("Incorrect password");

    let out: unknown;
    await act(async () => {
      out = await result.current.unlockVault("D:\\", "bad");
    });

    expect(out).toEqual({ success: false, msg: "Incorrect password" });
    expect(result.current.drives[0].isLocked).toBe(true);
    expect(result.current.error).toBe("Incorrect password");
  });

  it("locks a drive using its vault UUID", async () => {
    const { result } = await scanned([drive("D:\\", "uuid-d")]);
    await act(async () => {
      await result.current.unlockVault("D:\\", "pw");
    });

    await act(async () => {
      await result.current.lockVault("D:\\");
    });

    expect(commandCalls("lock_portable_vault")[0][1]).toEqual({ vaultId: "uuid-d" });
    expect(result.current.drives[0].isLocked).toBe(true);
    expect(result.current.drives[0].isUnlocked).toBe(false);
  });

  it("refuses to lock a drive that has no vault UUID", async () => {
    const { result } = await scanned([drive("D:\\")]);

    await act(async () => {
      await expect(result.current.lockVault("D:\\")).rejects.toThrow("Vault UUID not found");
    });

    expect(commandCalls("lock_portable_vault")).toHaveLength(0);
    expect(result.current.error).toContain("Vault UUID not found");
  });

  it("keeps the drive unlocked if the lock command fails", async () => {
    const { result } = await scanned([drive("D:\\", "uuid-d")]);
    await act(async () => {
      await result.current.unlockVault("D:\\", "pw");
    });
    mockInvoke.mockRejectedValueOnce("lock failed");

    await act(async () => {
      await expect(result.current.lockVault("D:\\")).rejects.toBe("lock failed");
    });

    expect(result.current.drives[0].isUnlocked).toBe(true);
  });
});
