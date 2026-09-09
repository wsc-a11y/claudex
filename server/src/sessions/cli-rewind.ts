import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import {
  query,
  type Options,
  type RewindFilesResult,
} from "@anthropic-ai/claude-agent-sdk";
import { defaultCliProjectsRoot } from "./cli-discovery.js";
import { stripHarnessNoise } from "./cli-text-filter.js";

/**
 * Rewind plumbing for sessions that have NO live runner attached.
 *
 * The CLI's checkpoint history lives on disk (~/.claude/file-history/<sid>/…)
 * independent of any running process, so we can rewind an idle session by
 * briefly resuming its SDK conversation, issuing the `rewindFiles` control
 * request, and tearing the CLI child down again. No user message is ever
 * sent — the prompt stream stays empty — so the transcript is untouched and
 * no model tokens are spent.
 *
 * When a live runner IS attached the caller uses
 * `SessionManager.tryRewindViaLiveRunner` instead; resuming a session whose
 * CLI child is already alive would double-open the transcript.
 */

/** Same `<root>/<slug>/<id>.jsonl` scan strategy as cli-resync.ts's locateJsonl. */
export async function locateSessionJsonl(
  root: string = defaultCliProjectsRoot(),
  sdkSessionId: string,
): Promise<string | null> {
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

/**
 * Does this JSONL record carry visible user text (as opposed to a
 * tool_result carrier, a queue-operation, an empty synthetic turn, or a
 * subagent sidechain record)?
 *
 * Mirrors cli-events-import.ts's record → user_message conversion rules
 * EXACTLY (`convertAndAppend` + `appendUserRecord`): sidechain records are
 * dropped, string content must survive `stripHarnessNoise` non-empty, and
 * array content that carries any tool_result block goes to the tool_result
 * path rather than a user_message. Sequence alignment (see below) depends
 * on both sides agreeing on what "counts" — a drift here rewinds to the
 * WRONG checkpoint, so this stays a mirror of the import rules rather than
 * its own definition of visible.
 */
function isVisibleUserRecord(obj: Record<string, unknown>): boolean {
  if (obj.isSidechain === true) return false;
  if (obj.type !== "user") return false;
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") {
    return stripHarnessNoise(content).length > 0;
  }
  if (!Array.isArray(content)) return false;
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_result") return false; // tool path, not user_message
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    }
  }
  return textParts.some((t) => stripHarnessNoise(t).length > 0);
}

/**
 * Resolve the CLI-side anchor UUID for the Nth visible user message
 * (1-based) in a session's JSONL transcript.
 *
 * `rewindFiles` addresses checkpoints by the transcript's user-message UUID
 * (the top-level `uuid` on the JSONL record), but claudex's `user_message`
 * events don't persist that UUID for sessions adopted before this feature.
 * Ordering is the bridge: DB user_message #N ↔ JSONL visible user record #N
 * (both filtered by the same visibility rule above). Recordings that lack a
 * top-level uuid break the alignment — return null so the caller can fail
 * loudly instead of rewinding to the wrong point.
 */
export async function resolveAnchorUuid(
  jsonlPath: string,
  nthUserMessage: number,
): Promise<string | null> {
  if (nthUserMessage < 1) return null;
  const stream = fs.createReadStream(jsonlPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!isVisibleUserRecord(obj)) continue;
      seen += 1;
      if (seen === nthUserMessage) {
        const uuid = obj.uuid;
        return typeof uuid === "string" && uuid.length > 0 ? uuid : null;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RewindViaResumeOptions {
  /** Session cwd — the CLI resolves its transcript by this. */
  cwd: string;
  /** CLI/SDK session id (the `sdkSessionId` on the claudex session row). */
  sdkSessionId: string;
  /** Transcript user-message UUID to rewind to (see `resolveAnchorUuid`). */
  userMessageId: string;
  dryRun?: boolean;
  /** Model the resumed CLI starts with. No turn is run, so this is inert
   * beyond what the CLI needs at boot. */
  model?: string;
}

/**
 * Resume an idle session's SDK conversation, issue one `rewindFiles` control
 * request, and shut the CLI child down again. Never sends a user message.
 *
 * The SDK exposes no "CLI is ready" event for a freshly resumed query, so we
 * poll: control requests issued before the child finishes initializing can
 * be rejected, hence one retry after a short wait. Long transcripts can take
 * a few seconds to load; the 6s initial wait covers typical cases and the
 * retry absorbs the stragglers.
 */
export async function rewindViaResume(
  opts: RewindViaResumeOptions,
): Promise<RewindFilesResult> {
  // An empty prompt stream keeps the child alive in streaming-input mode
  // without ever triggering a turn.
  const noopPrompt = (async function* () {
    await new Promise(() => {});
  })();

  const sdkOptions: Options = {
    cwd: opts.cwd,
    resume: opts.sdkSessionId,
    permissionMode: "default",
    model: opts.model ?? "opus",
    // The control request requires the checkpointing machinery to be armed
    // on the child even though the history itself was written earlier.
    enableFileCheckpointing: true,
  };

  const handle = query({ prompt: noopPrompt, options: sdkOptions });
  try {
    await sleep(6000);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await handle.rewindFiles(
          opts.userMessageId,
          opts.dryRun ? { dryRun: true } : undefined,
        );
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await sleep(4000);
      }
    }
    throw lastErr;
  } finally {
    // Tear the child down: interrupt ends its idle wait; returning the
    // generator lets the SDK run its own shutdown sequence.
    try {
      await handle.interrupt();
    } catch {
      /* already gone */
    }
    try {
      await (handle as AsyncGenerator).return?.(undefined);
    } catch {
      /* already gone */
    }
  }
}
