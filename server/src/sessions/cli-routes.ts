import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { ImportCliSessionsRequest } from "@claudex/shared";
import { ProjectStore } from "./projects.js";
import { SessionStore } from "./store.js";
import {
  defaultCliProjectsRoot,
  listCliSessions,
} from "./cli-discovery.js";
import { importCliSession } from "./cli-import.js";

export interface CliRoutesDeps {
  db: Database.Database;
  /**
   * Root directory holding `<cwd-slug>/<uuid>.jsonl` session logs. Tests
   * pass a tmp directory so they never read the developer's real CLI
   * history. Defaults to `~/.claude/projects`.
   */
  cliProjectsRoot?: string;
}

/**
 * HTTP surface for adopting `claude` CLI sessions into claudex. Two routes:
 *   GET  /api/cli/sessions          — discover candidates
 *   POST /api/cli/sessions/import   — adopt a selection (idempotent)
 *
 * Both require auth. The import endpoint swallows per-session failures and
 * reports only the rows it successfully inserted so a single malformed
 * JSONL doesn't poison a batch-select in the UI.
 */
export async function registerCliRoutes(
  app: FastifyInstance,
  deps: CliRoutesDeps,
): Promise<void> {
  const root = deps.cliProjectsRoot ?? defaultCliProjectsRoot();
  const projects = new ProjectStore(deps.db);
  const sessions = new SessionStore(deps.db);

  app.get(
    "/api/cli/sessions",
    { preHandler: app.requireAuth as any },
    async (_req, reply) => {
      const discovered = await listCliSessions(root);
      // Hide sessions that are already adopted so the UI only shows
      // actionable rows. Keeps the "import everything" button honest.
      const filtered = discovered.filter(
        (s) => !sessions.findBySdkSessionId(s.sessionId),
      );
      return reply.send({ sessions: filtered });
    },
  );

  app.post(
    "/api/cli/sessions/import",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = ImportCliSessionsRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const discovered = await listCliSessions(root);
      const byId = new Map(discovered.map((s) => [s.sessionId, s]));

      const imported = [];
      for (const sessionId of parsed.data.sessionIds) {
        const match = byId.get(sessionId);
        // Even if a matching on-disk file doesn't exist, we may have already
        // adopted this id in a prior call — fall back to the existing row
        // so the response is stable.
        if (!match) {
          const existing = sessions.findBySdkSessionId(sessionId);
          if (existing) imported.push(existing);
          continue;
        }
        try {
          const result = await importCliSession(
            { sessions, projects, logger: req.log },
            {
              sessionId: match.sessionId,
              cwd: match.cwd,
              title: match.title,
              filePath: match.filePath,
            },
          );
          imported.push(result.session);
        } catch (err) {
          req.log.warn(
            { err, sessionId },
            "cli session import failed; skipping",
          );
        }
      }

      return reply.send({ imported });
    },
  );
}
