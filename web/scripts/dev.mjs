/**
 * dev.mjs — `pnpm dev` entry for @claudex/web.
 *
 * Runs two vite dev servers side by side so one `pnpm dev` at the repo root
 * brings up both URLs (each proxies /api + /ws to the claudex backend on
 * 127.0.0.1:5179, which `pnpm -r --parallel run dev` starts in parallel):
 *
 *   http://localhost:5173  — claudex main app (index.html)
 *   http://localhost:5174  — standalone 文件站 (files.html, clean "/" URL)
 *
 * Cross-platform: plain node child_process spawning (no `&`, no concurrently
 * dependency). Child stdio is inherited so vite's HMR/error output lands on
 * the same terminal; Ctrl+C forwards to both children.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const viteBin = path.resolve(here, "../node_modules/vite/bin/vite.js");
const root = path.resolve(here, "..");

const children = [];
function start(label, args) {
  const child = spawn(process.execPath, [viteBin, ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    console.log(`[dev.mjs] ${label} exited (${signal ?? code})`);
    shutdown(code ?? 0);
  });
  return child;
}

start("main vite 5173", []);
start("文件站 vite 5174", ["--config", "vite.files.config.ts"]);

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
  process.exitCode = code;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
