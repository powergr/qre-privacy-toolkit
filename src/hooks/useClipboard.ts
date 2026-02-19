import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export interface ClipboardEntry {
  id: string;
  content: string;
  preview: string;
  category: string;
  created_at: number;
  is_pinned?: boolean; // <--- Added
}

export interface ClipboardVault {
  entries: ClipboardEntry[];
}

const CLIPBOARD_CLEAR_DELAY_MS = 30_000;
const RETENTION_STORAGE_KEY = "qre_clip_retention_v1";

export function useClipboard() {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [retentionHours, setRetentionHours] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(RETENTION_STORAGE_KEY);
      return saved ? parseInt(saved, 10) || 24 : 24;
    } catch {
      return 24;
    }
  });

  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    refreshVault();
    return () => {
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    };
  }, [retentionHours]);

  function updateRetention(hours: number) {
    setRetentionHours(hours);
    try {
      localStorage.setItem(RETENTION_STORAGE_KEY, hours.toString());
    } catch {}
  }

  async function refreshVault() {
    try {
      setLoading(true);
      const vault = await invoke<ClipboardVault>("load_clipboard_vault", {
        retentionHours,
      });

      // Sort: Pinned first, then Newest first
      const sorted = vault.entries.sort((a, b) => {
        if (a.is_pinned && !b.is_pinned) return -1;
        if (!a.is_pinned && b.is_pinned) return 1;
        return b.created_at - a.created_at;
      });

      setEntries(sorted);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // --- ACTIONS ---

  async function securePaste() {
    try {
      const text = await readText();
      if (!text || !text.trim()) throw new Error("Clipboard is empty.");
      if (text.length > 1_000_000) throw new Error("Content too large (>1MB).");

      await invoke("add_clipboard_entry", { text, retentionHours });
      await writeText(""); // Wipe system clipboard
      await refreshVault();
    } catch (e) {
      setError("Paste failed: " + e);
      throw e;
    }
  }

  async function togglePin(entry: ClipboardEntry) {
    try {
      // Toggle logic
      const newEntries = entries.map((e) =>
        e.id === entry.id ? { ...e, is_pinned: !e.is_pinned } : e,
      );

      // Re-sort
      newEntries.sort((a, b) => {
        if (a.is_pinned && !b.is_pinned) return -1;
        if (!a.is_pinned && b.is_pinned) return 1;
        return b.created_at - a.created_at;
      });

      await invoke("save_clipboard_vault", { vault: { entries: newEntries } });
      setEntries(newEntries);
    } catch (e) {
      setError("Failed to pin: " + e);
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await writeText(text);
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = setTimeout(async () => {
        try {
          await writeText("");
        } catch {}
      }, CLIPBOARD_CLEAR_DELAY_MS);
    } catch (e) {
      setError("Copy failed: " + e);
    }
  }

  async function clearAll() {
    try {
      await invoke("save_clipboard_vault", { vault: { entries: [] } });
      setEntries([]);
    } catch (e) {
      setError("Clear failed: " + e);
    }
  }

  async function deleteEntry(id: string) {
    try {
      const newEntries = entries.filter((e) => e.id !== id);
      await invoke("save_clipboard_vault", { vault: { entries: newEntries } });
      setEntries(newEntries);
    } catch (e) {
      setError("Delete failed: " + e);
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
    togglePin, // Added togglePin
    retentionHours,
    updateRetention,
  };
}
