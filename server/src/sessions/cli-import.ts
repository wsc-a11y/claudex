import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import type { Session } from "@claudex/shared";
import type { ProjectStore } from "./projects.js";
import type { SessionStore } from "./store.js";
import { importCliSessionEvents } from "./cli-events-import.js";

export interface CliImportDeps {
  sessions: SessionStore;
  projects: ProjectStore;
  logger?: {
    debug?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export interface CliImportInput {
  sessionId: string; // CLI/SDK session_id (uuid)
  cwd: string; // absolute path the CLI recorded the session under
  title: string;
  /**
   * Absolute path to the CLI JSONL file. When provided AND this is a
   * first-time adoption (wasNew === true), we seed session_events from it so
   * the imported session renders with its full transcript. Omitted → we
   * still create the row but leave it empty (backwards-compat for callers
   * that don't have a file path, e.g. synthetic adoptions in tests).
   */
  filePath?: string;
}

export interface CliImportResult {
  session: Session;
  wasNew: boolean;
  /** Number of session_events seeded from the JSONL, 0 if nothing to seed. */
  eventsImported: number;
}

/**
 * Adopt a `claude` CLI session into claudex. Idempotent:
 *   - if a claudex session already has `sdk_session_id === input.sessionId`,
 *     we return that row with `wasNew: false` — never duplicate, never
 *     re-seed events (the contract is "adopt once").
 *   - otherwise we ensure a project row exists for `cwd` (creating one named
 *     after the cwd's basename if needed) and insert a fresh session row
 *     with `sdk_session_id` pre-populated so the next WS turn resumes the
 *     same SDK conversation via `resume: <uuid>`.
 *
 * On first-time adoption, if `filePath` is passed, we ALSO parse the CLI's
 * JSONL transcript and stream it into `session_events` so the chat pane is
 * populated from turn 1. Without this, imported sessions would show an empty
 * chat until the user typed the next message.
 *
 * The adopted session is never marked as a worktree — CLI sessions run in
 * the user's real cwd; claudex's worktree plumbing is for its own spawns.
 */
export async function importCliSession(
  deps: CliImportDeps,
  input: CliImportInput,
): Promise<CliImportResult> {
  const existing = deps.sessions.findBySdkSessionId(input.sessionId);
  if (existing) {
    return { session: existing, wasNew: false, eventsImported: 0 };
  }

  // Anchor the session against a project row for the cwd. If the user
  // already added this cwd manually we reuse it; otherwise we synthesize a
  // project named after the basename (e.g. "claudex" for /Users/h/Code/AI/claudex).
  const project = deps.projects.upsertByPath({
    name: path.basename(input.cwd) || input.cwd,
    path: input.cwd,
  });
  // CLI-adopted projects are implicitly trusted — the user is already
  // operating in this cwd through the CLI. Flip the bit unconditionally so
  // that a pre-existing untrusted row (e.g. added manually via the web UI
  // but never confirmed) gets promoted on adoption, and so follow-up turns
  // don't hit the `project_not_trusted` gate in POST /api/sessions.
  deps.projects.setTrusted(project.id, true);

  const session = deps.sessions.create({
    title: input.title,
    projectId: project.id,
    // Default to the project's home model. CLI sessions store their own
    // model in the transcript but we don't parse it here — the user can
    // flip it from the session settings sheet if they care.
    model: "claude-opus-4-8",
    mode: "default",
    worktreePath: null,
    branch: null,
  });

  // Stamp the SDK session id so the next WS turn passes it as `resume`. The
  // store's setSdkSessionId uses first-write-wins (`WHERE sdk_session_id IS
  // NULL`) which is exactly what we want here.
  deps.sessions.setSdkSessionId(session.id, input.sessionId);
  // Flag the row as CLI-adopted so the resync-on-open and cli-sync-watcher
  // paths are willing to re-import subsequent JSONL growth into it. Native
  // claudex sessions stay `adopted_from_cli=0` (the DEFAULT) so neither
  // path touches them — see migrations 26/27 for the full rationale.
  deps.sessions.setAdoptedFromCli(session.id, true);

  // Seed session_events from the CLI transcript on first adoption. One bad
  // JSONL line is already swallowed by importCliSessionEvents; we still
  // wrap the whole call so a missing/unreadable file never 500s the import
  // route.
  let eventsImported = 0;
  if (input.filePath) {
    try {
      eventsImported = await importCliSessionEvents(
        { sessionEvents: deps.sessions, logger: deps.logger },
        { sessionId: session.id, filePath: input.filePath },
      );
      // Record how many non-empty JSONL lines we've consumed so the
      // resync-on-open path knows where to pick up when the CLI appends
      // more turns later.
      try {
        const lines = await countNonEmptyLines(input.filePath);
        deps.sessions.setCliJsonlSeq(session.id, lines);
      } catch (err) {
        deps.logger?.debug?.(
          { err, sessionId: input.sessionId },
          "cli-import: failed to count JSONL lines for seq stamp",
        );
      }
    } catch (err) {
      deps.logger?.warn?.(
        { err, sessionId: input.sessionId, filePath: input.filePath },
        "failed to seed CLI session events; adopted row remains empty",
      );
    }
  }

  const withSdk = deps.sessions.findById(session.id);
  return {
    session: withSdk ?? session,
    wasNew: true,
    eventsImported,
  };
}

async function countNonEmptyLines(filePath: string): Promise<number> {
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
