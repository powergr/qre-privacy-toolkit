import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, stat, watch } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { FileEntry } from "../types";

export type SortField = "name" | "size" | "modified";
export type SortDirection = "asc" | "desc";

export function useFileSystem(view: string) {
  const [currentPath, setCurrentPath] = useState("");
  const [rawEntries, setRawEntries] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [pendingFile, setPendingFile] = useState<string | null>(null);

  // Track last clicked index for Shift+Click range selection
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number>(-1);

  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

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

  // --- SELECTION LOGIC (New) ---
  const handleSelection = (
    path: string,
    index: number,
    multi: boolean,
    range: boolean,
  ) => {
    if (range && lastSelectedIndex !== -1) {
      // Shift+Click: Select Range
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangePaths = entries.slice(start, end + 1).map((e) => e.path);

      // Merge with existing if Ctrl is also held, otherwise replace
      setSelectedPaths((prev) =>
        multi ? [...new Set([...prev, ...rangePaths])] : rangePaths,
      );
    } else if (multi) {
      // Ctrl+Click: Toggle
      setSelectedPaths((prev) =>
        prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
      );
      setLastSelectedIndex(index);
    } else {
      // Single Click
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

  // --- LOADING LOGIC (Same as before) ---
  const loadDir = useCallback(
    async (path: string, preserveSelection = false) => {
      if (path === null) return;
      try {
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
        const separator = navigator.userAgent.includes("Windows") ? "\\" : "/";
        const mapped = await Promise.all(
          contents.map(async (entry) => {
            const cleanPath = path.endsWith(separator)
              ? path
              : path + separator;
            const fullPath = `${cleanPath}${entry.name}`;
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

  // --- WATCHER & STARTUP (Same as before) ---
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
    startWatcher();
    return () => {
      isActive = false;
      if (unlistenFn) unlistenFn();
      if (debounceTimer) window.clearTimeout(debounceTimer);
    };
  }, [currentPath, loadDir]);

  useEffect(() => {
    invoke<string | null>("get_startup_file").then((file) => {
      if (file) setPendingFile(file);
    });
  }, []);

  useEffect(() => {
    if (view === "dashboard") {
      if (pendingFile) handleStartupNavigation(pendingFile);
      else loadInitialPath();
    }
  }, [view, pendingFile]);

  async function handleStartupNavigation(path: string) {
    const sep = navigator.userAgent.includes("Windows") ? "\\" : "/";
    const parts = path.split(sep);
    parts.pop();
    let parent = parts.join(sep);
    if (!navigator.userAgent.includes("Windows") && !parent.startsWith("/"))
      parent = "/" + parent;
    if (navigator.userAgent.includes("Windows") && parent.endsWith(":"))
      parent += sep;
    if (parent === "")
      parent = navigator.userAgent.includes("Windows") ? "" : "/";
    await loadDir(parent);
    setSelectedPaths([path]);
    setPendingFile(null);
  }

  async function loadInitialPath() {
    try {
      loadDir(await homeDir());
    } catch {
      loadDir("");
    }
  }

  function goUp() {
    if (currentPath === "") return;
    const isWindows = navigator.userAgent.includes("Windows");
    const separator = isWindows ? "\\" : "/";
    if (
      currentPath === "/" ||
      (isWindows && currentPath.length <= 3 && currentPath.includes(":"))
    ) {
      loadDir("");
      return;
    }
    const parts = currentPath.split(separator).filter((p) => p);
    parts.pop();
    let parent = parts.join(separator);
    if (!isWindows) parent = "/" + parent;
    if (isWindows && parent.length === 2 && parent.endsWith(":"))
      parent += separator;
    loadDir(parts.length === 0 ? (isWindows ? "" : "/") : parent);
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

    // New Actions
    selectAll,
    clearSelection,
    handleSelection,
  };
}
