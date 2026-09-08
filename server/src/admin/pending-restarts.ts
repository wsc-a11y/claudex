import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

// -----------------------------------------------------------------------------
// PendingRestartStore — CRUD wrapper around the `pending_restart_results`
// table (migration 19).
//
// Purpose: carry a `(session_id, tool_use_id)` pair across a self-restart so
// the new server can, on boot, synthesize a success tool_result for that
// tool_use and thereby clean up the "dangling failed restart tool call" UX
// in the chat transcript. See migration 19 in server/src/db/index.ts and
// resolvePendingRestartResults in server/src/transport/pending-restart-
// sweep.ts for the full lifecycle.
//
// Statements are prepared lazily (first call) so tests that build the db but
// never hit this code path don't pay the prepare cost. Same pattern as
// SessionStore.
// -----------------------------------------------------------------------------

// 24 hours. Rows older than this on boot are assumed abandoned (a prior
// restart that never completed, or a session long gone) and pruned by the
// sweep before it tries to resolve anything.
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

export interface PendingRestartRow {
  tool_use_id: string;
  session_id: string;
  created_at: string; // ISO 8601
}

export class PendingRestartStore {
  private stmts: {
    insert: Statement | null;
    listFresh: Statement | null;
    deleteByToolUseId: Statement | null;
    deleteStale: Statement | null;
  } = {
    insert: null,
    listFresh: null,
    deleteByToolUseId: null,
    deleteStale: null,
  };

  constructor(private readonly db: Database.Database) {}

  private prep(key: keyof typeof this.stmts, sql: string): Statement {
    const cached = this.stmts[key];
    if (cached) return cached;
    const s = this.db.prepare(sql);
    this.stmts[key] = s;
    return s;
  }

  /**
   * Write / overwrite a pending row. Called by the admin restart handler
   * BEFORE it sends SIGTERM to itself. `INSERT OR REPLACE` covers the
   * degenerate case where a caller fires multiple restart requests for the
   * same tool_use_id — the latest session_id/timestamp wins.
   */
  insert(sessionId: string, toolUseId: string): void {
    this.prep(
      "insert",
      `INSERT OR REPLACE INTO pending_restart_results
         (tool_use_id, session_id, created_at)
         VALUES (?, ?, ?)`,
    ).run(toolUseId, sessionId, new Date().toISOString());
  }

  /**
   * Every row younger than STALE_MAX_MS. Stale rows are pruned separately
   * by `deleteStale()`. Returned in insertion order so the transcript
   * events land in the order the restarts fired.
   */
  listFresh(): PendingRestartRow[] {
    const cutoff = new Date(Date.now() - STALE_MAX_MS).toISOString();
    return this.prep(
      "listFresh",
      `SELECT tool_use_id, session_id, created_at
         FROM pending_restart_results
         WHERE created_at >= ?
         ORDER BY created_at ASC`,
    ).all(cutoff) as PendingRestartRow[];
  }

  deleteByToolUseId(toolUseId: string): void {
    this.prep(
      "deleteByToolUseId",
      `DELETE FROM pending_restart_results WHERE tool_use_id = ?`,
    ).run(toolUseId);
  }

  /**
   * Drop rows older than STALE_MAX_MS. Returns the number of rows removed
   * so the sweep can log it. Called by resolvePendingRestartResults at the
   * top of its boot-time pass.
   */
  deleteStale(): number {
    const cutoff = new Date(Date.now() - STALE_MAX_MS).toISOString();
    const res = this.prep(
      "deleteStale",
      `DELETE FROM pending_restart_results WHERE created_at < ?`,
    ).run(cutoff);
    return res.changes ?? 0;
  }
}
