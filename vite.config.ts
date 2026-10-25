import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    headers: { "Cross-Origin-Opener-Policy": "same-origin" },
    watch: {
      // Cargo build artifacts otherwise trigger a page reload on every
      // compile, blanking the webview mid-rebuild.
      ignored: ["**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "chrome105", minify: "esbuild", sourcemap: false },
});
