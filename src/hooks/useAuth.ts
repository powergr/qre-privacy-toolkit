import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ViewState } from "../types";
import { getPasswordScore } from "../utils/security";

type ActionResult = { success: boolean; msg?: string };

const WARNING_DELAY_MS = 14 * 60 * 1000;
const COUNTDOWN_SECONDS = 60;

// Helper to detect if we are in the Tauri App or a Browser
const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function useAuth() {
  const [view, setView] = useState<ViewState>("loading");
  const [password, setPassword] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  // FIX F-01: Track the current (existing) password for the change-password flow.
  // This is required so we can verify the user knows their current password before
  // allowing them to set a new one, preventing session-hijack escalation.
  const [currentPassword, setCurrentPassword] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  // FIX F-10: Centralised helper to wipe all password-related state in one call.
  // Calling this promptly after any auth operation reduces the window in which a
  // plain JS string containing the master password lives in V8 heap memory.
  const clearPasswordState = useCallback(() => {
    setPassword("");
    setConfirmPass("");
    setCurrentPassword("");
  }, []);

  const logout = useCallback(async () => {
    if (isTauri()) {
      try {
        await invoke("logout");
      } catch (e) {
        console.error(e);
      }
    }
    setView("login");
    // FIX F-10: Clear all password state on logout.
    clearPasswordState();
    setShowTimeoutWarning(false);
  }, [clearPasswordState]);

  const performLogout = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (countdownIntervalRef.current)
      clearInterval(countdownIntervalRef.current);
    logout();
    setSessionExpired(true);
  }, [logout]);

  const triggerWarning = useCallback(() => {
    setShowTimeoutWarning(true);
    countdownIntervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          performLogout();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [performLogout]);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (countdownIntervalRef.current)
      clearInterval(countdownIntervalRef.current);
    setShowTimeoutWarning(false);
    setCountdown(COUNTDOWN_SECONDS);
    if (view === "dashboard") {
      idleTimerRef.current = setTimeout(
        () => triggerWarning(),
        WARNING_DELAY_MS,
      );
    }
  }, [view, triggerWarning]);

  useEffect(() => {
    if (view !== "dashboard") return;
    const events = ["mousemove", "keydown", "click", "touchstart"];
    const handler = () => resetIdleTimer();
    events.forEach((event) => window.addEventListener(event, handler));
    resetIdleTimer();
    return () => {
      events.forEach((event) => window.removeEventListener(event, handler));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (countdownIntervalRef.current)
        clearInterval(countdownIntervalRef.current);
    };
  }, [view, resetIdleTimer]);

  // --- INIT ---
  useEffect(() => {
    let mounted = true;
    async function init() {
      // Browser Fallback (Dev Mode)
      if (!isTauri()) {
        console.warn("Running in Browser Mode - Backend skipped");
        if (mounted) setView("login"); // Default to login in browser
        return;
      }

      try {
        const status = await invoke<string>("check_auth_status");
        if (!mounted) return;
        if (status === "unlocked") setView("dashboard");
        else if (status === "setup_needed") setView("setup");
        else setView("login");
      } catch (e) {
        console.error("Auth Check Failed:", e);
        if (mounted) setView("login");
      }
    }
    init();
    return () => {
      mounted = false;
    };
  }, []);

  async function handleInit(): Promise<ActionResult> {
    if (getPasswordScore(password) < 3)
      return { success: false, msg: "Password too weak." };
    if (password !== confirmPass)
      return { success: false, msg: "Passwords do not match." };
    try {
      if (isTauri()) {
        const code = (await invoke("init_vault", {
          password,
          vaultId: "local",
        })) as string;
        setRecoveryCode(code);
      }
      // FIX F-10: Clear password fields immediately after the vault is initialised —
      // the recovery display screen has no need for them.
      clearPasswordState();
      setView("recovery_display");
      return { success: true };
    } catch (e) {
      return { success: false, msg: String(e) };
    }
  }

  async function handleLogin(): Promise<ActionResult> {
    try {
      if (isTauri()) await invoke("login", { password, vaultId: "local" });
      // FIX F-10: Clear password from state immediately after a successful login.
      clearPasswordState();
      setView("dashboard");
      setSessionExpired(false);
      return { success: true };
    } catch (e) {
      // Do NOT clear on failure so the user does not have to re-type.
      return { success: false, msg: String(e) };
    }
  }

  async function handleRecovery(): Promise<ActionResult> {
    if (!recoveryCode || password !== confirmPass)
      return { success: false, msg: "Check inputs." };
    try {
      if (isTauri())
        await invoke("recover_vault", {
          recoveryCode: recoveryCode.trim(),
          newPassword: password,
          vaultId: "local",
        });

      clearPasswordState();
      setRecoveryCode("");
      setView("dashboard");
      setSessionExpired(false);
      return { success: true, msg: "Vault recovered." };
    } catch (e) {
      return { success: false, msg: String(e) };
    }
  }

  async function handleChangePassword(): Promise<ActionResult> {
    // Prevent silently succeeding when the user types the same password twice.
    if (password === currentPassword)
      return {
        success: false,
        msg: "New password must be different from your current password.",
      };

    if (getPasswordScore(password) < 3)
      return { success: false, msg: "New password is too weak." };

    if (password !== confirmPass)
      return { success: false, msg: "Passwords do not match." };

    try {
      if (isTauri())
        await invoke("change_user_password", {
          currentPassword,
          newPassword: password,
          vaultId: "local",
        });
      clearPasswordState();
      return { success: true, msg: "Password updated." };
    } catch (e) {
      return { success: false, msg: String(e) };
    }
  }

  async function handleReset2FA(): Promise<ActionResult> {
    try {
      if (isTauri()) {
        const code = (await invoke("regenerate_recovery_code", {
          vaultId: "local",
        })) as string;
        setRecoveryCode(code);
      }
      setView("recovery_display");
      return { success: true };
    } catch (e) {
      return { success: false, msg: String(e) };
    }
  }

  return {
    view,
    setView,
    password,
    setPassword,
    confirmPass,
    setConfirmPass,
    currentPassword,
    setCurrentPassword,
    recoveryCode,
    setRecoveryCode,
    sessionExpired,
    setSessionExpired,
    showTimeoutWarning,
    countdown,
    stayLoggedIn: resetIdleTimer,
    handleInit,
    handleLogin,
    handleRecovery,
    handleChangePassword,
    handleReset2FA,
    logout,
  };
}
