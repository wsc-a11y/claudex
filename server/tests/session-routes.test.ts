import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapAuthedApp, trustProject } from "./helpers.js";
import type { ClaudexDb } from "../src/db/index.js";
import type {
  Runner,
  RunnerFactory,
  RunnerListener,
  RunnerEvent,
} from "../src/sessions/runner.js";
import type { PermissionMode } from "@claudex/shared";

const bootstrap = bootstrapAuthedApp;

describe("session HTTP routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("rejects unauthenticated access", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/projects",
    });
    expect(res.statusCode).toBe(401);
  });

  describe("POST /api/projects", () => {
    it("creates a project with a real directory path", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: ctx.tmpDir },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.project.name).toBe("demo");
      expect(body.project.path).toBe(ctx.tmpDir);
    });

    it("rejects a non-existent path", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: "/nope/does/not/exist" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("path_not_a_directory");
    });

    it("rejects a duplicate path with 409", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const once = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "a", path: ctx.tmpDir },
      });
      expect(once.statusCode).toBe(200);
      const twice = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "b", path: ctx.tmpDir },
      });
      expect(twice.statusCode).toBe(409);
    });
  });

  describe("PATCH /api/projects/:id", () => {
    async function createProject(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
    }) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "orig", path: ctx.tmpDir },
      });
      return res.json().project as { id: string };
    }

    it("requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${proj.id}`,
        payload: { name: "new" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("renames a project and the change is visible in GET", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const patched = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${proj.id}`,
        headers: { cookie: ctx.cookie },
        payload: { name: "renamed" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().project.name).toBe("renamed");
      // and it sticks
      const list = await ctx.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
      });
      const found = list
        .json()
        .projects.find((p: { id: string }) => p.id === proj.id);
      expect(found.name).toBe("renamed");
    });

    it("rejects an empty name with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${proj.id}`,
        headers: { cookie: ctx.cookie },
        payload: { name: "" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    });

    it("returns 404 for an unknown project id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: "/api/projects/no-such-id",
        headers: { cookie: ctx.cookie },
        payload: { name: "whatever" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });
  });

  describe("DELETE /api/projects/:id", () => {
    async function createProject(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
      dbh: ClaudexDb;
    }) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "to-delete", path: ctx.tmpDir },
      });
      const project = res.json().project as { id: string };
      // Trust so the "has_sessions" test can spawn a session under this
      // project; every other DELETE test ignores trust.
      trustProject(ctx.dbh, project.id);
      return project;
    }

    it("requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/projects/${proj.id}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("deletes a project with no sessions", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/projects/${proj.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const list = await ctx.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
      });
      const exists = list
        .json()
        .projects.some((p: { id: string }) => p.id === proj.id);
      expect(exists).toBe(false);
    });

    it("refuses to delete a project that has sessions (409 has_sessions)", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: proj.id,
          title: "s",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: false,
        },
      });
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/projects/${proj.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe("has_sessions");
      expect(body.sessionCount).toBe(1);
    });

    it("returns 404 for an unknown project id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/projects/no-such-id",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/projects/cleanup-empty", () => {
    it("requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects/cleanup-empty",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns zero when there are no empty projects", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects/cleanup-empty",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: 0, removedNames: [] });
    });

    it("removes only projects with zero sessions, leaving the rest", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      // Three projects: A (empty), B (empty), C (has a session). Each needs a
      // distinct path because the unique constraint on `projects.path` rejects
      // duplicates.
      const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-a-"));
      const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-b-"));
      const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-c-"));
      try {
        const mk = async (name: string, p: string) => {
          const r = await ctx.app.inject({
            method: "POST",
            url: "/api/projects",
            headers: { cookie: ctx.cookie },
            payload: { name, path: p },
          });
          return r.json().project as { id: string; name: string };
        };
        const a = await mk("alpha", tmpA);
        const b = await mk("bravo", tmpB);
        const c = await mk("charlie", tmpC);
        trustProject(ctx.dbh, c.id);
        await ctx.app.inject({
          method: "POST",
          url: "/api/sessions",
          headers: { cookie: ctx.cookie },
          payload: {
            projectId: c.id,
            title: "keep-me",
            model: "claude-opus-4-8",
            mode: "default",
            worktree: false,
          },
        });

        const res = await ctx.app.inject({
          method: "POST",
          url: "/api/projects/cleanup-empty",
          headers: { cookie: ctx.cookie },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.removed).toBe(2);
        expect(body.removedNames.sort()).toEqual(["alpha", "bravo"]);

        const list = await ctx.app.inject({
          method: "GET",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
        });
        const ids = list
          .json()
          .projects.map((p: { id: string }) => p.id)
          .sort();
        expect(ids).toEqual([c.id]);
        // sanity: the unrelated id `a` and `b` must not survive
        expect(ids).not.toContain(a.id);
        expect(ids).not.toContain(b.id);
      } finally {
        fs.rmSync(tmpA, { recursive: true, force: true });
        fs.rmSync(tmpB, { recursive: true, force: true });
        fs.rmSync(tmpC, { recursive: true, force: true });
      }
    });
  });

  describe("POST /api/sessions", () => {
    async function addProject(
      ctx: { app: FastifyInstance; cookie: string; tmpDir: string; dbh: ClaudexDb },
    ) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: ctx.tmpDir },
      });
      const project = res.json().project;
      trustProject(ctx.dbh, project.id);
      return project;
    }

    it("creates a session under an existing project", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const project = await addProject(ctx);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "first",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const session = res.json().session;
      expect(session.title).toBe("first");
      expect(session.status).toBe("idle");
    });

    it("rejects a session for an unknown project", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: "bogus",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: false,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("project_not_found");
    });

    it("rejects malformed payload", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: { projectId: "whatever" }, // missing model/mode
      });
      expect(res.statusCode).toBe(400);
    });

    // Trust gate: an untrusted project refuses to spawn sessions with
    // 409 project_not_trusted; flipping the bit via the trust endpoint
    // makes the next create succeed; untrusting puts the gate back.
    // Mirrors the NewSessionSheet's "Trust this folder?" confirm step.
    it("refuses to create a session when the project is untrusted (409)", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const project = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "untrusted", path: ctx.tmpDir },
        })
        .then((r) => r.json().project as { id: string; trusted: boolean });
      expect(project.trusted).toBe(false);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "nope",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: false,
        },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe("project_not_trusted");
      expect(body.projectId).toBe(project.id);
    });

    it("trust via endpoint → create succeeds; untrust → next create 409 again", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const project = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "tog", path: ctx.tmpDir },
        })
        .then((r) => r.json().project as { id: string });

      const trustRes = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/trust`,
        headers: { cookie: ctx.cookie },
        payload: { trusted: true },
      });
      expect(trustRes.statusCode).toBe(200);
      expect(trustRes.json().project.trusted).toBe(true);

      const ok = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "after-trust",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: false,
        },
      });
      expect(ok.statusCode).toBe(200);

      const untrustRes = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/trust`,
        headers: { cookie: ctx.cookie },
        payload: { trusted: false },
      });
      expect(untrustRes.statusCode).toBe(200);
      expect(untrustRes.json().project.trusted).toBe(false);

      const blocked = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "after-untrust",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: false,
        },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toBe("project_not_trusted");
    });
  });

  describe("POST /api/projects/:id/trust", () => {
    it("rejects unauthenticated", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects/anything/trust",
        payload: { trusted: true },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for an unknown project", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects/no-such-id/trust",
        headers: { cookie: ctx.cookie },
        payload: { trusted: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects a non-boolean body with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const project = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "demo", path: ctx.tmpDir },
        })
        .then((r) => r.json().project as { id: string });
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/trust`,
        headers: { cookie: ctx.cookie },
        payload: { trusted: "yes" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("flips the trust bit and is idempotent", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const project = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "demo", path: ctx.tmpDir },
        })
        .then((r) => r.json().project as { id: string; trusted: boolean });
      expect(project.trusted).toBe(false);

      const up = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/trust`,
        headers: { cookie: ctx.cookie },
        payload: { trusted: true },
      });
      expect(up.statusCode).toBe(200);
      expect(up.json().project.trusted).toBe(true);

      const again = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/trust`,
        headers: { cookie: ctx.cookie },
        payload: { trusted: true },
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().project.trusted).toBe(true);

      const down = await ctx.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/trust`,
        headers: { cookie: ctx.cookie },
        payload: { trusted: false },
      });
      expect(down.statusCode).toBe(200);
      expect(down.json().project.trusted).toBe(false);
    });
  });

  describe("GET /api/sessions*", () => {
    async function seed(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
      dbh: ClaudexDb;
    }) {
      const proj = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "demo", path: ctx.tmpDir },
        })
        .then((r) => r.json().project);
      trustProject(ctx.dbh, proj.id);
      const s = await ctx.app
        .inject({
          method: "POST",
          url: "/api/sessions",
          headers: { cookie: ctx.cookie },
          payload: {
            projectId: proj.id,
            title: "t",
            model: "claude-opus-4-8",
            mode: "default",
            worktree: false,
          },
        })
        .then((r) => r.json().session);
      return { proj, s };
    }

    it("lists sessions, scoped by project query", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { proj } = await seed(ctx);

      const all = await ctx.app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
      });
      expect(all.statusCode).toBe(200);
      expect(all.json().sessions).toHaveLength(1);

      const scoped = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions?project=${proj.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(scoped.statusCode).toBe(200);
      expect(scoped.json().sessions).toHaveLength(1);
    });

    it("gets a specific session, returns 404 otherwise", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);

      const ok = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(ok.statusCode).toBe(200);

      const missing = await ctx.app.inject({
        method: "GET",
        url: "/api/sessions/no-such-id",
        headers: { cookie: ctx.cookie },
      });
      expect(missing.statusCode).toBe(404);
    });

    it("lists events with sinceSeq filter", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);
      const r = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/events`,
        headers: { cookie: ctx.cookie },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.events).toEqual([]);
      // Back-compat: no pagination params → hasMore:false, oldestSeq:null
      expect(body.hasMore).toBe(false);
      expect(body.oldestSeq).toBeNull();
    });

    it("paginates /events: empty session with limit returns hasMore=false", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);
      const r = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/events?limit=100`,
        headers: { cookie: ctx.cookie },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.events).toEqual([]);
      expect(body.hasMore).toBe(false);
      expect(body.oldestSeq).toBeNull();
    });

    it("paginates /events: limit returns tail ASC with hasMore + beforeSeq pages older", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);
      // Seed 300 events in-band via direct DB writes. Keeps the test focused
      // on route shape — the store-level insert is already covered elsewhere.
      const stmt = ctx.dbh.db.prepare(
        `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (let i = 0; i < 300; i++) {
        stmt.run(
          `ev-${i}`,
          s.id,
          "user_message",
          i,
          now,
          JSON.stringify({ text: `msg-${i}` }),
        );
      }

      const page1 = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}/events?limit=100`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json() as {
          events: Array<{ seq: number }>;
          hasMore: boolean;
          oldestSeq: number | null;
        });
      // Last 100, ASC: seq 200..299
      expect(page1.events).toHaveLength(100);
      expect(page1.events[0].seq).toBe(200);
      expect(page1.events.at(-1)!.seq).toBe(299);
      expect(page1.hasMore).toBe(true);
      expect(page1.oldestSeq).toBe(200);

      const page2 = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}/events?limit=100&beforeSeq=200`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json() as {
          events: Array<{ seq: number }>;
          hasMore: boolean;
          oldestSeq: number | null;
        });
      expect(page2.events).toHaveLength(100);
      expect(page2.events[0].seq).toBe(100);
      expect(page2.events.at(-1)!.seq).toBe(199);
      expect(page2.hasMore).toBe(true);
      expect(page2.oldestSeq).toBe(100);

      const page3 = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}/events?limit=100&beforeSeq=100`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json() as {
          events: Array<{ seq: number }>;
          hasMore: boolean;
          oldestSeq: number | null;
        });
      expect(page3.events).toHaveLength(100);
      expect(page3.events[0].seq).toBe(0);
      expect(page3.events.at(-1)!.seq).toBe(99);
      // Absolute oldest now reached — hasMore must be false.
      expect(page3.hasMore).toBe(false);
      expect(page3.oldestSeq).toBe(0);
    });

    it("returns usage-summary with zeros on an empty session", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);
      const r = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/usage-summary`,
        headers: { cookie: ctx.cookie },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.totalInput).toBe(0);
      expect(body.totalOutput).toBe(0);
      expect(body.lastTurnInput).toBe(0);
      expect(body.lastTurnContextKnown).toBe(false);
      expect(body.turnCount).toBe(0);
      expect(body.perModel).toEqual([]);
    });

    it("archives a session", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);
      const r = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/archive`,
        headers: { cookie: ctx.cookie },
      });
      expect(r.statusCode).toBe(200);
      const fetched = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json().session);
      expect(fetched.status).toBe("archived");
      expect(fetched.archivedAt).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/sessions/:id
  //
  // Hard delete: row gone, events gone (FK CASCADE), side-chat children gone
  // (self-referential FK CASCADE). Worktree cleanup is best-effort; we don't
  // exercise the worktree branch here because creating a real git repo per
  // test is expensive and `worktree.test.ts` already covers removeWorktree.
  // ---------------------------------------------------------------------------
  describe("DELETE /api/sessions/:id", () => {
    async function seedSession(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
      dbh: ClaudexDb;
    }) {
      const proj = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "demo", path: ctx.tmpDir },
        })
        .then((r) => r.json().project);
      trustProject(ctx.dbh, proj.id);
      const s = await ctx.app
        .inject({
          method: "POST",
          url: "/api/sessions",
          headers: { cookie: ctx.cookie },
          payload: {
            projectId: proj.id,
            title: "goner",
            model: "claude-opus-4-8",
            mode: "default",
            worktree: false,
          },
        })
        .then((r) => r.json().session as { id: string });
      return { proj, s };
    }

    it("rejects unauthenticated", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/sessions/${s.id}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for an unknown session id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/sessions/no-such-id",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    it("hard-deletes the session row and cascades its events", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // Seed an event so we can prove cascade.
      const now = new Date().toISOString();
      ctx.dbh.db
        .prepare(
          `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("ev-1", s.id, "user_message", 0, now, JSON.stringify({ text: "hi" }));

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(204);

      // Row gone.
      const rowAfter = ctx.dbh.db
        .prepare("SELECT id FROM sessions WHERE id = ?")
        .get(s.id);
      expect(rowAfter).toBeUndefined();

      // Events cascaded.
      const eventsAfter = ctx.dbh.db
        .prepare("SELECT id FROM session_events WHERE session_id = ?")
        .all(s.id);
      expect(eventsAfter).toHaveLength(0);

      // And a follow-up GET 404s.
      const fetched = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(fetched.statusCode).toBe(404);
    });

    it("cascades delete to side-chat children", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // Spawn a /btw side chat off the parent.
      const side = await ctx.app
        .inject({
          method: "POST",
          url: `/api/sessions/${s.id}/side`,
          headers: { cookie: ctx.cookie },
          payload: {},
        })
        .then((r) => r.json().session as { id: string });
      expect(side.id).toBeTruthy();

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(204);

      // Parent gone, child gone too.
      const parentRow = ctx.dbh.db
        .prepare("SELECT id FROM sessions WHERE id = ?")
        .get(s.id);
      expect(parentRow).toBeUndefined();
      const childRow = ctx.dbh.db
        .prepare("SELECT id FROM sessions WHERE id = ?")
        .get(side.id);
      expect(childRow).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/sessions/:id/force-idle
  //
  // Escape hatch for sessions stuck in running/error — user can force the
  // row back to idle so the composer unlocks. Happy path + auth / not_found /
  // archived refusal + audit trail.
  // ---------------------------------------------------------------------------
  describe("POST /api/sessions/:id/force-idle", () => {
    async function seedSession(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
      dbh: ClaudexDb;
    }) {
      const proj = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "demo", path: ctx.tmpDir },
        })
        .then((r) => r.json().project);
      trustProject(ctx.dbh, proj.id);
      const s = await ctx.app
        .inject({
          method: "POST",
          url: "/api/sessions",
          headers: { cookie: ctx.cookie },
          payload: {
            projectId: proj.id,
            title: "stuck",
            model: "claude-opus-4-8",
            mode: "default",
            worktree: false,
          },
        })
        .then((r) => r.json().session as { id: string });
      return s;
    }

    it("rejects unauthenticated callers with 401", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions/nope/force-idle",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for an unknown session", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions/bogus-id/force-idle",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    it("flips a running session back to idle and audits", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedSession(ctx);
      // Put the row in `running` as if a turn were in flight.
      ctx.dbh.db
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(s.id);

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/force-idle`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { session: { id: string; status: string } };
      expect(body.session.status).toBe("idle");

      const dbStatus = ctx.dbh.db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .get(s.id) as { status: string };
      expect(dbStatus.status).toBe("idle");

      // Audit row written.
      const auditRows = ctx.dbh.db
        .prepare(
          "SELECT event, target, detail FROM audit_events WHERE target = ? AND event = 'session_forced_idle'",
        )
        .all(s.id) as Array<{ event: string; target: string; detail: string }>;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].detail).toBe("from running");
    });

    it("refuses with 409 archived when the session has been archived", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedSession(ctx);
      ctx.dbh.db
        .prepare(
          "UPDATE sessions SET status = 'archived', archived_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), s.id);

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/force-idle`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("archived");
    });

    it("is idempotent on an already-idle session (200, no audit delta)", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedSession(ctx);
      // Row is idle by default.
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/force-idle`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().session as { status: string }).status).toBe("idle");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/sessions/:id/pending-diffs
  //
  // We seed events directly via the SessionStore so the test doesn't need to
  // drive an actual Runner (the permission_request flow is already covered
  // end-to-end in session-manager.test.ts). Here we just check the HTTP
  // wiring: empty when no events, shaped right when a request is pending.
  // ---------------------------------------------------------------------------
  describe("GET /api/sessions/:id/pending-diffs", () => {
    async function addProject(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
      dbh: ClaudexDb;
    }) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: ctx.tmpDir },
      });
      const project = res.json().project;
      trustProject(ctx.dbh, project.id);
      return project;
    }

    async function createSession(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
      dbh: ClaudexDb;
    }) {
      const project = await addProject(ctx);
      const s = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "diffs",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: false,
        },
      });
      return s.json().session as { id: string };
    }

    it("rejects unauthenticated", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await createSession(ctx);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/pending-diffs`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for an unknown session", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/sessions/nope/pending-diffs",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns an empty array when the session has no pending edits", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await createSession(ctx);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/pending-diffs`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ diffs: [] });
    });

    it("returns a single-entry diff list when a permission_request is pending", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await createSession(ctx);
      // Seed directly into the event store — matches what SessionManager
      // writes when it sees a permission_request RunnerEvent.
      const now = new Date().toISOString();
      ctx.dbh.db
        .prepare(
          `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ev-1",
          s.id,
          "permission_request",
          0,
          now,
          JSON.stringify({
            toolUseId: "tu-1",
            toolName: "Edit",
            input: {
              file_path: "/repo/src/date.ts",
              old_string: "locale?: string",
              new_string: "locale = \"en-US\"",
            },
            title: "Edit file",
          }),
        );

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/pending-diffs`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        diffs: Array<{
          toolUseId: string;
          approvalId?: string;
          filePath: string;
          kind: string;
          addCount: number;
          delCount: number;
          hunks: Array<{ header: string; lines: unknown[] }>;
          title: string | null;
        }>;
      };
      expect(body.diffs).toHaveLength(1);
      const d = body.diffs[0];
      expect(d.toolUseId).toBe("tu-1");
      expect(d.approvalId).toBe("tu-1");
      expect(d.kind).toBe("edit");
      expect(d.filePath).toBe("/repo/src/date.ts");
      expect(d.addCount).toBe(1);
      expect(d.delCount).toBe(1);
      expect(d.hunks).toHaveLength(1);
      expect(d.title).toBe("Edit file");
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/sessions/:id
  //
  // A minimal recording runner — just enough to verify that a mode change
  // hits the live runner via setPermissionMode. Everything else is a noop.
  // ---------------------------------------------------------------------------
  class RecordingRunner implements Runner {
    sessionId: string;
    sdkSessionId: string | null = null;
    modeChanges: PermissionMode[] = [];
    userMessages: string[] = [];
    private listeners = new Set<RunnerListener>();
    constructor(sessionId: string) {
      this.sessionId = sessionId;
    }
    async start() {}
    async sendUserMessage(content: string) {
      this.userMessages.push(content);
    }
    resolvePermission() {}
    resolveAskUserQuestion() {}
    resolvePlanAccept() {}
    async interrupt() {}
    async setPermissionMode(mode: PermissionMode) {
      this.modeChanges.push(mode);
    }
    async dispose() {
      this.listeners.clear();
    }
    on(l: RunnerListener) {
      this.listeners.add(l);
      return () => this.listeners.delete(l);
    }
    listenerCount() {
      return this.listeners.size;
    }
    emit(ev: RunnerEvent) {
      for (const l of this.listeners) l(ev);
    }
  }

  function makeRecordingFactory(): {
    factory: RunnerFactory;
    last: () => RecordingRunner | null;
  } {
    let last: RecordingRunner | null = null;
    return {
      factory: {
        create(opts) {
          last = new RecordingRunner(opts.sessionId);
          return last;
        },
      },
      last: () => last,
    };
  }

  async function seedSession(ctx: {
    app: FastifyInstance;
    cookie: string;
    tmpDir: string;
    dbh: ClaudexDb;
  }) {
    const proj = await ctx.app
      .inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: ctx.tmpDir },
      })
      .then((r) => r.json().project);
    trustProject(ctx.dbh, proj.id);
    const s = await ctx.app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: proj.id,
          title: "orig",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: false,
        },
      })
      .then((r) => r.json().session);
    return { proj, s };
  }

  describe("PATCH /api/sessions/:id", () => {
    it("rejects unauthenticated", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        payload: { title: "hacked" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("updates the title and persists it", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { title: "fix hydration" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.title).toBe("fix hydration");
      expect(body.warnings).toBeUndefined();
      const fetched = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json().session);
      expect(fetched.title).toBe("fix hydration");
    });

    it("changing mode propagates to the live runner", async () => {
      const { factory, last } = makeRecordingFactory();
      const ctx = await bootstrap(factory);
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // Attach a runner to this session so the PATCH handler has something
      // to propagate the mode to. getOrCreate is idempotent and matches the
      // path SessionManager takes on the first user message.
      ctx.manager.getOrCreate(s.id);
      const runner = last()!;
      expect(runner).not.toBeNull();

      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { mode: "acceptEdits" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().session.mode).toBe("acceptEdits");
      expect(runner.modeChanges).toEqual(["acceptEdits"]);
    });

    it("changing model on an idle session does not warn", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { model: "claude-sonnet-4-6" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.model).toBe("claude-sonnet-4-6");
      expect(body.warnings).toBeUndefined();
    });

    it("changing model on a running session returns the next-turn warning", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // Normalise effort to `high` up-front. The seed creates an opus-4-8
      // session which now defaults to `xhigh`; switching to haiku-4-5
      // below would clamp that → high and emit a second warning we don't
      // want in this test's assertion. Doing the normalisation on the
      // still-idle session keeps warnings empty here.
      ctx.dbh.db
        .prepare("UPDATE sessions SET effort = 'high' WHERE id = ?")
        .run(s.id);
      // Flip status to running via a direct DB write — matches what
      // SessionManager does on the first status:running event.
      ctx.dbh.db
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(s.id);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { model: "claude-haiku-4-5" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.model).toBe("claude-haiku-4-5");
      expect(body.warnings).toEqual(["model_change_applies_to_next_turn"]);
    });

    it("clamps xhigh → high when the model is switched away from Opus", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // Seed defaults to xhigh because we created it with opus-4-8 and no
      // explicit effort. Sanity-check that the rule holds from creation.
      expect(s.effort).toBe("xhigh");
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { model: "claude-sonnet-4-6" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.model).toBe("claude-sonnet-4-6");
      // Server must downgrade the now-unsupported xhigh to high — not leave
      // the row in an invalid state for the next SDK turn.
      expect(body.session.effort).toBe("high");
    });

    it("rejects xhigh when PATCHed onto a non-Opus-4.7 session by clamping to high", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // First move to sonnet so the model lane is non-opus, then try to
      // push xhigh directly.
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { model: "claude-sonnet-4-6" },
      });
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { effort: "xhigh" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.effort).toBe("high");
    });

    it("refuses to patch an archived session (409)", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/archive`,
        headers: { cookie: ctx.cookie },
      });
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { title: "hello" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("archived");
    });

    it("rejects an empty body with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    });

    it("returns 404 for an unknown session id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: "/api/sessions/nope",
        headers: { cookie: ctx.cookie },
        payload: { title: "x" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    // -----------------------------------------------------------------------
    // Tags — validated at the HTTP surface via SessionTag + the 8-tag cap on
    // UpdateSessionRequest. Round-trip via GET to prove persistence.
    // -----------------------------------------------------------------------
    it("persists tags on PATCH and round-trips via GET", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const patched = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { tags: ["bug", "backend", "p0"] },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().session.tags).toEqual(["bug", "backend", "p0"]);
      const fetched = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json().session);
      expect(fetched.tags).toEqual(["bug", "backend", "p0"]);
    });

    it("replaces the full tag list (not append) and can clear to empty", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { tags: ["a", "b", "c"] },
      });
      const replaced = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { tags: ["d"] },
      });
      expect(replaced.json().session.tags).toEqual(["d"]);
      const cleared = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { tags: [] },
      });
      expect(cleared.json().session.tags).toEqual([]);
    });

    it("rejects a non-string tag with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { tags: ["ok", 42] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    });

    it("rejects a tag longer than 24 chars with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { tags: ["x".repeat(25)] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    });

    it("rejects a tag with invalid characters with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { tags: ["Bug!"] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    });

    it("rejects more than 8 tags with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: {
          tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    });

    // -----------------------------------------------------------------------
    // Pinned — backed by migration 16. Pinned sessions sort to the top of
    // Home's session list regardless of activity recency. Round-trip via GET
    // to prove the DB bit flipped and the DTO reflects the new value.
    // -----------------------------------------------------------------------
    it("pins a session on PATCH and round-trips via GET", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // New sessions default to unpinned.
      expect(s.pinned).toBe(false);
      const patched = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { pinned: true },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().session.pinned).toBe(true);
      // DB row reflects the flip.
      const row = ctx.dbh.db
        .prepare("SELECT pinned FROM sessions WHERE id = ?")
        .get(s.id) as { pinned: number };
      expect(row.pinned).toBe(1);
      // GET returns the same DTO.
      const fetched = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json().session);
      expect(fetched.pinned).toBe(true);
    });

    it("unpins a previously pinned session", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { pinned: true },
      });
      const unpinned = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { pinned: false },
      });
      expect(unpinned.statusCode).toBe(200);
      expect(unpinned.json().session.pinned).toBe(false);
      const row = ctx.dbh.db
        .prepare("SELECT pinned FROM sessions WHERE id = ?")
        .get(s.id) as { pinned: number };
      expect(row.pinned).toBe(0);
    });
  });

  describe("tool grants REST", () => {
    async function seedGrants(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
      dbh: { db: import("better-sqlite3").Database };
    }) {
      const { s } = await seedSession(ctx);
      // Insert two session-scoped grants and one global grant directly via DB
      // so the test is decoupled from the permission flow.
      const now = new Date().toISOString();
      ctx.dbh.db
        .prepare(
          `INSERT INTO tool_grants (id, session_id, tool_name, input_signature, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("g-sess-1", s.id, "Bash", "pnpm test", now);
      ctx.dbh.db
        .prepare(
          `INSERT INTO tool_grants (id, session_id, tool_name, input_signature, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("g-sess-2", s.id, "Edit", "/tmp/x.ts", now);
      ctx.dbh.db
        .prepare(
          `INSERT INTO tool_grants (id, session_id, tool_name, input_signature, created_at)
           VALUES (?, NULL, ?, ?, ?)`,
        )
        .run("g-global", "Grep", "TODO", now);
      return s;
    }

    it("GET /grants requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedGrants(ctx);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/grants`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /grants returns session + global grants with correct scope", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedGrants(ctx);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/grants`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const grants = res.json().grants as Array<{
        id: string;
        toolName: string;
        signature: string;
        scope: "session" | "global";
      }>;
      expect(grants).toHaveLength(3);
      const byId = Object.fromEntries(grants.map((g) => [g.id, g]));
      expect(byId["g-sess-1"].scope).toBe("session");
      expect(byId["g-sess-1"].toolName).toBe("Bash");
      expect(byId["g-sess-2"].scope).toBe("session");
      expect(byId["g-global"].scope).toBe("global");
      expect(byId["g-global"].toolName).toBe("Grep");
    });

    it("DELETE /grants/:id removes the grant", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedGrants(ctx);
      const del = await ctx.app.inject({
        method: "DELETE",
        url: `/api/grants/g-sess-1`,
        headers: { cookie: ctx.cookie },
      });
      expect(del.statusCode).toBe(200);
      const list = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/grants`,
        headers: { cookie: ctx.cookie },
      });
      const ids = list.json().grants.map((g: { id: string }) => g.id);
      expect(ids).not.toContain("g-sess-1");
    });

    it("DELETE /grants/:id returns 404 for unknown id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      await seedGrants(ctx);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/grants/no-such-grant`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    it("GET /api/grants requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      await seedGrants(ctx);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/grants`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /api/grants returns global + session grants, global first, newest first within group", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedGrants(ctx);
      // Add a second global grant at a later timestamp so we can verify
      // the secondary sort (created_at DESC within a scope group).
      ctx.dbh.db
        .prepare(
          `INSERT INTO tool_grants (id, session_id, tool_name, input_signature, created_at)
           VALUES (?, NULL, ?, ?, ?)`,
        )
        .run("g-global-2", "Bash", "ls -la", "2030-01-01T00:00:00Z");
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/grants`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const grants = res.json().grants as Array<{
        id: string;
        toolName: string;
        signature: string;
        scope: "session" | "global";
        sessionId?: string;
        sessionTitle?: string;
        createdAt: string;
      }>;
      expect(grants).toHaveLength(4);
      // Global rows come first.
      expect(grants[0].scope).toBe("global");
      expect(grants[1].scope).toBe("global");
      expect(grants[2].scope).toBe("session");
      expect(grants[3].scope).toBe("session");
      // Within global: newest (g-global-2 @ 2030) before g-global (seeded now()).
      // `seedGrants` uses `new Date().toISOString()` which is in 2026, so
      // g-global-2 at 2030 sorts first.
      expect(grants[0].id).toBe("g-global-2");
      expect(grants[1].id).toBe("g-global");
      // Session rows carry owning session metadata; global rows don't.
      const globalRow = grants[0];
      expect(globalRow.sessionId).toBeUndefined();
      expect(globalRow.sessionTitle).toBeUndefined();
      const sessionRow = grants.find((g) => g.id === "g-sess-1")!;
      expect(sessionRow.sessionId).toBe(s.id);
      expect(typeof sessionRow.sessionTitle).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/sessions/:id/edit-last-user-message
  //
  // Typo-recovery flow. The happy path reuses the `RecordingRunner` +
  // `makeRecordingFactory` defined in the PATCH block above so we can
  // observe the edited prompt being re-sent into the runner without
  // actually spinning up a real claude subprocess.
  // ---------------------------------------------------------------------------
  describe("POST /api/sessions/:id/edit-last-user-message", () => {
    it("rejects unauthenticated", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/edit-last-user-message`,
        payload: { text: "new" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for an unknown session id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions/nope/edit-last-user-message",
        headers: { cookie: ctx.cookie },
        payload: { text: "x" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    it("returns 409 not_idle when the session is running", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // Flip status to running via a direct DB write — matches what
      // SessionManager does on the first status:running event.
      ctx.dbh.db
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(s.id);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/edit-last-user-message`,
        headers: { cookie: ctx.cookie },
        payload: { text: "new" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_idle");
    });

    it("returns 400 no_user_message when the session has no user_message", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/edit-last-user-message`,
        headers: { cookie: ctx.cookie },
        payload: { text: "anything" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("no_user_message");
    });

    it("happy path: truncates events above the user_message, rewrites text + editedAt, re-kicks the runner", async () => {
      const { factory, last } = makeRecordingFactory();
      const ctx = await bootstrap(factory);
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);

      // Seed 1 user_message + 1 assistant_text via direct DB writes —
      // we're testing the route shape, not SessionStore.appendEvent.
      const now = new Date().toISOString();
      ctx.dbh.db
        .prepare(
          `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ev-user-1",
          s.id,
          "user_message",
          0,
          now,
          JSON.stringify({ text: "typoed message" }),
        );
      ctx.dbh.db
        .prepare(
          `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ev-assistant-1",
          s.id,
          "assistant_text",
          1,
          now,
          JSON.stringify({ text: "…reply to the typo." }),
        );

      // Attach a runner to the session so rerunFromEditedMessage has
      // somewhere to push the edited text.
      ctx.manager.getOrCreate(s.id);
      const runner = last()!;
      expect(runner).not.toBeNull();

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/edit-last-user-message`,
        headers: { cookie: ctx.cookie },
        payload: { text: "fixed message" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.seq).toBe(0);

      // Events above seq 0 must be gone; the user_message payload must
      // carry the new text + an editedAt stamp.
      const rows = ctx.dbh.db
        .prepare(
          "SELECT seq, kind, payload FROM session_events WHERE session_id = ? ORDER BY seq ASC",
        )
        .all(s.id) as Array<{ seq: number; kind: string; payload: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].seq).toBe(0);
      expect(rows[0].kind).toBe("user_message");
      const editedPayload = JSON.parse(rows[0].payload) as {
        text: string;
        editedAt?: string;
      };
      expect(editedPayload.text).toBe("fixed message");
      expect(typeof editedPayload.editedAt).toBe("string");

      // The runner should have received the edited prompt as a follow-up
      // user message. RecordingRunner captures every sendUserMessage call
      // into its `userMessages` array.
      expect(runner.userMessages).toContain("fixed message");
    });

    it("refuses edit when the last user_message carries attachments (400 has_attachments)", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const now = new Date().toISOString();
      ctx.dbh.db
        .prepare(
          `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ev-user-att",
          s.id,
          "user_message",
          0,
          now,
          JSON.stringify({
            text: "look at this",
            attachments: [
              { id: "att-1", filename: "cat.png", mime: "image/png", size: 42 },
            ],
          }),
        );
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/edit-last-user-message`,
        headers: { cookie: ctx.cookie },
        payload: { text: "new" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("has_attachments");
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/sessions/:id/fork
  //
  // Branch a session at a specific seq into a brand-new session under the
  // same project. The fork inherits project / model / mode, copies every
  // event with `seq <= upToSeq` verbatim (renumbered 1..N), and starts with
  // a null sdk_session_id so the SDK treats it as a fresh conversation.
  // ---------------------------------------------------------------------------
  describe("POST /api/sessions/:id/fork", () => {
    async function seedWithEvents(
      ctx: {
        app: FastifyInstance;
        cookie: string;
        tmpDir: string;
        dbh: ClaudexDb;
      },
      count: number,
      opts?: { title?: string },
    ) {
      const proj = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "demo", path: ctx.tmpDir },
        })
        .then((r) => r.json().project);
      trustProject(ctx.dbh, proj.id);
      const s = await ctx.app
        .inject({
          method: "POST",
          url: "/api/sessions",
          headers: { cookie: ctx.cookie },
          payload: {
            projectId: proj.id,
            title: opts?.title ?? "origin",
            model: "claude-opus-4-8",
            mode: "acceptEdits",
            worktree: false,
          },
        })
        .then((r) => r.json().session as { id: string });
      // Seed `count` events, alternating user / assistant so we can verify
      // kinds and payloads round-trip intact.
      const now = new Date().toISOString();
      const stmt = ctx.dbh.db.prepare(
        `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < count; i++) {
        const kind = i % 2 === 0 ? "user_message" : "assistant_text";
        stmt.run(
          `ev-${i}`,
          s.id,
          kind,
          i,
          now,
          JSON.stringify({ text: `m-${i}` }),
        );
      }
      return { proj, s };
    }

    it("rejects unauthenticated", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedWithEvents(ctx, 0);
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/fork`,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for an unknown session id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions/no-such-id/fork",
        headers: { cookie: ctx.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });

    it("returns 409 archived when the source session is archived", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedWithEvents(ctx, 2);
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/archive`,
        headers: { cookie: ctx.cookie },
      });
      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/fork`,
        headers: { cookie: ctx.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("archived");
    });

    it("happy path: fork at seq 5 copies 5 events with fresh ids and matching kinds/payloads", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      // Source has 10 events at seq 0..9.
      const { proj, s } = await seedWithEvents(ctx, 10);

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/fork`,
        headers: { cookie: ctx.cookie },
        payload: { upToSeq: 4 }, // copy seq 0..4 → 5 events in the fork
      });
      expect(res.statusCode).toBe(200);
      const fork = res.json().session as {
        id: string;
        projectId: string;
        model: string;
        mode: string;
        sdkSessionId: string | null;
        parentSessionId: string | null;
        forkedFromSessionId: string | null;
        status: string;
        title: string;
      };
      expect(fork.id).not.toBe(s.id);
      expect(fork.projectId).toBe(proj.id);
      expect(fork.model).toBe("claude-opus-4-8");
      expect(fork.mode).toBe("acceptEdits");
      expect(fork.sdkSessionId).toBeNull();
      expect(fork.parentSessionId).toBeNull();
      // Forked sessions carry a back-reference to their source so the chat
      // header can render a "Forked" badge making the SDK-context-reset
      // honest to the user.
      expect(fork.forkedFromSessionId).toBe(s.id);
      expect(fork.status).toBe("idle");
      expect(fork.title).toBe("Fork of origin");

      // Source events for seq 0..4
      const sourceRows = ctx.dbh.db
        .prepare(
          "SELECT id, kind, seq, payload FROM session_events WHERE session_id = ? AND seq <= 4 ORDER BY seq ASC",
        )
        .all(s.id) as Array<{
        id: string;
        kind: string;
        seq: number;
        payload: string;
      }>;
      expect(sourceRows).toHaveLength(5);

      // Fork events should be 5 rows, renumbered 1..5, same kinds/payloads,
      // but with *different* ids than the source rows.
      const forkRows = ctx.dbh.db
        .prepare(
          "SELECT id, kind, seq, payload FROM session_events WHERE session_id = ? ORDER BY seq ASC",
        )
        .all(fork.id) as Array<{
        id: string;
        kind: string;
        seq: number;
        payload: string;
      }>;
      expect(forkRows).toHaveLength(5);
      expect(forkRows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
      for (let i = 0; i < 5; i++) {
        expect(forkRows[i].kind).toBe(sourceRows[i].kind);
        expect(forkRows[i].payload).toBe(sourceRows[i].payload);
        // Fresh id per fork row — no collision with the source.
        expect(forkRows[i].id).not.toBe(sourceRows[i].id);
      }

      // Source is untouched — it still has its full 10 events.
      const srcTotal = ctx.dbh.db
        .prepare("SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?")
        .get(s.id) as { c: number };
      expect(srcTotal.c).toBe(10);

      // And the fork row's raw `forked_from_session_id` column is populated —
      // the DTO check above is the contract; this one guards against a DTO
      // remapping accidentally decoupling from the underlying storage.
      const forkRow = ctx.dbh.db
        .prepare("SELECT forked_from_session_id FROM sessions WHERE id = ?")
        .get(fork.id) as { forked_from_session_id: string | null };
      expect(forkRow.forked_from_session_id).toBe(s.id);
    });

    it("fork inherits project_id / model / mode but NOT sdk_session_id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { proj, s } = await seedWithEvents(ctx, 3);
      // Stamp an sdk_session_id on the source so we can prove it doesn't
      // leak into the fork row.
      ctx.dbh.db
        .prepare("UPDATE sessions SET sdk_session_id = ? WHERE id = ?")
        .run("sdk-abc-123", s.id);

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/fork`,
        headers: { cookie: ctx.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const fork = res.json().session as {
        id: string;
        projectId: string;
        model: string;
        mode: string;
        sdkSessionId: string | null;
      };
      expect(fork.projectId).toBe(proj.id);
      expect(fork.model).toBe("claude-opus-4-8");
      expect(fork.mode).toBe("acceptEdits");
      // The whole point — the fork is a fresh SDK conversation.
      expect(fork.sdkSessionId).toBeNull();
      // Omitted upToSeq forks at the latest event (seq 2 → 3 events copied,
      // renumbered 1..3).
      const forkRows = ctx.dbh.db
        .prepare(
          "SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq ASC",
        )
        .all(fork.id) as Array<{ seq: number }>;
      expect(forkRows.map((r) => r.seq)).toEqual([1, 2, 3]);
    });

    it("title is truncated to 60 chars when the source title is long", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      // 80-char source title → fork title `"Fork of "` (8) + 52 chars + "…"
      // = 60 chars total. Verifies both the ellipsis and the length cap.
      const longTitle = "x".repeat(80);
      const { s } = await seedWithEvents(ctx, 1, { title: longTitle });

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/fork`,
        headers: { cookie: ctx.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const fork = res.json().session as { title: string };
      expect(fork.title.length).toBe(60);
      expect(fork.title.endsWith("…")).toBe(true);
      expect(fork.title.startsWith("Fork of ")).toBe(true);
    });
  });
});
