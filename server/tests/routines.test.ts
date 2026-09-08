import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapAuthedApp } from "./helpers.js";
import type {
  Runner,
  RunnerFactory,
  RunnerListener,
  RunnerInitOptions,
} from "../src/sessions/runner.js";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionManager } from "../src/sessions/manager.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import { RoutineStore } from "../src/routines/store.js";
import { RoutineScheduler, computeNextRun, isValidCron } from "../src/routines/scheduler.js";
import { tempConfig } from "./helpers.js";
import { trustProject } from "./helpers.js";

// Minimal no-op runner so the SessionManager can kick off sessions without
// actually spawning claude. Captures sent messages for assertions.
class RecordingRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  sent: string[] = [];
  disposed = false;
  private listeners = new Set<RunnerListener>();

  constructor(opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
  }

  async start() {}
  async sendUserMessage(c: string) {
    this.sent.push(c);
  }
  resolvePermission() {}
  resolveAskUserQuestion() {}
  resolvePlanAccept() {}
  async interrupt() {}
  async setPermissionMode() {}
  async dispose() {
    this.disposed = true;
  }
  on(l: RunnerListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  listenerCount() {
    return this.listeners.size;
  }
}

function recordingFactory(): {
  factory: RunnerFactory;
  runners: RecordingRunner[];
} {
  const runners: RecordingRunner[] = [];
  return {
    factory: {
      create(opts) {
        const r = new RecordingRunner(opts);
        runners.push(r);
        return r;
      },
    },
    runners,
  };
}

// ---- Routes ----------------------------------------------------------------

describe("routines HTTP routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  async function seedProject(ctx: {
    app: FastifyInstance;
    cookie: string;
    tmpDir: string;
  }) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "spindle", path: ctx.tmpDir },
    });
    return res.json().project.id as string;
  }

  async function bootstrap() {
    const { factory, runners } = recordingFactory();
    const ctx = await bootstrapAuthedApp(factory);
    return { ...ctx, runners };
  }

  it("requires auth", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/routines",
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST → list → findById round-trip", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);

    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/routines",
      headers: { cookie: ctx.cookie },
      payload: {
        name: "dep audit",
        projectId,
        prompt: "run dependency audit",
        cronExpr: "0 9 * * *",
        model: "claude-opus-4-8",
        mode: "default",
      },
    });
    expect(created.statusCode).toBe(200);
    const routine = created.json().routine;
    expect(routine.name).toBe("dep audit");
    expect(routine.status).toBe("active");
    expect(routine.nextRunAt).toBeTruthy();
    expect(new Date(routine.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/routines",
      headers: { cookie: ctx.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().routines).toHaveLength(1);

    const fetched = await ctx.app.inject({
      method: "GET",
      url: `/api/routines/${routine.id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().routine.id).toBe(routine.id);
  });

  it("rejects invalid cron with 400 invalid_cron", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/routines",
      headers: { cookie: ctx.cookie },
      payload: {
        name: "broken",
        projectId,
        prompt: "nope",
        cronExpr: "not a cron",
        model: "claude-opus-4-8",
        mode: "default",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_cron");
  });

  it("rejects an unknown project id with 400", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/routines",
      headers: { cookie: ctx.cookie },
      payload: {
        name: "x",
        projectId: "does-not-exist",
        prompt: "run",
        cronExpr: "0 9 * * *",
        model: "claude-opus-4-8",
        mode: "default",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("project_not_found");
  });

  it("PATCH updates mutable fields and rejects bad cron", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/routines",
      headers: { cookie: ctx.cookie },
      payload: {
        name: "a",
        projectId,
        prompt: "first",
        cronExpr: "0 9 * * *",
        model: "claude-opus-4-8",
        mode: "default",
      },
    });
    const id = created.json().routine.id as string;

    const patched = await ctx.app.inject({
      method: "PATCH",
      url: `/api/routines/${id}`,
      headers: { cookie: ctx.cookie },
      payload: { name: "renamed", prompt: "second", status: "paused" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().routine.name).toBe("renamed");
    expect(patched.json().routine.prompt).toBe("second");
    expect(patched.json().routine.status).toBe("paused");

    const bad = await ctx.app.inject({
      method: "PATCH",
      url: `/api/routines/${id}`,
      headers: { cookie: ctx.cookie },
      payload: { cronExpr: "not a cron" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_cron");
  });

  it("DELETE removes the routine", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/routines",
      headers: { cookie: ctx.cookie },
      payload: {
        name: "a",
        projectId,
        prompt: "p",
        cronExpr: "0 9 * * *",
        model: "claude-opus-4-8",
        mode: "default",
      },
    });
    const id = created.json().routine.id as string;
    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/routines/${id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(del.statusCode).toBe(200);
    const fetched = await ctx.app.inject({
      method: "GET",
      url: `/api/routines/${id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(fetched.statusCode).toBe(404);
  });

  it("POST /api/routines/:id/run creates a session and sends the prompt", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);
    // Projects created via POST /api/projects arrive untrusted — the scheduler
    // now respects the trust gate (parity with POST /api/sessions), so trust
    // it explicitly for this happy-path test.
    trustProject(ctx.dbh, projectId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/routines",
      headers: { cookie: ctx.cookie },
      payload: {
        name: "dep audit",
        projectId,
        prompt: "run a dep audit now",
        cronExpr: "0 9 * * *",
        model: "claude-opus-4-8",
        mode: "default",
      },
    });
    const id = created.json().routine.id as string;

    const run = await ctx.app.inject({
      method: "POST",
      url: `/api/routines/${id}/run`,
      headers: { cookie: ctx.cookie },
    });
    expect(run.statusCode).toBe(200);
    const sessionId = run.json().sessionId as string;
    expect(sessionId).toBeTruthy();

    // The session should exist and point at this project.
    const session = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}`,
      headers: { cookie: ctx.cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().session.projectId).toBe(projectId);
    expect(session.json().session.title).toContain("dep audit");

    // And the runner got the prompt.
    const allSent = ctx.runners.flatMap((r) => r.sent);
    expect(allSent).toContain("run a dep audit now");

    // last_run_at should be set.
    const after = await ctx.app.inject({
      method: "GET",
      url: `/api/routines/${id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(after.json().routine.lastRunAt).toBeTruthy();
  }, 10000);
});

// ---- Scheduler -------------------------------------------------------------

describe("RoutineScheduler", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const { config, log, cleanup } = tempConfig();
    const { db, close } = openDb(config, log);
    const projects = new ProjectStore(db);
    const sessions = new SessionStore(db);
    const grants = new ToolGrantStore(db);
    const routines = new RoutineStore(db);

    const project = projects.create({
      name: "p",
      path: "/tmp/does-not-need-to-exist",
      trusted: true,
    });

    const runners: RecordingRunner[] = [];
    const factory: RunnerFactory = {
      create(opts) {
        const r = new RecordingRunner(opts);
        runners.push(r);
        return r;
      },
    };
    const manager = new SessionManager({
      sessions,
      projects,
      grants,
      runnerFactory: factory,
      broadcast: () => {},
    });

    // Capturing fake timer so we can drive fires synchronously without
    // vitest.useFakeTimers() (which doesn't mix well with some Fastify bits).
    const pending: Array<{ id: number; fn: () => void; deadline: number }> = [];
    let nextId = 1;
    let currentMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const nowFn = () => new Date(currentMs);
    const setTimeoutFn = (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.push({ id, fn, deadline: currentMs + ms });
      return id;
    };
    const clearTimeoutFn = (h: unknown) => {
      const idx = pending.findIndex((p) => p.id === h);
      if (idx >= 0) pending.splice(idx, 1);
    };

    const scheduler = new RoutineScheduler({
      routines,
      sessions,
      projects,
      manager,
      now: nowFn,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    cleanups.push(() => {
      scheduler.dispose();
      close();
      cleanup();
    });

    return {
      db,
      projects,
      sessions,
      routines,
      manager,
      scheduler,
      project,
      runners,
      advanceTo(ms: number) {
        currentMs = ms;
        // Fire everything whose deadline is <= currentMs, in order.
        while (true) {
          pending.sort((a, b) => a.deadline - b.deadline);
          const next = pending[0];
          if (!next || next.deadline > currentMs) break;
          pending.shift();
          next.fn();
        }
      },
      setNow(ms: number) {
        currentMs = ms;
      },
      currentMs: () => currentMs,
      pending: () => [...pending],
    };
  }

  it("fires an active routine when its next_run_at elapses", async () => {
    const s = setup();
    const now = s.currentMs();
    // Precompute next_run_at explicitly to 60s in the future.
    const r = s.routines.create({
      name: "r",
      projectId: s.project.id,
      prompt: "hello",
      cronExpr: "*/1 * * * *", // every minute (only used for rescheduling)
      model: "claude-opus-4-8",
      mode: "default",
      nextRunAt: new Date(now + 60_000).toISOString(),
    });
    s.scheduler.start();
    expect(s.scheduler.debugArmedAt()).not.toBeNull();
    expect(s.sessions.list()).toHaveLength(0);

    s.advanceTo(now + 60_000);
    // Give the scheduler's async fire() a tick to settle.
    await new Promise((r) => setImmediate(r));

    const sessions = s.sessions.list();
    expect(sessions).toHaveLength(1);
    // SessionManager auto-retitles a placeholder-looking title from the
    // first user_message. The routine's default "<name> · <ts>" title
    // is ≤3 tokens so it qualifies as a placeholder → retitled to the
    // prompt text ("hello").
    expect(sessions[0].title).toBe("hello");
    expect(sessions[0].projectId).toBe(s.project.id);
    expect(s.runners.some((rr) => rr.sent.includes("hello"))).toBe(true);

    const fresh = s.routines.findById(r.id)!;
    expect(fresh.lastRunAt).toBeTruthy();
    expect(fresh.nextRunAt).toBeTruthy();
    expect(new Date(fresh.nextRunAt!).getTime()).toBeGreaterThan(now + 60_000);
  });

  it("paused routines never fire", async () => {
    const s = setup();
    const now = s.currentMs();
    const r = s.routines.create({
      name: "r",
      projectId: s.project.id,
      prompt: "should not run",
      cronExpr: "*/1 * * * *",
      model: "claude-opus-4-8",
      mode: "default",
      nextRunAt: new Date(now + 1_000).toISOString(),
    });
    s.routines.setStatus(r.id, "paused");
    s.scheduler.start();
    expect(s.scheduler.debugArmedAt()).toBeNull();

    s.advanceTo(now + 120_000);
    await new Promise((r) => setImmediate(r));
    expect(s.sessions.list()).toHaveLength(0);
  });

  it("reload() rearms after a routine's cron is changed", async () => {
    const s = setup();
    const now = s.currentMs();
    // Start with a routine scheduled far in the future.
    const r = s.routines.create({
      name: "r",
      projectId: s.project.id,
      prompt: "p",
      cronExpr: "0 9 * * *",
      model: "claude-opus-4-8",
      mode: "default",
      nextRunAt: new Date(now + 10 * 60_000).toISOString(),
    });
    s.scheduler.start();
    const firstArmed = s.scheduler.debugArmedAt();
    expect(firstArmed).toBeTruthy();

    // Simulate a user editing the routine to "fire 1 minute from now".
    s.routines.setSchedule(r.id, new Date(now + 60_000).toISOString());
    s.scheduler.reload();
    const secondArmed = s.scheduler.debugArmedAt()!;
    expect(new Date(secondArmed).getTime()).toBe(now + 60_000);
  });

  it("deleted routines don't fire (their timer is cleared on reload)", async () => {
    const s = setup();
    const now = s.currentMs();
    const r = s.routines.create({
      name: "r",
      projectId: s.project.id,
      prompt: "delete-me",
      cronExpr: "*/1 * * * *",
      model: "claude-opus-4-8",
      mode: "default",
      nextRunAt: new Date(now + 60_000).toISOString(),
    });
    s.scheduler.start();
    // Delete before the fire window.
    s.routines.delete(r.id);
    s.scheduler.reload();
    expect(s.scheduler.debugArmedAt()).toBeNull();

    s.advanceTo(now + 120_000);
    await new Promise((r) => setImmediate(r));
    expect(s.sessions.list()).toHaveLength(0);
  });

  it("skips missed fires with a warn — does not catch up", async () => {
    const s = setup();
    const now = s.currentMs();
    // Schedule is in the past — simulates a server that was down.
    s.routines.create({
      name: "r",
      projectId: s.project.id,
      prompt: "should roll forward",
      cronExpr: "*/5 * * * *",
      model: "claude-opus-4-8",
      mode: "default",
      nextRunAt: new Date(now - 10 * 60_000).toISOString(),
    });
    s.scheduler.start();

    // No session should have been created synchronously as a catch-up.
    expect(s.sessions.list()).toHaveLength(0);

    // The routine's next_run_at must now be in the future.
    const [reloaded] = s.routines.list();
    expect(new Date(reloaded.nextRunAt!).getTime()).toBeGreaterThan(now);
  });

  it("fire() directly creates a session and advances the schedule", async () => {
    const s = setup();
    const now = s.currentMs();
    const r = s.routines.create({
      name: "manual",
      projectId: s.project.id,
      prompt: "hello",
      cronExpr: "0 9 * * *",
      model: "claude-opus-4-8",
      mode: "default",
    });
    const sessionId = await s.scheduler.fire(r);
    expect(sessionId).toBeTruthy();
    expect(s.sessions.list()).toHaveLength(1);
    const fresh = s.routines.findById(r.id)!;
    expect(fresh.lastRunAt).toBeTruthy();
    expect(fresh.nextRunAt).toBeTruthy();
    expect(new Date(fresh.nextRunAt!).getTime()).toBeGreaterThan(now);
  });

  it("skips firing when the project was untrusted after schedule creation", async () => {
    // QA blocker: a user trusts a project, schedules a routine, then revokes
    // trust. The routine must NOT spawn a session — the HTTP POST
    // /api/sessions trust gate is meaningless if the scheduler bypasses it.
    const s = setup();
    const r = s.routines.create({
      name: "untrusted",
      projectId: s.project.id,
      prompt: "should not fire",
      cronExpr: "0 9 * * *",
      model: "claude-opus-4-8",
      mode: "default",
    });
    // Revoke trust after the routine was created.
    s.projects.setTrusted(s.project.id, false);

    const sessionId = await s.scheduler.fire(r);
    expect(sessionId).toBeNull();
    expect(s.sessions.list()).toHaveLength(0);

    // Schedule should still advance (so we don't busy-loop on every tick),
    // but lastRunAt must remain null because the routine didn't actually run.
    const fresh = s.routines.findById(r.id)!;
    expect(fresh.lastRunAt).toBeNull();
    expect(fresh.nextRunAt).toBeTruthy();
  });
});

// ---- cron helpers ----------------------------------------------------------

describe("cron helpers", () => {
  it("isValidCron accepts standard 5-field expressions", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0 0 * * MON")).toBe(true);
  });

  it("isValidCron rejects garbage", () => {
    expect(isValidCron("definitely not a cron")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  it("computeNextRun yields a future Date", () => {
    const from = new Date("2026-05-08T00:00:00Z");
    const next = computeNextRun("0 9 * * *", from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });
});
