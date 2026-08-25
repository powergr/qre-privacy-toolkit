import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useTheme() {
  // Load saved theme or default to 'system'
  const [theme, setTheme] = useState(
    localStorage.getItem("qre_theme") || "system",
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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
