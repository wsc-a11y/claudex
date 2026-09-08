import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import type { UsageRangeResponse, UsageTodayResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// Usage analytics routes
//
// The aggregator sums `turn_end` payloads across every session since local
// midnight (today) or across N days (range). We drive it by seeding
// `session_events` rows directly — that's the same path agent-runner writes
// to and keeps these tests insulated from the whole SDK mock dance.
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
  // Flip trust so the subsequent POST /api/sessions doesn't hit the
  // project_not_trusted gate. Usage routes are not about the trust flow.
  ctx.dbh.db.prepare("UPDATE projects SET trusted = 1 WHERE id = ?").run(id);
  return id;
}

async function createSession(
  ctx: Ctx,
  projectId: string,
  model = "claude-opus-4-8",
  title = "session",
): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie: ctx.cookie },
    payload: {
      projectId,
      title,
      model,
      mode: "default",
      worktree: false,
    },
  });
  return res.json().session.id as string;
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
  createdAt: string,
  billingUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
): void {
  // Match SessionStore.appendEvent shape. We bypass the store here because we
  // need a specific `created_at` timestamp and `seq` isn't load-bearing for
  // the aggregator.
  ctx.dbh.db
    .prepare(
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
       VALUES (?, ?, 'turn_end', ?, ?, ?)`,
    )
    .run(
      `ev-${Math.random().toString(36).slice(2)}`,
      sessionId,
      0,
      createdAt,
      JSON.stringify(billingUsage ? { usage, billingUsage } : { usage }),
    );
}

describe("usage routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  describe("GET /api/usage/today", () => {
    it("requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/today",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns zeros + empty arrays on an empty DB", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/today",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as UsageTodayResponse;
      expect(body.totalTokens).toBe(0);
      expect(body.sessionCount).toBe(0);
      expect(body.perModel).toEqual([]);
      expect(body.topSessions).toEqual([]);
      expect(typeof body.windowStart).toBe("string");
    });

    it("aggregates three sessions across two models into correct totals", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const projectId = await createProject(ctx, "alpha");
      const s1 = await createSession(ctx, projectId, "claude-opus-4-8", "a");
      const s2 = await createSession(ctx, projectId, "claude-opus-4-8", "b");
      const s3 = await createSession(ctx, projectId, "claude-sonnet-4-6", "c");

      const now = new Date().toISOString();
      // s1: 1000 in + 200 out + 500 cacheRead = 1700
      seedTurnEnd(
        ctx,
        s1,
        {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 500,
        },
        now,
      );
      // s2: 100 in + 50 out = 150 (older row, no cache fields)
      seedTurnEnd(ctx, s2, { inputTokens: 100, outputTokens: 50 }, now);
      // s3: 2000 in + 300 out + 200 cacheCreate = 2500
      seedTurnEnd(
        ctx,
        s3,
        {
          inputTokens: 2000,
          outputTokens: 300,
          cacheCreationInputTokens: 200,
        },
        now,
      );

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/today",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as UsageTodayResponse;
      expect(body.totalTokens).toBe(1700 + 150 + 2500);
      expect(body.sessionCount).toBe(3);

      // Two models attributed — opus (s1 + s2) and sonnet (s3).
      const opus = body.perModel.find((m) => m.model === "claude-opus-4-8");
      const sonnet = body.perModel.find((m) => m.model === "claude-sonnet-4-6");
      expect(opus?.tokens).toBe(1700 + 150);
      expect(sonnet?.tokens).toBe(2500);
      // Sorted desc by tokens — sonnet first (2500 > 1850).
      expect(body.perModel[0].model).toBe("claude-sonnet-4-6");

      // Top sessions includes all three, sonnet first, then s1, then s2.
      expect(body.topSessions).toHaveLength(3);
      expect(body.topSessions[0].sessionId).toBe(s3);
      expect(body.topSessions[0].tokens).toBe(2500);
      expect(body.topSessions[0].projectName).toBe("alpha");
      expect(body.topSessions[1].sessionId).toBe(s1);
      expect(body.topSessions[2].sessionId).toBe(s2);
    });

    it("excludes turn_end events older than today's local midnight", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const projectId = await createProject(ctx, "alpha");
      const s1 = await createSession(ctx, projectId);

      // A turn from 3 days ago — out of the "today" window.
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      seedTurnEnd(
        ctx,
        s1,
        { inputTokens: 999999 },
        threeDaysAgo.toISOString(),
      );

      // A fresh turn from now.
      seedTurnEnd(ctx, s1, { inputTokens: 100 }, new Date().toISOString());

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/today",
        headers: { cookie: ctx.cookie },
      });
      const body = res.json() as UsageTodayResponse;
      expect(body.totalTokens).toBe(100);
      expect(body.sessionCount).toBe(1);
    });

    it("skips malformed / zero payloads without crashing", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const projectId = await createProject(ctx, "alpha");
      const s1 = await createSession(ctx, projectId);

      // Malformed JSON payload — should not sink the whole endpoint.
      const now = new Date().toISOString();
      ctx.dbh.db
        .prepare(
          `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
           VALUES ('ev-bad', ?, 'turn_end', 0, ?, 'not-json')`,
        )
        .run(s1, now);
      // Usage present but every field zero.
      seedTurnEnd(ctx, s1, { inputTokens: 0, outputTokens: 0 }, now);
      // A real contribution so we can confirm the endpoint still works.
      seedTurnEnd(ctx, s1, { inputTokens: 42 }, now);

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/today",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as UsageTodayResponse;
      expect(body.totalTokens).toBe(42);
      expect(body.sessionCount).toBe(1);
    });

    it("totalTokens prefers billingUsage (cumulative) over usage when both present", async () => {
      // Live runner from the per-call fix onward writes both. The aggregator
      // must read the cumulative `billingUsage` so multi-tool-use turns'
      // billable cache reads sum correctly. Falling back to per-call would
      // collapse the number to the final sub-call's usage and undercount.
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const projectId = await createProject(ctx, "billing-priority");
      const s1 = await createSession(ctx, projectId);
      const now = new Date().toISOString();

      seedTurnEnd(
        ctx,
        s1,
        { inputTokens: 10, outputTokens: 30, cacheReadInputTokens: 150 },
        now,
        { inputTokens: 15, outputTokens: 50, cacheReadInputTokens: 250 },
      );

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/today",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as UsageTodayResponse;
      // billingUsage sum = 15 + 50 + 250 = 315
      expect(body.totalTokens).toBe(315);
    });
  });

  describe("GET /api/usage/range", () => {
    it("requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/range?days=7",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns exactly 7 zero-padded buckets by default", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/range",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as UsageRangeResponse;
      expect(body.days).toBe(7);
      expect(body.byDay).toHaveLength(7);
      // All zeros on an empty DB.
      for (const day of body.byDay) {
        expect(day.totalTokens).toBe(0);
        expect(day.perModel).toEqual([]);
      }
    });

    it("places turns into three distinct day buckets", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const projectId = await createProject(ctx, "alpha");
      const s1 = await createSession(ctx, projectId);

      const mkDaysAgo = (n: number): string => {
        const d = new Date();
        d.setDate(d.getDate() - n);
        // Ensure we're comfortably inside the local day — midday.
        d.setHours(12, 0, 0, 0);
        return d.toISOString();
      };

      seedTurnEnd(ctx, s1, { inputTokens: 100 }, mkDaysAgo(0));
      seedTurnEnd(ctx, s1, { inputTokens: 200 }, mkDaysAgo(2));
      seedTurnEnd(ctx, s1, { inputTokens: 300 }, mkDaysAgo(5));
      // Out-of-window turn (older than 7 days) — must not appear.
      seedTurnEnd(ctx, s1, { inputTokens: 999999 }, mkDaysAgo(20));

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/usage/range?days=7",
        headers: { cookie: ctx.cookie },
      });
      const body = res.json() as UsageRangeResponse;
      expect(body.byDay).toHaveLength(7);
      const nonZero = body.byDay.filter((d) => d.totalTokens > 0);
      expect(nonZero).toHaveLength(3);
      const totals = nonZero.map((d) => d.totalTokens).sort((a, b) => a - b);
      expect(totals).toEqual([100, 200, 300]);
      // Out-of-window contribution is NOT present.
      expect(body.byDay.some((d) => d.totalTokens === 999999)).toBe(false);
    });

    it("clamps `days` to 1..90 and coerces bad input to 7", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      for (const [query, expected] of [
        ["days=0", 1],
        ["days=200", 90],
        ["days=abc", 7],
      ] as const) {
        const res = await ctx.app.inject({
          method: "GET",
          url: `/api/usage/range?${query}`,
          headers: { cookie: ctx.cookie },
        });
        const body = res.json() as UsageRangeResponse;
        expect(body.days).toBe(expected);
        expect(body.byDay).toHaveLength(expected);
      }
    });
  });
});
