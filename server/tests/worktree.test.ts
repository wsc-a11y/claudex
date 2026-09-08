import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bootstrapAuthedApp, createTmpGitRepo } from "./helpers.js";
import {
  isGitRepo,
  createWorktree,
  removeWorktree,
  WorktreeError,
} from "../src/sessions/worktree.js";

const execFileP = promisify(execFile);

describe("isGitRepo", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("returns true when <path>/.git is a directory", async () => {
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    expect(fs.statSync(path.join(repo.path, ".git")).isDirectory()).toBe(true);
    await expect(isGitRepo(repo.path)).resolves.toBe(true);
  });

  it("returns false when there is no .git entry", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claudex-nogit-"));
    disposers.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(isGitRepo(dir)).resolves.toBe(false);
  });

  it("returns true when .git is a file (submodule / linked worktree)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claudex-gitfile-"));
    disposers.push(() => rmSync(dir, { recursive: true, force: true }));
    // A gitfile points at the real gitdir; the pointer target doesn't need to
    // exist for isGitRepo — it only inspects whether `.git` is present.
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /nowhere\n");
    await expect(isGitRepo(dir)).resolves.toBe(true);
  });
});

describe("createWorktree / removeWorktree", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("creates a branch and worktree on disk", async () => {
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const res = await createWorktree({
      projectPath: repo.path,
      sessionId: "sess123",
      title: "Fix the thing",
    });
    expect(res.branch).toBe("claude/fix-the-thing");
    expect(res.path).toBe(
      path.join(repo.path, ".claude", "worktrees", "sess123"),
    );
    expect(fs.existsSync(res.path)).toBe(true);
    // git sees the branch
    const branches = execFileSync("git", ["branch", "--list"], {
      cwd: repo.path,
      encoding: "utf8",
    });
    expect(branches).toMatch(/claude\/fix-the-thing/);
  });

  it("suffixes the branch name to avoid collisions", async () => {
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const first = await createWorktree({
      projectPath: repo.path,
      sessionId: "sess-a",
      title: "same title",
    });
    const second = await createWorktree({
      projectPath: repo.path,
      sessionId: "sess-b",
      title: "same title",
    });
    expect(first.branch).toBe("claude/same-title");
    // The second one should have a non-empty suffix, not equal the first.
    expect(second.branch).not.toBe(first.branch);
    expect(second.branch.startsWith("claude/same-title-")).toBe(true);
  });

  it("throws WorktreeError when the project isn't a git repo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claudex-notgit-"));
    disposers.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(
      createWorktree({
        projectPath: dir,
        sessionId: "sess1",
        title: "x",
      }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });

  it("removeWorktree tears down the directory and git registration", async () => {
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const wt = await createWorktree({
      projectPath: repo.path,
      sessionId: "sess-rm",
      title: "rm me",
    });
    await removeWorktree(wt.path);
    expect(fs.existsSync(wt.path)).toBe(false);
    // `git worktree list` no longer shows it
    const { stdout } = await execFileP("git", ["worktree", "list"], {
      cwd: repo.path,
    });
    expect(stdout).not.toContain(wt.path);
  });
});

describe("POST /api/sessions { worktree: true }", () => {
  const disposers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  async function createProject(
    ctx: {
      app: import("fastify").FastifyInstance;
      cookie: string;
      dbh: import("../src/db/index.js").ClaudexDb;
    },
    projPath: string,
  ) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: path.basename(projPath), path: projPath },
    });
    const project = res.json().project as { id: string; path: string };
    // Trust so POST /api/sessions can spawn under it — worktree tests care
    // about git interaction, not the trust gate.
    ctx.dbh.db
      .prepare("UPDATE projects SET trusted = 1 WHERE id = ?")
      .run(project.id);
    return project;
  }

  it("creates a real worktree on a git repo and persists path + branch", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const project = await createProject(ctx, repo.path);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: ctx.cookie },
      payload: {
        projectId: project.id,
        title: "Hydration fix",
        model: "claude-opus-4-8",
        mode: "default",
        worktree: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const session = res.json().session;
    expect(session.worktreePath).toBe(
      path.join(repo.path, ".claude", "worktrees", session.id),
    );
    expect(session.branch).toMatch(/^claude\/hydration-fix/);
    // dir exists on disk
    expect(fs.existsSync(session.worktreePath)).toBe(true);
    // branch is a real ref
    const branches = execFileSync("git", ["branch", "--list"], {
      cwd: repo.path,
      encoding: "utf8",
    });
    expect(branches).toContain(session.branch);
  });

  it("rejects worktree: true on a non-git project with 400 not_a_git_repo", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    // ctx.tmpDir is a plain tmp dir — not a git repo
    const project = await createProject(ctx, ctx.tmpDir);

    const before = ctx.dbh.db
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .get() as { n: number };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: ctx.cookie },
      payload: {
        projectId: project.id,
        title: "whatever",
        model: "claude-opus-4-8",
        mode: "default",
        worktree: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_a_git_repo");

    const after = ctx.dbh.db
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("worktree: false leaves worktreePath + branch null (existing behavior)", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const project = await createProject(ctx, ctx.tmpDir);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: ctx.cookie },
      payload: {
        projectId: project.id,
        title: "plain",
        model: "claude-opus-4-8",
        mode: "default",
        worktree: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const session = res.json().session;
    expect(session.worktreePath).toBeNull();
    expect(session.branch).toBeNull();
  });

  it("collision on same title falls back to a suffixed branch", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const project = await createProject(ctx, repo.path);

    const makeSession = async () => {
      const r = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "Dup title",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: true,
        },
      });
      return r.json().session;
    };

    const a = await makeSession();
    const b = await makeSession();
    expect(a.branch).toBe("claude/dup-title");
    expect(b.branch).not.toBe(a.branch);
    expect(b.branch.startsWith("claude/dup-title-")).toBe(true);
  });
});

describe("POST /api/sessions/:id/archive with worktree", () => {
  const disposers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("removes the worktree directory on archive", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const project = await ctx.app
      .inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: repo.path },
      })
      .then((r) => r.json().project);
    ctx.dbh.db
      .prepare("UPDATE projects SET trusted = 1 WHERE id = ?")
      .run(project.id);
    const session = await ctx.app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "archive me",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: true,
        },
      })
      .then((r) => r.json().session);
    expect(fs.existsSync(session.worktreePath)).toBe(true);

    const r = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/archive`,
      headers: { cookie: ctx.cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(fs.existsSync(session.worktreePath)).toBe(false);
  });

  it("survives a missing worktree dir (user rm'd it) and still archives", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const project = await ctx.app
      .inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: repo.path },
      })
      .then((r) => r.json().project);
    ctx.dbh.db
      .prepare("UPDATE projects SET trusted = 1 WHERE id = ?")
      .run(project.id);
    const session = await ctx.app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "ghost",
          model: "claude-opus-4-8",
          mode: "default",
          worktree: true,
        },
      })
      .then((r) => r.json().session);
    // Wipe the worktree dir from under git's nose.
    fs.rmSync(session.worktreePath, { recursive: true, force: true });

    const r = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/archive`,
      headers: { cookie: ctx.cookie },
    });
    expect(r.statusCode).toBe(200);
    // Session is archived despite cleanup warning.
    const fetched = await ctx.app
      .inject({
        method: "GET",
        url: `/api/sessions/${session.id}`,
        headers: { cookie: ctx.cookie },
      })
      .then((r) => r.json().session);
    expect(fetched.status).toBe("archived");
  });
});
