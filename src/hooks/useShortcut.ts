import { useEffect, useRef } from "react";

interface ShortcutOptions {
  /** Turn the shortcut off while it makes no sense (an operation is running). */
  enabled?: boolean;
  /** Needs Shift as well, as in Ctrl+Shift+S. */
  shift?: boolean;
  /**
   * By default a shortcut does nothing while a dialog is open, so Ctrl+N cannot open a
   * second editor behind a confirmation. Set this for a shortcut that belongs to the
   * dialog itself, such as Ctrl+S inside an editor.
   */
  allowInDialog?: boolean;
}

/** True when a dialog is on screen. All dialogs use the `modal-overlay` class. */
export function dialogIsOpen(): boolean {
  return document.querySelector(".modal-overlay") !== null;
}

/**
 * Runs `handler` when Ctrl (or Cmd on a Mac) plus `key` is pressed. The browser's own
 * action for the key (find, save, open) is suppressed so only the app reacts.
 */
export function useShortcut(
  key: string,
  handler: () => void,
  { enabled = true, shift = false, allowInDialog = false }: ShortcutOptions = {},
) {
  const callback = useRef(handler);
  callback.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const wanted = key.toLowerCase();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      if (e.shiftKey !== shift) return;
      if (e.key.toLowerCase() !== wanted) return;
      e.preventDefault();
      if (!allowInDialog && dialogIsOpen()) return;
      callback.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, enabled, shift, allowInDialog]);
}
