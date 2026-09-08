#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Update + restart worker.
//
// Spawned detached by the server's POST /api/admin/update-and-restart handler
// AFTER the server has already verified git fetch + checkout + pnpm install +
// web build all succeeded.  This worker only waits for the port to drain and
// then starts the new server — it cannot fail in a way that leaves the
// instance dead (the old server has already committed to shutting down).
//
// Usage (internal):
//   node scripts/update-restart-worker.mjs <port> <repoRoot>
//
// Logs land in ~/.claudex/server-stdout.log via inherited fds from the parent
// (the admin route opens the log file and passes it as stdio).
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const port = Number(process.argv[2] ?? 5179);
const repoRoot = process.argv[3] ?? process.cwd();
const serverDir = `${repoRoot}/server`;

function portBusy(p) {
  return new Promise((res) => {
    const srv = net.createServer();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      res(v);
    };
    srv.once("error", () => done(true));
    srv.once("listening", () => srv.close(() => done(false)));
    try {
      srv.listen(p, "127.0.0.1");
    } catch {
      done(true);
    }
  });
}

const DEADLINE_MS = 30_000;
const deadline = Date.now() + DEADLINE_MS;
while (await portBusy(port)) {
  if (Date.now() > deadline) {
    console.error(
      `[claudex-update] port ${port} still busy after ${DEADLINE_MS / 1000}s; giving up`,
    );
    process.exit(1);
  }
  await sleep(200);
}

const isWin = process.platform === "win32";
const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: serverDir,
  stdio: "inherit",
  env: process.env,
  shell: isWin,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("[claudex-update] failed to spawn server:", err);
  process.exit(1);
});
