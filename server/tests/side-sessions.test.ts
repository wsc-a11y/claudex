import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapAuthedApp } from "./helpers.js";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionManager } from "../src/sessions/manager.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import { tempConfig } from "./helpers.js";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
  RunnerListener,
} from "../src/sessions/runner.js";
import type { PermissionMode } from "@claudex/shared";

// ---------------------------------------------------------------------------
// HTTP-surface tests for `/btw` side sessions.
//
// POST /api/sessions/:id/side creates a child session that branches off the
// main thread. The server is responsible for:
//   • copying project / model from the parent; defaulting mode to `plan`
//     so the side chat can't mutate the working tree
//   • persisting `parent_session_id` on the new row
//   • cascading the child when the parent is deleted
//   • 404ing on an unknown parent
//
// These tests don't reach into the SessionManager — that's covered by the
// manager suite. They pin the HTTP / DB contract.
// ---------------------------------------------------------------------------

const bootstrap = bootstrapAuthedApp;

async function addProject(ctx: {
  app: FastifyInstance;
  cookie: string;
  tmpDir: string;
  dbh: import("../src/db/index.js").ClaudexDb;
}) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: ctx.cookie },
    payload: { name: "demo", path: ctx.tmpDir },
  });
  const project = res.json().project as { id: string; path: string };
  // Trust immediately — these tests are about side-chat semantics, not the
  // trust gate. Without this the addSession helper trips 409.
  ctx.dbh.db
    .prepare("UPDATE projects SET trusted = 1 WHERE id = ?")
    .run(project.id);
  return project;
}

async function addSession(
  ctx: { app: FastifyInstance; cookie: string; tmpDir: string },
  projectId: string,
) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie: ctx.cookie },
    payload: {
      projectId,
      title: "main",
      model: "claude-opus-4-8",
      mode: "default",
      // we don't care about worktrees in these tests
      worktree: false,
    },
  });
  return res.json().session;
}

describe("POST /api/sessions/:id/side", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("creates a child session that copies project/model and defaults mode to plan", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const project = await addProject(ctx);
    const parent = await addSession(ctx, project.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const child = res.json().session;
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.projectId).toBe(parent.projectId);
    expect(child.model).toBe(parent.model);
    // Side chats are read-only by default — users can relax this from the
    // settings sheet if they really want to act from the side lane.
    expect(child.mode).toBe("plan");
    expect(child.title).toBe("Side chat");
  });

  it("persists parent_session_id in the DB column", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const project = await addProject(ctx);
    const parent = await addSession(ctx, project.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
      payload: {},
    });
    const child = res.json().session;
    const row = ctx.dbh.db
      .prepare(
        "SELECT parent_session_id FROM sessions WHERE id = ?",
      )
      .get(child.id) as { parent_session_id: string | null };
    expect(row.parent_session_id).toBe(parent.id);
  });

  it("cascades the child when the parent is deleted", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const project = await addProject(ctx);
    const parent = await addSession(ctx, project.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
      payload: {},
    });
    const child = res.json().session;
    // Hard-delete the parent (no HTTP delete yet; DB is the source of truth
    // for cascade correctness).
    const del = ctx.dbh.db
      .prepare("DELETE FROM sessions WHERE id = ?")
      .run(parent.id);
    expect(del.changes).toBe(1);
    const after = ctx.dbh.db
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .get(child.id);
    expect(after).toBeUndefined();
  });

  it("returns 404 for an unknown parent session", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions/no-such-parent/side",
      headers: { cookie: ctx.cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("default session list hides side chats (parent_session_id IS NOT NULL)", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const project = await addProject(ctx);
    const parent = await addSession(ctx, project.id);
    await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
      payload: {},
    });

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: ctx.cookie },
    });
    const sessionList = list.json().sessions as Array<{
      id: string;
      parentSessionId: string | null;
    }>;
    // Only the main thread should be listed — side chats live in their own
    // drawer and must not clutter the home screen.
    expect(sessionList).toHaveLength(1);
    expect(sessionList[0].id).toBe(parent.id);
    expect(sessionList[0].parentSessionId).toBeNull();
  });

  it("returning the existing active side chat is idempotent (no duplicate spawn)", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const project = await addProject(ctx);
    const parent = await addSession(ctx, project.id);

    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
      payload: {},
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().session.id).toBe(first.json().session.id);
  });

  it("GET /api/sessions/:id/side returns the active side chat or null", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const project = await addProject(ctx);
    const parent = await addSession(ctx, project.id);

    const none = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().session).toBeNull();

    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
      payload: {},
    });
    const child = created.json().session;
    const lookup = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${parent.id}/side`,
      headers: { cookie: ctx.cookie },
    });
    expect(lookup.json().session.id).toBe(child.id);
  });
});

// ---------------------------------------------------------------------------
// Context-injection behavior lives in SessionManager. We verify the seed is
// sent to the runner exactly once (on first spawn), is composed from the
// parent's user_message + assistant_text events only, and is NOT written
// back to the child's event log.
// ---------------------------------------------------------------------------

class MockRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  initOpts: RunnerInitOptions;
  sent: string[] = [];
  private listeners = new Set<RunnerListener>();
  constructor(opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
    this.initOpts = opts;
  }
  async start(initial?: string) {
    if (initial) this.sent.push(initial);
  }
  async sendUserMessage(c: string) {
    this.sent.push(c);
  }
  resolvePermission() {}
  resolveAskUserQuestion() {}
  resolvePlanAccept() {}
  async interrupt() {}
  async setPermissionMode(_: PermissionMode) {}
  async dispose() {
    this.listeners.clear();
  }
  on(l: RunnerListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  listenerCount() {
    return this.listeners.size;
  }
  emit(ev: RunnerEvent) {
    for (const l of this.listeners) l(ev);
  }
}

function setupManager() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const grants = new ToolGrantStore(db);
  const project = projects.create({
    name: "p",
    path: "/p/demo",
    trusted: true,
  });
  const parent = sessions.create({
    title: "main",
    projectId: project.id,
    model: "claude-opus-4-8",
    mode: "default",
  });
  const runnersByRole: Record<string, MockRunner> = {};
  const factory: RunnerFactory = {
    create(opts) {
      const r = new MockRunner(opts);
      runnersByRole[opts.sessionId] = r;
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
  return {
    manager,
    sessions,
    projects,
    parent,
    runnersByRole,
    cleanup: () => {
      close();
      cleanup();
    },
  };
}

describe("SessionManager side-chat context injection", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("flushes a context seed BEFORE the first user message and skips tool noise", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);

    // Seed the parent with a mix of event kinds. Only user_message and
    // assistant_text should make it into the seed — tool_use / tool_result /
    // thinking are stripped so the side chat isn't drowned in Bash output.
    s.sessions.appendEvent({
      sessionId: s.parent.id,
      kind: "user_message",
      payload: { text: "refactor the hydration helper" },
    });
    s.sessions.appendEvent({
      sessionId: s.parent.id,
      kind: "assistant_thinking",
      payload: { text: "considering options…" },
    });
    s.sessions.appendEvent({
      sessionId: s.parent.id,
      kind: "tool_use",
      payload: { toolUseId: "t1", name: "Bash", input: { command: "ls" } },
    });
    s.sessions.appendEvent({
      sessionId: s.parent.id,
      kind: "tool_result",
      payload: { toolUseId: "t1", content: "lib/\nsrc/", isError: false },
    });
    s.sessions.appendEvent({
      sessionId: s.parent.id,
      kind: "assistant_text",
      payload: { messageId: "m1", text: "I'll start by reading lib/date.ts.", done: true },
    });

    // Create the side chat.
    const child = s.sessions.create({
      title: "Side chat",
      projectId: s.parent.projectId,
      model: s.parent.model,
      mode: "plan",
      parentSessionId: s.parent.id,
    });

    await s.manager.sendUserMessage(child.id, "is pnpm faster than bun here?");

    const runner = s.runnersByRole[child.id]!;
    expect(runner).toBeDefined();
    // Exactly two SDK pushes: (1) the seed, (2) the real user message.
    expect(runner.sent).toHaveLength(2);
    const [seed, userMsg] = runner.sent;
    expect(userMsg).toBe("is pnpm faster than bun here?");
    // Seed shape: prompt preamble + transcript with only the two kept events.
    expect(seed).toContain("side question");
    expect(seed).toContain("user: refactor the hydration helper");
    expect(seed).toContain("assistant: I'll start by reading lib/date.ts.");
    // And the stripped kinds should NOT leak into the seed.
    expect(seed).not.toContain("considering options");
    expect(seed).not.toContain("Bash");
    expect(seed).not.toContain("tool_result");

    // The child's event log records only the user's real message — NOT the
    // synthetic seed. That's the whole point of /btw.
    const events = s.sessions.listEvents(child.id);
    const userTexts = events
      .filter((e) => e.kind === "user_message")
      .map((e) => (e.payload as { text?: string }).text);
    expect(userTexts).toEqual(["is pnpm faster than bun here?"]);
  });

  it("seeds only on the first user message; subsequent turns send raw content", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.sessions.appendEvent({
      sessionId: s.parent.id,
      kind: "user_message",
      payload: { text: "hi" },
    });
    const child = s.sessions.create({
      title: "Side chat",
      projectId: s.parent.projectId,
      model: s.parent.model,
      mode: "plan",
      parentSessionId: s.parent.id,
    });
    await s.manager.sendUserMessage(child.id, "first");
    await s.manager.sendUserMessage(child.id, "second");
    const runner = s.runnersByRole[child.id]!;
    // seed, first, second — three total, no re-seed
    expect(runner.sent).toHaveLength(3);
    expect(runner.sent[0]).toContain("conversation so far");
    expect(runner.sent[1]).toBe("first");
    expect(runner.sent[2]).toBe("second");
  });

  it("top-level sessions never get a seed even if the parent would", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    await s.manager.sendUserMessage(s.parent.id, "main msg");
    const runner = s.runnersByRole[s.parent.id]!;
    expect(runner.sent).toEqual(["main msg"]);
  });
});
