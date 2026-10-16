import "./ui.css";

/** True on macOS and iOS, where the command key replaces Ctrl. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
}

/**
 * Turns a portable shortcut such as "Mod+Shift+S" into the keys to show on this system.
 * "Mod" is Ctrl everywhere except macOS, where it is the command key.
 */
export function shortcutKeys(shortcut: string, mac: boolean = isMacPlatform()): string[] {
  return shortcut.split("+").map((part) => {
    const key = part.trim();
    switch (key.toLowerCase()) {
      case "mod":
        return mac ? "⌘" : "Ctrl";
      case "ctrl":
        return mac ? "⌃" : "Ctrl";
      case "alt":
        return mac ? "⌥" : "Alt";
      case "shift":
        return mac ? "⇧" : "Shift";
      case "esc":
      case "escape":
        return "Esc";
      case "enter":
        return mac ? "↵" : "Enter";
      default:
        return key.length === 1 ? key.toUpperCase() : key;
    }
  });
}

export interface ShortcutHintProps {
  /** A portable shortcut, for example "Mod+S" or "Mod+Shift+S". */
  shortcut: string;
}

/** Shows a keyboard shortcut next to the action it triggers. */
export function ShortcutHint({ shortcut }: ShortcutHintProps) {
  const keys = shortcutKeys(shortcut);
  return (
    <span className="ui-keys" title={keys.join(" + ")}>
      {keys.map((k, i) => (
        <kbd key={i} className="ui-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}
