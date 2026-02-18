import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface NoteEntry {
  id: string;
  title: string;
  content: string;
  created_at: number; // Seconds
  updated_at: number; // Seconds
  is_pinned?: boolean;
}

export interface NotesVault {
  entries: NoteEntry[];
}

export function useNotes() {
  const [entries, setEntries] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshVault();
  }, []);

  async function refreshVault() {
    try {
      setLoading(true);
      setError(null);
      const vault = await invoke<NotesVault>("load_notes_vault");

      // Validate timestamps (Must be seconds, not milliseconds)
      const validEntries = vault.entries.filter((note) => {
        if (note.updated_at > 9999999999) {
          console.warn("Detected invalid timestamp (ms?), skipping:", note.id);
          return false;
        }
        return true;
      });

      setEntries(validEntries.sort((a, b) => b.updated_at - a.updated_at));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function saveNote(note: NoteEntry): Promise<void> {
    try {
      setError(null);
      if (!note.title?.trim()) throw new Error("Title cannot be empty");

      const newEntries = [...entries];
      const index = newEntries.findIndex((e) => e.id === note.id);

      if (index >= 0) newEntries[index] = note;
      else newEntries.unshift(note);

      await invoke("save_notes_vault", { vault: { entries: newEntries } });
      setEntries(newEntries);
    } catch (e) {
      const msg = "Failed to save note: " + String(e);
      setError(msg);
      throw new Error(msg); // Re-throw for UI handling
    }
  }

  async function deleteNote(id: string): Promise<void> {
    try {
      const newEntries = entries.filter((e) => e.id !== id);
      await invoke("save_notes_vault", { vault: { entries: newEntries } });
      setEntries(newEntries);
    } catch (e) {
      throw new Error("Failed to delete: " + String(e));
    }
  }

  return { entries, loading, error, saveNote, deleteNote, refreshVault };
}
