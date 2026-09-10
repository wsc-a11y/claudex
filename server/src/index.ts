import { loadConfig, assertSafeBind } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { patchAnthropicEnvFromShell } from "./lib/shell-env.js";
import { openDb } from "./db/index.js";
import { loadOrCreateJwtSecret } from "./auth/index.js";
import { buildApp, defaultWebDist } from "./transport/app.js";
import { SessionStore } from "./sessions/store.js";
import { ProjectStore } from "./sessions/projects.js";
import { backfillSessionTitles } from "./sessions/backfill-titles.js";
import { backfillCliSessionTitles } from "./sessions/backfill-cli-titles.js";
import { loadOrCreateVapidKeys } from "./push/vapid.js";
import { startCliSyncWatcher, type CliSyncWatcher } from "./cli-sync/watcher.js";
import {
  startProcessScanner,
  type ProcessScanner,
} from "./cli-sync/process-scanner.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const config = loadConfig();
  assertSafeBind(config.host);
  const log = createLogger(config);

  // Patch ANTHROPIC_* env vars from the user's login shell before any runners
  // are created.  claudex is often spawned by Claude Desktop which injects its
  // own placeholder values (empty API key, https://api.anthropic.com base URL);
  // this recovers the real values the user set in ~/.zshrc / ~/.bash_profile.
  patchAnthropicEnvFromShell(log as any);
  const { db, close: closeDb } = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const vapid = loadOrCreateVapidKeys(config, log);

  // Resolve the web bundle location. Override with CLAUDEX_WEB_DIST; set
  // CLAUDEX_WEB_DIST=none to explicitly disable (i.e. you're running Vite
  // on a separate port in dev).
  const webEnv = process.env.CLAUDEX_WEB_DIST;
  let webDist: string | undefined;
  if (webEnv === "none") {
    webDist = undefined;
  } else if (webEnv) {
    webDist = path.resolve(webEnv);
  } else {
    const candidate = defaultWebDist();
    webDist = fs.existsSync(candidate) ? candidate : undefined;
  }

  const { app, manager, scheduler } = await buildApp({
    db,
    jwtSecret,
    logger: log as any,
    isProduction: config.nodeEnv === "production",
    webDist,
    vapid,
    stateDir: config.stateDir,
    port: config.port,
  });

  // Declared ahead of `shutdown` so the closure below can `.close()` it.
  // Assignment happens a few lines down, after the scheduler block.
  let cliSync: CliSyncWatcher | null = null;
  let cliProcScanner: ProcessScanner | null = null;

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    try {
      scheduler.dispose();
      if (cliSync) await cliSync.close();
      if (cliProcScanner) cliProcScanner.stop();
      await manager.disposeAll();
      await app.close();
    } finally {
      closeDb();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // CLI live sync — watch `~/.claude/projects` for the user's local `claude`
  // CLI activity and mirror new / updated JSONL transcripts into claudex in
  // near real time. Disabled under NODE_ENV=test (tests drive their own
  // file-level resync) and via CLAUDEX_WATCH_CLI=0 as an emergency off-switch.
  if (
    process.env.NODE_ENV !== "test" &&
    process.env.CLAUDEX_WATCH_CLI !== "0"
  ) {
    try {
      cliSync = startCliSyncWatcher({
        sessions: new SessionStore(db),
        projects: new ProjectStore(db),
        manager,
        logger: log as unknown as {
          debug?: (obj: unknown, msg?: string) => void;
          info?: (obj: unknown, msg?: string) => void;
          warn?: (obj: unknown, msg?: string) => void;
        },
      });
      // Fire-and-forget — we don't gate server ready on the initial scan.
      void cliSync.ready().then(() => {
        log.info("cli-sync watcher ready");
      });
    } catch (err) {
      log.error({ err }, "failed to start cli-sync watcher");
    }
  }

  // CLI process scanner — every 5s (15s on Windows, where each tick is a
  // PowerShell WMI cold start), walk `ps` + `lsof` / WMI to find live
  // `claude` CLI processes and flip idle claudex rows to `cli_running`
  // ("被占用") when there's a live external process attached to the same
  // SDK session. The composer locks on that status — the external process
  // is the only one that can be interrupted. Disabled in tests and under
  // the same `CLAUDEX_WATCH_CLI=0` kill switch as the watcher.
  if (
    process.env.NODE_ENV !== "test" &&
    process.env.CLAUDEX_WATCH_CLI !== "0"
  ) {
    try {
      cliProcScanner = startProcessScanner({
        sessions: new SessionStore(db),
        manager,
        logger: log as unknown as {
          debug?: (obj: unknown, msg?: string) => void;
          info?: (obj: unknown, msg?: string) => void;
          warn?: (obj: unknown, msg?: string) => void;
        },
      });
      log.info("cli process scanner started");
    } catch (err) {
      log.error({ err }, "failed to start cli process scanner");
    }
  }

  // One-shot title backfill. See server/src/sessions/backfill-titles.ts —
  // retitles historical sessions whose current title is still a placeholder
  // using their first persisted user_message. Synchronous; fast because it
  // only reads text.
  try {
    const backfillResult = backfillSessionTitles({
      sessions: new SessionStore(db),
    });
    log.info(
      `backfilled titles: ${backfillResult.retitled}/${backfillResult.scanned} sessions retitled`,
    );
  } catch (err) {
    log.error({ err }, "session title backfill failed");
  }

  // Second, narrower pass: CLI-adopted rows still carrying the pre-fix
  // first-message title get re-derived from the CLI's own `ai-title` /
  // `custom-title` / `last-prompt` records, matching what the VS Code
  // extension shows. See backfill-cli-titles.ts. Async (reads JSONL), but
  // it must land before the first client renders Home, so we await it.
  try {
    const cliTitles = await backfillCliSessionTitles({
      sessions: new SessionStore(db),
      projects: new ProjectStore(db),
      logger: log,
    });
    log.info(
      `backfilled CLI titles: ${cliTitles.retitled}/${cliTitles.scanned} sessions retitled`,
    );
  } catch (err) {
    log.error({ err }, "CLI session title backfill failed");
  }

  try {
    await app.listen({ host: config.host, port: config.port });
    log.info(
      {
        host: config.host,
        port: config.port,
        stateDir: config.stateDir,
        webDist: webDist ?? "(disabled — use Vite dev at 5173)",
      },
      "claudex server ready",
    );
  } catch (err) {
    log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
