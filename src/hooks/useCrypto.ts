import { useState, useEffect } from "react";
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

// FIX 1: Pass the raw loadDir function instead of a captured closure
export function useCrypto(loadDir: (path: string) => Promise<void>) {
  const [keyFilePath, setKeyFilePath] = useState<string | null>(null);
  const [keyFileBytes, setKeyFileBytes] = useState<Uint8Array | null>(null);
  const [isParanoid, setIsParanoid] = useState(false);
  const [compressionMode, setCompressionMode] = useState("auto");
  const [currentPlatform, setCurrentPlatform] = useState<string>("windows");

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

  function clearProgress(delay: number = 0) {
    if (delay > 0) {
      setTimeout(() => setProgress(null), delay);
    } else {
      setProgress(null);
    }
  }

  // FIX 1: Require currentPath so we reload exactly where we are
  async function runCrypto(
    cmd: "lock_file" | "unlock_file",
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
    progress,
    errorMsg,
    setErrorMsg,
    clearProgress,
    runCrypto,
  };
}
