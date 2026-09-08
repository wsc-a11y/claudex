import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectStore } from "../sessions/projects.js";
import type {
  FilesTreeEntry,
  FilesStatusEntry,
} from "@claudex/shared";

const execFileAsync = promisify(execFile);

// -----------------------------------------------------------------------------
// Files browser REST routes.
//
// Three endpoints, all JWT-gated, all read-only:
//
//   GET /api/files/tree?project=<id>&path=<rel>
//     One directory's immediate children. No recursion — the client expands
//     folders on demand. Dirs first, then files, alphabetical within each.
//     Hidden (leading-dot) entries included. Git status + +/- counts merged
//     in when the project root is a git repo.
//
//   GET /api/files/read?project=<id>&path=<rel>
//     File contents as UTF-8, capped at 1 MB. Binary detection: extension
//     blocklist first (fast, no I/O), then null-byte sniff of the first 512
//     bytes (catches .dat/.bin/etc. without an extension). Both paths return
//     415 binary_file.
//
//   GET /api/files/status?project=<id>
//     Git working-tree summary for the tree rail and preview-strip badges.
//     Degrades gracefully to `isGitRepo: false` when git isn't installed or
//     the project isn't a repo.
//
// SECURITY (load-bearing): every `path` param is resolved via
// `resolveRelPath(projectRoot, input)` before any disk access. The function
// rejects anything that escapes the root ("..", "..%2F", absolute paths).
// Do not reorder the checks.
// -----------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set([
  // images
  "jpg", "jpeg", "png", "gif", "ico", "webp", "bmp", "tiff", "tif",
  // audio / video
  "mp3", "mp4", "wav", "ogg", "flac", "aac", "mkv", "avi", "mov", "wmv",
  // archives
  "zip", "tar", "gz", "bz2", "xz", "rar", "7z", "zst",
  // binaries
  "exe", "dll", "obj", "bin", "wasm", "so", "dylib", "a", "o",
  // docs
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // DBs
  "db", "sqlite", "sqlite3",
  // JVM
  "class", "jar",
  // compiled python
  "pyc",
]);

const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MB

export interface FilesRoutesDeps {
  db: Database.Database;
}

/**
 * Resolve a project-relative path and verify it doesn't escape the root.
 * Returns the absolute path if safe, null otherwise.
 *
 * SECURITY: called before every disk operation keyed to a client-supplied
 * path. The `relPath` parameter is normalized first (strip leading slashes,
 * collapse ".." / "." segments via path.normalize), then resolved against
 * projectRoot, then checked to ensure the result is projectRoot itself OR
 * starts with `projectRoot + path.sep`. Using `path.sep` rather than a
 * hardcoded "/" keeps the check correct on Windows.
 */
function resolveRelPath(projectRoot: string, relPath: string): string | null {
  const normalized = path.normalize(relPath.replace(/^\/+/, ""));
  const abs = path.resolve(projectRoot, normalized);
  const withinRoot =
    abs === projectRoot || abs.startsWith(projectRoot + path.sep);
  return withinRoot ? abs : null;
}

/** Format an octal mode like "-rw-r--r--" for the meta panel. Only covers
 *  POSIX-y bits — Windows callers just see the same-looking rendering
 *  (mode bits are largely ornamental on that OS). */
function formatMode(mode: number): string {
  const chars = ["-", "-", "-", "-", "-", "-", "-", "-", "-", "-"];
  if ((mode & 0o400) !== 0) chars[1] = "r";
  if ((mode & 0o200) !== 0) chars[2] = "w";
  if ((mode & 0o100) !== 0) chars[3] = "x";
  if ((mode & 0o040) !== 0) chars[4] = "r";
  if ((mode & 0o020) !== 0) chars[5] = "w";
  if ((mode & 0o010) !== 0) chars[6] = "x";
  if ((mode & 0o004) !== 0) chars[7] = "r";
  if ((mode & 0o002) !== 0) chars[8] = "w";
  if ((mode & 0o001) !== 0) chars[9] = "x";
  return chars.join("");
}

/** Parse `git status --porcelain=v1` into a Map keyed by relpath (POSIX
 *  separators). For renames the output is "oldname -> newname"; we key by
 *  the new name so it lines up with what's on disk. */
function parseGitStatus(
  raw: string,
): Map<string, { status: "M" | "A" | "D" | "R" }> {
  const map = new Map<string, { status: "M" | "A" | "D" | "R" }>();
  for (const line of raw.split("\n")) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const filePart = line.slice(3);
    let st: "M" | "A" | "D" | "R" | null = null;
    // Renames win because git reports them as "R" in X or Y — check first
    // so a rename that also has modified content doesn't get demoted to M.
    if (xy[0] === "R" || xy[1] === "R") st = "R";
    else if (xy[0] === "A" || xy[1] === "A") st = "A";
    else if (xy[0] === "D" || xy[1] === "D") st = "D";
    else if (xy[0] === "M" || xy[1] === "M") st = "M";
    if (!st) continue;
    const file = filePart.includes(" -> ")
      ? filePart.split(" -> ")[1]
      : filePart;
    map.set(file.trim(), { status: st });
  }
  return map;
}

/** Parse `git diff --numstat HEAD` into per-file add/del counts. */
function parseNumstat(
  raw: string,
): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\t/);
    if (parts.length < 3) continue;
    const add = parseInt(parts[0], 10);
    const del = parseInt(parts[1], 10);
    const file = parts[2];
    // numstat reports "-\t-\tpath" for binary files — skip those rather
    // than render NaN counts.
    if (!file || Number.isNaN(add) || Number.isNaN(del)) continue;
    map.set(file, { additions: add, deletions: del });
  }
  return map;
}

/** Query git for status + numstat + branch in parallel. Every failure is
 *  swallowed — outside a git repo the maps are empty and isGit is false.
 *  Designed so a missing `git` binary doesn't break the whole Files
 *  experience; the client just loses the +/- badges. */
async function fetchGitMaps(projectRoot: string): Promise<{
  statusMap: Map<string, { status: "M" | "A" | "D" | "R" }>;
  numstatMap: Map<string, { additions: number; deletions: number }>;
  branch: string | null;
  isGit: boolean;
}> {
  const [statusResult, numstatResult, branchResult] = await Promise.allSettled(
    [
      execFileAsync("git", ["status", "--porcelain=v1"], { cwd: projectRoot }),
      execFileAsync("git", ["diff", "--numstat", "HEAD"], { cwd: projectRoot }),
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectRoot,
      }),
    ],
  );
  const isGit = statusResult.status === "fulfilled";
  const statusRaw =
    statusResult.status === "fulfilled" ? statusResult.value.stdout : "";
  const numstatRaw =
    numstatResult.status === "fulfilled" ? numstatResult.value.stdout : "";
  const branch =
    branchResult.status === "fulfilled"
      ? branchResult.value.stdout.trim() || null
      : null;
  return {
    statusMap: parseGitStatus(statusRaw),
    numstatMap: parseNumstat(numstatRaw),
    branch,
    isGit,
  };
}

export async function registerFilesRoutes(
  app: FastifyInstance,
  deps: FilesRoutesDeps,
): Promise<void> {
  const projects = new ProjectStore(deps.db);

  // GET /api/files/tree
  app.get(
    "/api/files/tree",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { project?: string; path?: string };
      if (!q.project) return reply.code(400).send({ error: "missing_project" });

      const project = projects.findById(q.project);
      if (!project)
        return reply.code(404).send({ error: "project_not_found" });

      const abs = resolveRelPath(project.path, q.path ?? "");
      if (abs === null)
        return reply.code(403).send({ error: "traversal_denied" });

      let stat: Stats;
      try {
        stat = await fsp.stat(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT")
          return reply.code(404).send({ error: "not_found" });
        if (code === "EACCES" || code === "EPERM")
          return reply.code(403).send({ error: "permission_denied" });
        throw err;
      }
      if (!stat.isDirectory())
        return reply.code(400).send({ error: "not_a_directory" });

      let names: string[];
      try {
        names = await fsp.readdir(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EACCES" || code === "EPERM")
          return reply.code(403).send({ error: "permission_denied" });
        throw err;
      }

      const { statusMap, numstatMap } = await fetchGitMaps(project.path);

      const entries: FilesTreeEntry[] = [];
      for (const name of names) {
        const childAbs = path.join(abs, name);
        let childStat: Stats | null = null;
        try {
          childStat = await fsp.lstat(childAbs);
        } catch {
          continue; // disappeared or unreadable — skip quietly
        }
        const isSymlink = childStat.isSymbolicLink();
        const isDir = !isSymlink && childStat.isDirectory();
        const isFile = isSymlink || childStat.isFile();
        if (!isDir && !isFile) continue; // socket, block device, etc.

        const childRel = path
          .relative(project.path, childAbs)
          .split(path.sep)
          .join("/");
        const gitEntry = statusMap.get(childRel) ?? null;
        const numEntry = numstatMap.get(childRel) ?? null;

        entries.push({
          name,
          relPath: childRel,
          isDir,
          isHidden: name.startsWith("."),
          size: isFile ? childStat.size : undefined,
          mtimeMs: childStat.mtimeMs,
          mode: formatMode(childStat.mode),
          gitStatus: gitEntry?.status ?? null,
          additions: numEntry?.additions ?? null,
          deletions: numEntry?.deletions ?? null,
        });
      }

      // Dirs first, then files; alphabetical within each group. Case-
      // insensitive compare so "README.md" sorts with "readme" rather than
      // floating above lowercase peers.
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
        });
      });

      const displayRel = path
        .relative(project.path, abs)
        .split(path.sep)
        .join("/");

      return {
        projectId: q.project,
        projectRoot: project.path,
        relPath: displayRel,
        entries,
      };
    },
  );

  // GET /api/files/read
  app.get(
    "/api/files/read",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { project?: string; path?: string };
      if (!q.project) return reply.code(400).send({ error: "missing_project" });
      if (!q.path) return reply.code(400).send({ error: "missing_path" });

      const project = projects.findById(q.project);
      if (!project)
        return reply.code(404).send({ error: "project_not_found" });

      const abs = resolveRelPath(project.path, q.path);
      if (abs === null)
        return reply.code(403).send({ error: "traversal_denied" });

      // Extension-based rejection first — fastest path, no I/O.
      const ext = path.extname(abs).toLowerCase().slice(1);
      if (BINARY_EXTENSIONS.has(ext))
        return reply.code(415).send({ error: "binary_file" });

      let stat: Stats;
      try {
        stat = await fsp.stat(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT")
          return reply.code(404).send({ error: "not_found" });
        if (code === "EACCES" || code === "EPERM")
          return reply.code(403).send({ error: "permission_denied" });
        throw err;
      }
      if (stat.isDirectory())
        return reply.code(400).send({ error: "is_a_directory" });

      // Read up to MAX_READ_BYTES + 1 so we can detect "file is larger than
      // the cap" from a single read.
      const fd = await fsp.open(abs, "r");
      let content: string;
      let truncated = false;
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES + 1);
        const { bytesRead } = await fd.read(buf, 0, MAX_READ_BYTES + 1, 0);
        truncated = bytesRead > MAX_READ_BYTES;
        const slice = buf.subarray(0, Math.min(bytesRead, MAX_READ_BYTES));

        // Null-byte sniff: catches binaries the extension check missed.
        // 512 is enough to catch common binary headers without pulling in
        // the whole file.
        const sniffLen = Math.min(512, slice.length);
        for (let i = 0; i < sniffLen; i++) {
          if (slice[i] === 0) {
            return reply.code(415).send({ error: "binary_file" });
          }
        }

        content = slice.toString("utf8");
      } finally {
        await fd.close();
      }

      const normalRel = path
        .relative(project.path, abs)
        .split(path.sep)
        .join("/");
      const { statusMap, numstatMap } = await fetchGitMaps(project.path);
      const gitEntry = statusMap.get(normalRel) ?? null;
      const numEntry = numstatMap.get(normalRel) ?? null;
      const lines = content.length === 0 ? 0 : content.split("\n").length;

      return {
        projectId: q.project,
        relPath: normalRel,
        content,
        lines,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: formatMode(stat.mode),
        truncated,
        gitStatus: gitEntry?.status ?? null,
        additions: numEntry?.additions ?? null,
        deletions: numEntry?.deletions ?? null,
      };
    },
  );

  // GET /api/files/status
  app.get(
    "/api/files/status",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { project?: string };
      if (!q.project) return reply.code(400).send({ error: "missing_project" });

      const project = projects.findById(q.project);
      if (!project)
        return reply.code(404).send({ error: "project_not_found" });

      const { statusMap, numstatMap, branch, isGit } = await fetchGitMaps(
        project.path,
      );

      const entries: FilesStatusEntry[] = [];
      let totalAdditions = 0;
      let totalDeletions = 0;
      for (const [relPath, gitEntry] of statusMap) {
        const numEntry = numstatMap.get(relPath) ?? null;
        if (numEntry) {
          totalAdditions += numEntry.additions;
          totalDeletions += numEntry.deletions;
        }
        entries.push({
          relPath,
          status: gitEntry.status,
          additions: numEntry?.additions ?? null,
          deletions: numEntry?.deletions ?? null,
        });
      }

      return {
        projectId: q.project,
        branch,
        totalAdditions,
        totalDeletions,
        changedCount: entries.length,
        entries,
        isGitRepo: isGit,
      };
    },
  );
}
