import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { StatsResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// GET /api/stats
//
// Single-snapshot aggregation backing the StatsSheet. Every query runs inside
// one IMMEDIATE transaction so the numbers across cards agree — otherwise the
// session-count COUNT could race with a concurrent archive and disagree with
// the status-bucketed counts on the next line.
//
// Honest zeros on an empty DB: every query below returns 0 / [] / null when
// the table it reads is empty, and the totals shake out to zero without any
// special casing. No fake social metrics — every value here is backed by a
// literal row count or SUM. See `shared/src/models.ts::StatsResponse` for
// the full schema the UI binds to.
// ---------------------------------------------------------------------------

export interface StatsRoutesDeps {
  db: Database.Database;
}

// Row shapes for the handful of SELECTs below. These are cheap local types
// rather than shared DTOs — the result of each query is collapsed into the
// StatsResponse shape before returning.
interface SessionCountsRow {
  total: number;
  active: number;
  archived: number;
  nonArchived: number;
}

interface BusiestProjectRow {
  id: string;
  name: string;
  sessionCount: number;
}

interface TurnAggRow {
  totalTurns: number;
  totalTokens: number;
}

interface TopToolRow {
  name: string;
  uses: number;
}

interface SessionRefRow {
  id: string;
  title: string;
  created_at: string;
}

export async function registerStatsRoutes(
  app: FastifyInstance,
  deps: StatsRoutesDeps,
): Promise<void> {
  app.get(
    "/api/stats",
    { preHandler: app.requireAuth as any },
    async () => {
      // All reads inside a single transaction — SQLite gives us snapshot
      // isolation under WAL, so the aggregates stay consistent even if the
      // session-manager writes an event mid-handler.
      const snapshot = deps.db.transaction((): StatsResponse => {
        // 1) Session status bucket counts in one pass.
        const sessionCounts = deps.db
          .prepare(
            `SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN status IN ('running','awaiting') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
               SUM(CASE WHEN status != 'archived' THEN 1 ELSE 0 END) AS nonArchived
             FROM sessions`,
          )
          .get() as SessionCountsRow | undefined;
        const totalSessions = Number(sessionCounts?.total ?? 0) | 0;
        const activeSessions = Number(sessionCounts?.active ?? 0) | 0;
        const archivedSessions = Number(sessionCounts?.archived ?? 0) | 0;
        const nonArchived = Number(sessionCounts?.nonArchived ?? 0) | 0;

        // 2) Busiest project by session row count. We don't filter archived
        //    here on purpose — "busiest" means "where have you spent your
        //    effort," and archived rows absolutely counted toward that. Ties
        //    break by `MIN(name)` so the pick is stable.
        const busiestRow = deps.db
          .prepare(
            `SELECT p.id AS id, p.name AS name, COUNT(s.id) AS sessionCount
             FROM projects p
             JOIN sessions s ON s.project_id = p.id
             GROUP BY p.id
             ORDER BY sessionCount DESC, p.name ASC
             LIMIT 1`,
          )
          .get() as BusiestProjectRow | undefined;
        const busiestProject = busiestRow
          ? {
              id: String(busiestRow.id),
              name: String(busiestRow.name),
              sessionCount: Number(busiestRow.sessionCount) | 0,
            }
          : null;

        // 3) Turn + token aggregates. `json_extract` (SQLite's json1, bundled
        //    with better-sqlite3) pulls the four usage fields out of each
        //    turn_end payload. Each field uses
        //    `COALESCE(json_extract(...,'$.billingUsage.X'),
        //              json_extract(...,'$.usage.X'), 0)`
        //    so live rows from the per-call fix onward sum the cumulative
        //    `billingUsage` (true billable breakdown across SDK sub-calls),
        //    while CLI imports / pre-fix live rows fall back to per-call
        //    `usage` and keep their existing summed semantics. One missing
        //    field doesn't poison the rest.
        const turnAgg = deps.db
          .prepare(
            `SELECT
               COUNT(*) AS totalTurns,
               COALESCE(SUM(
                 COALESCE(json_extract(payload, '$.billingUsage.inputTokens'), json_extract(payload, '$.usage.inputTokens'), 0)
                 + COALESCE(json_extract(payload, '$.billingUsage.outputTokens'), json_extract(payload, '$.usage.outputTokens'), 0)
                 + COALESCE(json_extract(payload, '$.billingUsage.cacheReadInputTokens'), json_extract(payload, '$.usage.cacheReadInputTokens'), 0)
                 + COALESCE(json_extract(payload, '$.billingUsage.cacheCreationInputTokens'), json_extract(payload, '$.usage.cacheCreationInputTokens'), 0)
               ), 0) AS totalTokens
             FROM session_events
             WHERE kind = 'turn_end'`,
          )
          .get() as TurnAggRow | undefined;
        const totalTurns = Number(turnAgg?.totalTurns ?? 0) | 0;
        const totalTokens = Number(turnAgg?.totalTokens ?? 0) | 0;

        // 4) Top 5 tools by tool_use count. Tool name lives in the event's
        //    JSON payload; same json_extract trick. Ties break alphabetically
        //    so the list is stable across snapshots.
        //
        //    Query quoted in the report:
        //      SELECT json_extract(payload,'$.name') AS name, COUNT(*) AS uses
        //      FROM session_events
        //      WHERE kind = 'tool_use' AND json_extract(payload,'$.name') IS NOT NULL
        //      GROUP BY name
        //      ORDER BY uses DESC, name ASC
        //      LIMIT 5;
        const topToolsRows = deps.db
          .prepare(
            `SELECT json_extract(payload, '$.name') AS name, COUNT(*) AS uses
             FROM session_events
             WHERE kind = 'tool_use'
               AND json_extract(payload, '$.name') IS NOT NULL
             GROUP BY name
             ORDER BY uses DESC, name ASC
             LIMIT 5`,
          )
          .all() as TopToolRow[];
        const topTools = topToolsRows.map((r) => ({
          name: String(r.name ?? "unknown"),
          uses: Number(r.uses) | 0,
        }));

        // 5) Oldest + newest session refs, by `created_at`. Two cheap scans
        //    over an already-indexed column; keeping them split is clearer
        //    than a single window query. Both return null on empty tables.
        const oldestRow = deps.db
          .prepare(
            `SELECT id, title, created_at
             FROM sessions
             ORDER BY created_at ASC
             LIMIT 1`,
          )
          .get() as SessionRefRow | undefined;
        const newestRow = deps.db
          .prepare(
            `SELECT id, title, created_at
             FROM sessions
             ORDER BY created_at DESC
             LIMIT 1`,
          )
          .get() as SessionRefRow | undefined;
        const oldestSession = oldestRow
          ? {
              id: String(oldestRow.id),
              title: String(oldestRow.title),
              createdAt: String(oldestRow.created_at),
            }
          : null;
        const newestSession = newestRow
          ? {
              id: String(newestRow.id),
              title: String(newestRow.title),
              createdAt: String(newestRow.created_at),
            }
          : null;

        // Derived averages. `avgTurnsPerSession` divides by non-archived
        // session count per spec — an archived session's turns still count
        // toward totalTurns but we normalize against the surface the user
        // currently sees. Rounded to 1 decimal via a *10/round/÷10 dance
        // so the wire value is a clean `number` (zod schema: nonnegative).
        const avgTurnsPerSession =
          nonArchived > 0
            ? Math.round((totalTurns / nonArchived) * 10) / 10
            : 0;
        const avgTokensPerTurn =
          totalTurns > 0 ? Math.round(totalTokens / totalTurns) : 0;

        return {
          totalSessions,
          activeSessions,
          archivedSessions,
          totalTurns,
          avgTurnsPerSession,
          busiestProject,
          topTools,
          avgTokensPerTurn,
          totalTokens,
          oldestSession,
          newestSession,
        };
      })();

      return snapshot;
    },
  );
}
