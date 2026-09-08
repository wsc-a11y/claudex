import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import type { Session } from "@claudex/shared";
import type { SessionStore } from "./store.js";
import type { SessionManager } from "./manager.js";
import { defaultCliProjectsRoot } from "./cli-discovery.js";
import { importCliSessionEvents } from "./cli-events-import.js";

export interface CliResyncDeps {
  sessions: SessionStore;
  manager?: SessionManager;
  /** Override `~/.claude/projects` — tests always pass a tmp root. */
  cliProjectsRoot?: string;
  logger?: {
    debug?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export interface CliResyncResult {
  /** Number of session_events appended this run (0 when nothing to do). */
  added: number;
  /** New `cli_jsonl_seq` persisted on the session row. */
  newJsonlSeq: number;
}

/**
 * CLI-JSONL incremental resync — keeps a claudex-adopted session in sync with
 * ongoing `claude` CLI activity against the same `<uuid>.jsonl` transcript.
 *
 * Contract:
 *   - No-op unless `session.sdkSessionId` is set AND we can find the matching
 *     JSONL under `<root>/<cwd-slug>/<uuid>.jsonl`.
 *   - Counts JSONL lines (streaming, no full-file read).
 *   - If the line count has grown past the session's `cli_jsonl_seq`, streams
 *     through the JSONL *skipping* the first `cli_jsonl_seq` lines and appends
 *     mapped events for the remainder. Updates `cli_jsonl_seq` to the new
 *     line count on success.
 *   - If `cli_jsonl_seq` is 0 (legacy row from before the column existed) we
 *     fall back to comparing persisted-event count against JSONL line count:
 *     when they match we no-op, otherwise we skip the lines that correspond
 *     to the events we already have. This means legacy rows may occasionally
 *     under-import (if the CLI wrote lines that mapped to zero events) — the
 *     next CLI turn will catch us up.
 */
export async function resyncCliSession(
  deps: CliResyncDeps,
  session: Session,
): Promise<CliResyncResult> {
  const sdkId = session.sdkSessionId;
  if (!sdkId) return { added: 0, newJsonlSeq: 0 };
  // Native claudex sessions share the same `<sdk-id>.jsonl` file on disk
  // (because the SDK writes the CLI's transcript format), but that file is
  // a *consequence* of events claudex already has, not a source of truth
  // we should re-import. Re-importing here is what caused user_message
  // attachments to vanish after migration 25 — the JSONL only carries the
  // rendered `@<path>` prompt, not the original attachment metadata.
  // `adoptedFromCli` is the sole gate; cli-import.ts flips it on when a
  // real adoption happens.
  if (session.adoptedFromCli !== true) {
    return { added: 0, newJsonlSeq: session.cliJsonlSeq ?? 0 };
  }

  const root = deps.cliProjectsRoot ?? defaultCliProjectsRoot();
  // The CLI's slug is `cwd.replaceAll("/", "-")`. We know the cwd via the
  // session's project, but that isn't on the Session DTO directly; the
  // caller can resolve it and pass the JSONL path, but to keep the deps
  // simple we scan the likely directory for `<sdkId>.jsonl`.
  const filePath = await locateJsonl(root, sdkId);
  if (!filePath) return { added: 0, newJsonlSeq: session.cliJsonlSeq ?? 0 };

  const lineCount = await countLines(filePath);
  const persistedSeq = deps.sessions.getCliJsonlSeq(session.id);

  // Fast-path: we already imported every line. Idempotent no-op.
  if (persistedSeq > 0 && persistedSeq >= lineCount) {
    return { added: 0, newJsonlSeq: persistedSeq };
  }

  // Legacy row: cli_jsonl_seq is 0 but we have adopted this session before
  // (it has events). Use event count as a proxy for lines-already-processed.
  // This isn't exact — not every JSONL line maps to exactly one event — so
  // we play it safe by NOT reimporting lines we've likely already seen.
  let skip = persistedSeq;
  if (persistedSeq === 0) {
    const priorEvents = deps.sessions.countEvents(session.id);
    if (priorEvents > 0) {
      // If the JSONL is shorter than or equal to the line-count we'd expect
      // for the events we have, don't import anything — the counts already
      // line up.
      if (lineCount <= priorEvents) {
        deps.sessions.setCliJsonlSeq(session.id, lineCount);
        return { added: 0, newJsonlSeq: lineCount };
      }
      // Skip the first `priorEvents` lines as a best-effort heuristic. This
      // mirrors what the fresh-import path would have done had it stamped
      // `cli_jsonl_seq` at import time.
      skip = priorEvents;
    }
  }

  const added = await appendFromLine(deps, session.id, filePath, skip);
  deps.sessions.setCliJsonlSeq(session.id, lineCount);

  if (added > 0 && deps.manager) {
    try {
      deps.manager.notifyTranscriptRefresh(session.id);
    } catch (err) {
      deps.logger?.warn?.(
        { err, sessionId: session.id },
        "cli resync: broadcast failed",
      );
    }
  }

  return { added, newJsonlSeq: lineCount };
}

/**
 * Fire-and-forget wrapper used by `GET /api/sessions/:id`. Dedupes parallel
 * triggers for the same session so a user opening two tabs doesn't kick off
 * two concurrent resyncs (better-sqlite3 is synchronous and that'd still be
 * safe, but we'd do twice the JSONL I/O for nothing).
 */
const inflight = new Map<string, Promise<CliResyncResult>>();

export function triggerCliResync(args: {
  sessions: SessionStore;
  sessionRow: Session;
  manager?: SessionManager;
  cliProjectsRoot?: string;
  logger?: {
    debug?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}): void {
  const id = args.sessionRow.id;
  // Fast-path: skip native sessions entirely rather than spin up a promise
  // just to bail inside `resyncCliSession`. Keeps the `inflight` map clean
  // and the logs quiet — every `GET /api/sessions/:id` used to fire this.
  if (args.sessionRow.adoptedFromCli !== true) return;
  if (inflight.has(id)) return;
  const p = resyncCliSession(
    {
      sessions: args.sessions,
      manager: args.manager,
      cliProjectsRoot: args.cliProjectsRoot,
      logger: args.logger,
    },
    args.sessionRow,
  )
    .catch((err) => {
      args.logger?.warn?.(
        { err, sessionId: id },
        "cli resync failed",
      );
      return { added: 0, newJsonlSeq: 0 };
    })
    .finally(() => {
      inflight.delete(id);
    });
  inflight.set(id, p);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function locateJsonl(
  root: string,
  sdkSessionId: string,
): Promise<string | null> {
  // The cwd-slug is unknown at this layer, so scan `<root>/*/(<id>.jsonl)`.
  // Directory is usually small (dozens of cwds) so this is cheap.
  try {
    const entries = await fs.promises.readdir(root);
    for (const slug of entries) {
      const candidate = path.join(root, slug, `${sdkSessionId}.jsonl`);
      try {
        const stat = await fs.promises.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        /* not this dir, keep looking */
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function countLines(filePath: string): Promise<number> {
  // readline is the cheapest way to count \n-separated records without
  // slurping the file into memory. We only care about non-empty lines since
  // that's what the importer ignores too.
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (line.trim().length > 0) n += 1;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return n;
}

async function appendFromLine(
  deps: CliResyncDeps,
  sessionId: string,
  filePath: string,
  skip: number,
): Promise<number> {
  // Strategy: truncate the JSONL in memory by skipping the first `skip`
  // non-empty lines, write the rest to a temp file, then hand off to
  // importCliSessionEvents. This reuses the existing mapping logic exactly.
  // The CLI JSONLs are tens of KB typical, a few MB at worst — the overhead
  // is fine and the code stays in one place.
  const os = await import("node:os");
  const tmpPath = path.join(
    os.tmpdir(),
    `claudex-resync-${sessionId}-${Date.now()}.jsonl`,
  );

  const input = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const out = fs.createWriteStream(tmpPath, { encoding: "utf-8" });
  let seen = 0;
  try {
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      seen += 1;
      if (seen <= skip) continue;
      out.write(line + "\n");
    }
  } finally {
    rl.close();
    input.destroy();
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  try {
    return await importCliSessionEvents(
      { sessionEvents: deps.sessions, logger: deps.logger },
      { sessionId, filePath: tmpPath },
    );
  } finally {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      /* best effort */
    }
  }
}
