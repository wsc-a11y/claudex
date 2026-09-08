import { create } from "zustand";
import { api, ApiError } from "@/api/client";
import { createWsClient, type WsClient, type WsDiagnostics } from "@/api/ws";
import { toast } from "@/lib/toast";
import { flashTitle } from "@/lib/title-flash";
import type {
  AskUserQuestionAnnotation,
  AskUserQuestionItem,
  ClientFrame,
  CompactBoundaryPayload,
  Session,
  SessionEvent,
  ServerFrame,
  SessionStatus,
  SubagentEndPayload,
  SubagentLifecycleStatus,
  SubagentProgressPayload,
  SubagentStartPayload,
  SubagentToolProgressPayload,
  SubagentUpdatePayload,
  SubagentUsage,
} from "@claudex/shared";

// ---------------------------------------------------------------------------
// Session-completion notifier (client-only, dedup'd per session).
//
// When a session transitions to a terminal-ish status (`idle` — Claude's
// turn ended — or `error` — terminal failure) we surface a toast + a
// document.title flash so the user knows to look. Web Push isn't an
// option on claudex because the user runs HTTP through frpc, so this is
// our in-app fallback.
//
// Dedup is by sessionId → lastNotifiedStatus. We only fire when the
// observed status actually differs from the last one we notified on
// (or there is no prior entry). The map is seeded from the REST
// /sessions payload on first load so nothing fires retroactively for
// sessions that were already idle when the app booted.
//
// Lives at module scope (not in the zustand store) because it's pure
// side-effect bookkeeping — no component needs to render off of it and
// keeping it out of state avoids spurious re-renders.
// ---------------------------------------------------------------------------
const notifiedStatus = new Map<string, SessionStatus>();

/**
 * Mirror of the server's `toPreview` helper in `server/src/sessions/store.ts`.
 * Collapses whitespace and truncates to 200 chars with an ellipsis so the
 * optimistic Home-row preview we write on a `user_message` frame matches
 * exactly what a subsequent `GET /api/sessions` would return — no flicker
 * after the next refresh.
 */
function previewUserMessage(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const collapsed = String(raw).replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

function shouldNotifyCompletion(
  prev: SessionStatus | undefined,
  next: SessionStatus,
): boolean {
  // Only `idle` (turn ended) and `error` (terminal failure) count as
  // "session finished" for the user-facing alert. `archived` is a user
  // action, `awaiting` is already surfaced on the Alerts screen, and
  // `running` is a start-of-turn transition.
  if (next !== "idle" && next !== "error") return false;
  if (prev === next) return false;
  // `cli_running` is a purely external-process observation; when it flips
  // back to idle the user's SDK-side turn was already over before it ever
  // entered cli_running, so treating the demotion as a "session finished"
  // would spam the user every time their external `claude` CLI exits.
  if (prev === "cli_running") return false;
  return true;
}

// Cap the completion map so a long-running client doesn't accumulate
// unbounded entries. When we overflow the cap we prefer to evict a
// `seen: true` row (the user has already acked it) by oldest `at`; if
// nothing is seen we fall back to evicting the globally oldest entry.
// One pass. Called from both the session_update handler and any future
// writer — kept small enough to inline but pulled out so the policy is
// in one place.
const COMPLETIONS_CAP = 50;
function capCompletions(
  map: Record<string, { status: "idle" | "error"; at: string; seen: boolean }>,
): Record<string, { status: "idle" | "error"; at: string; seen: boolean }> {
  const keys = Object.keys(map);
  if (keys.length <= COMPLETIONS_CAP) return map;
  let victim: string | null = null;
  let victimAt = Infinity;
  // Prefer oldest seen.
  for (const k of keys) {
    const v = map[k];
    if (!v.seen) continue;
    const t = Date.parse(v.at) || 0;
    if (t < victimAt) {
      victimAt = t;
      victim = k;
    }
  }
  // Fall back to oldest overall if no seen entry exists.
  if (!victim) {
    victimAt = Infinity;
    for (const k of keys) {
      const t = Date.parse(map[k].at) || 0;
      if (t < victimAt) {
        victimAt = t;
        victim = k;
      }
    }
  }
  if (!victim) return map;
  const { [victim]: _drop, ...rest } = map;
  void _drop;
  return rest;
}

// A streamed turn is rendered as a list of UI "pieces": text, tool_use,
// tool_result, thinking. We build these up from both persisted events (on
// load) and live WS frames.

export type UIPiece =
  | {
      kind: "user";
      id: string;
      text: string;
      at: string;
      // ISO timestamp of the persisted event. Mirrors `at` on user
      // pieces for consistency with other piece kinds, all of which
      // carry `createdAt` so the Chat + rails can render timestamps
      // uniformly without caring which kind of piece is in hand.
      createdAt?: string;
      // Persisted event seq when this piece came off the server. Undefined
      // for optimistic echoes that haven't been acked yet. Used by
      // MessageActions to build permalinks (`#seq-<n>`).
      seq?: number;
      // True once we've matched this piece against a server-broadcast
      // `user_message` frame (or it came straight from the server in the
      // first place). Used by the multi-tab de-dupe rule — a tab's locally
      // echoed user piece is `serverAcked=false` until its own ws receives
      // the matching broadcast, at which point we flip the flag rather
      // than push a second copy.
      serverAcked?: boolean;
      // Opaque nonce generated per-send. Stamped onto the optimistic piece
      // AND the outgoing WS `user_message` frame, and relayed back on the
      // server's echoed broadcast. The reconciliation handler matches on
      // echoId first (stable, collision-free) and only falls back to the
      // legacy text+3s heuristic for echoes that don't carry one (e.g.
      // messages sent by another tab / legacy client).
      echoId?: string;
      // Shallow list of attachment metadata from the original user_message
      // payload. Populated from persisted events only — optimistic echoes
      // skip it. Drives the "edit disabled because attachments" hint in
      // the Chat bubble; payload stays authoritative server-side.
      attachments?: Array<{
        id: string;
        filename: string;
        mime: string;
        size: number;
      }>;
    }
  | {
      kind: "assistant_text";
      id: string;
      text: string;
      seq?: number;
      createdAt?: string;
      /** Non-null when this text block came from a subagent's turn
       * (SDK `SDKAssistantMessage.parent_tool_use_id`). Used by the s-17
       * rail selector to gather nested child output under its SubagentRun.
       * Undefined on main-thread text — treat as main thread. */
      parentToolUseId?: string;
    }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      seq?: number;
      createdAt?: string;
      parentToolUseId?: string;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
      seq?: number;
      createdAt?: string;
      parentToolUseId?: string;
    }
  | {
      kind: "thinking";
      text: string;
      seq?: number;
      createdAt?: string;
      parentToolUseId?: string;
    }
  | {
      kind: "permission_request";
      approvalId: string;
      toolName: string;
      input: Record<string, unknown>;
      summary: string;
      seq?: number;
      createdAt?: string;
    }
  // SDK's AskUserQuestion tool — rendered as an in-transcript multiple-choice
  // card. Distinct from permission_request because it's an interaction, not a
  // security gate. `answers` is set once the user submits; until then the
  // card is pending. `answerSeq` tracks the seq of the sibling
  // `ask_user_answer` event so we can dedupe on refetch.
  | {
      kind: "ask_user_question";
      askId: string;
      questions: AskUserQuestionItem[];
      seq?: number;
      createdAt?: string;
      answers?: Record<string, string>;
      annotations?: Record<string, AskUserQuestionAnnotation>;
      answerSeq?: number;
    }
  // SDK's ExitPlanMode tool — rendered as a dedicated "commit to this plan?"
  // card. Like ask_user_question, it's not a security gate; accept lets the
  // model proceed, reject sends it back for revisions. `decision` is set
  // once the user has clicked one of the buttons (or on refetch from a
  // persisted `plan_accept_decision` sibling event), at which point the card
  // renders read-only with an accepted / rejected pill.
  | {
      kind: "plan_accept_request";
      planId: string;
      plan: string;
      seq?: number;
      createdAt?: string;
      decision?: "accept" | "reject";
      decisionSeq?: number;
    }
  // ------------------------------------------------------------------
  // Live subagents (s-17). Five pieces per subagent run lifecycle —
  // start / progress / update / end / tool_progress. They land in the
  // transcript like any other piece, but the s-17 rail aggregates them
  // by `taskId` via the `useSubagentRuns(sessionId)` selector rather
  // than rendering them inline in the main chat thread.
  // ------------------------------------------------------------------
  | ({ kind: "subagent_start"; seq?: number; createdAt?: string } & SubagentStartPayload)
  | ({ kind: "subagent_progress"; seq?: number; createdAt?: string } & SubagentProgressPayload)
  | ({ kind: "subagent_update"; seq?: number; createdAt?: string } & SubagentUpdatePayload)
  | ({ kind: "subagent_end"; seq?: number; createdAt?: string } & SubagentEndPayload)
  | ({
      kind: "subagent_tool_progress";
      seq?: number;
      createdAt?: string;
    } & SubagentToolProgressPayload)
  // Persisted divider inserted by `/compact` (manual) or auto-compaction.
  // Renders as a horizontal rule with pre→post token counts; not folded
  // into ToolGroup, never a finalizer for any group. `summary` lands a
  // few seconds later (the SDK only writes it to its transcript JSONL,
  // not the streamed message bus — runner harvests it and emits a
  // `compact_summary` frame whose payload is folded onto this piece by
  // `at === boundaryAt`).
  | ({
      kind: "compact_boundary";
      seq?: number;
      createdAt?: string;
      summary?: string;
    } & CompactBoundaryPayload)
  // `pending` is a UI-only piece (never persisted, never comes off the wire).
  // Inserted right after a user_message echo to give the user immediate
  // feedback that claude is processing. Removed as soon as any substantive
  // runner event lands (assistant_text, thinking, tool_use, tool_result,
  // permission_request, turn_end, error). If nothing arrives within ~30s the
  // piece flips into a "stalled" red state but stays on screen so the user
  // knows something's off without blocking further input.
  //
  // NB: we explicitly do NOT try to synthesize partial assistant text here.
  // The Agent SDK doesn't surface content_block_delta — the first thing the
  // UI sees for a reply is the *whole* message after message_stop. See
  // memory/project_streaming_deferred.md.
  | { kind: "pending"; id: string; startedAt: number; stalled: boolean };

/**
 * Per-session pagination bookkeeping for the transcript. Kept in a parallel
 * map so the main `transcripts[id]` UIPiece array stays the same shape.
 *
 *   - `hasMore`: true when there are older events on the server we haven't
 *     loaded yet. Drives the "Loading older messages…" trigger at the top
 *     of the scroller.
 *   - `lowestSeq`: the smallest `seq` in the loaded tail; used as the
 *     `beforeSeq` when requesting the next older page.
 *   - `loadingOlder`: re-entrancy guard so a fast scrollTop doesn't fire
 *     multiple overlapping requests.
 *   - `initialLoading`: true between `ensureTranscript` start and the
 *     first `/events?limit=200` resolving. The Chat screen shows a
 *     skeleton while this is true, instead of a blank canvas.
 */
export interface TranscriptMeta {
  hasMore: boolean;
  lowestSeq: number | null;
  loadingOlder: boolean;
  initialLoading: boolean;
}

interface SessionState {
  ws: WsClient | null;
  connected: boolean;
  wsDiag: WsDiagnostics;
  sessions: Session[];
  // sessionId → pieces in order
  transcripts: Record<string, UIPiece[]>;
  transcriptMeta: Record<string, TranscriptMeta>;
  loadingSessions: boolean;
  // Per-session "recently completed" marker. A session lands here when a
  // live WS `session_update` flips it into `idle` or `error` — i.e. the
  // turn just finished or blew up. Once the user opens the session we
  // flip `seen: true` (not delete) so the entry stays visible on the
  // Alerts screen as an archival row the user can still click back
  // into. One entry per session; re-completing resets seen=false.
  completions: Record<
    string,
    { status: "idle" | "error"; at: string; seen: boolean }
  >;
  // Per-session "compaction in progress" flag. Flipped on by the SDK's
  // `compact_status` start frame and off by the matching end frame; drives
  // the chat header's "Compacting…" pill. Not persisted — purely a transient
  // hint, the durable record is the `compact_boundary` row in
  // `session_events`. `error` is set on `phase: "end"` with `result: "failed"`
  // so the header can briefly surface the SDK's `compact_error` message.
  compacting: Record<string, { since: number; error?: string } | undefined>;
  // The session the user is currently looking at (Chat screen). Set by
  // `subscribeSession` (called from Chat.tsx on mount) and cleared by
  // `clearActiveSession` (called on unmount). Used by the WS `acked`
  // handler so, on reconnect, we can re-`subscribe` to the active
  // session AND pull any events that landed during the downtime via
  // `refetchTail`. Nullable — screens that don't own a single session
  // (Home, Settings) leave it null.
  activeSessionId: string | null;
  init: () => void;
  refreshSessions: () => Promise<void>;
  ensureTranscript: (sessionId: string) => Promise<void>;
  loadOlderTranscript: (sessionId: string) => Promise<void>;
  refetchTail: (sessionId: string) => Promise<void>;
  subscribeSession: (sessionId: string) => void;
  clearActiveSession: (sessionId: string) => void;
  sendUserMessage: (
    sessionId: string,
    text: string,
    attachmentIds?: string[],
  ) => void;
  interruptSession: (sessionId: string) => void;
  ensurePendingFor: (sessionId: string) => void;
  resolvePermission: (
    sessionId: string,
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
  resolveAskUserQuestion: (
    sessionId: string,
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ) => void;
  resolvePlanAccept: (
    sessionId: string,
    planId: string,
    decision: "accept" | "reject",
  ) => void;
  forgetSession: (id: string) => void;
}

function eventToPiece(ev: SessionEvent): UIPiece | null {
  const p = ev.payload as Record<string, any>;
  // Pick a valid ISO timestamp for subagent lifecycle pieces: some older
  // rows may have persisted an `at` field that isn't a parseable ISO
  // string (e.g. a numeric unix-seconds value stringified, which would
  // render as 1970-01-XX via `timeAgoShort`'s date fallback). When `at`
  // doesn't parse, fall back to the event's own `createdAt` (always a
  // proper ISO set by the DB insert path).
  const subagentAt = (): string => {
    const candidate = typeof p.at === "string" ? p.at : null;
    if (candidate) {
      const ts = Date.parse(candidate);
      if (Number.isFinite(ts) && ts > 0) return candidate;
    }
    return ev.createdAt;
  };
  switch (ev.kind) {
    case "user_message":
      return {
        kind: "user",
        id: ev.id,
        text: String(p.text ?? ""),
        at: ev.createdAt,
        createdAt: ev.createdAt,
        seq: ev.seq,
        serverAcked: true,
        // Pass attachments straight through from the persisted payload.
        // Undefined when the message was plain text (the common case).
        attachments: Array.isArray(p.attachments)
          ? (p.attachments as Array<{
              id: string;
              filename: string;
              mime: string;
              size: number;
            }>)
          : undefined,
      };
    case "assistant_text":
      return {
        kind: "assistant_text",
        id: String(p.messageId ?? ev.id),
        text: String(p.text ?? ""),
        seq: ev.seq,
        createdAt: ev.createdAt,
        ...(typeof p.parentToolUseId === "string"
          ? { parentToolUseId: p.parentToolUseId }
          : {}),
      };
    case "assistant_thinking":
      return {
        kind: "thinking",
        text: String(p.text ?? ""),
        seq: ev.seq,
        createdAt: ev.createdAt,
        ...(typeof p.parentToolUseId === "string"
          ? { parentToolUseId: p.parentToolUseId }
          : {}),
      };
    case "tool_use":
      return {
        kind: "tool_use",
        id: String(p.toolUseId ?? ev.id),
        name: String(p.name ?? "unknown"),
        input: (p.input as Record<string, unknown>) ?? {},
        seq: ev.seq,
        createdAt: ev.createdAt,
        ...(typeof p.parentToolUseId === "string"
          ? { parentToolUseId: p.parentToolUseId }
          : {}),
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: String(p.toolUseId ?? ""),
        content: String(p.content ?? ""),
        isError: Boolean(p.isError),
        seq: ev.seq,
        createdAt: ev.createdAt,
        ...(typeof p.parentToolUseId === "string"
          ? { parentToolUseId: p.parentToolUseId }
          : {}),
      };
    case "permission_request":
      return {
        kind: "permission_request",
        approvalId: String(p.toolUseId ?? ""),
        toolName: String(p.toolName ?? ""),
        input: (p.input as Record<string, unknown>) ?? {},
        summary: String(p.title ?? ""),
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "ask_user_question":
      return {
        kind: "ask_user_question",
        askId: String(p.askId ?? ""),
        questions: Array.isArray(p.questions)
          ? (p.questions as AskUserQuestionItem[])
          : [],
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "ask_user_answer":
      // Answers land as a sibling event; we don't render them as a
      // standalone piece. The reducer (see `eventsToPieces` below)
      // folds them into the matching `ask_user_question` piece. Return null
      // here so the default piece builder skips it.
      return null;
    case "plan_accept_request":
      return {
        kind: "plan_accept_request",
        planId: String(p.planId ?? ""),
        plan: String(p.plan ?? ""),
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "plan_accept_decision":
      // Decisions land as a sibling event; the reducer folds them into the
      // matching plan_accept_request piece. Skip in the default builder.
      return null;
    case "subagent_start": {
      // Five new live-subagent kinds (s-17). We surface them as
      // transcript pieces so they persist through reload / resume; the
      // rail selector (useSubagentRuns) groups them by taskId.
      const usage = (p.usage as SubagentUsage | undefined) ?? {};
      void usage;
      return {
        kind: "subagent_start",
        seq: ev.seq,
        createdAt: ev.createdAt,
        taskId: String(p.taskId ?? ""),
        parentToolUseId:
          typeof p.parentToolUseId === "string" ? p.parentToolUseId : null,
        description: String(p.description ?? ""),
        ...(typeof p.agentType === "string" ? { agentType: p.agentType } : {}),
        ...(typeof p.taskType === "string" ? { taskType: p.taskType } : {}),
        ...(typeof p.workflowName === "string"
          ? { workflowName: p.workflowName }
          : {}),
        ...(typeof p.prompt === "string" ? { prompt: p.prompt } : {}),
        ...(typeof p.isBackgrounded === "boolean"
          ? { isBackgrounded: p.isBackgrounded }
          : {}),
        at: subagentAt(),
      };
    }
    case "subagent_progress":
      return {
        kind: "subagent_progress",
        seq: ev.seq,
        createdAt: ev.createdAt,
        taskId: String(p.taskId ?? ""),
        description: String(p.description ?? ""),
        ...(typeof p.lastToolName === "string"
          ? { lastToolName: p.lastToolName }
          : {}),
        ...(typeof p.summary === "string" ? { summary: p.summary } : {}),
        usage: (p.usage as SubagentUsage | undefined) ?? {},
        at: subagentAt(),
      };
    case "subagent_update":
      return {
        kind: "subagent_update",
        seq: ev.seq,
        createdAt: ev.createdAt,
        taskId: String(p.taskId ?? ""),
        patch: (p.patch as Record<string, unknown> | undefined) ?? {},
        at: subagentAt(),
      } as UIPiece;
    case "subagent_end": {
      const status = isLifecycleStatus(p.status)
        ? (p.status as SubagentLifecycleStatus)
        : "completed";
      return {
        kind: "subagent_end",
        seq: ev.seq,
        createdAt: ev.createdAt,
        taskId: String(p.taskId ?? ""),
        status,
        summary: String(p.summary ?? ""),
        ...(typeof p.outputFile === "string"
          ? { outputFile: p.outputFile }
          : {}),
        ...(typeof p.toolUseId === "string" ? { toolUseId: p.toolUseId } : {}),
        ...(p.usage ? { usage: p.usage as SubagentUsage } : {}),
        at: subagentAt(),
      };
    }
    case "subagent_tool_progress":
      // Not normally persisted (see server/src/sessions/manager.ts —
      // we broadcast but skip the DB row). Here for completeness in
      // case a future change starts persisting them.
      return {
        kind: "subagent_tool_progress",
        seq: ev.seq,
        createdAt: ev.createdAt,
        toolUseId: String(p.toolUseId ?? ""),
        toolName: String(p.toolName ?? ""),
        parentToolUseId:
          typeof p.parentToolUseId === "string" ? p.parentToolUseId : null,
        elapsedSeconds: Number(p.elapsedSeconds ?? 0),
        ...(typeof p.taskId === "string" ? { taskId: p.taskId } : {}),
        at: subagentAt(),
      };
    case "compact_boundary":
      return {
        kind: "compact_boundary",
        seq: ev.seq,
        createdAt: ev.createdAt,
        trigger: p.trigger === "auto" ? "auto" : "manual",
        preTokens: Number(p.preTokens ?? 0),
        ...(typeof p.postTokens === "number"
          ? { postTokens: p.postTokens }
          : {}),
        ...(typeof p.durationMs === "number"
          ? { durationMs: p.durationMs }
          : {}),
        at: typeof p.at === "string" ? p.at : ev.createdAt,
      };
    default:
      return null;
  }
}

function isLifecycleStatus(v: unknown): v is SubagentLifecycleStatus {
  return (
    v === "running" || v === "completed" || v === "failed" || v === "stopped"
  );
}

function frameToPiece(frame: ServerFrame): UIPiece | null {
  // Live frames don't carry a createdAt (see shared/src/protocol.ts — the
  // wire schema omits it to keep frames small, since the authoritative
  // timestamp is the DB row written server-side). But the UI's per-message
  // timestamp rendering guards on `p.createdAt`, so pieces that land via
  // WS come in with blank timestamps and only acquire one after a REST
  // refetch repopulates them from `session_events.createdAt`. Stamp a
  // client-side arrival time here so live messages render a timestamp
  // immediately; when the tab later refetches, the server's authoritative
  // value overwrites this one (eventsToPieces is called fresh on hydration).
  // The clock skew vs. server emission is sub-millisecond over localhost WS
  // and bounded by network RTT otherwise — acceptable for a display-only
  // "time ago" label.
  const nowIso = new Date().toISOString();
  switch (frame.type) {
    case "assistant_text_delta":
      return {
        kind: "assistant_text",
        id: frame.messageId,
        text: frame.text,
        createdAt: nowIso,
        ...(frame.parentToolUseId !== undefined
          ? { parentToolUseId: frame.parentToolUseId }
          : {}),
      };
    case "thinking":
      return {
        kind: "thinking",
        seq: frame.seq,
        text: frame.text,
        createdAt: nowIso,
        ...(frame.parentToolUseId !== undefined
          ? { parentToolUseId: frame.parentToolUseId }
          : {}),
      };
    case "tool_use":
      return {
        kind: "tool_use",
        id: frame.toolUseId,
        name: frame.name,
        input: frame.input,
        createdAt: nowIso,
        ...(frame.parentToolUseId !== undefined
          ? { parentToolUseId: frame.parentToolUseId }
          : {}),
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: frame.toolUseId,
        content: frame.content,
        isError: frame.isError,
        createdAt: nowIso,
        ...(frame.parentToolUseId !== undefined
          ? { parentToolUseId: frame.parentToolUseId }
          : {}),
      };
    case "permission_request":
      return {
        kind: "permission_request",
        approvalId: frame.approvalId,
        toolName: frame.toolName,
        input: frame.toolInput,
        summary: frame.summary,
        createdAt: nowIso,
      };
    case "ask_user_question":
      return {
        kind: "ask_user_question",
        askId: frame.askId,
        questions: frame.questions,
        createdAt: nowIso,
      };
    case "plan_accept_request":
      return {
        kind: "plan_accept_request",
        planId: frame.planId,
        plan: frame.plan,
        createdAt: nowIso,
      };
    case "subagent_start":
      return {
        kind: "subagent_start",
        taskId: frame.taskId,
        parentToolUseId: frame.parentToolUseId,
        description: frame.description,
        ...(frame.agentType !== undefined ? { agentType: frame.agentType } : {}),
        ...(frame.taskType !== undefined ? { taskType: frame.taskType } : {}),
        ...(frame.workflowName !== undefined
          ? { workflowName: frame.workflowName }
          : {}),
        ...(frame.prompt !== undefined ? { prompt: frame.prompt } : {}),
        ...(frame.isBackgrounded !== undefined
          ? { isBackgrounded: frame.isBackgrounded }
          : {}),
        at: frame.at,
      };
    case "subagent_progress":
      return {
        kind: "subagent_progress",
        taskId: frame.taskId,
        description: frame.description,
        ...(frame.lastToolName !== undefined
          ? { lastToolName: frame.lastToolName }
          : {}),
        ...(frame.summary !== undefined ? { summary: frame.summary } : {}),
        usage: frame.usage,
        at: frame.at,
      };
    case "subagent_update":
      return {
        kind: "subagent_update",
        taskId: frame.taskId,
        patch: frame.patch,
        at: frame.at,
      };
    case "subagent_end":
      return {
        kind: "subagent_end",
        taskId: frame.taskId,
        status: frame.status,
        summary: frame.summary,
        ...(frame.outputFile !== undefined
          ? { outputFile: frame.outputFile }
          : {}),
        ...(frame.toolUseId !== undefined ? { toolUseId: frame.toolUseId } : {}),
        ...(frame.usage !== undefined ? { usage: frame.usage } : {}),
        at: frame.at,
      };
    case "subagent_tool_progress":
      return {
        kind: "subagent_tool_progress",
        toolUseId: frame.toolUseId,
        toolName: frame.toolName,
        parentToolUseId: frame.parentToolUseId,
        elapsedSeconds: frame.elapsedSeconds,
        ...(frame.taskId !== undefined ? { taskId: frame.taskId } : {}),
        at: frame.at,
      };
    case "compact_boundary":
      return {
        kind: "compact_boundary",
        seq: frame.seq,
        createdAt: nowIso,
        trigger: frame.trigger,
        preTokens: frame.preTokens,
        ...(frame.postTokens !== undefined ? { postTokens: frame.postTokens } : {}),
        ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
        at: frame.at,
      };
    default:
      return null;
  }
}

/**
 * Build UIPieces from a list of persisted SessionEvents, folding any
 * `ask_user_answer` events into the matching `ask_user_question` piece so the
 * card renders in its resolved (read-only) state after refetch.
 */
function eventsToPieces(events: SessionEvent[]): UIPiece[] {
  const pieces: UIPiece[] = [];
  // Map askId → index into `pieces` for fast answer-fold.
  const askIdx = new Map<string, number>();
  // Map planId → index into `pieces` for fast decision-fold.
  const planIdx = new Map<string, number>();
  // Map boundaryAt → index into `pieces` so a `compact_summary` row
  // dropped into the middle of the event stream can be folded onto the
  // matching `compact_boundary` divider it belongs to.
  const boundaryIdx = new Map<string, number>();
  // Collect toolUseIds for any `permission_decision` event so we can drop
  // the matching `permission_request` piece — once decided, the card
  // disappears (live behavior via resolvePermission). Mirrors
  // server/src/sessions/diffs.ts::aggregatePendingDiffs.
  const decidedApprovalIds = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "permission_decision") {
      const p = ev.payload as Record<string, any>;
      const id = String(p.toolUseId ?? p.approvalId ?? "");
      if (id) decidedApprovalIds.add(id);
    }
  }
  for (const ev of events) {
    if (ev.kind === "ask_user_answer") {
      const p = ev.payload as Record<string, any>;
      const askId = String(p.askId ?? "");
      const idx = askIdx.get(askId);
      if (idx !== undefined) {
        const existing = pieces[idx];
        if (existing.kind === "ask_user_question") {
          pieces[idx] = {
            ...existing,
            answers: (p.answers as Record<string, string>) ?? {},
            annotations:
              (p.annotations as Record<string, AskUserQuestionAnnotation>) ??
              undefined,
            answerSeq: ev.seq,
          };
        }
      }
      continue;
    }
    if (ev.kind === "plan_accept_decision") {
      const p = ev.payload as Record<string, any>;
      const planId = String(p.planId ?? "");
      const idx = planIdx.get(planId);
      if (idx !== undefined) {
        const existing = pieces[idx];
        if (existing.kind === "plan_accept_request") {
          const decision =
            p.decision === "accept" || p.decision === "reject"
              ? (p.decision as "accept" | "reject")
              : undefined;
          pieces[idx] = {
            ...existing,
            decision,
            decisionSeq: ev.seq,
          };
        }
      }
      continue;
    }
    if (ev.kind === "compact_summary") {
      const p = ev.payload as Record<string, any>;
      const boundaryAt = String(p.boundaryAt ?? "");
      const content = typeof p.content === "string" ? p.content : "";
      if (!boundaryAt || !content) continue;
      const idx = boundaryIdx.get(boundaryAt);
      if (idx !== undefined) {
        const existing = pieces[idx];
        if (existing.kind === "compact_boundary") {
          pieces[idx] = { ...existing, summary: content };
        }
      }
      continue;
    }
    const piece = eventToPiece(ev);
    if (!piece) continue;
    // Drop persisted permission_request pieces that already have a decision
    // recorded. Matches live behavior where the card disappears on decide.
    if (
      piece.kind === "permission_request" &&
      decidedApprovalIds.has(piece.approvalId)
    ) {
      continue;
    }
    if (piece.kind === "ask_user_question") {
      askIdx.set(piece.askId, pieces.length);
    } else if (piece.kind === "plan_accept_request") {
      planIdx.set(piece.planId, pieces.length);
    } else if (piece.kind === "compact_boundary") {
      boundaryIdx.set(piece.at, pieces.length);
    }
    pieces.push(piece);
  }
  return pieces;
}

export const useSessions = create<SessionState>((set, get) => {
  // Per-session "stall watchdog" timers. The *first* substantive WS frame
  // clears the timer; if nothing arrives in STALL_MS we flip the pending
  // piece to `stalled: true` but we DON'T remove it — the user still needs
  // to know claude hasn't replied so they can decide whether to keep
  // waiting or hit Stop. Rendered as a muted informational hint, NOT an
  // error — the agent is usually still running (long thinking, slow tool).
  // Threshold is deliberately generous: short tool calls and normal
  // thinking finish well under this, so the hint only appears when
  // silence is actually worth surfacing.
  const STALL_MS = 90_000;
  const stallTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearStallTimer(sessionId: string) {
    const t = stallTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      stallTimers.delete(sessionId);
    }
  }

  function armStallTimer(sessionId: string, pendingId: string) {
    clearStallTimer(sessionId);
    const t = setTimeout(() => {
      stallTimers.delete(sessionId);
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionId]: (s.transcripts[sessionId] ?? []).map((p) =>
            p.kind === "pending" && p.id === pendingId
              ? { ...p, stalled: true }
              : p,
          ),
        },
      }));
    }, STALL_MS);
    stallTimers.set(sessionId, t);
  }

  // Remove the *first* pending piece for a session. Called when a meaningful
  // runner frame arrives — thinking / assistant_text / tool_use / tool_result /
  // permission_request / turn_end / error — meaning claude has started
  // producing output (or hit a terminal state) and the placeholder has done
  // its job.
  function dropFirstPending(sessionId: string) {
    clearStallTimer(sessionId);
    set((s) => {
      const list = s.transcripts[sessionId];
      if (!list) return s;
      const idx = list.findIndex((p) => p.kind === "pending");
      if (idx === -1) return s;
      return {
        transcripts: {
          ...s.transcripts,
          [sessionId]: [...list.slice(0, idx), ...list.slice(idx + 1)],
        },
      };
    });
  }

  return {
  ws: null,
  connected: false,
  wsDiag: { phase: "connecting", attempts: 0 },
  sessions: [],
  transcripts: {},
  transcriptMeta: {},
  loadingSessions: false,
  activeSessionId: null,
  completions: {},
  compacting: {},

  init() {
    if (get().ws) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const client = createWsClient(url);
    client.onState((diag) => {
      set({ wsDiag: diag, connected: diag.phase === "acked" });
    });
    // Recovery hook: every time the socket reaches `acked` (initial connect
    // AND every reconnect), re-subscribe the active session, refetch its
    // event tail, and resync session metadata. This is how we recover
    // frames dropped while the socket was down — the server paginates
    // `/events` cheaply, so pulling the last 200 on every ack is fine.
    // Testing deterministically would need vi fake timers + a mock socket;
    // skipped intentionally.
    //
    // `refreshSessions()` is what fixes the common mobile case: user sends
    // a prompt, backgrounds the tab; server finishes and fires a
    // `session_update` → idle frame that the closed socket never receives;
    // when the tab comes back the detail view still reads `running` from
    // the stale store. Pulling `GET /api/sessions` on ack realigns every
    // session's status with the SQLite source of truth — the active one
    // and anything else the user had running during the offline window.
    client.onAcked(() => {
      // Resync all session statuses on every ack, even if no session is
      // active — the list view may be the one the user returns to.
      void get().refreshSessions();
      const sid = get().activeSessionId;
      if (!sid) return;
      // Resubscribe first so any frames arriving mid-refetch still land in
      // the store; refetchTail's merge handles the overlap.
      client.send({ type: "subscribe", sessionId: sid } satisfies ClientFrame);
      void get().refetchTail(sid);
    });
    client.subscribe((frame) => {
      // Connection liveness tracked via hello_ack
      if (frame.type === "hello_ack") set({ connected: true });
      if (frame.type === "session_update") {
        const sid = frame.sessionId;
        // Snapshot pre-transition state so we can decide whether to fire a
        // completion toast. We deliberately look at the session BEFORE
        // applying the new status; the dedup map uses "last notified" as
        // its key, but the session row's own previous status is what tells
        // us whether this frame represents a real transition.
        const prevSession = get().sessions.find((x) => x.id === sid);
        // Bump the session's `updatedAt` locally whenever a session_update
        // lands. The server always bumps its `updated_at` column on any
        // mutation that emits this frame, so mirroring that client-side is
        // how ordered lists (Home, ChatSessionsRail) keep "most-recently-
        // updated first" semantics live — without this, `updatedAt` stays
        // frozen at the initial `GET /api/sessions` snapshot and the rail
        // looks randomly ordered once activity starts flowing.
        // Frame-optional fields (mode, title, lastMessageAt) are applied
        // when present so a title rename or mode flip on another tab
        // propagates without a refetch.
        const nowIso = new Date().toISOString();
        set((s) => ({
          sessions: s.sessions.map((x) => {
            if (x.id !== sid) return x;
            const next = { ...x, status: frame.status, updatedAt: nowIso };
            if (frame.mode !== undefined) next.mode = frame.mode;
            if (frame.title !== undefined) next.title = frame.title;
            if (frame.lastMessageAt !== undefined) {
              next.lastMessageAt = frame.lastMessageAt;
            }
            return next;
          }),
        }));
        // When a session drops back to idle/error without having produced any
        // assistant output (e.g. user interrupted immediately), still clear
        // the placeholder so it doesn't linger.
        if (
          frame.status === "idle" ||
          frame.status === "error" ||
          frame.status === "archived"
        ) {
          dropFirstPending(sid);
          // Defensive cleanup: a `compact_status` end frame may have been
          // missed (server restart mid-compaction, transient WS hiccup) so
          // the "Compacting…" pill could otherwise stick forever. Any
          // terminal-ish session_update is a definitive "no longer
          // compacting" signal.
          if (get().compacting[sid]) {
            set((s) => {
              const next = { ...s.compacting };
              delete next[sid];
              return { compacting: next };
            });
          }
        }
        // Session-completion alert. Only fire on real transitions into
        // `idle` / `error`, skip child (side-chat) sessions so Task-spawned
        // subagents don't spam the parent's completion signal, and dedup
        // per-session via the module-level `notifiedStatus` map so a repeat
        // `session_update` frame for the same status doesn't re-fire.
        const lastNotified = notifiedStatus.get(sid);
        if (
          prevSession &&
          !prevSession.parentSessionId &&
          shouldNotifyCompletion(lastNotified, frame.status)
        ) {
          notifiedStatus.set(sid, frame.status);
          const title = prevSession.title || "Session";
          // Normal completions go to the Alerts bucket silently — the
          // bottom toast was getting noisy when you had multiple runs
          // finishing in quick succession. Errors still toast + flash
          // the tab title because they're a real interrupt worth
          // pulling the user's eye.
          if (frame.status === "error") {
            toast(`${title} — session error`);
            flashTitle();
          }
          // Also surface this on the Alerts screen as a "recently
          // completed" entry. One slot per session; re-completing
          // overwrites. Cleared when the user opens that session via
          // subscribeSession, so the surface acts like "unread" signals.
          // `shouldNotifyCompletion` above already narrowed the status,
          // but TS can't carry that through the closure — re-narrow here.
          const completionStatus: "idle" | "error" =
            frame.status === "error" ? "error" : "idle";
          set((s) => {
            const activeId = s.activeSessionId;
            // If the user is currently looking at this session, don't
            // even add the completion — they've already seen it.
            if (activeId === sid) return s;
            const nextEntry = {
              status: completionStatus,
              at: new Date().toISOString(),
              // New completions always start unseen — even if a previous
              // completion for this session was already marked seen, a
              // re-completion should bubble the row back up.
              seen: false,
            };
            const merged = { ...s.completions, [sid]: nextEntry };
            // Cap total completions at 50 per client so the map doesn't grow
            // forever. Drop the oldest `seen: true` entry first; if none are
            // seen, drop the oldest overall.
            return { completions: capCompletions(merged) };
          });
        } else {
          // Always keep the dedup map in sync with the current status so
          // re-transitions (idle → running → idle) fire exactly once per
          // completion edge.
          notifiedStatus.set(sid, frame.status);
        }
      }
      // Multi-tab: a user_message broadcast can land in any subscribed tab —
      // including the one that sent it. De-dupe rule (in order):
      //   1. If the broadcast carries an `echoId`, try to find a local user
      //      piece with the same `echoId` in this session — that's the
      //      originating tab's own optimistic echo. Upgrade it to
      //      `serverAcked=true` and stamp the authoritative `createdAt`.
      //   2. Otherwise fall back to the legacy heuristic — match on content
      //      and a 3s timestamp window. This covers broadcasts from OTHER
      //      tabs (which carry an echoId this tab didn't generate, so the
      //      nonce match misses) and legacy clients that didn't stamp one
      //      at all — those are simply inserted as fresh pieces.
      //   3. Insert a fresh piece otherwise.
      if (frame.type === "user_message") {
        const sid = frame.sessionId;
        const ts = Date.parse(frame.createdAt) || Date.now();
        const frameEchoId = frame.echoId;
        // Bump session-level timestamps so ordered lists re-sort this
        // session to the top on any client that has the list rendered.
        // Server writes `last_message_at = created_at` and bumps
        // `updated_at`, so mirror that exactly (not "now") to stay aligned
        // with the canonical value.
        //
        // Also mirror the message text into `lastUserMessage` so the Home
        // row's "last sent" preview updates live without a `GET /api/sessions`
        // round-trip. Server-side preview is trimmed/collapsed/truncated in
        // `toPreview`; we repeat the exact same shape here so reloads don't
        // shift the characters the user sees.
        const preview = previewUserMessage(frame.content);
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === sid
              ? {
                  ...x,
                  updatedAt: frame.createdAt,
                  lastMessageAt: frame.createdAt,
                  lastUserMessage: preview,
                }
              : x,
          ),
        }));
        set((s) => {
          const list = s.transcripts[sid] ?? [];
          let matchIdx = -1;
          // 1. Stable echoId match — only if the frame and a local piece
          //    both carry the same nonce. Other tabs have no such piece,
          //    so this deliberately fails for their broadcasts.
          if (frameEchoId) {
            for (let i = list.length - 1; i >= 0; i--) {
              const piece = list[i];
              if (piece.kind !== "user") continue;
              if (piece.echoId && piece.echoId === frameEchoId) {
                matchIdx = i;
                break;
              }
            }
          }
          // 2. Legacy text+3s heuristic — only consulted when the echoId
          //    match failed. Handles broadcasts from legacy clients.
          if (matchIdx === -1) {
            for (let i = list.length - 1; i >= 0; i--) {
              const piece = list[i];
              if (piece.kind !== "user") continue;
              if (piece.text !== frame.content) continue;
              // Skip pieces that already carry a different echoId — they
              // belong to a distinct local send, not this broadcast.
              if (piece.echoId && piece.echoId !== frameEchoId) continue;
              if (piece.serverAcked) {
                matchIdx = i;
                break;
              }
              const pTs = Date.parse(piece.at) || 0;
              if (Math.abs(ts - pTs) <= 3000) {
                matchIdx = i;
                break;
              }
            }
          }
          if (matchIdx !== -1) {
            const existing = list[matchIdx];
            if (existing.kind === "user" && existing.serverAcked) {
              // Already acked — but if the sender was us and the first
              // broadcast lost the race to set attachments (shouldn't
              // happen with the current ordering, but be defensive), still
              // flow attachments through when this frame carries them.
              if (
                frame.attachments &&
                frame.attachments.length > 0 &&
                !existing.attachments
              ) {
                const next = [...list];
                next[matchIdx] = {
                  ...(existing as UIPiece & { kind: "user" }),
                  attachments: frame.attachments,
                };
                return { transcripts: { ...s.transcripts, [sid]: next } };
              }
              return s; // already acked, nothing to do
            }
            const next = [...list];
            next[matchIdx] = {
              ...(existing as UIPiece & { kind: "user" }),
              at: frame.createdAt,
              createdAt: frame.createdAt,
              serverAcked: true,
              // Flow attachments from the broadcast onto the reconciled
              // piece. Optimistic echoes don't carry this (the send path
              // only has attachment ids, not metadata) so the first paint
              // with thumbs/chips happens exactly here.
              ...(frame.attachments && frame.attachments.length > 0
                ? { attachments: frame.attachments }
                : {}),
            };
            return { transcripts: { ...s.transcripts, [sid]: next } };
          }
          // No local echo to reconcile — a *different* tab sent this. Insert
          // before any trailing `pending` placeholder so the UI keeps its
          // "claude is thinking" bubble at the very bottom.
          const piece: UIPiece = {
            kind: "user",
            id: `remote-${ts}`,
            text: frame.content,
            at: frame.createdAt,
            createdAt: frame.createdAt,
            serverAcked: true,
            ...(frame.attachments && frame.attachments.length > 0
              ? { attachments: frame.attachments }
              : {}),
          };
          const tailIsPending =
            list.length > 0 && list[list.length - 1].kind === "pending";
          const next = tailIsPending
            ? [...list.slice(0, -1), piece, list[list.length - 1]]
            : [...list, piece];
          return { transcripts: { ...s.transcripts, [sid]: next } };
        });
        return;
      }
      // Conversation compaction lifecycle. Three flavors:
      //   - `compact_status` is transient and only flips a per-session
      //     UI flag (drives the chat header's "Compacting…" pill).
      //   - `compact_boundary` is durable and gets folded into the
      //     transcript via the regular `frameToPiece` path further down.
      //   - `compact_summary` carries the SDK's post-compaction summary
      //     text, which lands a beat after the boundary because the SDK
      //     only ever writes it to its own JSONL. We fold it into the
      //     matching boundary piece by `at === boundaryAt` rather than
      //     pushing a new piece — keeps the divider self-contained.
      if (frame.type === "compact_status") {
        const sid = frame.sessionId;
        if (frame.phase === "start") {
          set((s) => ({
            compacting: { ...s.compacting, [sid]: { since: Date.now() } },
          }));
        } else {
          // phase: "end" — clear the flag. If compaction failed, surface
          // the error briefly so the header can flash a danger-toned hint
          // before clearing on the next heartbeat. We don't persist the
          // failed end state — the compacting flag is purely transient.
          if (frame.result === "failed") {
            const msg =
              frame.error ?? "Compaction failed — context not summarized.";
            toast(msg);
          }
          set((s) => {
            const next = { ...s.compacting };
            delete next[sid];
            return { compacting: next };
          });
        }
        return;
      }
      if (frame.type === "compact_summary") {
        const sid = frame.sessionId;
        const boundaryAt = frame.boundaryAt;
        const content = frame.content;
        set((s) => {
          const list = s.transcripts[sid];
          if (!list) return s;
          // Walk back-to-front: the summary almost always belongs to the
          // most recent boundary, and matching by `at` is exact.
          let touched = false;
          const next = list.map((piece) => {
            if (touched) return piece;
            if (piece.kind === "compact_boundary" && piece.at === boundaryAt) {
              touched = true;
              return { ...piece, summary: content };
            }
            return piece;
          });
          if (!touched) return s;
          return { transcripts: { ...s.transcripts, [sid]: next } };
        });
        return;
      }
      // Server appended events out-of-band (CLI resync). Refetch the tail
      // so the transcript reflects whatever the CLI added. Only act on the
      // currently-cached session to avoid surprise fetches for sessions the
      // user isn't looking at.
      //
      // We also fan this out as a window event so screens that aggregate
      // across sessions (e.g. the Subagent monitor at /agents) can refresh
      // themselves without caring which session changed.
      if (frame.type === "refresh_transcript") {
        const sid = frame.sessionId;
        if (get().transcripts[sid]) {
          void get().refetchTail(sid);
        }
        try {
          window.dispatchEvent(
            new CustomEvent("claudex:refresh_transcript", {
              detail: { sessionId: sid },
            }),
          );
        } catch {
          // SSR / no-window: ignore.
        }
        return;
      }
      // Queue table changed somewhere on the server — forward to any
      // screen that cares via a plain window event. We don't keep queue
      // state in this store (it's screen-local to QueueScreen), so a
      // custom event is the lightest-weight bridge. Replaces the 5s
      // poll in Queue.tsx.
      if (frame.type === "queue_update") {
        try {
          window.dispatchEvent(new CustomEvent("claudex:queue_update"));
        } catch {
          // SSR / no-window: ignore.
        }
        return;
      }
      // Global alerts_update ping — server says "the alerts list changed".
      // Dynamic import to avoid a cycle with web/src/state/alerts.ts (which
      // imports the API client, which is the opposite direction from here).
      // Fire-and-forget; the alerts store handles error cases itself.
      if (frame.type === "alerts_update") {
        void import("./alerts").then(({ useAlerts }) => {
          void useAlerts.getState().fetchAlerts();
        });
        return;
      }
      // Any substantive reply frame means the pending placeholder did its job.
      if (
        frame.type === "assistant_text_delta" ||
        frame.type === "thinking" ||
        frame.type === "tool_use" ||
        frame.type === "tool_result" ||
        frame.type === "permission_request" ||
        frame.type === "ask_user_question" ||
        frame.type === "plan_accept_request" ||
        frame.type === "turn_end"
      ) {
        // Every variant above carries a non-null `sessionId` per protocol.ts —
        // narrowing via the discriminated union means no cast is needed.
        dropFirstPending(frame.sessionId);
      } else if (frame.type === "error") {
        // `error` uniquely carries `sessionId: string | null` — a null means
        // the failure wasn't session-scoped (e.g. a handshake-level rejection)
        // and we must skip session-routed effects entirely.
        if (frame.sessionId) dropFirstPending(frame.sessionId);
      }
      const piece = frameToPiece(frame);
      if (piece) {
        // `frameToPiece` only returns non-null for frame types that carry a
        // required string `sessionId` (assistant_text_delta, thinking,
        // tool_use, tool_result, permission_request, ask_user_question,
        // plan_accept_request, and the five subagent_* lifecycle frames).
        // None of those allow a null sessionId, so a discriminant check
        // picks the correct narrowing without a cast.
        //
        // NOTE: the subagent_* entries below are load-bearing. Without
        // them, live WS frames that carry the SDK's task lifecycle get
        // dropped here even though frameToPiece mapped them to valid
        // pieces — `computeSubagentRuns` then falls back to legacy
        // synthesis for the parent Task tool_use and the live stream
        // shows "0 events / Waiting for the first tool call…" until a
        // page refresh replays the DB. Persisted events went through
        // fine (manager.ts appends them), the gap was only in-memory.
        if (
          frame.type !== "assistant_text_delta" &&
          frame.type !== "thinking" &&
          frame.type !== "tool_use" &&
          frame.type !== "tool_result" &&
          frame.type !== "permission_request" &&
          frame.type !== "ask_user_question" &&
          frame.type !== "plan_accept_request" &&
          frame.type !== "subagent_start" &&
          frame.type !== "subagent_progress" &&
          frame.type !== "subagent_update" &&
          frame.type !== "subagent_end" &&
          frame.type !== "subagent_tool_progress" &&
          frame.type !== "compact_boundary"
        ) {
          return;
        }
        const sid = frame.sessionId;
        set((s) => ({
          transcripts: {
            ...s.transcripts,
            [sid]: [...(s.transcripts[sid] ?? []), piece],
          },
        }));
      }
    });
    set({ ws: client });
  },

  async refreshSessions() {
    set({ loadingSessions: true });
    try {
      const res = await api.listSessions();
      // Seed the completion-notify dedup map so that sessions already in a
      // terminal state when the app boots (or when Home re-fetches) don't
      // retroactively fire a toast. We only want notifications for live
      // transitions observed over the WS after this point.
      for (const s of res.sessions) {
        if (!notifiedStatus.has(s.id)) {
          notifiedStatus.set(s.id, s.status);
        }
      }
      set({ sessions: res.sessions });
    } catch (err) {
      // Network flaps (iOS backgrounded-tab resume, WS reconnect) surface
      // here as a `TypeError: Load failed` with no stack. These are fire-
      // and-forget callers (Home mount, ws onAcked, rail refresh) so we
      // must not let the rejection escape — it ends up as an unhandled
      // `rejection` in the client-error log with no useful context.
      // Real API errors (4xx/5xx) still propagate so UIs that await this
      // can surface them.
      if (err instanceof ApiError) throw err;
    } finally {
      set({ loadingSessions: false });
    }
  },

  async ensureTranscript(sessionId) {
    if (get().transcripts[sessionId]) return;
    // Flag the session as "initial loading" so Chat can render a skeleton
    // instead of a blank canvas while the first 200 events resolve. We set
    // this synchronously so the first render already knows.
    set((s) => ({
      transcriptMeta: {
        ...s.transcriptMeta,
        [sessionId]: {
          hasMore: false,
          lowestSeq: null,
          loadingOlder: false,
          initialLoading: true,
        },
      },
    }));
    try {
      const res = await api.listEvents(sessionId, { limit: 200 });
      const pieces = eventsToPieces(res.events);
      set((s) => ({
        transcripts: { ...s.transcripts, [sessionId]: pieces },
        transcriptMeta: {
          ...s.transcriptMeta,
          [sessionId]: {
            hasMore: res.hasMore,
            lowestSeq: res.events.length > 0 ? res.events[0].seq : null,
            loadingOlder: false,
            initialLoading: false,
          },
        },
      }));
    } catch (err) {
      // Leave transcripts[id] empty so a retry (e.g. on nav back) fires a
      // fresh ensureTranscript. Clear the loading flag so the skeleton
      // doesn't stick.
      set((s) => ({
        transcriptMeta: {
          ...s.transcriptMeta,
          [sessionId]: {
            ...(s.transcriptMeta[sessionId] ?? {
              hasMore: false,
              lowestSeq: null,
              loadingOlder: false,
              initialLoading: false,
            }),
            initialLoading: false,
          },
        },
      }));
      throw err;
    }
  },

  async loadOlderTranscript(sessionId) {
    const meta = get().transcriptMeta[sessionId];
    if (!meta || !meta.hasMore || meta.loadingOlder) return;
    const lowest = meta.lowestSeq;
    if (lowest === null) return;
    set((s) => ({
      transcriptMeta: {
        ...s.transcriptMeta,
        [sessionId]: { ...meta, loadingOlder: true },
      },
    }));
    try {
      const res = await api.listEvents(sessionId, {
        beforeSeq: lowest,
        limit: 200,
      });
      const older = eventsToPieces(res.events);
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionId]: [...older, ...(s.transcripts[sessionId] ?? [])],
        },
        transcriptMeta: {
          ...s.transcriptMeta,
          [sessionId]: {
            hasMore: res.hasMore,
            lowestSeq:
              res.events.length > 0 ? res.events[0].seq : lowest,
            loadingOlder: false,
            initialLoading: false,
          },
        },
      }));
    } catch {
      set((s) => ({
        transcriptMeta: {
          ...s.transcriptMeta,
          [sessionId]: { ...meta, loadingOlder: false },
        },
      }));
    }
  },

  async refetchTail(sessionId) {
    // Server appended events out-of-band (CLI resync). Re-fetch the last 200
    // and merge with what we already have. Any lazily-loaded older pages
    // stay intact — we only touch the tail.
    try {
      const res = await api.listEvents(sessionId, { limit: 200 });
      const freshTail = eventsToPieces(res.events);
      const oldestInTail =
        res.events.length > 0 ? res.events[0].seq : null;
      set((s) => {
        const existing = s.transcripts[sessionId] ?? [];
        // Keep any loaded pieces from BEFORE the refetched tail window —
        // we determine that by matching piece-level identity from
        // `eventToPiece`, but we don't store `seq` on UIPiece. Fallback:
        // if there's nothing older loaded locally than the tail's oldest
        // seq, just replace the whole transcript. Otherwise, keep the
        // leading slice and replace the trailing portion.
        // Heuristic: existing length > freshTail length and tail hasMore
        // was false for "first page" → the existing array has a prefix of
        // older-loaded pages we want to keep. We append freshTail after
        // the prefix (approximated as everything up to existing.length -
        // freshTail.length).
        const prefixLen = Math.max(0, existing.length - freshTail.length);
        const merged = [...existing.slice(0, prefixLen), ...freshTail];
        const prevMeta = s.transcriptMeta[sessionId];
        return {
          transcripts: { ...s.transcripts, [sessionId]: merged },
          transcriptMeta: {
            ...s.transcriptMeta,
            [sessionId]: {
              hasMore: prevMeta?.hasMore ?? res.hasMore,
              lowestSeq: prevMeta?.lowestSeq ?? oldestInTail,
              loadingOlder: false,
              initialLoading: false,
            },
          },
        };
      });
    } catch {
      /* ignore — a live WS event will catch us up eventually */
    }
  },

  subscribeSession(sessionId) {
    // Chat.tsx calls this on mount. Treat it as a declaration of "this is the
    // session the user is looking at" — so on WS reconnect we can resubscribe
    // and refetch its tail automatically. If the user navigates from one
    // chat to another, the newer subscribe wins. `clearActiveSession` resets
    // to null on Chat unmount.
    set((s) => {
      // Demote any "recently completed" marker for this session from unseen
      // to seen — the user is now looking at it, so the Alerts screen should
      // show it as an archival row (muted) instead of a pending signal. We
      // deliberately do NOT delete the entry so the user can still see the
      // history of completed turns. If the entry is already seen, leave it
      // alone so re-navigating doesn't re-stamp it.
      const entry = s.completions[sessionId];
      if (!entry) return { activeSessionId: sessionId };
      if (entry.seen) return { activeSessionId: sessionId };
      return {
        activeSessionId: sessionId,
        completions: {
          ...s.completions,
          [sessionId]: { ...entry, seen: true },
        },
      };
    });
    get().ws?.send({ type: "subscribe", sessionId } satisfies ClientFrame);
  },

  clearActiveSession(sessionId) {
    // Only clear if we still think this session is active — guards against a
    // stale unmount racing a fast nav (A mount → B mount → A unmount) from
    // wiping B's activeSessionId.
    if (get().activeSessionId === sessionId) {
      set({ activeSessionId: null });
    }
  },

  sendUserMessage(sessionId, text, attachmentIds) {
    const pendingId = `pending-${Date.now()}`;
    // Per-send nonce for stable de-dupe against the server's echoed
    // `user_message` broadcast. `crypto.randomUUID` is only available in
    // secure contexts (HTTPS/localhost) — over plain HTTP through frp it's
    // undefined, so fall back to a time+random composite that's unique
    // enough for broadcast matching.
    const echoId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
    // Optimistic local echo + a pending placeholder so the user sees that
    // claude received the message and is thinking. We intentionally do NOT
    // wait for the first WS frame before showing this — the goal is to fill
    // the "what's happening?" gap between send and first assistant chunk.
    //
    // If the tail already carries a pending placeholder (user is queuing a
    // second message while claude is still thinking on the first), drop it
    // so we end up with a single trailing pending — otherwise we'd render
    // two "..." indicators stacked under two user messages. The fresh
    // pending takes over; armStallTimer below resets the stall clock.
    set((s) => {
      const list = s.transcripts[sessionId] ?? [];
      const tailIsPending =
        list.length > 0 && list[list.length - 1].kind === "pending";
      const base = tailIsPending ? list.slice(0, -1) : list;
      return {
        transcripts: {
          ...s.transcripts,
          [sessionId]: [
            ...base,
            {
              kind: "user",
              id: `local-${Date.now()}`,
              text,
              at: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              serverAcked: false,
              echoId,
            },
            {
              kind: "pending",
              id: pendingId,
              startedAt: Date.now(),
              stalled: false,
            },
          ],
        },
      };
    });
    armStallTimer(sessionId, pendingId);
    get().ws?.send({
      type: "user_message",
      sessionId,
      content: text,
      echoId,
      ...(attachmentIds && attachmentIds.length > 0
        ? { attachmentIds }
        : {}),
    } satisfies ClientFrame);
  },

  interruptSession(sessionId) {
    get().ws?.send({ type: "interrupt", sessionId } satisfies ClientFrame);
  },

  ensurePendingFor(sessionId) {
    const list = get().transcripts[sessionId] ?? [];
    // If there's already a pending piece at the tail, don't duplicate.
    if (list.length > 0 && list[list.length - 1].kind === "pending") return;
    const pendingId = `pending-${Date.now()}`;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    // No stall timer here — the session was already running before we
    // arrived, so we can't usefully claim "30s since user typed". We'll
    // clear this piece naturally when the next WS frame shows up.
  },

  resolvePermission(sessionId, approvalId, decision) {
    // Clear the pending card locally
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: (s.transcripts[sessionId] ?? []).filter(
          (p) =>
            !(
              p.kind === "permission_request" && p.approvalId === approvalId
            ),
        ),
      },
    }));
    get().ws?.send({
      type: "permission_decision",
      sessionId,
      approvalId,
      decision,
    } satisfies ClientFrame);
    // After deciding, claude's about to continue — re-arm a pending placeholder
    // so the user doesn't stare at an empty thread while the next reply cooks.
    const pendingId = `pending-${Date.now()}`;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    armStallTimer(sessionId, pendingId);
  },

  resolveAskUserQuestion(sessionId, askId, answers, annotations) {
    // Mark the matching question piece as answered in place — we DON'T
    // filter it out (unlike permission_request, which gets removed on
    // decide). The card stays in the transcript and renders read-only.
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: (s.transcripts[sessionId] ?? []).map((p) =>
          p.kind === "ask_user_question" && p.askId === askId
            ? { ...p, answers, annotations }
            : p,
        ),
      },
    }));
    get().ws?.send({
      type: "ask_user_answer",
      sessionId,
      askId,
      answers,
      ...(annotations ? { annotations } : {}),
    } satisfies ClientFrame);
    // Re-arm a pending placeholder so the next assistant turn isn't silent.
    const pendingId = `pending-${Date.now()}`;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    armStallTimer(sessionId, pendingId);
  },

  resolvePlanAccept(sessionId, planId, decision) {
    // Mark the matching plan card as decided in place — like
    // ask_user_question, the card stays in the transcript and renders
    // read-only afterwards with an accepted / rejected pill.
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: (s.transcripts[sessionId] ?? []).map((p) =>
          p.kind === "plan_accept_request" && p.planId === planId
            ? { ...p, decision }
            : p,
        ),
      },
    }));
    get().ws?.send({
      type: "plan_accept_decision",
      sessionId,
      planId,
      decision,
    } satisfies ClientFrame);
    // Re-arm a pending placeholder so the next assistant turn isn't silent.
    const pendingId = `pending-${Date.now()}`;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    armStallTimer(sessionId, pendingId);
  },

  forgetSession(id) {
    clearStallTimer(id);
    set((s) => {
      const { [id]: _gone, ...rest } = s.transcripts;
      const { [id]: _meta, ...restMeta } = s.transcriptMeta;
      void _gone;
      void _meta;
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        transcripts: rest,
        transcriptMeta: restMeta,
      };
    });
  },
  };
});

// ---------------------------------------------------------------------------
// Subagent run aggregation (s-17)
//
// The rail surfaces one row per subagent task_id. Each row carries the
// latest description ("activeForm"), cumulative usage, status, and a
// chronological stream of the child's text chunks + nested tool_use /
// tool_result pairs — anything whose `parentToolUseId` matches this
// run's parent tool_use id.
//
// Built by walking the session's UIPiece[] twice:
//   1. First pass seeds a `SubagentRun` per `subagent_start` piece
//      (taskId → run). `subagent_progress` / `subagent_update` mutate
//      the latest description and status. `subagent_end` flips status
//      to the terminal value and fills summary/outputFile.
//   2. Second pass gathers every text / thinking / tool_use / tool_result
//      piece whose `parentToolUseId` matches one of the run's parent
//      ids, pushing them into that run's `stream` in original order.
//
// Memoization: the selector pattern below caches per (sessionId,
// transcript-array-reference). Since the transcript array is replaced
// immutably on every update, a simple reference-identity cache is
// enough — no deep compare.
// ---------------------------------------------------------------------------

export interface SubagentStreamEvent {
  /** Ordering key — the UIPiece's `seq`, or a fallback if missing. */
  seq: number;
  piece: UIPiece;
}

export interface SubagentRun {
  taskId: string;
  parentToolUseId: string | null;
  description: string;
  status: SubagentLifecycleStatus;
  agentType: string | null;
  taskType: string | null;
  workflowName: string | null;
  prompt: string | null;
  isBackgrounded: boolean;
  startedAt: string;
  endedAt: string | null;
  lastToolName: string | null;
  usage: SubagentUsage;
  summary: string | null;
  outputFile: string | null;
  error: string | null;
  /** Ordered child events (nested tool chips, text chunks, thinking). */
  stream: SubagentStreamEvent[];
  /** Liveness hint for the rail ticker — last time we saw any update
   * (progress tick, tool_progress heartbeat, nested child message). */
  lastActivityAt: string;
}

interface RunCacheEntry {
  transcript: UIPiece[];
  runs: SubagentRun[];
}
const runCache = new WeakMap<UIPiece[], RunCacheEntry>();

export function computeSubagentRuns(pieces: UIPiece[]): SubagentRun[] {
  const cached = runCache.get(pieces);
  if (cached && cached.transcript === pieces) return cached.runs;
  const byTaskId = new Map<string, SubagentRun>();
  const byParentToolUseId = new Map<string, SubagentRun>();
  // Pre-pass: index parent Task/Agent/Explore tool_use pieces by their
  // id so we can read `subagent_type` out of the input payload when
  // building the run (the SDK's task_started gives us an opaque
  // task_type like "local_agent" which isn't human-friendly; the user
  // names the subagent via the Task tool's `subagent_type` field).
  const parentToolUses = new Map<
    string,
    Extract<UIPiece, { kind: "tool_use" }>
  >();
  for (const p of pieces) {
    if (p.kind === "tool_use" && SUBAGENT_PARENT_TOOLS.has(p.name)) {
      parentToolUses.set(p.id, p);
    }
  }
  // First pass — seed runs from `subagent_start` and apply subsequent
  // lifecycle pieces. Runs whose task_type is a backgrounded bash
  // command (async SDK bookkeeping, not a real subagent) are skipped
  // entirely: they'd render with an empty stream + garble the panel.
  for (const piece of pieces) {
    if (piece.kind === "subagent_start") {
      if (isAsyncBashTask(piece.taskType)) continue;
      const parent = piece.parentToolUseId
        ? parentToolUses.get(piece.parentToolUseId)
        : undefined;
      const subagentTypeFromInput = parent
        ? extractSubagentType(parent.input)
        : null;
      const run: SubagentRun = {
        taskId: piece.taskId,
        parentToolUseId: piece.parentToolUseId,
        description: piece.description,
        status: "running",
        agentType: subagentTypeFromInput ?? piece.agentType ?? null,
        taskType: piece.taskType ?? null,
        workflowName: piece.workflowName ?? null,
        prompt: piece.prompt ?? null,
        isBackgrounded: piece.isBackgrounded ?? false,
        startedAt: piece.at,
        endedAt: null,
        lastToolName: null,
        usage: {},
        summary: null,
        outputFile: null,
        error: null,
        stream: [],
        lastActivityAt: piece.at,
      };
      byTaskId.set(piece.taskId, run);
      if (piece.parentToolUseId) byParentToolUseId.set(piece.parentToolUseId, run);
      continue;
    }
    if (piece.kind === "subagent_progress") {
      const run = byTaskId.get(piece.taskId);
      if (!run) continue;
      run.description = piece.description || run.description;
      if (piece.lastToolName) run.lastToolName = piece.lastToolName;
      if (piece.summary) run.summary = piece.summary;
      run.usage = { ...run.usage, ...piece.usage };
      run.lastActivityAt = piece.at;
      continue;
    }
    if (piece.kind === "subagent_update") {
      const run = byTaskId.get(piece.taskId);
      if (!run) continue;
      const patch = piece.patch;
      if (typeof patch.status === "string" && isLifecycleStatus(patch.status)) {
        run.status = patch.status as SubagentLifecycleStatus;
      }
      if (typeof patch.description === "string") {
        run.description = patch.description;
      }
      if (typeof patch.isBackgrounded === "boolean") {
        run.isBackgrounded = patch.isBackgrounded;
      }
      if (typeof patch.error === "string") run.error = patch.error;
      run.lastActivityAt = piece.at;
      continue;
    }
    if (piece.kind === "subagent_end") {
      const run = byTaskId.get(piece.taskId);
      if (!run) continue;
      run.status = piece.status;
      run.endedAt = piece.at;
      run.summary = piece.summary || run.summary;
      if (piece.outputFile) run.outputFile = piece.outputFile;
      if (piece.usage) run.usage = { ...run.usage, ...piece.usage };
      run.lastActivityAt = piece.at;
      continue;
    }
    if (piece.kind === "subagent_tool_progress") {
      const key = piece.parentToolUseId ?? "";
      const run = key ? byParentToolUseId.get(key) : undefined;
      if (!run) continue;
      run.lastActivityAt = piece.at;
      run.lastToolName = piece.toolName;
      continue;
    }
  }
  // Second pass — attach nested child pieces to their run via
  // parentToolUseId. `parentToolUseId` on a tool_use points at the parent
  // Task/Agent/Explore tool_use; we seeded a run's parent pointer from
  // `subagent_start.parentToolUseId`. Same pointer — same group.
  for (const piece of pieces) {
    let parent: string | undefined;
    if (
      piece.kind === "assistant_text" ||
      piece.kind === "thinking" ||
      piece.kind === "tool_use" ||
      piece.kind === "tool_result"
    ) {
      if (typeof piece.parentToolUseId === "string") {
        parent = piece.parentToolUseId;
      }
    }
    if (!parent) continue;
    const run = byParentToolUseId.get(parent);
    if (!run) continue;
    const seq =
      "seq" in piece && typeof piece.seq === "number"
        ? piece.seq
        : Number.MAX_SAFE_INTEGER;
    run.stream.push({ seq, piece });
    if ("createdAt" in piece && typeof piece.createdAt === "string") {
      run.lastActivityAt = piece.createdAt;
    }
  }
  // Third pass — LEGACY SYNTHESIS. For every Task/Agent/Explore
  // `tool_use` piece that didn't land on a `subagent_start` event
  // (recorded before Phase 1 shipped the new SDK options, or against
  // an older SDK that doesn't emit task_* events), fabricate a
  // SubagentRun so the panel is the canonical subagents surface — no
  // more "some runs live in TasksList's Subagents group, others here"
  // split-brain. Stream is empty (no data was captured), but the
  // matching `tool_result` gives us a summary + status.
  const resultsByToolUseId = new Map<
    string,
    Extract<UIPiece, { kind: "tool_result" }>
  >();
  for (const p of pieces) {
    if (p.kind === "tool_result") resultsByToolUseId.set(p.toolUseId, p);
  }
  for (const p of pieces) {
    if (p.kind !== "tool_use") continue;
    if (!SUBAGENT_PARENT_TOOLS.has(p.name)) continue;
    if (byParentToolUseId.has(p.id)) continue; // already handled above
    const res = resultsByToolUseId.get(p.id);
    let status: SubagentLifecycleStatus = "running";
    let endedAt: string | null = null;
    let summary: string | null = null;
    if (res) {
      status = res.isError ? "failed" : "completed";
      endedAt = res.createdAt ?? null;
      summary = res.content;
    }
    const input = p.input as Record<string, unknown>;
    const description = pickInputString(
      input,
      "description",
      "title",
      "subagent_type",
      "prompt",
      "task",
    );
    const synthetic: SubagentRun = {
      taskId: `legacy-${p.id}`,
      parentToolUseId: p.id,
      description: description ?? p.name,
      status,
      agentType: extractSubagentType(input),
      taskType: null,
      workflowName: null,
      prompt: pickInputString(input, "prompt") ?? null,
      isBackgrounded: false,
      // Prefer the tool_use's own createdAt; otherwise fall through to
      // the tool_result's createdAt (so a legacy run from a live session
      // doesn't render with a bogus 1970-epoch stamp just because the
      // live `tool_use` frame didn't carry a createdAt before server
      // ack). Only fall through to `new Date()` when neither is set —
      // that's the "we really don't know" branch, and using "now" means
      // timeAgoShort renders "now" instead of the confusing epoch date.
      startedAt: p.createdAt ?? endedAt ?? new Date().toISOString(),
      endedAt,
      lastToolName: null,
      usage: {},
      summary,
      outputFile: null,
      error: null,
      stream: [],
      lastActivityAt:
        endedAt ?? p.createdAt ?? new Date().toISOString(),
    };
    byTaskId.set(synthetic.taskId, synthetic);
  }
  // Sort each run's stream by seq — the first pass preserves insertion
  // order but a refetched transcript may have interleaved live + history.
  for (const run of byTaskId.values()) {
    run.stream.sort((a, b) => a.seq - b.seq);
  }
  const runs = Array.from(byTaskId.values()).sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
  );
  runCache.set(pieces, { transcript: pieces, runs });
  return runs;
}

/** Tools on the parent session whose tool_use launches a subagent run.
 * Mirror of `SUBAGENT_TOOL_NAMES` in `server/src/agents/routes.ts` — kept
 * in sync by convention; adding one here without updating the server
 * means /api/agents won't pick up the new tool. */
export const SUBAGENT_PARENT_TOOLS = new Set(["Task", "Agent", "Explore"]);

/** SDK `task_type` values that are NOT real subagents — async bash
 * bookkeeping, mostly. Filtered out of the panel since they have no
 * nested transcript and the user doesn't think of them as "subagents". */
function isAsyncBashTask(taskType: string | undefined | null): boolean {
  return taskType === "bash" || taskType === "local_bash";
}

/** Human-readable subagent type from a Task/Agent/Explore tool_use input.
 * The SDK lets users write `subagent_type: "code-explorer"` etc — that's
 * what shows on the row as "code-explorer" (not the SDK-internal
 * "local_agent"). Falls back through common field name synonyms. */
function extractSubagentType(input: Record<string, unknown>): string | null {
  const v =
    pickInputString(input, "subagent_type") ??
    pickInputString(input, "agent_type");
  return v;
}

function pickInputString(
  input: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
  }
  return null;
}

/** Hook-friendly selector — memoized per transcript array reference. */
export function useSubagentRuns(sessionId: string): SubagentRun[] {
  return useSessions((s) => {
    const pieces = s.transcripts[sessionId];
    if (!pieces) return EMPTY_RUNS;
    return computeSubagentRuns(pieces);
  });
}

const EMPTY_RUNS: SubagentRun[] = [];
