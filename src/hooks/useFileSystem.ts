import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, stat, watch } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { platform } from "@tauri-apps/plugin-os";
import { FileEntry } from "../types";

export type SortField = "name" | "size" | "modified";
export type SortDirection = "asc" | "desc";

// --- SECURITY BLACKLIST ---
const BLOCKED_PATHS = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/etc",
  "/var",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
];

const isDangerousPath = (path: string) => {
  if (!path) return false;
  const normalized = path.replace(/\//g, "\\");
  return BLOCKED_PATHS.some(
    (blocked) =>
      path.toLowerCase().startsWith(blocked.toLowerCase()) ||
      normalized.toLowerCase().startsWith(blocked.toLowerCase()),
  );
};

export function useFileSystem(view: string) {
  const [currentPath, setCurrentPath] = useState("");
  const [rawEntries, setRawEntries] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number>(-1);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  // NEW: Access Denied State for Modal
  const [accessDenied, setAccessDenied] = useState<string | null>(null);

  const currentPathRef = useRef(currentPath);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  // --- SORTING ---
  const entries = useMemo(() => {
    const sorted = [...rawEntries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (a.isDrive !== b.isDrive) return a.isDrive ? -1 : 1;

      let valA: any = a[sortField];
      let valB: any = b[sortField];

      if (valA === null) return 1;
      if (valB === null) return -1;

      if (sortField === "name") {
        return sortDirection === "asc"
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      }
      if (valA < valB) return sortDirection === "asc" ? -1 : 1;
      if (valA > valB) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [rawEntries, sortField, sortDirection]);

  // --- SELECTION LOGIC ---
  const handleSelection = (
    path: string,
    index: number,
    multi: boolean,
    range: boolean,
  ) => {
    if (range && lastSelectedIndex !== -1) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangePaths = entries.slice(start, end + 1).map((e) => e.path);
      setSelectedPaths((prev) =>
        multi ? [...new Set([...prev, ...rangePaths])] : rangePaths,
      );
    } else if (multi) {
      setSelectedPaths((prev) =>
        prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
      );
      setLastSelectedIndex(index);
    } else {
      setSelectedPaths([path]);
      setLastSelectedIndex(index);
    }
  };

  const selectAll = useCallback(() => {
    setSelectedPaths(entries.map((e) => e.path));
  }, [entries]);

  const clearSelection = useCallback(() => {
    setSelectedPaths([]);
    setLastSelectedIndex(-1);
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const selectionSize = useMemo(() => {
    return rawEntries
      .filter((e) => selectedPaths.includes(e.path) && e.size !== null)
      .reduce((acc, e) => acc + (e.size || 0), 0);
  }, [rawEntries, selectedPaths]);

  // --- LOADING LOGIC ---
  const loadDir = useCallback(
    async (path: string, preserveSelection = false) => {
      if (path === null || path === undefined) return;

      // SECURITY CHECK
      if (isDangerousPath(path)) {
        setAccessDenied(path);
        return;
      }

      try {
        // Handle Root/Drives
        if (path === "") {
          const drives = await invoke<string[]>("get_drives");
          setRawEntries(
            drives.map((d) => ({
              name: d,
              isDirectory: true,
              path: d,
              isDrive: true,
              size: null,
              modified: null,
            })),
          );
          setCurrentPath("");
          if (!preserveSelection) setSelectedPaths([]);
          setStatusMsg("Select a Drive");
          return;
        }

        const contents = await readDir(path);
        const isWin = platform() === "windows" || path.includes("\\");
        const separator = isWin ? "\\" : "/";

        const mapped = await Promise.all(
          contents.map(async (entry) => {
            let fullPath = path;
            if (!fullPath.endsWith(separator)) {
              fullPath += separator;
            }
            fullPath += entry.name;

            let size = null,
              modified = null;
            try {
              const m = await stat(fullPath);
              size = m.size;
              if (m.mtime) modified = new Date(m.mtime);
            } catch {}
            return {
              name: entry.name,
              isDirectory: entry.isDirectory,
              path: fullPath,
              size,
              modified,
            };
          }),
        );

        setRawEntries(mapped);
        setCurrentPath(path);

        if (!preserveSelection) {
          setSelectedPaths([]);
          setLastSelectedIndex(-1);
          setStatusMsg(`Loaded`);
        } else {
          const newPathSet = new Set(mapped.map((e) => e.path));
          setSelectedPaths((prev) => prev.filter((p) => newPathSet.has(p)));
        }
      } catch (e) {
        if (!preserveSelection) setStatusMsg(`Error: ${e}`);
      }
    },
    [],
  );

  // --- WATCHER ---
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let debounceTimer: number | null = null;
    let isActive = true;
    async function startWatcher() {
      if (!currentPath || currentPath === "") return;
      try {
        const unlisten = await watch(
          currentPath,
          () => {
            if (!isActive) return;
            if (debounceTimer) window.clearTimeout(debounceTimer);
            debounceTimer = window.setTimeout(() => {
              if (isActive && currentPathRef.current === currentPath)
                loadDir(currentPath, true);
            }, 200);
          },
          { recursive: false },
        );
        if (isActive) unlistenFn = unlisten;
        else unlisten();
      } catch (e) {}
    }

    if (platform() !== "android") {
      startWatcher();
    }

    return () => {
      isActive = false;
      if (unlistenFn) unlistenFn();
      if (debounceTimer) window.clearTimeout(debounceTimer);
    };
  }, [currentPath, loadDir]);

  // --- STARTUP ---
  useEffect(() => {
    if (view === "dashboard") {
      loadInitialPath();
    }
  }, [view]);

  async function loadInitialPath() {
    try {
      if (platform() === "android") {
        loadDir("/storage/emulated/0");
      } else {
        loadDir(await homeDir());
      }
    } catch (e) {
      console.error("Home dir failed", e);
      loadDir("");
    }
  }

  function goUp() {
    if (currentPath === "") return;

    const isWin = platform() === "windows" || currentPath.includes("\\");
    const separator = isWin ? "\\" : "/";

    if (isWin && currentPath.length <= 3 && currentPath.includes(":")) {
      loadDir("");
      return;
    }
    if (currentPath === "/" || currentPath === "/storage/emulated/0") {
      if (platform() === "android") return;
      loadDir("");
      return;
    }

    const parts = currentPath.split(separator).filter((p) => p);
    parts.pop();
    let parent = parts.join(separator);

    if (!isWin) parent = "/" + parent;
    if (isWin && parent.length === 2 && parent.endsWith(":"))
      parent += separator;

    loadDir(parts.length === 0 ? (isWin ? "" : "/") : parent);
  }

  return {
    currentPath,
    entries,
    selectedPaths,
    setSelectedPaths,
    statusMsg,
    setStatusMsg,
    loadDir,
    goUp,
    sortField,
    sortDirection,
    handleSort,
    selectionSize,
    selectAll,
    clearSelection,
    handleSelection,
    accessDenied, // Exported for UI
    setAccessDenied, // Exported for UI
  };
}
