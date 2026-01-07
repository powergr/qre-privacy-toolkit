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