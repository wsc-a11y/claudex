import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectStore } from "./projects.js";
import type { SessionStore } from "./store.js";

const execFileP = promisify(execFile);

/**
 * One claudex-managed worktree, as surfaced by `listClaudexWorktrees`. Returned
 * by the `GET /api/worktrees` route and rendered by the Settings "Advanced"
 * panel so the user can prune orphan `claude/*` branches + dirs that piled up
 * when sessions were deleted / worktree creation half-failed.
 */
export interface Worktree {
  /** Git branch name — always begins with `claude/`. */
  branch: string;
  /** Absolute path of the worktree directory. */
  path: string;
  /** 40-char commit sha the worktree currently points at, or null when detached/unknown. */
  sha: string | null;
  /** Owning project (claudex `projects` row). */
  projectId: string;
  /** Project's human name (convenience for the UI — saves a client-side join). */
  projectName: string;
  /** Project's absolute path — needed for prune, and so the UI can show it. */
  projectPath: string;
  /** Whether any session row still references this branch / path. */
  status: "linked" | "orphaned";
  /** mtime of the worktree dir, when readable. Missing for dirs that have vanished. */
  lastModified: string | null;
}

/**
 * Parse `git worktree list --porcelain` output into a small struct. Each entry
 * is separated by a blank line; fields we care about: `worktree <path>`,
 * `HEAD <sha>`, `branch refs/heads/<branch>` (or `detached`). Returns an empty
 * array if the output is empty or unparseable — git is authoritative.
 */
function parseWorktreePorcelain(out: string): Array<{
  path: string;
  sha: string | null;
  branch: string | null;
}> {
  const entries: Array<{ path: string; sha: string | null; branch: string | null }> = [];
  let cur: { path?: string; sha: string | null; branch: string | null } = {
    sha: null,
    branch: null,
  };
  const flush = () => {
    if (cur.path) {
      entries.push({ path: cur.path, sha: cur.sha, branch: cur.branch });
    }
    cur = { sha: null, branch: null };
  };
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      cur.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      cur.sha = line.slice("HEAD ".length) || null;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      cur.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line === "detached") {
      cur.branch = null;
    }
  }
  // Final entry may not be followed by a blank line.
  flush();
  return entries;
}

/**
 * Discover every `claude/*` worktree under every claudex-known project and
 * cross-reference against live session rows to classify each as "linked" or
 * "orphaned". Best-effort per project: if a project's path is gone or git is
 * unavailable there, the project is skipped silently — we return whatever we
 * could read elsewhere.
 */
export async function listClaudexWorktrees(deps: {
  projects: ProjectStore;
  sessions: SessionStore;
}): Promise<Worktree[]> {
  const projects = deps.projects.list();
  // Build a set of live (non-archived would still count as "linked" — the
  // worktree is there because a session on it exists) worktree paths + branches.
  // Archived sessions DO keep their worktreePath/branch on the row until the
  // archive worktree-remove step succeeds, so we include archived ones too —
  // if they're still on a session row, the user can delete the session to
  // release them rather than yank the branch out from under it.
  const allSessions = deps.sessions.list({
    includeArchived: true,
    includeSideChats: true,
  });
  const linkedPaths = new Set<string>();
  const linkedBranches = new Set<string>();
  for (const s of allSessions) {
    if (s.worktreePath) {
      linkedPaths.add(s.worktreePath);
      // macOS /var ↔ /private/var (and other symlinked path prefixes) mean
      // the path git hands back may not byte-match the string we persisted
      // on the session row. Add the realpath'd form too so the matcher
      // still lights up.
      try {
        linkedPaths.add(fs.realpathSync(s.worktreePath));
      } catch {
        /* path may no longer exist — fine, the unresolved form is enough */
      }
    }
    if (s.branch) linkedBranches.add(s.branch);
  }

  const out: Worktree[] = [];
  for (const project of projects) {
    let raw: string;
    try {
      const res = await execFileP(
        "git",
        ["-C", project.path, "worktree", "list", "--porcelain"],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      raw = res.stdout;
    } catch {
      // Project path may no longer exist, may not be a git repo, or git may
      // not be installed. Swallow per-project so one bad project can't hide
      // orphans in the others.
      continue;
    }
    const entries = parseWorktreePorcelain(raw);
    for (const e of entries) {
      if (!e.branch) continue;
      if (!/^claude\//.test(e.branch)) continue;

      let lastModified: string | null = null;
      try {
        const st = fs.statSync(e.path);
        lastModified = st.mtime.toISOString();
      } catch {
        // Directory removed from disk — git still has a registration though.
        lastModified = null;
      }

      const status: "linked" | "orphaned" = (() => {
        if (linkedBranches.has(e.branch)) return "linked";
        if (linkedPaths.has(e.path)) return "linked";
        // And try the realpath'd git path against the linked set, in case
        // the session stored a /var form while git hands back /private/var
        // (or vice versa).
        try {
          if (linkedPaths.has(fs.realpathSync(e.path))) return "linked";
        } catch {
          /* path may not exist on disk */
        }
        return "orphaned";
      })();

      out.push({
        branch: e.branch,
        path: e.path,
        sha: e.sha,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        status,
        lastModified,
      });
    }
  }
  // Newest-modified first, orphans bubble up only by mtime — listing is a
  // diagnostic, not a task list.
  out.sort((a, b) => {
    const at = a.lastModified ?? "";
    const bt = b.lastModified ?? "";
    if (at === bt) return a.branch.localeCompare(b.branch);
    return bt.localeCompare(at);
  });
  return out;
}

/**
 * Result of a single prune attempt. `removed` is true when git confirmed the
 * worktree registration is gone (and, if applicable, the branch was deleted).
 * On failure `error` carries a short single-line stderr summary so the UI can
 * render something helpful next to the row instead of swallowing the reason.
 */
export interface PruneResult {
  removed: boolean;
  error?: string;
}

/**
 * Scrub stderr for the first non-empty line, trimmed — every git surface we
 * show has room for a one-liner, not a paragraph.
 */
function firstLine(stderr: unknown): string {
  const s =
    typeof stderr === "string"
      ? stderr
      : (stderr as { stderr?: unknown })?.stderr;
  if (typeof s !== "string") return String(stderr);
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return s.trim();
}

/**
 * Remove an orphan claudex worktree + its branch. Safety-gated on the branch
 * name — we refuse to touch anything outside `claude/*`, so a caller that
 * somehow forges a payload can't prune the user's `main` or `feature/foo`
 * branch. Order:
 *   1. `git -C <project> worktree remove <path> --force` — this also cleans
 *      up the `.git/worktrees/<id>` registration inside the main repo. `--force`
 *      covers the "has modifications" case which is exactly the orphan we're
 *      trying to reach.
 *   2. `git -C <project> branch -D <branch>` — unmerged or not, the user
 *      explicitly asked to prune it. No-op if git already killed the branch.
 *   3. `rm -rf <path>` as a defensive second pass — if step 1 left a stray
 *      directory because git thought it was already removed (the user rm'd
 *      the dir manually earlier), we clean up behind it.
 */
export async function pruneOrphan(input: {
  projectPath: string;
  branch: string;
  path: string;
}): Promise<PruneResult> {
  if (!/^claude\//.test(input.branch)) {
    return { removed: false, error: "refused: branch is not under claude/" };
  }

  // Bound the target path to inside the project. Without this, a caller
  // could pair a legit `claude/xxx` branch with an arbitrary absolute
  // `path` (e.g. `/Users/haowu/important`) and ride the final `fs.rmSync`
  // on someone else's directory. Compare realpaths so /var ↔ /private/var
  // and symlink'd project roots still match as "inside".
  //
  // If the worktree dir has already been nuked on disk (the "ghost"
  // case), `realpathSync` on the path itself fails — walk up to the
  // nearest existing ancestor so we still get a stable canonical form
  // for the prefix check.
  const resolvedPath = path.resolve(input.path);
  const resolvedProject = path.resolve(input.projectPath);
  const canonicalize = (p: string): string => {
    let cur = p;
    // Walk up until realpathSync succeeds. In the worst case we reach the
    // root, which always resolves.
    for (let i = 0; i < 64; i++) {
      try {
        const real = fs.realpathSync(cur);
        // Re-attach any suffix we popped so the resulting string is
        // equivalent to the original, just with symlinks resolved on
        // the existing prefix.
        if (cur === p) return real;
        const suffix = path.relative(cur, p);
        return path.join(real, suffix);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return p; // reached root
        cur = parent;
      }
    }
    return p;
  };
  const realPath = canonicalize(resolvedPath);
  const realProject = canonicalize(resolvedProject);
  const projectPrefix = realProject.endsWith(path.sep)
    ? realProject
    : realProject + path.sep;
  const inside =
    realPath === realProject || realPath.startsWith(projectPrefix);
  if (!inside) {
    return { removed: false, error: "path_out_of_project" };
  }

  let gitRemovedOk = false;
  try {
    await execFileP(
      "git",
      ["-C", input.projectPath, "worktree", "remove", input.path, "--force"],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    gitRemovedOk = true;
  } catch (err) {
    // If the worktree was already unregistered on disk, git says "is not a
    // working tree" — treat that as already-gone and keep going so we can
    // still delete the branch + any stray dir.
    const msg = firstLine(err);
    if (/is not a working tree|does not exist/i.test(msg)) {
      gitRemovedOk = true;
      // Run a `git worktree prune` so the registration is cleaned up.
      try {
        await execFileP("git", ["-C", input.projectPath, "worktree", "prune"]);
      } catch {
        /* best-effort */
      }
    } else {
      return { removed: false, error: `worktree remove failed: ${msg}` };
    }
  }

  // Delete the branch. `-D` force-deletes even if unmerged — the orphan use
  // case is exactly "branch with in-progress work nobody wants".
  try {
    await execFileP(
      "git",
      ["-C", input.projectPath, "branch", "-D", input.branch],
      { maxBuffer: 1024 * 1024 },
    );
  } catch (err) {
    const msg = firstLine(err);
    // "not found" = already gone, fine. Anything else is a real failure.
    if (!/not found|no branch named/i.test(msg)) {
      return {
        removed: gitRemovedOk,
        error: `branch delete failed: ${msg}`,
      };
    }
  }

  // Defensive rm of the dir — `git worktree remove` should have handled this
  // already, but if the user had manually nuked it (or git's idea of the
  // worktree diverged from disk) clean up the path anyway.
  try {
    const abs = path.resolve(input.path);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }

  return { removed: true };
}
