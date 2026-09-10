import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Session, SessionStatus } from "@claudex/shared";
import type { SessionStore } from "../sessions/store.js";
import type { ProjectStore } from "../sessions/projects.js";
import type { SessionManager } from "../sessions/manager.js";
import {
  defaultCliProjectsRoot,
  readCliSessionTitle,
  resolveSlugToPath,
} from "../sessions/cli-discovery.js";
import { importCliSession } from "../sessions/cli-import.js";
import { resyncCliSession } from "../sessions/cli-resync.js";

/**
 * CLI live sync — watches `~/.claude/projects/<slug>/<uuid>.jsonl` for changes
 * from the user's `claude` CLI and keeps claudex's DB state in sync in near
 * real time. Complements the on-demand Import sheet + the GET /api/sessions
 * resync-on-open path: this fires as soon as the CLI writes, whether or not
 * the user has claudex open on that session.
 *
 * Design notes:
 *   - We only react to `add` / `change`. `unlink` is deliberately ignored —
 *     a user deleting a CLI JSONL should not silently wipe claudex state.
 *   - Status is a heuristic from the file's mtime + last line (see
 *     `deriveCliStatus`). File-watch can't observe "is the CLI actually
 *     running right now", only "has the file grown recently". Paused-but-
 *     background sessions may briefly flip to idle then back.
 *   - Resync is deduped per sessionId so a flurry of writes triggers at most
 *     one in-flight import. The next change event after completion will
 *     pick up anything missed.
 *   - Creating a chokidar watcher is behind a factory so tests can point it
 *     at a tmp `cliProjectsRoot` without touching the real `~/.claude`.
 */

const SDK_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Heuristic windows for `deriveCliStatus`. Keep these conservative — false
// "running" is the worst outcome (composer looks locked, user can't tell
// why), while false "idle" just means the status dot lags a few seconds
// behind. We err on idle.
const RUNNING_MTIME_WINDOW_MS = 20_000; // file must be actively growing
const ACTIVE_ASSISTANT_WINDOW_MS = 30_000; // last assistant line must be recent
const TAIL_BYTES = 8 * 1024;
// How many tail records we parse back for status derivation. Five is enough
// to cover a typical turn's trailing pattern: user → tool_use → tool_result
// → assistant (final) without us having to walk the whole file.
const TAIL_LINES = 5;

export interface CliSyncWatcherDeps {
  sessions: SessionStore;
  projects: ProjectStore;
  manager: SessionManager;
  /** Override `~/.claude/projects` — tests always pass a tmp root. */
  cliProjectsRoot?: string;
  logger?: {
    debug?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export interface CliSyncWatcher {
  /** Await the initial directory scan + initial status backfill. */
  ready(): Promise<void>;
  /** Stop watching and release FS handles. Safe to call multiple times. */
  close(): Promise<void>;
  /**
   * Test hook — process a single `change` event synchronously against the
   * current state. Production callers should let chokidar drive it.
   */
  __handleForTest(
    kind: "add" | "change",
    absPath: string,
  ): Promise<void>;
}

export function startCliSyncWatcher(
  deps: CliSyncWatcherDeps,
): CliSyncWatcher {
  const root = deps.cliProjectsRoot ?? defaultCliProjectsRoot();
  const log = deps.logger;

  // Dedup guard — one in-flight operation per sessionId.
  const inflight = new Set<string>();

  // Initial status backfill: runs once after boot against every CLI-imported
  // session already in the DB. Cheap: stat + tail-read per row.
  const backfillPromise = backfillStatuses(deps, root).catch((err) => {
    log?.warn?.({ err }, "cli-sync: initial status backfill failed");
  });

  // Make the directory exist so chokidar doesn't swallow a fresh install
  // where the user hasn't ever run `claude` yet. No-op if it already exists.
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    log?.warn?.({ err, root }, "cli-sync: could not ensure projects root");
  }

  const watcher: FSWatcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  const handle = async (
    kind: "add" | "change",
    absPath: string,
  ): Promise<void> => {
    if (!absPath.endsWith(".jsonl")) return;
    const base = path.basename(absPath, ".jsonl");
    if (!SDK_ID_RE.test(base)) return;
    const sdkSessionId = base;

    // We might get `add` events during the initial scan even with
    // ignoreInitial — chokidar treats newly-discovered files after ready as
    // add regardless. Either way, adopt-if-new is the same path.
    if (inflight.has(sdkSessionId)) return;
    inflight.add(sdkSessionId);
    try {
      const existing = deps.sessions.findBySdkSessionId(sdkSessionId);
      if (existing) {
        await onExistingChange(deps, existing, absPath);
      } else {
        await onNewJsonl(deps, absPath, sdkSessionId, root);
      }
    } catch (err) {
      log?.warn?.(
        { err, sdkSessionId, kind, absPath },
        "cli-sync: handler failed",
      );
    } finally {
      inflight.delete(sdkSessionId);
    }
  };

  watcher.on("add", (p: string) => {
    void handle("add", p);
  });
  watcher.on("change", (p: string) => {
    void handle("change", p);
  });
  watcher.on("error", (err: unknown) => {
    log?.warn?.({ err }, "cli-sync: watcher error");
  });

  const readyPromise = new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve());
  });

  return {
    ready: async () => {
      await readyPromise;
      await backfillPromise;
    },
    close: async () => {
      await watcher.close();
    },
    __handleForTest: handle,
  };
}

/**
 * A JSONL appeared for a session we haven't adopted yet. Import it through
 * the normal `importCliSession` path so the row is stamped with the same
 * cli_jsonl_seq + events the Import sheet would produce. The project's cwd
 * comes from the slug directory the file lives in.
 */
async function onNewJsonl(
  deps: CliSyncWatcherDeps,
  absPath: string,
  sdkSessionId: string,
  root: string,
): Promise<void> {
  const slug = path.basename(path.dirname(absPath));
  const parent = path.dirname(path.dirname(absPath));
  // Guard against files at unexpected depths — a JSONL dropped directly into
  // the root, or buried deeper than `<root>/<slug>/<file>`, isn't something
  // we can safely adopt.
  if (parent !== root) {
    deps.logger?.debug?.(
      { absPath, root },
      "cli-sync: ignoring JSONL outside <root>/<slug>/ layout",
    );
    return;
  }
  const cwd = resolveSlugToPath(slug, {
    knownPaths: deps.projects.list().map((p) => p.path),
  });
  const title = await firstUserMessageTitle(absPath);

  const result = await importCliSession(
    {
      sessions: deps.sessions,
      projects: deps.projects,
      logger: deps.logger,
    },
    {
      sessionId: sdkSessionId,
      cwd,
      title,
      filePath: absPath,
    },
  );
  if (result.wasNew) {
    deps.logger?.info?.(
      {
        sessionId: result.session.id,
        sdkSessionId,
        cwd,
        eventsImported: result.eventsImported,
      },
      "cli-sync: adopted new CLI session",
    );
    // Broadcast a status so Home's list wakes up. New imports default to
    // idle; the status heuristic below will upgrade if the file is fresh.
    const derived = await deriveCliStatus(result.session, absPath);
    if (derived !== result.session.status) {
      logAndSetStatus(
        deps,
        result.session.id,
        result.session.status,
        derived,
        "cli_sync_new_jsonl",
      );
    }
    // Tell subscribed tabs to refetch the transcript (initial events have
    // been seeded) and Home to refresh status.
    deps.manager.notifyTranscriptRefresh(result.session.id);
    notifyStatus(deps, result.session.id, derived);
  } else {
    // Race: someone else adopted this session between our lookup and the
    // import call. Treat as a change event and resync.
    await onExistingChange(deps, result.session, absPath);
  }
}

/**
 * An existing adopted session's JSONL changed. Resync from the last
 * cli_jsonl_seq and refresh status.
 *
 * Skip the event-resync branch when claudex itself has a live AgentRunner
 * attached to this session — in that case the SDK is writing to the JSONL
 * as a *consequence* of turns we already persisted via
 * `SessionManager.handleEvent` (user_message, assistant_text, tool_use,
 * tool_result, turn_end, etc). Re-importing from the JSONL would double
 * every event in the transcript. See issue writeup in commit message.
 *
 * Status backfill still runs unconditionally — mtime/tail heuristics are
 * cheap and non-mutating to the event log, and the claudex-driven case
 * already transitions status through the runner event bus anyway.
 */
async function onExistingChange(
  deps: CliSyncWatcherDeps,
  session: Session,
  absPath: string,
): Promise<void> {
  // Native claudex sessions (adopted_from_cli=0) write the same `<sdk>.jsonl`
  // via the SDK as a side-effect of turns claudex already owns. Touching it
  // here — even just bumping cli_jsonl_seq — is what got native sessions
  // caught in migration 25's `cli_jsonl_seq > 0` sweep and lost their
  // user_message.attachments. Leave native rows completely alone; the
  // runner / manager is authoritative for both transcript and status.
  if (session.adoptedFromCli !== true) return;

  if (deps.manager.hasRunner(session.id)) {
    // Claudex is the one driving — any growth in the JSONL is the SDK
    // echoing back events we've already appended through AgentRunner.
    // Still bump cli_jsonl_seq so that after the runner disposes, the
    // next CLI-driven edit resumes from the correct offset rather than
    // reimporting everything the SDK wrote during our own run.
    try {
      const lineCount = await countNonEmptyLines(absPath);
      const persisted = deps.sessions.getCliJsonlSeq(session.id);
      if (lineCount > persisted) {
        deps.sessions.setCliJsonlSeq(session.id, lineCount);
      }
    } catch (err) {
      deps.logger?.debug?.(
        { err, sessionId: session.id },
        "cli-sync: seq bump during active runner failed",
      );
    }
  } else {
    // Resync — appends any new events and broadcasts refresh_transcript on
    // success via its manager hook.
    try {
      await resyncCliSession(
        {
          sessions: deps.sessions,
          manager: deps.manager,
          cliProjectsRoot: deps.cliProjectsRoot,
          logger: deps.logger,
        },
        session,
      );
    } catch (err) {
      deps.logger?.warn?.(
        { err, sessionId: session.id },
        "cli-sync: resync failed",
      );
    }
  }

  // Always refresh derived status — the JSONL grew, which is new signal
  // regardless of whether any mapped events got appended.
  //
  // Exception: when an AgentRunner is attached, the runner is authoritative
  // for status. The JSONL-derived heuristic can only return `running` /
  // `idle` (never `awaiting`), so running it here would overwrite the
  // awaiting state we just set when e.g. AskUserQuestion / ExitPlanMode /
  // a permission_request came in. We also lose the briefly-stale "idle"
  // flicker that the watcher would emit between turns when the SDK writes
  // a user record before the next assistant chunk. Runner-driven sessions
  // broadcast every status transition through the manager's event bus
  // already, so the watcher adds no signal here.
  if (deps.manager.hasRunner(session.id)) return;

  const fresh = deps.sessions.findById(session.id) ?? session;
  // `cli_running` is owned by the process scanner — the JSONL-heuristic has
  // no visibility into whether the external CLI is still alive, so leave
  // the row alone and let the scanner demote it back to idle when the
  // process dies. Without this guard, a stale mtime on the JSONL would
  // flip the row back to idle here before the next scanner tick could
  // re-promote it, producing a flapping dot on the UI.
  if (fresh.status === "cli_running") return;
  const next = await deriveCliStatus(fresh, absPath);
  if (next !== fresh.status) {
    logAndSetStatus(deps, session.id, fresh.status, next, "cli_sync_change");
    notifyStatus(deps, session.id, next);
  }
}

/**
 * Run the initial status-derivation pass over every CLI-imported session.
 * Cheap — one stat + short tail read per row. Doesn't touch events.
 */
async function backfillStatuses(
  deps: CliSyncWatcherDeps,
  root: string,
): Promise<void> {
  const all = deps.sessions.list({ includeArchived: false, includeSideChats: true });
  for (const s of all) {
    if (!s.sdkSessionId) continue;
    // Skip native claudex sessions outright — same rationale as
    // `onExistingChange`: their JSONL is a downstream artifact, not a
    // source of truth, so the mtime-based heuristic can't say anything
    // useful about them and could clobber states set by the runner.
    if (s.adoptedFromCli !== true) continue;
    // Runner-driven sessions: skip status backfill for the same reason
    // `onExistingChange` skips — the AgentRunner is the source of truth and
    // the JSONL heuristic can't produce `awaiting`, so it would clobber.
    if (deps.manager.hasRunner(s.id)) continue;
    // `cli_running` is owned by the CLI process scanner (see
    // cli-sync/process-scanner.ts). The JSONL heuristic below only produces
    // `idle` / `running` and would clobber it on boot; leave it alone so
    // the scanner's next tick is authoritative.
    if (s.status === "cli_running") continue;
    const absPath = await locateJsonl(root, s.sdkSessionId);
    if (!absPath) continue;
    try {
      const next = await deriveCliStatus(s, absPath);
      if (next !== s.status) {
        logAndSetStatus(deps, s.id, s.status, next, "cli_sync_backfill");
        notifyStatus(deps, s.id, next);
      }
    } catch (err) {
      deps.logger?.debug?.(
        { err, sessionId: s.id },
        "cli-sync: status backfill skipped row",
      );
    }
  }
}

/**
 * Derive a session's status from its JSONL file alone. We have three inputs:
 *
 *   1. file mtime (how fresh is the last write?)
 *   2. the last few JSONL records (what kind of record is it?)
 *   3. whether the most recent `assistant` record carries `stop_reason`
 *      (the authoritative "turn is done" signal the CLI emits)
 *
 * Decision table (first match wins):
 *
 *   a. Most recent `assistant` record has `stop_reason` set
 *      → `idle` regardless of mtime. The turn is finished; any subsequent
 *      file growth is the user typing the next prompt (which we classify
 *      below).
 *
 *   b. Last non-empty line is `type:"user"` with no `assistant` record
 *      after it → CLI is waiting for the user to send the reply. We don't
 *      have a dedicated "awaiting_user" status today, so map to `idle` —
 *      this is the most common "looks idle, I can type" case and matches
 *      what the user expects.
 *
 *   c. mtime < 20s AND there's a recent (< 30s old) `assistant` record
 *      without `stop_reason` → `running`. We require BOTH an active write
 *      window and an in-flight assistant turn so that a user typing into a
 *      just-opened session (where the tail is a `user` record and no
 *      assistant has started yet) doesn't get misclassified as running.
 *
 *   d. Anything else → `idle`. Covers stale files (> 60s), mid-turn pauses
 *      longer than the active window (we'd rather show idle and flip back
 *      on next write than show fake-running), and anomalies.
 *
 * Honest limits: we can't observe "is the CLI process alive" from a JSONL
 * alone — only "has the file grown recently". A turn that legitimately runs
 * a 60+ second tool call will briefly show idle before the next assistant
 * chunk flips it back. This is a deliberate trade-off: false idle flickers
 * are visually annoying, false running leaves the user convinced the
 * session is broken.
 */
export async function deriveCliStatus(
  session: Session,
  absPath: string,
  now: number = Date.now(),
): Promise<SessionStatus> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return session.status;
  }
  const mtimeAge = now - stat.mtimeMs;
  const tail = await tailLastJsonlLines(absPath, TAIL_LINES).catch(
    () => [] as Array<Record<string, unknown>>,
  );

  // (a) / (b): walk the tail from newest → oldest and find the most-recent
  // assistant + whether a later user line exists after it.
  let lastAssistant: Record<string, unknown> | null = null;
  let lastAssistantIdxFromEnd = -1;
  let lastNonEmpty: Record<string, unknown> | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const rec = tail[i];
    if (!lastNonEmpty) lastNonEmpty = rec;
    if (rec && (rec as Record<string, unknown>).type === "assistant") {
      lastAssistant = rec;
      lastAssistantIdxFromEnd = tail.length - 1 - i;
      break;
    }
  }

  // (a) Finished turn.
  if (lastAssistant && assistantHasStopReason(lastAssistant)) return "idle";

  // (b) Last line is a user prompt sitting after the most recent assistant —
  // CLI is waiting for the user (or we're looking at a brand-new session
  // that hasn't gotten its first assistant reply yet). Show idle.
  if (
    lastNonEmpty &&
    (lastNonEmpty as Record<string, unknown>).type === "user" &&
    lastAssistantIdxFromEnd !== 0
  ) {
    return "idle";
  }

  // (c) In-flight turn. Require fresh mtime AND a recent assistant record
  // without stop_reason, so we don't call "running" on files whose tail is
  // all tool_use / tool_result with no assistant-in-progress.
  if (lastAssistant && mtimeAge < RUNNING_MTIME_WINDOW_MS) {
    const assistantAge = assistantRecordAge(lastAssistant, stat.mtimeMs, now);
    if (assistantAge < ACTIVE_ASSISTANT_WINDOW_MS) return "running";
  }

  // (d) Default.
  return "idle";
}

/**
 * True when `type:"assistant"` record carries `message.stop_reason` — the
 * CLI's signal that the turn has wrapped. SDK variants also emit a top-level
 * `type:"result"` record we treat as terminal.
 */
function assistantHasStopReason(rec: Record<string, unknown>): boolean {
  if (rec.type === "result") return true;
  if (rec.type !== "assistant") return false;
  const message = rec.message as Record<string, unknown> | undefined;
  if (!message) return false;
  return message.stop_reason !== undefined && message.stop_reason !== null;
}

/**
 * Best-effort age of an assistant record in milliseconds. The CLI stamps
 * `timestamp` as an ISO string on each record — when present we use that
 * directly. Otherwise we fall back to the file's mtime (the record is the
 * last one we saw, so it can't be older than the file's last write).
 */
function assistantRecordAge(
  rec: Record<string, unknown>,
  mtimeMs: number,
  now: number,
): number {
  const ts = rec.timestamp;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return Math.max(0, now - parsed);
  }
  return Math.max(0, now - mtimeMs);
}

/**
 * Count non-empty lines in a JSONL file by streaming via readline — same
 * accounting `cli_jsonl_seq` uses elsewhere. Kept local to the watcher so
 * claudex-drives-the-session branch can bump the seq without pulling in
 * `cli-resync`'s larger surface.
 */
async function countNonEmptyLines(absPath: string): Promise<number> {
  const readline = await import("node:readline");
  const stream = fs.createReadStream(absPath, { encoding: "utf-8" });
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

/**
 * Read the last ~8 KB of a file and return up to `maxLines` parsed JSON
 * records (oldest → newest). Malformed / truncated lines at the head of the
 * window (possibly clipped mid-line) are dropped silently. Returns an empty
 * array on missing / empty input.
 *
 * We keep the window small because status derivation only needs the trailing
 * handful of records, and a bounded tail read is O(1) regardless of file size
 * — the CLI's JSONLs grow indefinitely over long conversations.
 */
async function tailLastJsonlLines(
  absPath: string,
  maxLines: number,
): Promise<Array<Record<string, unknown>>> {
  let fd: fsp.FileHandle | null = null;
  try {
    fd = await fsp.open(absPath, "r");
    const stat = await fd.stat();
    const size = stat.size;
    if (size === 0) return [];
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, size - len);
    const text = buf.toString("utf-8");
    const lines = text.split("\n");
    const parsed: Array<Record<string, unknown>> = [];
    // Walk from the end collecting parseable lines until we hit `maxLines`.
    for (let i = lines.length - 1; i >= 0 && parsed.length < maxLines; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        parsed.unshift(obj);
      } catch {
        // Likely a truncated head line (we started mid-record). Skip.
        continue;
      }
    }
    return parsed;
  } finally {
    if (fd) await fd.close();
  }
}

/**
 * Title for a freshly-observed JSONL. Delegates to the shared resolver in
 * cli-discovery so the watcher and the Import sheet name the same session
 * identically (CLI `ai-title` / `custom-title` records first, first user
 * message as the fallback).
 */
async function firstUserMessageTitle(absPath: string): Promise<string> {
  return readCliSessionTitle(absPath);
}

async function locateJsonl(
  root: string,
  sdkSessionId: string,
): Promise<string | null> {
  try {
    const slugs = await fsp.readdir(root);
    for (const slug of slugs) {
      const candidate = path.join(root, slug, `${sdkSessionId}.jsonl`);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // not this dir, keep looking
      }
    }
  } catch {
    return null;
  }
  return null;
}

function notifyStatus(
  deps: CliSyncWatcherDeps,
  sessionId: string,
  status: SessionStatus,
): void {
  // Map the DB status back onto the "status" RunnerEvent vocabulary. The
  // WS bridge translates this into a `session_update` frame on the wire.
  let rtStatus: "running" | "idle" | "terminated" | "starting";
  if (status === "running") rtStatus = "running";
  else if (status === "idle") rtStatus = "idle";
  else rtStatus = "idle"; // awaiting/error/archived ride the row itself; we don't synthesize those here
  deps.manager.broadcastStatus(sessionId, rtStatus);
}

/**
 * Persist + log a status transition driven by the CLI-sync watcher. Mirrors
 * the `session status transition` log line the `SessionManager` emits for
 * runner-driven transitions so a grep across `{ sessionId, from, to, reason }`
 * surfaces every state change regardless of who triggered it.
 */
function logAndSetStatus(
  deps: CliSyncWatcherDeps,
  sessionId: string,
  from: SessionStatus,
  to: SessionStatus,
  reason: string,
): void {
  deps.logger?.info?.(
    { sessionId, from, to, reason },
    "session status transition",
  );
  deps.sessions.setStatus(sessionId, to);
}
