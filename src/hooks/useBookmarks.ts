import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutationQueue } from "./useMutationQueue";

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
  // Serializes saveBookmark/deleteBookmark so concurrent calls can't race
  // and silently drop each other's change - see useMutationQueue.
  const queue = useMutationQueue<BookmarkEntry[]>([]);

  function commit(next: BookmarkEntry[]) {
    queue.sync(next);
    setEntries(next);
  }

  useEffect(() => {
    refreshVault();
  }, []);

  async function refreshVault(): Promise<void> {
    try {
      setLoading(true);
      setError(null);
      const vault = await invoke<BookmarksVault>("load_bookmarks_vault", {
        vaultId: "local",
      });

      const validEntries = vault.entries.filter((bookmark) => {
        // Sanity check: timestamps > year 2286 mean milliseconds were used
        if (bookmark.created_at > 9999999999) return false;
        return true;
      });

      commit(sortBookmarks(validEntries));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function saveBookmark(bookmark: BookmarkEntry): Promise<void> {
    return queue.run(async (current) => {
      try {
        setError(null);

        if (!bookmark.title.trim()) throw new Error("Title cannot be empty.");
        if (!bookmark.url.trim()) throw new Error("URL cannot be empty.");

        const normalizedUrl = normalizeUrl(bookmark.url);
        if (!isValidUrl(normalizedUrl)) throw new Error("Invalid URL format.");

        const urlLower = normalizedUrl.toLowerCase();
        const DANGEROUS_SCHEMES = ["javascript:", "data:", "file:", "vbscript:"];
        if (DANGEROUS_SCHEMES.some((s) => urlLower.startsWith(s))) {
          throw new Error(
            `Dangerous URL scheme detected. Allowed schemes: http, https, ftp.`,
          );
        }

        const sanitizedBookmark = {
          ...bookmark,
          url: normalizedUrl,
          title: bookmark.title.trim(),
          category: (bookmark.category || "General").trim(),
        };

        const newEntries = [...current];
        const index = newEntries.findIndex((e) => e.id === sanitizedBookmark.id);

        if (index >= 0) newEntries[index] = sanitizedBookmark;
        else newEntries.unshift(sanitizedBookmark);

        const sortedEntries = sortBookmarks(newEntries);
        await invoke("save_bookmarks_vault", {
          vault: { entries: sortedEntries },
          vaultId: "local",
        });
        commit(sortedEntries);
      } catch (e) {
        const msg = "Failed to save: " + String(e);
        setError(msg);
        throw new Error(msg);
      }
    });
  }

  function deleteBookmark(id: string): Promise<void> {
    return queue.run(async (current) => {
      try {
        setError(null);
        const newEntries = current.filter((e) => e.id !== id);
        await invoke("save_bookmarks_vault", {
          vault: { entries: newEntries },
          vaultId: "local",
        });
        commit(newEntries);
      } catch (e) {
        setError("Failed to delete: " + String(e));
      }
    });
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
