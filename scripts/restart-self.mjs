#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Restart with context — preferred Bash-path entry point for Claude.
//
// Calls POST /api/admin/restart with {sessionId, toolUseId} in the body. The
// server writes a `pending_restart_results` row BEFORE SIGTERMing itself; on
// the next boot, a sweep turns that row into a synthetic success tool_result
// event so the chat UI renders the restart tool call as green instead of a
// dangling "failed".
//
// Usage:
//   node scripts/restart-self.mjs [port] \
//     --session-id <claudex-session-id> \
//     --tool-use-id <sdk-tool-use-id> \
//     [--cookie <session-cookie-value>]
//
// Positional port (back-compat with scripts/restart.mjs):
//   node scripts/restart-self.mjs 5179 --session-id X --tool-use-id Y
//
// If --cookie is omitted, we try to read it from `~/.claudex/cookies.txt` in
// Netscape-cookie format (same file the documented curl flow uses). This is
// the usual case when Claude is triggering a restart from inside the server
// process — the cookie is the same one the UI uses.
//
// If the HTTP request fails (endpoint unreachable, server already dead),
// this script falls back to plain `scripts/restart.mjs` so restart still
// happens — the user just doesn't get the green tool_result polish.
//
// Requires Node 18+ for the built-in `fetch`.
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
let sessionId = null;
let toolUseId = null;
let cookieValue = null;
let port = Number(process.env.CLAUDEX_PORT ?? 5179);

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--session-id" && args[i + 1]) sessionId = args[++i];
  else if (a === "--tool-use-id" && args[i + 1]) toolUseId = args[++i];
  else if (a === "--cookie" && args[i + 1]) cookieValue = args[++i];
  else if (a === "--port" && args[i + 1]) port = Number(args[++i]);
  else if (/^\d+$/.test(a)) port = Number(a);
}

// Best-effort cookie lookup: parse the "claudex_session" line out of a
// Netscape-format cookies.txt. We only read; we never write. No error if
// the file is missing — fallback path handles the auth failure.
function readCookieFromJar() {
  const jarPath = join(homedir(), ".claudex", "cookies.txt");
  if (!existsSync(jarPath)) return null;
  try {
    const raw = readFileSync(jarPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      // Netscape format: domain, flag, path, secure, expires, name, value
      if (parts.length >= 7 && parts[5] === "claudex_session") {
        return parts[6];
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

if (!cookieValue) {
  cookieValue = readCookieFromJar();
}

async function tryHttpRestart() {
  const body = {
    ...(sessionId ? { sessionId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  };
  const headers = { "Content-Type": "application/json" };
  if (cookieValue) headers["Cookie"] = `claudex_session=${cookieValue}`;

  const res = await fetch(`http://127.0.0.1:${port}/api/admin/restart`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = await res.json().catch(() => ({}));
  process.stdout.write(JSON.stringify(json) + "\n");
}

async function main() {
  try {
    await tryHttpRestart();
    // Success — the server is now shutting down and the restart worker is
    // already detached + polling the port. Nothing more for us to do.
    return;
  } catch (err) {
    process.stderr.write(
      `[restart-self] HTTP restart failed (${err.message}); falling back to scripts/restart.mjs\n`,
    );
  }

  // Fallback: plain restart.mjs. No pending_restart_results row gets
  // written, so the chat UI will show a dangling tool call — but the
  // server does come back up.
  const restartMjs = join(__dirname, "restart.mjs");
  const child = spawn(process.execPath, [restartMjs, String(port)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (e) => {
    process.stderr.write(`[restart-self] fallback failed: ${e.message}\n`);
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`[restart-self] fatal: ${err.message}\n`);
  process.exit(1);
});
