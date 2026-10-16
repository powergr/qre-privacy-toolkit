import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus inside a dialog or drawer while it is open, and gives focus back
 * to whatever had it before. Focus starts on the element marked data-autofocus, else on
 * the first control not marked data-no-initial-focus (the Close button), unless something
 * inside already took it (an input with autoFocus).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;

    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));

    if (!root.contains(document.activeElement)) {
      const preferred = root.querySelector<HTMLElement>("[data-autofocus]");
      const all = controls();
      const first = all.find((el) => !el.hasAttribute("data-no-initial-focus")) ?? all[0];
      (preferred ?? first ?? root).focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const list = controls();
      if (list.length === 0) {
        e.preventDefault();
        root!.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    }

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [ref, active]);
}
