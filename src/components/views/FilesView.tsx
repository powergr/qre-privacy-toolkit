// --- START OF FILE src/components/views/FilesView.tsx ---

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { platform } from "@tauri-apps/plugin-os";
import {
  join,
  downloadDir,
  desktopDir,
  documentDir,
} from "@tauri-apps/api/path";
import {
  UploadCloud,
  ShieldAlert,
  FolderOpen,
  AlertTriangle,
  RefreshCw,
  X,
} from "lucide-react";
import { formatSize } from "../../utils/formatting";

// Hooks
import { useFileSystem } from "../../hooks/useFileSystem";
import { useCrypto } from "../../hooks/useCrypto";
import { useDragDrop } from "../../hooks/useDragDrop";
import type { PortableDriveState } from "../../hooks/usePortableVault";

// Components
import { Toolbar } from "../dashboard/Toolbar";
import { AddressBar } from "../dashboard/AddressBar";
import { FileGrid } from "../dashboard/FileGrid";
import { PlacesRail } from "../dashboard/PlacesRail";
import { DetailsPanel } from "../dashboard/DetailsPanel";
import { SelectionBar } from "../dashboard/SelectionBar";
import { ContextMenu } from "../dashboard/ContextMenu";
import { InputModal } from "../modals/InputModal";
import { EntropyModal } from "../modals/EntropyModal";
import {
  DeleteConfirmModal,
  CompressionModal,
  ProcessingModal,
  ErrorModal,
  TimeLockModal,
} from "../modals/AppModals";
import { UpgradeFormatModal } from "../modals/UpgradeFormatModal";
import { useToast } from "../ui";
import { cancelNotice, isCancelledResult, summarizeCancel } from "../../utils/cancelled";

import { BatchResult, ClipboardFiles, FileEntry } from "../../types";

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface FilesViewProps {
  onShowBackupReminder: () => void;
  portable: {
    drives: PortableDriveState[];
    isScanning: boolean;
    scanDrives: () => void;
    lockVault: (p: string) => void;
  };
  onInitDrive: (path: string) => void;
  onUnlockDrive: (path: string) => void;
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export function FilesView(props: FilesViewProps) {
  const fs = useFileSystem("dashboard");
  const crypto = useCrypto(fs.loadDir);
  const toast = useToast();

  // A known upstream Tauri bug (tauri-apps/tauri#11705, #11708): a path containing an
  // unmatched bracket - picked via any file/folder dialog anywhere in the app, or dropped
  // onto the window - permanently corrupts the fs plugin's in-memory scope for the rest of
  // the session. Every subsequent read_dir/stat call then fails with this exact error,
  // regardless of which folder is being browsed. There's no way to guard against it from
  // here (the corruption happens inside Tauri's own dialog-plugin/drag-drop handling before
  // our code ever runs), so the only real recovery is restarting the app process, which
  // clears the corrupted in-memory scope.
  const scopeCorrupted = fs.statusMsg.includes("invalid glob pattern");
  // Tracked separately from statusMsg (rather than clearing it on dismiss): the underlying
  // corruption doesn't go away just because the modal was closed - every retry will fail
  // identically until a real restart happens - so we still want to show a lightweight
  // reminder instead of a blank "0 items" list that looks like nothing's wrong.
  const [scopeCorruptionDismissed, setScopeCorruptionDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);
  useEffect(() => {
    try {
      if (platform() === "android") setIsAndroid(true);
    } catch {
      /* ignore */
    }
  }, []);

  // `@tauri-apps/plugin-process`'s relaunch() ultimately calls Tauri's `process::restart()`,
  // which re-spawns the app by running `Command::new(current_binary_path).spawn()` - a
  // desktop-only re-exec pattern with no Android equivalent (there is no standalone
  // executable to re-launch inside Android's app sandbox; apps are started via Activity
  // intents, not `exec()`). On Android this ends up just killing the current process with
  // nothing bringing it back, which is why the app appeared to "minimize" instead of
  // restarting. So on Android we don't call relaunch() at all - we tell the user how to
  // actually force a fresh process (which genuinely does clear the corrupted scope, since
  // this app doesn't persist scope state to disk).
  async function restartApp() {
    if (isAndroid) return;
    setRestarting(true);
    try {
      await relaunch();
    } catch {
      setRestarting(false);
    }
  }

  // ── Existing state ──────────────────────────────────────────────────────────
  const [showCompression, setShowCompression] = useState(false);
  const [showEntropyModal, setShowEntropyModal] = useState(false);
  const [pendingLockTargets, setPendingLockTargets] = useState<string[] | null>(
    null,
  );
  const [showGhostWarning, setShowGhostWarning] = useState(false);
  const [showExtractModal, setShowExtractModal] = useState(false);
  const [pendingUnlockTargets, setPendingUnlockTargets] = useState<
    string[] | null
  >(null);
  // What Copy and Cut put aside. `viaOs` is true when the same list also reached the system
  // clipboard, so Explorer can paste it. If it did not (Android, Linux, a busy clipboard), the list
  // here is the only copy and Paste uses it.
  const [fileClipboard, setFileClipboard] = useState<{
    paths: string[];
    isCut: boolean;
    viaOs: boolean;
  } | null>(null);
  // True when the system clipboard holds files that another program put there.
  const [osHasFiles, setOsHasFiles] = useState(false);
  const pasting = useRef(false);
  const [menuData, setMenuData] = useState<{
    x: number;
    y: number;
    path: string;
    isBg: boolean;
  } | null>(null);
  const [inputModal, setInputModal] = useState<{
    mode: "rename" | "create";
    path: string;
  } | null>(null);
  const [itemsToDelete, setItemsToDelete] = useState<string[] | null>(null);
  // Facts about the selection, shown beside the list. Closed until asked for.
  const [showDetails, setShowDetails] = useState(false);

  // ── Time-lock state ─────────────────────────────────────────────────────────
  /** Path of the plaintext file to time-lock (opens TimeLockModal). */
  const [timeLockTarget, setTimeLockTarget] = useState<string | null>(null);
  /** The dialog that rewrites locked files made by older versions in the current format. */
  const [showUpgrade, setShowUpgrade] = useState(false);
  /** The format version of each readable .qre file in this folder, by path. */
  const [qreVersions, setQreVersions] = useState<Map<string, number>>(new Map());
  /** True for a .qre file that an older version made (format 5, 6 or 7). */
  const isOldFormat = (path: string) => {
    const version = qreVersions.get(path) ?? 0;
    return version >= 5 && version <= 7;
  };
  /**
   * Map of .qre path → locked_until timestamp for files in the current directory.
   * Populated by loadTimeLockStatuses on every directory change.
   * The Map (rather than a Set) lets FileGrid show the actual remaining time.
   */
  const [timeLockInfo, setTimeLockInfo] = useState<Map<string, number>>(
    new Map(),
  );

  // ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────

  // The shortcut handler below is set up once per selection, so it reaches the copy and paste
  // functions through this box, which always holds the ones from the latest render.
  const clipboardActions = useRef({
    put: (_paths: string[], _isCut: boolean) => {},
    paste: () => {},
    forget: () => {},
  });

  // Any dialog or menu on top of the list. Shortcuts such as Backspace (go up) and Delete must
  // not act on the list behind it.
  const overlayOpen = Boolean(
    inputModal ||
      itemsToDelete ||
      showEntropyModal ||
      showCompression ||
      showGhostWarning ||
      showExtractModal ||
      timeLockTarget ||
      menuData ||
      crypto.errorMsg ||
      fs.accessDenied ||
      (scopeCorrupted && !scopeCorruptionDismissed),
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (overlayOpen) return;
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        fs.selectAll();
      }
      if (e.key === "Delete" && fs.selectedPaths.length > 0) {
        e.preventDefault();
        setItemsToDelete(fs.selectedPaths);
      }
      // Copy, cut and paste, as in Explorer. Text the user has marked on the page is left to the browser.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const key = e.key.toLowerCase();
        const markedText = Boolean(window.getSelection()?.toString());
        if ((key === "c" || key === "x") && fs.selectedPaths.length > 0 && !markedText) {
          e.preventDefault();
          clipboardActions.current.put(fs.selectedPaths, key === "x");
        }
        if (key === "v") {
          e.preventDefault();
          clipboardActions.current.paste();
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        fs.clearSelection();
        clipboardActions.current.forget();
      }
      if (e.key === "Backspace") fs.goUp();
      if (e.key === "Enter" && fs.selectedPaths.length === 1) {
        const entry = fs.entries.find((en) => en.path === fs.selectedPaths[0]);
        if (entry?.isDirectory) fs.loadDir(entry.path);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fs.selectedPaths, fs.entries, overlayOpen]);

  // ─── TIME-LOCK STATUS LOADING ─────────────────────────────────────────────
  //
  // Fires on every directory listing change. Calls get_file_timelock_status
  // for each .qre file in parallel — the command reads only the plaintext
  // StreamHeader and requires no master key, so this is fast.

  useEffect(() => {
    // The answers can arrive after the user has already moved on. Only the latest listing
    // may update the badges, or a slow answer for the old folder would replace the new one's.
    let stale = false;
    loadTimeLockStatuses(fs.entries, () => stale);
    return () => {
      stale = true;
    };
  }, [fs.entries]);

  async function loadTimeLockStatuses(
    entries: FileEntry[],
    isStale: () => boolean,
  ) {
    const qreFiles = entries.filter(
      (e) => !e.isDirectory && e.name.endsWith(".qre"),
    );
    if (qreFiles.length === 0) {
      setTimeLockInfo(new Map());
      setQreVersions(new Map());
      return;
    }

    const results = await Promise.allSettled(
      qreFiles.map((e) =>
        invoke<{ is_locked: boolean; locked_until: number; format_version?: number }>(
          "get_file_timelock_status",
          { qrePath: e.path },
        ),
      ),
    );
    if (isStale()) return;

    const info = new Map<string, number>();
    const versions = new Map<string, number>();
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      if (r.value.is_locked) info.set(qreFiles[i].path, r.value.locked_until);
      const version = r.value.format_version ?? 0;
      if (version > 0) versions.set(qreFiles[i].path, version);
    });
    setTimeLockInfo(info);
    setQreVersions(versions);
  }

  // ─── PORTABLE DRIVE HELPERS ───────────────────────────────────────────────

  const isPortableTarget = (targets: string[]) => {
    const portableMountPaths = props.portable.drives
      .filter((d) => d.isUnlocked)
      .map((d) => d.drive.path);
    return targets.some((t) =>
      portableMountPaths.some((mount) =>
        t.toLowerCase().startsWith(mount.toLowerCase()),
      ),
    );
  };

  const requestLock = useCallback(
    async (targets: string[]) => {
      if (isPortableTarget(targets)) {
        setPendingLockTargets(targets);
        setShowGhostWarning(true);
      } else {
        executeLock(targets);
      }
    },
    // `crypto` must be a dependency: it's a fresh object every render (from
    // useCrypto()), and without it here this callback would stay memoized
    // against a stale executeLock/crypto closure — silently ignoring a
    // just-toggled Paranoid Mode, compression mode, or keyfile selection
    // whenever Lock is clicked without an intervening path/drive-list change.
    [props.portable.drives, fs.currentPath, crypto],
  );

  const executeLock = async (targets: string[], explicitEntropy?: number[]) => {
    // Say so before Paranoid Mode makes the user wave the mouse around for nothing.
    if (targets.length === 0) {
      crypto.setErrorMsg("No files selected.");
      return;
    }
    if (crypto.isParanoid && !explicitEntropy) {
      setPendingLockTargets(targets);
      setShowEntropyModal(true);
    } else {
      const results = await crypto.runCrypto(
        "lock_file",
        targets,
        fs.currentPath,
        explicitEntropy,
      );
      if (results) {
        const { cancelled, finished, problems } = summarizeCancel(results);
        if (problems.length > 0) {
          crypto.setErrorMsg(
            "Locking failed for some items:\n" +
              problems.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
          );
        } else if (!cancelled) {
          props.onShowBackupReminder();
        }
        if (cancelled) toast.info(cancelNotice(finished, "locked"));
      }
    }
  };

  // ─── UPGRADING FILES MADE BY OLDER VERSIONS ───────────────────────────────

  /**
   * Rewrites these locked files in the current format. Returns a text about the files that
   * could not be upgraded, or null if all went well, so a caller that has its own problems to
   * report can show both in one message.
   */
  async function upgradeFiles(paths: string[]): Promise<string | null> {
    if (paths.length === 0) return null;
    const results = await crypto.runCrypto("relock_file", paths, fs.currentPath);
    if (!results) return null; // runCrypto has already shown why
    const { cancelled, problems: failures } = summarizeCancel(results);
    const done = results.filter((r) => r.success && r.message.startsWith("Upgraded")).length;
    if (cancelled) {
      toast.info(cancelNotice(done, "upgraded"));
    } else if (done > 0) {
      toast.success(done === 1 ? "Upgraded 1 file to the current format." : `Upgraded ${done} files to the current format.`);
    }
    if (failures.length === 0) return null;
    return (
      "Upgrade failed for some items:\n" + failures.map((f) => `• ${f.name}: ${f.message}`).join("\n")
    );
  }

  /**
   * With the setting on, a file that was unlocked and was in an older format also gets its locked
   * copy rewritten. Only files that unlocked are touched, so a wrong key file or a time-lock
   * that has not ended never starts an upgrade. Results are in the order of the targets.
   */
  async function upgradeAfterUnlock(targets: string[], results: BatchResult[]): Promise<string | null> {
    if (!crypto.upgradeWhenUnlocking) return null;
    const unlockedOld = targets.filter((p, i) => isOldFormat(p) && results[i]?.success);
    return upgradeFiles(unlockedOld);
  }

  // ─── UNLOCK — handles time-locked files transparently ────────────────────
  //
  // The regular unlock command (files.rs → decrypt_file_stream) now checks
  // the embedded time-lock metadata and returns a TIME_LOCKED: error when
  // appropriate. No special routing needed here — we just surface the message.

  const requestUnlock = useCallback(
    async (targets: string[]) => {
      if (isPortableTarget(targets)) {
        setPendingUnlockTargets(targets);
        setShowExtractModal(true);
        return;
      }

      const results = await crypto.runCrypto(
        "unlock_file",
        targets,
        fs.currentPath,
      );

      if (results) {
        const timeLocked = results.filter(
          (r) => !r.success && r.message.startsWith("TIME_LOCKED:"),
        );
        const realFailures = results.filter(
          (r) => !r.success && !r.message.startsWith("TIME_LOCKED:") && !isCancelledResult(r),
        );

        // Show both kinds in one message; a second setErrorMsg would replace the first.
        const sections: string[] = [];
        if (timeLocked.length > 0) {
          // Parse "TIME_LOCKED:<unix_ts>:<human message>" from Rust
          const msgs = timeLocked.map((r) => {
            const parts = r.message.split(":");
            return `🔒 ${parts.slice(2).join(":")}`;
          });
          sections.push(msgs.join("\n\n"));
        }
        if (realFailures.length > 0) {
          sections.push(
            "Unlock failed:\n" +
              realFailures.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
          );
        }
        if (results.some(isCancelledResult)) {
          // The user stopped the job, so nothing else is started after it.
          toast.info(cancelNotice(results.filter((r) => r.success).length, "unlocked"));
        } else {
          const upgradeProblems = await upgradeAfterUnlock(targets, results);
          if (upgradeProblems) sections.push(upgradeProblems);
        }
        if (sections.length > 0) crypto.setErrorMsg(sections.join("\n\n"));
      }

      // Refresh so badges update if a lock just expired
      fs.loadDir(fs.currentPath);
    },
    // See the matching comment on requestLock — `crypto` must be a dependency
    // so this callback always uses the current keyfile/crypto state.
    [props.portable.drives, fs.currentPath, crypto, qreVersions],
  );

  const handleEntropyComplete = async (entropy: number[]) => {
    setShowEntropyModal(false);
    if (pendingLockTargets) {
      await executeLock(pendingLockTargets, entropy);
      setPendingLockTargets(null);
    }
  };

  const handleDrop = useCallback(
    async (paths: string[]) => {
      const toUnlock = paths.filter((p) => p.endsWith(".qre"));
      const toLock = paths.filter((p) => !p.endsWith(".qre"));
      if (toUnlock.length > 0) requestUnlock(toUnlock);
      if (toLock.length > 0) requestLock(toLock);
    },
    [requestLock, requestUnlock],
  );

  const { isDragging } = useDragDrop(handleDrop);

  // ─── CONTEXT MENU ─────────────────────────────────────────────────────────

  function handleContextMenu(e: React.MouseEvent, path: string | null) {
    e.preventDefault();
    e.stopPropagation();
    // Files copied in another program make Paste available too. Asked as the menu opens.
    if (!path && !isAndroid) {
      invoke<ClipboardFiles>("get_clipboard_files")
        .then((os) => setOsHasFiles(Boolean(os?.supported) && os.paths.length > 0))
        .catch(() => setOsHasFiles(false));
    }
    setMenuData({
      x: e.clientX,
      y: e.clientY,
      path: path || fs.currentPath,
      isBg: !path,
    });
  }

  // ─── COPY, CUT AND PASTE ──────────────────────────────────────────────────

  /**
   * Copies or cuts these items: keeps the list here, and also puts it on the system clipboard so
   * Explorer can paste it. Where the system clipboard cannot be used, the list here still works
   * inside QRE.
   */
  async function putOnClipboard(paths: string[], isCut: boolean) {
    setFileClipboard({ paths, isCut, viaOs: false });
    if (isAndroid) return;
    try {
      await invoke("set_clipboard_files", { paths, cut: isCut });
      setFileClipboard((now) => (now && now.paths === paths ? { ...now, viaOs: true } : now));
    } catch (e) {
      const why = String(e);
      if (!why.includes("not supported")) {
        toast.info(`Copied inside QRE only. Other programs cannot paste these files. ${why}`);
      }
    }
  }

  /** Drops the pending copy or cut, here and on the system clipboard. */
  function forgetClipboard() {
    const wasShared = fileClipboard?.viaOs;
    setFileClipboard(null);
    if (wasShared) invoke("clear_clipboard_files").catch(() => {});
  }

  /** What Paste would paste: the system clipboard if the copy went there, else the list kept here. */
  async function whatToPaste(): Promise<{ paths: string[]; isCut: boolean } | null> {
    const kept = fileClipboard;
    if (isAndroid) return kept;
    try {
      const os = await invoke<ClipboardFiles>("get_clipboard_files");
      if (!os?.supported) return kept;
      // A copy that never reached the system clipboard is the only one there is.
      if (kept && !kept.viaOs) return kept;
      return os.paths.length > 0 ? { paths: os.paths, isCut: os.cut } : null;
    } catch {
      return kept;
    }
  }

  async function pasteIntoCurrentFolder() {
    if (pasting.current) return;
    pasting.current = true;
    try {
      const source = await whatToPaste();
      if (!source) {
        setFileClipboard(null);
        setOsHasFiles(false);
        toast.info("There are no copied files to paste.");
        return;
      }
      crypto.setErrorMsg(null);
      const results = await invoke<BatchResult[]>("paste_items", {
        sources: source.paths,
        destDir: fs.currentPath,
        isCut: source.isCut,
      });
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        crypto.setErrorMsg(
          "Paste failed:\n" +
            failures.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
        );
      }
      if (source.isCut) {
        // The files were moved, so no list of their old names may stay behind.
        setFileClipboard(null);
        setOsHasFiles(false);
        if (!isAndroid) invoke("clear_clipboard_files").catch(() => {});
      }
      fs.loadDir(fs.currentPath);
    } catch (e) {
      crypto.setErrorMsg(String(e));
    } finally {
      pasting.current = false;
      crypto.clearProgress(500);
    }
  }

  clipboardActions.current = {
    put: putOnClipboard,
    paste: pasteIntoCurrentFolder,
    forget: forgetClipboard,
  };

  async function handleContextAction(action: string) {
    if (!menuData) return;
    const { path, isBg } = menuData;
    setMenuData(null);

    if (action === "refresh") return fs.loadDir(fs.currentPath);
    if (action === "new_folder")
      return setInputModal({ mode: "create", path: fs.currentPath });

    if (action === "paste") return pasteIntoCurrentFolder();

    if (isBg) return;

    let targets = [path];
    if (fs.selectedPaths.includes(path)) targets = fs.selectedPaths;

    if (action === "lock") requestLock(targets);
    if (action === "unlock") requestUnlock(targets);
    if (action === "upgrade") {
      const problems = await upgradeFiles(targets.filter(isOldFormat));
      if (problems) crypto.setErrorMsg(problems);
    }
    if (action === "share")
      invoke("show_in_folder", { path }).catch((e) =>
        crypto.setErrorMsg(String(e)),
      );
    // Android equivalent of "Reveal in Explorer" — there's no OS-level file explorer to
    // reveal an item in, so this opens the file directly with whatever app the OS considers
    // the default for its type (gallery for images, a PDF viewer, etc.). Routed through our
    // own open_file_android command rather than plugin-opener's open_path, which is broken
    // on Android (see commands/files.rs::open_file_android for the full explanation).
    if (action === "open")
      invoke("open_file_android", { path }).catch((e) =>
        crypto.setErrorMsg(String(e)),
      );
    if (action === "rename") setInputModal({ mode: "rename", path });
    if (action === "delete") setItemsToDelete(targets);
    if (action === "cut") putOnClipboard(targets, true);
    if (action === "copy") putOnClipboard(targets, false);
  }

  // ─── DELETE ───────────────────────────────────────────────────────────────

  async function performDeleteAction(mode: "trash" | "shred") {
    if (!itemsToDelete) return;
    crypto.setErrorMsg(null);
    const targets = [...itemsToDelete];
    setItemsToDelete(null);
    const command = mode === "shred" ? "delete_items" : "trash_items";

    try {
      const results = await invoke<BatchResult[]>(command, { paths: targets });
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        crypto.setErrorMsg(
          "Errors occurred:\n\n" +
            failures.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
        );
      }
      fs.loadDir(fs.currentPath);
      fs.setSelectedPaths([]);
    } catch (e) {
      crypto.setErrorMsg(String(e));
    } finally {
      crypto.clearProgress(500);
    }
  }

  // ─── OTHER HANDLERS ───────────────────────────────────────────────────────

  async function handleInputConfirm(rawName: string) {
    // Leading and trailing spaces are never wanted in a name (Windows drops or rejects them).
    const val = rawName.trim();
    if (!inputModal || !val) return;
    const { mode, path } = inputModal;
    setInputModal(null);
    try {
      if (mode === "create")
        await invoke("create_dir", { path: await join(path, val) });
      else await invoke("rename_item", { path, newName: val });
      fs.loadDir(fs.currentPath);
    } catch (e) {
      crypto.setErrorMsg(String(e));
    }
  }

  const executeExtract = async (dir: string | undefined) => {
    setShowExtractModal(false);
    if (!pendingUnlockTargets) return;

    const results = await crypto.runCrypto(
      "unlock_file",
      pendingUnlockTargets,
      fs.currentPath,
      undefined,
      dir,
    );
    if (results) {
      const failures = results.filter((r) => !r.success && !isCancelledResult(r));
      const sections: string[] = [];
      if (failures.length > 0) {
        sections.push(
          "Unlock failed:\n" +
            failures.map((f) => `• ${f.name}: ${f.message}`).join("\n"),
        );
      }
      if (results.some(isCancelledResult)) {
        toast.info(cancelNotice(results.filter((r) => r.success).length, "unlocked"));
      } else {
        const upgradeProblems = await upgradeAfterUnlock(pendingUnlockTargets, results);
        if (upgradeProblems) sections.push(upgradeProblems);
      }
      if (sections.length > 0) crypto.setErrorMsg(sections.join("\n\n"));
    }
    setPendingUnlockTargets(null);
  };

  // The selected entries in list order, for the selection bar and the details panel.
  const selectedEntries = fs.entries.filter((e) => fs.selectedPaths.includes(e.path));

  // Derive the Set<string> that FileGrid uses for badge display
  const timeLockPaths = new Set(timeLockInfo.keys());

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative",
      }}
      onContextMenu={(e) => handleContextMenu(e, null)}
    >
      <Toolbar
        onLock={() => requestLock(fs.selectedPaths)}
        onUnlock={() => requestUnlock(fs.selectedPaths)}
        onNavigate={fs.loadDir}
        keyFile={crypto.keyFile}
        setKeyFile={crypto.setKeyFile}
        selectKeyFile={crypto.selectKeyFile}
        isParanoid={crypto.isParanoid}
        setIsParanoid={crypto.setIsParanoid}
        verifyAfterLock={crypto.verifyAfterLock}
        setVerifyAfterLock={crypto.setVerifyAfterLock}
        onUpgradeFormat={() => setShowUpgrade(true)}
        upgradeWhenUnlocking={crypto.upgradeWhenUnlocking}
        setUpgradeWhenUnlocking={crypto.setUpgradeWhenUnlocking}
        compressionMode={crypto.compressionMode}
        onOpenCompression={() => setShowCompression(true)}
        portable={props.portable}
        onInitDrive={props.onInitDrive}
        onUnlockDrive={props.onUnlockDrive}
      />
      <AddressBar
        currentPath={fs.currentPath}
        onGoUp={fs.goUp}
        onNavigate={fs.loadDir}
        onGoHome={fs.goHome}
      />

      <div className="files-body">
        {!isAndroid && <PlacesRail currentPath={fs.currentPath} onNavigate={fs.loadDir} />}
        <div className="files-main">
          {scopeCorrupted && scopeCorruptionDismissed ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                padding: 40,
                color: "var(--text-dim)",
              }}
            >
              <AlertTriangle size={40} color="var(--btn-danger)" style={{ marginBottom: 12 }} />
              <p style={{ fontWeight: 600, color: "var(--text-main)", marginBottom: 6 }}>
                File browsing is still stuck
              </p>
              <p style={{ fontSize: "0.85rem", maxWidth: 360 }}>
                {isAndroid
                  ? "Force-close the app from Recent Apps and reopen it to fix this."
                  : "Restart the app to fix this."}
              </p>
              <button
                className="secondary-btn"
                style={{ marginTop: 15 }}
                onClick={() => setScopeCorruptionDismissed(false)}
              >
                Show details again
              </button>
            </div>
          ) : (
            <FileGrid
              entries={fs.entries}
              selectedPaths={fs.selectedPaths}
              onSelect={(path, idx, multi, range) =>
                fs.handleSelection(path, idx, multi, range)
              }
              onNavigate={fs.loadDir}
              onGoUp={fs.goUp}
              onContextMenu={handleContextMenu}
              sortField={fs.sortField}
              sortDirection={fs.sortDirection}
              onSort={fs.handleSort}
              timeLockPaths={timeLockPaths}
              timeLockInfo={timeLockInfo}
            />
          )}
          <SelectionBar
            names={selectedEntries.map((e) => e.name)}
            totalSize={fs.selectionSize}
            detailsOpen={showDetails}
            onToggleDetails={() => setShowDetails((open) => !open)}
            onDelete={() => setItemsToDelete(fs.selectedPaths)}
            onClear={fs.clearSelection}
          />
        </div>
        {showDetails && (
          <DetailsPanel
            selected={selectedEntries}
            timeLockInfo={timeLockInfo}
            formatVersions={qreVersions}
            onClose={() => setShowDetails(false)}
          />
        )}
      </div>

      {isDragging && (
        <div className="drag-overlay" role="status">
          <div className="drag-content">
            <UploadCloud size={48} />
            <span>Drop to Lock</span>
            <span className="drag-hint">Dropped files are encrypted with your current settings.</span>
          </div>
        </div>
      )}

      <div className="status-bar">
        <span>{fs.entries.length} items</span>
        <div
          style={{
            width: 1,
            height: 14,
            background: "var(--border)",
            margin: "0 10px",
          }}
        />
        <span>
          {fs.selectedPaths.length > 0
            ? `${fs.selectedPaths.length} selected (${formatSize(fs.selectionSize)})`
            : "No selection"}
        </span>
        {fs.statusMsg.startsWith("Error:") && !scopeCorrupted && (
          <>
            <div
              style={{
                width: 1,
                height: 14,
                background: "var(--border)",
                margin: "0 10px",
              }}
            />
            <span
              style={{ color: "var(--btn-danger)", fontSize: "0.85rem" }}
              title={fs.statusMsg}
            >
              {fs.statusMsg}
            </span>
          </>
        )}
        <div style={{ flex: 1 }} />
        {fileClipboard && (
          <span
            style={{
              color: "var(--accent)",
              fontSize: "0.75rem",
              marginRight: 15,
            }}
          >
            {fileClipboard.paths.length} item(s){" "}
            {fileClipboard.isCut ? "cut" : "copied"}
          </span>
        )}
        {crypto.keyFile && (
          <span style={{ color: "var(--btn-success)", fontSize: "0.75rem" }}>
            Keyfile Active
          </span>
        )}
      </div>

      {/* CONTEXT MENU */}
      {menuData && (
        <ContextMenu
          x={menuData.x}
          y={menuData.y}
          targetPath={menuData.path}
          isBackground={menuData.isBg}
          onClose={() => setMenuData(null)}
          onAction={handleContextAction}
          canPaste={fileClipboard !== null || osHasFiles}
          canUpgrade={isOldFormat(menuData.path)}
          onTimeLock={(path) => {
            setMenuData(null);
            setTimeLockTarget(path);
          }}
        />
      )}

      {inputModal && (
        <InputModal
          mode={inputModal.mode}
          initialValue={
            inputModal.mode === "rename"
              ? inputModal.path.split(/[/\\]/).pop() || ""
              : ""
          }
          onConfirm={handleInputConfirm}
          onCancel={() => setInputModal(null)}
        />
      )}

      {itemsToDelete && (
        <DeleteConfirmModal
          items={itemsToDelete}
          onTrash={() => performDeleteAction("trash")}
          onShred={() => performDeleteAction("shred")}
          onCancel={() => setItemsToDelete(null)}
        />
      )}

      {showCompression && (
        <CompressionModal
          current={crypto.compressionMode}
          onSave={(mode) => {
            crypto.setCompressionMode(mode);
            setShowCompression(false);
          }}
          onCancel={() => setShowCompression(false)}
        />
      )}

      {/* GHOST WARNING */}
      {showGhostWarning && pendingLockTargets && (
        <div className="modal-overlay" style={{ zIndex: 100005 }}>
          <div className="auth-card">
            <div
              className="modal-header"
              style={{ borderBottomColor: "var(--warning)" }}
            >
              <AlertTriangle size={24} color="var(--warning)" />
              <h2 style={{ color: "var(--warning)" }}>
                USB Encryption Warning
              </h2>
            </div>
            <div className="modal-body">
              <p
                style={{
                  color: "var(--text-main)",
                  fontSize: "0.95rem",
                  lineHeight: 1.5,
                }}
              >
                You are about to encrypt a file directly on a USB drive.
              </p>
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.85rem",
                  lineHeight: 1.5,
                  background: "rgba(245,158,11,0.1)",
                  padding: 15,
                  borderRadius: 8,
                }}
              >
                <strong>Hardware Risk:</strong> USB Flash memory uses
                "wear-leveling". When QRE deletes the original file, the USB
                hardware may leave a hidden ghost copy of the plaintext intact.
                <br />
                <br />
                <strong>Best Practice:</strong> Encrypt on your PC first, then
                copy the <code>.qre</code> file to the USB.
              </p>
              <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
                <button
                  className="secondary-btn"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setShowGhostWarning(false);
                    setPendingLockTargets(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="auth-btn"
                  style={{
                    flex: 1,
                    background: "var(--warning)",
                    color: "#000",
                  }}
                  onClick={() => {
                    setShowGhostWarning(false);
                    executeLock(pendingLockTargets);
                  }}
                >
                  I Understand, Proceed
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EXTRACT LOCATION MODAL */}
      {showExtractModal && pendingUnlockTargets && (
        <div className="modal-overlay" style={{ zIndex: 100005 }}>
          <div className="auth-card" style={{ width: 400 }}>
            <div className="modal-header">
              <FolderOpen size={24} color="var(--accent)" />
              <h2>Extract Files</h2>
              <div style={{ flex: 1 }} />
              <X
                size={20}
                style={{ cursor: "pointer" }}
                onClick={() => {
                  setShowExtractModal(false);
                  setPendingUnlockTargets(null);
                }}
              />
            </div>
            <div className="modal-body">
              <p
                style={{
                  color: "var(--text-dim)",
                  fontSize: "0.9rem",
                  marginBottom: 20,
                }}
              >
                Select where to save the decrypted files.
              </p>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                <ExtractOption
                  label="Downloads"
                  onClick={async () => executeExtract(await downloadDir())}
                />
                <ExtractOption
                  label="Desktop"
                  onClick={async () => executeExtract(await desktopDir())}
                />
                <ExtractOption
                  label="Documents"
                  onClick={async () => executeExtract(await documentDir())}
                />
                <div
                  style={{
                    height: 1,
                    background: "var(--border)",
                    margin: "5px 0",
                  }}
                />
                <ExtractOption
                  label="Extract Here (USB)"
                  color="var(--warning)"
                  onClick={() => executeExtract(undefined)}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {showEntropyModal && (
        <EntropyModal
          onComplete={handleEntropyComplete}
          onCancel={() => {
            setShowEntropyModal(false);
            setPendingLockTargets(null);
          }}
        />
      )}

      {crypto.errorMsg && (
        <ErrorModal
          message={crypto.errorMsg}
          onClose={() => crypto.setErrorMsg(null)}
        />
      )}

      {fs.accessDenied && (
        <div className="modal-overlay" style={{ zIndex: 99999 }}>
          <div
            className="auth-card"
            style={{ borderColor: "var(--btn-danger)" }}
          >
            <div
              className="modal-header"
              style={{ borderBottomColor: "var(--btn-danger)" }}
            >
              <ShieldAlert size={24} color="var(--btn-danger)" />
              <h2 style={{ color: "var(--btn-danger)" }}>Access Denied</h2>
            </div>
            <div className="modal-body" style={{ textAlign: "center" }}>
              <p
                style={{
                  fontSize: "1.1rem",
                  marginBottom: 10,
                  fontWeight: "bold",
                }}
              >
                System Protection Active
              </p>
              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                For your security, QRE Privacy Toolkit blocks access to critical
                operating system folders.
              </p>
              <div
                style={{
                  background: "rgba(217,64,64,0.1)",
                  padding: 10,
                  borderRadius: 6,
                  margin: "15px 0",
                  fontFamily: "monospace",
                  fontSize: "0.85rem",
                  wordBreak: "break-all",
                }}
              >
                {fs.accessDenied}
              </div>
              <button
                className="auth-btn danger-btn"
                style={{ width: "100%" }}
                onClick={() => fs.setAccessDenied(null)}
              >
                Understood
              </button>
            </div>
          </div>
        </div>
      )}

      {scopeCorrupted && !scopeCorruptionDismissed && (
        <div className="modal-overlay" style={{ zIndex: 99999 }}>
          <div
            className="auth-card"
            style={{ borderColor: "var(--btn-danger)" }}
          >
            <div
              className="modal-header"
              style={{ borderBottomColor: "var(--btn-danger)" }}
            >
              <ShieldAlert size={24} color="var(--btn-danger)" />
              <h2 style={{ color: "var(--btn-danger)" }}>File Browser Needs a Restart</h2>
            </div>
            <div className="modal-body" style={{ textAlign: "center" }}>
              <p
                style={{
                  fontSize: "1.1rem",
                  marginBottom: 10,
                  fontWeight: "bold",
                }}
              >
                A file with an unusual name broke the file browser
              </p>
              <p style={{ color: "var(--text-dim)", fontSize: "0.9rem" }}>
                Picking or dropping a file whose name contains an unmatched
                bracket (like <code>[</code>) can trip a known bug outside
                this app's control, which then breaks every folder listing
                until the app restarts. Your files themselves are completely
                unaffected — only this browsing session is stuck.
              </p>

              {isAndroid ? (
                <div
                  style={{
                    background: "rgba(139,92,246,0.08)",
                    border: "1px solid rgba(139,92,246,0.25)",
                    borderRadius: 8,
                    padding: 12,
                    marginTop: 15,
                    textAlign: "left",
                    fontSize: "0.85rem",
                  }}
                >
                  <strong>On Android, this needs a manual restart</strong> —
                  a one-tap restart isn't reliable on this platform, so
                  tapping a button here would just close the app without it
                  reopening. Instead:
                  <ol style={{ margin: "8px 0 0 0", paddingLeft: 18 }}>
                    <li>
                      Open your Recent Apps switcher and swipe this app away
                      completely (a Home-button tap alone isn't enough — it
                      needs to fully close).
                    </li>
                    <li>Reopen QRE Privacy Toolkit from your app drawer.</li>
                  </ol>
                </div>
              ) : (
                <button
                  className="auth-btn danger-btn"
                  style={{ width: "100%", marginTop: 15, display: "flex",
                    alignItems: "center", justifyContent: "center", gap: 8 }}
                  onClick={restartApp}
                  disabled={restarting}
                >
                  <RefreshCw size={16} className={restarting ? "spinner" : ""} />
                  {restarting ? "Restarting…" : "Restart App"}
                </button>
              )}

              <button
                className="secondary-btn"
                style={{ width: "100%", marginTop: 8 }}
                onClick={() => setScopeCorruptionDismissed(true)}
              >
                Dismiss for now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* UPGRADE OLD LOCKED FILES - before the processing overlay, so progress shows on top of it */}
      {showUpgrade && (
        <UpgradeFormatModal
          folder={fs.currentPath}
          keyFile={crypto.keyFile}
          onRun={(paths) => crypto.runCrypto("relock_file", paths, fs.currentPath)}
          onClose={() => setShowUpgrade(false)}
        />
      )}

      {!showEntropyModal && crypto.progress && (
        <ProcessingModal
          status={crypto.progress.status}
          percentage={crypto.progress.percentage}
          onCancel={crypto.canCancel ? crypto.cancel : undefined}
          cancelling={crypto.cancelling}
        />
      )}

      {/* TIME-LOCK MODAL */}
      {timeLockTarget && (
        <TimeLockModal
          filePath={timeLockTarget}
          verifyAfter={crypto.verifyAfterLock}
          onClose={() => setTimeLockTarget(null)}
          onSuccess={(_msg) => {
            crypto.clearProgress(0);
            setTimeLockTarget(null);
            fs.loadDir(fs.currentPath);
          }}
        />
      )}
    </div>
  );
}

// ─── HELPER COMPONENT ─────────────────────────────────────────────────────────

function ExtractOption({
  label,
  onClick,
  color,
}: {
  label: string;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "12px 15px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-color)",
        color: color || "var(--text-main)",
        fontSize: "0.95rem",
        fontWeight: "bold",
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.2s",
      }}
      onMouseOver={(e) =>
        (e.currentTarget.style.background = "var(--highlight)")
      }
      onMouseOut={(e) => (e.currentTarget.style.background = "var(--bg-color)")}
    >
      {label}
    </button>
  );
}

// --- END OF FILE src/components/views/FilesView.tsx ---
