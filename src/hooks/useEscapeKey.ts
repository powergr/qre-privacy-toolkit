import { useEffect, useRef } from "react";

// Every active Escape handler, oldest first. A dialog opened on top of another one
// registers later, so it sits at the end of the list and is the only one that reacts.
const stack: symbol[] = [];
const handlers = new Map<symbol, () => void>();
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  handlers.get(top)?.();
}

function register(id: symbol, handler: () => void) {
  stack.push(id);
  handlers.set(id, handler);
  if (!listening) {
    window.addEventListener("keydown", onKeyDown);
    listening = true;
  }
}

function unregister(id: symbol) {
  const i = stack.indexOf(id);
  if (i >= 0) stack.splice(i, 1);
  handlers.delete(id);
  if (stack.length === 0 && listening) {
    window.removeEventListener("keydown", onKeyDown);
    listening = false;
  }
}

/**
 * Calls `onEscape` when Escape is pressed, but only while this is the newest active
 * dialog. Pass `active = false` while the dialog is closed.
 */
export function useEscapeKey(onEscape: () => void, active: boolean = true) {
  const callback = useRef(onEscape);
  callback.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const id = Symbol("escape");
    register(id, () => callback.current());
    return () => unregister(id);
  }, [active]);
}
