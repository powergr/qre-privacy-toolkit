import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface NoteEntry {
  id: string;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
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
      const vault = await invoke<NotesVault>("load_notes_vault");
      // Sort by recently updated
      setEntries(vault.entries.sort((a, b) => b.updated_at - a.updated_at));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function saveNote(note: NoteEntry) {
    try {
      const newEntries = [...entries];
      const index = newEntries.findIndex((e) => e.id === note.id);

      if (index >= 0) {
        newEntries[index] = note;
      } else {
        newEntries.unshift(note);
      }

      await invoke("save_notes_vault", { vault: { entries: newEntries } });
      setEntries(newEntries);
    } catch (e) {
      setError("Failed to save note: " + String(e));
    }
  }

  async function deleteNote(id: string) {
    try {
      const newEntries = entries.filter((e) => e.id !== id);
      await invoke("save_notes_vault", { vault: { entries: newEntries } });
      setEntries(newEntries);
    } catch (e) {
      setError("Failed to delete note: " + String(e));
    }
  }

  return { entries, loading, error, saveNote, deleteNote, refreshVault };
}
