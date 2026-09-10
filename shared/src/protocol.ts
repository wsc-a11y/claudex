import { z } from "zod";
import {
  AskUserQuestionAnnotation,
  AskUserQuestionItem,
  CompactBoundaryPayload,
  CompactStatusPayload,
  CompactSummaryPayload,
  PermissionMode,
  SessionStatus,
  SubagentEndPayload,
  SubagentLifecycleStatus,
  SubagentProgressPayload,
  SubagentStartPayload,
  SubagentToolProgressPayload,
  SubagentUpdatePayload,
  SubagentUsage,
} from "./models.js";

// ============================================================================
// WebSocket protocol
//
// A single WS connection carries events for any number of sessions. Every
// frame is one of these discriminated union variants. The client subscribes
// to sessions explicitly; the server pushes events only for subscribed ids.
// ============================================================================

// ---------- Client → Server ----------

export const ClientHello = z.object({
  type: z.literal("hello"),
  // last seq the client has already seen per session, for resume on reconnect
  resume: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

export const ClientSubscribe = z.object({
  type: z.literal("subscribe"),
  sessionId: z.string(),
});

export const ClientUnsubscribe = z.object({
  type: z.literal("unsubscribe"),
  sessionId: z.string(),
});

export const ClientUserMessage = z.object({
  type: z.literal("user_message"),
  sessionId: z.string(),
  content: z.string(),
  // Optional list of attachment ids (from `POST /api/sessions/:id/attachments`)
  // that should be linked to this user_message. On receipt, SessionManager
  // stamps each row's `message_event_seq` with the seq of the user_message
  // event it just appended, and prefixes the outgoing SDK prompt with
  // `@<absolute-path>` tokens so the SDK's Read tool can pick the files up.
  attachmentIds: z.array(z.string()).optional(),
  // Opaque nonce the client generates per-send so the originating tab can
  // match the server's echoed `user_message` broadcast back to its local
  // optimistic piece without relying on the fragile text+3s-timestamp
  // heuristic. The server relays this value back verbatim; other tabs have
  // no local piece with this echoId and simply insert the broadcast as a
  // fresh piece (their match falls back to the legacy heuristic or nothing).
  // Omitted by legacy clients; server tolerates absence.
  echoId: z.string().optional(),
});

export const ClientInterrupt = z.object({
  type: z.literal("interrupt"),
  sessionId: z.string(),
});

export const ClientPermissionDecision = z.object({
  type: z.literal("permission_decision"),
  sessionId: z.string(),
  approvalId: z.string(),
  decision: z.enum(["allow_once", "allow_always", "deny"]),
});

// User-submitted answers for an `AskUserQuestion` tool call. Routed to
// `SessionManager.resolveAskUserQuestion`, which resolves the corresponding
// `canUseTool` promise with `{ behavior: "allow", updatedInput: { answers,
// annotations? } }` (matching the SDK's `AskUserQuestionOutput`).
export const ClientAskUserAnswer = z.object({
  type: z.literal("ask_user_answer"),
  sessionId: z.string(),
  askId: z.string(),
  answers: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), AskUserQuestionAnnotation).optional(),
});

// Accept / reject decision on an `ExitPlanMode` tool call. Routed to
// `SessionManager.resolvePlanAccept`, which resolves the corresponding
// `canUseTool` promise with `{ behavior: "allow" }` on accept or
// `{ behavior: "deny", message: "plan not accepted — please revise" }` on
// reject. The SDK treats a deny as a tool error that the model can recover
// from by regenerating the plan; accept lets the model proceed with the
// planned actions (the SDK transitions out of `plan` permission mode on
// its own).
export const ClientPlanAcceptDecision = z.object({
  type: z.literal("plan_accept_decision"),
  sessionId: z.string(),
  planId: z.string(),
  decision: z.enum(["accept", "reject"]),
});

export const ClientFrame = z.discriminatedUnion("type", [
  ClientHello,
  ClientSubscribe,
  ClientUnsubscribe,
  ClientUserMessage,
  ClientInterrupt,
  ClientPermissionDecision,
  ClientAskUserAnswer,
  ClientPlanAcceptDecision,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---------- Server → Client ----------

export const ServerHelloAck = z.object({
  type: z.literal("hello_ack"),
  serverVersion: z.string(),
});

export const ServerSessionUpdate = z.object({
  type: z.literal("session_update"),
  sessionId: z.string(),
  status: SessionStatus,
  mode: PermissionMode.optional(),
  title: z.string().optional(),
  lastMessageAt: z.string().nullable().optional(),
});

export const ServerAssistantTextDelta = z.object({
  type: z.literal("assistant_text_delta"),
  sessionId: z.string(),
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  // Set when this text chunk came from a subagent (child turn spawned by
  // a Task/Agent/Explore tool on the parent). Links back to the parent's
  // `tool_use.toolUseId`; undefined on main-thread text. See s-17 rail —
  // the web store groups these under the matching SubagentRun for the
  // live-stream timeline.
  parentToolUseId: z.string().optional(),
});

export const ServerAssistantTextEnd = z.object({
  type: z.literal("assistant_text_end"),
  sessionId: z.string(),
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
});

export const ServerThinking = z.object({
  type: z.literal("thinking"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  /** Same semantics as `ServerAssistantTextDelta.parentToolUseId`. */
  parentToolUseId: z.string().optional(),
});

export const ServerToolUse = z.object({
  type: z.literal("tool_use"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  toolUseId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** Same semantics as `ServerAssistantTextDelta.parentToolUseId` — set
   * when this tool_use fired from inside a subagent's turn. */
  parentToolUseId: z.string().optional(),
});

export const ServerToolResult = z.object({
  type: z.literal("tool_result"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().default(false),
  // Set when the WS mapper clipped `content` to the per-frame size budget
  // (see `TOOL_RESULT_WS_LIMIT` in `server/src/transport/ws.ts`). The full
  // payload is still persisted in `session_events` — clients can refetch
  // via `GET /api/sessions/:id/events` to see the untruncated content.
  truncated: z.boolean().optional(),
  /** Same semantics as `ServerAssistantTextDelta.parentToolUseId`. */
  parentToolUseId: z.string().optional(),
});

export const ServerPermissionRequest = z.object({
  type: z.literal("permission_request"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  approvalId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  summary: z.string(),
  blastRadius: z.string().nullable(),
});

// Broadcast when the SDK's `AskUserQuestion` tool fires. The client renders an
// in-transcript multiple-choice card (see `AskUserQuestionCard`) and replies
// with a `ClientAskUserAnswer` frame once the user submits. `askId` is the
// SDK `toolUseID` — we reuse it as the correlation id.
export const ServerAskUserQuestion = z.object({
  type: z.literal("ask_user_question"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  askId: z.string(),
  questions: z.array(AskUserQuestionItem),
});

// Broadcast when the SDK's `ExitPlanMode` tool fires. Distinct from
// `permission_request` because it is not a security gate — it's the model
// signalling "I've sketched a plan, ready to execute?". The client renders a
// dedicated klein-wash card with the plan rendered as markdown plus
// Accept/Reject buttons, and replies with a `ClientPlanAcceptDecision` frame.
// `planId` is the SDK `toolUseID` — we reuse it as the correlation id.
export const ServerPlanAcceptRequest = z.object({
  type: z.literal("plan_accept_request"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  planId: z.string(),
  plan: z.string(),
});

export const ServerTurnEnd = z.object({
  type: z.literal("turn_end"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  stopReason: z.string(),
});

// Broadcast when a user message lands in a session — including the tab that
// sent it. Other tabs subscribed to the same session use this to surface
// the message immediately, instead of waiting until `turn_end` to refresh.
// The originating tab uses `content` + `createdAt` to reconcile its local
// optimistic echo (see web/src/state/sessions.ts for the de-dupe rule).
export const ServerUserMessage = z.object({
  type: z.literal("user_message"),
  sessionId: z.string(),
  content: z.string(),
  createdAt: z.string(),
  // Relayed verbatim from the originating `ClientUserMessage.echoId`. The
  // originating tab matches its optimistic piece against this nonce instead
  // of the legacy text+3s heuristic. Other tabs won't have a local piece
  // with a matching echoId and insert a fresh piece. Undefined for messages
  // sent by legacy clients that didn't supply an echoId.
  echoId: z.string().optional(),
  // Shallow attachment metadata for the linked files, when the originating
  // send carried `attachmentIds`. Lets every subscribed tab (including the
  // sender) render image thumbs / filename chips on the live send path —
  // the same shape we persist inside the user_message event payload, so
  // the web store can flow it straight onto the reconciled piece.
  attachments: z
    .array(
      z.object({
        id: z.string(),
        filename: z.string(),
        mime: z.string(),
        size: z.number(),
      }),
    )
    .optional(),
});

// Broadcast when the queued_prompts table changes in any way (create, patch,
// delete, reorder, or runner-driven status transitions). Payload-free beyond
// a server-side timestamp — clients refetch `/api/queue` to reconcile. This
// replaces the 5s poll on the Queue screen; any authenticated tab receives
// it via the global channel (see ws.ts GLOBAL_FRAME_TYPES).
export const ServerQueueUpdate = z.object({
  type: z.literal("queue_update"),
  at: z.string(),
});

// Global-channel ping telling every authenticated tab that the alerts list
// has changed (a new alert landed, an existing alert was marked seen, or an
// alert auto-resolved because the underlying session left `awaiting` /
// `error`). Clients call `GET /api/alerts` to reconcile. We don't ship the
// row inline because the alerts list is bounded and one extra REST round-
// trip is cheaper than keeping a cross-tab snapshot in sync.
export const ServerAlertsUpdate = z.object({
  type: z.literal("alerts_update"),
  at: z.string(),
});

// Broadcast when the server has appended events to a session out-of-band —
// notably the CLI-JSONL resync-on-open path, which discovers new CLI turns
// and streams them into `session_events` without going through the live
// runner. The web client handles this by refetching the tail
// (`/events?limit=200`) and merging with any lazily-loaded older pages.
// Intentionally payload-free beyond the session id — the client's existing
// fetch path is simpler to drive than a per-event replay channel.
export const ServerRefreshTranscript = z.object({
  type: z.literal("refresh_transcript"),
  sessionId: z.string(),
});

export const ServerError = z.object({
  type: z.literal("error"),
  sessionId: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

// Point-to-point reply to a `ClientInterrupt` frame, sent only to the
// originating connection (not broadcast — other tabs don't care that you
// pressed stop). `ok: false` carries a machine-readable reason so the
// originating tab can explain WHY the stop didn't happen instead of
// silently doing nothing:
//   - `held_externally` — the session row is `cli_running`: a live external
//     claude (VSCode / terminal) owns the transcript; claudex has no runner
//     attached and cannot reach that process. Tell the user to stop there.
//   - `no_runner` — no runner attached and the row isn't cli_running either
//     (idle session, or the scanner hasn't promoted it yet). Nothing to stop.
//   - `interrupt_failed` — a runner existed but the SDK interrupt threw.
export const ServerInterruptResult = z.object({
  type: z.literal("interrupt_result"),
  sessionId: z.string(),
  ok: z.boolean(),
  reason: z
    .enum(["held_externally", "no_runner", "interrupt_failed"])
    .optional(),
});

// ---- Subagent live stream (s-17) ----------------------------------------
//
// Mirror the SubagentStartPayload / … shapes from `models.ts` so the server
// emits exactly what the web store groups into a `SubagentRun[]`. `seq`
// piggybacks on the underlying `session_events` row (same scheme as the
// other session-scoped frames); these frames route through the ordinary
// subscriber bucket for their parent session, not the global channel —
// subagent events belong to a specific session's live stream.
//
// We re-export the models' payload schemas as the frames' field shapes
// instead of re-declaring them to keep the server → wire → web contract
// byte-identical.

export const ServerSubagentStart = SubagentStartPayload.extend({
  type: z.literal("subagent_start"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
});

export const ServerSubagentProgress = SubagentProgressPayload.extend({
  type: z.literal("subagent_progress"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
});

export const ServerSubagentUpdate = SubagentUpdatePayload.extend({
  type: z.literal("subagent_update"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
});

export const ServerSubagentEnd = SubagentEndPayload.extend({
  type: z.literal("subagent_end"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
});

export const ServerSubagentToolProgress = SubagentToolProgressPayload.extend({
  type: z.literal("subagent_tool_progress"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
});

// SDK conversation compaction lifecycle.
//
// `compact_status` is a transient ping (no `seq`) that flips a per-session UI
// flag in the web store: when phase="start" the header pill shows
// "Compacting…"; when phase="end" the flag clears and the optional `result` /
// `error` get surfaced. We don't persist this — the boundary event below
// carries the durable record.
//
// `compact_boundary` is the persisted divider. Each boundary is a
// `session_events` row; the chat transcript renders it as a horizontal rule
// with pre→post token counts and the trigger (manual / auto). `seq` rides on
// the persisted event so reload + lazy paging stay consistent.
export const ServerCompactStatus = CompactStatusPayload.extend({
  type: z.literal("compact_status"),
  sessionId: z.string(),
});

export const ServerCompactBoundary = CompactBoundaryPayload.extend({
  type: z.literal("compact_boundary"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
});

// Persisted body of the SDK's compaction summary. Arrives a few seconds after
// the matching `compact_boundary` because the SDK only writes it to its own
// transcript JSONL; runner tails the file and emits this once. `boundaryAt`
// matches the boundary's `at` so the UI can fold it under the right divider.
export const ServerCompactSummary = CompactSummaryPayload.extend({
  type: z.literal("compact_summary"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
});

export const ServerFrame = z.discriminatedUnion("type", [
  ServerHelloAck,
  ServerSessionUpdate,
  ServerAssistantTextDelta,
  ServerAssistantTextEnd,
  ServerThinking,
  ServerToolUse,
  ServerToolResult,
  ServerPermissionRequest,
  ServerAskUserQuestion,
  ServerPlanAcceptRequest,
  ServerTurnEnd,
  ServerUserMessage,
  ServerRefreshTranscript,
  ServerQueueUpdate,
  ServerAlertsUpdate,
  ServerError,
  ServerInterruptResult,
  ServerSubagentStart,
  ServerSubagentProgress,
  ServerSubagentUpdate,
  ServerSubagentEnd,
  ServerSubagentToolProgress,
  ServerCompactStatus,
  ServerCompactBoundary,
  ServerCompactSummary,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
