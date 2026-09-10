import type { EventEmitter } from "node:events";
import type { RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionAnnotation,
  AskUserQuestionItem,
  CompactBoundaryPayload,
  CompactStatusPayload,
  CompactSummaryPayload,
  EffortLevel,
  ModelId,
  PermissionMode,
  SubagentEndPayload,
  SubagentLifecycleStatus,
  SubagentProgressPayload,
  SubagentStartPayload,
  SubagentToolProgressPayload,
  SubagentUpdatePayload,
} from "@claudex/shared";

// -----------------------------------------------------------------------------
// Runner abstraction
//
// The server holds one Runner per active session. A Runner is responsible for:
//   • spawning and managing the claude subprocess (via the Agent SDK)
//   • accepting user messages and forwarding them
//   • emitting RunnerEvent to anyone listening (the transport layer)
//   • surfacing permission requests as awaitable promises
//
// Concrete implementation lives in `agent-runner.ts`. This file is the
// contract the transport + tests pin against, so the SDK wrapper can
// evolve without ripple effects.
// -----------------------------------------------------------------------------

export interface RunnerInitOptions {
  sessionId: string;
  cwd: string;
  model: ModelId;
  permissionMode: PermissionMode;
  // Thinking-effort level. Defaults to "medium" in the AgentRunner when
  // omitted — "medium" preserves the existing adaptive-thinking behavior.
  effort?: EffortLevel;
  // Persisted SDK session id (for resume across turns). Undefined on first run.
  resumeSdkSessionId?: string;
  // Whether CLAUDE.md / settings files should be loaded. Default true.
  useProjectSettings?: boolean;
  /**
   * Optional claudex-global output language override (e.g. "chinese",
   * "japanese"). When non-empty the runner appends "Please respond in
   * <lang>." to the Claude Code system preset. `null` / `undefined` → no
   * override (defer to Claude Code's own `~/.claude/settings.json` via the
   * SDK's default `settingSources`).
   *
   * Sourced from `AppSettingsStore` in `SessionManager.getOrCreate`; read
   * once at session start and baked into the SDK's `systemPrompt`. Changes
   * made after a session starts only affect *future* sessions.
   */
  language?: string | null;
  /**
   * Optional API base URL override (ANTHROPIC_BASE_URL). When set, the runner
   * passes it as an env var to the Claude Code subprocess so that API requests
   * are routed through the user's proxy. Sourced from the custom model's
   * `baseUrl` field.
   */
  baseUrl?: string;
  /**
   * Optional API key override (ANTHROPIC_API_KEY). When set, the runner
   * passes it as an env var to the Claude Code subprocess. Sourced from the
   * custom model's `apiKey` field.
   */
  apiKey?: string;
  // Optional pino-shaped logger for diagnostic breadcrumbs (e.g. raw SDK
  // usage on every turn_end). When absent the runner stays silent — tests
  // don't need to thread a logger through.
  logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export type RunnerEvent =
  // `starting` / `terminated` are runner-lifecycle values; the WS bridge
  // maps them to `running` / `idle` respectively. `awaiting` and `error`
  // are never emitted by the AgentRunner itself — the SessionManager
  // synthesizes them via `broadcastStatus` when the DB row flips to
  // those states (e.g. pending permission / ask_user_question /
  // plan_accept_request, or a watchdog-forced error) so subscribed tabs
  // see the session's status dot change without waiting for the next
  // runner event.
  | {
      type: "status";
      status:
        | "starting"
        | "running"
        | "idle"
        | "terminated"
        | "awaiting"
        | "error"
        // Manager-synthesized from the CLI process scanner
        // (server/src/cli-sync/process-scanner.ts). Flips idle sessions that
        // have a live external `claude` CLI process attached. Never emitted
        // by the AgentRunner.
        | "cli_running";
      /** Optional title override, carried on the `session_update` frame the
       *  bridge emits. Lets an out-of-band renamer (the CLI title resync)
       *  push a new title to every tab's session list without inventing a
       *  second frame type — `status` is already the sole carrier of
       *  `session_update`. Omitted on ordinary status transitions, where
       *  the client keeps the title it already has. */
      title?: string;
    }
  | { type: "sdk_session_id"; sdkSessionId: string }
  | {
      type: "assistant_text";
      messageId: string;
      text: string;
      done: boolean;
      /** Non-null when this text chunk came from a subagent's turn (SDK
       * `SDKAssistantMessage.parent_tool_use_id`). The WS bridge + store
       * thread it through so the s-17 rail can group by `parentToolUseId`
       * into a live stream per subagent. */
      parentToolUseId?: string;
    }
  | { type: "thinking"; text: string; parentToolUseId?: string }
  | {
      type: "tool_use";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
      parentToolUseId?: string;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
      parentToolUseId?: string;
    }
  | {
      type: "permission_request";
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      title: string;
    }
  // SDK's built-in `AskUserQuestion` tool — NOT a permission ask. Surfaces a
  // multiple-choice interaction the model wants the user to answer before it
  // continues. We resolve the corresponding `canUseTool` promise via
  // `resolveAskUserQuestion` with the user's selections as `updatedInput`.
  | {
      type: "ask_user_question";
      askId: string;
      questions: AskUserQuestionItem[];
    }
  // SDK's built-in `ExitPlanMode` tool — NOT a permission ask either. The
  // model calls it after a planning pass to signal "I've sketched the plan,
  // ready to execute?". We resolve the `canUseTool` promise via
  // `resolvePlanAccept`: accept → `{behavior: "allow"}`, reject →
  // `{behavior: "deny", message: ...}` (the model sees a tool error and can
  // regenerate the plan). `plan` is the markdown text the SDK delivered in
  // the tool_use input payload.
  | {
      type: "plan_accept_request";
      planId: string;
      plan: string;
    }
  | {
      type: "turn_end";
      stopReason: string;
      // Per-call usage from the FINAL underlying API call of this turn —
      // sourced from the SDK's last `assistant` message (`message.usage`),
      // not from the `result` aggregate. This is what the context-window
      // ring needs: `inputTokens + cacheReadInputTokens +
      // cacheCreationInputTokens` is the size of the prompt the model
      // actually saw on its last sub-call. The SDK's `result.usage` sums
      // every sub-call's cache_read, which double-counts the warm prefix
      // across tool-use loops and pushes the ring above 100% on long
      // turns. See `billingUsage` below for the cumulative number.
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
      // Cumulative usage across every API sub-call the SDK made during
      // this turn (i.e. the original `result.usage`). Drives the
      // session-level "Tokens · this session" totals and the per-day /
      // per-range billing rollups, where summing the per-call cache reads
      // gives an accurate billing breakdown. Absent when the SDK didn't
      // surface a `result.usage` (extremely rare) — consumers should
      // fall back to `usage`.
      billingUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
    }
  // Manager-synthesized (not emitted by the Agent SDK). Broadcast when a
  // user message lands in the session so every subscribed tab sees it
  // right away. The originating tab gets it too and reconciles it
  // against its local optimistic echo. `echoId` is an opaque nonce the
  // originating tab attached to its `ClientUserMessage` — relayed
  // verbatim so the sender can match its optimistic piece without the
  // legacy text+3s heuristic. Undefined for messages from legacy clients.
  | {
      type: "user_message";
      text: string;
      at: string;
      echoId?: string;
      // Shallow metadata for each attachment linked to this user_message,
      // if any. Lets the web transcript render image thumbs / filename
      // chips inline with the user bubble on the live send path — without
      // this, only a full page reload (which goes through the REST events
      // endpoint and reads the persisted payload) would paint attachments.
      // Shape mirrors the persisted `user_message` payload's `attachments`.
      attachments?: Array<{
        id: string;
        filename: string;
        mime: string;
        size: number;
      }>;
    }
  // Manager-synthesized. Fired when the server has appended events to a
  // session out-of-band (e.g. the CLI JSONL resync path) — the client
  // refetches the transcript tail rather than us re-streaming each event.
  | { type: "refresh_transcript" }
  // Manager-synthesized. Fired when the queued_prompts table changes in any
  // way (create, patch, delete, move, runner status transition). Not tied
  // to a specific session — the WS layer routes it through the global
  // channel so every authenticated tab's Queue screen can refetch.
  | { type: "queue_update"; at: string }
  // Alerts list changed (new row, seen/resolved/dismissed, or auto-resolved
  // by a session status transition). Cross-session by design — routed
  // through the global WS channel just like queue_update.
  | { type: "alerts_update"; at: string }
  // --------------------------------------------------------------------
  // Live subagents (s-17). Each `task_*` SDK message maps to one of
  // these. Shapes mirror the shared `Subagent*Payload` schemas verbatim
  // so the runner → WS bridge is a pass-through; persist rides the
  // ordinary append-to-`session_events` pipeline in manager.ts using the
  // five new EventKinds.
  // --------------------------------------------------------------------
  | ({ type: "subagent_start" } & SubagentStartPayload)
  | ({ type: "subagent_progress" } & SubagentProgressPayload)
  | ({ type: "subagent_update" } & SubagentUpdatePayload)
  | ({ type: "subagent_end" } & SubagentEndPayload)
  | ({ type: "subagent_tool_progress" } & SubagentToolProgressPayload)
  // ----------------------------------------------------------------------
  // Conversation compaction. The Agent SDK emits two distinct system
  // messages around `/compact` (manual) or auto-compaction:
  //   `system/status` with `status: "compacting"` (start) and
  //   `status: null` + `compact_result: "success"|"failed"` (end), and
  //   `system/compact_boundary` carrying the actual `compact_metadata`.
  // We translate them into a transient `compact_status` event (UI hint
  // only — drives the "Compacting…" header pill) and a persisted
  // `compact_boundary` event (rendered as a divider in the transcript).
  // ----------------------------------------------------------------------
  | ({ type: "compact_status" } & CompactStatusPayload)
  | ({ type: "compact_boundary" } & CompactBoundaryPayload)
  // The SDK writes the post-compaction summary as an `isCompactSummary` user
  // line in its transcript JSONL with `isVisibleInTranscriptOnly: true`, so
  // it never reaches us through the streamed SDKMessage interface. The runner
  // tails the JSONL after each `compact_boundary`, extracts the text, and
  // emits this event once. Manager persists it as a `compact_summary` row
  // tagged by `boundaryAt` so reload + lazy paging can still rejoin it with
  // the right divider piece.
  | ({ type: "compact_summary" } & CompactSummaryPayload)
  | { type: "error"; code: string; message: string };

export type RunnerListener = (event: RunnerEvent) => void;

export interface PermissionDecision {
  behavior: "allow" | "deny";
  reason?: string;
}

export interface Runner {
  readonly sessionId: string;
  readonly sdkSessionId: string | null;
  start(initialPrompt?: string): Promise<void>;
  sendUserMessage(content: string): Promise<void>;
  resolvePermission(toolUseId: string, decision: PermissionDecision): void;
  // Resolve a pending AskUserQuestion interaction with the user's answers.
  // Mirror of `resolvePermission`: no-op when the askId is unknown (double
  // submit / stale client). The runner resolves the SDK `canUseTool` promise
  // with `{ behavior: "allow", updatedInput: { answers, annotations? } }`.
  resolveAskUserQuestion(
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ): void;
  // Resolve a pending `ExitPlanMode` interaction. `accept` resolves the SDK's
  // `canUseTool` with `{ behavior: "allow" }` (letting the model proceed with
  // its plan; the SDK itself handles transitioning out of `plan` mode).
  // `reject` resolves with `{ behavior: "deny", message }` — the model sees
  // a tool error and can revise the plan. No-op on unknown planId (double
  // submit / stale client).
  resolvePlanAccept(planId: string, decision: "accept" | "reject"): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  // Hot-swap the model. The Agent SDK exposes a control-request `setModel`
  // on the live `Query`; we route through it so subsequent SDK turns use
  // the new model without tearing the runner down. The runner also caches
  // the value so a future resume after restart picks the right model.
  setModel(model: ModelId): Promise<void>;
  // Hot-swap the thinking-effort level. Stored on the runner; takes effect
  // on the NEXT SDK turn (the SDK's `thinking` option is start-time only,
  // so we can't restyle an in-flight query without tearing it down).
  setEffort(effort: EffortLevel): Promise<void>;
  // Roll tracked files back to their state at a user message — the CLI's
  // checkpoint feature, forwarded to the live SDK child. Throws
  // "runner_not_started" when no SDK handle exists yet (caller falls back
  // to a resume-based rewind).
  rewindFiles(userMessageId: string, dryRun?: boolean): Promise<RewindFilesResult>;
  dispose(): Promise<void>;
  on(listener: RunnerListener): () => void;
  // For tests / diagnostics.
  listenerCount(): number;
}

export interface RunnerFactory {
  create(opts: RunnerInitOptions): Runner;
}
