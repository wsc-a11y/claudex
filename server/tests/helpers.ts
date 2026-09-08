import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/lib/config.js";
import type { Logger } from "../src/lib/logger.js";
import pino from "pino";
import { buildApp } from "../src/transport/app.js";
import { openDb, type ClaudexDb } from "../src/db/index.js";
import {
  currentTotp,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";
import type { RunnerFactory } from "../src/sessions/runner.js";
import type { SessionManager } from "../src/sessions/manager.js";
import type { RoutineScheduler } from "../src/routines/scheduler.js";
import type { VapidKeys } from "../src/push/vapid.js";

/**
 * Create a fully isolated Config pointing at a fresh tmp dir and a silent logger.
 * Use `cleanup()` in `afterEach` to remove the tmp dir.
 */
export function tempConfig(overrides?: Partial<Config>): {
  config: Config;
  log: Logger;
  cleanup: () => void;
} {
  const stateDir = mkdtempSync(path.join(tmpdir(), "claudex-test-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    stateDir,
    dbPath: path.join(stateDir, "claudex.db"),
    logDir: path.join(stateDir, "logs"),
    jwtSecretPath: path.join(stateDir, "jwt.secret"),
    nodeEnv: "development",
    ...overrides,
  };
  const log = pino({ level: "silent" }) as Logger;
  return {
    config,
    log,
    cleanup: () => {
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * Stands up an isolated app with a freshly-created user, logs them in, and
 * hands back the session cookie + a scratch tmp dir. The returned
 * `cleanup()` tears all of that down.
 *
 * Prefer this to hand-rolling the login dance in each suite.
 */
export async function bootstrapAuthedApp(
  runnerFactory?: RunnerFactory,
  opts?: {
    userClaudeDir?: string;
    cliProjectsRoot?: string;
    vapid?: VapidKeys;
  },
): Promise<{
  app: FastifyInstance;
  dbh: ClaudexDb;
  cookie: string;
  tmpDir: string;
  manager: SessionManager;
  scheduler: RoutineScheduler;
  cleanup: () => Promise<void>;
}> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const { app, manager, scheduler } = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: false,
    runnerFactory,
    userClaudeDir: opts?.userClaudeDir,
    cliProjectsRoot: opts?.cliProjectsRoot,
    vapid: opts?.vapid,
    stateDir: config.stateDir,
  });
  const users = new UserStore(dbh.db);
  const totpSecret = generateTotpSecret();
  const passwordHash = await hashPassword("hunter22-please-work");
  users.create({ username: "hao", passwordHash, totpSecret });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "hao", password: "hunter22-please-work" },
  });
  const challengeId = login.json().challengeId as string;
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/verify-totp",
    payload: { challengeId, code: currentTotp(totpSecret) },
  });
  const sessionCookie = verify.cookies.find(
    (c) => c.name === "claudex_session",
  )!;
  const cookie = `claudex_session=${sessionCookie.value}`;

  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "claudex-proj-"));

  return {
    app,
    dbh,
    cookie,
    tmpDir,
    manager,
    scheduler,
    cleanup: async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      scheduler.dispose();
      await manager.disposeAll();
      await app.close();
      dbh.close();
      cleanup();
    },
  };
}

/**
 * Flip `projects.trusted = 1` directly via the test DB. New projects
 * created through `POST /api/projects` arrive untrusted by default (see
 * migration 11 / the trust-gate flow); most suites want to immediately
 * create a session under the project they just added, so they call this
 * helper to bypass the confirm step. Idempotent.
 */
export function trustProject(dbh: ClaudexDb, projectId: string): void {
  dbh.db
    .prepare("UPDATE projects SET trusted = 1 WHERE id = ?")
    .run(projectId);
}

/**
 * Create a throwaway git repo with a single initial commit so we can create
 * worktrees against it. Returns the absolute path + a cleanup function that
 * rms the dir.
 *
 * `git worktree add` refuses to run on a repo with no commits ("fatal: not a
 * valid object name: 'HEAD'"), hence the seed file + commit. We also pass
 * `--initial-branch=main` so tests don't depend on the host's init defaults.
 */
export function createTmpGitRepo(): { path: string; cleanup: () => void } {
  const repoPath = mkdtempSync(path.join(tmpdir(), "claudex-gitrepo-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoPath,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  run("init", "--initial-branch=main");
  fs.writeFileSync(path.join(repoPath, "seed.txt"), "seed\n");
  run("add", "seed.txt");
  run("commit", "-m", "init");
  return {
    path: repoPath,
    cleanup: () => {
      fs.rmSync(repoPath, { recursive: true, force: true });
    },
  };
}
