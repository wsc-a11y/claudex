import fs from "node:fs";
import readline from "node:readline";
import { nanoid } from "nanoid";
import type { SessionStore } from "./store.js";
import { stripHarnessNoise } from "./cli-text-filter.js";

export interface CliEventsImportDeps {
  sessionEvents: SessionStore;
  logger?: {
    debug?: (obj: unknown, msg?: string) => void;
  };
}

export interface CliEventsImportInput {
  /** claudex session row id (NOT the CLI/SDK uuid). Events attach here. */
  sessionId: string;
  /** Absolute path to the CLI's `<uuid>.jsonl` transcript. */
  filePath: string;
}

/**
 * Seed a claudex session's `session_events` table from a `claude` CLI JSONL
 * transcript. Converts each CLI record into zero or more SessionEvents using
 * the same kind/payload shape the live agent-runner produces, so an imported
 * session renders identically to a native one.
 *
 * Streams the file line-by-line — some JSONLs are multi-MB and slurping them
 * would blow up memory. Parse errors and unknown record types are silently
 * skipped (logged at debug) so a single bad line never fails an import.
 *
 * Record types we deliberately skip (they have no UI representation today):
 *   - "queue-operation": CLI internal enqueue/dequeue bookkeeping.
 *   - "attachment": skill listings, image references, etc. The runner
 *     doesn't surface these as pieces in the chat.
 *   - "file-history-snapshot": CLI's built-in undo state, orthogonal to us.
 *   - "last-prompt": CLI resume hint, not a transcript event.
 *   - any other unknown `type`.
 *
 * Returns the number of SessionEvents appended.
 */
export async function importCliSessionEvents(
  deps: CliEventsImportDeps,
  input: CliEventsImportInput,
): Promise<number> {
  const stream = fs.createReadStream(input.filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let appended = 0;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch (err) {
        deps.logger?.debug?.({ err }, "skipping malformed JSONL line");
        continue;
      }
      appended += convertAndAppend(deps.sessionEvents, input.sessionId, obj);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return appended;
}

/**
 * Emit zero or more SessionEvents for a single parsed JSONL record. Returns
 * the count appended so the caller can report totals.
 */
function convertAndAppend(
  sessionEvents: SessionStore,
  sessionId: string,
  obj: Record<string, unknown>,
): number {
  // Skip subagent / Task-tool records outright. Their `usage` reflects the
  // child agent's own context (separate from the parent session), so folding
  // them into our turn_end stream corrupts both the context ring
  // (lastTurnInput would sometimes come from a child's context) and the
  // per-session token rollups. Claude Code CLI's own statusline treats
  // sidechain records the same way.
  if (obj.isSidechain === true) return 0;
  const type = obj.type;
  if (type === "user") {
    return appendUserRecord(sessionEvents, sessionId, obj);
  }
  if (type === "assistant") {
    return appendAssistantRecord(sessionEvents, sessionId, obj);
  }
  // queue-operation, attachment, file-history-snapshot, last-prompt, ... skip.
  return 0;
}

function appendUserRecord(
  sessionEvents: SessionStore,
  sessionId: string,
  obj: Record<string, unknown>,
): number {
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || message.role !== "user") return 0;
  const content = message.content;

  // String content = a real user turn *unless* it's entirely harness-injected
  // noise (task-notification, system-reminder, slash-command echo, …). We run
  // the filter on every string payload and drop the event if nothing remains.
  if (typeof content === "string") {
    const cleaned = stripHarnessNoise(content);
    if (cleaned.length === 0) return 0;
    sessionEvents.appendEvent({
      sessionId,
      kind: "user_message",
      payload: { text: cleaned },
    });
    return 1;
  }

  if (!Array.isArray(content)) return 0;

  // Array content splits into two cases:
  //   - blocks of {type:"text"} → a real user turn (e.g. the CLI sometimes
  //     wraps a typed message as [{type:"text",text:"hi"}] instead of a bare
  //     string). Concat the text blocks.
  //   - blocks of {type:"tool_result"} → synthetic user turn carrying tool
  //     results from the prior assistant turn. Emit tool_result events and
  //     NOT a user_message.
  const toolResults: Array<Record<string, unknown>> = [];
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_result") {
      toolResults.push(b);
    } else if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    }
  }

  if (toolResults.length > 0) {
    let n = 0;
    for (const b of toolResults) {
      sessionEvents.appendEvent({
        sessionId,
        kind: "tool_result",
        payload: {
          toolUseId: String(b.tool_use_id ?? ""),
          content: stringifyToolResultContent(b.content),
          isError: Boolean(b.is_error),
        },
      });
      n += 1;
    }
    return n;
  }

  // Strip harness noise from each text block independently, then join. If the
  // joined result is empty the whole record was harness chatter → drop it.
  const cleanedParts = textParts
    .map((t) => stripHarnessNoise(t))
    .filter((t) => t.length > 0);
  const text = cleanedParts.join("\n").trim();
  if (text.length === 0) return 0;
  sessionEvents.appendEvent({
    sessionId,
    kind: "user_message",
    payload: { text },
  });
  return 1;
}

function appendAssistantRecord(
  sessionEvents: SessionStore,
  sessionId: string,
  obj: Record<string, unknown>,
): number {
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || message.role !== "assistant") return 0;
  const content = message.content;
  if (!Array.isArray(content)) return 0;

  const messageId = String(
    (message.id as string | undefined) ??
      (obj.uuid as string | undefined) ??
      nanoid(12),
  );

  let n = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      sessionEvents.appendEvent({
        sessionId,
        kind: "assistant_text",
        payload: { messageId, text: b.text, done: true },
      });
      n += 1;
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      // Skip empty thinking blocks — the CLI emits them as placeholders when
      // the assistant only thought silently before calling a tool. They'd
      // render as an empty bubble.
      if (b.thinking.trim().length === 0) continue;
      sessionEvents.appendEvent({
        sessionId,
        kind: "assistant_thinking",
        payload: { text: b.thinking },
      });
      n += 1;
    } else if (b.type === "tool_use") {
      sessionEvents.appendEvent({
        sessionId,
        kind: "tool_use",
        payload: {
          toolUseId: String(b.id ?? nanoid(12)),
          name: String(b.name ?? "unknown"),
          input: (b.input as Record<string, unknown> | undefined) ?? {},
        },
      });
      n += 1;
    }
  }

  // After the assistant record, mirror the live runner's `turn_end` so the
  // Usage panel / context ring reflect historical turns. The CLI records
  // usage on every assistant chunk, including intermediate tool-use ones;
  // we emit a turn_end for each so `lastTurn` tracks the most recent
  // context body even mid-turn, but we record the raw `stop_reason` so the
  // shared `scanTurnEnds` only accumulates `totalInput` on real end-of-turn
  // chunks (`end_turn` / `stop_sequence` / …). `unknown` fallback (rather
  // than `end_turn`) keeps us from laundering a missing stop_reason into a
  // fake final turn.
  const usage = message.usage as Record<string, unknown> | undefined;
  if (usage) {
    sessionEvents.appendEvent({
      sessionId,
      kind: "turn_end",
      payload: {
        stopReason:
          typeof message.stop_reason === "string"
            ? message.stop_reason
            : "unknown",
        usage: {
          inputTokens: toInt(usage.input_tokens),
          outputTokens: toInt(usage.output_tokens),
          cacheReadInputTokens: toInt(usage.cache_read_input_tokens),
          cacheCreationInputTokens: toInt(usage.cache_creation_input_tokens),
        },
      },
    });
    n += 1;
  }
  return n;
}

function stringifyToolResultContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  if (Array.isArray(raw)) {
    return raw
      .map((c) => {
        if (c && typeof c === "object") {
          const cc = c as Record<string, unknown>;
          if (cc.type === "text" && typeof cc.text === "string") return cc.text;
          return JSON.stringify(cc);
        }
        return String(c);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function toInt(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
