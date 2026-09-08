import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type {
  UsagePerModel,
  UsageRangeResponse,
  UsageTodayResponse,
  UsageTopSession,
} from "@claudex/shared";

// ---------------------------------------------------------------------------
// /api/usage/* — cross-session token aggregations for the full-screen Usage
// page (mockup s-08 desktop). We attribute every `turn_end` to the owning
// session's *current* model, matching the per-session client math in
// `web/src/lib/usage.ts`. Side chats (`parent_session_id IS NOT NULL`) and
// archived sessions are included on purpose — tokens burned there still
// counted, and a user who archives a session expects "Today" to keep
// reflecting what they actually spent today.
//
// Token math, per turn:
//   tokens = inputTokens + outputTokens + cacheReadInputTokens
//          + cacheCreationInputTokens
//
// Older rows (before agent-runner emitted cache fields) have only
// input/output — they contribute proportionally less, which is correct
// (we don't make up data). A few-dozen-token outlier is harmless in a sum.
// ---------------------------------------------------------------------------

export interface UsageRoutesDeps {
  db: Database.Database;
  /** Override "now" for tests. Defaults to `Date.now`. */
  now?: () => Date;
}

interface SessionMetaRow {
  id: string;
  title: string;
  project_id: string;
  model: string;
  project_name: string | null;
}

interface TurnRow {
  session_id: string;
  created_at: string;
  payload: string;
}

/**
 * Sum a single `turn_end` payload into a token count. Returns 0 if the
 * payload is malformed / missing usage. We intentionally do NOT distinguish
 * input vs output here — the Usage page's "tokens" number is the whole
 * context body shipped to the model plus output.
 *
 * Prefers `billingUsage` (cumulative across SDK sub-calls; written by live
 * runner from the per-call fix onward) over `usage` (per-call snapshot,
 * post-fix; per-API-call as written by the CLI JSONL importer; cumulative
 * on legacy live rows). For new live rows, billingUsage gives a true
 * billing breakdown — every sub-call's cache-read sums correctly. For CLI
 * imports / pre-fix live rows, falling back to `usage` preserves the
 * pre-existing per-call-summed semantics.
 */
function tokensFromTurnPayload(payloadJson: string): number {
  try {
    const payload = JSON.parse(payloadJson) as {
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
      billingUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
    };
    const u = payload?.billingUsage ?? payload?.usage;
    if (!u) return 0;
    return (
      (Number(u.inputTokens ?? 0) | 0) +
      (Number(u.outputTokens ?? 0) | 0) +
      (Number(u.cacheReadInputTokens ?? 0) | 0) +
      (Number(u.cacheCreationInputTokens ?? 0) | 0)
    );
  } catch {
    return 0;
  }
}

/** ISO start-of-day (local time, midnight) for a given Date. */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Local `YYYY-MM-DD` for a given Date — for the 7-day chart's x-axis. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function registerUsageRoutes(
  app: FastifyInstance,
  deps: UsageRoutesDeps,
): Promise<void> {
  const now = deps.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // GET /api/usage/today
  //
  // Sums every `turn_end` token count across every session whose event
  // landed since local midnight. Response also includes:
  //   - sessionCount: number of *distinct* sessions that contributed tokens
  //   - perModel: ranked by total tokens desc
  //   - topSessions: up to 5, ranked by tokens desc
  //
  // Empty DB / no turns today → zero counts + empty arrays. Never 404s.
  // -------------------------------------------------------------------------
  app.get(
    "/api/usage/today",
    { preHandler: app.requireAuth as any },
    async () => {
      const windowStart = startOfLocalDay(now()).toISOString();

      // Pull every turn_end in-window, plus enough session metadata to
      // attribute tokens to a model and surface a title/project. We don't
      // filter on archived — tokens spent count regardless.
      const turnRows = deps.db
        .prepare(
          `SELECT session_id, created_at, payload
           FROM session_events
           WHERE kind = 'turn_end' AND created_at >= ?`,
        )
        .all(windowStart) as TurnRow[];

      const sessionRows = deps.db
        .prepare(
          `SELECT s.id, s.title, s.project_id, s.model, p.name AS project_name
           FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id`,
        )
        .all() as SessionMetaRow[];
      const sessionsById = new Map<string, SessionMetaRow>();
      for (const r of sessionRows) sessionsById.set(r.id, r);

      let totalTokens = 0;
      const perModelTokens = new Map<string, number>();
      const perSessionTokens = new Map<string, number>();

      for (const row of turnRows) {
        const tokens = tokensFromTurnPayload(row.payload);
        if (tokens <= 0) continue;
        totalTokens += tokens;
        perSessionTokens.set(
          row.session_id,
          (perSessionTokens.get(row.session_id) ?? 0) + tokens,
        );
        const meta = sessionsById.get(row.session_id);
        const model = meta?.model ?? "unknown";
        perModelTokens.set(model, (perModelTokens.get(model) ?? 0) + tokens);
      }

      const perModel: UsagePerModel[] = Array.from(perModelTokens.entries())
        .map(([model, tokens]) => ({ model, tokens }))
        .sort((a, b) => b.tokens - a.tokens);

      const topSessions: UsageTopSession[] = Array.from(
        perSessionTokens.entries(),
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([sessionId, tokens]) => {
          const meta = sessionsById.get(sessionId);
          return {
            sessionId,
            title: meta?.title ?? "(deleted)",
            projectId: meta?.project_id ?? "",
            projectName: meta?.project_name ?? null,
            tokens,
          };
        });

      const response: UsageTodayResponse = {
        windowStart,
        totalTokens,
        sessionCount: perSessionTokens.size,
        perModel,
        topSessions,
      };
      return response;
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/usage/range?days=N
  //
  // Returns a zero-padded array of exactly `N` day buckets, oldest first,
  // each carrying a token total and per-model breakdown. Bucketed by LOCAL
  // date so the x-axis labels mean what the user expects. `N` defaults to
  // 7, clamped to 1..90 to keep the query bounded.
  // -------------------------------------------------------------------------
  app.get(
    "/api/usage/range",
    { preHandler: app.requireAuth as any },
    async (req) => {
      const q = req.query as { days?: string };
      const raw = q?.days ? Number(q.days) : 7;
      const days = Number.isFinite(raw)
        ? Math.min(90, Math.max(1, Math.floor(raw)))
        : 7;

      const today = startOfLocalDay(now());
      // windowStart = midnight `days-1` days ago. For days=7 we want today +
      // the previous 6 days = 7 buckets total.
      const windowStart = new Date(today);
      windowStart.setDate(windowStart.getDate() - (days - 1));

      const turnRows = deps.db
        .prepare(
          `SELECT session_id, created_at, payload
           FROM session_events
           WHERE kind = 'turn_end' AND created_at >= ?`,
        )
        .all(windowStart.toISOString()) as TurnRow[];

      const sessionModels = new Map<string, string>();
      const sessionRows = deps.db
        .prepare(`SELECT id, model FROM sessions`)
        .all() as Array<{ id: string; model: string }>;
      for (const r of sessionRows) sessionModels.set(r.id, r.model);

      // Pre-build zero-filled buckets so empty days still render.
      const byDay: Array<{
        date: string;
        totalTokens: number;
        perModel: Map<string, number>;
      }> = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(windowStart);
        d.setDate(d.getDate() + i);
        byDay.push({
          date: localDateKey(d),
          totalTokens: 0,
          perModel: new Map(),
        });
      }
      const bucketByDate = new Map(byDay.map((b) => [b.date, b]));

      for (const row of turnRows) {
        const tokens = tokensFromTurnPayload(row.payload);
        if (tokens <= 0) continue;
        // `row.created_at` is an ISO timestamp in UTC. Convert to a local
        // date key so the bucket matches the chart's axis labels.
        const key = localDateKey(new Date(row.created_at));
        const bucket = bucketByDate.get(key);
        if (!bucket) continue; // outside the window (shouldn't happen)
        bucket.totalTokens += tokens;
        const model = sessionModels.get(row.session_id) ?? "unknown";
        bucket.perModel.set(model, (bucket.perModel.get(model) ?? 0) + tokens);
      }

      const response: UsageRangeResponse = {
        days,
        byDay: byDay.map((b) => ({
          date: b.date,
          totalTokens: b.totalTokens,
          perModel: Array.from(b.perModel.entries())
            .map(([model, tokens]) => ({ model, tokens }))
            .sort((a, b) => b.tokens - a.tokens),
        })),
      };
      return response;
    },
  );
}
