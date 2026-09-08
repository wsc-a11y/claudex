import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { LinkPreview } from "@claudex/shared";

// ---------------------------------------------------------------------------
// Link preview cache store.
//
// Backed by the `link_previews` table (migration id=13). Each row is keyed by
// the exact URL string — no canonicalization — and carries the parsed
// metadata plus the upstream HTTP status. Freshness policy lives in the
// route layer (24h for success, 1h for failure); this store just stores and
// retrieves.
//
// Failed fetches (`status >= 400` or the sentinel `0` we use for network
// errors) still land in the cache so we don't hammer upstream on every
// render. The route layer uses `status < 400` to decide whether to surface
// the cached metadata to callers or re-try.
// ---------------------------------------------------------------------------

export interface LinkPreviewRow {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  fetchedAt: string;
  status: number;
}

export class LinkPreviewStore {
  // Prepared-statement cache — both methods have fixed SQL.
  private readonly stmts: {
    get: Statement | null;
    upsert: Statement | null;
  } = { get: null, upsert: null };

  constructor(private readonly db: Database.Database) {}

  private lazyStmt<K extends keyof LinkPreviewStore["stmts"]>(
    key: K,
    sql: string,
  ): Statement {
    return (this.stmts[key] ??= this.db.prepare(sql));
  }

  get(url: string): LinkPreviewRow | null {
    const row = this.lazyStmt(
      "get",
      `SELECT url, title, description, image, site_name AS siteName,
              fetched_at AS fetchedAt, status
         FROM link_previews
        WHERE url = ?`,
    ).get(url) as LinkPreviewRow | undefined;
    return row ?? null;
  }

  upsert(row: LinkPreviewRow): void {
    this.lazyStmt(
      "upsert",
      `INSERT INTO link_previews
          (url, title, description, image, site_name, fetched_at, status)
       VALUES (@url, @title, @description, @image, @siteName, @fetchedAt, @status)
       ON CONFLICT(url) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          image = excluded.image,
          site_name = excluded.site_name,
          fetched_at = excluded.fetched_at,
          status = excluded.status`,
    ).run(row);
  }
}

/**
 * Convert a cache row into the wire-shape `LinkPreview` returned from the
 * HTTP route. NULL columns collapse to `undefined` so zod's `.optional()`
 * accepts them.
 */
export function rowToPreview(row: LinkPreviewRow): LinkPreview {
  return {
    url: row.url,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    image: row.image ?? undefined,
    siteName: row.siteName ?? undefined,
    fetchedAt: row.fetchedAt,
  };
}

/** Success TTL — 24h. */
export const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
/** Negative cache TTL — 1h. */
export const FAILURE_TTL_MS = 60 * 60 * 1000;

/**
 * Given a cached row, decide whether it is still fresh relative to `now`.
 * Success rows (status < 400) get the 24h window; everything else gets 1h.
 */
export function isFresh(row: LinkPreviewRow, now: number): boolean {
  const fetched = Date.parse(row.fetchedAt);
  if (!Number.isFinite(fetched)) return false;
  const ttl = row.status >= 400 || row.status === 0
    ? FAILURE_TTL_MS
    : SUCCESS_TTL_MS;
  return now - fetched < ttl;
}
