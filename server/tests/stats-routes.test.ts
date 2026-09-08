import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import type { StatsResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// Stats routes — single-snapshot aggregation over sessions + session_events.
// We seed rows directly against the DB (same pattern as usage-routes.test.ts)
// so the tests stay insulated from the agent-runner mock dance. Each case
// boots a fresh app so state is independent.
// ---------------------------------------------------------------------------

const bootstrap = bootstrapAuthedApp;

interface Ctx {
  app: Awaited<ReturnType<typeof bootstrapAuthedApp>>["app"];
  dbh: Awaited<ReturnType<typeof bootstrapAuthedApp>>["dbh"];
  cookie: string;
  tmpDir: string;
}

async function createProject(ctx: Ctx, name = "demo"): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: ctx.cookie },
    payload: { name, path: ctx.tmpDir },
  });
  const id = res.json().project.id as string;
  // New projects land untrusted (migration 11); flip so createSession works.
  ctx.dbh.db.prepare("UPDATE projects SET trusted = 1 WHERE id = ?").run(id);
  return id;
}

async function createSession(
  ctx: Ctx,
  projectId: string,
  title = "session",
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

function setStatus(ctx: Ctx, sessionId: string, status: string): void {
  // Direct-write bypass of the usual archive flow — the stats aggregator only
  // reads the `status` column, so we don't need to bother with archived_at.
  ctx.dbh.db
    .prepare("UPDATE sessions SET status = ? WHERE id = ?")
    .run(status, sessionId);
}

function seedTurnEnd(
  ctx: Ctx,
  sessionId: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
  seq = 1,
  billingUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
): void {
  ctx.dbh.db
    .prepare(
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
       VALUES (?, ?, 'turn_end', ?, ?, ?)`,
    )
    .run(
      `ev-${Math.random().toString(36).slice(2)}`,
      sessionId,
      seq,
      new Date().toISOString(),
      JSON.stringify(billingUsage ? { usage, billingUsage } : { usage }),
    );
}

function seedToolUse(
  ctx: Ctx,
  sessionId: string,
  toolName: string,
  seq: number,
): void {
  ctx.dbh.db
    .prepare(
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
       VALUES (?, ?, 'tool_use', ?, ?, ?)`,
    )
    .run(
      `ev-${Math.random().toString(36).slice(2)}`,
      sessionId,
      seq,
      new Date().toISOString(),
      JSON.stringify({
        toolUseId: `tu-${seq}`,
        name: toolName,
        input: {},
      }),
    );
}

describe("stats routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("requires auth", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/stats",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns zeros + nulls + empty arrays on an empty DB", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(body.totalSessions).toBe(0);
    expect(body.activeSessions).toBe(0);
    expect(body.archivedSessions).toBe(0);
    expect(body.totalTurns).toBe(0);
    expect(body.avgTurnsPerSession).toBe(0);
    expect(body.totalTokens).toBe(0);
    expect(body.avgTokensPerTurn).toBe(0);
    expect(body.topTools).toEqual([]);
    expect(body.busiestProject).toBeNull();
    expect(body.oldestSession).toBeNull();
    expect(body.newestSession).toBeNull();
  });

  it("aggregates seeded sessions, turns, usage, and tools correctly", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "alpha");

    // Three sessions: one archived, one running, one idle.
    const sArchived = await createSession(ctx, projectId, "zzz-archived");
    const sRunning = await createSession(ctx, projectId, "yyy-running");
    const sIdle = await createSession(ctx, projectId, "xxx-idle");
    setStatus(ctx, sArchived, "archived");
    setStatus(ctx, sRunning, "running");
    // sIdle keeps default status from POST /api/sessions — which is "idle".

    // Nudge `created_at` apart by hand so oldest/newest ordering is stable.
    // Three `createSession` calls inside the same millisecond otherwise tie
    // on created_at and SQLite breaks the tie however it likes.
    ctx.dbh.db
      .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .run("2025-01-01T00:00:00.000Z", sArchived);
    ctx.dbh.db
      .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .run("2025-02-01T00:00:00.000Z", sRunning);
    ctx.dbh.db
      .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .run("2025-03-01T00:00:00.000Z", sIdle);

    // Five turn_end events, distributed across sessions. Token math:
    //   t1: 100 + 50                    = 150
    //   t2: 200 + 100 + 50 (cacheRead)  = 350
    //   t3: 300 + 200                   = 500
    //   t4: 50                           = 50
    //   t5: 1000 + 500 + 100 (cacheCr.) = 1600
    // total = 2650
    seedTurnEnd(ctx, sRunning, { inputTokens: 100, outputTokens: 50 }, 1);
    seedTurnEnd(
      ctx,
      sRunning,
      { inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 50 },
      2,
    );
    seedTurnEnd(ctx, sIdle, { inputTokens: 300, outputTokens: 200 }, 1);
    seedTurnEnd(ctx, sIdle, { inputTokens: 50 }, 2);
    seedTurnEnd(
      ctx,
      sArchived,
      {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 100,
      },
      1,
    );

    // 10 tool_use events across 3 tools: Read x5, Edit x3, Bash x2.
    let seq = 100;
    for (let i = 0; i < 5; i++) seedToolUse(ctx, sRunning, "Read", seq++);
    for (let i = 0; i < 3; i++) seedToolUse(ctx, sIdle, "Edit", seq++);
    for (let i = 0; i < 2; i++) seedToolUse(ctx, sArchived, "Bash", seq++);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;

    // Session status buckets.
    expect(body.totalSessions).toBe(3);
    expect(body.activeSessions).toBe(1); // only running (awaiting + running counted; here just running)
    expect(body.archivedSessions).toBe(1);

    // Turn aggregates.
    expect(body.totalTurns).toBe(5);
    // Non-archived sessions = 2 (running + idle). avg = 5 / 2 = 2.5.
    expect(body.avgTurnsPerSession).toBe(2.5);

    // Token aggregates.
    expect(body.totalTokens).toBe(2650);
    // 2650 / 5 = 530 exactly.
    expect(body.avgTokensPerTurn).toBe(530);

    // Busiest project — only one project, 3 sessions.
    expect(body.busiestProject).not.toBeNull();
    expect(body.busiestProject!.id).toBe(projectId);
    expect(body.busiestProject!.name).toBe("alpha");
    expect(body.busiestProject!.sessionCount).toBe(3);

    // Top tools — Read > Edit > Bash, all three surface because we only have 3.
    expect(body.topTools).toHaveLength(3);
    expect(body.topTools[0]).toEqual({ name: "Read", uses: 5 });
    expect(body.topTools[1]).toEqual({ name: "Edit", uses: 3 });
    expect(body.topTools[2]).toEqual({ name: "Bash", uses: 2 });

    // Oldest / newest session refs by created_at.
    expect(body.oldestSession).not.toBeNull();
    expect(body.newestSession).not.toBeNull();
    // sArchived was created first in this test, sIdle last.
    expect(body.oldestSession!.id).toBe(sArchived);
    expect(body.newestSession!.id).toBe(sIdle);
  });

  // -------------------------------------------------------------------------
  // Edge cases: empty / all-archived / NULL-usage / archive accounting.
  // -------------------------------------------------------------------------

  it("div-by-zero guard: avgTokensPerTurn stays 0 when there are sessions but no turns", async () => {
    // Sessions exist but no turn_end events → totalTurns=0 must not blow up
    // the avgTokensPerTurn division. Also documents the current choice:
    // avgTurnsPerSession is 0 (not null) here — the StatsResponse schema is
    // `z.number().nonnegative()` (non-nullable), and the handler returns 0
    // when `nonArchived === 0` OR `totalTurns === 0`.
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "empty-turns");
    await createSession(ctx, projectId, "no-turns");

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(body.totalSessions).toBe(1);
    expect(body.totalTurns).toBe(0);
    // Non-archived session with zero turns → avg is 0 per the handler's
    // convention. Documented here; if the design changes to "null" that's
    // a wire-shape change + schema change + this assertion.
    expect(body.avgTurnsPerSession).toBe(0);
    // No turns → 0 tokens / 0 avg, no NaN.
    expect(body.totalTokens).toBe(0);
    expect(body.avgTokensPerTurn).toBe(0);
    expect(Number.isNaN(body.avgTokensPerTurn)).toBe(false);
    expect(Number.isNaN(body.avgTurnsPerSession)).toBe(false);
  });

  it("handles turn_end rows with missing / null usage payloads without breaking aggregation", async () => {
    // Three turn_end events with progressively sparser usage:
    //   t1: usage = { inputTokens: 100, outputTokens: 50 }
    //   t2: usage missing entirely → contributes 0 tokens (COALESCE → 0)
    //   t3: usage = {} (present but empty) → also contributes 0 tokens
    // Without the COALESCEs in stats/routes.ts this would crash or NaN.
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "sparse-usage");
    const sid = await createSession(ctx, projectId, "s");

    // t1 — full usage
    seedTurnEnd(ctx, sid, { inputTokens: 100, outputTokens: 50 }, 1);
    // t2 — no `usage` key at all on the payload. Insert raw JSON that skips
    // the field so we're truly testing the NULL-safe aggregate.
    ctx.dbh.db
      .prepare(
        `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
         VALUES (?, ?, 'turn_end', ?, ?, ?)`,
      )
      .run(
        `ev-sparse-2-${Math.random().toString(36).slice(2)}`,
        sid,
        2,
        new Date().toISOString(),
        JSON.stringify({ note: "no usage here" }),
      );
    // t3 — `usage` key present but an empty object.
    ctx.dbh.db
      .prepare(
        `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
         VALUES (?, ?, 'turn_end', ?, ?, ?)`,
      )
      .run(
        `ev-sparse-3-${Math.random().toString(36).slice(2)}`,
        sid,
        3,
        new Date().toISOString(),
        JSON.stringify({ usage: {} }),
      );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(body.totalTurns).toBe(3);
    // Only t1 contributed — 150 tokens total.
    expect(body.totalTokens).toBe(150);
    // 150 / 3 = 50. Integer result — no NaN.
    expect(body.avgTokensPerTurn).toBe(50);
    expect(Number.isFinite(body.avgTokensPerTurn)).toBe(true);
  });

  it("busiestProject: only-archived sessions still count toward busiestProject (documents current behavior)", async () => {
    // Stats routes doc says: "we don't filter archived here on purpose —
    // 'busiest' means 'where have you spent your effort,' and archived rows
    // absolutely counted toward that." This test pins the behavior: a
    // project whose every session is archived still surfaces as busiest
    // with sessionCount === archivedSessionCount.
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "only-archived");
    const s1 = await createSession(ctx, projectId, "a-1");
    const s2 = await createSession(ctx, projectId, "a-2");
    setStatus(ctx, s1, "archived");
    setStatus(ctx, s2, "archived");

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(body.totalSessions).toBe(2);
    expect(body.archivedSessions).toBe(2);
    // Archived sessions DO feed busiestProject per the route's documented
    // stance. sessionCount === totalSessions on this project (both archived).
    expect(body.busiestProject).not.toBeNull();
    expect(body.busiestProject!.id).toBe(projectId);
    expect(body.busiestProject!.sessionCount).toBe(2);
    // avgTurnsPerSession: nonArchived=0 → handler returns 0 (documented).
    expect(body.avgTurnsPerSession).toBe(0);
  });

  it("totalTokens prefers billingUsage (cumulative) over usage when both present", async () => {
    // Live runner from the per-call fix onward writes both fields.
    // `usage` is per-call (drives the ring); `billingUsage` is cumulative
    // (drives billing-style totals). The stats SQL must prefer
    // billingUsage so totalTokens reflects the true billable breakdown
    // across SDK sub-calls, not just the final sub-call's per-call number.
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "billing-priority");
    const sid = await createSession(ctx, projectId, "s-bill");

    // Single turn_end with disagreeing per-call vs cumulative numbers.
    // billingUsage sum = 15 + 50 + 250 + 5 = 320 → expected totalTokens.
    // usage (per-call) sum = 10 + 30 + 150 + 0 = 190 → would be wrong.
    seedTurnEnd(
      ctx,
      sid,
      {
        inputTokens: 10,
        outputTokens: 30,
        cacheReadInputTokens: 150,
        cacheCreationInputTokens: 0,
      },
      1,
      {
        inputTokens: 15,
        outputTokens: 50,
        cacheReadInputTokens: 250,
        cacheCreationInputTokens: 5,
      },
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(body.totalTurns).toBe(1);
    expect(body.totalTokens).toBe(320);
  });

  it("totalTokens falls back to usage when billingUsage is absent (CLI imports / legacy live)", async () => {
    // CLI JSONL importer never writes billingUsage; pre-fix live rows
    // are the same shape. The fallback path keeps these rows contributing
    // to totalTokens — otherwise stats would silently drop per-call data
    // for any session not yet touched by the per-call fix.
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "billing-fallback");
    const sid = await createSession(ctx, projectId, "s-fallback");

    seedTurnEnd(
      ctx,
      sid,
      {
        inputTokens: 10,
        outputTokens: 30,
        cacheReadInputTokens: 150,
        cacheCreationInputTokens: 0,
      },
      1,
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatsResponse;
    expect(body.totalTurns).toBe(1);
    expect(body.totalTokens).toBe(190); // 10 + 30 + 150 + 0
  });
});
