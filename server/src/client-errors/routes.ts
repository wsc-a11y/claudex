import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  ClientErrorListResponse,
  ClientErrorReport,
} from "@claudex/shared";
import { ClientErrorStore } from "./store.js";

// ---------------------------------------------------------------------------
// Client-error routes
//
// Ingest path:
//   POST /api/client-errors          body: ClientErrorReport
// Management (login-gated — same as ingest since the user is the only caller):
//   GET  /api/client-errors?status=open|resolved|all&limit=50&before=<iso>
//   POST /api/client-errors/:id/resolve
//   POST /api/client-errors/:id/reopen
//   DEL  /api/client-errors/:id
//   POST /api/client-errors/resolve-all
//   DEL  /api/client-errors/resolved
//
// All routes require auth — the server binds 127.0.0.1 and access is
// gated by the user's tunnel + claudex login, so we don't need a
// separate anonymous ingest door. Pre-login errors are not captured;
// that's an accepted gap (the white-screen case we care about happens
// inside the authenticated app).
// ---------------------------------------------------------------------------

export interface ClientErrorRoutesDeps {
  db: Database.Database;
  store: ClientErrorStore;
}

export async function registerClientErrorRoutes(
  app: FastifyInstance,
  deps: ClientErrorRoutesDeps,
): Promise<void> {
  const store = deps.store;

  // Ingest. Best-effort: parse failures return 400 but never throw, and
  // storage failures (logged inside the store) return a 202 with a tiny
  // payload so the client can still detect "it happened" without
  // branching on the row contents.
  app.post(
    "/api/client-errors",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = ClientErrorReport.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { code: "invalid_payload", issues: parsed.error.issues };
      }
      const row = store.upsert(parsed.data);
      if (!row) {
        reply.code(202);
        return { ok: true, stored: false };
      }
      reply.code(201);
      return { ok: true, stored: true, error: row };
    },
  );

  app.get(
    "/api/client-errors",
    { preHandler: app.requireAuth as any },
    async (req) => {
      const q = req.query as {
        status?: string;
        limit?: string;
        before?: string;
      };
      const status =
        q?.status === "open" || q?.status === "resolved" || q?.status === "all"
          ? q.status
          : "all";
      const rawLimit = q?.limit ? Number(q.limit) : undefined;
      const limit =
        rawLimit !== undefined && Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(rawLimit, 200))
          : 50;
      const errors = store.list({ status, limit, before: q?.before });
      const body: ClientErrorListResponse = {
        errors,
        openCount: store.countOpen(),
        resolvedCount: store.countResolved(),
      };
      return body;
    },
  );

  app.post(
    "/api/client-errors/resolve-all",
    { preHandler: app.requireAuth as any },
    async () => {
      const count = store.resolveAll();
      return { ok: true, resolved: count };
    },
  );

  app.delete(
    "/api/client-errors/resolved",
    { preHandler: app.requireAuth as any },
    async () => {
      const count = store.deleteResolved();
      return { ok: true, deleted: count };
    },
  );

  app.post(
    "/api/client-errors/:id/resolve",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!store.findById(id)) {
        reply.code(404);
        return { code: "not_found" };
      }
      store.markResolved(id);
      return { ok: true };
    },
  );

  app.post(
    "/api/client-errors/:id/reopen",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!store.findById(id)) {
        reply.code(404);
        return { code: "not_found" };
      }
      store.markOpen(id);
      return { ok: true };
    },
  );

  app.delete(
    "/api/client-errors/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = store.delete(id);
      if (!ok) {
        reply.code(404);
        return { code: "not_found" };
      }
      return { ok: true };
    },
  );
}
