import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Full-text search store.
//
// Thin wrapper over the two FTS5 virtual tables (`session_search` and
// `session_title_search`) created by migration id=9. Responsibilities:
//
//   1. Live sync for ongoing writes — `indexMessage(...)` is called by
//      SessionStore.appendEvent for text-bearing events; `upsertTitle(...)`
//      by SessionStore.setTitle / .create; `deleteSession(...)` by the
//      session DELETE path so stale rows don't linger.
//   2. Query helpers used by the HTTP route in routes.ts.
//
// FTS5 has no natural upsert, so `upsertTitle` deletes the existing
// `session_title_search` row for the session before inserting the new one.
// Message rows are append-only and keyed (session_id, event_seq) — we never
// update a stored event's text, so there's no upsert case.
// ---------------------------------------------------------------------------

/** Text-bearing event kinds we index. Other kinds (tool_use, tool_result,
 *  permission_*, turn_end, error) aren't text the user would search for. */
const INDEXABLE_KINDS = new Set([
  "user_message",
  "assistant_text",
  "assistant_thinking",
]);

export type IndexableKind =
  | "user_message"
  | "assistant_text"
  | "assistant_thinking";

export interface TitleHit {
  sessionId: string;
  title: string;
  snippet?: string;
}

export interface MessageHit {
  sessionId: string;
  title: string;
  eventSeq: number;
  kind: string;
  snippet: string;
  createdAt: string;
}

/**
 * Sanitize a user-supplied query for FTS5's MATCH operator.
 *
 * FTS5 treats a handful of characters as syntax: `"`, `(`, `)`, `-`, `^`,
 * `*`, `:`, and the keywords `AND` / `OR` / `NOT` / `NEAR/`. Handing a raw
 * query through can either (a) crash with "fts5: syntax error" on unclosed
 * quotes or (b) silently change the search intent.
 *
 * Our choice: tokenize on whitespace, keep only tokens that contain at
 * least one letter/digit (anywhere in the world, per the `\p{L}` +
 * `\p{N}` Unicode classes), strip the FTS5 syntax chars out of the
 * remaining token, and wrap each survivor in double quotes. This lets
 * "retry" and "half-hydrated" both work while neutering any attempt to
 * compose a malicious MATCH expression.
 *
 * Returns null when the sanitized query is empty — callers should 400.
 */
export function sanitizeFtsQuery(q: string): string | null {
  const trimmed = q.trim();
  if (trimmed.length === 0) return null;
  // Strip FTS5 syntax chars from each token, keep only tokens with a
  // letter or digit somewhere. Wrap each in double quotes so FTS5
  // treats them as literal phrases.
  const tokens: string[] = [];
  for (const raw of trimmed.split(/\s+/)) {
    // Remove FTS5 syntax chars. Intentionally keep CJK / accented
    // characters (unicode61 tokenizer handles them).
    const cleaned = raw.replace(/["'()\-^*:]+/g, "");
    if (cleaned.length === 0) continue;
    if (!/[\p{L}\p{N}]/u.test(cleaned)) continue;
    tokens.push(`"${cleaned}"`);
  }
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

export class SearchStore {
  // Prepared-statement cache. Populated lazily on first use of each method
  // so we don't pay the prepare() cost per write on hot paths like
  // indexMessage (called once per appended text-bearing event).
  private readonly stmts: {
    insertMsg: Statement | null;
    deleteTitle: Statement | null;
    insertTitle: Statement | null;
    deleteSessionMsg: Statement | null;
    deleteSessionTitle: Statement | null;
    deleteEventsAbove: Statement | null;
    deleteOneMsg: Statement | null;
  } = {
    insertMsg: null,
    deleteTitle: null,
    insertTitle: null,
    deleteSessionMsg: null,
    deleteSessionTitle: null,
    deleteEventsAbove: null,
    deleteOneMsg: null,
  };

  constructor(private readonly db: Database.Database) {}

  private lazyStmt<K extends keyof SearchStore["stmts"]>(
    key: K,
    sql: string,
  ): Statement {
    return (this.stmts[key] ??= this.db.prepare(sql));
  }

  // ---- live-sync writes -------------------------------------------------

  /**
   * Index a single text-bearing event for full-text search. No-op for
   * non-text kinds, null/empty text, or other unexpected shapes. Never
   * throws — FTS5 failures must never block a session_events INSERT.
   */
  indexMessage(input: {
    sessionId: string;
    seq: number;
    kind: string;
    payload: Record<string, unknown> | null | undefined;
  }): void {
    try {
      if (!INDEXABLE_KINDS.has(input.kind)) return;
      const text =
        input.payload && typeof input.payload.text === "string"
          ? (input.payload.text as string)
          : "";
      if (text.length === 0) return;
      this.lazyStmt(
        "insertMsg",
        `INSERT INTO session_search (session_id, event_seq, kind, body)
         VALUES (?, ?, ?, ?)`,
      ).run(input.sessionId, input.seq, input.kind, text);
    } catch {
      // Best-effort: log via caller if desired. The caller passes a logger
      // through its own try/catch — we stay silent here so an FTS failure
      // can't cascade into broken event persistence.
    }
  }

  /**
   * Upsert the title row for a session. FTS5 doesn't support INSERT OR
   * REPLACE directly (its rowid semantics are different), so we clear the
   * existing row by session_id first and then insert fresh. Empty titles
   * are indexed as empty strings — searching for them won't match, which
   * is the right behavior (users search for words, not absences).
   */
  upsertTitle(sessionId: string, title: string): void {
    try {
      this.lazyStmt(
        "deleteTitle",
        `DELETE FROM session_title_search WHERE session_id = ?`,
      ).run(sessionId);
      this.lazyStmt(
        "insertTitle",
        `INSERT INTO session_title_search (session_id, title)
         VALUES (?, ?)`,
      ).run(sessionId, title);
    } catch {
      /* best-effort, see indexMessage */
    }
  }

  /** Remove every FTS row for a session — called from SessionStore.deleteById. */
  deleteSession(sessionId: string): void {
    try {
      this.lazyStmt(
        "deleteSessionMsg",
        `DELETE FROM session_search WHERE session_id = ?`,
      ).run(sessionId);
      this.lazyStmt(
        "deleteSessionTitle",
        `DELETE FROM session_title_search WHERE session_id = ?`,
      ).run(sessionId);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Delete every `session_search` row for a session with
   * `event_seq > cutoffSeq`. Used by SessionStore.deleteEventsAboveSeq when
   * the edit-last-user-message flow truncates the transcript — dropping
   * rows from `session_events` without also dropping their FTS entries
   * would leave global search returning snippets for text that no longer
   * exists.
   */
  deleteEventsAbove(sessionId: string, cutoffSeq: number): void {
    try {
      this.lazyStmt(
        "deleteEventsAbove",
        `DELETE FROM session_search
         WHERE session_id = ? AND event_seq > ?`,
      ).run(sessionId, cutoffSeq);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Reindex a single event row — delete the existing FTS row (if any) and
   * reinsert it using the new payload. Used by SessionStore.updateEventPayload
   * when a persisted user_message is rewritten so the search snippet
   * reflects the new text rather than the pre-edit one.
   */
  reindexMessage(input: {
    sessionId: string;
    seq: number;
    kind: string;
    payload: Record<string, unknown> | null | undefined;
  }): void {
    try {
      this.lazyStmt(
        "deleteOneMsg",
        `DELETE FROM session_search
         WHERE session_id = ? AND event_seq = ?`,
      ).run(input.sessionId, input.seq);
    } catch {
      /* best-effort */
    }
    this.indexMessage(input);
  }

  // ---- reads ------------------------------------------------------------

  /**
   * Look up sessions whose titles match the (already-sanitized) FTS query.
   * Joins against `sessions` so we can return a stable `title` even if the
   * FTS row happens to be stale by a microsecond.
   */
  searchTitles(sanitized: string, limit: number): TitleHit[] {
    const rows = this.db
      .prepare(
        `SELECT
           tfts.session_id AS sessionId,
           s.title AS title,
           snippet(session_title_search, 1, '<mark>', '</mark>', '…', 16) AS snippet
         FROM session_title_search tfts
         JOIN sessions s ON s.id = tfts.session_id
         WHERE session_title_search MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, limit) as Array<{
      sessionId: string;
      title: string;
      snippet: string | null;
    }>;
    return rows.map((r) => ({
      sessionId: r.sessionId,
      title: r.title,
      snippet: r.snippet ?? undefined,
    }));
  }

  /**
   * Look up message-body matches, joined against `sessions` for the parent
   * title (so the UI can render "in <title>") and against `session_events`
   * for the created_at timestamp (the FTS row itself has no timestamp).
   *
   * Uses `snippet(session_search, 3, ...)` — column index 3 is `body`. The
   * 32-token window is wide enough to show surrounding context without
   * dominating the sheet on mobile.
   */
  searchMessages(sanitized: string, limit: number): MessageHit[] {
    const rows = this.db
      .prepare(
        `SELECT
           mfts.session_id AS sessionId,
           s.title AS title,
           mfts.event_seq AS eventSeq,
           mfts.kind AS kind,
           snippet(session_search, 3, '<mark>', '</mark>', '…', 32) AS snippet,
           ev.created_at AS createdAt
         FROM session_search mfts
         JOIN sessions s ON s.id = mfts.session_id
         LEFT JOIN session_events ev
           ON ev.session_id = mfts.session_id AND ev.seq = mfts.event_seq
         WHERE session_search MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, limit) as Array<{
      sessionId: string;
      title: string;
      eventSeq: number;
      kind: string;
      snippet: string;
      createdAt: string | null;
    }>;
    return rows.map((r) => ({
      sessionId: r.sessionId,
      title: r.title,
      eventSeq: r.eventSeq,
      kind: r.kind,
      snippet: r.snippet,
      // If the event row has been deleted between search and this join,
      // fall back to an empty string rather than crashing.
      createdAt: r.createdAt ?? "",
    }));
  }
}
