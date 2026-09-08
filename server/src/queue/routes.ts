import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  CreateQueuedPromptRequest,
  UpdateQueuedPromptRequest,
} from "@claudex/shared";
import { z } from "zod";
import { ProjectStore } from "../sessions/projects.js";
import { QueueStore } from "./store.js";
import type { SessionManager } from "../sessions/manager.js";

export interface QueueRoutesDeps {
  db: Database.Database;
  manager: SessionManager;
  /**
   * Optional pre-built QueueStore. Passed in so the routes and the runner
   * share one instance — letting a single `onChange` listener cover both
   * code paths. When omitted (tests that don't need broadcasts), we build
   * our own local store as before.
   */
  queue?: QueueStore;
}

const MoveQueuedRequest = z.object({
  seq: z.number().int(),
});

export async function registerQueueRoutes(
  app: FastifyInstance,
  deps: QueueRoutesDeps,
): Promise<void> {
  const queue = deps.queue ?? new QueueStore(deps.db);
  const projects = new ProjectStore(deps.db);

  app.get(
    "/api/queue",
    { preHandler: app.requireAuth as any },
    async () => ({ queue: queue.list() }),
  );

  app.post(
    "/api/queue",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = CreateQueuedPromptRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      if (!projects.findById(parsed.data.projectId)) {
        return reply.code(400).send({ error: "project_not_found" });
      }
      const created = queue.create({
        projectId: parsed.data.projectId,
        prompt: parsed.data.prompt,
        title: parsed.data.title ?? null,
        model: parsed.data.model ?? null,
        mode: parsed.data.mode ?? null,
        worktree: parsed.data.worktree ?? false,
      });
      return reply.send({ queued: created });
    },
  );

  // PATCH — only allowed while the row is still `queued`. Once it flips to
  // `running` the prompt is in claude's hands and the queue row becomes a
  // record-of-what-happened rather than a knob the user can tweak.
  app.patch(
    "/api/queue/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateQueuedPromptRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const existing = queue.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (existing.status !== "queued") {
        return reply.code(409).send({ error: "not_editable" });
      }
      const updated = queue.update(id, parsed.data);
      return reply.send({ queued: updated });
    },
  );

  // DELETE — cancels a queued row, interrupts + cancels a running one. Other
  // states are already terminal and can't be cancelled (the right UX there is
  // "delete to clean up the list" once we ship that; for now 409 keeps the
  // surface honest rather than silently no-op'ing).
  app.delete(
    "/api/queue/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = queue.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (existing.status === "queued") {
        queue.setStatus(id, "cancelled", {
          finishedAt: new Date().toISOString(),
        });
        return reply.send({ ok: true });
      }
      if (existing.status === "running") {
        if (existing.sessionId) {
          try {
            await deps.manager.interrupt(existing.sessionId);
          } catch (err) {
            req.log.warn(
              { err, queueId: id, sessionId: existing.sessionId },
              "failed to interrupt running queued session",
            );
          }
        }
        queue.setStatus(id, "cancelled", {
          finishedAt: new Date().toISOString(),
        });
        return reply.send({ ok: true });
      }
      return reply.code(409).send({ error: "not_cancellable" });
    },
  );

  // Reorder within the queued set. Swaps seq with the nearest neighbour that
  // is also still `queued` — running/done/cancelled rows don't participate
  // because reordering a finished row doesn't mean anything.
  app.post(
    "/api/queue/:id/up",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = queue.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (existing.status !== "queued") {
        return reply.code(409).send({ error: "not_reorderable" });
      }
      const moved = queue.swapNeighbor(id, "up");
      return reply.send({ ok: true, moved });
    },
  );
  app.post(
    "/api/queue/:id/down",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = queue.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (existing.status !== "queued") {
        return reply.code(409).send({ error: "not_reorderable" });
      }
      const moved = queue.swapNeighbor(id, "down");
      return reply.send({ ok: true, moved });
    },
  );

  // Move a queued row to a specific target index within the queued set.
  // Drives the desktop drag-and-drop reorder on the web Queue screen —
  // the client computes an absolute target index from the drop point and
  // posts it here. `seq` is the zero-based index in the queued list, not
  // the row's `seq` column value — the store clamps it to the valid range
  // so the route tolerates "drop past the end" without erroring. Only
  // queued rows can move; running / done / failed / cancelled rows are
  // historical and don't participate.
  app.post(
    "/api/queue/:id/move",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = MoveQueuedRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const existing = queue.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (existing.status !== "queued") {
        return reply.code(409).send({ error: "not_reorderable" });
      }
      const moved = queue.reorderTo(id, parsed.data.seq);
      return reply.send({ ok: true, moved });
    },
  );
}
