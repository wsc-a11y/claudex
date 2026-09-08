import type { FastifyInstance } from "fastify";
import type { AlertStore } from "./store.js";
import type { SessionManager } from "../sessions/manager.js";
import type { AlertsListResponse } from "@claudex/shared";

// -----------------------------------------------------------------------------
// Alerts REST routes.
//
//   GET    /api/alerts                   — list all + unseen count
//   POST   /api/alerts/seen-all          — bulk mark-seen
//   POST   /api/alerts/:id/seen          — mark one seen
//   POST   /api/alerts/:id/dismiss       — user-initiated resolve
//
// All JWT-gated via `requireAuth`. Every mutation path invokes
// manager.notifyAlertsUpdate() so other tabs refetch. The GET path doesn't
// mutate and doesn't notify.
// -----------------------------------------------------------------------------

export interface AlertRoutesDeps {
  alerts: AlertStore;
  manager: SessionManager;
}

export async function registerAlertsRoutes(
  app: FastifyInstance,
  deps: AlertRoutesDeps,
): Promise<void> {
  app.get(
    "/api/alerts",
    { preHandler: app.requireAuth as any },
    async (_req, reply) => {
      const list = deps.alerts.listAll();
      const unseenCount = list.filter((a) => a.seenAt === null).length;
      const body: AlertsListResponse = { alerts: list, unseenCount };
      return reply.send(body);
    },
  );

  app.post(
    "/api/alerts/seen-all",
    { preHandler: app.requireAuth as any },
    async (_req, reply) => {
      const touched = deps.alerts.markAllSeen();
      if (touched > 0) {
        deps.manager.notifyAlertsUpdate();
      }
      return reply.send({ ok: true, touched });
    },
  );

  app.post(
    "/api/alerts/:id/seen",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      deps.alerts.markSeen(id);
      deps.manager.notifyAlertsUpdate();
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/alerts/:id/dismiss",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      deps.alerts.markResolved(id, { dismissedByUser: true });
      // Also mark seen when the user explicitly dismisses — the intent is
      // "I've handled this", so the badge should drop immediately even if
      // the user never opened the Alerts screen.
      deps.alerts.markSeen(id);
      deps.manager.notifyAlertsUpdate();
      return reply.send({ ok: true });
    },
  );
}
