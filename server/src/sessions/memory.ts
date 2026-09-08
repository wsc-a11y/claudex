import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Read-only CLAUDE.md discovery for the Session settings "Memory" section.
//
// The `claude` CLI treats CLAUDE.md as ambient memory: whatever sits at
// <project>/CLAUDE.md, <project>/.claude/CLAUDE.md, or ~/.claude/CLAUDE.md is
// pulled into the model's context at session start. We want to surface the
// same files inside claudex so the user can see what's actually being loaded
// without guessing. Read-only — editing is a separate future surface; here we
// only ever read and always cap the body to keep a 10 MB CLAUDE.md from
// blowing up the response.
//
// Safety:
//   - `lstat` rather than `stat` so a symlink never silently escapes the
//     project root (or the user-global CLAUDE.md shape)
//   - Symlinks are refused outright — a symlink at any of the probed paths is
//     treated as "no file" rather than following it
//   - Only the three documented paths are probed; we never walk directories
// ---------------------------------------------------------------------------

/** Max bytes of CLAUDE.md content we'll ship back. Anything larger is
 *  truncated and flagged so the UI can show a note. */
export const MEMORY_MAX_BYTES = 64 * 1024;

export type MemoryScope = "project" | "user";

export interface MemoryFile {
  scope: MemoryScope;
  /** Absolute path to the file that was read. */
  path: string;
  /** Real (un-truncated) byte size on disk. */
  bytes: number;
  content: string;
  /** Only set (and true) when `content` was cut at MEMORY_MAX_BYTES. */
  truncated?: boolean;
}

export interface MemoryResponse {
  files: MemoryFile[];
}

/**
 * Resolve the memory files for a given project path.
 *
 * Probes in this order (project scope), returning the first match:
 *   1. `<projectPath>/CLAUDE.md`
 *   2. `<projectPath>/.claude/CLAUDE.md`
 *
 * Always also probes `~/.claude/CLAUDE.md` (user scope). Both can appear in
 * the response — project takes precedence in the UI, but the user-global file
 * is still shown underneath so the user can see what's being layered in.
 *
 * `homeDir` / `readFile` / `lstat` are injectable for tests.
 */
export async function readProjectMemory(
  projectPath: string,
  opts?: {
    homeDir?: string;
    maxBytes?: number;
  },
): Promise<MemoryResponse> {
  const home = opts?.homeDir ?? os.homedir();
  const maxBytes = opts?.maxBytes ?? MEMORY_MAX_BYTES;
  const files: MemoryFile[] = [];

  // --- project scope --------------------------------------------------------
  // Both paths must live under projectPath. `path.resolve` + a prefix check
  // guards against a malformed `projectPath` that already contains `..`
  // (unlikely — the server validates project paths at registration time —
  // but cheap to enforce here so this module stands on its own).
  const projectRoot = path.resolve(projectPath);

  const projectCandidates = [
    path.join(projectRoot, "CLAUDE.md"),
    path.join(projectRoot, ".claude", "CLAUDE.md"),
  ];
  for (const candidate of projectCandidates) {
    const resolved = path.resolve(candidate);
    // Refuse anything that would escape the project root.
    if (
      resolved !== projectRoot &&
      !resolved.startsWith(projectRoot + path.sep)
    ) {
      continue;
    }
    const file = await readMemoryFile(resolved, "project", maxBytes);
    if (file) {
      files.push(file);
      break; // first match wins for project scope
    }
  }

  // --- user scope -----------------------------------------------------------
  const userPath = path.join(home, ".claude", "CLAUDE.md");
  const userFile = await readMemoryFile(userPath, "user", maxBytes);
  if (userFile) files.push(userFile);

  return { files };
}

/**
 * Read a single candidate CLAUDE.md. Returns `null` when the path doesn't
 * exist, isn't a regular file, or is a symlink (symlinks are refused outright
 * so a malicious `CLAUDE.md -> /etc/passwd` can't leak arbitrary host files).
 *
 * Truncates at `maxBytes`; the returned `bytes` always reflects the real
 * on-disk size even when `content` is the truncated prefix.
 */
async function readMemoryFile(
  abs: string,
  scope: MemoryScope,
  maxBytes: number,
): Promise<MemoryFile | null> {
  let lstat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    lstat = await fsp.lstat(abs);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    // EACCES / EPERM: treat as missing. The settings sheet is a diagnostic
    // surface, not a debugger — if we can't read it, we can't show it.
    if (code === "EACCES" || code === "EPERM") return null;
    throw err;
  }
  // Refuse symlinks (even if the target is inside the project root — we'd
  // still have to resolve the realpath and re-check scope. Simpler to decline
  // and document this limitation). Also refuse non-regular files (dirs, fifos).
  if (lstat.isSymbolicLink() || !lstat.isFile()) return null;

  const bytes = lstat.size;
  let content: string;
  let truncated = false;
  if (bytes > maxBytes) {
    // Read only the first maxBytes so we don't buffer a giant file just to
    // slice() it. `readFile` with `length` isn't exposed, but a single
    // FileHandle.read() with a prealloc buffer does the job.
    const fh = await fsp.open(abs, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
      content = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
    truncated = true;
  } else {
    content = await fsp.readFile(abs, "utf8");
  }

  return {
    scope,
    path: abs,
    bytes,
    content,
    ...(truncated ? { truncated: true } : {}),
  };
}
