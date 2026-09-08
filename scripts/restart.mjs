#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Detached restart launcher.
//
// Forks scripts/restart-worker.mjs with `detached: true`, ignoring stdio, so
// the worker survives the death of whatever invoked us — notably a claudex
// server being asked to restart itself via POST /api/admin/restart, and the
// Claude CLI subprocess the call rode in on. The chain looks like:
//
//   server (dying) → Node spawns THIS launcher → launcher spawns worker,
//   fully detached → launcher exits → worker polls the port → server dies →
//   worker sees port free → worker execs pnpm exec tsx src/index.ts.
//
// Node's child_process.spawn({ detached: true }) does the platform-specific
// work for us: setsid(2) on Unix, DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP
// on Windows. We pair it with stdio: ["ignore", <file>, <file>] so the child
// inherits no pipes from the parent (inherited pipes close when the server
// dies and would kill the child along with it), and unref() so the parent
// can exit immediately without waiting on the child.
//
// Usage:
//   node scripts/restart.mjs [port]
//
// `port` is the TCP port the worker will wait on before relaunching the
// server. Defaults to CLAUDEX_PORT env, then 5179.
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const serverDir = resolve(repoRoot, "server");
const stateDir = process.env.CLAUDEX_STATE_DIR
  ? resolve(process.env.CLAUDEX_STATE_DIR)
  : join(homedir(), ".claudex");

mkdirSync(stateDir, { recursive: true });
const logPath = join(stateDir, "server-stdout.log");
const logFd = openSync(logPath, "a");

const port = Number(process.argv[2] ?? process.env.CLAUDEX_PORT ?? 5179);

const child = spawn(
  process.execPath,
  [join(__dirname, "restart-worker.mjs"), String(port), serverDir],
  {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: serverDir,
    env: process.env,
    windowsHide: true,
  },
);
child.unref();

// Emit a single JSON line so callers (including the HTTP restart handler)
// can machine-parse the worker pid + log path if they want.
process.stdout.write(
  JSON.stringify({
    restarterPid: child.pid,
    port,
    log: logPath,
  }) + "\n",
);
