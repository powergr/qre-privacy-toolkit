import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    // FIX: Force resolution of Tauri packages to avoid "undefined" errors
    alias: {
      "@tauri-apps/api": resolve(import.meta.dirname, "node_modules/@tauri-apps/api"),
      "@tauri-apps/plugin-shell": resolve(
        import.meta.dirname,
        "node_modules/@tauri-apps/plugin-shell"
      ),
      "@tauri-apps/plugin-dialog": resolve(
        import.meta.dirname,
        "node_modules/@tauri-apps/plugin-dialog"
      ),
      "@tauri-apps/plugin-fs": resolve(
        import.meta.dirname,
        "node_modules/@tauri-apps/plugin-fs"
      ),
      "@tauri-apps/plugin-clipboard-manager": resolve(
        import.meta.dirname,
        "node_modules/@tauri-apps/plugin-clipboard-manager"
      ),
      "@tauri-apps/plugin-global-shortcut": resolve(
        import.meta.dirname,
        "node_modules/@tauri-apps/plugin-global-shortcut"
      ),
      "@tauri-apps/plugin-process": resolve(
        import.meta.dirname,
        "node_modules/@tauri-apps/plugin-process"
      ),
    },
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    chunkSizeWarningLimit: 3000,
  },
});
