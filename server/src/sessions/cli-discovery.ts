import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { CliSessionSummary } from "@claudex/shared";

/**
 * Discovery of `claude` CLI sessions persisted on disk so claudex can adopt
 * them. The CLI writes one JSONL file per session at:
 *
 *   ~/.claude/projects/<cwd-slug>/<sessionUuid>.jsonl
 *
 * The <cwd-slug> is the absolute cwd with every separator replaced by '-'.
 * POSIX `/Users/hao/Code/foo` → `-Users-hao-Code-foo`. Windows
 * `D:\Code\foo` → `D--Code-foo` (both `:` and `\` collapse to `-`, producing
 * the `X--` drive-letter prefix we key off).
 *
 * IMPORTANT — slug ambiguity: the CLI's encoding is lossy. A directory named
 * literally `my-dir` renders the same as `my/dir`. We cannot round-trip
 * perfectly; `decodeSlug` produces the CLI's own interpretation, which is
 * what the `claude` binary itself does at runtime. Users with real `-` in
 * their paths will see the same quirk claudex-less CLI users see.
 */

/** Default root: the real `~/.claude/projects` directory. */
export function defaultCliProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Reverse a CLI cwd slug back into an absolute path. POSIX slug convention:
 * `/` ↔ `-`, with a leading `-` indicating the root `/`. Windows slug
 * convention: `X:\` ↔ `X--`, with every `\` thereafter also collapsed to
 * `-` (indistinguishable from real dashes — we leave the body verbatim so
 * the user can read their own path, e.g. `D--Code-foo-bar` →
 * `D:\Code-foo-bar`).
 *
 * Known ambiguity: real dashes in directory names round-trip incorrectly.
 * Documented — same behavior as the CLI. See module docstring. A POSIX path
 * that literally starts with `/X--…` would also hit the Windows branch
 * here; that's rare enough to accept.
 */
export function decodeSlug(slug: string): string {
  // Windows drive-letter prefix: `D--…` or `-D--…` (the CLI may or may not
  // emit a leading `-` before the drive letter). Restore `X:\` and keep the
  // rest of the body verbatim.
  const winMatch = slug.match(/^-?([A-Za-z])--(.*)$/);
  if (winMatch) return `${winMatch[1]}:\\${winMatch[2]}`;
  // POSIX: strip the leading `-` (which represents the root `/`) and swap.
  const body = slug.startsWith("-") ? slug.slice(1) : slug;
  return "/" + body.split("-").join("/");
}

/**
 * Encode an absolute cwd into the CLI's slug convention: every character
 * that isn't `[A-Za-z0-9]` becomes `-`, so:
 *   POSIX    `/Users/hao/Code/foo`  → `-Users-hao-Code-foo`
 *   Windows  `C:\Code\foo bar`      → `C--Code-foo-bar`
 * (`:` and the first `\` collapse into the `X--` drive prefix; spaces,
 * dots, Chinese, parens and real dashes all become `-` — that's why slugs
 * round-trip lossily and `resolveSlugToPath` needs hints / probing.)
 *
 * The previous implementation only handled POSIX (`split("/").join("-")`)
 * and returned Windows paths verbatim, so `knownPaths` matching never hit
 * on Windows and adopted-CLI sessions were registered under the lossy
 * decode (`C:\Users-80549-Desktop-LoongArch`) instead of the real
 * directory. Real CLI transcripts confirm the blanket character rule:
 * `c:\Users\80549\Desktop\新建文件夹 (3)` sits under slug
 * `c--Users-80549-Desktop--------3-`.
 */
export function encodeCwdToSlug(cwd: string): string {
  if (!cwd) return cwd;
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Resolve a slug to an absolute path with as much fidelity as possible.
 *
 * The slug encoding is lossy — a literal `-` in a directory name (`kollab-api`)
 * is indistinguishable from a path separator (`kollab/api`). This function
 * disambiguates by:
 *   1. Matching the slug against `knownPaths` (e.g. claudex's projects table).
 *      The first known path that re-encodes to this slug wins — exact match.
 *   2. Filesystem probe: enumerate candidate decodings (treating each `-` as
 *      either a separator or a literal dash), order them by "fewest literal
 *      dashes first" so the most-common interpretation is tried first, and
 *      return the first candidate that exists on disk.
 *   3. Lossy fallback: if neither hint nor probe finds a real path, return the
 *      naive `-` → `/` decoding (current `decodeSlug` behavior).
 *
 * The Windows branch is unambiguous (drive-letter prefix `X--` is structural)
 * so we keep the existing behavior there.
 */
export function resolveSlugToPath(
  slug: string,
  opts?: { knownPaths?: readonly string[] },
): string {
  // 1. Known-path hint: first known path whose re-encode matches the slug
  //    wins — exact, no fs probing. Works on every platform now that
  //    encodeCwdToSlug applies the CLI's blanket character rule.
  if (opts?.knownPaths) {
    for (const p of opts.knownPaths) {
      if (encodeCwdToSlug(p) === slug) return p;
    }
  }

  const winMatch = slug.match(/^-?([A-Za-z])--(.*)$/);
  if (winMatch) {
    const drive = `${winMatch[1]}:\\`;
    // 2. Windows fs probe: try treating each `-` as either a separator or a
    //    literal dash, fewest literal dashes first. Only meaningful for
    //    pure-ASCII slugs — a body with empty segments (`Desktop--------3-`
    //    from 中文/spaces) can't be re-derived character-by-character, so
    //    probeByMask bails and we fall back to the lossy decode.
    return probeByMask(drive, winMatch[2]) ?? `${drive}${winMatch[2]}`;
  }

  const body = slug.startsWith("-") ? slug.slice(1) : slug;
  if (body === "") return "/";
  // 2. POSIX fs probe (same rationale), then the naive all-separators
  //    decode — the CLI's own interpretation when nothing exists on disk.
  return probeByMask("/", body) ?? "/" + body.split("-").join("/");
}

/**
 * Enumerate candidate decodings of a slug body (treating each `-` as either
 * a path separator or a literal dash) under a root prefix, ordered by
 * "fewest literal dashes first" so the most-common interpretation is tried
 * first. Returns the first candidate that exists on disk, or null.
 *
 * Bodies containing empty segments (two or more adjacent `-`, which on
 * Windows means the original had consecutive non-ASCII chars — 中文, spaces,
 * parens) are skipped: each empty segment is an unrecoverable character, so
 * probing would only ever miss and the caller's lossy fallback is the
 * honest answer. A hard N≤16 cap keeps the worst case bounded at 65536
 * candidates; paths deeper than that fall back to naive.
 */
function probeByMask(prefix: string, body: string): string | null {
  const parts = body.split("-");
  if (parts.length <= 1) return null;
  if (parts.some((s) => s.length === 0)) return null;
  const N = parts.length - 1;
  if (N > 16) return null;

  const masks: number[] = [];
  for (let m = 0; m < 1 << N; m++) masks.push(m);
  masks.sort((a, b) => popcount(a) - popcount(b));

  for (const mask of masks) {
    const segments: string[] = [parts[0]];
    for (let i = 0; i < N; i++) {
      if (mask & (1 << i)) {
        segments[segments.length - 1] += "-" + parts[i + 1];
      } else {
        segments.push(parts[i + 1]);
      }
    }
    // path.sep keeps the probe result in native form — on Windows a
    // mixed `C:\Users/80549/...` string would pass existsSync but come back
    // with forward slashes, diverging from what callers persist as cwd.
    const candidate = prefix + segments.join(path.sep);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore — treat as not-existing
    }
  }
  return null;
}

function popcount(n: number): number {
  let c = 0;
  let x = n;
  while (x) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}

/**
 * Enumerate every CLI session jsonl under `root` and return summaries. The
 * directory is usually small (dozens of cwds, tens of sessions each) so
 * doing this synchronously-ish is fine; we still stream-read each file to
 * extract only the head lines rather than slurping multi-MB transcripts.
 */
export async function listCliSessions(
  root: string = defaultCliProjectsRoot(),
  opts?: { knownPaths?: readonly string[] },
): Promise<CliSessionSummary[]> {
  let slugs: string[];
  try {
    slugs = await fsp.readdir(root);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const out: CliSessionSummary[] = [];
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Known registered paths are the only way to re-derive real Windows
    // dirs with non-ASCII components (the slug loses those characters); pass
    // them through so list results (and anything imported from them) land on
    // the real project path rather than the lossy decode.
    const cwd = resolveSlugToPath(slug, {
      knownPaths: opts?.knownPaths,
    });
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      const sessionId = name.slice(0, -".jsonl".length);
      let summary: CliSessionSummary | null = null;
      try {
        summary = await summarizeJsonl(full, sessionId, cwd);
      } catch {
        // Corrupt / unreadable file — skip, never blow up the whole list.
        continue;
      }
      if (summary) out.push(summary);
    }
  }

  // Newest first — matches how the rest of the app lists sessions.
  out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return out;
}

/**
 * Scan the first ~20 lines of a JSONL file to pull the first user message.
 * We stop as soon as we have a title to avoid walking multi-MB transcripts.
 */
async function summarizeJsonl(
  filePath: string,
  sessionId: string,
  cwd: string,
): Promise<CliSessionSummary | null> {
  const stat = await fsp.stat(filePath);
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let firstUserMessage: string | null = null;
  let lineCount = 0;
  const maxScan = 40; // head-only; we don't need the full line count for sort
  try {
    for await (const line of rl) {
      lineCount++;
      if (firstUserMessage === null && lineCount <= maxScan) {
        const text = extractUserText(line);
        if (text !== null && text.length > 0) {
          firstUserMessage = text;
        }
      }
      if (firstUserMessage !== null && lineCount >= maxScan) {
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const title =
    firstUserMessage !== null && firstUserMessage.length > 0
      ? truncateTitle(firstUserMessage, 60)
      : "Untitled CLI session";

  return {
    sessionId,
    cwd,
    title,
    firstUserMessage,
    lineCount,
    fileSize: stat.size,
    lastModified: stat.mtime.toISOString(),
    filePath,
  };
}

/**
 * Pull the user-visible text out of one JSONL record, or return null if this
 * record isn't a user message we can render. Records look like:
 *   {"type":"user","message":{"role":"user","content":"hello"}, ...}
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
 * Non-user records ("assistant", "queue-operation", "attachment", ...) are
 * filtered out.
 */
function extractUserText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== "user") return null;
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || message.role !== "user") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        return (block as Record<string, unknown>).text as string;
      }
    }
  }
  return null;
}

/**
 * Collapse whitespace and truncate on a word boundary under `max` chars,
 * appending an ellipsis when we drop anything. Titles in the UI are one
 * line; newlines look bad so we fold them too.
 */
export function truncateTitle(raw: string, max: number): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const slice = flat.slice(0, max);
  // Prefer a word boundary if one exists in the last ~20% of the slice.
  const lastSpace = slice.lastIndexOf(" ");
  const cutoff =
    lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cutoff.replace(/[\s.,;:!?-]+$/, "") + "…";
}
