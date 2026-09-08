import { defineConfig } from "vite";
import type { Plugin } from "vite";
import base from "./vite.config";

/**
 * vite.files.config.ts — second dev instance for the standalone 文件站 entry
 * (web/files.html). Serves the same codebase as the main dev server (same
 * /api + /ws proxy → claudex backend on 127.0.0.1:5179) but on port 5174,
 * and redirects "/" → /files.html so the file station has a clean URL.
 *
 * Driven by web/scripts/dev.mjs, which `pnpm dev` (root) picks up via the
 * web package's dev script. Nothing here affects the main 5173 dev server;
 * production builds use vite.config.ts's multi-entry rollup input instead.
 */
function filesRootRedirect(): Plugin {
  return {
    name: "files-root-redirect",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req as { url?: string }).url ?? "";
        if (url === "/" || url === "") {
          res.statusCode = 302;
          res.setHeader("Location", "/files.html");
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  ...base,
  plugins: [...(base.plugins ?? []), filesRootRedirect()],
  // Multi-page mode: only real HTML files (files.html) are served; unknown
  // paths 404 instead of SPA-falling-back to index.html — without this, a
  // stray /login or old bookmark on 5174 would render the MAIN claudex app
  // (with its login screen) on the file-station port.
  appType: "mpa",
  server: {
    ...base.server,
    port: 5174,
  },
});
