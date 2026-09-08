import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { ProjectStore } from "./projects.js";
import { readProjectMemory } from "./memory.js";

/**
 * Read-only CLAUDE.md preview for a project. Backs the "Memory" section in
 * the session settings sheet so the user can see what ambient memory the
 * `claude` CLI is pulling into context.
 *
 *   GET /api/projects/:id/memory
 *
 * Login-gated. 404 when the project id is unknown. Always returns a
 * `{files}` array — empty when neither the project-local nor user-global
 * CLAUDE.md is readable.
 */
export async function registerMemoryRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database },
): Promise<void> {
  const projects = new ProjectStore(deps.db);

  app.get(
    "/api/projects/:id/memory",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = projects.findById(id);
      if (!project) return reply.code(404).send({ error: "not_found" });
      const memory = await readProjectMemory(project.path);
      return memory;
    },
  );
}
