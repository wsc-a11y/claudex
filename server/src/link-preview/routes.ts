import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { SlidingWindowLimiter } from "../auth/rate-limit.js";
import {
  LinkPreviewStore,
  isFresh,
  rowToPreview,
  type LinkPreviewRow,
} from "./store.js";
import { assertPublicHost, classifyUrl, fetchPreview } from "./fetch.js";
import type { LinkPreview } from "@claudex/shared";
import { getRequestCtx } from "../lib/req.js";

// ---------------------------------------------------------------------------
// GET /api/link-preview?url=<encoded>
//
// Login-gated. Validates the URL is public http(s) (see classifyUrl in
// ./fetch.ts — rejects non-http schemes and literal private/loopback/meta
// IPs). Enforces a per-user rate limit of 60 previews per hour using the
// same SlidingWindowLimiter the auth routes use. Successful responses cached
// for 24h; upstream failures are negatively cached for 1h so a bad URL
// doesn't keep us reaching out every time the chat re-renders.
//
// The auth middleware sets `req.userId`; we key the limiter on that so a
// compromised device can't blow the budget for a second device on the
// same account. The limiter is single-process / in-memory — fine for
// claudex (single binary, single user).
// ---------------------------------------------------------------------------

export interface LinkPreviewRoutesDeps {
  db: Database.Database;
  /**
   * Optional override so tests can inject a deterministic clock and a stub
   * fetcher. Prod wiring relies on the defaults.
   */
  now?: () => number;
  fetcher?: typeof fetchPreview;
  limiter?: SlidingWindowLimiter;
}

/** Per-user cap — matches the task spec (60 / hour). */
export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export async function registerLinkPreviewRoutes(
  app: FastifyInstance,
  deps: LinkPreviewRoutesDeps,
): Promise<void> {
  const store = new LinkPreviewStore(deps.db);
  const now = deps.now ?? (() => Date.now());
  const fetcher = deps.fetcher ?? fetchPreview;
  // Shared limiter instance across all requests. Keyed by `req.userId`.
  const limiter =
    deps.limiter
    ?? new SlidingWindowLimiter({
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: RATE_LIMIT_MAX,
      clock: now,
    });

  app.get(
    "/api/link-preview",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { url?: string };
      const raw = typeof q?.url === "string" ? q.url : "";
      if (!raw) {
        return reply.code(400).send({ error: "bad_request" });
      }

      const classified = classifyUrl(raw);
      if (!classified.ok) {
        return reply.code(400).send({ error: classified.reason });
      }
      const url = classified.url;

      // Rate limit by authenticated user id. Each successful preview (cache
      // hit OR upstream hit) counts as one stamp — the goal is to bound
      // our work, not our upstream traffic specifically.
      const ctx = getRequestCtx(req);
      if (!ctx.userId) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const userKey = ctx.userId;
      const gate = limiter.check(userKey);
      if (!gate.allowed) {
        reply.header("Retry-After", String(gate.retryAfterSec ?? 1));
        return reply
          .code(429)
          .send({
            error: "rate_limited",
            retryAfterSec: gate.retryAfterSec,
          });
      }

      // Cache hit — return stored row if still fresh. This is checked BEFORE
      // we stamp the limiter so repeated renders of the same message don't
      // eat the user's budget.
      const cached = store.get(url.toString());
      const t = now();
      if (cached && isFresh(cached, t)) {
        if (cached.status >= 400 || cached.status === 0) {
          // Negative cache hit — pretend it's fresh by returning a 502 so
          // the client renders nothing. We DON'T stamp the limiter for
          // negative hits either (same reason as above).
          return reply.code(502).send({ error: "upstream_failed" });
        }
        return reply.send(rowToPreview(cached) satisfies LinkPreview);
      }

      // DNS-aware host guard. `classifyUrl` only catches literal private
      // IPs; a hostname that resolves to 127.0.0.1 (DNS rebinding) would
      // otherwise slip through and let us make an unauthenticated request
      // to an attacker-chosen intra-network address. Do this BEFORE the
      // fetch so rebinds are rejected with a 400, and BEFORE stamping the
      // limiter so a burst of rebind attempts doesn't eat the user's
      // budget (they never reach upstream anyway).
      const guard = await assertPublicHost(url.hostname);
      if (!guard.ok) {
        return reply
          .code(400)
          .send({ error: "private_or_invalid_host" });
      }

      // Miss — real fetch. Stamp the limiter FIRST so a burst of uncached
      // URLs actually hits the cap; refunds on failure aren't worth the
      // complexity for a 60/hour budget.
      limiter.recordFailure(userKey);

      const fetched = await fetcher(url);
      const row: LinkPreviewRow = {
        url: url.toString(),
        title: fetched.title ?? null,
        description: fetched.description ?? null,
        image: fetched.image ?? null,
        siteName: fetched.siteName ?? null,
        fetchedAt: new Date(t).toISOString(),
        status: fetched.status,
      };
      store.upsert(row);

      if (fetched.status >= 400 || fetched.status === 0) {
        return reply.code(502).send({ error: "upstream_failed" });
      }
      return reply.send(rowToPreview(row) satisfies LinkPreview);
    },
  );
}
