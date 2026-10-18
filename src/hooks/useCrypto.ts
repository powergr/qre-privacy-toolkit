import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import { generateBrowserEntropy } from "../utils/security";
import { BatchResult } from "../types";

interface ProgressEvent {
  status: string;
  percentage: number;
}

const VERIFY_KEY = "qre_verify_after_lock";
const UPGRADE_KEY = "qre_upgrade_when_unlocking";

/** Checking each new locked file is on unless the user turned it off. */
function readVerifyAfterLock(): boolean {
  try {
    return localStorage.getItem(VERIFY_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Upgrading an older file when it is unlocked is off unless the user turned it on. */
function readUpgradeWhenUnlocking(): boolean {
  try {
    return localStorage.getItem(UPGRADE_KEY) === "1";
  } catch {
    return false;
  }
}

// FIX 1: Pass the raw loadDir function instead of a captured closure
export function useCrypto(loadDir: (path: string) => Promise<void>) {
  const [keyFilePath, setKeyFilePath] = useState<string | null>(null);
  const [keyFileBytes, setKeyFileBytes] = useState<Uint8Array | null>(null);
  const [isParanoid, setIsParanoid] = useState(false);
  const [compressionMode, setCompressionMode] = useState("auto");
  // After locking, open the new file once to be sure it is whole. The choice is remembered.
  const [verifyAfterLock, setVerifyAfterLockState] = useState(readVerifyAfterLock);
  function setVerifyAfterLock(on: boolean) {
    setVerifyAfterLockState(on);
    try {
      localStorage.setItem(VERIFY_KEY, on ? "1" : "0");
    } catch {
      // The choice just will not be remembered.
    }
  }
  // After a file in an older format is unlocked, also rewrite the locked copy in the current
  // format. Off by default, because it replaces files without being asked each time.
  const [upgradeWhenUnlocking, setUpgradeWhenUnlockingState] = useState(readUpgradeWhenUnlocking);
  function setUpgradeWhenUnlocking(on: boolean) {
    setUpgradeWhenUnlockingState(on);
    try {
      localStorage.setItem(UPGRADE_KEY, on ? "1" : "0");
    } catch {
      // The choice just will not be remembered.
    }
  }
  const [currentPlatform, setCurrentPlatform] = useState<string>("windows");

  // True while a lock, unlock or upgrade started here is running, so only those show a Cancel button.
  const [running, setRunning] = useState(false);
  // True from the moment Cancel is pressed until the job has stopped.
  const [cancelling, setCancelling] = useState(false);
  // Set at once on the first press, before the screen has redrawn, so a second press or a double
  // click cannot send the request twice.
  const cancelAsked = useRef(false);

  const [progress, setProgress] = useState<{
    status: string;
    percentage: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const os = platform();
    setCurrentPlatform(os);

    const unlisten = listen<ProgressEvent>("qre:progress", (event) => {
      setProgress({
        status: event.payload.status,
        percentage: event.payload.percentage,
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  async function selectKeyFile() {
    try {
      const selected = await open({ multiple: false });
      if (typeof selected === "string") {
        setKeyFilePath(selected);
        if (currentPlatform === "android" || currentPlatform === "ios") {
          try {
            const bytes = await readFile(selected);
            setKeyFileBytes(bytes);
          } catch (readErr) {
            console.error("Failed to read keyfile bytes:", readErr);
            setErrorMsg("Failed to load keyfile data.");
            setKeyFilePath(null);
          }
        } else {
          setKeyFileBytes(null);
        }
      }
    } catch (e) {
      setErrorMsg("Failed to select keyfile: " + String(e));
    }
  }

  function clearKeyFile() {
    if (keyFileBytes) {
      keyFileBytes.fill(0);
    }
    setKeyFilePath(null);
    setKeyFileBytes(null);
  }

  /** Asks the running job to stop. It ends at its next step and removes what it was writing. */
  async function cancel() {
    if (!running || cancelAsked.current) return;
    cancelAsked.current = true;
    setCancelling(true);
    try {
      await invoke("cancel_operation");
    } catch (e) {
      console.error("Could not cancel:", e);
      cancelAsked.current = false;
      setCancelling(false);
    }
  }

  function clearProgress(delay: number = 0) {
    if (delay > 0) {
      setTimeout(() => setProgress(null), delay);
    } else {
      setProgress(null);
    }
  }

  // FIX 1: Require currentPath so we reload exactly where we are
  async function runCrypto(
    cmd: "lock_file" | "unlock_file" | "relock_file",
    targets: string[],
    currentPath: string, // <--- NEW PARAMETER
    explicitEntropy?: number[],
    outputDir?: string,
  ): Promise<BatchResult[] | null> {
    if (targets.length === 0) {
      setErrorMsg("No files selected.");
      return null;
    }

    setProgress({ status: "Preparing...", percentage: 0 });
    cancelAsked.current = false;
    setCancelling(false);
    setRunning(true);

    try {
      let finalEntropy: number[] | null = null;

      if (cmd === "lock_file") {
        if (explicitEntropy) {
          finalEntropy = explicitEntropy.map((v) =>
            Math.max(0, Math.min(255, Math.floor(v))),
          );
        } else if (isParanoid) {
          const raw = generateBrowserEntropy();
          finalEntropy = raw.map((v) =>
            Math.max(0, Math.min(255, Math.floor(v))),
          );
        }
      }

      const keyFileArray = keyFileBytes ? Array.from(keyFileBytes) : null;

      const results = await invoke<BatchResult[]>(cmd, {
        filePaths: targets,
        keyfilePath: keyFilePath,
        keyfileBytes: keyFileArray,
        extraEntropy: finalEntropy,
        compressionMode: cmd === "lock_file" ? compressionMode : null,
        verifyAfter: cmd === "lock_file" ? verifyAfterLock : null,
        outputDir: cmd === "unlock_file" ? outputDir || null : null,
      });

      // FIX 1: Explicitly reload the exact path we were in
      await loadDir(currentPath);
      return results;
    } catch (e) {
      console.error(`Crypto Command Error (${cmd}):`, e);
      setErrorMsg(String(e));
      return null;
    } finally {
      setRunning(false);
      cancelAsked.current = false;
      setCancelling(false);
      clearProgress(500);
    }
  }

  return {
    keyFile: keyFilePath,
    setKeyFile: clearKeyFile,
    selectKeyFile,
    isParanoid,
    setIsParanoid,
    compressionMode,
    setCompressionMode,
    verifyAfterLock,
    setVerifyAfterLock,
    upgradeWhenUnlocking,
    setUpgradeWhenUnlocking,
    progress,
    canCancel: running,
    cancelling,
    cancel,
    errorMsg,
    setErrorMsg,
    clearProgress,
    runCrypto,
  };
}
