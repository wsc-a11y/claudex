import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  CreateRoutineRequest,
  UpdateRoutineRequest,
} from "@claudex/shared";
import { ProjectStore } from "../sessions/projects.js";
import { RoutineStore } from "./store.js";
import { computeNextRun, isValidCron, type RoutineScheduler } from "./scheduler.js";

export interface RoutinesRoutesDeps {
  db: Database.Database;
  scheduler: RoutineScheduler;
}

export async function registerRoutineRoutes(
  app: FastifyInstance,
  deps: RoutinesRoutesDeps,
): Promise<void> {
  const routines = new RoutineStore(deps.db);
  const projects = new ProjectStore(deps.db);

  app.get(
    "/api/routines",
    { preHandler: app.requireAuth as any },
    async () => ({ routines: routines.list() }),
  );

  app.get(
    "/api/routines/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = routines.findById(id);
      if (!r) return reply.code(404).send({ error: "not_found" });
      return reply.send({ routine: r });
    },
  );

  app.post(
    "/api/routines",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = CreateRoutineRequest.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "bad_request" });
      if (!isValidCron(parsed.data.cronExpr)) {
        return reply.code(400).send({ error: "invalid_cron" });
      }
      if (!projects.findById(parsed.data.projectId)) {
        return reply.code(400).send({ error: "project_not_found" });
      }
      // Precompute next_run_at so the scheduler's first reload finds it and
      // arms the timer immediately — no dead window between create and fire.
      const next = computeNextRun(parsed.data.cronExpr);
      const routine = routines.create({
        ...parsed.data,
        nextRunAt: next ? next.toISOString() : null,
      });
      deps.scheduler.reload();
      return reply.send({ routine });
    },
  );

  app.patch(
    "/api/routines/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateRoutineRequest.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "bad_request" });
      const existing = routines.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (
        parsed.data.cronExpr !== undefined &&
        !isValidCron(parsed.data.cronExpr)
      ) {
        return reply.code(400).send({ error: "invalid_cron" });
      }
      const updated = routines.update(id, parsed.data);
      // When the cron or active/paused flag changes, recompute next_run_at so
      // the next reload() immediately sees the fresh schedule — otherwise a
      // paused-then-resumed routine would wait until its stale next_run_at
      // (possibly in the past) to fire.
      if (
        updated &&
        (parsed.data.cronExpr !== undefined || parsed.data.status !== undefined)
      ) {
        if (updated.status === "active") {
          const next = computeNextRun(updated.cronExpr);
          routines.setSchedule(id, next ? next.toISOString() : null);
        } else {
          routines.setSchedule(id, null);
        }
      }
      deps.scheduler.reload();
      return reply.send({ routine: routines.findById(id) });
    },
  );

  app.delete(
    "/api/routines/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = routines.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      routines.delete(id);
      deps.scheduler.reload();
      return reply.send({ ok: true });
    },
  );

  // POST /api/routines/:id/run
  //
  // Fire a routine immediately without waiting for its cron slot. Uses the
  // scheduler's `fire()` path so session creation + initial-prompt delivery
  // goes through the same code as a timed run. Returns the id of the session
  // that was spawned so the UI can deep-link into it.
  app.post(
    "/api/routines/:id/run",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = routines.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (!projects.findById(existing.projectId)) {
        return reply.code(400).send({ error: "project_not_found" });
      }
      const sessionId = await deps.scheduler.fire(existing);
      if (!sessionId) {
        return reply.code(500).send({ error: "fire_failed" });
      }
      // fire() rolled last_run_at + next_run_at forward; reload so the next
      // timer points at the right routine.
      deps.scheduler.reload();
      return reply.send({ sessionId });
    },
  );
}
