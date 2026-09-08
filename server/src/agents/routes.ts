import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type {
  ListSubagentsResponse,
  SubagentRunStatus,
  SubagentSummary,
} from "@claudex/shared";

// ---------------------------------------------------------------------------
// GET /api/agents — read-only observability over subagent tool invocations.
//
// A "subagent run" is a `tool_use` event whose tool name is one of the SDK's
// subagent-family tools (see SUBAGENT_TOOL_NAMES), keyed on the event's
// `toolUseId`. Its matching `tool_result` (same `toolUseId`, emitted later
// by the same session) carries the subagent's final text + an `isError`
// flag; that's the terminal state.
//
// We do one SQL pass for each side (tool_use rows, tool_result rows) and
// then JOIN in JS by toolUseId. A SQL join over two `json_extract` columns
// is doable but ugly with SQLite's json1 — the JS side is trivially clear
// and runs fast because we've already filtered tool_use down to the
// subagent-family names in SQL.
//
// Restricted to the SDK's known subagent-family tools (`Task`, `Agent`,
// `Explore`) — if the user ever wires a prompt-template subagent that shows
// up under a different tool name, add it to SUBAGENT_TOOL_NAMES. Documented
// in docs/FEATURES.md under the Subagents section.
// ---------------------------------------------------------------------------

export interface AgentsRoutesDeps {
  db: Database.Database;
  /** Override current time for tests; defaults to `Date.now()`. Used for the
   * "today" (UTC midnight) stats window. */
  now?: () => number;
}

/** Recognized subagent tool names. Edit in one place if the SDK introduces a
 * new family. User-defined prompt-template subagents would need to land here
 * too — today we assume the SDK's built-ins are the only surface. */
export const SUBAGENT_TOOL_NAMES = ["Task", "Agent", "Explore"] as const;
export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

const SUBAGENT_IN_CLAUSE = SUBAGENT_TOOL_NAMES.map((n) => `'${n}'`).join(",");

/** Cap on `?limit` — matches the events-pagination guard. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Preview of the `tool_result` text. 200 chars matches the schema doc. */
const RESULT_PREVIEW_MAX = 200;
/** Short description derived from the tool_use input payload. */
const DESCRIPTION_MAX = 200;

interface ToolUseRow {
  id: string;
  session_id: string;
  session_title: string;
  project_name: string | null;
  seq: number;
  created_at: string;
  tool_use_id: string;
  tool_name: string;
  input_json: string | null;
}

interface ToolResultRow {
  session_id: string;
  tool_use_id: string;
  created_at: string;
  is_error: number | null;
  content: string | null;
}

/** Short, human-friendly label for a tool_use row. Subagent tool inputs tend
 * to carry a `description` (Task) and a `prompt` (Task / Agent / Explore);
 * we prefer description when present, fall back to the prompt's first line.
 */
function summarizeInput(inputJson: string | null): string {
  if (!inputJson) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const obj = parsed as Record<string, unknown>;
  const pick = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const candidate =
    pick(obj.description) ??
    pick(obj.title) ??
    pick(obj.subagent_type) ??
    pick(obj.prompt) ??
    pick(obj.query) ??
    pick(obj.task) ??
    "";
  const firstLine = candidate.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > DESCRIPTION_MAX
    ? firstLine.slice(0, DESCRIPTION_MAX - 1) + "…"
    : firstLine;
}

/** Parse the tool_use `input` JSON column into an object, defensively. Bad or
 * non-object payloads return `{}` so the wire shape (always-object) is stable.
 * Consumers (the /agents expanded view) pretty-print this as-is. */
function parseInputObject(inputJson: string | null): Record<string, unknown> {
  if (!inputJson) return {};
  try {
    const parsed = JSON.parse(inputJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function derivePreview(content: string | null): string | null {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > RESULT_PREVIEW_MAX
    ? trimmed.slice(0, RESULT_PREVIEW_MAX - 1) + "…"
    : trimmed;
}

/** UTC midnight of the day containing `at`. Stats use this as the "today"
 * window so the numbers match how the user reads a calendar date. */
function utcMidnight(at: number): number {
  const d = new Date(at);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    0,
    0,
    0,
    0,
  );
}

export async function registerAgentsRoutes(
  app: FastifyInstance,
  deps: AgentsRoutesDeps,
): Promise<void> {
  const nowFn = deps.now ?? (() => Date.now());

  app.get(
    "/api/agents",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const query = req.query as {
        status?: string;
        limit?: string;
        sessionId?: string;
      };
      const statusFilter = parseStatusFilter(query.status);
      if (statusFilter === "invalid") {
        return reply.code(400).send({ error: "bad_status" });
      }

      const rawLimit = Number.parseInt(query.limit ?? "", 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

      // Optional session-scope filter. When set, the SQL WHERE narrows to
      // tool_use / tool_result rows that live on this session only — used by
      // the per-session Subagents rail / drawer in Chat. An unknown or empty
      // string is treated as "no filter" (same as omitting the param); we
      // don't 404 because the panel might load concurrent with a session
      // delete and surfacing an empty list is friendlier than an error.
      const sessionIdFilter = typeof query.sessionId === "string" && query.sessionId.length > 0
        ? query.sessionId
        : null;

      const snapshot = deps.db.transaction(
        (): ListSubagentsResponse => {
          // One pass for the tool_use side. We hard-filter to the recognized
          // subagent-family tool names in SQL so the JS join doesn't walk
          // every tool_use on the system. When sessionIdFilter is set we
          // narrow the WHERE clause accordingly — the same filter is also
          // applied to the tool_result pass below so both sides stay scoped.
          const toolUseSql =
            `SELECT
               e.id AS id,
               e.session_id AS session_id,
               s.title AS session_title,
               p.name AS project_name,
               e.seq AS seq,
               e.created_at AS created_at,
               json_extract(e.payload, '$.toolUseId') AS tool_use_id,
               json_extract(e.payload, '$.name') AS tool_name,
               json_extract(e.payload, '$.input') AS input_json
             FROM session_events e
             JOIN sessions s ON s.id = e.session_id
             LEFT JOIN projects p ON p.id = s.project_id
             WHERE e.kind = 'tool_use'
               AND json_extract(e.payload, '$.name') IN (${SUBAGENT_IN_CLAUSE})
               AND json_extract(e.payload, '$.toolUseId') IS NOT NULL
               ${sessionIdFilter ? "AND e.session_id = ?" : ""}
             ORDER BY e.created_at DESC`;
          const toolUseRows = (sessionIdFilter
            ? deps.db.prepare(toolUseSql).all(sessionIdFilter)
            : deps.db.prepare(toolUseSql).all()) as ToolUseRow[];

          // Companion pass for every tool_result. In theory we could scope
          // this to only the toolUseIds we just picked, but that would be
          // either a very long `IN (...)` list or a temp table — simpler to
          // fetch all tool_results and look them up by Map. When a per-session
          // filter is active we narrow here too so the scan stays proportional
          // to the session's event stream rather than the whole database.
          const toolResultSql =
            `SELECT
               e.session_id AS session_id,
               e.created_at AS created_at,
               json_extract(e.payload, '$.toolUseId') AS tool_use_id,
               json_extract(e.payload, '$.isError') AS is_error,
               json_extract(e.payload, '$.content') AS content
             FROM session_events e
             WHERE e.kind = 'tool_result'
               AND json_extract(e.payload, '$.toolUseId') IS NOT NULL
               ${sessionIdFilter ? "AND e.session_id = ?" : ""}`;
          const toolResultRows = (sessionIdFilter
            ? deps.db.prepare(toolResultSql).all(sessionIdFilter)
            : deps.db.prepare(toolResultSql).all()) as ToolResultRow[];

          // Index the results by `(sessionId, toolUseId)`. Scoping to the
          // owning session protects us from the theoretical case where two
          // different sessions pick the same toolUseId string — the SDK uses
          // UUID-ish ids, so collision is essentially impossible, but being
          // defensive here is free.
          const resultsByKey = new Map<string, ToolResultRow>();
          for (const row of toolResultRows) {
            if (!row.tool_use_id) continue;
            const key = `${row.session_id}::${row.tool_use_id}`;
            // Keep the earliest tool_result if multiple match (shouldn't
            // happen — the SDK emits exactly one — but this keeps the JOIN
            // deterministic).
            if (!resultsByKey.has(key)) resultsByKey.set(key, row);
          }

          const items: SubagentSummary[] = [];
          for (const use of toolUseRows) {
            if (!use.tool_use_id) continue;
            const key = `${use.session_id}::${use.tool_use_id}`;
            const result = resultsByKey.get(key) ?? null;
            const startedAtMs = Date.parse(use.created_at);
            let finishedAt: string | null = null;
            let durationMs: number | null = null;
            let status: SubagentRunStatus = "running";
            let isError = false;
            let resultPreview: string | null = null;
            if (result) {
              finishedAt = result.created_at;
              const finishedAtMs = Date.parse(finishedAt);
              if (
                Number.isFinite(startedAtMs) &&
                Number.isFinite(finishedAtMs)
              ) {
                durationMs = Math.max(0, finishedAtMs - startedAtMs);
              }
              isError = Boolean(result.is_error);
              status = isError ? "failed" : "done";
              resultPreview = derivePreview(result.content);
            }

            items.push({
              id: use.tool_use_id,
              sessionId: use.session_id,
              sessionTitle: use.session_title,
              projectName: use.project_name,
              toolName: use.tool_name,
              description: summarizeInput(use.input_json),
              input: parseInputObject(use.input_json),
              seq: Number(use.seq) | 0,
              startedAt: use.created_at,
              finishedAt,
              durationMs,
              status,
              isError,
              resultPreview,
            });
          }

          // Stats are computed from the full item set *before* we apply the
          // status filter / limit — the four cards should read the same
          // regardless of which tab the user is on.
          const todayStart = utcMidnight(nowFn());
          let activeCount = 0;
          let doneToday = 0;
          let failedToday = 0;
          let durationSumToday = 0;
          for (const item of items) {
            if (item.status === "running") {
              activeCount++;
              continue;
            }
            if (!item.finishedAt) continue;
            const finishedAtMs = Date.parse(item.finishedAt);
            if (!Number.isFinite(finishedAtMs)) continue;
            if (finishedAtMs < todayStart) continue;
            if (item.status === "done") doneToday++;
            else if (item.status === "failed") failedToday++;
            if (typeof item.durationMs === "number") {
              durationSumToday += item.durationMs;
            }
          }
          const completedToday = doneToday + failedToday;
          const avgDurationMs =
            completedToday > 0
              ? Math.round(durationSumToday / completedToday)
              : null;
          const failureRate =
            completedToday > 0 ? failedToday / completedToday : null;

          // Apply the ?status filter, then trim to ?limit. Keeping filter
          // post-aggregation means the cards stay truthful even when the
          // list is narrowed.
          let filtered = items;
          if (statusFilter === "active") {
            filtered = items.filter((i) => i.status === "running");
          } else if (statusFilter === "done") {
            filtered = items.filter((i) => i.status !== "running");
          }
          const trimmed = filtered.slice(0, limit);

          return {
            items: trimmed,
            stats: {
              activeCount,
              completedToday,
              avgDurationMs,
              failureRate,
            },
          };
        },
      )();

      return snapshot;
    },
  );
}

/** Parse the `?status=` query parameter. Returns `"all" | "active" | "done"`
 * on success, `"invalid"` for an unrecognized value. Unset defaults to
 * `"all"`. */
function parseStatusFilter(
  raw: string | undefined,
): "all" | "active" | "done" | "invalid" {
  if (raw === undefined || raw === "" || raw === "all") return "all";
  if (raw === "active") return "active";
  if (raw === "done") return "done";
  return "invalid";
}
