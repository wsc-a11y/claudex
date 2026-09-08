import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // 0.0.0.0 so the dev preview is reachable from a phone on the LAN.
    // Dev only — the built claudex server still binds 127.0.0.1 (CLAUDE.md).
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5179",
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://127.0.0.1:5179",
        ws: true,
      },
    },
  },
  // Multi-page build: files.html (the standalone 文件站 entry) is emitted
  // next to index.html so the claudex server's static hosting exposes both.
  // Dev serves both HTML files regardless of this input map; the second dev
  // instance (port 5174) is driven by vite.files.config.ts via dev.mjs.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        files: path.resolve(__dirname, "files.html"),
      },
    },
  },
});
