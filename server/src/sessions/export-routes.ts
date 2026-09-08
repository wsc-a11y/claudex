import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { ProjectStore } from "./projects.js";
import { SessionStore } from "./store.js";
import {
  exportSessionJson,
  renderTranscriptMarkdown,
} from "./export.js";

/**
 * Per-session transcript export.
 *
 *   GET /api/sessions/:id/export?format=md|json
 *
 * Login-gated. Default format is `md` when the query is absent. Sends the
 * transcript as a browser download (Content-Disposition: attachment) with a
 * dated filename so the user knows which session the file came from.
 *
 * Buffers the full response in memory — adequate for today's P0 workload,
 * where a single session's events comfortably fit. For multi-megabyte
 * transcripts we'd want to stream row-by-row; explicitly out of scope here.
 */
export async function registerSessionExportRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database },
): Promise<void> {
  const sessions = new SessionStore(deps.db);
  const projects = new ProjectStore(deps.db);

  app.get(
    "/api/sessions/:id/export",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as { format?: string };
      const session = sessions.findById(id);
      if (!session) return reply.code(404).send({ error: "not_found" });

      const format = q?.format === "json" ? "json" : "md";
      const events = sessions.listEvents(id);
      const shortId = id.slice(0, 8);
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const filename = `claudex-${shortId}-${date}.${format}`;

      if (format === "json") {
        const project = projects.findById(session.projectId) ?? null;
        const payload = exportSessionJson(session, events);
        return reply
          .header("content-type", "application/json; charset=utf-8")
          .header(
            "content-disposition",
            `attachment; filename="${filename}"`,
          )
          .send(
            JSON.stringify(
              { ...payload, project: project ?? undefined },
              null,
              2,
            ),
          );
      }

      const project = projects.findById(session.projectId);
      const md = renderTranscriptMarkdown(session, events, { project });
      return reply
        .header("content-type", "text/markdown; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="${filename}"`,
        )
        .send(md);
    },
  );
}
