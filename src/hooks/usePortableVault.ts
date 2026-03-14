// src/hooks/usePortableVault.ts
//
// Manages the lifecycle of portable USB vaults:
//   scanDrives()        → enumerate_removable_drives (explicit user action only)
//   initVault()         → init_portable_vault
//   unlockVault()       → unlock_portable_vault
//   lockVault()         → lock_portable_vault
//
// SECURITY: Drive scanning is NEVER triggered automatically on mount or on a
// polling interval. It fires only when the user navigates to the Portable
// Drives section or presses Refresh. Passive auto-detection leaks to any
// process watching the Tauri IPC bridge that a portable vault is present (S-09).

import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DriveInfo } from "../types";

export type KdfTier = "Standard" | "High" | "Paranoid";

type ActionResult = { success: boolean; msg?: string };

export interface PortableDriveState {
  drive: DriveInfo;
  /** vault_id (UUID) returned by the backend on successful unlock */
  vaultId: string | null;
  isUnlocked: boolean;
}

export function usePortableVault() {
  const [drives, setDrives] = useState<PortableDriveState[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  // ── Scan ────────────────────────────────────────────────────────────────────
  const scanDrives = useCallback(async () => {
    setIsScanning(true);
    try {
      const found = await invoke<DriveInfo[]>("enumerate_removable_drives");
      setDrives((prev) => {
        // Merge new scan results with existing unlock state so that an already-
        // unlocked vault doesn't lose its vaultId just because the user re-scanned.
        return found.map((d) => {
          const existing = prev.find((p) => p.drive.path === d.drive_path);
          return {
            drive: d,
            vaultId: existing?.vaultId ?? null,
            isUnlocked: existing?.isUnlocked ?? false,
          };
        });
      });
    } catch (e) {
      console.error("Drive scan failed:", e);
    } finally {
      setIsScanning(false);
    }
  }, []);

  // ── Init ────────────────────────────────────────────────────────────────────
  const initVault = useCallback(
    async (
      drivePath: string,
      password: string,
      tier: KdfTier,
    ): Promise<ActionResult & { recoveryCode?: string; vaultId?: string }> => {
      try {
        const [recoveryCode, vaultId] = await invoke<[string, string]>(
          "init_portable_vault",
          { drivePath, password, tier },
        );
        // Refresh the drive list so the newly formatted drive shows is_qre_portable=true
        await scanDrives();
        return { success: true, recoveryCode, vaultId };
      } catch (e) {
        return { success: false, msg: String(e) };
      }
    },
    [scanDrives],
  );

  // ── Unlock ──────────────────────────────────────────────────────────────────
  const unlockVault = useCallback(
    async (drivePath: string, password: string): Promise<ActionResult> => {
      try {
        const vaultId = await invoke<string>("unlock_portable_vault", {
          drivePath,
          password,
        });
        setDrives((prev) =>
          prev.map((d) =>
            d.drive.path === drivePath
              ? { ...d, vaultId, isUnlocked: true }
              : d,
          ),
        );
        return { success: true };
      } catch (e) {
        return { success: false, msg: String(e) };
      }
    },
    [],
  );

  // ── Lock ────────────────────────────────────────────────────────────────────
  const lockVault = useCallback(
    async (drivePath: string): Promise<ActionResult> => {
      const entry = drives.find((d) => d.drive.path === drivePath);
      if (!entry?.vaultId) return { success: false, msg: "Vault not found" };

      try {
        await invoke("lock_portable_vault", { vaultId: entry.vaultId });
        setDrives((prev) =>
          prev.map((d) =>
            d.drive.path === drivePath
              ? { ...d, vaultId: null, isUnlocked: false }
              : d,
          ),
        );
        return { success: true };
      } catch (e) {
        return { success: false, msg: String(e) };
      }
    },
    [drives],
  );

  // ── Helpers ──────────────────────────────────────────────────────────────────
  /** Returns true if any portable vault is currently unlocked. */
  const hasUnlockedVault = drives.some((d) => d.isUnlocked);

  /** Returns the vault entry for a given drive path, if unlocked. */
  const getUnlockedVault = useCallback(
    (drivePath: string) =>
      drives.find((d) => d.drive.path === drivePath && d.isUnlocked) ?? null,
    [drives],
  );

  return {
    drives,
    isScanning,
    scanDrives,
    initVault,
    unlockVault,
    lockVault,
    hasUnlockedVault,
    getUnlockedVault,
  };
}
