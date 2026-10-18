export interface FileEntry {
  name: string;
  isDirectory: boolean;
  path: string;
  isDrive?: boolean;
  size: number | null;
  modified: Date | null;
}

export type ViewState =
  | "loading"
  | "setup"
  | "recovery_display"
  | "recovery_entry"
  | "login"
  | "dashboard";

export interface BatchResult {
  name: string;
  success: boolean;
  message: string;
}

/** The files on the system clipboard, from `get_clipboard_files`. `supported` is false where QRE cannot use it. */
export interface ClipboardFiles {
  supported: boolean;
  paths: string[];
  cut: boolean;
}

/** A locked file in an older format (5, 6 or 7), found by the `find_old_format_files` scan. */
export interface OldFormatFile {
  path: string;
  name: string;
  version: number;
  /** For a time-locked file, the Unix time (seconds) the lock ends. Null otherwise. */
  locked_until: number | null;
}

// --- PORTABLE USB TYPES ---

export type VaultId = string; // "local" or a drive path like "D:\"

export interface DriveInfo {
  path: string;
  name: string;
  free_space: number;
  total_space: number;
  is_qre_portable: boolean;
  /** UUID read from keychain.qre at scan time. Shown in unlock modal for evil-maid verification. */
  vault_uuid?: string;
}

export interface PortableVaultState {
  drive: DriveInfo;
  is_unlocked: boolean;
  is_locked: boolean;
}
