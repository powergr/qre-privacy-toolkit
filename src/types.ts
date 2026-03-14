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

// --- PORTABLE USB TYPES ---

export type VaultId = string; // "local" or a drive path like "D:\"

export interface DriveInfo {
  path: string;
  name: string;
  free_space: number;
  total_space: number;
  is_qre_portable: boolean;
}

export interface PortableVaultState {
  drive: DriveInfo;
  is_unlocked: boolean;
  is_locked: boolean;
}
