import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ChallengeStore } from "../auth/index.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { ProjectStore } from "../sessions/projects.js";
import { SessionStore } from "../sessions/store.js";
import { SessionManager } from "../sessions/manager.js";
import { ToolGrantStore } from "../sessions/grants.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { registerBrowseRoutes } from "../sessions/browse.js";
import { registerFilesRoutes } from "../files/routes.js";
import { registerSlashCommandRoutes } from "../sessions/slash-commands.js";
import { registerUserEnvRoutes } from "../sessions/user-env.js";
import { registerCliRoutes } from "../sessions/cli-routes.js";
import { registerUsageRoutes } from "../sessions/usage-routes.js";
import { registerSessionExportRoutes } from "../sessions/export-routes.js";
import { registerWorktreeRoutes } from "../sessions/worktree-routes.js";
import { registerMemoryRoutes } from "../sessions/memory-routes.js";
import { registerSearchRoutes } from "../search/routes.js";
import { registerLinkPreviewRoutes } from "../link-preview/routes.js";
import { registerStatsRoutes } from "../stats/routes.js";
import { registerMetaRoutes } from "../meta/routes.js";
import { registerAgentsRoutes } from "../agents/routes.js";
import { AuditStore } from "../audit/store.js";
import { registerAuditRoutes } from "../audit/routes.js";
import { registerBackupRoutes } from "../backup/routes.js";
import { registerAdminRoutes } from "../admin/routes.js";
import { resolvePendingRestartResults } from "./pending-restart-sweep.js";
import { AlertStore } from "../alerts/store.js";
import { createAlertHook } from "../alerts/events.js";
import { registerAlertsRoutes } from "../alerts/routes.js";
import { ClientErrorStore } from "../client-errors/store.js";
import { registerClientErrorRoutes } from "../client-errors/routes.js";
import { registerWsRoute } from "./ws.js";
import { registerPtyRoutes } from "./pty.js";
import { agentRunnerFactory } from "../sessions/agent-runner.js";
import type { RunnerFactory } from "../sessions/runner.js";
import { RoutineStore } from "../routines/store.js";
import { RoutineScheduler } from "../routines/scheduler.js";
import { registerRoutineRoutes } from "../routines/routes.js";
import { QueueRunner } from "../queue/runner.js";
import { QueueStore } from "../queue/store.js";
import { registerQueueRoutes } from "../queue/routes.js";
import { StatsRefresher } from "../sessions/stats-refresher.js";
import { AppSettingsStore } from "../settings/store.js";
import { registerAppSettingsRoutes } from "../settings/routes.js";
import {
  createPushSender,
  registerPushRoutes,
  type PushSender,
} from "../push/routes.js";
import type { VapidKeys } from "../push/vapid.js";

export interface AppDeps {
  db: Database.Database;
  jwtSecret: Uint8Array;
  logger: FastifyBaseLogger | false;
  isProduction: boolean;
  runnerFactory?: RunnerFactory;
  /**
   * Override the Claude config directory used for slash-command scans.
   * Defaults to `~/.claude`. Tests pass a tmp dir so they never read the
   * host user's real commands.
   */
  userClaudeDir?: string;
  /**
   * Override the CLI projects root used by the /api/cli/sessions discovery
   * endpoint. Defaults to `~/.claude/projects`. Tests pass a tmp dir so
   * they never read / mutate the developer's real CLI session history.
   */
  cliProjectsRoot?: string;
  /**
   * Absolute path to the built web/dist directory. If set, the server
   * mounts those files at `/` and falls through to index.html for SPA
   * routes — so browsers can hit the server on a single port, which is
   * what you want behind a Cloudflare Tunnel / Tailscale / Caddy
   * exposing ONE hostname.
   *
   * In dev you typically leave this unset and rely on Vite at 5173 with
   * its /api + /ws proxy pointing here.
   */
  webDist?: string;
  /**
   * VAPID keys for the Web Push routes + SessionManager's permission-request
   * push trigger. Injected by `server/src/index.ts` via
   * `loadOrCreateVapidKeys(config, log)` in production; tests omit it and
   * the push surface is disabled (routes still register, but send returns
   * a no-op sender — see the nullish `vapid` branch below).
   */
  vapid?: VapidKeys;
  /**
   * Absolute path to the claudex state directory (normally `~/.claudex`).
   * Used to anchor `uploads/<session-id>/` for the composer's Attach chip.
   * Optional for back-compat; defaults to `<os.homedir>/.claudex` to match
   * `loadConfig()` behavior. Tests inject a tmp state dir via `bootstrapAuthedApp`.
   */
  stateDir?: string;
  /**
   * The port the server will listen on. Threaded through so the admin
   * restart handler can tell its detached worker which port to watch.
   * Optional for back-compat; defaults to 5179 (same default as
   * `loadConfig()`). Tests inject 0 / a random port.
   */
  port?: number;
}

export async function buildApp(
  deps: AppDeps,
): Promise<{
  app: FastifyInstance;
  manager: SessionManager;
  scheduler: RoutineScheduler;
  queueRunner: QueueRunner;
  statsRefresher: StatsRefresher;
}> {
  const app =
    deps.logger === false
      ? Fastify({ logger: false })
      : Fastify({ loggerInstance: deps.logger });

  await app.register(fastifyCookie);

  // Audit store is wired up front so auth routes (the first register below)
  // can record login / totp / password events from day one. Every call site
  // passes it through its own `deps` bag rather than a global — keeps the
  // cross-module coupling explicit and makes test fakes trivial.
  const audit = new AuditStore(
    deps.db,
    deps.logger === false ? undefined : deps.logger,
  );

  app.get("/api/health", async () => ({
    status: "ok",
    version: "0.0.1",
    time: new Date().toISOString(),
  }));

  const challenges = new ChallengeStore();
  await registerAuthRoutes(app, {
    db: deps.db,
    jwtSecret: deps.jwtSecret,
    challenges,
    audit,
  });

  const manager = new SessionManager({
    sessions: new SessionStore(deps.db),
    projects: new ProjectStore(deps.db),
    grants: new ToolGrantStore(deps.db),
    runnerFactory: deps.runnerFactory ?? agentRunnerFactory,
    broadcast: () => {
      /* replaced by WS layer */
    },
    logger: deps.logger === false ? undefined : deps.logger,
    audit,
    attachments: new (await import("../uploads/store.js")).AttachmentStore(
      deps.db,
    ),
    // Global claudex preferences (currently just `language`). Read by
    // `getOrCreate` at runner-create to seed the SDK's `systemPrompt`.
    appSettings: new AppSettingsStore(deps.db),
  });

  // Alerts — persistent queue keyed on session-status transitions. Wire
  // the hook BEFORE any code path that could transitionStatus (the runner
  // factory above doesn't start sessions immediately; the routes/scheduler
  // below are what eventually drive transitions). Hook is fire-and-forget
  // and cannot throw — see createAlertHook for guarantees.
  const alertStore = new AlertStore(deps.db);
  manager.setAlertHook(
    createAlertHook({
      alerts: alertStore,
      sessions: new SessionStore(deps.db),
      notifyUpdate: () => manager.notifyAlertsUpdate(),
      logger: deps.logger === false ? undefined : deps.logger,
    }),
  );
  // Prune old resolved alerts on boot so the table stays bounded (30-day
  // retention for rows where resolved_at IS NOT NULL).
  if (process.env.NODE_ENV !== "test") {
    try {
      alertStore.pruneOld();
    } catch {
      /* best-effort */
    }
  }

  // Push notifications. We only wire the real web-push sender when VAPID
  // keys are configured — tests skip them to avoid the cost of ECC keygen
  // and to keep the send path deterministic. Without keys we register the
  // routes with a no-op sender so `GET /api/push/state` still works; the
  // subscribe route still rejects because the browser can't subscribe
  // without a valid applicationServerKey.
  let pushSender: PushSender | null = null;
  if (deps.vapid) {
    pushSender = createPushSender({
      db: deps.db,
      vapid: deps.vapid,
      logger: deps.logger === false ? undefined : deps.logger,
    });
    await registerPushRoutes(
      app,
      {
        db: deps.db,
        vapid: deps.vapid,
        logger: deps.logger === false ? undefined : deps.logger,
        audit,
      },
      pushSender,
    );
    // Fire a push every time a permission_request makes a session wait on a
    // user decision. Fire-and-forget: the manager catches rejections so a
    // push-delivery failure never crashes runtime.
    manager.setPushSender(pushSender);
  }

  // Multipart parsing — registered once here so the uploads routes can use
  // `req.file()` for streaming parse. 10 MB per-request cap matches the
  // uploads module's documented per-request limit; individual files are
  // further capped to 5 MB inside the route handler (`MAX_FILE_BYTES`).
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // per file
      files: 1, // one file per request — client serializes
      fields: 10,
      fieldSize: 1024 * 1024,
    },
  });

  const stateDir =
    deps.stateDir ?? path.join(os.homedir(), ".claudex");
  const uploadsRoot = path.join(stateDir, "uploads");

  await registerSessionRoutes(app, {
    db: deps.db,
    manager,
    cliProjectsRoot: deps.cliProjectsRoot,
    audit,
    uploadsRoot,
  });
  await registerBrowseRoutes(app);
  await registerFilesRoutes(app, { db: deps.db });
  const { registerUploadsRoutes } = await import("../uploads/routes.js");
  await registerUploadsRoutes(app, { db: deps.db, uploadsRoot });
  await registerSlashCommandRoutes(app, {
    db: deps.db,
    userClaudeDir: deps.userClaudeDir,
  });
  await registerUserEnvRoutes(app, {
    db: deps.db,
    userClaudeDir: deps.userClaudeDir,
  });
  await registerCliRoutes(app, {
    db: deps.db,
    cliProjectsRoot: deps.cliProjectsRoot,
  });
  await registerUsageRoutes(app, { db: deps.db });
  await registerSessionExportRoutes(app, { db: deps.db });
  await registerWorktreeRoutes(app, { db: deps.db });
  await registerMemoryRoutes(app, { db: deps.db });
  await registerSearchRoutes(app, { db: deps.db });
  await registerLinkPreviewRoutes(app, { db: deps.db });
  await registerStatsRoutes(app, { db: deps.db });
  await registerMetaRoutes(app, { db: deps.db });
  await registerAgentsRoutes(app, { db: deps.db });
  await registerAuditRoutes(app, { db: deps.db, audit });
  await registerBackupRoutes(app, { db: deps.db });
  await registerClientErrorRoutes(app, {
    db: deps.db,
    store: new ClientErrorStore(
      deps.db,
      deps.logger === false ? undefined : (deps.logger as any),
    ),
  });
  await registerAdminRoutes(app, {
    audit,
    port: deps.port ?? 5179,
    stateDir,
    db: deps.db,
  });
  await registerAlertsRoutes(app, { alerts: alertStore, manager });

  // Global claudex preferences (language override etc.). Separate store
  // from SessionManager's `appSettings` ref so the route handler can patch
  // the KV table directly; the manager re-reads on next `getOrCreate`.
  await registerAppSettingsRoutes(app, {
    store: new AppSettingsStore(deps.db),
  });

  // Routines: periodic cron-driven session spawns. The scheduler owns a single
  // timer chained across all active routines and reloads itself on any CRUD.
  const scheduler = new RoutineScheduler({
    routines: new RoutineStore(deps.db),
    sessions: new SessionStore(deps.db),
    projects: new ProjectStore(deps.db),
    manager,
    logger: deps.logger === false ? undefined : deps.logger,
  });
  scheduler.start();
  await registerRoutineRoutes(app, { db: deps.db, scheduler });

  // Queue: batch of prompts dispatched one at a time. The runner polls every
  // QUEUE_TICK_INTERVAL_MS (2s) for queued rows; tests set NODE_ENV=test so
  // we skip auto-start and drive `tick()` directly. Share a single QueueStore
  // across the runner and the HTTP routes so the `onChange` subscription
  // registered below fires for mutations from either side.
  const queueStore = new QueueStore(deps.db);
  // Bridge queue changes to the global WS channel so the web Queue screen
  // can drop its 5s poll. attachBroadcaster (inside registerWsRoute, below)
  // wires the real broadcaster into `manager`; this listener invokes it
  // lazily at fire-time so we don't depend on registration order.
  queueStore.onChange(() => {
    manager.notifyQueueUpdate();
  });
  const queueRunner = new QueueRunner({
    queue: queueStore,
    sessions: new SessionStore(deps.db),
    projects: new ProjectStore(deps.db),
    manager,
    logger: deps.logger === false ? undefined : deps.logger,
  });
  if (process.env.NODE_ENV !== "test") {
    queueRunner.start();
  }
  await registerQueueRoutes(app, { db: deps.db, manager, queue: queueStore });

  // Stats refresher: background sweeper that keeps each session's
  // stats_files_changed / stats_lines_added / stats_lines_removed columns
  // in sync with its event log. Without this the Home list forever shows
  // "no changes" for every session — the stats columns had no writer prior
  // to this worker. See server/src/sessions/stats-refresher.ts.
  //
  // Auto-start gated on NODE_ENV to match QueueRunner/tests; the refresher
  // is otherwise safe to run from boot (first tick is one interval away).
  const statsRefresher = new StatsRefresher({
    sessions: new SessionStore(deps.db),
    logger: deps.logger === false ? undefined : deps.logger,
  });
  if (process.env.NODE_ENV !== "test") {
    statsRefresher.start();
  }

  await registerWsRoute(app, {
    manager,
    db: deps.db,
    jwtSecret: deps.jwtSecret,
  });
  // On-boot sweep over rows stuck in active states. In-memory watchdog
  // timers don't survive a restart, so any session that was `running` /
  // `awaiting` when the process exited would otherwise stay that way
  // forever. Must run AFTER the WS route wires the real broadcaster into
  // `manager`, otherwise the synthesized `status` / `error` frames get
  // swallowed by the placeholder broadcast.
  //
  // Skipped in test mode — the session-manager tests exercise the sweep
  // directly against a freshly-constructed manager without the full app.
  if (process.env.NODE_ENV !== "test") {
    manager.sweepStuckOnBoot();
    // One-shot backfill of `stats_context_pct` for sessions whose last
    // turn_end predates the runtime change that stamps the column. Without
    // this pass, every pre-existing session on the list renders an empty
    // ring until the user sends another turn.
    manager.backfillContextPctOnBoot();
    // Resolve any pending_restart_results rows left by a prior
    // POST /api/admin/restart with {sessionId, toolUseId}. Runs AFTER
    // sweepStuckOnBoot (which re-arms watchdogs) so the force-idle here
    // supersedes any watchdog re-arm for sessions that had a restart
    // mid-tool-call. Runs AFTER registerWsRoute so notifyTranscriptRefresh
    // has a real broadcaster wired up (even if no clients are connected
    // at boot, the future reconnect will re-fetch the tail).
    //
    // Fire-and-forget: the sweep is cheap, synchronous-ish SQLite work
    // wrapped in an async signature for future-proofing. Awaiting would
    // block buildApp; the tradeoff is acceptable given this runs once
    // per process lifetime.
    void resolvePendingRestartResults(
      deps.db,
      manager,
      deps.logger === false ? undefined : deps.logger,
    );
  }
  await registerPtyRoutes(app, {
    db: deps.db,
    jwtSecret: deps.jwtSecret,
  });

  if (deps.webDist) {
    await registerWebStatic(app, deps.webDist);
  }

  return { app, manager, scheduler, queueRunner, statsRefresher };
}

async function registerWebStatic(
  app: FastifyInstance,
  webDist: string,
): Promise<void> {
  if (!fs.existsSync(webDist)) {
    app.log.warn(
      { webDist },
      "webDist path does not exist; skipping static mount. Run `pnpm --filter @claudex/web build` first.",
    );
    return;
  }

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    // We set our own Cache-Control per request (see setHeaders below), so
    // turn off fastify-static's default max-age=0 cache header.
    cacheControl: false,
    // Everything under /assets (Vite hash-named bundles) can be cached hard.
    // index.html we always revalidate so users pick up new bundles on refresh.
    setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  });

  // SPA fallback: any GET that's not /api/*, /ws, or an existing file goes
  // to index.html so React Router can handle /session/:id etc. on refresh.
  const indexPath = path.join(webDist, "index.html");
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0] ?? "/";
    if (req.method !== "GET") {
      return reply.code(404).send({ error: "not_found" });
    }
    if (
      url.startsWith("/api/") ||
      url === "/api" ||
      url === "/ws" ||
      url.startsWith("/ws/") ||
      url === "/pty" ||
      url.startsWith("/pty/")
    ) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!fs.existsSync(indexPath)) {
      return reply.code(500).send({ error: "index_html_missing" });
    }
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      // Mirror the fastify-static `no-cache` policy for index.html. Without
      // this, any SPA route (/session/:id, /routines, /alerts, …) falls
      // through to this handler and Fastify sends index.html with no
      // Cache-Control at all — which means the browser is free to cache
      // it indefinitely, and the user can't pick up a new JS bundle hash
      // until they manually clear Safari's site data. Pair this with the
      // Advanced → "Force reload" button for the case where the old
      // header already poisoned the cache.
      .header("Cache-Control", "no-cache")
      .send(fs.readFileSync(indexPath));
  });
}

// Default location of the built web bundle when the repo layout is intact.
export function defaultWebDist(): string {
  // src/transport/app.ts  →  repo: ../../..
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "web", "dist");
}
