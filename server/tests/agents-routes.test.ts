import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import type { ListSubagentsResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// /api/agents — aggregation over `tool_use` + `tool_result` rows for the
// subagent-family tool names (`Task`, `Agent`, `Explore`). Tests seed events
// directly against the DB so they never have to spin up a real runner.
// ---------------------------------------------------------------------------

type Ctx = Awaited<ReturnType<typeof bootstrapAuthedApp>>;

async function createProject(ctx: Ctx, name = "demo"): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: ctx.cookie },
    payload: { name, path: ctx.tmpDir },
  });
  const id = res.json().project.id as string;
  ctx.dbh.db.prepare("UPDATE projects SET trusted = 1 WHERE id = ?").run(id);
  return id;
}

async function createSession(
  ctx: Ctx,
  projectId: string,
  title: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie: ctx.cookie },
    payload: {
      projectId,
      title,
      model: "claude-opus-4-8",
      mode: "default",
      worktree: false,
    },
  });
  return res.json().session.id as string;
}

function seedEvent(
  ctx: Ctx,
  sessionId: string,
  kind: string,
  seq: number,
  createdAt: string,
  payload: Record<string, unknown>,
): void {
  ctx.dbh.db
    .prepare(
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ev-${Math.random().toString(36).slice(2)}-${seq}`,
      sessionId,
      kind,
      seq,
      createdAt,
      JSON.stringify(payload),
    );
}

describe("GET /api/agents", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("401s without a session cookie", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty items + zero stats on an empty DB", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListSubagentsResponse;
    expect(body.items).toEqual([]);
    expect(body.stats).toEqual({
      activeCount: 0,
      completedToday: 0,
      avgDurationMs: null,
      failureRate: null,
    });
  });

  it(
    "aggregates three Task invocations across two sessions — one done, one failed, one running",
    async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const projectId = await createProject(ctx, "demo");
      const s1 = await createSession(ctx, projectId, "S1");
      const s2 = await createSession(ctx, projectId, "S2");

      // Three tool_use events. Two have matching tool_results (one ok, one
      // error); the third has no result yet, so it should surface as running.
      const now = Date.now();
      const iso = (off: number) => new Date(now + off).toISOString();

      // s1 — run A: Task that completed successfully 2s after dispatch.
      seedEvent(ctx, s1, "tool_use", 1, iso(-60_000), {
        toolUseId: "tu-a",
        name: "Task",
        input: {
          description: "Audit docs",
          prompt: "Look at docs/FEATURES.md\nand summarise",
        },
      });
      seedEvent(ctx, s1, "tool_result", 2, iso(-58_000), {
        toolUseId: "tu-a",
        isError: false,
        content: "found 86 shipped behaviors",
      });

      // s1 — run B: Task that failed 1s after dispatch.
      seedEvent(ctx, s1, "tool_use", 3, iso(-30_000), {
        toolUseId: "tu-b",
        name: "Task",
        input: { description: "Bad job", prompt: "oops" },
      });
      seedEvent(ctx, s1, "tool_result", 4, iso(-29_000), {
        toolUseId: "tu-b",
        isError: true,
        content: "boom: upstream 500",
      });

      // s2 — run C: Task still running (no matching tool_result).
      seedEvent(ctx, s2, "tool_use", 1, iso(-1_000), {
        toolUseId: "tu-c",
        name: "Task",
        input: { description: "still going" },
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as ListSubagentsResponse;

      expect(body.items).toHaveLength(3);

      const byId = new Map(body.items.map((i) => [i.id, i]));
      const a = byId.get("tu-a")!;
      expect(a).toBeDefined();
      expect(a.sessionId).toBe(s1);
      expect(a.sessionTitle).toBe("S1");
      expect(a.projectName).toBe("demo");
      expect(a.toolName).toBe("Task");
      expect(a.description).toBe("Audit docs");
      expect(a.status).toBe("done");
      expect(a.isError).toBe(false);
      expect(a.durationMs).toBe(2000);
      expect(a.finishedAt).not.toBeNull();
      expect(a.resultPreview).toBe("found 86 shipped behaviors");

      const b = byId.get("tu-b")!;
      expect(b.status).toBe("failed");
      expect(b.isError).toBe(true);
      expect(b.durationMs).toBe(1000);
      expect(b.resultPreview).toBe("boom: upstream 500");

      const c = byId.get("tu-c")!;
      expect(c.sessionId).toBe(s2);
      expect(c.status).toBe("running");
      expect(c.finishedAt).toBeNull();
      expect(c.durationMs).toBeNull();
      expect(c.resultPreview).toBeNull();
      // Description falls back through the candidate fields — we only seeded
      // `description`, so that's what lands here.
      expect(c.description).toBe("still going");

      // Stats: one running; two completed (one done, one failed) → 0.5 rate.
      // Both completions landed in the last minute, so they're "today".
      expect(body.stats.activeCount).toBe(1);
      expect(body.stats.completedToday).toBe(2);
      expect(body.stats.failureRate).toBe(0.5);
      expect(body.stats.avgDurationMs).toBe(1500);
    },
  );

  it("?status=active filters to running runs only", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "demo");
    const sid = await createSession(ctx, projectId, "S1");

    const iso = (off: number) => new Date(Date.now() + off).toISOString();

    // Two runs: one finished, one still running.
    seedEvent(ctx, sid, "tool_use", 1, iso(-10_000), {
      toolUseId: "tu-done",
      name: "Task",
      input: { description: "Done one" },
    });
    seedEvent(ctx, sid, "tool_result", 2, iso(-9_000), {
      toolUseId: "tu-done",
      isError: false,
      content: "ok",
    });
    seedEvent(ctx, sid, "tool_use", 3, iso(-1_000), {
      toolUseId: "tu-run",
      name: "Agent",
      input: { description: "Running one" },
    });

    const all = await ctx.app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { cookie: ctx.cookie },
    });
    expect((all.json() as ListSubagentsResponse).items).toHaveLength(2);

    const active = await ctx.app.inject({
      method: "GET",
      url: "/api/agents?status=active",
      headers: { cookie: ctx.cookie },
    });
    expect(active.statusCode).toBe(200);
    const activeBody = active.json() as ListSubagentsResponse;
    expect(activeBody.items).toHaveLength(1);
    expect(activeBody.items[0].id).toBe("tu-run");
    expect(activeBody.items[0].toolName).toBe("Agent");
    // Stats are unconditional — they report the full aggregate regardless of
    // the status filter the caller applied.
    expect(activeBody.stats.activeCount).toBe(1);
    expect(activeBody.stats.completedToday).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Additional edge cases — filters, limit clamp, null-stats invariants.
  // -------------------------------------------------------------------------

  it("?status=done returns non-running rows (done + failed) and rejects an unknown status with 400", async () => {
    // The route's parseStatusFilter accepts `all|active|done` only. "done"
    // is actually "not running" — i.e. it includes both succeeded and
    // failed runs. `?status=failed` is NOT a recognized filter value; it
    // returns 400 `bad_status`. This test pins both behaviors.
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "demo");
    const sid = await createSession(ctx, projectId, "S");

    const iso = (off: number) => new Date(Date.now() + off).toISOString();
    // done run
    seedEvent(ctx, sid, "tool_use", 1, iso(-30_000), {
      toolUseId: "tu-ok",
      name: "Task",
      input: { description: "ok" },
    });
    seedEvent(ctx, sid, "tool_result", 2, iso(-29_000), {
      toolUseId: "tu-ok",
      isError: false,
      content: "fine",
    });
    // failed run
    seedEvent(ctx, sid, "tool_use", 3, iso(-20_000), {
      toolUseId: "tu-bad",
      name: "Task",
      input: { description: "bad" },
    });
    seedEvent(ctx, sid, "tool_result", 4, iso(-19_000), {
      toolUseId: "tu-bad",
      isError: true,
      content: "boom",
    });
    // running run
    seedEvent(ctx, sid, "tool_use", 5, iso(-1_000), {
      toolUseId: "tu-run",
      name: "Task",
      input: { description: "running" },
    });

    const done = await ctx.app.inject({
      method: "GET",
      url: "/api/agents?status=done",
      headers: { cookie: ctx.cookie },
    });
    expect(done.statusCode).toBe(200);
    const doneBody = done.json() as ListSubagentsResponse;
    // `done` filter = "not running" → both succeeded + failed rows surface.
    expect(doneBody.items).toHaveLength(2);
    const statuses = doneBody.items.map((i) => i.status).sort();
    expect(statuses).toEqual(["done", "failed"]);

    // Unknown status → 400 bad_status. Confirms the filter allow-list.
    const bad = await ctx.app.inject({
      method: "GET",
      url: "/api/agents?status=failed",
      headers: { cookie: ctx.cookie },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error?: string }).error).toBe("bad_status");
  });

  it("?limit=1 returns exactly one row and ?limit=501 clamps to the 500 cap", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "demo");
    const sid = await createSession(ctx, projectId, "S");
    const iso = (off: number) => new Date(Date.now() + off).toISOString();

    // Seed 3 runs; ?limit=1 should trim to exactly 1.
    for (let i = 0; i < 3; i++) {
      seedEvent(ctx, sid, "tool_use", i + 1, iso(-(i + 1) * 1000), {
        toolUseId: `tu-${i}`,
        name: "Task",
        input: { description: `run ${i}` },
      });
    }
    const res1 = await ctx.app.inject({
      method: "GET",
      url: "/api/agents?limit=1",
      headers: { cookie: ctx.cookie },
    });
    expect(res1.statusCode).toBe(200);
    expect((res1.json() as ListSubagentsResponse).items).toHaveLength(1);

    // Seed more to push above the 500 cap. Inserting 550 rows is cheap
    // under better-sqlite3 inside one transaction. We don't expect the
    // returned list to contain 550 rows — the cap is 500.
    const insertMany = ctx.dbh.db.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        seedEvent(ctx, sid, "tool_use", 1000 + i, iso(-(1_000 + i) * 10), {
          toolUseId: `tu-bulk-${i}`,
          name: "Task",
          input: { description: `bulk ${i}` },
        });
      }
    });
    insertMany(550);

    const res501 = await ctx.app.inject({
      method: "GET",
      url: "/api/agents?limit=501",
      headers: { cookie: ctx.cookie },
    });
    expect(res501.statusCode).toBe(200);
    // 550 + 3 = 553 rows exist; with limit clamped at 500 we should see 500.
    const body501 = res501.json() as ListSubagentsResponse;
    expect(body501.items).toHaveLength(500);
  });

  it("all-running → failureRate is null (not 0, not NaN) and avgDurationMs is null", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "demo");
    const sid = await createSession(ctx, projectId, "S");
    const iso = (off: number) => new Date(Date.now() + off).toISOString();

    // Two running runs — no tool_result rows.
    seedEvent(ctx, sid, "tool_use", 1, iso(-5_000), {
      toolUseId: "tu-r1",
      name: "Task",
      input: { description: "r1" },
    });
    seedEvent(ctx, sid, "tool_use", 2, iso(-3_000), {
      toolUseId: "tu-r2",
      name: "Agent",
      input: { description: "r2" },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListSubagentsResponse;
    expect(body.items).toHaveLength(2);
    expect(body.stats.activeCount).toBe(2);
    expect(body.stats.completedToday).toBe(0);
    // No completed runs → both derived metrics stay null. The critical bit
    // is `null`, NOT 0 (which would pretend "0% failure" truthfully) and
    // NOT NaN (which would blow the zod schema).
    expect(body.stats.failureRate).toBeNull();
    expect(body.stats.avgDurationMs).toBeNull();
  });

  it("zero subagent events at all → fully zeroed stats and empty items, no crash", async () => {
    // The previous "empty DB" test doesn't create any session — this one
    // creates a session *and* seeds unrelated tool_use events (e.g. Bash,
    // Read) so the SUBAGENT_TOOL_NAMES filter has to skip them. The
    // response should still be shape-clean: zeros, nulls, empty array.
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "demo");
    const sid = await createSession(ctx, projectId, "S");
    const iso = (off: number) => new Date(Date.now() + off).toISOString();

    // Non-subagent tool events — these must not surface as subagent runs.
    seedEvent(ctx, sid, "tool_use", 1, iso(-5_000), {
      toolUseId: "tu-bash",
      name: "Bash",
      input: { command: "ls" },
    });
    seedEvent(ctx, sid, "tool_result", 2, iso(-4_000), {
      toolUseId: "tu-bash",
      isError: false,
      content: "a\nb",
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListSubagentsResponse;
    expect(body.items).toEqual([]);
    expect(body.stats.activeCount).toBe(0);
    expect(body.stats.completedToday).toBe(0);
    expect(body.stats.avgDurationMs).toBeNull();
    expect(body.stats.failureRate).toBeNull();
  });
});
