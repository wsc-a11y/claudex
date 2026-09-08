import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { Alert, AlertKind } from "@claudex/shared";

// -----------------------------------------------------------------------------
// AlertStore — CRUD wrapper around the `alerts` table (migration 20).
//
// Design is state-transition, not deletion. See the migration doc for the
// two orthogonal state bits (seen_at, resolved_at) and the retention policy.
// -----------------------------------------------------------------------------

interface AlertRowRaw {
  id: string;
  kind: string;
  session_id: string | null;
  project_id: string | null;
  title: string;
  body: string | null;
  payload_json: string | null;
  created_at: string;
  seen_at: string | null;
  resolved_at: string | null;
}

function rowToAlert(r: AlertRowRaw): Alert {
  let payload: Record<string, unknown> | null = null;
  if (r.payload_json) {
    try {
      payload = JSON.parse(r.payload_json) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  return {
    id: r.id,
    kind: r.kind as AlertKind,
    sessionId: r.session_id,
    projectId: r.project_id,
    title: r.title,
    body: r.body,
    payload,
    createdAt: r.created_at,
    seenAt: r.seen_at,
    resolvedAt: r.resolved_at,
  };
}

export interface InsertAlertInput {
  id?: string; // generated here if omitted
  kind: AlertKind;
  sessionId: string | null;
  projectId: string | null;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
}

/** Generate a uuid-ish id with a fallback for non-secure contexts. The
 *  server normally has crypto.randomUUID available (Node 20+), but we
 *  mirror the fallback pattern used elsewhere so the path is identical. */
function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class AlertStore {
  private stmts: {
    insert: Statement | null;
    findById: Statement | null;
    listAll: Statement | null;
    listUnseen: Statement | null;
    listActive: Statement | null;
    markSeen: Statement | null;
    markSeenAll: Statement | null;
    markResolved: Statement | null;
    resolveBySessionKind: Statement | null;
    deleteBySessionKind: Statement | null;
    countUnseen: Statement | null;
    prune: Statement | null;
  } = {
    insert: null,
    findById: null,
    listAll: null,
    listUnseen: null,
    listActive: null,
    markSeen: null,
    markSeenAll: null,
    markResolved: null,
    resolveBySessionKind: null,
    deleteBySessionKind: null,
    countUnseen: null,
    prune: null,
  };

  constructor(private readonly db: Database.Database) {}

  private prep(key: keyof typeof this.stmts, sql: string): Statement {
    const cached = this.stmts[key];
    if (cached) return cached;
    const s = this.db.prepare(sql);
    this.stmts[key] = s;
    return s;
  }

  insert(input: InsertAlertInput): Alert {
    const id = input.id ?? makeId();
    const now = new Date().toISOString();
    this.prep(
      "insert",
      `INSERT INTO alerts
         (id, kind, session_id, project_id, title, body, payload_json,
          created_at, seen_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id,
      input.kind,
      input.sessionId,
      input.projectId,
      input.title,
      input.body ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      now,
    );
    // Read-back to return a canonical Alert (including any DB-side defaults).
    const row = this.prep(
      "findById",
      `SELECT id, kind, session_id, project_id, title, body, payload_json,
              created_at, seen_at, resolved_at
         FROM alerts WHERE id = ?`,
    ).get(id) as AlertRowRaw | undefined;
    if (!row) throw new Error("insert_failed");
    return rowToAlert(row);
  }

  /** List alerts. Newest first. No pagination today — the 30-day retention
   *  keeps the row count small enough that shipping the full list is fine. */
  listAll(): Alert[] {
    const rows = this.prep(
      "listAll",
      `SELECT id, kind, session_id, project_id, title, body, payload_json,
              created_at, seen_at, resolved_at
         FROM alerts ORDER BY created_at DESC`,
    ).all() as AlertRowRaw[];
    return rows.map(rowToAlert);
  }

  markSeen(id: string): void {
    const now = new Date().toISOString();
    this.prep(
      "markSeen",
      `UPDATE alerts SET seen_at = ? WHERE id = ? AND seen_at IS NULL`,
    ).run(now, id);
  }

  /** Mark every currently-unseen alert as seen. Returns the number
   *  actually touched (zero if there were no unseen rows). */
  markAllSeen(): number {
    const now = new Date().toISOString();
    const res = this.prep(
      "markSeenAll",
      `UPDATE alerts SET seen_at = ? WHERE seen_at IS NULL`,
    ).run(now);
    return res.changes ?? 0;
  }

  /** Stamp `resolved_at`. Idempotent — no-op if already resolved. Optional
   *  `dismissedBy` marker appended to payload_json so the UI can distinguish
   *  "auto-resolved because the session status cleared" from "user tapped
   *  dismiss". */
  markResolved(id: string, opts?: { dismissedByUser?: boolean }): void {
    const now = new Date().toISOString();
    // Update resolved_at unconditionally (idempotent); set payload dismissal
    // flag when asked. We merge into existing payload_json by reading first.
    if (opts?.dismissedByUser) {
      const existing = this.prep(
        "findById",
        `SELECT id, kind, session_id, project_id, title, body, payload_json,
                created_at, seen_at, resolved_at
           FROM alerts WHERE id = ?`,
      ).get(id) as AlertRowRaw | undefined;
      if (!existing) return;
      let payload: Record<string, unknown> = {};
      if (existing.payload_json) {
        try {
          payload = JSON.parse(existing.payload_json) as Record<string, unknown>;
        } catch {
          payload = {};
        }
      }
      payload.dismissedByUser = true;
      this.db
        .prepare(
          `UPDATE alerts
             SET resolved_at = COALESCE(resolved_at, ?),
                 payload_json = ?
             WHERE id = ?`,
        )
        .run(now, JSON.stringify(payload), id);
      return;
    }
    this.prep(
      "markResolved",
      `UPDATE alerts SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?`,
    ).run(now, id);
  }

  /** Auto-resolve every currently-unresolved alert of a given kind for a
   *  given session. Called by the status-transition hook when a session
   *  leaves an alertable state (e.g. out of `awaiting` → resolve every
   *  `permission_pending` alert for it). Returns the number of rows
   *  touched so the caller can decide whether to notify. */
  resolveBySessionKind(sessionId: string, kind: AlertKind): number {
    const now = new Date().toISOString();
    const res = this.prep(
      "resolveBySessionKind",
      `UPDATE alerts
         SET resolved_at = ?
         WHERE session_id = ? AND kind = ? AND resolved_at IS NULL`,
    ).run(now, sessionId, kind);
    return res.changes ?? 0;
  }

  /** Hard-delete every alert of a given kind for a session. Used by the
   *  event hook for `session_completed`: each time a session finishes a
   *  turn we want *exactly one* latest-completion row, not a pile of 10.
   *  Deleting (rather than resolving) keeps the table bounded and means
   *  the new insert carries a fresh id + createdAt + unseen state, which
   *  is what drives the badge back up for the new completion. */
  deleteBySessionKind(sessionId: string, kind: AlertKind): number {
    const res = this.prep(
      "deleteBySessionKind",
      `DELETE FROM alerts WHERE session_id = ? AND kind = ?`,
    ).run(sessionId, kind);
    return res.changes ?? 0;
  }

  countUnseen(): number {
    const row = this.prep(
      "countUnseen",
      `SELECT COUNT(*) as n FROM alerts WHERE seen_at IS NULL`,
    ).get() as { n: number };
    return row.n;
  }

  /** Drop long-resolved alerts. Called once at server boot to keep the
   *  table bounded without forcing the user to clean up by hand. */
  pruneOld(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const res = this.prep(
      "prune",
      `DELETE FROM alerts
         WHERE resolved_at IS NOT NULL AND created_at < ?`,
    ).run(cutoff);
    return res.changes ?? 0;
  }
}
