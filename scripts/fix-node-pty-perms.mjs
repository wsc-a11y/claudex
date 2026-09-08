#!/usr/bin/env node
// node-pty ships a native `spawn-helper` binary under prebuilds/<os>-<arch>/
// that must be executable for posix_spawnp to launch it. pnpm's fetch-extract
// path drops the +x bit on those files on at least some macOS installs,
// producing `posix_spawnp failed` at runtime and breaking tests/pty.test.ts
// on every fresh `pnpm install`. Rather than depend on pnpm behavior we
// normalize the bit ourselves after every install.
import { readdirSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === ".cache") continue;
      walk(p, out);
    } else if (e.isFile() && e.name === "spawn-helper" && p.includes("/node-pty/prebuilds/")) {
      out.push(p);
    }
  }
}

const roots = ["node_modules"];
const hits = [];
for (const r of roots) walk(r, hits);

for (const p of hits) {
  try {
    const st = statSync(p);
    const mode = st.mode & 0o777;
    const needed = mode | 0o111;
    if (mode !== needed) {
      chmodSync(p, needed);
      console.log(`chmod +x ${p}`);
    }
  } catch (err) {
    console.warn(`skip ${p}: ${err.message}`);
  }
}
