import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DriveInfo } from "../types";

// --- EXPORTED TYPES REQUIRED BY UI ---
export type KdfTier = "Standard" | "High" | "Paranoid";

export interface PortableDriveState {
  drive: DriveInfo;
  isLocked: boolean;
  isUnlocked: boolean;
}

export function usePortableVault() {
  const [drives, setDrives] = useState<PortableDriveState[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // We use a ref to prevent spamming the backend if a scan is already running
  // Exported as state so the UI can show a spinner
  const [isScanning, setIsScanning] = useState(false);
  const scanRef = useRef(false);

  const scanDrives = useCallback(async () => {
    if (scanRef.current) return;

    try {
      scanRef.current = true;
      setIsScanning(true);
      setLoading(true);
      setError(null);

      const fetchedDrives = await invoke<DriveInfo[]>(
        "enumerate_removable_drives",
      );

      setDrives((prev) => {
        return fetchedDrives.map((d) => {
          const existing = prev.find((p) => p.drive.path === d.path);

          if (existing) {
            return {
              ...existing,
              drive: d,
            };
          }

          return {
            drive: d,
            isLocked: true,
            isUnlocked: false,
          };
        });
      });
    } catch (e) {
      console.error(e);
      setError(String(e));
    } finally {
      scanRef.current = false;
      setIsScanning(false);
      setLoading(false);
    }
  }, []);

  async function initVault(drivePath: string, password: string, tier: KdfTier) {
    try {
      setLoading(true);
      setError(null);

      const [recoveryCode, vaultId] = await invoke<[string, string]>(
        "init_portable_vault",
        {
          drivePath,
          password,
          tier,
        },
      );

      // FIX 1: Immediately unlock it using the newly created password.
      // This forces the backend to register the key in RAM and inject the path into `fs:scope`.
      await invoke("unlock_portable_vault", { drivePath, password });

      // Refresh drives list
      await scanDrives();

      // Return structured object expected by App.tsx
      return { success: true, recoveryCode, vaultId };
    } catch (e) {
      setError(String(e));
      return { success: false, msg: String(e) };
    } finally {
      setLoading(false);
    }
  }

  async function unlockVault(drivePath: string, password: string) {
    try {
      setLoading(true);
      setError(null);

      await invoke<string>("unlock_portable_vault", {
        drivePath,
        password,
      });

      setDrives((prev) =>
        prev.map((state) =>
          state.drive.path === drivePath
            ? { ...state, isLocked: false, isUnlocked: true }
            : state,
        ),
      );

      return { success: true };
    } catch (e) {
      setError(String(e));
      return { success: false, msg: String(e) };
    } finally {
      setLoading(false);
    }
  }

  async function lockVault(drivePath: string) {
    try {
      setLoading(true);
      setError(null);

      const targetState = drives.find((s) => s.drive.path === drivePath);
      if (!targetState || !targetState.drive.vault_uuid) {
        throw new Error("Cannot lock: Vault UUID not found in state.");
      }

      await invoke("lock_portable_vault", {
        vaultId: targetState.drive.vault_uuid,
      });

      setDrives((prev) =>
        prev.map((state) =>
          state.drive.path === drivePath
            ? { ...state, isLocked: true, isUnlocked: false }
            : state,
        ),
      );
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }

  return {
    drives,
    loading,
    error,
    isScanning,
    scanDrives,
    initVault,
    unlockVault,
    lockVault,
  };
}
