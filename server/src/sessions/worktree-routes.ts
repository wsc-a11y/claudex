import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { ProjectStore } from "./projects.js";
import { SessionStore } from "./store.js";
import {
  listClaudexWorktrees,
  pruneOrphan,
  type Worktree,
} from "./worktree-manage.js";

// ---------------------------------------------------------------------------
// /api/worktrees/* — diagnostic + prune surface for claudex-managed git
// worktrees. Surfaces the `claude/*` branches and `.claude/worktrees/*` dirs
// scattered across the user's projects so they can be torn down when a session
// is deleted or worktree creation half-failed and left stale state behind.
//
// Nothing here mutates DB state — we only touch git + the filesystem inside
// projects the user has already trusted enough to register. Safety guards:
//   - Refuse to act on a branch that doesn't match /^claude\//
//   - Only operate inside `project.path` for a project claudex knows about
// ---------------------------------------------------------------------------

export interface WorktreeRoutesDeps {
  db: Database.Database;
}

// Body shape for the bulk prune endpoint. Each entry carries enough to anchor
// the prune inside a specific project without trusting a free-form path from
// the client — we look the project up in the DB and prune inside its path.
const PruneBody = z.object({
  worktrees: z
    .array(
      z.object({
        projectId: z.string().min(1),
        branch: z.string().min(1),
        path: z.string().min(1),
      }),
    )
    .min(1),
});

export async function registerWorktreeRoutes(
  app: FastifyInstance,
  deps: WorktreeRoutesDeps,
): Promise<void> {
  const projects = new ProjectStore(deps.db);
  const sessions = new SessionStore(deps.db);

  // GET /api/worktrees
  //
  // Returns every `claude/*` worktree git knows about under every project,
  // classified as `linked` (still referenced by a session row) or `orphaned`
  // (no session owns it — safe to prune). Empty array is a valid response.
  app.get(
    "/api/worktrees",
    { preHandler: app.requireAuth as any },
    async () => {
      const worktrees: Worktree[] = await listClaudexWorktrees({
        projects,
        sessions,
      });
      return { worktrees };
    },
  );

  // POST /api/worktrees/prune
  //
  // Bulk prune. Body: `{worktrees: [{projectId, branch, path}]}`. Iterates
  // through every entry, returning a per-item result so one failed prune
  // doesn't hide the successes. Branches outside `claude/*` are rejected by
  // `pruneOrphan` — we also validate the project exists so a stray projectId
  // can't be used to poke around the user's filesystem.
  app.post(
    "/api/worktrees/prune",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = PruneBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }

      const results: Array<{
        projectId: string;
        branch: string;
        path: string;
        removed: boolean;
        error?: string;
      }> = [];

      for (const item of parsed.data.worktrees) {
        const project = projects.findById(item.projectId);
        if (!project) {
          results.push({
            ...item,
            removed: false,
            error: "project not found",
          });
          continue;
        }
        const res = await pruneOrphan({
          projectPath: project.path,
          branch: item.branch,
          path: item.path,
        });
        results.push({
          ...item,
          removed: res.removed,
          ...(res.error ? { error: res.error } : {}),
        });
      }

      return reply.send({ results });
    },
  );

  // POST /api/worktrees/prune/:branch?projectId=<id>
  //
  // Single-prune convenience endpoint scoped to one project. `:branch` carries
  // the branch name (may contain slashes — Fastify's wildcard param doesn't
  // accept those in plain `:branch`, so we pass it as a query parameter
  // instead). Kept as a single helper for the UI's per-row "Remove" click.
  app.post(
    "/api/worktrees/prune-single",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = z
        .object({
          projectId: z.string().min(1),
          branch: z.string().min(1),
          path: z.string().min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const project = projects.findById(parsed.data.projectId);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const res = await pruneOrphan({
        projectPath: project.path,
        branch: parsed.data.branch,
        path: parsed.data.path,
      });
      return reply.send({
        projectId: parsed.data.projectId,
        branch: parsed.data.branch,
        path: parsed.data.path,
        removed: res.removed,
        ...(res.error ? { error: res.error } : {}),
      });
    },
  );
}
