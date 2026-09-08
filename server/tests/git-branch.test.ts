import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTmpGitRepo } from "./helpers.js";
import { resolveCurrentBranch } from "../src/sessions/git-branch.js";

// ---------------------------------------------------------------------------
// resolveCurrentBranch — best-effort git branch lookup for non-worktree
// session creation. Null on anything we can't classify; exposed for tests so
// the three interesting paths (real branch / non-git / detached HEAD) can be
// verified.
// ---------------------------------------------------------------------------

describe("resolveCurrentBranch", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("returns the current branch name in a normal git repo", async () => {
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    await expect(resolveCurrentBranch(repo.path)).resolves.toBe("main");
  });

  it("returns null for a non-git directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claudex-nogit-"));
    disposers.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(resolveCurrentBranch(dir)).resolves.toBeNull();
  });

  it("returns null when HEAD is detached", async () => {
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    // Check out the current commit as a detached HEAD. After this
    // `rev-parse --abbrev-ref HEAD` prints the literal string "HEAD".
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo.path,
    })
      .toString()
      .trim();
    execFileSync("git", ["checkout", "--detach", sha], {
      cwd: repo.path,
      stdio: "pipe",
    });
    await expect(resolveCurrentBranch(repo.path)).resolves.toBeNull();
  });

  it("returns null for a path that does not exist", async () => {
    const missing = path.join(
      tmpdir(),
      `claudex-missing-${Math.random().toString(36).slice(2)}`,
    );
    expect(fs.existsSync(missing)).toBe(false);
    await expect(resolveCurrentBranch(missing)).resolves.toBeNull();
  });

  it("reports a different branch name after checkout", async () => {
    const repo = createTmpGitRepo();
    disposers.push(repo.cleanup);
    execFileSync("git", ["checkout", "-b", "feature/foo"], {
      cwd: repo.path,
      stdio: "pipe",
    });
    await expect(resolveCurrentBranch(repo.path)).resolves.toBe("feature/foo");
  });
});
