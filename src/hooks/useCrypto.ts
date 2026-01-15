import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import { generateBrowserEntropy } from "../utils/security";

interface ProgressEvent {
  status: string;
  percentage: number;
}

export function useCrypto(reloadDir: () => void) {
  const [keyFilePath, setKeyFilePath] = useState<string | null>(null);
  const [keyFileBytes, setKeyFileBytes] = useState<Uint8Array | null>(null);
  const [isParanoid, setIsParanoid] = useState(false);
  const [compressionMode, setCompressionMode] = useState("normal");
  const [currentPlatform, setCurrentPlatform] = useState<string>("windows");

  const [progress, setProgress] = useState<{
    status: string;
    percentage: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Detect Platform on Mount
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

        // HYBRID LOGIC:
        // Only read file into memory if on Android/iOS (to handle Content URIs)
        // On Desktop, we avoid this to prevent freezing with large files
        if (currentPlatform === "android" || currentPlatform === "ios") {
          try {
            const bytes = await readFile(selected);
            setKeyFileBytes(bytes);
          } catch (readErr) {
            console.error("Failed to read keyfile bytes:", readErr);
            setErrorMsg("Failed to load keyfile data.");
            setKeyFilePath(null); // Revert
          }
        } else {
          // Desktop: Clear bytes to ensure we use the Path in backend
          setKeyFileBytes(null);
        }
      }
    } catch (e) {
      setErrorMsg("Failed to select keyfile: " + String(e));
    }
  }

  function clearKeyFile() {
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

  async function runCrypto(
    cmd: "lock_file" | "unlock_file",
    targets: string[],
    explicitEntropy?: number[]
  ) {
    if (targets.length === 0) {
      setErrorMsg("No files selected.");
      return;
    }

    setProgress({ status: "Preparing...", percentage: 0 });

    try {
      let finalEntropy: number[] | null = null;

      if (cmd === "lock_file") {
        if (explicitEntropy) {
          finalEntropy = explicitEntropy;
        } else if (isParanoid) {
          finalEntropy = generateBrowserEntropy(true);
        }
      }

      // Convert Uint8Array to regular Array for serialization
      const keyFileArray = keyFileBytes ? Array.from(keyFileBytes) : null;

      await invoke(cmd, {
        filePaths: targets,
        keyfilePath: keyFilePath, // Always send path (Rust decides if it uses it)
        keyfileBytes: keyFileArray, // Sent only on mobile
        extraEntropy: finalEntropy,
        compressionMode: cmd === "lock_file" ? compressionMode : null,
      });

      reloadDir();
    } catch (e) {
      setErrorMsg(String(e));
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
