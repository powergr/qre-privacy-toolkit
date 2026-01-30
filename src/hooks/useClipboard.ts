import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export interface ClipboardEntry {
  id: string;
  content: string;
  preview: string;
  category: string;
  created_at: number;
}

export interface ClipboardVault {
  entries: ClipboardEntry[];
}

export function useClipboard() {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Default to 24 hours
  const [retentionHours, setRetentionHours] = useState<number>(() => {
    const saved = localStorage.getItem("qre_clip_retention");
    return saved ? parseInt(saved, 10) : 24;
  });

  useEffect(() => {
    refreshVault();
  }, [retentionHours]);

  function updateRetention(hours: number) {
    setRetentionHours(hours);
    localStorage.setItem("qre_clip_retention", hours.toString());
  }

  async function refreshVault() {
    try {
      setLoading(true);
      const vault = await invoke<ClipboardVault>("load_clipboard_vault", {
        retentionHours,
      });
      setEntries(vault.entries.sort((a, b) => b.created_at - a.created_at));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function securePaste() {
    try {
      const text = await readText();
      if (!text) throw new Error("Clipboard is empty");

      // Pass retentionHours to the ADD command too
      await invoke("add_clipboard_entry", { text, retentionHours });
      await writeText(""); // Clear system clipboard immediately for security
      await refreshVault();
    } catch (e) {
      setError("Failed to paste: " + String(e));
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await writeText(text);
    } catch (e) {
      console.error(e);
    }
  }

  async function clearAll() {
    try {
      await invoke("save_clipboard_vault", { vault: { entries: [] } });
      setEntries([]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteEntry(id: string) {
    try {
      const newEntries = entries.filter((e) => e.id !== id);
      await invoke("save_clipboard_vault", { vault: { entries: newEntries } });
      setEntries(newEntries);
    } catch (e) {
      setError("Failed to delete entry: " + String(e));
    }
  }

  return {
    entries,
    loading,
    error,
    securePaste,
    copyToClipboard,
    clearAll,
    deleteEntry,
    retentionHours,
    updateRetention,
  };
}
