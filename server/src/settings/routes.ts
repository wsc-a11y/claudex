import type { FastifyInstance } from "fastify";
import type { AppSettingsStore } from "./store.js";
import {
  UpdateAppSettingsRequest,
  type AppSettings,
  type UpdateAppSettingsRequest as UpdateAppSettingsRequestType,
} from "@claudex/shared";

// -----------------------------------------------------------------------------
// App-settings REST routes.
//
//   GET    /api/app-settings         — read current values (missing = null)
//   PATCH  /api/app-settings         — partial update; null = delete override
//
// Endpoint name is `app-settings` (not `settings`) to avoid conceptual
// collision with Claude Code's own `settings.json`. These knobs live in
// claudex's own SQLite, not in `~/.claude/`.
//
// Auth: both routes go through `requireAuth` like every other user-facing
// route. The values aren't secret but mutating them mid-session does change
// how Claude responds on subsequent turns, so we don't want an unauthenticated
// peer flipping them.
//
// Change takes effect on NEW / RESUMED sessions — already-running sessions
// keep whatever `systemPrompt` they were spawned with. This is intentional:
// swapping systemPrompt on a live SDK session isn't a supported operation and
// the language instruction is a once-per-start append.
// -----------------------------------------------------------------------------

export interface AppSettingsRoutesDeps {
  store: AppSettingsStore;
}

export async function registerAppSettingsRoutes(
  app: FastifyInstance,
  deps: AppSettingsRoutesDeps,
): Promise<void> {
  app.get(
    "/api/app-settings",
    { preHandler: app.requireAuth as any },
    async (_req, reply) => {
      const settings: AppSettings = deps.store.get();
      return reply.send({ settings });
    },
  );

  app.patch(
    "/api/app-settings",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = UpdateAppSettingsRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_request", detail: parsed.error.message });
      }
      const patch: UpdateAppSettingsRequestType = parsed.data;
      const settings = deps.store.patch(patch);
      return reply.send({ settings });
    },
  );
}
