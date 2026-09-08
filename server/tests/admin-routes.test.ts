import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp, trustProject } from "./helpers.js";
import { resolvePendingRestartResults } from "../src/transport/pending-restart-sweep.js";

// ---------------------------------------------------------------------------
// Admin routes — POST /api/admin/restart.
//
// In test mode (NODE_ENV=test, set by vitest) the handler short-circuits
// after writing an audit row: it returns `{ ok: true, dryRun: true }`
// without spawning a detached worker and without killing the process. So
// we can exercise auth + the audit write here without actually
// restarting vitest's worker.
//
// The real spawn/shutdown path is deliberately NOT unit-tested: it's
// exercised by the operator manually via `node scripts/restart.mjs` or
// by the running server receiving the POST. Mocking the detach primitives
// accurately is harder than just trying it live.
// ---------------------------------------------------------------------------

describe("admin routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/restart",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns dryRun:true in test mode and records an audit event", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/restart",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; dryRun?: boolean };
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);

    // Audit row should exist. We read it directly from the DB so the test
    // doesn't depend on the audit HTTP surface.
    const row = ctx.dbh.db
      .prepare(
        "SELECT event, user_id FROM audit_events WHERE event = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get("server_restart") as { event: string; user_id: string | null } | undefined;
    expect(row?.event).toBe("server_restart");
    expect(typeof row?.user_id === "string").toBe(true);
  });

  it("persists a pending_restart_results row when session_id + tool_use_id are supplied", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/restart",
      headers: { cookie: ctx.cookie },
      payload: { sessionId: "test-session-abc", toolUseId: "tu_xyz" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      dryRun?: boolean;
      pendingResult?: { sessionId: string; toolUseId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.pendingResult).toEqual({
      sessionId: "test-session-abc",
      toolUseId: "tu_xyz",
    });

    // Row is in the scratch table, ready for the next boot's sweep to pick up.
    const row = ctx.dbh.db
      .prepare(
        "SELECT tool_use_id, session_id FROM pending_restart_results WHERE tool_use_id = ?",
      )
      .get("tu_xyz") as
      | { tool_use_id: string; session_id: string }
      | undefined;
    expect(row?.tool_use_id).toBe("tu_xyz");
    expect(row?.session_id).toBe("test-session-abc");
  });

  it("skips the pending_restart_results write when no ids are supplied (legacy body-less call)", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/restart",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; pendingResult?: unknown };
    expect(body.ok).toBe(true);
    expect(body.pendingResult).toBeUndefined();

    const count = ctx.dbh.db
      .prepare("SELECT COUNT(*) as n FROM pending_restart_results")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("boot sweep turns a pending row into a synthetic tool_result and idles the session", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    // Need a real session to attach the synthetic tool_result to.
    const projRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "test-proj", path: ctx.tmpDir },
    });
    expect(projRes.statusCode).toBe(200);
    const projectId = (projRes.json() as { project: { id: string } })
      .project.id;
    trustProject(ctx.dbh, projectId);

    const sessRes = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: ctx.cookie },
      payload: {
        projectId,
        title: "restart-sweep test session",
        model: "claude-sonnet-4-6",
        mode: "default",
        worktree: false,
      },
    });
    expect(sessRes.statusCode).toBe(200);
    const sessionId = (sessRes.json() as { session: { id: string } }).session
      .id;
    const toolUseId = "tu_boot_sweep";

    // Inject the pending row directly — this is what
    // POST /api/admin/restart writes in production.
    ctx.dbh.db
      .prepare(
        `INSERT INTO pending_restart_results
           (tool_use_id, session_id, created_at)
           VALUES (?, ?, ?)`,
      )
      .run(toolUseId, sessionId, new Date().toISOString());

    // Run the sweep that fires at buildApp boot time.
    await resolvePendingRestartResults(ctx.dbh.db, ctx.manager);

    // Row was consumed.
    const remaining = ctx.dbh.db
      .prepare(
        "SELECT tool_use_id FROM pending_restart_results WHERE tool_use_id = ?",
      )
      .get(toolUseId);
    expect(remaining).toBeUndefined();

    // Synthetic tool_result event landed with isError=false. Read the most
    // recent tool_result on this session.
    const ev = ctx.dbh.db
      .prepare(
        `SELECT kind, payload FROM session_events
           WHERE session_id = ? AND kind = 'tool_result'
           ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId) as { kind: string; payload: string } | undefined;
    expect(ev?.kind).toBe("tool_result");
    const payload = JSON.parse(ev!.payload) as {
      toolUseId: string;
      content: string;
      isError: boolean;
    };
    expect(payload.toolUseId).toBe(toolUseId);
    expect(payload.isError).toBe(false);
    expect(payload.content.toLowerCase()).toContain("restarted");
  });
});
