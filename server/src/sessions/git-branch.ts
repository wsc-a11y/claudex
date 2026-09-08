import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Resolve the current branch name for a project directory. Returns the
 * branch name on success, `null` when:
 *   - the directory isn't a git repo,
 *   - git is missing or otherwise errored,
 *   - HEAD is detached (git reports `HEAD` as the "branch"),
 *   - the call took longer than the 2s budget.
 *
 * Used by POST /api/sessions (no-worktree path) to capture the project's
 * current branch at session-creation time, so the Home list shows something
 * real instead of the `?? "main"` fallback.
 *
 * Deliberately best-effort: the session-creation path must not fail because
 * a subshell was slow. A null return just means the UI shows the "no branch"
 * placeholder.
 */
export async function resolveCurrentBranch(
  projectPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: projectPath, timeout: 2000 },
    );
    const name = stdout.trim();
    if (!name || name === "HEAD") return null;
    return name;
  } catch {
    return null;
  }
}
