import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { SearchStore, sanitizeFtsQuery } from "./store.js";

// ---------------------------------------------------------------------------
// GET /api/search?q=<query>&limit=20
//
// Full-text search across session titles and message bodies. Both hits
// buckets are capped at `limit` (default 20, max 50 to keep payload small).
//
// `q` sanitization: see `sanitizeFtsQuery` in ./store.ts. Summary — we
// tokenize on whitespace, strip FTS5 syntax chars per token, and require at
// least one letter/digit per token. Empty-after-sanitize returns 400.
//
// The response embeds `<mark>…</mark>` HTML into each message snippet (via
// FTS5's `snippet()` function). The web renderer maps those to styled
// spans; it must NOT dump them as raw HTML into an untrusted sink — callers
// render the snippet through a small tokenizer, not `dangerouslySetInnerHTML`
// on arbitrary input.
// ---------------------------------------------------------------------------

export interface SearchRoutesDeps {
  db: Database.Database;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function registerSearchRoutes(
  app: FastifyInstance,
  deps: SearchRoutesDeps,
): Promise<void> {
  const store = new SearchStore(deps.db);

  app.get(
    "/api/search",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { q?: string; limit?: string };
      const rawQuery = typeof q?.q === "string" ? q.q : "";
      const sanitized = sanitizeFtsQuery(rawQuery);
      if (!sanitized) {
        return reply.code(400).send({ error: "bad_request" });
      }

      const rawLimit = q?.limit ? Number(q.limit) : DEFAULT_LIMIT;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
        : DEFAULT_LIMIT;

      try {
        const titleHits = store.searchTitles(sanitized, limit);
        const messageHits = store.searchMessages(sanitized, limit);
        return { titleHits, messageHits };
      } catch (err) {
        // FTS5 can still reject malformed queries even after our sanitizer
        // (e.g., a token that's all syntax chars that we stripped to empty
        // and then filtered out — we should never hit this, but be safe).
        req.log?.warn?.({ err, rawQuery }, "search query failed");
        return reply.code(400).send({ error: "bad_request" });
      }
    },
  );
}
