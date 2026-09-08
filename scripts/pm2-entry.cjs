// pm2's entrypoint for the claudex server.
//
// We run the server in the pm2-forked process directly — we do NOT
// spawn a grandchild. On Windows that matters: a grandchild node.exe
// whose parent has no console triggers Windows into allocating a new
// console for it, which surfaces as a visible terminal window. Closing
// that window kills the grandchild, pm2 auto-restarts it, and the loop
// becomes a flickering terminal users can't dismiss.
//
// By registering tsx's ESM loader in-process and dynamic-importing
// server/src/index.ts here, the server runs inside the pm2 fork (pm2
// already sets up stdio without a console) and no window ever appears.

const path = require("node:path");
const { pathToFileURL } = require("node:url");

process.env.NODE_ENV = process.env.NODE_ENV || "production";

const repoRoot = path.resolve(__dirname, "..");
const serverDir = path.join(repoRoot, "server");

let register;
try {
  const tsxApiPath = require.resolve("tsx/esm/api", { paths: [serverDir] });
  ({ register } = require(tsxApiPath));
} catch (err) {
  console.error(
    "[pm2-entry] could not locate tsx under server/node_modules. Run `pnpm install` first.",
  );
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}

// Anchor cwd to server/ so relative file lookups (e.g. default web dist
// probing) behave the same as `pnpm --filter @claudex/server exec tsx
// src/index.ts`, which runs with cwd=server/.
process.chdir(serverDir);

register();

const entry = pathToFileURL(path.join(serverDir, "src", "index.ts")).href;
import(entry).catch((err) => {
  console.error("[pm2-entry] claudex server failed to start:", err);
  process.exit(1);
});
