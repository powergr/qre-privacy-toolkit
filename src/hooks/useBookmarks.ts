import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface BookmarkEntry {
  id: string;
  title: string;
  url: string;
  category: string;
  created_at: number; // Unix Seconds
  is_pinned?: boolean;
  color?: string;
}

export interface BookmarksVault {
  entries: BookmarkEntry[];
}

function isValidUrl(urlString: string): boolean {
  try {
    new URL(urlString);
    return true;
  } catch {
    try {
      new URL("https://" + urlString);
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/)) return trimmed;
  return "https://" + trimmed;
}

function sortBookmarks(bookmarks: BookmarkEntry[]): BookmarkEntry[] {
  return [...bookmarks].sort((a, b) => {
    const aPin = a.is_pinned || false;
    const bPin = b.is_pinned || false;
    if (aPin && !bPin) return -1;
    if (!aPin && bPin) return 1;
    return b.created_at - a.created_at;
  });
}

export function useBookmarks() {
  const [entries, setEntries] = useState<BookmarkEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshVault();
  }, []);

  async function refreshVault(): Promise<void> {
    try {
      setLoading(true);
      setError(null);
      const vault = await invoke<BookmarksVault>("load_bookmarks_vault");

      const validEntries = vault.entries.filter((bookmark) => {
        // Sanity check: timestamps > year 2286 mean milliseconds were used
        if (bookmark.created_at > 9999999999) return false;
        return true;
      });

      setEntries(sortBookmarks(validEntries));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function saveBookmark(bookmark: BookmarkEntry): Promise<void> {
    try {
      setError(null);

      if (!bookmark.title.trim()) throw new Error("Title cannot be empty.");
      if (!bookmark.url.trim()) throw new Error("URL cannot be empty.");

      const normalizedUrl = normalizeUrl(bookmark.url);
      if (!isValidUrl(normalizedUrl)) throw new Error("Invalid URL format.");

      const urlLower = normalizedUrl.toLowerCase();
      if (urlLower.startsWith("javascript:") || urlLower.startsWith("data:")) {
        throw new Error("Dangerous URL scheme detected.");
      }

      const sanitizedBookmark = {
        ...bookmark,
        url: normalizedUrl,
        title: bookmark.title.trim(),
        category: (bookmark.category || "General").trim(),
      };

      const newEntries = [...entries];
      const index = newEntries.findIndex((e) => e.id === sanitizedBookmark.id);

      if (index >= 0) newEntries[index] = sanitizedBookmark;
      else newEntries.unshift(sanitizedBookmark);

      const sortedEntries = sortBookmarks(newEntries);
      await invoke("save_bookmarks_vault", {
        vault: { entries: sortedEntries },
      });
      setEntries(sortedEntries);
    } catch (e) {
      const msg = "Failed to save: " + String(e);
      setError(msg);
      throw new Error(msg);
    }
  }

  async function deleteBookmark(id: string): Promise<void> {
    try {
      setError(null);
      const newEntries = entries.filter((e) => e.id !== id);
      await invoke("save_bookmarks_vault", { vault: { entries: newEntries } });
      setEntries(newEntries);
    } catch (e) {
      setError("Failed to delete: " + String(e));
    }
  }

  return {
    entries,
    loading,
    error,
    saveBookmark,
    deleteBookmark,
    refreshVault,
  };
}
