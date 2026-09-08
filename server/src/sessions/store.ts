import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  EffortLevel,
  EventKind,
  ModelId,
  PermissionMode,
  Session,
  SessionEvent,
  SessionStatus,
} from "@claudex/shared";
import { defaultEffortForModel } from "@claudex/shared";
import { SearchStore } from "../search/store.js";

interface SessionRow {
  id: string;
  title: string;
  project_id: string;
  branch: string | null;
  worktree_path: string | null;
  status: string;
  model: string;
  mode: string;
  effort: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  archived_at: string | null;
  sdk_session_id: string | null;
  parent_session_id: string | null;
  forked_from_session_id: string | null;
  stats_messages: number;
  stats_files_changed: number;
  stats_lines_added: number;
  stats_lines_removed: number;
  stats_context_pct: number;
  stats_computed_seq: number;
  cli_jsonl_seq: number;
  adopted_from_cli: number;
  tags: string;
  pinned: number;
  // Not a physical column — populated by the correlated subquery wrapped
  // into every SELECT via `SESSION_SELECT_COLS`. Raw `payload.$.text` from
  // the most recent user_message event on this session, or NULL if the
  // session has no user messages yet. Trimmed + truncated in JS by
  // `toSession`. Optional because the `create` path constructs a row
  // literal before the event exists and passes it to `INSERT` — better-
  // sqlite3 would reject the extra param if we always set it here.
  last_user_message?: string | null;
}

/**
 * Columns we append to every `SELECT ... FROM sessions` so the Session DTO
 * has a `lastUserMessage` preview without requiring a separate round-trip
 * (or a denormalised column that would need its own sync path). The
 * correlated subquery uses `idx_events_session_seq` (session_id, seq) and
 * short-circuits on the first matching row — cheap even with thousands of
 * events per session.
 */
const SESSION_SELECT_COLS = `sessions.*, (
    SELECT json_extract(payload, '$.text')
      FROM session_events
     WHERE session_id = sessions.id AND kind = 'user_message'
     ORDER BY seq DESC
     LIMIT 1
  ) AS last_user_message`;

/**
 * Trim + truncate a raw user_message payload string into the single-line
 * preview we ship to clients. Collapses whitespace so multi-line prompts
 * render as one line in the Home list, and caps length at 200 chars with
 * an ellipsis. Returns null when the input is null/empty — keeps the
 * Session DTO's `lastUserMessage: string | null` honest.
 */
function toPreview(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const collapsed = String(raw).replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > 200
    ? `${collapsed.slice(0, 200)}…`
    : collapsed;
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Malformed rows (shouldn't happen; the column is NOT NULL DEFAULT '[]')
    // degrade to empty rather than crash every list call.
  }
  return [];
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    status: row.status as SessionStatus,
    model: row.model as ModelId,
    mode: row.mode as PermissionMode,
    // `effort` is NOT NULL with DEFAULT 'medium' at the SQL level, but
    // legacy rows written before migration 23 existed can still surface a
    // missing value here during the migration window — coerce defensively.
    effort: ((row.effort as EffortLevel | undefined) ?? "medium") as EffortLevel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    archivedAt: row.archived_at,
    sdkSessionId: row.sdk_session_id,
    parentSessionId: row.parent_session_id,
    forkedFromSessionId: row.forked_from_session_id,
    cliJsonlSeq: row.cli_jsonl_seq ?? 0,
    adoptedFromCli: row.adopted_from_cli === 1,
    tags: parseTags(row.tags),
    pinned: row.pinned === 1,
    lastUserMessage: toPreview(row.last_user_message),
    stats: {
      messages: row.stats_messages,
      filesChanged: row.stats_files_changed,
      linesAdded: row.stats_lines_added,
      linesRemoved: row.stats_lines_removed,
      contextPct: row.stats_context_pct,
    },
  };
}

export interface SessionCreateInput {
  id?: string;
  title: string;
  projectId: string;
  model: ModelId;
  mode: PermissionMode;
  effort?: EffortLevel;
  worktreePath?: string | null;
  branch?: string | null;
  parentSessionId?: string | null;
  forkedFromSessionId?: string | null;
}

export class SessionStore {
  // Search index sync. Wrapped in try/catch at each call site via the
  // SearchStore's internal best-effort semantics — an FTS5 failure must
  // never block the primary write that caused it.
  private readonly search: SearchStore;

  // Prepared-statement cache. Populated lazily on first use of each method
  // so we don't pay the prepare() cost on every call to the hottest write
  // paths (appendEvent, nextSeq, touchLastMessage, setStatus). Methods
  // whose SQL is assembled from runtime-variable WHERE clauses (e.g.
  // listEvents' pagination forms) are left uncached.
  private readonly stmts: {
    listAll: Statement | null;
    listByProject: Statement | null;
    listChildren: Statement | null;
    findById: Statement | null;
    findBySdkSessionId: Statement | null;
    create: Statement | null;
    setStatus: Statement | null;
    setTitle: Statement | null;
    setModel: Statement | null;
    setMode: Statement | null;
    setEffort: Statement | null;
    setTags: Statement | null;
    setPinned: Statement | null;
    setSdkSessionId: Statement | null;
    touchLastMessage: Statement | null;
    forkMaxSeq: Statement | null;
    forkSelectEvents: Statement | null;
    archive: Statement | null;
    deleteById: Statement | null;
    bumpStats: Statement | null;
    setStats: Statement | null;
    setContextPctRaw: Statement | null;
    listStaleStats: Statement | null;
    nextSeq: Statement | null;
    appendEvent: Statement | null;
    countEvents: Statement | null;
    oldestEventSeq: Statement | null;
    getCliJsonlSeq: Statement | null;
    setCliJsonlSeq: Statement | null;
    setAdoptedFromCli: Statement | null;
    findLastEventByKind: Statement | null;
    deleteEventsAboveSeq: Statement | null;
    updateEventPayload: Statement | null;
    selectEventKind: Statement | null;
  } = {
    listAll: null,
    listByProject: null,
    listChildren: null,
    findById: null,
    findBySdkSessionId: null,
    create: null,
    setStatus: null,
    setTitle: null,
    setModel: null,
    setMode: null,
    setEffort: null,
    setTags: null,
    setPinned: null,
    setSdkSessionId: null,
    touchLastMessage: null,
    forkMaxSeq: null,
    forkSelectEvents: null,
    archive: null,
    deleteById: null,
    bumpStats: null,
    setStats: null,
    setContextPctRaw: null,
    listStaleStats: null,
    nextSeq: null,
    appendEvent: null,
    countEvents: null,
    oldestEventSeq: null,
    getCliJsonlSeq: null,
    setCliJsonlSeq: null,
    setAdoptedFromCli: null,
    findLastEventByKind: null,
    deleteEventsAboveSeq: null,
    updateEventPayload: null,
    selectEventKind: null,
  };

  constructor(private readonly db: Database.Database) {
    this.search = new SearchStore(db);
  }

  private lazyStmt<K extends keyof SessionStore["stmts"]>(
    key: K,
    sql: string,
  ): Statement {
    return (this.stmts[key] ??= this.db.prepare(sql));
  }

  // ---- sessions ----------------------------------------------------------

  // By default hides `/btw` side chats (parent_session_id IS NOT NULL) —
  // they shouldn't clutter the home session list. Pass `includeSideChats`
  // when something (the settings sheet, a debug view) explicitly wants
  // them.
  list(opts?: { includeArchived?: boolean; includeSideChats?: boolean }): Session[] {
    const rows = this.lazyStmt(
      "listAll",
      `SELECT ${SESSION_SELECT_COLS} FROM sessions
         WHERE (? = 1 OR archived_at IS NULL)
           AND (? = 1 OR parent_session_id IS NULL)
         ORDER BY updated_at DESC`,
    ).all(
      opts?.includeArchived ? 1 : 0,
      opts?.includeSideChats ? 1 : 0,
    ) as SessionRow[];
    return rows.map(toSession);
  }

  listByProject(projectId: string): Session[] {
    const rows = this.lazyStmt(
      "listByProject",
      `SELECT ${SESSION_SELECT_COLS} FROM sessions
         WHERE project_id = ? AND parent_session_id IS NULL
         ORDER BY updated_at DESC`,
    ).all(projectId) as SessionRow[];
    return rows.map(toSession);
  }

  /** List every side chat whose parent is `parentId`, newest first. */
  listChildren(parentId: string): Session[] {
    const rows = this.lazyStmt(
      "listChildren",
      `SELECT ${SESSION_SELECT_COLS} FROM sessions
         WHERE parent_session_id = ?
         ORDER BY created_at DESC`,
    ).all(parentId) as SessionRow[];
    return rows.map(toSession);
  }

  findById(id: string): Session | null {
    const row = this.lazyStmt(
      "findById",
      `SELECT ${SESSION_SELECT_COLS} FROM sessions WHERE id = ?`,
    ).get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  /**
   * Look up a session by its Agent SDK / CLI session_id. Used by the CLI
   * import path to keep adoption idempotent — re-importing a session that's
   * already adopted should return the existing row rather than duplicate it.
   */
  findBySdkSessionId(sdkSessionId: string): Session | null {
    const row = this.lazyStmt(
      "findBySdkSessionId",
      `SELECT ${SESSION_SELECT_COLS} FROM sessions WHERE sdk_session_id = ?`,
    ).get(sdkSessionId) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  /**
   * Every session whose status is in `statuses`. Used by the on-boot sweep
   * in `SessionManager.sweepStuckOnBoot` to locate rows that were active
   * when the process exited and therefore lost their in-memory watchdog
   * timer. Ordered by `updated_at DESC` for stable log output.
   *
   * Not exposed on the HTTP surface — it's a management primitive only.
   * Callers pass a non-empty array of status literals; an empty array
   * short-circuits to `[]` so we don't emit a malformed IN clause.
   */
  listByStatuses(statuses: SessionStatus[]): Session[] {
    if (statuses.length === 0) return [];
    // Build a parameterized IN clause sized to the input. Can't use
    // lazyStmt's cache because the arity varies per call; SQLite's prepared
    // statement parser requires a literal number of `?`.
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_SELECT_COLS} FROM sessions WHERE status IN (${placeholders}) ORDER BY updated_at DESC`,
      )
      .all(...statuses) as SessionRow[];
    return rows.map(toSession);
  }

  /**
   * Non-archived sessions whose `stats_context_pct` was never populated but
   * which have at least one `turn_end` recorded. Used by the boot-time
   * backfill to seed the context ring for sessions whose most recent turn
   * predates the runtime that stamps the field on each `turn_end`.
   */
  listSessionsNeedingContextBackfill(): Array<{ id: string; model: string }> {
    return this.db
      .prepare(
        `SELECT id, model FROM sessions
           WHERE stats_context_pct = 0
             AND stats_messages > 0
             AND archived_at IS NULL`,
      )
      .all() as Array<{ id: string; model: string }>;
  }

  /**
   * Overwrite `stats_context_pct` without touching `updated_at`. Used by the
   * boot backfill — a derived projection must not disturb the session list's
   * recency ordering (same reasoning as `setStats`).
   */
  setContextPctRaw(id: string, pct: number): void {
    this.lazyStmt(
      "setContextPctRaw",
      `UPDATE sessions SET stats_context_pct = ? WHERE id = ?`,
    ).run(pct, id);
  }

  create(input: SessionCreateInput): Session {
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: input.id ?? nanoid(12),
      title: input.title,
      project_id: input.projectId,
      branch: input.branch ?? null,
      worktree_path: input.worktreePath ?? null,
      status: "idle",
      model: input.model,
      mode: input.mode,
      effort: input.effort ?? defaultEffortForModel(input.model),
      created_at: now,
      updated_at: now,
      last_message_at: null,
      archived_at: null,
      sdk_session_id: null,
      parent_session_id: input.parentSessionId ?? null,
      forked_from_session_id: input.forkedFromSessionId ?? null,
      stats_messages: 0,
      stats_files_changed: 0,
      stats_lines_added: 0,
      stats_lines_removed: 0,
      stats_context_pct: 0,
      stats_computed_seq: -1,
      cli_jsonl_seq: 0,
      adopted_from_cli: 0,
      tags: "[]",
      pinned: 0,
    };
    this.lazyStmt(
      "create",
      `INSERT INTO sessions (
           id, title, project_id, branch, worktree_path, status, model, mode,
           effort,
           created_at, updated_at, last_message_at, archived_at, sdk_session_id,
           parent_session_id, forked_from_session_id,
           stats_messages, stats_files_changed, stats_lines_added,
           stats_lines_removed, stats_context_pct, stats_computed_seq,
           cli_jsonl_seq, adopted_from_cli, tags, pinned
         ) VALUES (
           @id, @title, @project_id, @branch, @worktree_path, @status, @model, @mode,
           @effort,
           @created_at, @updated_at, @last_message_at, @archived_at, @sdk_session_id,
           @parent_session_id, @forked_from_session_id,
           @stats_messages, @stats_files_changed, @stats_lines_added,
           @stats_lines_removed, @stats_context_pct, @stats_computed_seq,
           @cli_jsonl_seq, @adopted_from_cli, @tags, @pinned
         )`,
    ).run(row);
    this.search.upsertTitle(row.id, row.title);
    return toSession(row);
  }

  setStatus(id: string, status: SessionStatus): void {
    this.lazyStmt(
      "setStatus",
      "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
    ).run(status, new Date().toISOString(), id);
  }

  setTitle(id: string, title: string): void {
    this.lazyStmt(
      "setTitle",
      "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
    ).run(title, new Date().toISOString(), id);
    this.search.upsertTitle(id, title);
  }

  setModel(id: string, model: ModelId): void {
    this.lazyStmt(
      "setModel",
      "UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?",
    ).run(model, new Date().toISOString(), id);
  }

  setMode(id: string, mode: PermissionMode): void {
    this.lazyStmt(
      "setMode",
      "UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?",
    ).run(mode, new Date().toISOString(), id);
  }

  setEffort(id: string, effort: EffortLevel): void {
    this.lazyStmt(
      "setEffort",
      "UPDATE sessions SET effort = ?, updated_at = ? WHERE id = ?",
    ).run(effort, new Date().toISOString(), id);
  }

  /**
   * Replace the session's tag list. Caller is responsible for validating
   * individual tags (see `SessionTag` in `@claudex/shared` — lowercase
   * ASCII letters/digits/dashes, 1..24 chars) and the 8-tag cap; the store
   * just serializes whatever array it's given. De-duplicates preserving
   * first-occurrence order so the UI doesn't get surprised by a round-trip
   * that mutates the array.
   */
  setTags(id: string, tags: string[]): void {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of tags) {
      if (seen.has(t)) continue;
      seen.add(t);
      deduped.push(t);
    }
    this.lazyStmt(
      "setTags",
      "UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(deduped), new Date().toISOString(), id);
  }

  /**
   * Pin / unpin a session. Pinned rows sort to the top of Home's list
   * regardless of activity recency. Idempotent — re-pinning an already-pinned
   * row still bumps `updated_at` (the route layer checks whether the flag
   * actually changed before caring about warnings, but the store intentionally
   * stays dumb).
   */
  setPinned(id: string, pinned: boolean): void {
    this.lazyStmt(
      "setPinned",
      "UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?",
    ).run(pinned ? 1 : 0, new Date().toISOString(), id);
  }

  /**
   * Persist the Agent SDK session_id for a claudex session. First-write-wins:
   * once set, subsequent calls are no-ops, because `resume` on a live SDK
   * conversation re-emits the same id and we don't want to thrash the row.
   * Returns true if the write happened, false if the row already had one.
   */
  setSdkSessionId(id: string, sdkSessionId: string): boolean {
    const res = this.lazyStmt(
      "setSdkSessionId",
      `UPDATE sessions
         SET sdk_session_id = ?, updated_at = ?
         WHERE id = ? AND sdk_session_id IS NULL`,
    ).run(sdkSessionId, new Date().toISOString(), id);
    return res.changes > 0;
  }

  touchLastMessage(id: string): void {
    const now = new Date().toISOString();
    this.lazyStmt(
      "touchLastMessage",
      "UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, id);
  }

  /**
   * Fork a session at `upToSeq` into a brand-new session row under the same
   * project. The new row inherits `project_id`, `model`, and `mode` from the
   * source; it does NOT inherit `sdk_session_id` (the fork is a fresh SDK
   * conversation — the model has no idea it was forked) or `parent_session_id`
   * (forks aren't side chats, they're top-level siblings). Status starts
   * `idle` and stats start at zero.
   *
   * Events with `seq <= upToSeq` are copied verbatim (payload, kind,
   * created_at) with fresh ids and a normalized 1..N seq sequence so the
   * fork reads top-to-bottom without holes. If `upToSeq` is omitted we fork
   * at the latest event in the source. Title falls back to
   * `"Fork of <source.title>"`, truncated to 60 chars with an ellipsis when
   * the source title is long.
   *
   * Returns the new Session, or null when the source doesn't exist. Archived
   * sources are left to the caller to reject — the store only knows about
   * rows.
   */
  forkSession(
    sourceId: string,
    upToSeq?: number,
    newTitle?: string,
  ): Session | null {
    const source = this.findById(sourceId);
    if (!source) return null;

    // Resolve the cutoff seq. When no upToSeq is given, fork at the latest
    // event; when the source has no events at all, cutoff stays at -1 so the
    // INSERT-SELECT below copies nothing (the fork starts empty).
    let cutoff: number;
    if (upToSeq === undefined) {
      const row = this.lazyStmt(
        "forkMaxSeq",
        "SELECT COALESCE(MAX(seq), -1) AS s FROM session_events WHERE session_id = ?",
      ).get(sourceId) as { s: number };
      cutoff = row.s;
    } else {
      cutoff = upToSeq;
    }

    const title = (() => {
      if (newTitle && newTitle.trim().length > 0) return newTitle;
      const base = `Fork of ${source.title}`;
      if (base.length <= 60) return base;
      // Truncate-with-ellipsis at 60 chars total, matching the pattern used
      // in auto-title so forks don't produce 200-char breadcrumbs.
      return `${base.slice(0, 59)}…`;
    })();

    const fork = this.create({
      title,
      projectId: source.projectId,
      model: source.model,
      mode: source.mode,
      // No parentSessionId: forks are top-level, unlike /btw side chats.
      // No worktreePath/branch: forks reuse the project root. A future
      // version could mirror the source's worktree but that'd need a real
      // git-level branch-off and is out of scope here.
      // forkedFromSessionId: set so the chat header can render a "Forked"
      // badge making the SDK-context-reset honest to the user.
      forkedFromSessionId: sourceId,
    });

    if (cutoff >= 0) {
      // Copy every event with seq <= cutoff, rewriting seq to 1..N in order.
      // We stream rows rather than doing a single INSERT-SELECT because we
      // need to mint fresh event ids and the seq rewrite is easier in JS.
      const rows = this.lazyStmt(
        "forkSelectEvents",
        `SELECT kind, seq, created_at, payload FROM session_events
           WHERE session_id = ? AND seq <= ?
           ORDER BY seq ASC`,
      ).all(sourceId, cutoff) as Array<{
        kind: string;
        seq: number;
        created_at: string;
        payload: string;
      }>;
      const insert = this.lazyStmt(
        "appendEvent",
        `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      // Normalize seq to 1..N in the fork. Starting from 1 matches how
      // `appendEvent` numbers events once the fork receives its first new
      // message (nextSeq() returns MAX+1).
      let nextSeq = 1;
      const copied = this.db.transaction(() => {
        for (const r of rows) {
          insert.run(
            nanoid(16),
            fork.id,
            r.kind,
            nextSeq,
            r.created_at,
            r.payload,
          );
          // Keep the FTS index in sync so the forked transcript is
          // searchable from day one. Best-effort — SearchStore swallows.
          this.search.indexMessage({
            sessionId: fork.id,
            seq: nextSeq,
            kind: r.kind as EventKind,
            payload: JSON.parse(r.payload),
          });
          nextSeq++;
        }
      });
      copied();
    }

    return fork;
  }

  archive(id: string): void {
    const now = new Date().toISOString();
    this.lazyStmt(
      "archive",
      "UPDATE sessions SET archived_at = ?, status = 'archived', updated_at = ? WHERE id = ?",
    ).run(now, now, id);
  }

  /**
   * Hard-delete the session row. `session_events` and any side-chat children
   * (`parent_session_id = id`) are removed via FK CASCADE (see migration 1
   * for events, migration 3 for the self-referential parent FK). `tool_grants`
   * scoped to this session also cascade. Returns true if a row was deleted.
   */
  deleteById(id: string): boolean {
    // Clear FTS rows first. If the session DELETE below fails (it won't
    // under normal conditions, but FK RESTRICT elsewhere could surprise
    // us), we'd rather re-index on the next backfill than leave stale
    // rows that point to a live session.
    this.search.deleteSession(id);
    const res = this.lazyStmt(
      "deleteById",
      "DELETE FROM sessions WHERE id = ?",
    ).run(id);
    return res.changes > 0;
  }

  bumpStats(
    id: string,
    delta: Partial<Session["stats"]>,
  ): void {
    this.lazyStmt(
      "bumpStats",
      `UPDATE sessions SET
           stats_messages = stats_messages + ?,
           stats_files_changed = stats_files_changed + ?,
           stats_lines_added = stats_lines_added + ?,
           stats_lines_removed = stats_lines_removed + ?,
           stats_context_pct = COALESCE(?, stats_context_pct),
           updated_at = ?
         WHERE id = ?`,
    ).run(
      delta.messages ?? 0,
      delta.filesChanged ?? 0,
      delta.linesAdded ?? 0,
      delta.linesRemoved ?? 0,
      delta.contextPct ?? null,
      new Date().toISOString(),
      id,
    );
  }

  /**
   * Absolute overwrite of the file/line diff stats derived from the event
   * log. Called by `StatsRefresher` after it re-runs `aggregateSessionDiff`
   * for a session whose max event seq has moved past `stats_computed_seq`.
   *
   * Deliberately does NOT touch `stats_messages` (owned by `bumpStats`),
   * `stats_context_pct` (owned by the streaming path), or `updated_at`
   * (stats is a derived projection — a background refresh must not bump
   * the session to the top of the list and disturb the user's ordering).
   *
   * `computedSeq` must be the max seq observed at the moment the caller
   * started aggregating. If the session has since received a new event,
   * the next tick will see `MAX(seq) > computedSeq` and re-aggregate. No
   * locking required.
   */
  setStats(
    id: string,
    stats: {
      filesChanged: number;
      linesAdded: number;
      linesRemoved: number;
      computedSeq: number;
    },
  ): void {
    this.lazyStmt(
      "setStats",
      `UPDATE sessions SET
           stats_files_changed = ?,
           stats_lines_added = ?,
           stats_lines_removed = ?,
           stats_computed_seq = ?
         WHERE id = ?`,
    ).run(
      stats.filesChanged,
      stats.linesAdded,
      stats.linesRemoved,
      stats.computedSeq,
      id,
    );
  }

  /**
   * Return up to `limit` sessions whose stats projection is behind their
   * event log — i.e. `MAX(session_events.seq) > stats_computed_seq`.
   * Ordered by `updated_at DESC` so actively-used sessions refresh first.
   *
   * `maxSeq` is returned alongside `id` so the caller can thread it through
   * `setStats({ computedSeq })` without re-querying. -1 means "no events";
   * such rows are filtered out by the `>` comparison (default
   * stats_computed_seq is -1) so they never appear here.
   *
   * Archived sessions are excluded — they can't receive new events, and
   * once the refresher has caught up once (stats_computed_seq == max) they
   * stop being candidates anyway, but skipping them in the WHERE clause
   * keeps the query cheap on large history dumps.
   */
  listStaleStats(limit: number): Array<{ id: string; maxSeq: number }> {
    return this.lazyStmt(
      "listStaleStats",
      `SELECT s.id AS id,
              COALESCE(
                (SELECT MAX(seq) FROM session_events WHERE session_id = s.id),
                -1
              ) AS maxSeq
         FROM sessions s
         WHERE s.archived_at IS NULL
           AND COALESCE(
                 (SELECT MAX(seq) FROM session_events WHERE session_id = s.id),
                 -1
               ) > s.stats_computed_seq
         ORDER BY s.updated_at DESC
         LIMIT ?`,
    ).all(limit) as Array<{ id: string; maxSeq: number }>;
  }

  // ---- events ------------------------------------------------------------

  nextSeq(sessionId: string): number {
    const row = this.lazyStmt(
      "nextSeq",
      "SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM session_events WHERE session_id = ?",
    ).get(sessionId) as { next: number };
    return row.next;
  }

  appendEvent(input: {
    sessionId: string;
    kind: EventKind;
    payload: Record<string, unknown>;
  }): SessionEvent {
    const seq = this.nextSeq(input.sessionId);
    const event: SessionEvent = {
      id: nanoid(16),
      sessionId: input.sessionId,
      kind: input.kind,
      seq,
      createdAt: new Date().toISOString(),
      payload: input.payload,
    };
    this.lazyStmt(
      "appendEvent",
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.sessionId,
      event.kind,
      event.seq,
      event.createdAt,
      JSON.stringify(event.payload),
    );
    // Keep the full-text search index in sync for text-bearing events.
    // SearchStore.indexMessage is a no-op for other kinds / empty text.
    this.search.indexMessage({
      sessionId: event.sessionId,
      seq: event.seq,
      kind: event.kind,
      payload: event.payload,
    });
    return event;
  }

  listEvents(sessionId: string, sinceSeq?: number): SessionEvent[];
  listEvents(
    sessionId: string,
    opts: { sinceSeq?: number; beforeSeq?: number; limit?: number },
  ): SessionEvent[];
  listEvents(
    sessionId: string,
    arg?:
      | number
      | { sinceSeq?: number; beforeSeq?: number; limit?: number },
  ): SessionEvent[] {
    // Back-compat: listEvents(id) / listEvents(id, sinceSeq) — old callers
    // get the full history ASC (or the tail after sinceSeq).
    if (arg === undefined || typeof arg === "number") {
      const sinceSeq = typeof arg === "number" ? arg : -1;
      const rows = this.db
        .prepare(
          `SELECT id, session_id, kind, seq, created_at, payload
           FROM session_events WHERE session_id = ? AND seq > ?
           ORDER BY seq ASC`,
        )
        .all(sessionId, sinceSeq) as Array<{
        id: string;
        session_id: string;
        kind: string;
        seq: number;
        created_at: string;
        payload: string;
      }>;
      return rows.map(rowToEvent);
    }

    const { sinceSeq, beforeSeq, limit } = arg;
    // New paginated forms.
    //   - sinceSeq (no limit/beforeSeq): tail-fetch semantics (preserved).
    //   - beforeSeq + limit: `limit` rows with seq < beforeSeq, ASC.
    //   - limit alone: last `limit` rows, ASC.
    if (sinceSeq !== undefined && beforeSeq === undefined && limit === undefined) {
      const rows = this.db
        .prepare(
          `SELECT id, session_id, kind, seq, created_at, payload
           FROM session_events WHERE session_id = ? AND seq > ?
           ORDER BY seq ASC`,
        )
        .all(sessionId, sinceSeq) as Array<{
        id: string;
        session_id: string;
        kind: string;
        seq: number;
        created_at: string;
        payload: string;
      }>;
      return rows.map(rowToEvent);
    }

    const cap = Math.max(1, Math.min(limit ?? 200, 1000));
    // DESC scan over the indexed (session_id, seq) tail, then reverse to ASC
    // on the way out — the client always expects ASC order.
    const params: unknown[] = [sessionId];
    let sql =
      `SELECT id, session_id, kind, seq, created_at, payload
       FROM session_events WHERE session_id = ?`;
    if (beforeSeq !== undefined) {
      sql += ` AND seq < ?`;
      params.push(beforeSeq);
    }
    sql += ` ORDER BY seq DESC LIMIT ?`;
    params.push(cap);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      session_id: string;
      kind: string;
      seq: number;
      created_at: string;
      payload: string;
    }>;
    rows.reverse();
    return rows.map(rowToEvent);
  }

  /**
   * Count session_events for a session — cheap, indexed. Used by the CLI
   * resync path to decide whether a JSONL has grown since last import.
   */
  countEvents(sessionId: string): number {
    const row = this.lazyStmt(
      "countEvents",
      "SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?",
    ).get(sessionId) as { c: number };
    return row.c;
  }

  /**
   * Oldest (minimum) `seq` for a session, or null when the session has no
   * events. Used by the lazy-load pagination to tell clients whether more
   * history exists to page through.
   */
  oldestEventSeq(sessionId: string): number | null {
    const row = this.lazyStmt(
      "oldestEventSeq",
      "SELECT MIN(seq) AS s FROM session_events WHERE session_id = ?",
    ).get(sessionId) as { s: number | null };
    return row.s;
  }

  /** Last JSONL line index imported for this session's adopted CLI transcript. */
  getCliJsonlSeq(id: string): number {
    const row = this.lazyStmt(
      "getCliJsonlSeq",
      "SELECT cli_jsonl_seq FROM sessions WHERE id = ?",
    ).get(id) as { cli_jsonl_seq: number } | undefined;
    return row?.cli_jsonl_seq ?? 0;
  }

  setCliJsonlSeq(id: string, seq: number): void {
    this.lazyStmt(
      "setCliJsonlSeq",
      "UPDATE sessions SET cli_jsonl_seq = ? WHERE id = ?",
    ).run(seq, id);
  }

  /**
   * Mark (or unmark) a session as "adopted from the `claude` CLI JSONL".
   * Native claudex-spawned sessions stay false even though they also write
   * the JSONL via the SDK — this flag is the sole input the cli-resync /
   * cli-sync-watcher paths consult before re-importing from disk. Writing
   * is idempotent; the flag is touched by cli-import.ts on first adopt
   * and never flipped back.
   */
  setAdoptedFromCli(id: string, adopted: boolean): void {
    this.lazyStmt(
      "setAdoptedFromCli",
      "UPDATE sessions SET adopted_from_cli = ? WHERE id = ?",
    ).run(adopted ? 1 : 0, id);
  }

  /**
   * Return the event with the largest `seq` for this session matching
   * `kind`, or null when no such event exists. Used by the
   * edit-last-user-message flow to find the most recent user_message before
   * mutating it.
   */
  findLastEventByKind(
    sessionId: string,
    kind: EventKind,
  ): SessionEvent | null {
    const row = this.lazyStmt(
      "findLastEventByKind",
      `SELECT id, session_id, kind, seq, created_at, payload
         FROM session_events
         WHERE session_id = ? AND kind = ?
         ORDER BY seq DESC LIMIT 1`,
    ).get(sessionId, kind) as
      | {
          id: string;
          session_id: string;
          kind: string;
          seq: number;
          created_at: string;
          payload: string;
        }
      | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * Delete every event with `seq > cutoffSeq` for this session. Used by
   * the edit-last-user-message flow to drop the now-obsolete assistant
   * turns / tool calls that followed the user_message being rewritten.
   * The user_message row at `cutoffSeq` itself is preserved.
   *
   * FTS rows for the deleted events are cleared in the same pass —
   * otherwise global search would keep returning snippets for text the
   * user has already edited out. Best-effort, mirroring appendEvent's
   * index semantics. Returns the number of rows deleted.
   */
  deleteEventsAboveSeq(sessionId: string, cutoffSeq: number): number {
    // Clear FTS first so a SQL failure on the events delete doesn't leave
    // orphaned search rows pointing at events we're about to drop.
    this.search.deleteEventsAbove(sessionId, cutoffSeq);
    const res = this.lazyStmt(
      "deleteEventsAboveSeq",
      "DELETE FROM session_events WHERE session_id = ? AND seq > ?",
    ).run(sessionId, cutoffSeq);
    return res.changes ?? 0;
  }

  /**
   * Overwrite the JSON payload of a single event identified by
   * (sessionId, seq). Used by the edit-last-user-message flow to rewrite
   * user_message.text + stamp an editedAt marker. Returns false when no
   * such event exists.
   *
   * Also refreshes the FTS row so the search index reflects the new text.
   */
  updateEventPayload(
    sessionId: string,
    seq: number,
    payload: Record<string, unknown>,
  ): boolean {
    const res = this.lazyStmt(
      "updateEventPayload",
      "UPDATE session_events SET payload = ? WHERE session_id = ? AND seq = ?",
    ).run(JSON.stringify(payload), sessionId, seq);
    if ((res.changes ?? 0) === 0) return false;
    const row = this.lazyStmt(
      "selectEventKind",
      "SELECT kind FROM session_events WHERE session_id = ? AND seq = ?",
    ).get(sessionId, seq) as { kind: string } | undefined;
    if (row) {
      this.search.reindexMessage({
        sessionId,
        seq,
        kind: row.kind as EventKind,
        payload,
      });
    }
    return true;
  }
}

function rowToEvent(r: {
  id: string;
  session_id: string;
  kind: string;
  seq: number;
  created_at: string;
  payload: string;
}): SessionEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as EventKind,
    seq: r.seq,
    createdAt: r.created_at,
    payload: JSON.parse(r.payload),
  };
}
