import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp, trustProject } from "./helpers.js";
import { AlertStore } from "../src/alerts/store.js";
import type { AlertsListResponse } from "@claudex/shared";

// -----------------------------------------------------------------------------
// Alerts store + routes + status-transition hook.
//
// We avoid driving the real SessionManager.transitionStatus path (it's
// private) and instead exercise the hook directly via AlertStore +
// createAlertHook for the transition-mapping checks, plus the HTTP layer
// end-to-end for the routes.
// -----------------------------------------------------------------------------

describe("alerts store", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("insert round-trips all fields via listAll", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AlertStore(ctx.dbh.db);

    const row = store.insert({
      kind: "permission_pending",
      sessionId: null,
      projectId: "proj-1",
      title: "Needs approval",
      body: "Bash: rm -rf /",
      payload: { toolUseId: "tu_1" },
    });
    expect(row.kind).toBe("permission_pending");
    expect(row.seenAt).toBeNull();
    expect(row.resolvedAt).toBeNull();
    expect(row.payload).toEqual({ toolUseId: "tu_1" });

    const all = store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(row.id);
  });

  it("markSeen and markAllSeen are idempotent", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AlertStore(ctx.dbh.db);

    const a = store.insert({
      kind: "session_completed",
      sessionId: null,
      projectId: null,
      title: "done",
    });
    const b = store.insert({
      kind: "session_error",
      sessionId: null,
      projectId: null,
      title: "fail",
    });
    expect(store.countUnseen()).toBe(2);

    store.markSeen(a.id);
    expect(store.countUnseen()).toBe(1);
    // Re-marking the same id is a no-op.
    store.markSeen(a.id);
    expect(store.countUnseen()).toBe(1);

    // Bulk clears the remainder.
    const touched = store.markAllSeen();
    expect(touched).toBe(1);
    expect(store.countUnseen()).toBe(0);

    // Nothing left to touch.
    const touchedAgain = store.markAllSeen();
    expect(touchedAgain).toBe(0);
  });

  it("resolveBySessionKind only touches rows of that kind for that session", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AlertStore(ctx.dbh.db);

    // We need real session ids since alerts.session_id has a FK. Create
    // two sessions under one throwaway project.
    const proj = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "p", path: ctx.tmpDir },
    });
    const projectId = (proj.json() as { project: { id: string } }).project.id;
    trustProject(ctx.dbh, projectId);
    const mk = async (title: string) => {
      const r = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId,
          title,
          model: "claude-sonnet-4-6",
          mode: "default",
          worktree: false,
        },
      });
      return (r.json() as { session: { id: string } }).session.id;
    };
    const s1 = await mk("s1");
    const s2 = await mk("s2");

    const a = store.insert({
      kind: "permission_pending",
      sessionId: s1,
      projectId,
      title: "s1 pending",
    });
    const b = store.insert({
      kind: "permission_pending",
      sessionId: s2,
      projectId,
      title: "s2 pending",
    });
    const c = store.insert({
      kind: "session_error",
      sessionId: s1,
      projectId,
      title: "s1 error",
    });

    const n = store.resolveBySessionKind(s1, "permission_pending");
    expect(n).toBe(1);

    const all = store.listAll();
    const byId = new Map(all.map((x) => [x.id, x]));
    expect(byId.get(a.id)?.resolvedAt).not.toBeNull();
    expect(byId.get(b.id)?.resolvedAt).toBeNull(); // different session
    expect(byId.get(c.id)?.resolvedAt).toBeNull(); // different kind
  });

  it("pruneOld drops rows resolved and older than cutoff", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AlertStore(ctx.dbh.db);

    const old = store.insert({
      kind: "session_completed",
      sessionId: null,
      projectId: null,
      title: "old",
    });
    ctx.dbh.db
      .prepare(
        "UPDATE alerts SET created_at = ?, resolved_at = ? WHERE id = ?",
      )
      .run(
        new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
        old.id,
      );

    store.insert({
      kind: "session_completed",
      sessionId: null,
      projectId: null,
      title: "recent",
    });

    const removed = store.pruneOld(30 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    const remaining = store.listAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe("recent");
  });
});

describe("alerts routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("GET /api/alerts requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/alerts",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/alerts returns the list + unseenCount", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AlertStore(ctx.dbh.db);
    store.insert({
      kind: "permission_pending",
      sessionId: null,
      projectId: null,
      title: "hello",
    });
    store.insert({
      kind: "session_completed",
      sessionId: null,
      projectId: null,
      title: "done",
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/alerts",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AlertsListResponse;
    expect(body.alerts).toHaveLength(2);
    expect(body.unseenCount).toBe(2);
  });

  it("POST /api/alerts/seen-all clears unseenCount", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AlertStore(ctx.dbh.db);
    store.insert({
      kind: "session_error",
      sessionId: null,
      projectId: null,
      title: "x",
    });
    store.insert({
      kind: "session_error",
      sessionId: null,
      projectId: null,
      title: "y",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/alerts/seen-all",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, touched: 2 });

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/alerts",
      headers: { cookie: ctx.cookie },
    });
    expect((after.json() as AlertsListResponse).unseenCount).toBe(0);
  });

  it("POST /api/alerts/:id/dismiss stamps resolvedAt and seenAt", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AlertStore(ctx.dbh.db);
    const a = store.insert({
      kind: "session_error",
      sessionId: null,
      projectId: null,
      title: "z",
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/alerts/${a.id}/dismiss`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);

    const after = (
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/alerts",
          headers: { cookie: ctx.cookie },
        })
      ).json() as AlertsListResponse
    ).alerts.find((x) => x.id === a.id)!;
    expect(after.resolvedAt).not.toBeNull();
    expect(after.seenAt).not.toBeNull();
    expect(after.payload?.dismissedByUser).toBe(true);
  });
});

// Integration: when a session transitions into awaiting, the hook
// should append a permission_pending alert. Drive it via the public
// sessions flow that SessionManager actually uses.
describe("alerts hook — status transitions", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("inserts a permission_pending alert when a session enters awaiting and resolves it when it leaves", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    // Create a project + session we can flip via the store directly.
    const proj = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "p", path: ctx.tmpDir },
    });
    expect(proj.statusCode).toBe(200);
    const projectId = (proj.json() as { project: { id: string } }).project.id;
    trustProject(ctx.dbh, projectId);

    const sess = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: ctx.cookie },
      payload: {
        projectId,
        title: "alert-hook test",
        model: "claude-sonnet-4-6",
        mode: "default",
        worktree: false,
      },
    });
    expect(sess.statusCode).toBe(200);
    const sessionId = (sess.json() as { session: { id: string } }).session.id;

    // Manually invoke the alert hook that buildApp wired. We don't have a
    // direct handle on the manager's private hook, but we can drive the
    // same effect by calling the SessionStore.setStatus + reconstructing
    // the hook ourselves — mirrors the production wiring.
    const { createAlertHook } = await import("../src/alerts/events.js");
    const { AlertStore } = await import("../src/alerts/store.js");
    const { SessionStore } = await import("../src/sessions/store.js");
    const store = new AlertStore(ctx.dbh.db);
    const sessions = new SessionStore(ctx.dbh.db);
    let notifications = 0;
    const hook = createAlertHook({
      alerts: store,
      sessions,
      notifyUpdate: () => {
        notifications++;
      },
    });

    // idle → awaiting
    hook(sessionId, "idle", "awaiting");
    let list = store.listAll().filter((a) => a.sessionId === sessionId);
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("permission_pending");
    expect(list[0].resolvedAt).toBeNull();
    expect(notifications).toBe(1);

    // Dedupe: firing the same transition again should NOT insert another row.
    hook(sessionId, "idle", "awaiting");
    list = store.listAll().filter((a) => a.sessionId === sessionId);
    expect(list).toHaveLength(1);

    // awaiting → running  → auto-resolve the permission_pending
    hook(sessionId, "awaiting", "running");
    list = store.listAll().filter((a) => a.sessionId === sessionId);
    expect(list).toHaveLength(1);
    expect(list[0].resolvedAt).not.toBeNull();
    expect(notifications).toBe(2);

    // running → idle  → emit session_completed
    hook(sessionId, "running", "idle");
    list = store.listAll().filter((a) => a.sessionId === sessionId);
    // Previously-resolved permission_pending + new session_completed.
    expect(list.some((a) => a.kind === "session_completed")).toBe(true);
  });

  it("createAlertHook: session_completed is deduped per session — only one latest row", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    // Create a project + session to transition.
    const proj = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "dedup-proj", path: ctx.tmpDir },
    });
    expect(proj.statusCode).toBe(200);
    const projectId = (proj.json() as { project: { id: string } }).project.id;
    trustProject(ctx.dbh, projectId);

    const sess = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: ctx.cookie },
      payload: {
        projectId,
        title: "session-completed-dedup",
        model: "claude-sonnet-4-6",
        mode: "default",
        worktree: false,
      },
    });
    expect(sess.statusCode).toBe(200);
    const sessionId = (sess.json() as { session: { id: string } }).session.id;

    const { createAlertHook } = await import("../src/alerts/events.js");
    const { AlertStore } = await import("../src/alerts/store.js");
    const { SessionStore } = await import("../src/sessions/store.js");
    const store = new AlertStore(ctx.dbh.db);
    const sessions = new SessionStore(ctx.dbh.db);
    const hook = createAlertHook({
      alerts: store,
      sessions,
      notifyUpdate: () => {},
    });

    // First turn completes: one session_completed row.
    hook(sessionId, "running", "idle");
    let list = store
      .listAll()
      .filter((a) => a.sessionId === sessionId && a.kind === "session_completed");
    expect(list).toHaveLength(1);
    const firstId = list[0].id;
    const firstCreated = list[0].createdAt;

    // Give the clock a tick so createdAt can differ. Sleep a couple ms —
    // this is cheap and avoids a flaky same-millisecond string compare.
    await new Promise((r) => setTimeout(r, 5));

    // Second turn completes. We should still have exactly one
    // session_completed row, but it's the NEW one (different id, fresher
    // createdAt, unseen again) — not the old one sitting around.
    hook(sessionId, "running", "idle");
    list = store
      .listAll()
      .filter((a) => a.sessionId === sessionId && a.kind === "session_completed");
    expect(list).toHaveLength(1);
    expect(list[0].id).not.toBe(firstId);
    expect(list[0].createdAt >= firstCreated).toBe(true);
    expect(list[0].seenAt).toBeNull();
    expect(list[0].resolvedAt).toBeNull();
  });
});
