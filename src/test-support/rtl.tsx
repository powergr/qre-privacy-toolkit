import type { ReactElement } from "react";
import { render as baseRender, type RenderOptions } from "@testing-library/react";
import { ToastProvider } from "../components/ui/Toast";

// Everything from Testing Library, so a test can import from this file instead.
export * from "@testing-library/react";

/**
 * Testing Library's render with the toast system mounted, the way main.tsx mounts it.
 * Screens that confirm success with a toast need it, or the message is never shown.
 */
export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return baseRender(ui, { wrapper: ToastProvider, ...options });
}
