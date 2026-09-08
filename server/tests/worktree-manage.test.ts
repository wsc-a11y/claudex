import { describe, it, expect, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bootstrapAuthedApp, createTmpGitRepo } from "./helpers.js";
import {
  listClaudexWorktrees,
  pruneOrphan,
} from "../src/sessions/worktree-manage.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";

const execFileP = promisify(execFile);

// Skip the whole suite if git isn't on PATH — CI images without git can't run
// any of this, and we'd rather skip than fail noisily.
let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  gitAvailable = false;
}
const d = gitAvailable ? describe : describe.skip;

// Helper: create a `claude/*` worktree on a repo by hand. Mirrors what
// `createWorktree` does in production, but avoids coupling this test to that
// module's branch-suffix logic — we want to control branch names exactly.
async function addClaudeWorktree(
  repoPath: string,
  branch: string,
  subDir: string,
): Promise<string> {
  const worktreePath = path.join(repoPath, ".claude", "worktrees", subDir);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await execFileP(
    "git",
    ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
    { cwd: repoPath },
  );
  return worktreePath;
}

d("listClaudexWorktrees", () => {
  const disposers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("returns empty array when no projects are registered", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projects = new ProjectStore(ctx.dbh.db);
    const sessions = new SessionStore(ctx.dbh.db);
    const res = await listClaudexWorktrees({ projects, sessions });
    expect(res).toEqual([]);
  });

  it(
    "returns claude/* worktrees and classifies linked vs orphaned",
    async () => {
      const ctx = await bootstrapAuthedApp();
      disposers.push(ctx.cleanup);
      const repo = createTmpGitRepo();
      disposers.push(repo.cleanup);

      // One linked worktree (matches a live session.branch), one orphan.
      const linkedPath = await addClaudeWorktree(
        repo.path,
        "claude/linked-one",
        "sess-linked",
      );
      const orphanPath = await addClaudeWorktree(
        repo.path,
        "claude/orphan-one",
        "sess-orphan",
      );
      // Sanity: also add a non-claude branch, to confirm it's filtered out.
      const featurePath = path.join(repo.path, ".claude", "worktrees", "feat");
      await execFileP(
        "git",
        ["worktree", "add", "-b", "feature/unrelated", featurePath, "HEAD"],
        { cwd: repo.path },
      );

      const projects = new ProjectStore(ctx.dbh.db);
      const sessions = new SessionStore(ctx.dbh.db);
      const project = projects.create({
        name: "demo",
        path: repo.path,
        trusted: true,
      });
      sessions.create({
        title: "linked session",
        projectId: project.id,
        model: "claude-opus-4-8",
        mode: "default",
        branch: "claude/linked-one",
        worktreePath: linkedPath,
      });

      const res = await listClaudexWorktrees({ projects, sessions });
      const branches = res.map((w) => w.branch).sort();
      expect(branches).toEqual(["claude/linked-one", "claude/orphan-one"]);
      const linked = res.find((w) => w.branch === "claude/linked-one")!;
      const orphan = res.find((w) => w.branch === "claude/orphan-one")!;
      expect(linked.status).toBe("linked");
      expect(orphan.status).toBe("orphaned");
      expect(linked.projectId).toBe(project.id);
      expect(linked.projectName).toBe("demo");
      // macOS /var → /private/var resolution: compare via realpath.
      expect(fs.realpathSync(linked.path)).toBe(fs.realpathSync(linkedPath));
      expect(fs.realpathSync(orphan.path)).toBe(fs.realpathSync(orphanPath));
      // sha populated from porcelain
      expect(linked.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(orphan.sha).toMatch(/^[0-9a-f]{40}$/);
    },
  );

  it("skips projects whose path no longer exists", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    await addClaudeWorktree(repo.path, "claude/keeper", "sess-k");

    const gone = mkdtempSync(path.join(tmpdir(), "claudex-gone-"));
    // Initialize then nuke to simulate a registered project path that has
    // since been deleted.
    rmSync(gone, { recursive: true, force: true });

    const projects = new ProjectStore(ctx.dbh.db);
    const sessions = new SessionStore(ctx.dbh.db);
    projects.create({ name: "gone", path: gone, trusted: true });
    projects.create({ name: "live", path: repo.path, trusted: true });

    const res = await listClaudexWorktrees({ projects, sessions });
    // Only the live project's worktree comes back — the gone one is
    // silently skipped.
    expect(res).toHaveLength(1);
    expect(res[0].branch).toBe("claude/keeper");
  });
});

d("pruneOrphan", () => {
  const disposers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("removes git registration, branch, and directory", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const wtPath = await addClaudeWorktree(
      repo.path,
      "claude/prune-me",
      "sess-prune",
    );

    const res = await pruneOrphan({
      projectPath: repo.path,
      branch: "claude/prune-me",
      path: wtPath,
    });
    expect(res.removed).toBe(true);
    expect(res.error).toBeUndefined();
    // worktree dir gone
    expect(fs.existsSync(wtPath)).toBe(false);
    // branch gone
    const branches = execFileSync("git", ["branch", "--list"], {
      cwd: repo.path,
      encoding: "utf8",
    });
    expect(branches).not.toMatch(/claude\/prune-me/);
    // git worktree list no longer mentions it
    const { stdout } = await execFileP("git", ["worktree", "list"], {
      cwd: repo.path,
    });
    expect(stdout).not.toContain(wtPath);
  });

  it("refuses to prune branches outside claude/*", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const res = await pruneOrphan({
      projectPath: repo.path,
      branch: "feature/something",
      path: "/tmp/whatever",
    });
    expect(res.removed).toBe(false);
    expect(res.error).toMatch(/refused/);
  });

  it("refuses to prune a path outside the project directory", async () => {
    // Defense against a forged request: even with a legit `claude/*`
    // branch name, the target `path` must be inside the project — otherwise
    // the defensive rm at the end of pruneOrphan would nuke an arbitrary
    // absolute path on the host.
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    // Set up a real worktree inside the project so the branch is plausible;
    // then call prune with a branch-looks-legit but path-is-outside payload.
    await addClaudeWorktree(repo.path, "claude/legit", "sess-legit");

    // Create a sibling directory OUTSIDE the project to prove it survives.
    const outside = mkdtempSync(path.join(tmpdir(), "claudex-outside-"));
    disposers.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    });
    const outsideFile = path.join(outside, "important.txt");
    fs.writeFileSync(outsideFile, "precious", "utf8");

    const res = await pruneOrphan({
      projectPath: repo.path,
      branch: "claude/legit",
      path: outside,
    });
    expect(res.removed).toBe(false);
    expect(res.error).toBe("path_out_of_project");
    // Outside directory must be untouched.
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("precious");
  });

  it("handles a worktree whose directory is already gone", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const wtPath = await addClaudeWorktree(
      repo.path,
      "claude/ghost",
      "sess-ghost",
    );
    // User manually nuked the worktree dir, leaving the git registration
    // dangling — this is exactly the orphan-cleanup case.
    fs.rmSync(wtPath, { recursive: true, force: true });

    const res = await pruneOrphan({
      projectPath: repo.path,
      branch: "claude/ghost",
      path: wtPath,
    });
    expect(res.removed).toBe(true);
    // branch is also cleaned
    const branches = execFileSync("git", ["branch", "--list"], {
      cwd: repo.path,
      encoding: "utf8",
    });
    expect(branches).not.toMatch(/claude\/ghost/);
  });
});

d("GET /api/worktrees + POST /api/worktrees/prune", () => {
  const disposers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/worktrees",
    });
    expect(res.statusCode).toBe(401);
  });

  it("lists and bulk-prunes orphan worktrees", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    const wtPath = await addClaudeWorktree(
      repo.path,
      "claude/old-thing",
      "sess-old",
    );

    const projects = new ProjectStore(ctx.dbh.db);
    const project = projects.create({
      name: "demo",
      path: repo.path,
      trusted: true,
    });

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/api/worktrees",
      headers: { cookie: ctx.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const worktrees = listRes.json().worktrees as Array<{
      branch: string;
      status: string;
      projectId: string;
      path: string;
    }>;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].branch).toBe("claude/old-thing");
    expect(worktrees[0].status).toBe("orphaned");

    // Bulk prune
    const pruneRes = await ctx.app.inject({
      method: "POST",
      url: "/api/worktrees/prune",
      headers: { cookie: ctx.cookie },
      payload: {
        worktrees: [
          {
            projectId: project.id,
            branch: "claude/old-thing",
            path: wtPath,
          },
        ],
      },
    });
    expect(pruneRes.statusCode).toBe(200);
    const body = pruneRes.json() as {
      results: Array<{ removed: boolean; branch: string }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].removed).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});
