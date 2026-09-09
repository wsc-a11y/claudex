import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CreateSessionRequest,
  CreateSideSessionRequest,
  EditLastUserMessageRequest,
  ForkSessionRequest,
  RewindSessionRequest,
  RewindSessionResult,
  TrustProjectRequest,
  UpdateProjectRequest,
  UpdateSessionRequest,
  clampEffortForModel,
  type ToolGrant,
} from "@claudex/shared";
import {
  locateSessionJsonl,
  resolveAnchorUuid,
  rewindViaResume,
} from "./cli-rewind.js";
import { ProjectStore } from "./projects.js";
import { SessionStore } from "./store.js";
import { ToolGrantStore } from "./grants.js";
import { aggregatePendingDiffs } from "./diffs.js";
import { aggregateSessionDiff } from "./session-diff.js";
import type { SessionManager } from "./manager.js";
import { computeUsageSummary } from "./usage-summary.js";
import { triggerCliResync } from "./cli-resync.js";
import type { AuditStore } from "../audit/store.js";
import {
  createWorktree,
  ensureWorktreeProjectLink,
  isGitRepo,
  removeWorktree,
  WorktreeError,
} from "./worktree.js";
import { resolveCurrentBranch } from "./git-branch.js";
import { getRequestCtx } from "../lib/req.js";

export interface SessionsRoutesDeps {
  db: Database.Database;
  manager: SessionManager;
  /**
   * Override the Claude CLI projects root for tests. Defaults to
   * `~/.claude/projects`. When a session has `sdkSessionId` set we look for
   * its JSONL under `<root>/<cwd-slug>/<uuid>.jsonl` for the resync-on-open
   * path.
   */
  cliProjectsRoot?: string;
  /**
   * Override the Claude Code home whose `projects/` dir receives the
   * Windows worktree→parent junction (`ensureWorktreeProjectLink`).
   * Defaults to the real `os.homedir()`. Tests pass a tmp dir so
   * worktree-session creation never pollutes `~/.claude/projects`.
   */
  claudeHomeDir?: string;
  audit: AuditStore;
  /**
   * Absolute path to the uploads root (normally `~/.claudex/uploads`). When
   * provided, `DELETE /api/sessions/:id` best-effort removes the session's
   * upload directory in addition to the FK-cascaded attachment rows. Absent
   * is safe — cleanup is a no-op.
   */
  uploadsRoot?: string;
}

const AddProject = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionsRoutesDeps,
): Promise<void> {
  const projects = new ProjectStore(deps.db);
  const sessions = new SessionStore(deps.db);
  const grants = new ToolGrantStore(deps.db);

  // -- projects -------------------------------------------------------------

  app.get(
    "/api/projects",
    { preHandler: app.requireAuth as any },
    async () => {
      // Enrich each row with an `isGitRepo` bit so NewSessionSheet can decide
      // whether to enable the worktree toggle without a second round-trip.
      // `isGitRepo` is an `fs.lstatSync` — cheap enough to run N times on a
      // list a user realistically has (dozens at most). Failure is swallowed
      // per-row so one unreadable path doesn't blank the list.
      const rows = projects.list();
      const enriched = await Promise.all(
        rows.map(async (p) => {
          let gitBit = false;
          try {
            gitBit = await isGitRepo(p.path);
          } catch {
            gitBit = false;
          }
          return { ...p, isGitRepo: gitBit };
        }),
      );
      return { projects: enriched };
    },
  );

  app.post(
    "/api/projects",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = AddProject.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const abs = path.resolve(parsed.data.path);
      // Reject paths that don't exist — we'd rather fail loudly than end up
      // with a phantom project in the UI.
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return reply.code(400).send({ error: "path_not_a_directory" });
      }
      if (projects.findByPath(abs)) {
        return reply.code(409).send({ error: "path_already_exists" });
      }
      const project = projects.create({
        name: parsed.data.name,
        path: abs,
        // Default untrusted — the caller must go through
        // POST /api/projects/:id/trust (or its UI confirm card) before we'll
        // let a session spawn under this project.
      });
      return reply.send({ project });
    },
  );

  // POST /api/projects/:id/trust
  //
  // Flip the trust bit on a project. Body `{ trusted: boolean }`. Idempotent.
  // Gate lives in POST /api/sessions (see below). Trust flips are
  // security-relevant — the user is deciding whether claude can touch a
  // folder — so we audit both directions.
  app.post(
    "/api/projects/:id/trust",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = TrustProjectRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const existing = projects.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      projects.setTrusted(id, parsed.data.trusted);
      const updated = projects.findById(id)!;
      const ctx = getRequestCtx(req);
      deps.audit.append({
        userId: ctx.userId,
        event: parsed.data.trusted ? "project_trusted" : "project_untrusted",
        target: id,
        detail: `Project ${updated.name} ${
          parsed.data.trusted ? "trusted" : "untrusted"
        }`,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return reply.send({ project: updated });
    },
  );

  app.patch(
    "/api/projects/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateProjectRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const existing = projects.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      projects.setName(id, parsed.data.name);
      const updated = projects.findById(id);
      return reply.send({ project: updated });
    },
  );

  app.delete(
    "/api/projects/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = projects.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const sessionCount = projects.countSessions(id);
      if (sessionCount > 0) {
        // FK is ON DELETE RESTRICT — bail with a precise count so the UI
        // can phrase the error properly ("project has N sessions").
        return reply
          .code(409)
          .send({ error: "has_sessions", sessionCount });
      }
      projects.delete(id);
      return reply.send({ ok: true });
    },
  );

  // POST /api/projects/cleanup-empty
  //
  // Bulk-remove every project that has zero sessions (archived included, since
  // `countSessions` does). Returns `{ removed, removedNames }` so the UI can
  // toast a precise summary. Idempotent — re-running with no empty projects
  // returns `{ removed: 0, removedNames: [] }` rather than 404'ing.
  app.post(
    "/api/projects/cleanup-empty",
    { preHandler: app.requireAuth as any },
    async () => {
      const removed = projects.cleanupEmpty();
      return {
        removed: removed.length,
        removedNames: removed.map((p) => p.name),
      };
    },
  );

  // -- sessions -------------------------------------------------------------

  app.get(
    "/api/sessions",
    { preHandler: app.requireAuth as any },
    async (req) => {
      const q = req.query as { project?: string; archived?: string };
      if (q?.project) {
        return { sessions: sessions.listByProject(q.project) };
      }
      return {
        sessions: sessions.list({ includeArchived: q?.archived === "1" }),
      };
    },
  );

  app.get(
    "/api/sessions/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = sessions.findById(id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      // Fire-and-forget CLI resync: if this session was adopted from the
      // `claude` CLI and its JSONL has grown since we last imported, pull the
      // new lines in the background. We never block the HTTP response on it;
      // the WS bridge will push the new events (or a `refresh_transcript`
      // signal) when they land.
      if (row.sdkSessionId) {
        triggerCliResync({
          sessions,
          sessionRow: row,
          manager: deps.manager,
          cliProjectsRoot: deps.cliProjectsRoot,
          logger:
            req.log && typeof req.log.warn === "function"
              ? {
                  warn: (o, m) => req.log.warn(o, m),
                  debug: (o, m) => req.log.debug?.(o, m),
                }
              : undefined,
        });
      }
      return { session: row };
    },
  );

  app.get(
    "/api/sessions/:id/events",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as {
        sinceSeq?: string;
        beforeSeq?: string;
        limit?: string;
      };
      if (!sessions.findById(id))
        return reply.code(404).send({ error: "not_found" });

      const parseNum = (v: string | undefined): number | undefined => {
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const sinceSeq = parseNum(q?.sinceSeq);
      const beforeSeq = parseNum(q?.beforeSeq);
      const rawLimit = parseNum(q?.limit);

      // Back-compat: no pagination params at all → full history, matches
      // every existing caller.
      if (sinceSeq === undefined && beforeSeq === undefined && rawLimit === undefined) {
        return {
          events: sessions.listEvents(id),
          hasMore: false,
          oldestSeq: sessions.oldestEventSeq(id),
        };
      }

      // sinceSeq without any of the newer params keeps the tail-fetch shape.
      if (sinceSeq !== undefined && beforeSeq === undefined && rawLimit === undefined) {
        return {
          events: sessions.listEvents(id, sinceSeq),
          hasMore: false,
          oldestSeq: sessions.oldestEventSeq(id),
        };
      }

      // New pagination path — `limit` is mandatory on this branch; cap at 1000.
      const limit = Math.max(1, Math.min(rawLimit ?? 200, 1000));
      const events = sessions.listEvents(id, { beforeSeq, limit });
      const oldestSeqAll = sessions.oldestEventSeq(id);
      const batchOldest = events.length > 0 ? events[0].seq : null;
      // hasMore: there exists at least one event older than what we just
      // returned. If the oldest in the batch matches the absolute oldest in
      // the table, we've paged to the top.
      const hasMore =
        batchOldest !== null &&
        oldestSeqAll !== null &&
        batchOldest > oldestSeqAll;
      return { events, hasMore, oldestSeq: batchOldest };
    },
  );

  // GET /api/sessions/:id/usage-summary
  //
  // Small JSON payload (~1 KB) that lets the chat header ring, UsagePanel, and
  // ChatTasksRail show context / token info without re-downloading the full
  // event stream every time the transcript grows. Computed server-side via an
  // indexed scan over `session_events WHERE kind = 'turn_end'`.
  app.get(
    "/api/sessions/:id/usage-summary",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = sessions.findById(id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      const events = sessions.listEvents(id);
      return reply.send(computeUsageSummary(events, row.model));
    },
  );

  // GET /api/sessions/:id/pending-diffs
  //
  // Aggregates every diff-producing (Edit / Write / MultiEdit) tool call in
  // the session that is *currently awaiting the user* — either because it
  // has a live `permission_request` with no matching `permission_decision`,
  // or because its `tool_use` event has no matching `tool_result` yet
  // (in-flight under acceptEdits / bypass modes where the SDK doesn't ask).
  //
  // The computed `hunks` ship with the response so the full-screen Diff
  // Review page (mockup s-06) can render without replaying the transcript
  // client-side. Empty array is a valid response — no pending edits = nothing
  // to review; the UI shows an empty state rather than a 404.
  app.get(
    "/api/sessions/:id/pending-diffs",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!sessions.findById(id))
        return reply.code(404).send({ error: "not_found" });
      const events = sessions.listEvents(id);
      const diffs = aggregatePendingDiffs(events);
      return reply.send({ diffs });
    },
  );

  // GET /api/sessions/:id/session-diff
  //
  // Whole-session PR-shaped diff (mockup s-15). Walks every Edit / Write /
  // MultiEdit tool_use in the session and stitches them per file. Includes
  // a chronological timeline of every change so the right rail can show
  // what happened when. Powers /session/:id/session-diff in the web.
  app.get(
    "/api/sessions/:id/session-diff",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = sessions.findById(id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const events = sessions.listEvents(id);
      return reply.send(aggregateSessionDiff(events, session));
    },
  );

  app.post(
    "/api/sessions",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = CreateSessionRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const project = projects.findById(parsed.data.projectId);
      if (!project) return reply.code(400).send({ error: "project_not_found" });
      // Trust gate. The web NewSessionSheet flips the bit via
      // POST /api/projects/:id/trust before hitting this endpoint; a direct
      // API caller that skipped the confirm step gets 409 with the projectId
      // echoed so they can route to the trust flow.
      if (!project.trusted) {
        return reply
          .code(409)
          .send({ error: "project_not_trusted", projectId: project.id });
      }

      const rawTitle = parsed.data.title?.trim() || undefined;
      const title = rawTitle ?? "Untitled";
      let worktreePath: string | null = null;
      let branch: string | null = null;
      let sessionId: string | undefined;

      // If the caller asked for a worktree, verify the project is a git repo
      // up front, then create the worktree BEFORE inserting the session row
      // so a failure here leaves no dangling session in the DB. The session
      // id is pre-generated so the directory name matches the DB primary key.
      if (parsed.data.worktree) {
        if (!(await isGitRepo(project.path))) {
          return reply.code(400).send({ error: "not_a_git_repo" });
        }
        const { nanoid } = await import("nanoid");
        sessionId = nanoid(12);
        try {
          const wt = await createWorktree({
            projectPath: project.path,
            sessionId,
            // Pass the RAW user-supplied title, not the "Untitled" default.
            // If the user didn't name the session, we'd rather the branch
            // fall back to the sessionId (globally unique, readable) than
            // spray the repo with `claude/untitled`, `claude/untitled-<nano>`
            // collisions every time a blank-title session is spawned.
            title: rawTitle,
          });
          worktreePath = wt.path;
          branch = wt.branch;
          ensureWorktreeProjectLink(
            project.path,
            wt.path,
            req.log,
            deps.claudeHomeDir,
          );
        } catch (err) {
          if (err instanceof WorktreeError) {
            req.log.warn(
              { err, projectPath: project.path },
              "worktree creation failed",
            );
            return reply
              .code(400)
              .send({ error: "worktree_failed", detail: err.message });
          }
          throw err;
        }
      } else {
        // No worktree: capture the project's current git branch so the Home
        // list shows something real. Best-effort — a non-git project or a
        // detached HEAD both return null and the UI falls back to a "no
        // branch" placeholder rather than the old `?? "main"` lie.
        branch = await resolveCurrentBranch(project.path);
      }

      const session = sessions.create({
        id: sessionId,
        title,
        projectId: parsed.data.projectId,
        model: parsed.data.model,
        mode: parsed.data.mode,
        effort: parsed.data.effort,
        worktreePath,
        branch,
      });
      return reply.send({ session });
    },
  );

  app.post(
    "/api/sessions/:id/archive",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = sessions.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      // Clean up the worktree if we made one. This is best-effort: a missing
      // directory (user rm'd it) or a git failure shouldn't block the user
      // from archiving — the session row flip is what matters.
      if (existing.worktreePath) {
        try {
          await removeWorktree(existing.worktreePath);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, worktreePath: existing.worktreePath },
            "worktree cleanup failed during archive",
          );
        }
      }
      sessions.archive(id);
      return reply.send({ ok: true });
    },
  );

  // DELETE /api/sessions/:id
  //
  // Hard-delete a session. Unlike archive, this is irreversible: the session
  // row + every `session_events` row (FK CASCADE) + any `/btw` side-chat
  // children (also CASCADE via `parent_session_id` FK) disappear. Tool grants
  // scoped to this session also cascade.
  //
  // Live runner is torn down first so the SDK subprocess doesn't keep writing
  // events against a row that's about to vanish. Worktree cleanup is
  // best-effort — archive logs & continues on failure, and delete must do the
  // same: the user expects the session to be gone regardless of whether git
  // cleaned up behind us.
  app.delete(
    "/api/sessions/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = sessions.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });

      // Tear down the runner first so no more events get appended to a row
      // we're about to delete. Safe to call even when no runner is attached.
      try {
        await deps.manager.dispose(id);
      } catch (err) {
        req.log.warn(
          { err, sessionId: id },
          "runner dispose failed during session delete",
        );
      }

      if (existing.worktreePath) {
        try {
          await removeWorktree(existing.worktreePath);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, worktreePath: existing.worktreePath },
            "worktree cleanup failed during delete",
          );
        }
      }

      sessions.deleteById(id);
      // Best-effort remove the session's upload directory so orphaned files
      // don't sit under `~/.claudex/uploads/<session-id>/` forever. The FK
      // cascade already dropped the DB rows. Swallow errors — the session
      // is already gone in the user's mental model.
      if (deps.uploadsRoot) {
        try {
          const { removeSessionUploadsDir } = await import(
            "../uploads/routes.js"
          );
          await removeSessionUploadsDir(deps.uploadsRoot, id);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id },
            "uploads dir cleanup failed during session delete",
          );
        }
      }
      // Audit: hard-delete is the only session action that can't be undone,
      // so it earns an audit row. Title goes in `detail` so the Security UI
      // can show "Deleted session 'Fix login bug'" without another lookup.
      const ctx = getRequestCtx(req);
      deps.audit.append({
        userId: ctx.userId,
        event: "session_deleted",
        target: id,
        detail: existing.title,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return reply.code(204).send();
    },
  );

  // POST /api/sessions/:id/side
  //
  // Spawns a `/btw` side chat that branches off an existing session. Copies
  // project / model / mode from the parent; default mode is `plan` (read-only)
  // so the side chat can't accidentally mutate the main thread's working tree
  // while the user is just asking a quick lateral question. We explicitly do
  // NOT copy the worktree path — side chats run in the parent's cwd, and we
  // never create a new worktree for them.
  //
  // Archived parents can't spawn side chats (nothing to branch off of). If
  // an active side chat for this parent already exists, returns it instead
  // of creating a new one — matches the "one active side chat per main
  // thread" convention the UI enforces. To start fresh, archive the existing
  // side chat first.
  app.post(
    "/api/sessions/:id/side",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = CreateSideSessionRequest.safeParse(req.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({ error: "bad_request" });
      const parent = sessions.findById(id);
      if (!parent) return reply.code(404).send({ error: "not_found" });
      if (parent.status === "archived") {
        return reply.code(409).send({ error: "archived" });
      }
      // Reuse an existing active side chat if the caller has one open.
      const children = sessions.listChildren(id);
      const active = children.find((c) => c.status !== "archived");
      if (active) {
        return reply.send({ session: active });
      }
      const session = sessions.create({
        title: parsed.data.title ?? "Side chat",
        projectId: parent.projectId,
        model: parent.model,
        // Read-only by default — /btw is for sanity checks, not actions.
        mode: "plan",
        parentSessionId: parent.id,
      });
      return reply.send({ session });
    },
  );

  // GET /api/sessions/:id/side
  //
  // Returns the currently-active side chat for `id`, if any. Used by the
  // web UI on mount to decide whether the /btw button should open an
  // existing drawer (preserving the conversation) or show an empty new
  // one. Deliberately ignores archived children so "Archive and start
  // new" feels like a clean slate.
  app.get(
    "/api/sessions/:id/side",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parent = sessions.findById(id);
      if (!parent) return reply.code(404).send({ error: "not_found" });
      const children = sessions.listChildren(id);
      const active = children.find((c) => c.status !== "archived") ?? null;
      return reply.send({ session: active });
    },
  );

  app.patch(
    "/api/sessions/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateSessionRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const existing = sessions.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      // Archived sessions are read-only. Unarchiving isn't wired yet; bail
      // loudly rather than silently updating a row the user can't use.
      if (existing.status === "archived") {
        return reply.code(409).send({ error: "archived" });
      }

      const warnings: string[] = [];
      const { title, model, mode, effort, tags, pinned } = parsed.data;

      // Clamp `effort` to what the (possibly-new) model supports. Today this
      // only matters for `xhigh`, which is Opus 4.7-only — switching to a
      // smaller model (or PATCHing xhigh onto one) silently downgrades to
      // `high` so the runner never hands an unsupported budget to the SDK.
      const nextModel = model ?? existing.model;
      const incomingEffort = effort ?? existing.effort;
      const clamped = clampEffortForModel(nextModel, incomingEffort);
      // Only turn clamp into a field change when it actually differs from the
      // incoming patch — if the caller didn't pass `effort` and the existing
      // row is already unsupported (stale data), we still want to fix it.
      const effectiveEffort =
        clamped !== incomingEffort ? clamped : effort;

      if (title !== undefined) sessions.setTitle(id, title);
      if (model !== undefined && model !== existing.model) {
        sessions.setModel(id, model);
        // Propagate to the live runner via the SDK's Query.setModel control
        // request so the next turn actually uses the new model. Without this
        // the cached runner keeps replying with whatever model it was
        // launched with — typically the SDK's default Sonnet — and the user
        // sees "I picked Opus but Claude still answers as Sonnet". The
        // change applies to the NEXT SDK turn; an in-flight query keeps
        // the model it was launched with (matches SDK semantics).
        try {
          await deps.manager.applyModel(id, model);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, model },
            "failed to propagate model change to runner",
          );
        }
        if (existing.status === "running" || deps.manager.hasRunner(id)) {
          warnings.push("model_change_applies_to_next_turn");
        }
      }
      if (mode !== undefined && mode !== existing.mode) {
        sessions.setMode(id, mode);
        // Propagate live if a runner is attached. Safe to call even when
        // the runner is idle; no-ops on sessions that never spawned one.
        try {
          await deps.manager.applyPermissionMode(id, mode);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, mode },
            "failed to propagate permission mode to runner",
          );
        }
      }
      if (
        effectiveEffort !== undefined &&
        effectiveEffort !== existing.effort
      ) {
        sessions.setEffort(id, effectiveEffort);
        // Runner stores the new value for the NEXT SDK turn — same warning
        // as model swap so the UI can tell the user the change is deferred
        // if Claude is currently mid-turn.
        if (existing.status === "running" || deps.manager.hasRunner(id)) {
          warnings.push("effort_change_applies_to_next_turn");
        }
        try {
          await deps.manager.applyEffort(id, effectiveEffort);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, effort: effectiveEffort },
            "failed to propagate effort level to runner",
          );
        }
      }
      if (tags !== undefined) {
        sessions.setTags(id, tags);
      }
      if (pinned !== undefined) {
        sessions.setPinned(id, pinned);
      }

      const updated = sessions.findById(id)!;
      return reply.send({
        session: updated,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  );

  // POST /api/sessions/:id/edit-last-user-message
  //
  // Typo recovery: rewrite the text of the session's most recent
  // `user_message`, drop every event that followed it (assistant turns,
  // tool calls, permission prompts — all now obsolete), and re-run the SDK
  // so a fresh assistant reply takes their place. Only valid while the
  // session is `idle` — a running turn would race with the truncation.
  //
  // Error codes:
  //   401 (auth gate) — handled by `requireAuth` preHandler
  //   404 not_found        — session row doesn't exist
  //   409 archived         — archived sessions are read-only
  //   409 not_idle         — session is running / awaiting / error
  //   400 no_user_message  — session has no user_message to edit
  //   400 has_attachments  — the message carried attachments; we don't have
  //                          a re-link/delete story for those yet
  //   400 bad_request      — body schema mismatch (missing `text`)
  //
  // Caveat (also in docs/FEATURES.md): CLI-imported sessions keep their
  // original JSONL at `~/.claude/projects/<slug>/<uuid>.jsonl`; this route
  // rewrites our own event log but NOT that file. The Agent SDK's in-memory
  // conversation history also still contains the pre-edit message + any
  // assistant reply, and will replay both when formulating the next turn.
  // We ship it anyway: the web UX win (fix a typo without resending)
  // outweighs the CLI-side divergence.
  app.post(
    "/api/sessions/:id/edit-last-user-message",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = EditLastUserMessageRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });

      const existing = sessions.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (existing.status === "archived") {
        return reply.code(409).send({ error: "archived" });
      }
      if (existing.status !== "idle") {
        return reply.code(409).send({ error: "not_idle" });
      }

      const lastUser = sessions.findLastEventByKind(id, "user_message");
      if (!lastUser) {
        return reply.code(400).send({ error: "no_user_message" });
      }

      // Attachments aren't editable yet — a resend would need to either
      // re-link the existing attachment rows onto a new user_message seq
      // or drop them. Refuse cleanly so the UI can show a tooltip rather
      // than silently dropping the attached files.
      const prevPayload = lastUser.payload as Record<string, unknown>;
      const prevAttachments = prevPayload.attachments;
      if (Array.isArray(prevAttachments) && prevAttachments.length > 0) {
        return reply.code(400).send({ error: "has_attachments" });
      }

      const newText = parsed.data.text;

      // 1. Drop every event after the user_message being edited — those
      //    responses are no longer reachable from the transcript.
      sessions.deleteEventsAboveSeq(id, lastUser.seq);

      // 2. Rewrite the user_message payload. Preserve every pre-existing
      //    key so future fields aren't accidentally wiped, then overwrite
      //    `text` and stamp `editedAt`.
      const nextPayload: Record<string, unknown> = {
        ...prevPayload,
        text: newText,
        editedAt: new Date().toISOString(),
      };
      sessions.updateEventPayload(id, lastUser.seq, nextPayload);

      // 3. Bump last_message_at so Home ordering reflects the edit.
      sessions.touchLastMessage(id);

      // 4. Kick the runner. The manager flips status→running, broadcasts a
      //    refresh_transcript frame, and pushes the edited text into the
      //    SDK. We don't await the runner's reply — this endpoint returns
      //    as soon as the edit is persisted and the run has been queued.
      try {
        await deps.manager.rerunFromEditedMessage(id, newText);
      } catch (err) {
        req.log.warn(
          { err, sessionId: id },
          "rerunFromEditedMessage failed after edit; transcript edited but no assistant turn queued",
        );
      }

      return reply.send({ ok: true, seq: lastUser.seq });
    },
  );

  // POST /api/sessions/:id/fork
  //
  // Fork a session at a specific `upToSeq` into a brand-new top-level session
  // under the same project. The new session inherits `project_id`, `model`,
  // and `mode` from the source; it does NOT inherit `sdk_session_id` — the
  // fork is a fresh SDK conversation, and the model has no memory of being
  // forked. Events with `seq <= upToSeq` are copied verbatim into the fork
  // with a normalized 1..N seq sequence.
  //
  // Body `{ upToSeq?, title? }`:
  //  - `upToSeq` omitted → fork at the latest event in the source.
  //  - `title` omitted → `"Fork of <source.title>"`, truncated at 60 chars.
  //
  // Error codes:
  //   401 — auth gate (via requireAuth)
  //   404 not_found   — source session doesn't exist
  //   409 archived    — source is archived (fork from a read-only session
  //                     would be misleading; unarchive or export first)
  //   400 bad_request — body schema mismatch (upToSeq not a number, etc.)
  app.post(
    "/api/sessions/:id/fork",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = ForkSessionRequest.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });

      const source = sessions.findById(id);
      if (!source) return reply.code(404).send({ error: "not_found" });
      if (source.status === "archived") {
        return reply.code(409).send({ error: "archived" });
      }

      const fork = sessions.forkSession(
        id,
        parsed.data.upToSeq,
        parsed.data.title,
      );
      // forkSession returns null only when the source row vanished between
      // our findById and the call — treat it as a 404 for symmetry.
      if (!fork) return reply.code(404).send({ error: "not_found" });
      return reply.send({ session: fork });
    },
  );

  // POST /api/sessions/:id/rewind
  //
  // Roll the session's tracked files back to their state at the user message
  // with seq `upToSeq`. This is the bundled CLI's own checkpoint feature —
  // the CLI snapshots files before every write (sessions started with
  // `enableFileCheckpointing`, i.e. every claudex-run session since this
  // route landed) and `rewindFiles` restores the backups. claudex only
  // forwards: resolves the CLI-side anchor UUID for the target message,
  // then issues the SDK control request either on the session's live runner
  // or (idle sessions) on a short-lived resumed CLI child.
  //
  // Conversation history is deliberately untouched — only files are rolled
  // back (the CLI transcript keeps the later turns). To restart from a clean
  // context, fork at the same seq instead.
  //
  // Body `{ upToSeq, dryRun? }`:
  //  - `upToSeq` must point at a `user_message` event (the rewind anchor).
  //  - `dryRun: true` previews filesChanged/insertions/deletions without
  //    touching the filesystem.
  //
  // Error codes:
  //   401 — auth gate (via requireAuth)
  //   404 not_found         — session doesn't exist / has no project
  //   409 archived          — rewinding a read-only session is misleading
  //   409 no_cli_session    — session has no SDK conversation yet (never
  //                           sent a message), so no transcript / checkpoints
  //   409 transcript_missing— SDK session id set but its JSONL isn't under
  //                           the CLI projects root
  //   400 bad_request / not_a_user_message
  //   422 anchor_unresolved — could not map `upToSeq` to a CLI transcript
  //                           record (alignment mismatch); try a newer
  //                           session or re-sync first
  //   500 rewind_failed     — CLI child errored during the rewind
  app.post(
    "/api/sessions/:id/rewind",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = RewindSessionRequest.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });

      const session = sessions.findById(id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      if (session.status === "archived") {
        return reply.code(409).send({ error: "archived" });
      }
      const sdkId = session.sdkSessionId;
      if (!sdkId) {
        return reply.code(409).send({ error: "no_cli_session" });
      }

      const event = sessions.findEventBySeq(id, parsed.data.upToSeq);
      if (!event || event.kind !== "user_message") {
        return reply.code(400).send({ error: "not_a_user_message" });
      }

      // CLI-side anchor: the transcript UUID of the user record this event
      // corresponds to. Ordinal alignment against the JSONL — see
      // cli-rewind.ts for the visibility rules both sides share.
      const jsonl = await locateSessionJsonl(deps.cliProjectsRoot, sdkId);
      if (!jsonl) {
        return reply.code(409).send({ error: "transcript_missing" });
      }
      const nth = sessions.countUserMessagesUpTo(id, parsed.data.upToSeq);
      const anchor = await resolveAnchorUuid(jsonl, nth);
      if (!anchor) {
        return reply.code(422).send({ error: "anchor_unresolved" });
      }

      const project = projects.findById(session.projectId);
      const cwd = session.worktreePath ?? project?.path;
      if (!cwd) return reply.code(404).send({ error: "not_found" });

      const dryRun = parsed.data.dryRun;
      try {
        // Live runner first (its CLI child owns the session), else resume
        // the SDK conversation for one control request and tear it down.
        const result =
          (await deps.manager.tryRewindViaLiveRunner(id, anchor, dryRun)) ??
          (await rewindViaResume({
            cwd,
            sdkSessionId: sdkId,
            userMessageId: anchor,
            dryRun,
            model: session.model,
          }));
        const out = RewindSessionResult.safeParse(result);
        return reply.send(
          out.success ? out.data : { canRewind: false, error: "unexpected" },
        );
      } catch (err) {
        app.log.warn({ err, sessionId: id }, "rewind failed");
        return reply.code(500).send({ error: "rewind_failed" });
      }
    },
  );

  // POST /api/sessions/:id/force-idle
  //
  // Escape hatch for the "stuck-running" failure mode. When the user sees a
  // session that's been `running` or `error` for minutes with no activity
  // (watchdog didn't fire because its in-memory timer was wiped by a
  // restart, or the SDK died in a way that didn't surface), this endpoint
  // force-transitions the row back to `idle` so the composer unlocks and a
  // fresh turn becomes possible.
  //
  // Idempotent: a 200 response means the row is now idle, not necessarily
  // that we flipped anything. We always emit an audit row so forensics can
  // count how often users are having to bail themselves out — if the
  // number climbs, the watchdog window or the on-boot sweep needs tuning.
  app.post(
    "/api/sessions/:id/force-idle",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = sessions.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      if (existing.status === "archived") {
        // Archived is a deliberate terminal state — flipping it to idle
        // here would re-open the composer, which the rest of the archive
        // flow assumes is locked. Refuse cleanly so the UI can render a
        // tooltip rather than silently stashing a write.
        return reply.code(409).send({ error: "archived" });
      }
      deps.manager.forceIdle(id, "user_forced_idle");
      const ctx = getRequestCtx(req);
      deps.audit.append({
        userId: ctx.userId,
        event: "session_forced_idle",
        target: id,
        detail: `from ${existing.status}`,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      const updated = sessions.findById(id)!;
      return reply.send({ session: updated });
    },
  );

  // -- tool grants ---------------------------------------------------------

  app.get(
    "/api/sessions/:id/grants",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!sessions.findById(id))
        return reply.code(404).send({ error: "not_found" });
      const rows = grants.listForSession(id);
      const out: ToolGrant[] = rows.map((r) => ({
        id: r.id,
        toolName: r.tool_name,
        signature: r.input_signature,
        scope: r.session_id === null ? "global" : "session",
        createdAt: r.created_at,
      }));
      return reply.send({ grants: out });
    },
  );

  // Flat listing of every tool grant on the machine. Used by Settings →
  // Security's Granted-tools card so the user can audit and revoke grants
  // without first drilling into each session. Global grants sort first
  // (biggest blast radius → shown first), then session-scoped grants;
  // within each group, newest first. Session-scoped rows include the
  // owning session's id + title so the UI can label "which session" and
  // link back.
  app.get(
    "/api/grants",
    { preHandler: app.requireAuth as any },
    async (_req, reply) => {
      const rows = grants.listAllGrants();
      const out: ToolGrant[] = rows.map((r) => {
        const scope: "session" | "global" =
          r.session_id === null ? "global" : "session";
        const base: ToolGrant = {
          id: r.id,
          toolName: r.tool_name,
          signature: r.input_signature,
          scope,
          createdAt: r.created_at,
        };
        if (scope === "session") {
          base.sessionId = r.session_id ?? undefined;
          // `session_title` can be NULL if the FK cascade somehow raced
          // with the read (it shouldn't — cascade drops the grant row
          // too — but be defensive rather than coerce to "").
          if (r.session_title != null) base.sessionTitle = r.session_title;
        }
        return base;
      });
      return reply.send({ grants: out });
    },
  );

  app.delete(
    "/api/grants/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = grants.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      grants.revoke(id);
      return reply.send({ ok: true });
    },
  );
}
