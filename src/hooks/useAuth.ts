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
  const [sessionExpired, setSessionExpired] = useState(false);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  const logout = useCallback(async () => {
    if (isTauri()) {
      try {
        await invoke("logout");
      } catch (e) {
        console.error(e);
      }
    }
    setView("login");
    setPassword("");
    setShowTimeoutWarning(false);
  }, []);

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
        const code = (await invoke("init_vault", { password })) as string;
        setRecoveryCode(code);
      }
      setView("recovery_display");
      return { success: true };
    } catch (e) {
      return { success: false, msg: String(e) };
    }
  }

  async function handleLogin(): Promise<ActionResult> {
    try {
      if (isTauri()) await invoke("login", { password });
      setPassword("");
      setView("dashboard");
      setSessionExpired(false);
      return { success: true };
    } catch (e) {
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
        });
      setPassword("");
      setConfirmPass("");
      setRecoveryCode("");
      setView("dashboard");
      setSessionExpired(false);
      return { success: true, msg: "Vault recovered." };
    } catch (e) {
      return { success: false, msg: String(e) };
    }
  }

  async function handleChangePassword(): Promise<ActionResult> {
    if (password !== confirmPass) return { success: false, msg: "Mismatch." };
    try {
      if (isTauri())
        await invoke("change_user_password", { newPassword: password });
      setPassword("");
      setConfirmPass("");
      return { success: true, msg: "Password updated." };
    } catch (e) {
      return { success: false, msg: String(e) };
    }
  }

  async function handleReset2FA(): Promise<ActionResult> {
    try {
      if (isTauri()) {
        const code = (await invoke("regenerate_recovery_code")) as string;
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
