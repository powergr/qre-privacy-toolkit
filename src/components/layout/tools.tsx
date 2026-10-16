import {
  Lock,
  Trash2,
  Key,
  Home,
  StickyNote,
  Radar,
  Eraser,
  ClipboardList,
  QrCode,
  Bookmark,
  FileCheck,
  Brush,
  FileSearch,
  type LucideIcon,
} from "lucide-react";

/** The four kinds of tool. Each one has its own colour (--hue-*) in the sidebar. */
export type ToolGroupId = "protect" | "inspect" | "clean" | "create";

export interface Tool {
  /** The tab id App.tsx renders. */
  id: string;
  label: string;
  /** The tooltip. */
  desc: string;
  Icon: LucideIcon;
  group: ToolGroupId | null;
  /** Extra words the jump bar matches, so "wifi" finds the QR Generator. */
  keywords: string[];
}

export const TOOL_GROUPS: ReadonlyArray<{ id: ToolGroupId; label: string; blurb: string }> = [
  { id: "protect", label: "Protect", blurb: "Keep your data private." },
  { id: "inspect", label: "Inspect", blurb: "Check what you already have." },
  { id: "clean", label: "Clean up", blurb: "Remove traces for good." },
  { id: "create", label: "Create", blurb: "Make things offline." },
];

export const HOME_TOOL: Tool = {
  id: "home",
  label: "Home",
  desc: "Dashboard",
  Icon: Home,
  group: null,
  keywords: ["dashboard", "start", "overview"],
};

/** Every tool, in the order the sidebar shows them. */
export const TOOLS: ReadonlyArray<Tool> = [
  { id: "files", label: "Encrypt Files", desc: "Encrypt files", Icon: Lock, group: "protect", keywords: ["encrypt", "decrypt", "lock", "unlock", "folder", "file", "usb", "time-lock"] },
  { id: "notes", label: "Secure Notes", desc: "Secure notepad", Icon: StickyNote, group: "protect", keywords: ["note", "notes", "write", "markdown", "notepad"] },
  { id: "vault", label: "Passwords Vault", desc: "Offline credential vault", Icon: Key, group: "protect", keywords: ["password", "passwords", "login", "credential", "2fa", "totp", "authenticator"] },
  { id: "bookmarks", label: "Bookmarks Vault", desc: "Private encrypted links", Icon: Bookmark, group: "protect", keywords: ["bookmark", "link", "url", "favourite", "favorite"] },
  { id: "clipboard", label: "Secure Clipboard", desc: "Secure copy and history", Icon: ClipboardList, group: "protect", keywords: ["clipboard", "copy", "paste", "history"] },
  { id: "breach", label: "Privacy Check", desc: "Check leaks and IP exposure", Icon: Radar, group: "inspect", keywords: ["leak", "breach", "privacy", "ip", "email", "secrets", "scan", "network"] },
  { id: "hash", label: "Integrity Check", desc: "Verify file hashes", Icon: FileCheck, group: "inspect", keywords: ["hash", "checksum", "sha", "md5", "verify", "download", "integrity"] },
  { id: "analyzer", label: "File Analyzer", desc: "Detect fake extensions", Icon: FileSearch, group: "inspect", keywords: ["analyze", "extension", "spoof", "fake", "executable", "rtlo", "malware"] },
  { id: "sysclean", label: "System Clean", desc: "Clear temp and cache", Icon: Brush, group: "clean", keywords: ["clean", "cache", "temp", "junk", "registry", "browser", "traces"] },
  { id: "cleaner", label: "Metadata Cleaner", desc: "Strip hidden metadata from any file", Icon: Eraser, group: "clean", keywords: ["metadata", "exif", "gps", "photo", "steganography", "stego", "strip"] },
  { id: "shred", label: "Shredder", desc: "Permanently destroy files", Icon: Trash2, group: "clean", keywords: ["shred", "delete", "wipe", "erase", "trim", "destroy"] },
  { id: "qr", label: "QR Generator", desc: "Offline QR creation", Icon: QrCode, group: "create", keywords: ["qr", "code", "wifi", "barcode", "generate"] },
];

export function toolsInGroup(group: ToolGroupId): Tool[] {
  return TOOLS.filter((t) => t.group === group);
}

/** The CSS colour variable for a group, or undefined for tools that have none (Home). */
export function groupHue(group: ToolGroupId | null): string | undefined {
  return group ? `var(--hue-${group})` : undefined;
}
