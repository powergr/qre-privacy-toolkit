import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface VaultEntry {
  id: string;
  service: string;
  username: string;
  password: string;
  url?: string;
  notes: string;
  color?: string;
  is_pinned?: boolean;
  created_at: number;
  updated_at: number;
  totp_secret?: string;
}

export interface PasswordVault {
  entries: VaultEntry[];
}

export function useVault() {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load on mount
  useEffect(() => {
    refreshVault();
  }, []);

  async function refreshVault() {
    try {
      setLoading(true);
      // Tauri converts the Rust parameter `vault_id` to `vaultId`
      const vault = await invoke<PasswordVault>("load_password_vault", {
        vaultId: "local",
      });
      // Sort: Pinned first, then alphabetically
      setEntries(
        vault.entries.sort((a, b) => {
          if (a.is_pinned && !b.is_pinned) return -1;
          if (!a.is_pinned && b.is_pinned) return 1;
          return a.service.localeCompare(b.service);
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function saveEntry(entry: VaultEntry) {
    try {
      const newEntries = [...entries];
      const index = newEntries.findIndex((e) => e.id === entry.id);
      if (index >= 0) newEntries[index] = entry;
      else newEntries.unshift(entry);

      // CRITICAL FIX: Must pass vaultId (camelCase) to match Tauri's automatic conversion
      await invoke("save_password_vault", {
        vault: { entries: newEntries },
        vaultId: "local",
      });

      setEntries(newEntries);
    } catch (e) {
      console.error("🔥 RUST BACKEND ERROR (saveEntry):", e);
      setError("Failed to save: " + String(e));
      throw e;
    }
  }

  // --- BULK IMPORT ---
  async function importEntries(newItems: VaultEntry[]) {
    try {
      // Merge new items with existing ones (add to top)
      const combined = [...newItems, ...entries];

      // CRITICAL FIX: Pass vaultId
      await invoke("save_password_vault", {
        vault: { entries: combined },
        vaultId: "local",
      });

      setEntries(combined);
      return true;
    } catch (e) {
      console.error("🔥 RUST BACKEND ERROR (importEntries):", e);
      setError("Import failed: " + String(e));
      return false;
    }
  }

  async function deleteEntry(id: string) {
    try {
      const newEntries = entries.filter((e) => e.id !== id);

      // CRITICAL FIX: Pass vaultId
      await invoke("save_password_vault", {
        vault: { entries: newEntries },
        vaultId: "local",
      });

      setEntries(newEntries);
    } catch (e) {
      console.error("🔥 RUST BACKEND ERROR (deleteEntry):", e);
      setError("Failed to delete: " + String(e));
      throw e;
    }
  }

  return {
    entries,
    loading,
    error,
    saveEntry,
    deleteEntry,
    refreshVault,
    importEntries,
  };
}
