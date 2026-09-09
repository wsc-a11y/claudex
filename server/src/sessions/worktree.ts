import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";

const execFileP = promisify(execFile);

/**
 * Thrown when `git worktree add` (or related git plumbing) fails. The caller
 * turns this into a 400 with a stderr summary so the user can see what git
 * said — we don't want to swallow the actual reason.
 */
export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

/**
 * Is the given directory a git repository? Handles both the usual ".git
 * directory" case and the "'.git' is a file" case used by submodules and
 * worktrees themselves (a gitfile pointing at the real .git dir).
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  const dotGit = path.join(projectPath, ".git");
  try {
    const st = fs.lstatSync(dotGit);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * Turn a free-form title into a slug safe for a git branch name. Keeps letters,
 * digits, dot, underscore, dash. Collapses whitespace and other separators into
 * a single dash, strips leading/trailing dashes, lowercases. Empty or useless
 * inputs fall back to the empty string so the caller can use the session id.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

interface CreateOptions {
  projectPath: string;
  sessionId: string;
  /** Prefix applied to the branch name. Defaults to "claude/". */
  branchPrefix?: string;
  /** Session title; if provided, used to derive the slug. */
  title?: string;
}

interface CreateResult {
  path: string;
  branch: string;
}

/**
 * Create a git worktree at `<projectPath>/.claude/worktrees/<sessionId>` on a
 * new branch. Branch naming strategy:
 *   1. base = `<prefix><slug-of-title>` (or `<prefix><sessionId>` if no title)
 *   2. if that branch already exists, retry with a `-<shortid>` suffix — up to
 *      a handful of attempts. We don't want to loop forever if the repo is in
 *      a weird state; 5 collisions in a row is already suspicious.
 *
 * We never delete the branch on failure — a failed `git worktree add` leaves
 * no branch behind (git is atomic here), and on success the caller owns the
 * branch.
 */
export async function createWorktree(
  opts: CreateOptions,
): Promise<CreateResult> {
  const prefix = opts.branchPrefix ?? "claude/";
  const slug = opts.title ? slugify(opts.title) : "";
  const base = `${prefix}${slug || opts.sessionId}`;

  const worktreeRoot = path.join(opts.projectPath, ".claude", "worktrees");
  const worktreePath = path.join(worktreeRoot, opts.sessionId);

  // Ensure the parent dir exists. `git worktree add` will happily create the
  // final component but not intermediate directories.
  fs.mkdirSync(worktreeRoot, { recursive: true });

  // Try a handful of branch names. First the "clean" one, then add suffixes.
  const attempts: string[] = [base];
  for (let i = 0; i < 4; i++) attempts.push(`${base}-${nanoid(6)}`);

  let lastErr: WorktreeError | null = null;
  for (const branch of attempts) {
    const existing = await branchExists(opts.projectPath, branch);
    if (existing) continue;
    try {
      await execFileP(
        "git",
        ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
        { cwd: opts.projectPath },
      );
      return { path: worktreePath, branch };
    } catch (err) {
      // If the error is specifically "branch already exists" (a race) keep
      // trying; otherwise surface it immediately.
      const stderr =
        typeof (err as { stderr?: unknown }).stderr === "string"
          ? ((err as { stderr: string }).stderr)
          : String(err);
      const msg = `git worktree add failed: ${stderr.trim().split("\n")[0]}`;
      lastErr = new WorktreeError(msg, stderr);
      if (!/already exists/i.test(stderr)) break;
    }
  }
  throw lastErr ?? new WorktreeError("git worktree add exhausted attempts", "");
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    await execFileP(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: projectPath },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a worktree registration and its directory. Intentionally non-fatal:
 * callers handle the throw by logging a warning — a missing worktree on
 * archive should not block the user from archiving the session.
 *
 * We do NOT delete the branch: the user may have work on it they want to
 * merge or inspect. That's a manual `git branch -D` when they're sure.
 *
 * Windows note: `git worktree remove` frequently hits a transient "Permission
 * denied" — a freshly-created worktree's files can be briefly held by the
 * antivirus scanner or a lagging handle. We retry a few times before giving
 * up; the directory removal fallback below also retries for the same reason.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  // `git worktree remove` needs to run inside the main repo, not the worktree
  // itself. We find the main repo by walking up: a worktree's .git is a file
  // with a "gitdir:" pointer, but passing `cwd: worktreePath` works because
  // git resolves the superproject automatically.
  let lastStderr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await execFileP(
        "git",
        ["worktree", "remove", "--force", worktreePath],
        { cwd: worktreePath },
      );
      return;
    } catch (err) {
      const stderr =
        typeof (err as { stderr?: unknown }).stderr === "string"
          ? ((err as { stderr: string }).stderr)
          : String(err);
      lastStderr = stderr;
      // Only transient permission failures are worth a retry — anything else
      // (e.g. "not a working tree", "unknown worktree") won't get better.
      if (!/permission denied/i.test(stderr) || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // On Windows, `git worktree remove` frequently deletes the registration and
  // then fails to delete the (briefly locked) working-tree files — a retry
  // then reports "not a working tree". By that point the git side is done and
  // only the directory removal is outstanding, so fall back to a plain rm.
  // If the rm succeeds the remove's intent is fully met (dir gone, and any
  // stray registration is harmless — `git worktree prune` reaps it). Only
  // when the directory itself cannot be removed (still locked) do we surface
  // the error for the caller's warning log.
  try {
    await rmRetry(worktreePath);
    return;
  } catch {
    /* fall through to the throw */
  }
  throw new WorktreeError(
    `git worktree remove failed: ${lastStderr.trim().split("\n")[0]}`,
    lastStderr,
  );
}

/**
 * `rm -rf` with Windows-friendly retries. A recursive delete of a just-used
 * tree can fail with EBUSY/EPERM while the filesystem releases handles
 * (antivirus scans, indexer, lagging git subprocess) — a short retry loop
 * clears most of those. Only ever removes the path itself, never follows
 * junctions/symlinks into their targets.
 */
async function rmRetry(target: string): Promise<void> {
  const rm = (await import("node:fs/promises")).rm;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 2) throw new Error(`failed to remove ${target}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// ---------------------------------------------------------------------------
// Windows workaround: Claude CLI worktree→parent project resolution bug
// ---------------------------------------------------------------------------

const PROJECT_ID_MAX_LEN = 200;

function normalizeCLIPath(p: string): string {
  return path.normalize(p).replaceAll("\\", "/");
}

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function pathToProjectId(p: string): string {
  const normalized = normalizeCLIPath(p);
  const sanitized = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= PROJECT_ID_MAX_LEN) return sanitized;
  return `${sanitized.slice(0, PROJECT_ID_MAX_LEN)}-${djb2(normalized)}`;
}

/**
 * On Windows, the Claude CLI fails to resolve a worktree path back to its
 * parent project (case-insensitive path comparison bug). This causes the CLI
 * to create a separate `~/.claude/projects/<worktree-id>/` entry, losing the
 * parent project's memory and settings.
 *
 * Workaround: create a directory junction from the "wrong" project dir to the
 * "correct" one so the CLI transparently reads/writes the right location.
 *
 * Non-fatal — failures are logged but never block session creation.
 */
export function ensureWorktreeProjectLink(
  parentProjectPath: string,
  worktreePath: string,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  /**
   * Override the Claude Code home whose `projects/` dir receives the
   * junction. Defaults to `os.homedir()` — the production layout. Tests
   * pass a tmp dir so worktree-session creation on throwaway temp repos
   * never writes into the real `~/.claude/projects` (it would leave
   * `claudex-gitrepo-*` dirs + junctions behind once the repo is deleted).
   */
  claudeHomeDir?: string,
): void {
  if (process.platform !== "win32") return;

  try {
    const correctId = pathToProjectId(parentProjectPath);
    const wrongId = pathToProjectId(worktreePath);
    if (correctId === wrongId) return;

    const claudeProjectsDir = path.join(
      claudeHomeDir ?? os.homedir(),
      ".claude",
      "projects",
    );
    const correctDir = path.join(claudeProjectsDir, correctId);
    const wrongDir = path.join(claudeProjectsDir, wrongId);

    fs.mkdirSync(correctDir, { recursive: true });

    try {
      const st = fs.lstatSync(wrongDir);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) return;
    } catch {
      // doesn't exist — proceed to create the junction
    }

    fs.symlinkSync(correctDir, wrongDir, "junction");
  } catch (err) {
    logger?.warn(
      { err, parentProjectPath, worktreePath },
      "failed to create worktree project junction (non-fatal)",
    );
  }
}
