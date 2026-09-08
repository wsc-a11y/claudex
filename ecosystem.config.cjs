// pm2 process definition for the claudex server.
//
// Primary target: Windows, where pm2 fills in for the absence of a native
// user-scoped daemon tool (launchd / systemd --user). The installer only
// invokes pm2 on Windows; macOS and Linux go through launchd / systemd
// respectively. This file is still safe to run manually on any platform:
//
//   pm2 start ecosystem.config.cjs
//
// We point pm2 at a plain Node wrapper (scripts/pm2-entry.cjs) rather than
// `pnpm start` because pm2 on Windows can't spawn `pnpm.cmd` directly —
// Node's spawn rejects .cmd scripts with EINVAL unless shell:true is
// threaded through the pm2 layer. The wrapper does the spawning itself.
//
// Logs land under $CLAUDEX_STATE_DIR (default ~/.claudex) so they follow
// the same convention as the rest of claudex runtime state.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const stateDir =
  process.env.CLAUDEX_STATE_DIR || path.join(os.homedir(), ".claudex");
const logDir = path.join(stateDir, "logs");
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {
  // best-effort; pm2 will fall back to ~/.pm2/logs if we can't create this
}

module.exports = {
  apps: [
    {
      name: "claudex",
      cwd: __dirname,
      script: "scripts/pm2-entry.cjs",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "5s",
      out_file: path.join(logDir, "claudex.out.log"),
      error_file: path.join(logDir, "claudex.err.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
