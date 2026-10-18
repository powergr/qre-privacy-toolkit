import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useMediaQuery } from "./useMediaQuery";

/** True while the phone or computer itself is set to its light appearance. */
export const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * Whether the app is showing a light background. "system" follows the device, anything
 * unknown is treated as "system", as the style sheets do.
 */
export function isLightBackground(theme: string, systemPrefersLight: boolean): boolean {
  if (theme === "light") return true;
  if (theme === "dark") return false;
  return systemPrefersLight;
}

/**
 * Tells Android to draw its status bar and navigation bar icons dark on a light app
 * background and white on a dark one. Without it they follow the phone's own dark mode and
 * can vanish. On other systems the command does nothing, and a failure changes nothing.
 */
async function syncSystemBars(light: boolean) {
  try {
    await invoke("set_android_system_bars", { lightBackground: light });
  } catch {
    // Not Android, or too early in the start-up: the bars keep their current colour.
  }
}

export function useTheme() {
  // Load saved theme or default to 'system'
  const [theme, setTheme] = useState(
    localStorage.getItem("qre_theme") || "system",
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // The icons follow the app's theme, and, for "system", the device as it changes.
  const systemPrefersLight = useMediaQuery(SYSTEM_LIGHT_QUERY);
  useEffect(() => {
    syncSystemBars(isLightBackground(theme, systemPrefersLight));
  }, [theme, systemPrefersLight]);

  async function applyTheme(t: string) {
    // 1. Update DOM for CSS
    document.body.setAttribute("data-theme", t);

    // 2. Persist
    localStorage.setItem("qre_theme", t);

    // 3. Try to update native Window frame (Desktop only)
    // We wrap this in try/catch because it often fails on Android or during early init.
    // (Previously gated behind `"os" in window.navigator`, a property no Tauri package
    // or standard Navigator ever defines - that condition was always false, so this
    // never actually ran. The try/catch below is what makes it safe to call directly.)
    try {
      const appWindow = getCurrentWindow();
      if (appWindow && typeof appWindow.setTheme === "function") {
        await appWindow.setTheme(t as any);
      }
    } catch (e) {
      // Ignore errors here to prevent app crash (common on Android)
      // console.warn("Native theme update failed:", e);
    }
  }

  return { theme, setTheme };
}
