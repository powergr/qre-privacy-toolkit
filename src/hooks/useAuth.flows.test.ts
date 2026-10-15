import { renderHook, act, waitFor } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAuth } from "./useAuth";

const mockInvoke = jest.fn();

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}));

const mockOpen = open as unknown as jest.Mock;

const STRONG = "Correct-Horse-Battery-Staple-9271!";
const OTHER_STRONG = "Different-Purple-Elephant-Lamp-4408#";
const WEAK = "abc";

type Auth = ReturnType<typeof useAuth>;

function setTauri(on: boolean) {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function commandCalls(cmd: string) {
  return mockInvoke.mock.calls.filter(([c]) => c === cmd);
}

async function renderAuth(status = "locked") {
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "check_auth_status" ? Promise.resolve(status) : Promise.resolve(null),
  );
  const hook = renderHook(() => useAuth());
  await waitFor(() => expect(hook.result.current.view).not.toBe("loading"));
  return hook;
}

async function run<T>(hook: { result: { current: Auth } }, fn: (a: Auth) => Promise<T>) {
  let out!: T;
  await act(async () => {
    out = await fn(hook.result.current);
  });
  return out;
}

function type(hook: { result: { current: Auth } }, fields: Partial<Record<string, string>>) {
  act(() => {
    const a = hook.result.current;
    if (fields.password !== undefined) a.setPassword(fields.password);
    if (fields.confirm !== undefined) a.setConfirmPass(fields.confirm);
    if (fields.current !== undefined) a.setCurrentPassword(fields.current);
    if (fields.code !== undefined) a.setRecoveryCode(fields.code);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setTauri(true);
});
afterEach(() => setTauri(false));

describe("useAuth - starting up", () => {
  it.each([
    ["unlocked", "dashboard"],
    ["setup_needed", "setup"],
    ["locked", "login"],
    ["anything-else", "login"],
  ])("maps backend status %s to the %s screen", async (status, view) => {
    const { result } = await renderAuth(status);
    expect(result.current.view).toBe(view);
  });

  it("falls back to the login screen if the status check fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockRejectedValue(new Error("backend down"));
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.view).toBe("login"));
    spy.mockRestore();
  });

  it("shows the login screen without calling the backend in a plain browser", async () => {
    setTauri(false);
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.view).toBe("login"));
    expect(mockInvoke).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("useAuth - first-time setup", () => {
  it("rejects a weak password without touching the backend", async () => {
    const hook = await renderAuth("setup_needed");
    type(hook, { password: WEAK, confirm: WEAK });
    const res = await run(hook, (a) => a.handleInit());
    expect(res).toEqual({ success: false, msg: "Password too weak." });
    expect(commandCalls("init_vault")).toHaveLength(0);
  });

  it("rejects mismatched passwords", async () => {
    const hook = await renderAuth("setup_needed");
    type(hook, { password: STRONG, confirm: OTHER_STRONG });
    const res = await run(hook, (a) => a.handleInit());
    expect(res).toEqual({ success: false, msg: "Passwords do not match." });
    expect(commandCalls("init_vault")).toHaveLength(0);
  });

  it("creates the vault, shows the recovery code and wipes the typed passwords", async () => {
    const hook = await renderAuth("setup_needed");
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "init_vault" ? Promise.resolve("RECOVERY-CODE-123") : Promise.resolve(null),
    );
    type(hook, { password: STRONG, confirm: STRONG });

    const res = await run(hook, (a) => a.handleInit());

    expect(res).toEqual({ success: true });
    expect(commandCalls("init_vault")[0][1]).toEqual({ password: STRONG, vaultId: "local" });
    expect(hook.result.current.recoveryCode).toBe("RECOVERY-CODE-123");
    expect(hook.result.current.view).toBe("recovery_display");
    expect(hook.result.current.password).toBe("");
    expect(hook.result.current.confirmPass).toBe("");
  });

  it("reports a backend failure and stays on the setup screen", async () => {
    const hook = await renderAuth("setup_needed");
    mockInvoke.mockRejectedValue("disk full");
    type(hook, { password: STRONG, confirm: STRONG });

    const res = await run(hook, (a) => a.handleInit());

    expect(res).toEqual({ success: false, msg: "disk full" });
    expect(hook.result.current.view).toBe("setup");
    expect(hook.result.current.recoveryCode).toBe("");
  });
});

describe("useAuth - login", () => {
  it("logs in, wipes the password and clears an expired-session flag", async () => {
    const hook = await renderAuth("locked");
    act(() => hook.result.current.setSessionExpired(true));
    type(hook, { password: STRONG });

    const res = await run(hook, (a) => a.handleLogin());

    expect(res).toEqual({ success: true });
    expect(commandCalls("login")[0][1]).toEqual({ password: STRONG, vaultId: "local" });
    expect(hook.result.current.view).toBe("dashboard");
    expect(hook.result.current.password).toBe("");
    expect(hook.result.current.sessionExpired).toBe(false);
  });

  it("keeps the typed password and the login screen after a failed attempt", async () => {
    const hook = await renderAuth("locked");
    mockInvoke.mockRejectedValue("Too many failed attempts. Please wait 30 more second(s).");
    type(hook, { password: "wrong-password" });

    const res = await run(hook, (a) => a.handleLogin());

    expect(res.success).toBe(false);
    expect(res.msg).toContain("Too many failed attempts");
    expect(hook.result.current.view).toBe("login");
    expect(hook.result.current.password).toBe("wrong-password");
  });
});

describe("useAuth - recovery", () => {
  it("requires a recovery code and matching passwords", async () => {
    const hook = await renderAuth("locked");
    type(hook, { password: STRONG, confirm: STRONG, code: "" });
    expect(await run(hook, (a) => a.handleRecovery())).toEqual({
      success: false,
      msg: "Check inputs.",
    });

    type(hook, { code: "ABCD-EFGH", confirm: OTHER_STRONG });
    expect((await run(hook, (a) => a.handleRecovery())).success).toBe(false);
    expect(commandCalls("recover_vault")).toHaveLength(0);
  });

  it("recovers with a trimmed code, sets the new password and signs in", async () => {
    const hook = await renderAuth("locked");
    type(hook, { password: STRONG, confirm: STRONG, code: "  ABCD-EFGH  " });

    const res = await run(hook, (a) => a.handleRecovery());

    expect(res).toEqual({ success: true, msg: "Vault recovered." });
    expect(commandCalls("recover_vault")[0][1]).toEqual({
      recoveryCode: "ABCD-EFGH",
      newPassword: STRONG,
      vaultId: "local",
    });
    expect(hook.result.current.view).toBe("dashboard");
    expect(hook.result.current.recoveryCode).toBe("");
    expect(hook.result.current.password).toBe("");
  });

  it("keeps everything on screen when the backend rejects the code", async () => {
    const hook = await renderAuth("locked");
    mockInvoke.mockRejectedValue("Invalid recovery code");
    type(hook, { password: STRONG, confirm: STRONG, code: "WRONG" });

    const res = await run(hook, (a) => a.handleRecovery());

    expect(res).toEqual({ success: false, msg: "Invalid recovery code" });
    expect(hook.result.current.view).toBe("login");
    expect(hook.result.current.recoveryCode).toBe("WRONG");
  });
});

describe("useAuth - change password", () => {
  async function loggedIn() {
    const hook = await renderAuth("unlocked");
    mockInvoke.mockClear();
    return hook;
  }

  it("refuses to reuse the current password", async () => {
    const hook = await loggedIn();
    type(hook, { current: STRONG, password: STRONG, confirm: STRONG });
    const res = await run(hook, (a) => a.handleChangePassword());
    expect(res.success).toBe(false);
    expect(res.msg).toContain("different");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("refuses a weak new password and a mismatched confirmation", async () => {
    const hook = await loggedIn();
    type(hook, { current: STRONG, password: WEAK, confirm: WEAK });
    expect((await run(hook, (a) => a.handleChangePassword())).msg).toContain("too weak");

    type(hook, { password: OTHER_STRONG, confirm: STRONG });
    expect((await run(hook, (a) => a.handleChangePassword())).msg).toBe(
      "Passwords do not match.",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("changes the password and wipes all three password fields", async () => {
    const hook = await loggedIn();
    type(hook, { current: STRONG, password: OTHER_STRONG, confirm: OTHER_STRONG });

    const res = await run(hook, (a) => a.handleChangePassword());

    expect(res).toEqual({ success: true, msg: "Password updated." });
    expect(commandCalls("change_user_password")[0][1]).toEqual({
      currentPassword: STRONG,
      newPassword: OTHER_STRONG,
      vaultId: "local",
    });
    expect(hook.result.current.password).toBe("");
    expect(hook.result.current.confirmPass).toBe("");
    expect(hook.result.current.currentPassword).toBe("");
  });

  it("reports a wrong current password from the backend", async () => {
    const hook = await loggedIn();
    mockInvoke.mockRejectedValue("Current password is incorrect.");
    type(hook, { current: "nope", password: OTHER_STRONG, confirm: OTHER_STRONG });

    const res = await run(hook, (a) => a.handleChangePassword());

    expect(res).toEqual({ success: false, msg: "Current password is incorrect." });
    expect(hook.result.current.currentPassword).toBe("nope");
  });
});

describe("useAuth - new recovery code", () => {
  it("shows the freshly generated code", async () => {
    const hook = await renderAuth("unlocked");
    mockInvoke.mockResolvedValue("NEW-CODE-999");

    const res = await run(hook, (a) => a.handleReset2FA());

    expect(res).toEqual({ success: true });
    expect(commandCalls("regenerate_recovery_code")[0][1]).toEqual({ vaultId: "local" });
    expect(hook.result.current.recoveryCode).toBe("NEW-CODE-999");
    expect(hook.result.current.view).toBe("recovery_display");
  });

  it("stays put and reports the error if the backend refuses", async () => {
    const hook = await renderAuth("unlocked");
    mockInvoke.mockRejectedValue("Vault is locked. Cannot reset code.");

    const res = await run(hook, (a) => a.handleReset2FA());

    expect(res.success).toBe(false);
    expect(hook.result.current.view).toBe("dashboard");
  });
});

describe("useAuth - restore backup", () => {
  it("does nothing when the file picker is cancelled", async () => {
    const hook = await renderAuth("setup_needed");
    mockOpen.mockResolvedValue(null);
    mockInvoke.mockClear();

    const res = await run(hook, (a) => a.handleRestoreBackup());

    expect(res).toEqual({ success: true });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(hook.result.current.view).toBe("setup");
  });

  it("restores the chosen backup and sends the user to login", async () => {
    const hook = await renderAuth("setup_needed");
    mockOpen.mockResolvedValue("C:\\backups\\keychain.json");

    const res = await run(hook, (a) => a.handleRestoreBackup());

    expect(res.success).toBe(true);
    expect(res.msg).toContain("Log in");
    expect(commandCalls("restore_keychain")[0][1]).toEqual({
      backupPath: "C:\\backups\\keychain.json",
    });
    expect(hook.result.current.view).toBe("login");
  });

  it("shows the backend's reason when the backup is rejected", async () => {
    const hook = await renderAuth("setup_needed");
    mockOpen.mockResolvedValue("C:\\backups\\wrong.json");
    mockInvoke.mockRejectedValue("This file doesn't look like a valid QRE keychain backup.");

    const res = await run(hook, (a) => a.handleRestoreBackup());

    expect(res.success).toBe(false);
    expect(res.msg).toContain("valid QRE keychain backup");
    expect(hook.result.current.view).toBe("setup");
  });
});

describe("useAuth - logout", () => {
  it("locks the backend, returns to login and wipes typed passwords", async () => {
    const hook = await renderAuth("unlocked");
    type(hook, { password: "secret-1", confirm: "secret-2", current: "secret-3" });

    await run(hook, (a) => a.logout());

    expect(commandCalls("logout")).toHaveLength(1);
    expect(hook.result.current.view).toBe("login");
    expect(hook.result.current.password).toBe("");
    expect(hook.result.current.confirmPass).toBe("");
    expect(hook.result.current.currentPassword).toBe("");
  });

  it("still returns to the login screen if the backend call fails", async () => {
    const hook = await renderAuth("unlocked");
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockRejectedValue(new Error("ipc down"));

    await run(hook, (a) => a.logout());

    expect(hook.result.current.view).toBe("login");
    spy.mockRestore();
  });
});
