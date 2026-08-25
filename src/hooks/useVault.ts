import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutationQueue } from "./useMutationQueue";

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
  // Serializes saveEntry/deleteEntry/importEntries so concurrent calls can't
  // race and silently drop each other's change - see useMutationQueue.
  const queue = useMutationQueue<VaultEntry[]>([]);

  function commit(next: VaultEntry[]) {
    queue.sync(next);
    setEntries(next);
  }

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
      commit(
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

  function saveEntry(entry: VaultEntry) {
    return queue.run(async (current) => {
      try {
        const newEntries = [...current];
        const index = newEntries.findIndex((e) => e.id === entry.id);
        if (index >= 0) newEntries[index] = entry;
        else newEntries.unshift(entry);

        // CRITICAL FIX: Must pass vaultId (camelCase) to match Tauri's automatic conversion
        await invoke("save_password_vault", {
          vault: { entries: newEntries },
          vaultId: "local",
        });

        commit(newEntries);
      } catch (e) {
        console.error("🔥 RUST BACKEND ERROR (saveEntry):", e);
        setError("Failed to save: " + String(e));
        throw e;
      }
    });
  }

  // --- BULK IMPORT ---
  function importEntries(newItems: VaultEntry[]) {
    return queue.run(async (current) => {
      try {
        // Merge new items with existing ones (add to top)
        const combined = [...newItems, ...current];

        // CRITICAL FIX: Pass vaultId
        await invoke("save_password_vault", {
          vault: { entries: combined },
          vaultId: "local",
        });

        commit(combined);
        return true;
      } catch (e) {
        console.error("🔥 RUST BACKEND ERROR (importEntries):", e);
        setError("Import failed: " + String(e));
        return false;
      }
    });
  }

  function deleteEntry(id: string) {
    return queue.run(async (current) => {
      try {
        const newEntries = current.filter((e) => e.id !== id);

        // CRITICAL FIX: Pass vaultId
        await invoke("save_password_vault", {
          vault: { entries: newEntries },
          vaultId: "local",
        });

        commit(newEntries);
      } catch (e) {
        console.error("🔥 RUST BACKEND ERROR (deleteEntry):", e);
        setError("Failed to delete: " + String(e));
        throw e;
      }
    });
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
