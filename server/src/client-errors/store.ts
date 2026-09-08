import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { ClientError, ClientErrorKind, ClientErrorReport } from "@claudex/shared";

// ---------------------------------------------------------------------------
// ClientErrorStore
//
// Thin wrapper around the `client_errors` table. Dedup by `fingerprint`
// (sha1 of kind + first-line message + first stack frame) so an error
// fired 200 times during a render loop shows up as one row with
// count=200, not 200 rows. `upsert` is the hot path; list / resolve /
// delete feed the `/errors` screen.
// ---------------------------------------------------------------------------

interface DbRow {
  id: string;
  kind: string;
  message: string;
  stack: string | null;
  component_stack: string | null;
  url: string | null;
  user_agent: string | null;
  fingerprint: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

function toClientError(r: DbRow): ClientError {
  return {
    id: r.id,
    kind: r.kind as ClientErrorKind,
    message: r.message,
    stack: r.stack,
    componentStack: r.component_stack,
    url: r.url,
    userAgent: r.user_agent,
    fingerprint: r.fingerprint,
    count: r.count,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    resolvedAt: r.resolved_at,
  };
}

// Keep free-form strings bounded even though the zod schema caps them —
// defensive in case the schema drifts or an old client sneaks by.
const MSG_MAX = 4000;
const STACK_MAX = 16000;
const URL_MAX = 2000;
const UA_MAX = 500;

function clip(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  if (s.length === 0) return null;
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * Normalize then hash the fields that define "same error": kind + first
 * line of message + first stack frame. This absorbs variable bits like
 * line:col shifts across rebuilds while still distinguishing genuinely
 * different errors at the same site. sha1 is plenty — no security
 * requirement, just a bucket key.
 */
function fingerprint(
  kind: ClientErrorKind,
  message: string,
  stack: string | null | undefined,
): string {
  const firstMsg = message.split("\n")[0].trim().slice(0, 500);
  const firstFrame = (stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("at ") || /:\d+:\d+/.test(l)) ?? "";
  const h = crypto.createHash("sha1");
  h.update(kind);
  h.update("\0");
  h.update(firstMsg);
  h.update("\0");
  h.update(firstFrame.slice(0, 500));
  return h.digest("hex");
}

type WarnLogger = { warn: (obj: unknown, msg?: string) => void } | undefined;

export interface ClientErrorListOpts {
  /** open = not resolved; resolved = resolved; all = both. Default: all. */
  status?: "open" | "resolved" | "all";
  /** Max rows. Capped at 200. Default 50. */
  limit?: number;
  /** ISO cursor. Returns rows strictly older (by last_seen_at) than this. */
  before?: string;
}

export class ClientErrorStore {
  private readonly stmts: {
    findByFp: Statement | null;
    insert: Statement | null;
    bumpExisting: Statement | null;
    findById: Statement | null;
    markResolved: Statement | null;
    markOpen: Statement | null;
    delete: Statement | null;
    resolveAll: Statement | null;
    deleteResolved: Statement | null;
    countOpen: Statement | null;
    countResolved: Statement | null;
  } = {
    findByFp: null, insert: null, bumpExisting: null, findById: null,
    markResolved: null, markOpen: null, delete: null,
    resolveAll: null, deleteResolved: null,
    countOpen: null, countResolved: null,
  };

  constructor(
    private readonly db: Database.Database,
    private readonly logger?: WarnLogger,
  ) {}

  private lazy<K extends keyof ClientErrorStore["stmts"]>(
    key: K, sql: string,
  ): Statement {
    return (this.stmts[key] ??= this.db.prepare(sql));
  }

  /**
   * Ingest one error. Dedup by fingerprint: if a row already exists with
   * the same fingerprint we bump count + last_seen_at, refresh
   * stack/url/userAgent (latest sample wins — cheap heuristic), and
   * reopen if it was previously resolved. New fingerprints insert fresh.
   *
   * Returns the resulting row so the route can 200 with the current
   * count / open state. Never throws — a failed ingest logs a warn and
   * returns null; we don't want a disk-full to 500 every page load on a
   * phone.
   */
  upsert(input: ClientErrorReport): ClientError | null {
    try {
      const kind = input.kind;
      const message = clip(input.message, MSG_MAX) ?? "(empty)";
      const stack = clip(input.stack, STACK_MAX);
      const componentStack = clip(input.componentStack, STACK_MAX);
      const url = clip(input.url, URL_MAX);
      const userAgent = clip(input.userAgent, UA_MAX);
      const fp = fingerprint(kind, message, stack);
      const now = new Date().toISOString();

      const existing = this.lazy(
        "findByFp",
        "SELECT * FROM client_errors WHERE fingerprint = ?",
      ).get(fp) as DbRow | undefined;

      if (existing) {
        // Bump count, refresh sample. Reopen if resolved — the user
        // explicitly wants to see regressions, not silently re-bury them.
        this.lazy(
          "bumpExisting",
          `UPDATE client_errors
              SET count = count + 1,
                  last_seen_at = ?,
                  stack = COALESCE(?, stack),
                  component_stack = COALESCE(?, component_stack),
                  url = COALESCE(?, url),
                  user_agent = COALESCE(?, user_agent),
                  message = ?,
                  resolved_at = NULL
            WHERE id = ?`,
        ).run(now, stack, componentStack, url, userAgent, message, existing.id);
        const row = this.lazy(
          "findById",
          "SELECT * FROM client_errors WHERE id = ?",
        ).get(existing.id) as DbRow;
        return toClientError(row);
      }

      const id = nanoid(16);
      this.lazy(
        "insert",
        `INSERT INTO client_errors
           (id, kind, message, stack, component_stack, url, user_agent,
            fingerprint, count, first_seen_at, last_seen_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      ).run(id, kind, message, stack, componentStack, url, userAgent, fp, now, now);
      const row = this.lazy(
        "findById",
        "SELECT * FROM client_errors WHERE id = ?",
      ).get(id) as DbRow;
      return toClientError(row);
    } catch (err) {
      this.logger?.warn?.({ err }, "client-error upsert failed");
      return null;
    }
  }

  list(opts: ClientErrorListOpts = {}): ClientError[] {
    const status = opts.status ?? "all";
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (status === "open") clauses.push("resolved_at IS NULL");
    else if (status === "resolved") clauses.push("resolved_at IS NOT NULL");
    if (opts.before) {
      clauses.push("last_seen_at < ?");
      params.push(opts.before);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM client_errors
         ${where}
         ORDER BY last_seen_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as DbRow[];
    return rows.map(toClientError);
  }

  findById(id: string): ClientError | null {
    const row = this.lazy(
      "findById",
      "SELECT * FROM client_errors WHERE id = ?",
    ).get(id) as DbRow | undefined;
    return row ? toClientError(row) : null;
  }

  markResolved(id: string): boolean {
    const res = this.lazy(
      "markResolved",
      "UPDATE client_errors SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL",
    ).run(new Date().toISOString(), id);
    return res.changes > 0;
  }

  markOpen(id: string): boolean {
    const res = this.lazy(
      "markOpen",
      "UPDATE client_errors SET resolved_at = NULL WHERE id = ? AND resolved_at IS NOT NULL",
    ).run(id);
    return res.changes > 0;
  }

  delete(id: string): boolean {
    const res = this.lazy(
      "delete",
      "DELETE FROM client_errors WHERE id = ?",
    ).run(id);
    return res.changes > 0;
  }

  /** Resolve every currently-open row. Returns the number affected. */
  resolveAll(): number {
    const res = this.lazy(
      "resolveAll",
      "UPDATE client_errors SET resolved_at = ? WHERE resolved_at IS NULL",
    ).run(new Date().toISOString());
    return res.changes;
  }

  /** Delete every resolved row. Returns the number affected. */
  deleteResolved(): number {
    const res = this.lazy(
      "deleteResolved",
      "DELETE FROM client_errors WHERE resolved_at IS NOT NULL",
    ).run();
    return res.changes;
  }

  countOpen(): number {
    const row = this.lazy(
      "countOpen",
      "SELECT COUNT(*) as c FROM client_errors WHERE resolved_at IS NULL",
    ).get() as { c: number };
    return row.c;
  }

  countResolved(): number {
    const row = this.lazy(
      "countResolved",
      "SELECT COUNT(*) as c FROM client_errors WHERE resolved_at IS NOT NULL",
    ).get() as { c: number };
    return row.c;
  }
}
