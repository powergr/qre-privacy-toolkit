import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readDir, stat, watch } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { FileEntry } from "../types";

export function useFileSystem(view: string) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [pendingFile, setPendingFile] = useState<string | null>(null);

  // Ref to ensure the watcher callback always uses the latest path state
  const currentPathRef = useRef(currentPath);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  // --- CORE LOAD FUNCTION ---
  const loadDir = useCallback(
    async (path: string, preserveSelection = false) => {
      if (!path) return;

      try {
        if (path === "") {
          const drives = await invoke<string[]>("get_drives");
          setEntries(
            drives.map((d) => ({
              name: d,
              isDirectory: true,
              path: d,
              isDrive: true,
              size: null,
              modified: null,
            }))
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
          })
        );

        mapped.sort((a, b) =>
          a.isDirectory === b.isDirectory
            ? a.name.localeCompare(b.name)
            : a.isDirectory
            ? -1
            : 1
        );
        setEntries(mapped);
        setCurrentPath(path);

        if (!preserveSelection) {
          setSelectedPaths([]);
          setStatusMsg(`Loaded: ${path}`);
        } else {
          const newPathSet = new Set(mapped.map((e) => e.path));
          setSelectedPaths((prev) => prev.filter((p) => newPathSet.has(p)));
        }
      } catch (e) {
        if (!preserveSelection) setStatusMsg(`Error: ${e}`);
      }
    },
    []
  );

  // --- NATIVE FILE WATCHER ---
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let debounceTimer: number | null = null;
    let isActive = true;

    async function startWatcher() {
      // Don't watch the "Drives" view
      if (!currentPath || currentPath === "") return;

      try {
        const unlisten = await watch(
          currentPath,
          () => {
            // Check if we are still active before processing
            if (!isActive) return;

            // Debounce: Wait 200ms to group multiple file changes into one reload
            if (debounceTimer) window.clearTimeout(debounceTimer);

            debounceTimer = window.setTimeout(() => {
              if (isActive && currentPathRef.current === currentPath) {
                loadDir(currentPath, true);
              }
            }, 200);
          },
          { recursive: false }
        );

        if (isActive) {
          unlistenFn = unlisten;
        } else {
          unlisten(); // Cleanup if effect unmounted during await
        }
      } catch (e) {
        // Silently fail if watcher is not supported (e.g. some network drives)
        // User can still manually refresh.
      }
    }

    startWatcher();

    return () => {
      isActive = false;
      if (unlistenFn) unlistenFn();
      if (debounceTimer) window.clearTimeout(debounceTimer);
    };
  }, [currentPath, loadDir]);

  // --- STARTUP LOGIC ---
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
    setStatusMsg(`Opened: ${path}`);
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
      loadDir(isWindows ? "" : "/");
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
  };
}
