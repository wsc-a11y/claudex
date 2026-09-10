import { z } from "zod";

// ============================================================================
// Core enums
// ============================================================================

export const PermissionMode = z.enum([
  "default", // ask before every tool use
  "acceptEdits", // auto-accept file edits + safe filesystem ops
  "plan", // read-only exploration
  "auto", // autonomous with server-side safety classifier
  "bypassPermissions", // no prompts — sandboxed use only
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

// Built-in Claude models shipped with claudex. Used as display defaults in
// model selectors; the actual ModelId type accepts any string so custom
// models from self-hosted proxies (OneAPI, New API, etc.) work seamlessly.
export const BUILTIN_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

// ModelId accepts any non-empty string. The three built-in Claude models are
// known to claudex (pricing, context window, effort gating), but any model id
// the user's proxy supports can be used.
export const ModelId = z.string().min(1);
export type ModelId = z.infer<typeof ModelId>;

// Thinking-effort level for a session's Claude runner. Selected in the Chat
// header like model and permission mode, and persisted on the session row
// so it survives restart / resume. Server-side the runner maps each level
// to a specific `thinking` option on the Agent SDK:
//
//   low     → thinking disabled (fastest turn, no budget)
//   medium  → adaptive thinking (current default; SDK picks the budget)
//   high    → enabled, 16000-token budget
//   xhigh   → enabled, 32000-token budget
//   max     → enabled, 63999-token budget (just under the documented ceiling)
//
// The mapping itself lives in `server/src/sessions/agent-runner.ts`.
// `medium` stays the default so sessions created before migration 23
// behave exactly like they did before the column existed.
export const EffortLevel = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type EffortLevel = z.infer<typeof EffortLevel>;

// Thinking-effort defaults / gating by model. Rule (user-stated):
//   - `xhigh` is Opus only. Other models can't use it.
//   - Default effort is the highest level the model supports:
//       opus-4-8    → xhigh
//       opus-4-7    → xhigh
//       sonnet-4-6  → high
//       haiku-4-5   → high
//       custom      → high  (let the SDK handle unsupported levels)
// Kept in `shared/` so the UI and server agree on what to offer and what
// to accept when the user swaps models on an existing session.
export function defaultEffortForModel(model: ModelId): EffortLevel {
  return model === "claude-opus-4-8" || model === "claude-opus-4-7"
    ? "xhigh"
    : "high";
}

export function effortSupportedOnModel(
  model: ModelId,
  effort: EffortLevel,
): boolean {
  // xhigh is gated to Opus for built-in models. For custom models
  // (proxied through self-hosted APIs), allow all effort levels — the
  // SDK and proxy will handle unsupported values.
  if (effort === "xhigh")
    return model === "claude-opus-4-8" || model === "claude-opus-4-7";
  return true;
}

// Clamp an effort level to what the given model supports. If the current
// level isn't available on the new model (today: `xhigh` outside Opus),
// fall back to `high` — closest neighbour that every model supports.
export function clampEffortForModel(
  model: ModelId,
  effort: EffortLevel,
): EffortLevel {
  return effortSupportedOnModel(model, effort) ? effort : "high";
}

export const SessionStatus = z.enum([
  "idle", // no turn in progress
  "running", // claude is working (driven by claudex's SDK runner)
  // An external `claude` CLI process is currently alive for this session
  // (detected via `ps` / WMI + cwd → jsonl mapping in
  // `server/src/cli-sync/process-scanner.ts`). The claudex composer is
  // LOCKED in this state — two writers on one transcript means the
  // external process keeps running while claudex's own interrupt can't
  // reach it (the "paused but still outputting" bug). The user continues
  // in the external window; when the external process exits the scanner
  // flips the row back to `idle` and claudex regains the composer. Only
  // sessions currently `idle` are eligible for promotion. Never set by
  // the SDK runner.
  "cli_running",
  "awaiting", // waiting on user (permission / input)
  "archived", // closed, read-only
  "error", // terminal error state
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// ============================================================================
// Persistence-shaped DTOs
// ============================================================================

export const Project = z.object({
  id: z.string(), // slug (e.g. "spindle")
  name: z.string(),
  path: z.string(), // absolute host path
  trusted: z.boolean(), // user confirmed trust for this folder
  createdAt: z.string(), // ISO 8601
  // Populated on the GET /api/projects list response so the NewSessionSheet
  // can pre-gate its worktree toggle without an extra probe round-trip. The
  // server fs-checks `<path>/.git` lazily at list time (dir or gitfile both
  // count). Optional because code paths that build a Project from a DB row
  // (create response, store lookups, backup import) don't do the check and
  // we don't want to cascade-async every projects.list() call site.
  isGitRepo: z.boolean().optional(),
});
export type Project = z.infer<typeof Project>;

export const Session = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  status: SessionStatus,
  model: ModelId,
  mode: PermissionMode,
  // Thinking-effort level for the Agent SDK runner. Default `medium` keeps
  // the existing adaptive-thinking behavior; other levels switch to a fixed
  // thinking budget. See `EffortLevel` above.
  effort: EffortLevel.default("medium"),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  // Agent SDK session_id captured on first system/init; persisted so we can
  // `resume` the same SDK conversation after a server restart. Null means the
  // SDK has not yet initialized for this session.
  sdkSessionId: z.string().nullable(),
  // If this session is a `/btw` side chat, the id of the main session it
  // branches off. Side chats read the parent's transcript for context on
  // first spawn but never write back into the parent's event log. Null for
  // top-level sessions. Enforced ON DELETE CASCADE so removing the parent
  // cleans up every child.
  parentSessionId: z.string().nullable(),
  // If this session was created via `POST /api/sessions/:id/fork`, the id of
  // the source session. Null for top-level / side-chat / CLI-imported
  // sessions. Surfaced in the chat header as a "Forked" badge so users know
  // the SDK side has no memory of the parent turns beyond the copied events.
  // Deliberately NOT ON DELETE CASCADE — if the source gets deleted the
  // fork should survive as a standalone conversation.
  forkedFromSessionId: z.string().nullable(),
  // Number of `claude` CLI JSONL transcript lines we've already imported into
  // this session's `session_events`. Incremented by the resync-on-open path
  // in `server/src/sessions/cli-resync.ts`. Zero when this session wasn't
  // adopted from the CLI (or when the row predates the column). Internal to
  // the server; clients can ignore it.
  cliJsonlSeq: z.number().int().nonnegative().default(0),
  // True when this row was created by adopting an existing `claude` CLI
  // session under `~/.claude/projects/<slug>/<uuid>.jsonl`. Native claudex
  // sessions — the ones spawned via the SDK from this server — stay false
  // even though the SDK also writes that JSONL. The cli-resync and
  // cli-sync-watcher paths key off this flag so they never re-import the
  // JSONL on top of a native session (which would drop `attachments` off
  // `user_message` payloads; see migrations 26/27).
  adoptedFromCli: z.boolean().default(false),
  // User-authored tags for filtering / organization. Persisted as a JSON
  // string array in SQLite (migration id=15). Tag strings must match
  // `[a-z0-9-]{1,24}` and there is a max of 8 tags per session — both rules
  // enforced at the route layer (invalid values → 400). Default `[]` for
  // rows created before the column existed.
  tags: z.array(z.string()).default([]),
  // User-authored pin flag. Pinned sessions sort to the top of the Home list
  // regardless of activity recency. Backed by migration id=16
  // (`sessions.pinned INTEGER NOT NULL DEFAULT 0`); flipped via
  // `PATCH /api/sessions/:id` with `{pinned: boolean}`. Defaults to false so
  // rows created before the column existed round-trip cleanly.
  pinned: z.boolean().default(false),
  // Single-line preview of the most recent `user_message` event's text,
  // used by the Home session list to show "what the user last said here"
  // under the title. Computed server-side via a correlated subquery on
  // `session_events` (no DB column — stays cheap thanks to
  // `idx_events_session_seq`). Truncated to 200 chars with ellipsis so we
  // never ship multi-KB prompts down to the list view. Null when the
  // session has no user message yet (fresh row, or CLI import that hasn't
  // seeded one). Web clients keep it fresh on the fly by mirroring the
  // incoming `user_message` WS frame into this field (see
  // `web/src/state/sessions.ts`).
  lastUserMessage: z.string().nullable().default(null),
  // aggregate counters, cheap to read
  stats: z.object({
    messages: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative(),
    linesAdded: z.number().int().nonnegative(),
    linesRemoved: z.number().int().nonnegative(),
    contextPct: z.number().min(0).max(1),
  }),
});
export type Session = z.infer<typeof Session>;

// A single turn event as we persist it. Subset of the SDK's stream types,
// remapped to what the UI actually renders.
export const EventKind = z.enum([
  "user_message",
  "assistant_text",
  "assistant_thinking",
  "tool_use",
  "tool_result",
  "permission_request",
  "permission_decision",
  // `AskUserQuestion` SDK tool — surfaces a multiple-choice interaction in the
  // transcript instead of a permission card. The model emits a tool call with
  // `questions[]`; we persist it as `ask_user_question` and the user's answer
  // as a sibling `ask_user_answer` event (append-only, mirroring how
  // `permission_request` pairs with `permission_decision`).
  "ask_user_question",
  "ask_user_answer",
  // SDK's built-in `ExitPlanMode` tool — emitted by the model at the end of a
  // planning pass to signal "I've sketched the steps, ready to execute?". Not
  // a security gate; renders as its own "commit to this plan?" card instead
  // of the generic permission prompt. Append-only: accept/reject lands as a
  // sibling `plan_accept_decision` event.
  "plan_accept_request",
  "plan_accept_decision",
  "turn_end",
  "error",
  // ------------------------------------------------------------------
  // Live subagents (s-17). Parent session emits these for every Task /
  // Agent / Explore tool invocation the main Claude turn dispatches. The
  // claude-agent-sdk forwards the child run's lifecycle — start, periodic
  // progress, status patches, completion — into the parent's SDKMessage
  // stream (with `forwardSubagentText: true`, also the child's text +
  // thinking + nested tool_use / tool_result blocks, correlated via
  // `parent_tool_use_id`). These kinds persist each of those events so
  // the in-session rail can replay the live stream on reload without
  // needing a separate subagent transcript channel.
  //
  //   subagent_start         — task_started (taskId, agentType, prompt, …)
  //   subagent_progress      — task_progress (AI-generated description + usage)
  //   subagent_update        — task_updated (status / is_backgrounded patch)
  //   subagent_end           — task_notification (completed / failed / stopped)
  //   subagent_tool_progress — tool_progress heartbeat (elapsed seconds)
  //
  // The nested child text / thinking / tool_use / tool_result themselves
  // still persist as their existing kinds — what distinguishes them from
  // main-thread events is a `parentToolUseId` field in the payload.
  "subagent_start",
  "subagent_progress",
  "subagent_update",
  "subagent_end",
  "subagent_tool_progress",
  // SDK's `system/compact_boundary` — emitted when the conversation has been
  // compacted (manually via `/compact` or automatically when the context fills
  // up). Persisted so the transcript can render a visible divider on reload
  // and exports can preserve the boundary. Payload mirrors the SDK's
  // `compact_metadata` minus the relink anchors (we don't replay them on the
  // claudex side; resume is handled by the SDK itself off its own JSONL).
  "compact_boundary",
  // The compact summary text the SDK writes immediately after a boundary as
  // an `isCompactSummary: true` user message in its transcript JSONL. The SDK
  // marks it `isVisibleInTranscriptOnly` and never streams it as a regular
  // SDKMessage, so we tail the JSONL after the boundary lands and emit this
  // separately. UI folds it into the preceding `compact_boundary` piece as
  // the "expand summary" body.
  "compact_summary",
]);
export type EventKind = z.infer<typeof EventKind>;

// ============================================================================
// AskUserQuestion SDK tool — shapes the wire protocol + the persisted event
// payloads.
//
// The Claude Agent SDK's built-in `AskUserQuestion` tool feeds us an input of
// this shape (see node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts
// `AskUserQuestionInput`). When the user answers, we resolve `canUseTool` with
// `{ behavior: "allow", updatedInput: { answers, annotations? } }`, matching
// the SDK's `AskUserQuestionOutput` expectation.
// ============================================================================

export const AskUserQuestionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
export type AskUserQuestionOption = z.infer<typeof AskUserQuestionOption>;

export const AskUserQuestionItem = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(AskUserQuestionOption),
});
export type AskUserQuestionItem = z.infer<typeof AskUserQuestionItem>;

export const AskUserQuestionAnnotation = z.object({
  notes: z.string().optional(),
  preview: z.string().optional(),
});
export type AskUserQuestionAnnotation = z.infer<typeof AskUserQuestionAnnotation>;

export const SessionEvent = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: EventKind,
  seq: z.number().int().nonnegative(), // ordering within a session
  createdAt: z.string(),
  // shape depends on kind; parsers in server/web narrow via kind
  payload: z.record(z.string(), z.unknown()),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

/**
 * Usage payload attached to a persisted `turn_end` SessionEvent.
 *
 * Two slots, with different semantics — keep them straight:
 *
 * - `usage` is **per-call**: the token counts from the SDK's *final*
 *   underlying API call in this turn (taken off the last `assistant`
 *   SDKMessage's `message.usage`, NOT off `result.usage`). The
 *   "context body shipped to the model" for this turn is
 *   `inputTokens + cacheReadInputTokens + cacheCreationInputTokens` of
 *   `usage`. The Usage panel's "how full is my context window" ring uses
 *   that sum, not `inputTokens` alone — otherwise every turn after the
 *   first looks like it used almost no context.
 *
 * - `billingUsage` is **cumulative** across every SDK sub-call in the
 *   turn (the original `result.usage`). Used for billing-style totals —
 *   "Tokens · this session", `/api/usage/today`, `/api/stats` — where
 *   the per-call cache reads should sum, not collapse.
 *
 * Aggregation rule everywhere: ring/context math reads `usage`; billing
 * totals read `billingUsage ?? usage` so CLI-imported sessions (which
 * only emit `usage` per-call, one turn_end per assistant record) keep
 * their existing per-call-summed semantics.
 *
 * All fields are optional on the schema because:
 *   - older persisted rows (from before the cache fields existed) don't
 *     carry the cache numbers
 *   - `billingUsage` only appears on live-runner rows from the per-call
 *     fix onward; CLI imports and pre-fix live rows omit it
 */
export const TurnEndUsage = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
});
export type TurnEndUsage = z.infer<typeof TurnEndUsage>;

// Response for `GET /api/sessions/:id/usage-summary` — lightweight per-session
// usage rollup that replaces places on the web that used to refetch the full
// `/events` payload just to compute last-turn context. Computed server-side
// by scanning `session_events WHERE kind='turn_end'`.
export const UsageSummaryResponse = z.object({
  totalInput: z.number().int().nonnegative(),
  totalOutput: z.number().int().nonnegative(),
  /** inp + cacheRead + cacheCreation from the most recent `turn_end`. */
  lastTurnInput: z.number().int().nonnegative(),
  /** Mirrors `computeSessionUsage.lastTurnContextKnown`. */
  lastTurnContextKnown: z.boolean(),
  turnCount: z.number().int().nonnegative(),
  perModel: z.array(
    z.object({
      model: z.string(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  ),
});
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponse>;

// ============================================================================
// Diff primitives — shared by server aggregation and web rendering.
//
// The web bundle has its own `web/src/lib/diff.ts` that computes these shapes
// directly from a tool_use input. The server full-screen review page
// (mockup s-06) aggregates across a session's event log and ships the pre-
// computed `FileDiff` hunks over the wire, which means both ends must agree
// on the shape.
// ============================================================================

export const DiffLineKind = z.enum(["ctx", "add", "del"]);
export type DiffLineKind = z.infer<typeof DiffLineKind>;

export const DiffLine = z.object({
  kind: DiffLineKind,
  oldNum: z.number().int().nullable(),
  newNum: z.number().int().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const DiffHunk = z.object({
  header: z.string(),
  lines: z.array(DiffLine),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const DiffKind = z.enum(["create", "edit", "overwrite"]);
export type DiffKind = z.infer<typeof DiffKind>;

export const FileDiff = z.object({
  path: z.string(),
  kind: DiffKind,
  addCount: z.number().int().nonnegative(),
  delCount: z.number().int().nonnegative(),
  hunks: z.array(DiffHunk),
});
export type FileDiff = z.infer<typeof FileDiff>;

// One entry in the `/api/sessions/:id/pending-diffs` response.
//
// `approvalId` is set when this diff is backed by a still-pending
// `permission_request` — the UI can surface an Approve button and pipe it
// through the same `permission_decision` WS frame. When undefined, the diff
// is from an in-flight `tool_use` with no matching `tool_result` yet
// (rarely happens for Edit/Write under the default permission mode, but the
// UI still wants to show it so the user isn't blind).
export const PendingDiffEntry = z.object({
  toolUseId: z.string(),
  filePath: z.string(),
  // Matches the broad semantics of the original diff but keeps the labels
  // the UI wants ("MultiEdit" is its own bucket rather than a sub-kind of
  // Edit). `write` covers both create and overwrite at this level.
  kind: z.enum(["edit", "write", "multiedit"]),
  addCount: z.number().int().nonnegative(),
  delCount: z.number().int().nonnegative(),
  hunks: z.array(DiffHunk),
  approvalId: z.string().optional(),
  // Human-readable summary from the permission request's `title` field
  // (populated by summarizePermission). Null when there's no matching
  // permission_request — in-flight tool_use events have no such title.
  title: z.string().nullable(),
});
export type PendingDiffEntry = z.infer<typeof PendingDiffEntry>;

export const PendingDiffsResponse = z.object({
  diffs: z.array(PendingDiffEntry),
});
export type PendingDiffsResponse = z.infer<typeof PendingDiffsResponse>;

export const PendingApproval = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  // concise user-facing summary, prepared server-side
  summary: z.string(),
  // optional rendered "blast radius" hint shown in the UI
  blastRadius: z.string().nullable(),
  createdAt: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApproval>;

export const User = z.object({
  id: z.string(),
  username: z.string(),
  createdAt: z.string(),
  twoFactorEnabled: z.boolean(),
});
export type User = z.infer<typeof User>;

// ============================================================================
// HTTP request/response shapes
// ============================================================================

export const LoginRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  // whether the caller must now submit a TOTP code
  requireTotp: z.boolean(),
  // short-lived challenge id, stored in cookie too
  challengeId: z.string().nullable(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const VerifyTotpRequest = z.object({
  challengeId: z.string(),
  code: z.string().regex(/^\d{6}$/),
});
export type VerifyTotpRequest = z.infer<typeof VerifyTotpRequest>;

export const VerifyTotpResponse = z.object({
  ok: z.literal(true),
});
export type VerifyTotpResponse = z.infer<typeof VerifyTotpResponse>;

// Alternate second-factor path when the user's authenticator is unavailable:
// redeem one of the 10 single-use recovery codes that were issued at `init`
// (or later, via the Regenerate flow on the Security tab). Same
// challenge-then-cookie shape as `/verify-totp`. The `code` field accepts the
// user-visible `xxxx-xxxx-xxxx-xxxx` spelling and also tolerates whitespace
// or case variation — normalization happens server-side before bcrypt
// comparison — so the schema only enforces a coarse length bound.
export const VerifyRecoveryCodeRequest = z.object({
  challengeId: z.string(),
  // Min 16 (bare chars) / max 32 (with separators) gives us some slack for
  // users who paste extra whitespace.
  code: z.string().min(16).max(64),
});
export type VerifyRecoveryCodeRequest = z.infer<
  typeof VerifyRecoveryCodeRequest
>;

export const VerifyRecoveryCodeResponse = z.object({
  ok: z.literal(true),
  /** How many unused codes remain after this consumption. Useful for UIs
   * that want to nag the user to regenerate before they run out. */
  remaining: z.number().int().nonnegative(),
});
export type VerifyRecoveryCodeResponse = z.infer<
  typeof VerifyRecoveryCodeResponse
>;

export const RecoveryCodesStateResponse = z.object({
  remaining: z.number().int().nonnegative(),
  /** ISO timestamp of the most recent regenerate. Absent if the user has
   * never generated any codes (shouldn't happen for installs created after
   * migration 12 — init.ts seeds them — but the field is optional so the
   * UI can render a degrade gracefully for older installs). */
  generatedAt: z.string().optional(),
});
export type RecoveryCodesStateResponse = z.infer<
  typeof RecoveryCodesStateResponse
>;

export const RegenerateRecoveryCodesResponse = z.object({
  /** The plaintext codes, exactly 10 entries, rendered as
   * `xxxx-xxxx-xxxx-xxxx`. Returned to the client **exactly once** — the
   * server only stores hashes, so there is no "show them again" endpoint. */
  codes: z.array(z.string()).length(10),
  generatedAt: z.string(),
});
export type RegenerateRecoveryCodesResponse = z.infer<
  typeof RegenerateRecoveryCodesResponse
>;

export const WhoAmIResponse = z.object({
  user: User,
});
export type WhoAmIResponse = z.infer<typeof WhoAmIResponse>;

// Change-password flow. Requires the caller's current password (so a stolen
// JWT cookie alone can't rotate the password and lock the owner out) plus
// the new password, which is min-8 for parity with bcrypt setup.
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

// TOTP setup / rebind flow.
//
//   begin    →  server mints a fresh secret + otpauth URI (NOT persisted yet)
//   confirm  →  client sends the secret back along with a current 6-digit
//               code; server verifies the code against the proposed secret,
//               then atomically swaps it in. If 2FA is currently enabled the
//               caller must also include `currentTotp` (a code from the *old*
//               authenticator); if 2FA is currently off the caller must
//               include `password` instead — the two prove the same thing
//               (this user controls the account right now), but the right
//               proof depends on what's already configured.
//   disable  →  flag off, secret cleared, recovery codes wiped. Always
//               gated on the current password since "disabling 2FA"
//               permanently lowers account security.
//
// `secret` is the base32 string from `begin` echoed back by the client. We
// keep it on the wire instead of in server-side session state so that
// reloading the Settings page mid-flow doesn't strand the user.
export const TotpBeginResponse = z.object({
  secret: z.string().min(16),
  uri: z.string(),
  issuer: z.string(),
  account: z.string(),
  // Server-rendered SVG of the otpauth URI. Inlined so the browser can render
  // it via `dangerouslySetInnerHTML` without pulling in a QR library and
  // without round-tripping data URIs through an `<img>` tag (the latter
  // breaks under strict-CSP webviews).
  qrSvg: z.string(),
});
export type TotpBeginResponse = z.infer<typeof TotpBeginResponse>;

export const TotpConfirmRequest = z.object({
  secret: z.string().min(16),
  code: z.string().regex(/^\d{6}$/),
  // Exactly one of these must be present. Validation deferred to the route
  // because zod's discriminated unions add a wrapper field on the wire and
  // we'd rather keep the JSON shape flat.
  currentTotp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  password: z.string().min(1).optional(),
});
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequest>;

export const TotpConfirmResponse = z.object({
  ok: z.literal(true),
});
export type TotpConfirmResponse = z.infer<typeof TotpConfirmResponse>;

export const TotpDisableRequest = z.object({
  password: z.string().min(1),
});
export type TotpDisableRequest = z.infer<typeof TotpDisableRequest>;

export const TotpDisableResponse = z.object({
  ok: z.literal(true),
});
export type TotpDisableResponse = z.infer<typeof TotpDisableResponse>;

// Read-only reflection of the user's Claude CLI environment: which plugins
// are installed, which are flagged as enabled in `settings.json`. We don't
// let the UI mutate any of this — the CLI owns those files, we just surface
// them so the settings page isn't lying about what's loaded.
export const UserEnvPlugin = z.object({
  key: z.string(), // e.g. "skill-creator@claude-plugins-official"
  name: z.string(), // e.g. "skill-creator"
  marketplace: z.string().nullable(), // e.g. "claude-plugins-official" (null if the key has no @)
  version: z.string().nullable(),
  installPath: z.string().nullable(),
  enabled: z.boolean(),
});
export type UserEnvPlugin = z.infer<typeof UserEnvPlugin>;

export const UserEnvResponse = z.object({
  user: User,
  // Absolute path to `~/.claude` as the server sees it (informational only).
  claudeDir: z.string(),
  // Whether `~/.claude/settings.json` was readable. False means the panel
  // should show a "no settings file" note instead of claiming everything's
  // disabled.
  settingsReadable: z.boolean(),
  plugins: z.array(UserEnvPlugin),
});
export type UserEnvResponse = z.infer<typeof UserEnvResponse>;

export const CreateSessionRequest = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  model: ModelId,
  mode: PermissionMode,
  // Optional — defaults to `medium` server-side.
  effort: EffortLevel.optional(),
  worktree: z.boolean().default(true),
  initialPrompt: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

// Body of `POST /api/sessions/:id/side` — spawns a /btw side chat that reads
// the parent's transcript for context but never writes back. Everything on
// the child (model / mode / project) is copied from the parent by default.
// Only the optional initial prompt is carried in the body.
export const CreateSideSessionRequest = z.object({
  initialPrompt: z.string().optional(),
  title: z.string().min(1).optional(),
});
export type CreateSideSessionRequest = z.infer<typeof CreateSideSessionRequest>;

export const UpdateProjectRequest = z.object({
  // Only `name` is mutable. Changing `path` would effectively be a different
  // project — adding a new one is the correct way to express that.
  name: z.string().min(1),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

// Validator for a single session tag. Lowercase ASCII letters/digits/dashes,
// length 1..24. Enforced at the HTTP surface so invalid inputs surface as
// 400 rather than slipping into persisted JSON.
export const SessionTag = z
  .string()
  .min(1)
  .max(24)
  .regex(/^[a-z0-9-]+$/);
export type SessionTag = z.infer<typeof SessionTag>;

// Partial update for a session. At least one field must be present — the
// server uses `.refine()` to reject empty bodies (otherwise a no-op PATCH
// would still bump updated_at).
export const UpdateSessionRequest = z
  .object({
    title: z.string().min(1).optional(),
    model: ModelId.optional(),
    mode: PermissionMode.optional(),
    // Hot-swap the thinking-effort level. The runner picks up the new value
    // on the NEXT SDK turn; an in-flight turn keeps the budget it started
    // with (matches how `model` changes propagate).
    effort: EffortLevel.optional(),
    // Max 8 tags per session. Each tag is validated by `SessionTag`. Passing
    // an explicit empty array clears all tags.
    tags: z.array(SessionTag).max(8).optional(),
    // Pin / unpin the session. Pinned sessions sort to the top of Home's
    // session list regardless of activity.
    pinned: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.model !== undefined ||
      v.mode !== undefined ||
      v.effort !== undefined ||
      v.tags !== undefined ||
      v.pinned !== undefined,
    {
      message:
        "at least one of title, model, mode, effort, tags, or pinned is required",
    },
  );
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

// Scope of a tool grant: session-only or global across all sessions.
export const ToolGrantScope = z.enum(["session", "global"]);
export type ToolGrantScope = z.infer<typeof ToolGrantScope>;

export const ToolGrant = z.object({
  id: z.string(),
  toolName: z.string(),
  signature: z.string(),
  scope: ToolGrantScope,
  createdAt: z.string(),
  // Populated for `scope: "session"` rows. `GET /api/grants` (global view)
  // returns them so the Settings → Security card can show "which session
  // owns this grant" next to each row; `GET /api/sessions/:id/grants`
  // (single-session view) omits them because every row is already scoped
  // to the current session.
  sessionId: z.string().optional(),
  sessionTitle: z.string().optional(),
});
export type ToolGrant = z.infer<typeof ToolGrant>;

// ============================================================================
// Filesystem browse (for the FolderPicker UI)
// ============================================================================

export const BrowseEntry = z.object({
  name: z.string(),
  path: z.string(), // absolute host path
  isDir: z.boolean(),
  isHidden: z.boolean(), // leading-dot entries; UI decides whether to show
  // Optional metadata for general-purpose file browsers. Older consumers
  // (FolderPicker, @-file mention sheet) ignore these; the Files screen
  // uses them to render size + mtime per row.
  size: z.number().int().nonnegative().optional(),
  mtimeMs: z.number().nonnegative().optional(),
});
export type BrowseEntry = z.infer<typeof BrowseEntry>;

export const BrowseResponse = z.object({
  path: z.string(), // the (resolved) directory that was listed
  parent: z.string().nullable(), // absolute parent path, or null at the root
  entries: z.array(BrowseEntry),
});
export type BrowseResponse = z.infer<typeof BrowseResponse>;

// Response from GET /api/browse/read?path=<abs>. Used by the general-purpose
// Files browser to preview arbitrary host files (not project-scoped). See
// `FilesReadResponse` below for the project-scoped sibling — that one carries
// git annotations, this one doesn't.
export const BrowseReadResponse = z.object({
  path: z.string(), // absolute host path of the file
  parent: z.string().nullable(), // absolute parent directory
  name: z.string(), // basename
  content: z.string(),
  lines: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  mode: z.string(), // "-rw-r--r--" style
  truncated: z.boolean(), // true when the file was larger than the 1 MB cap
});
export type BrowseReadResponse = z.infer<typeof BrowseReadResponse>;

// ============================================================================
// CLI session discovery & import
// ============================================================================

// Summary of a `claude` CLI session discovered on disk at
// ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. We don't parse the whole
// transcript — just enough metadata to render a "pick which ones to adopt"
// list. `title` is derived from the first user message (word-boundary
// truncated to ~60 chars) so the list looks like the other session lists.
export const CliSessionSummary = z.object({
  sessionId: z.string(),
  cwd: z.string(), // decoded from the slug; best-effort (see decodeSlug)
  title: z.string(),
  firstUserMessage: z.string().nullable(),
  lineCount: z.number().int().nonnegative(), // bounded: we only read ~head
  fileSize: z.number().int().nonnegative(),
  lastModified: z.string(), // ISO 8601
  // Absolute path to the underlying <uuid>.jsonl. The server uses this on
  // import to seed `session_events` from the CLI's transcript. Shipped to
  // the UI for transparency but the UI has no reason to render it.
  filePath: z.string(),
});
export type CliSessionSummary = z.infer<typeof CliSessionSummary>;

export const ListCliSessionsResponse = z.object({
  sessions: z.array(CliSessionSummary),
});
export type ListCliSessionsResponse = z.infer<typeof ListCliSessionsResponse>;

export const ImportCliSessionsRequest = z.object({
  sessionIds: z.array(z.string().min(1)).min(1),
});
export type ImportCliSessionsRequest = z.infer<typeof ImportCliSessionsRequest>;

export const ImportCliSessionsResponse = z.object({
  imported: z.array(Session),
});
export type ImportCliSessionsResponse = z.infer<
  typeof ImportCliSessionsResponse
>;

// ============================================================================
// Slash commands (composer `/` picker)
// ============================================================================

// Where a slash command came from. `built-in` is hard-coded in the server
// (the `claude` CLI owns the actual behavior); `user` comes from
// `~/.claude/commands/`; `project` from `<project>/.claude/commands/`;
// `plugin` is reserved for a future scanner — not emitted today.
export const SlashCommandKind = z.enum([
  "built-in",
  "user",
  "project",
  "plugin",
]);
export type SlashCommandKind = z.infer<typeof SlashCommandKind>;

// How the composer should treat a slash command when the user picks it.
//
// Motivated by a concrete bug: many of the `claude` CLI's `/` commands are
// REPL-only (`/login`, `/doctor`, `/init`, …) and the Agent SDK rejects them
// with "isn't available in this environment". Rather than let the user paste
// one of those into the composer and get that error, the picker now knows
// which entries are:
//
//   - `native`:         the SDK forwards the `/x` token through — just send
//   - `claudex-action`: the token is intercepted client-side and mapped to a
//                       claudex UI action (open model picker, open usage,
//                       etc.) instead of going over the wire
//   - `unsupported`:    REPL-only, no claudex equivalent — show a dimmed row
//                       with a short reason, and block sends that start with
//                       this exact token
//
// Custom `user`/`project`/`plugin` commands are always `native` — the SDK
// resolves the prompt template from disk the same way the CLI does. Only
// `built-in` entries vary.
export const SlashBehaviorKind = z.enum([
  "native",
  "claudex-action",
  "unsupported",
]);
export type SlashBehaviorKind = z.infer<typeof SlashBehaviorKind>;

// The set of client-side actions the web composer knows how to dispatch when
// the user picks a `claudex-action` command. Keeping this as a closed enum
// (rather than a free-form string) lets TypeScript keep the Chat screen
// exhaustive when we add a mapping later.
export const SlashClaudexAction = z.enum([
  "open-model-picker",
  "open-session-settings",
  "open-usage",
  "open-plugins-settings",
  "open-slash-help",
  "clear-transcript",
]);
export type SlashClaudexAction = z.infer<typeof SlashClaudexAction>;

export const SlashBehavior = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native") }),
  z.object({
    kind: z.literal("claudex-action"),
    action: SlashClaudexAction,
  }),
  z.object({ kind: z.literal("unsupported"), reason: z.string() }),
]);
export type SlashBehavior = z.infer<typeof SlashBehavior>;

export const SlashCommand = z.object({
  // Bare command name, without the leading `/`.
  name: z.string(),
  // One-line description; null when we couldn't extract one from the file.
  description: z.string().nullable(),
  kind: SlashCommandKind,
  // Absolute path to the source file for user/project/plugin entries; omitted
  // for built-ins.
  source: z.string().optional(),
  // Composer triage — see SlashBehavior. Always set on built-ins; for
  // user/project/plugin entries the server stamps `{ kind: "native" }`.
  behavior: SlashBehavior,
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const ListSlashCommandsResponse = z.object({
  commands: z.array(SlashCommand),
});
export type ListSlashCommandsResponse = z.infer<
  typeof ListSlashCommandsResponse
>;

// ============================================================================
// Routines (scheduled sessions)
// ============================================================================

// A routine is a cron-scheduled recipe: at each fire, the scheduler creates a
// fresh session (with the routine's project/model/mode) and kicks it off with
// `prompt` as the first user message. Independent conversation history per run.
// `paused` routines stay in the list but skip scheduling.
export const RoutineStatus = z.enum(["active", "paused"]);
export type RoutineStatus = z.infer<typeof RoutineStatus>;

export const Routine = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  prompt: z.string(),
  // Five-field cron expression (min hr dom mon dow). Evaluated in the host's
  // local timezone by the scheduler.
  cronExpr: z.string(),
  model: ModelId,
  mode: PermissionMode,
  status: RoutineStatus,
  lastRunAt: z.string().nullable(),
  // ISO timestamp of the next scheduled fire; null when paused or the
  // expression no longer yields future dates (shouldn't happen for 5-field).
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Routine = z.infer<typeof Routine>;

export const CreateRoutineRequest = z.object({
  name: z.string().min(1),
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  cronExpr: z.string().min(1),
  model: ModelId,
  mode: PermissionMode,
});
export type CreateRoutineRequest = z.infer<typeof CreateRoutineRequest>;

// Partial update. At least one field must be present — the route rejects
// empty bodies rather than bumping `updated_at` for nothing.
export const UpdateRoutineRequest = z
  .object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    cronExpr: z.string().min(1).optional(),
    model: ModelId.optional(),
    mode: PermissionMode.optional(),
    status: RoutineStatus.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.prompt !== undefined ||
      v.cronExpr !== undefined ||
      v.model !== undefined ||
      v.mode !== undefined ||
      v.status !== undefined,
    { message: "at least one field is required" },
  );
export type UpdateRoutineRequest = z.infer<typeof UpdateRoutineRequest>;

// ============================================================================
// Usage analytics (full-screen `/usage` page)
//
// These endpoints aggregate `turn_end` payloads across non-archived sessions.
// They intentionally do NOT try to mirror Claude's subscription-plan quota —
// claudex doesn't see that data; it lives inside the `claude` CLI itself. The
// UI surfaces an empty state for plan-period usage rather than faking a bar.
//
// Token math: per-turn tokens = `inputTokens + outputTokens +
// cacheReadInputTokens + cacheCreationInputTokens`. Missing fields (older
// rows) contribute zero rather than crashing the sum. See `usage.ts` / the
// `TurnEndUsage` schema above for the "why cache fields are load-bearing"
// discussion.
// ============================================================================

// Per-model breakdown for the "Today · tokens" tile and the stacked bars.
export const UsagePerModel = z.object({
  // The raw model id as persisted on sessions.model (no translation).
  model: z.string(),
  tokens: z.number().int().nonnegative(),
});
export type UsagePerModel = z.infer<typeof UsagePerModel>;

// One entry in "Top sessions" — enough to render title + project + tokens
// without the web bundle having to match these up against its own sessions
// store.
export const UsageTopSession = z.object({
  sessionId: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string().nullable(), // null if the project row is gone
  tokens: z.number().int().nonnegative(),
});
export type UsageTopSession = z.infer<typeof UsageTopSession>;

// Response for `GET /api/usage/today` — everything the three-tile header +
// "Top sessions" card on the Usage screen needs. `windowStart` is ISO and
// lets the UI show "Today · since 00:00" honestly.
export const UsageTodayResponse = z.object({
  windowStart: z.string(),
  totalTokens: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  perModel: z.array(UsagePerModel),
  topSessions: z.array(UsageTopSession),
});
export type UsageTodayResponse = z.infer<typeof UsageTodayResponse>;

// One day's stacked token breakdown — drives the 7-day bar chart. `date` is
// `YYYY-MM-DD` in the server's local timezone so the x-axis labels line up
// with what the user considers "today".
export const UsageRangeDay = z.object({
  date: z.string(),
  totalTokens: z.number().int().nonnegative(),
  perModel: z.array(UsagePerModel),
});
export type UsageRangeDay = z.infer<typeof UsageRangeDay>;

// Response for `GET /api/usage/range?days=N`. `byDay` is always exactly N
// entries, oldest first, including days with zero tokens — so the chart
// doesn't have to pad missing days client-side.
export const UsageRangeResponse = z.object({
  days: z.number().int().positive(),
  byDay: z.array(UsageRangeDay),
});
export type UsageRangeResponse = z.infer<typeof UsageRangeResponse>;

// ============================================================================
// Push notifications
//
// claudex fires a Web Push notification every time a session enters the
// `awaiting` state because the CLI asked for tool-use permission — that's the
// whole reason this surface exists. The user reaches claudex from their phone
// over frpc; without push they have to keep the tab open to see a request.
//
// Subscriptions are per device, not per user: claudex is single-user, and we
// want every browser that's installed claudex as a PWA to get notified.
// ============================================================================

// Body of `POST /api/push/subscriptions` — the serialized browser
// PushSubscription plus the user-agent string we stamp onto the stored row so
// Settings can render an honest device list.
export const PushSubscribeRequest = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;

export const PushSubscribeResponse = z.object({
  id: z.string(),
  enabled: z.literal(true),
});
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponse>;

// One registered device. `userAgent` can be null on rows imported before we
// captured it; the UI renders "Unknown device" then.
export const PushDevice = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type PushDevice = z.infer<typeof PushDevice>;

// `GET /api/push/state` — snapshot for the Settings Notifications tab.
// `enabled` is "does at least one subscription exist on this server"; it does
// NOT imply the *current* browser is subscribed — the UI separately consults
// `Notification.permission` and the in-memory `PushSubscription` from the
// service worker registration for that.
export const PushStateResponse = z.object({
  enabled: z.boolean(),
  devices: z.array(PushDevice),
});
export type PushStateResponse = z.infer<typeof PushStateResponse>;

// `GET /api/push/vapid-public` — VAPID public key for
// `PushManager.subscribe({ applicationServerKey })`. Generated on first boot
// and persisted at `~/.claudex/vapid.json`.
export const VapidPublicResponse = z.object({
  publicKey: z.string(),
});
export type VapidPublicResponse = z.infer<typeof VapidPublicResponse>;

// Response for `POST /api/push/test` — fires a test push to every stored
// subscription. `sent` counts subscriptions we handed to web-push; `pruned`
// counts subscriptions that came back 404/410 (browser unsubscribed) and were
// deleted as a side-effect.
export const PushTestResponse = z.object({
  sent: z.number().int().nonnegative(),
  pruned: z.number().int().nonnegative(),
});
export type PushTestResponse = z.infer<typeof PushTestResponse>;

// ============================================================================
// Attachments (composer "Attach" chip)
//
// Two-phase model: uploads land unlinked (`message_event_seq = null`) via
// `POST /api/sessions/:id/attachments`, then get stamped onto the user's
// `user_message` event seq when they hit Send. A user can delete an unlinked
// attachment (they changed their mind); linked attachments are immutable.
// The file itself lives under `~/.claudex/uploads/<session-id>/`. The raw
// file is served by a login-gated endpoint at `/api/attachments/:id/raw`;
// for image attachments this is also the `previewUrl` the composer uses to
// render an inline thumbnail.
// ============================================================================

export const Attachment = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  /** Absolute URL path (same origin) that serves the raw bytes. Only populated
   * for image attachments today — the composer uses it for inline thumbnails.
   * The server route exists for every mime type; the client just chooses not
   * to fetch non-images. */
  previewUrl: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

export const UploadAttachmentResponse = Attachment;
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponse>;

// ============================================================================
// Full-text search across sessions + messages
//
// Backed by SQLite FTS5 (see server migration id=9). The server returns two
// buckets: `titleHits` (session titles that matched) and `messageHits`
// (user_message / assistant_text / assistant_thinking bodies that matched).
// Each capped at the `limit` query param (default 20, max 50 server-side).
//
// Snippets embed `<mark>…</mark>` HTML around the matched fragment. Clients
// must either sanitize-and-map those to styled spans (preferred) or, if they
// really do need to render as HTML, do so with the understanding that the
// server controls that output and will never emit anything other than
// literal `<mark>` / `</mark>` around tokenizer matches.
// ============================================================================

export const SearchTitleHit = z.object({
  sessionId: z.string(),
  title: z.string(),
  // The FTS `snippet()` for the matched title. Short (≤16 tokens). Optional
  // because a literal one-word title match may return an empty snippet.
  snippet: z.string().optional(),
});
export type SearchTitleHit = z.infer<typeof SearchTitleHit>;

export const SearchMessageHit = z.object({
  sessionId: z.string(),
  // Parent session's current title (JOINed server-side so clients don't
  // need a second round-trip to resolve it).
  title: z.string(),
  eventSeq: z.number().int().nonnegative(),
  kind: z.string(),
  snippet: z.string(),
  createdAt: z.string(),
});
export type SearchMessageHit = z.infer<typeof SearchMessageHit>;

export const SearchResponse = z.object({
  titleHits: z.array(SearchTitleHit),
  messageHits: z.array(SearchMessageHit),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// ============================================================================
// Batch queue
//
// A queue of prompts the user wants run sequentially, each as its own fresh
// session. The runner picks the lowest-seq `queued` row, spawns a session,
// sends the prompt, then waits for the session to settle (idle or error)
// before moving on. Crash-resilient: every transition is persisted; a restart
// mid-run picks up with whatever row is still marked `running`.
// ============================================================================

export const QueueStatus = z.enum([
  "queued",
  "running",
  "done",
  "cancelled",
  "failed",
]);
export type QueueStatus = z.infer<typeof QueueStatus>;

export const QueuedPrompt = z.object({
  id: z.string(),
  projectId: z.string(),
  prompt: z.string(),
  // Short user label; falls back to first 60 chars of the prompt at render
  // time. Nullable so the API body can omit it.
  title: z.string().nullable(),
  // Null → runner falls back to the project/user default (claude-opus-4-8 /
  // 'default'). Non-null entries pin the choice.
  model: ModelId.nullable(),
  mode: PermissionMode.nullable(),
  worktree: z.boolean(),
  status: QueueStatus,
  // Set when the runner promotes the row to `running` (or later). Lets the
  // UI render "Open session →" once a real session exists.
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  seq: z.number().int().nonnegative(),
});
export type QueuedPrompt = z.infer<typeof QueuedPrompt>;

export const CreateQueuedPromptRequest = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  model: ModelId.optional(),
  mode: PermissionMode.optional(),
  worktree: z.boolean().optional(),
});
export type CreateQueuedPromptRequest = z.infer<
  typeof CreateQueuedPromptRequest
>;

export const UpdateQueuedPromptRequest = z
  .object({
    prompt: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    model: ModelId.optional(),
    mode: PermissionMode.optional(),
    worktree: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.prompt !== undefined ||
      v.title !== undefined ||
      v.model !== undefined ||
      v.mode !== undefined ||
      v.worktree !== undefined,
    { message: "at least one field is required" },
  );
export type UpdateQueuedPromptRequest = z.infer<
  typeof UpdateQueuedPromptRequest
>;

export const ListQueuedPromptsResponse = z.object({
  queue: z.array(QueuedPrompt),
});
export type ListQueuedPromptsResponse = z.infer<
  typeof ListQueuedPromptsResponse
>;

// ============================================================================
// Audit log
//
// Security-relevant events visible to the logged-in operator. The server
// writes rows fire-and-forget from auth, session, manager, and push call
// sites (see server/src/audit/); the web Security tab renders a rolling list
// plus a full-log sheet. `event` is an open string rather than a closed enum
// so new call sites can land without a shared-schema bump — the UI falls back
// to a generic "<event>" sentence when it doesn't have a mapping.
// ============================================================================

export const AuditEvent = z.object({
  id: z.string(),
  event: z.string(),
  target: z.string().nullable(),
  detail: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  // Populated by the route via userStore lookup when `user_id` is non-null.
  // Null for pre-login events (failed login / invalid challenge).
  user: z
    .object({ id: z.string(), username: z.string() })
    .nullable(),
  // 登录设备审计(2026-09):deviceId = 浏览器设备号 claudex_device_id;
  // deviceIsNew = 该设备号对该用户首次登录成功(仅成功事件为 true);
  // port = TCP 源端口。旧行 deviceId/port 为 null,deviceIsNew 为 false。
  deviceId: z.string().nullable(),
  deviceIsNew: z.boolean(),
  port: z.number().int().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditListResponse = z.object({
  events: z.array(AuditEvent),
  totalCount: z.number().int().nonnegative(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;

// ============================================================================
// Client errors — browser-side crash capture
//
// The web UI runs on HTTP over an frpc tunnel, so the user can't open the real
// browser DevTools on a phone. When React render crashes or a global
// unhandledrejection fires, the frontend POSTs the payload to
// `/api/client-errors` and the server persists it. The `/errors` screen then
// surfaces the queue so the user can inspect stack traces and mark entries
// resolved once they've been investigated / fixed.
//
// Grouping: identical errors (same fingerprint = sha1 of kind + 1st line of
// message + 1st stack frame) increment `count` and bump `lastSeenAt`, instead
// of creating a brand-new row — otherwise a render loop would fill the table
// in seconds.
// ============================================================================

export const ClientErrorKind = z.enum([
  "render", // React render crash caught by RootErrorBoundary
  "uncaught", // window.error (sync throw outside React)
  "unhandledrejection", // unhandled Promise rejection
  "console-error", // console.error — includes React warnings
]);
export type ClientErrorKind = z.infer<typeof ClientErrorKind>;

// Input payload shape — what the browser POSTs. Server fills in id, times,
// count, resolvedAt, fingerprint.
export const ClientErrorReport = z.object({
  kind: ClientErrorKind,
  message: z.string().min(1).max(4000),
  stack: z.string().max(16000).optional(),
  componentStack: z.string().max(16000).optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
  // Client's own wall-clock at the time of the error. Server trusts this
  // loosely — it's shown alongside the server-side `createdAt` so the UI can
  // show "browser time" without letting a skewed client influence storage
  // ordering.
  clientTime: z.number().int().nonnegative().optional(),
});
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

export const ClientError = z.object({
  id: z.string(),
  kind: ClientErrorKind,
  message: z.string(),
  stack: z.string().nullable(),
  componentStack: z.string().nullable(),
  url: z.string().nullable(),
  userAgent: z.string().nullable(),
  fingerprint: z.string(),
  count: z.number().int().positive(),
  firstSeenAt: z.string(), // ISO, server time of first occurrence
  lastSeenAt: z.string(), // ISO, server time of most recent occurrence
  resolvedAt: z.string().nullable(), // null = open; ISO when marked resolved
});
export type ClientError = z.infer<typeof ClientError>;

export const ClientErrorListResponse = z.object({
  errors: z.array(ClientError),
  openCount: z.number().int().nonnegative(),
  resolvedCount: z.number().int().nonnegative(),
});
export type ClientErrorListResponse = z.infer<typeof ClientErrorListResponse>;

// ============================================================================
// Project memory (CLAUDE.md preview)
//
// Returned by `GET /api/projects/:id/memory` — read-only surfacing of the
// CLAUDE.md files the `claude` CLI treats as ambient memory. Up to two entries:
// one project-scoped (<project>/CLAUDE.md or <project>/.claude/CLAUDE.md, first
// match wins) and one user-scoped (~/.claude/CLAUDE.md). `content` is capped at
// 64 KB server-side; `truncated: true` signals the UI should say so.
// ============================================================================

export const MemoryFile = z.object({
  scope: z.enum(["project", "user"]),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  content: z.string(),
  truncated: z.boolean().optional(),
});
export type MemoryFile = z.infer<typeof MemoryFile>;

export const MemoryResponse = z.object({
  files: z.array(MemoryFile),
});
export type MemoryResponse = z.infer<typeof MemoryResponse>;

// ============================================================================
// Link previews
//
// Returned by `GET /api/link-preview?url=<encoded>`. A tiny metadata shape
// good enough to render a card with title / description / thumbnail next to a
// message bubble that contains a link. Fields beyond `url` and `fetchedAt`
// are best-effort — the server might have got a 200 with nothing useful in
// the HTML, in which case everything else is omitted and the web client
// silently renders nothing. Errors (private IP, non-http, rate limit, 4xx /
// 5xx upstream) surface as HTTP errors and are NOT shaped into this struct.
// ============================================================================

export const LinkPreview = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  siteName: z.string().optional(),
  fetchedAt: z.string(),
});
export type LinkPreview = z.infer<typeof LinkPreview>;

// ============================================================================
// Stats dashboard (`GET /api/stats`)
//
// Single-snapshot aggregation over the sessions / session_events tables. Backs
// the StatsSheet reached from Home's overflow menu. Kept intentionally
// high-signal: totals, honest averages, the busiest project, the top 5 tools
// by tool_use count, and oldest/newest session stamps. No vanity metrics
// (no "streak days", no social counters) — every number has a direct query
// behind it. Gracefully zero when the DB is empty.
// ============================================================================

export const StatsTopTool = z.object({
  name: z.string(),
  uses: z.number().int().nonnegative(),
});
export type StatsTopTool = z.infer<typeof StatsTopTool>;

export const StatsBusiestProject = z.object({
  id: z.string(),
  name: z.string(),
  sessionCount: z.number().int().nonnegative(),
});
export type StatsBusiestProject = z.infer<typeof StatsBusiestProject>;

export const StatsSessionRef = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
});
export type StatsSessionRef = z.infer<typeof StatsSessionRef>;

export const StatsResponse = z.object({
  totalSessions: z.number().int().nonnegative(),
  // status in ('running', 'awaiting')
  activeSessions: z.number().int().nonnegative(),
  archivedSessions: z.number().int().nonnegative(),
  // Count of `turn_end` events across every session.
  totalTurns: z.number().int().nonnegative(),
  // totalTurns / nonArchivedSessions, rounded to one decimal. Zero when there
  // are no non-archived sessions.
  avgTurnsPerSession: z.number().nonnegative(),
  busiestProject: StatsBusiestProject.nullable(),
  // Up to five entries, sorted by `uses` desc. Empty when no tool_use events.
  topTools: z.array(StatsTopTool),
  // Rounded to the nearest integer. Zero when totalTurns is 0.
  avgTokensPerTurn: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  oldestSession: StatsSessionRef.nullable(),
  newestSession: StatsSessionRef.nullable(),
});
export type StatsResponse = z.infer<typeof StatsResponse>;

// ============================================================================
// Full-data backup bundle
//
// `GET /api/export/all` emits a single JSON document matching `BackupBundle`
// shape — every project/session/event/routine/queued-prompt/grant on this
// installation plus best-effort attachment metadata (no file bytes) and the
// most recent audit rows. Secrets (password hashes, TOTP secrets, recovery
// code hashes, push subscription keys, VAPID / JWT secrets) are deliberately
// NOT included — the bundle is meant to be portable to another claudex
// install, not to mirror the auth store.
//
// `POST /api/import/all` accepts a multipart upload whose `bundle` part is the
// same JSON shape. Semantics are merge-not-replace: projects dedupe on path,
// sessions are always appended (new ids, remapped project ids), events are
// re-sequenced 1..N per session, and device-bound tables (push subscriptions,
// recovery codes, users) are skipped entirely.
// ============================================================================

// Attachment metadata as it appears in a backup bundle. The on-disk bytes are
// NOT copied — restore-to-another-machine preserves the row history but links
// a raw-path that may no longer exist. The web surface already tolerates
// missing files (the raw route 404s with `file_missing`) so this is honest.
export const BackupAttachmentMeta = z.object({
  id: z.string(),
  sessionId: z.string(),
  messageEventSeq: z.number().int().nullable(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  path: z.string(),
  createdAt: z.string(),
});
export type BackupAttachmentMeta = z.infer<typeof BackupAttachmentMeta>;

export const BackupBundle = z.object({
  /** Version of claudex that produced this bundle (server package.json). */
  claudexVersion: z.string(),
  exportedAt: z.string(),
  projects: z.array(Project),
  // Sessions list is exhaustive — includes archived rows + side chats.
  sessions: z.array(Session),
  // Flat events list across every session, ordered by created_at ASC so a
  // naive restore replay preserves causality without peeking at seqs.
  events: z.array(SessionEvent),
  routines: z.array(Routine),
  queue: z.array(QueuedPrompt),
  grants: z.array(ToolGrant),
  attachments: z.array(BackupAttachmentMeta),
  // Optional so older bundles that predated audit export still parse. When
  // present, capped at the last 1000 rows server-side (the table can grow
  // unbounded — full-dump would blow the bundle size for no gain).
  audit: z.array(AuditEvent).optional(),
});
export type BackupBundle = z.infer<typeof BackupBundle>;

// Response shape for `POST /api/import/all`. Tallies per-table inserts, and a
// bag of skip reasons the UI surfaces so the user can tell why not everything
// landed.
export const ImportAllResponse = z.object({
  imported: z.object({
    projects: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    routines: z.number().int().nonnegative(),
    queue: z.number().int().nonnegative(),
    audit: z.number().int().nonnegative(),
  }),
  skipped: z.object({
    projectsByPath: z.number().int().nonnegative(),
    sessionsBySdkId: z.number().int().nonnegative(),
    routinesMissingProject: z.number().int().nonnegative(),
    queueMissingProject: z.number().int().nonnegative(),
    grants: z.number().int().nonnegative(),
    attachments: z.number().int().nonnegative(),
    // Audit rows carry attacker-chosen `event`/`ip`/`user_agent` strings —
    // importing them would let a bundle inject fake "login" entries into
    // the local Security card. We always skip, and surface the count so
    // the user sees why the number here doesn't match the bundle body.
    audit: z
      .object({
        count: z.number().int().nonnegative(),
        reason: z.string(),
      })
      .optional(),
  }),
  /** `true` when the incoming `claudexVersion` didn't match this server's —
   * import still proceeded (shapes are additive) but the UI can nag the user. */
  versionMismatch: z.boolean(),
});
export type ImportAllResponse = z.infer<typeof ImportAllResponse>;

// ============================================================================
// Subagent monitor
//
// Aggregates the SDK's subagent-family `tool_use` events (`Task`, `Agent`,
// `Explore`) across every session into a single read-only observability feed.
// A run is keyed on `toolUseId`: the `tool_use` event is when the parent
// delegated to a subagent; a matching `tool_result` (JOINed in JS by
// `toolUseId`) carries its final output and the terminal status. Missing
// match → still `running`.
//
// Scope note: today we only recognize the SDK's built-in subagent tool names
// (see `SUBAGENT_TOOL_NAMES` in `server/src/agents/routes.ts`). User-defined
// prompt-template subagents would need to be added to that list — the wire
// schema does not need to change.
// ============================================================================

export const SubagentRunStatus = z.enum(["running", "done", "failed"]);
export type SubagentRunStatus = z.infer<typeof SubagentRunStatus>;

export const SubagentSummary = z.object({
  /** Primary key — the `tool_use.toolUseId` that launched this subagent run. */
  id: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  projectName: z.string().nullable(),
  /** Recognized subagent tool name (`Task` / `Agent` / `Explore` / other). */
  toolName: z.string(),
  /** Short human-readable label derived from the tool_use input payload. */
  description: z.string(),
  /** Full `input` payload of the `tool_use` event — shown pretty-printed in
   * the /agents expanded-row view. Shape varies by tool (Task / Agent /
   * Explore), so we keep it loose as an arbitrary object. Empty object when
   * the SDK emitted no input or when parsing failed. */
  input: z.record(z.string(), z.unknown()),
  /** Seq of the `tool_use` event in its session — lets the UI deep-link via
   * `/session/:id#seq-<seq>`. */
  seq: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** finishedAt − startedAt in ms; null while still running. */
  durationMs: z.number().int().nonnegative().nullable(),
  status: SubagentRunStatus,
  isError: z.boolean(),
  /** First 200 chars of the matching `tool_result.content`; null while still
   * running (or when the content was non-text). */
  resultPreview: z.string().nullable(),
});
export type SubagentSummary = z.infer<typeof SubagentSummary>;

export const SubagentStats = z.object({
  activeCount: z.number().int().nonnegative(),
  completedToday: z.number().int().nonnegative(),
  /** Mean duration of completed (done + failed) runs today; null when zero
   * completed. */
  avgDurationMs: z.number().int().nonnegative().nullable(),
  /** `failed_today / (failed_today + done_today)`; null when zero completed. */
  failureRate: z.number().min(0).max(1).nullable(),
});
export type SubagentStats = z.infer<typeof SubagentStats>;

export const ListSubagentsResponse = z.object({
  items: z.array(SubagentSummary),
  stats: SubagentStats,
});
export type ListSubagentsResponse = z.infer<typeof ListSubagentsResponse>;

// ============================================================================
// Subagent live stream (s-17)
//
// Payloads persisted under the five new `subagent_*` EventKinds — sourced
// from the Claude Agent SDK's `system/task_started|task_progress|
// task_updated|task_notification` messages plus the top-level
// `tool_progress` message. `taskId` is the SDK's stable per-subagent id
// (distinct from the parent's `tool_use.toolUseId` — see
// `parentToolUseId` for that linkage).
//
// Also used verbatim as the shape of the matching ServerFrame variants in
// `shared/src/protocol.ts`, so clients, server ingest, and WS layer all
// share one contract. The web store consumes these to assemble a
// `SubagentRun[]` view; see `web/src/state/sessions.ts`.
// ============================================================================

export const SubagentUsage = z.object({
  totalTokens: z.number().int().nonnegative().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type SubagentUsage = z.infer<typeof SubagentUsage>;

export const SubagentLifecycleStatus = z.enum([
  "running",
  "completed",
  "failed",
  "stopped",
]);
export type SubagentLifecycleStatus = z.infer<typeof SubagentLifecycleStatus>;

/** `system/task_started` — sent once when the parent dispatches a subagent.
 *
 * `taskType` mirrors the SDK's open string (today: `local_agent` | `bash` |
 * `remote_agent` | `local_workflow` | …). `parentToolUseId` links back to
 * the parent's `Task` / `Agent` / `Explore` tool_use row so nested events
 * (correlated via `parent_tool_use_id`) can be grouped under this run.
 */
export const SubagentStartPayload = z.object({
  taskId: z.string(),
  parentToolUseId: z.string().nullable(),
  description: z.string(),
  agentType: z.string().optional(),
  taskType: z.string().optional(),
  workflowName: z.string().optional(),
  prompt: z.string().optional(),
  isBackgrounded: z.boolean().optional(),
  at: z.string(),
});
export type SubagentStartPayload = z.infer<typeof SubagentStartPayload>;

/** `system/task_progress` — periodic (~30s) heartbeat with an AI-generated
 * present-tense `description` ("Analyzing authentication module") plus the
 * name of the last tool the subagent called and cumulative usage.
 */
export const SubagentProgressPayload = z.object({
  taskId: z.string(),
  description: z.string(),
  lastToolName: z.string().optional(),
  summary: z.string().optional(),
  usage: SubagentUsage,
  at: z.string(),
});
export type SubagentProgressPayload = z.infer<typeof SubagentProgressPayload>;

/** `system/task_updated` — patch-shaped; each field is independently
 * optional (SDK only sends changed fields). The UI merges into its local
 * `SubagentRun` map keyed by `taskId`.
 */
export const SubagentUpdatePayload = z.object({
  taskId: z.string(),
  patch: z.object({
    status: SubagentLifecycleStatus.optional(),
    description: z.string().optional(),
    endTime: z.number().optional(),
    error: z.string().optional(),
    isBackgrounded: z.boolean().optional(),
  }),
  at: z.string(),
});
export type SubagentUpdatePayload = z.infer<typeof SubagentUpdatePayload>;

/** `system/task_notification` — terminal event. `outputFile` is the
 * SDK-produced artefact path (bash stdout, local_agent JSONL transcript,
 * remote_agent streamed output). For foreground local_agent runs the
 * `summary` is the subagent's final text; for background runs this is
 * where you read the result from.
 */
export const SubagentEndPayload = z.object({
  taskId: z.string(),
  status: SubagentLifecycleStatus,
  summary: z.string(),
  outputFile: z.string().optional(),
  usage: SubagentUsage.optional(),
  toolUseId: z.string().optional(),
  at: z.string(),
});
export type SubagentEndPayload = z.infer<typeof SubagentEndPayload>;

/** Top-level `tool_progress` — a long-running tool inside a subagent (or
 * the parent) has been executing for `elapsedSeconds`. Used to keep the
 * rail's "still alive" indicator ticking even between `task_progress`
 * heartbeats. `parentToolUseId` is non-null when the tool fired from
 * inside a subagent.
 */
export const SubagentToolProgressPayload = z.object({
  toolUseId: z.string(),
  toolName: z.string(),
  parentToolUseId: z.string().nullable(),
  elapsedSeconds: z.number(),
  taskId: z.string().optional(),
  at: z.string(),
});
export type SubagentToolProgressPayload = z.infer<
  typeof SubagentToolProgressPayload
>;

// ============================================================================
// Conversation compaction
//
// Surfaces the SDK's compaction lifecycle on the wire + in `session_events`.
// Two shapes:
//
//   - `CompactStatusPayload` — transient ping for the chat header: claude is
//     in the middle of compacting, or just finished. Not persisted (the same
//     information is carried by the boundary event below for resume).
//   - `CompactBoundaryPayload` — the actual boundary that was inserted into
//     the conversation. Persisted as a `compact_boundary` SessionEvent so
//     the transcript renders a divider on reload and exports preserve it.
//
// The SDK distinguishes manual (`/compact`) from automatic (window full)
// compaction via `trigger`; we surface that to the UI so the divider can say
// "compacted manually" vs "auto-compacted at N tokens".
// ============================================================================

export const CompactStatusPayload = z.object({
  /**
   * "start" when the SDK begins compacting (status=compacting),
   * "end" when it returns to idle (status=null with a compact_result).
   */
  phase: z.enum(["start", "end"]),
  result: z.enum(["success", "failed"]).optional(),
  error: z.string().optional(),
});
export type CompactStatusPayload = z.infer<typeof CompactStatusPayload>;

export const CompactBoundaryPayload = z.object({
  trigger: z.enum(["manual", "auto"]),
  preTokens: z.number().int().nonnegative(),
  postTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  at: z.string(),
});
export type CompactBoundaryPayload = z.infer<typeof CompactBoundaryPayload>;

// Body of the SDK's post-compaction summary. Carried as its own event because
// the SDK emits it asynchronously (it's an `isCompactSummary` line in the
// transcript JSONL, not a streamed SDKMessage). `boundaryAt` ties it back to
// the preceding `compact_boundary` row so the UI can fold it into the right
// divider; on reload the transcript reducer matches by `boundaryAt`.
export const CompactSummaryPayload = z.object({
  boundaryAt: z.string(),
  content: z.string(),
});
export type CompactSummaryPayload = z.infer<typeof CompactSummaryPayload>;

// ============================================================================
// Small request bodies lifted out of server routes so the web client can
// import the types rather than restating them. Kept at the bottom of the file
// because they don't belong to any of the larger thematic groups above.
// ============================================================================

// Body of `POST /api/projects/:id/trust`.
export const TrustProjectRequest = z.object({ trusted: z.boolean() });
export type TrustProjectRequest = z.infer<typeof TrustProjectRequest>;

// Body of `POST /api/sessions/:id/fork`. Both fields optional — server defaults
// are "fork at the latest event" and `"Fork of <source.title>"` (truncated at
// 60 chars) respectively. See the route handler for the authoritative contract.
export const ForkSessionRequest = z.object({
  upToSeq: z.number().int().nonnegative().optional(),
  title: z.string().max(200).optional(),
});
export type ForkSessionRequest = z.infer<typeof ForkSessionRequest>;

// Body of `POST /api/sessions/:id/rewind`. Rolls tracked files back to their
// state at the user message with this `upToSeq` (the CLI's own checkpoint
// feature — claudex forwards to the bundled CLI, which maintains the file
// history under ~/.claude/file-history). `dryRun` previews the changes
// without touching the filesystem; omit it to execute.
export const RewindSessionRequest = z.object({
  upToSeq: z.number().int().nonnegative(),
  dryRun: z.boolean().optional(),
});
export type RewindSessionRequest = z.infer<typeof RewindSessionRequest>;

// Response of `POST /api/sessions/:id/rewind` — mirrors the SDK's
// RewindFilesResult. `canRewind: false` + `error` explains why (no
// checkpoints on record, anchor unresolvable, …).
export const RewindSessionResult = z.object({
  canRewind: z.boolean(),
  error: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  insertions: z.number().optional(),
  deletions: z.number().optional(),
});
export type RewindSessionResult = z.infer<typeof RewindSessionResult>;

/** One user message in a session, as offered by the rewind/fork picker.
 *  Only user messages are valid CLI checkpoint anchors, so the picker
 *  endpoint returns just these — not the whole transcript. */
export const SessionUserMessage = z.object({
  seq: z.number().int(),
  text: z.string(),
  createdAt: z.string(),
});
export type SessionUserMessage = z.infer<typeof SessionUserMessage>;

export const SessionUserMessagesResponse = z.object({
  messages: z.array(SessionUserMessage),
});
export type SessionUserMessagesResponse = z.infer<
  typeof SessionUserMessagesResponse
>;

// Body of `POST /api/sessions/:id/edit-last-user-message`. Min length 1 so
// the endpoint refuses empty-string edits — clearing the message isn't a
// supported flow; the user should archive instead.
export const EditLastUserMessageRequest = z.object({ text: z.string().min(1) });
export type EditLastUserMessageRequest = z.infer<
  typeof EditLastUserMessageRequest
>;

// ============================================================================
// Meta / About
//
// Response for `GET /api/meta` — powers the `/about` screen. Static info
// (version, commit, buildTime, platform) is sampled once at server boot;
// `uptimeSec` is live per request. `commit`/`commitShort` are null when the
// server wasn't launched from a git checkout (Docker image, archive extract).
// ============================================================================

export const MetaResponse = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  commitShort: z.string().nullable(),
  buildTime: z.string(),
  nodeVersion: z.string(),
  sqliteVersion: z.string(),
  platform: z.string(),
  uptimeSec: z.number().nonnegative(),
});
export type MetaResponse = z.infer<typeof MetaResponse>;

// ============================================================================
// Latest GitHub release
//
// Response for `GET /api/meta/latest-release`. Lazily fetched (only on first
// request to the route) from GitHub's `releases/latest` endpoint, cached
// in-process for 1 hour. The endpoint returns:
//
//   - `tag`         — release tag, e.g. "v0.0.2"
//   - `name`        — release title, e.g. "v0.0.2 — minor fixes"
//   - `version`     — `tag` with leading `v` stripped, used for compare()
//   - `htmlUrl`     — link to the release page on GitHub
//   - `publishedAt` — ISO timestamp
//   - `body`        — release notes (truncated to 2KB, may be empty)
//   - `currentVersion` — server's package.json version, for client convenience
//   - `updateAvailable` — true when `version` > `currentVersion` (semver-ish
//                         compare, prerelease tags fall back to string compare)
//   - `fetchedAt`   — when the cache row was filled
//
// `error` is set instead of the rest when GitHub is unreachable or the
// response was unparseable; clients should render a muted "couldn't check"
// row, not a hard failure.
// ============================================================================

export const LatestReleaseResponse = z.union([
  z.object({
    ok: z.literal(true),
    tag: z.string(),
    name: z.string(),
    version: z.string(),
    htmlUrl: z.string(),
    publishedAt: z.string(),
    body: z.string(),
    currentVersion: z.string(),
    updateAvailable: z.boolean(),
    fetchedAt: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    currentVersion: z.string(),
    fetchedAt: z.string(),
  }),
]);
export type LatestReleaseResponse = z.infer<typeof LatestReleaseResponse>;

// ============================================================================
// Admin / self-restart
//
// Body for POST /api/admin/restart. Both fields optional — the legacy call
// with no body still works (and still restarts). When Claude triggers a
// restart mid-tool-call, it passes its own session id + the tool_use id so
// the server can persist a `pending_restart_results` row; the next boot's
// sweep then synthesizes a green tool_result event for that tool_use, so
// the chat UI doesn't render the restart as a failed tool call.
// ============================================================================

export const AdminRestartRequest = z.object({
  sessionId: z.string().optional(),
  toolUseId: z.string().optional(),
});
export type AdminRestartRequest = z.infer<typeof AdminRestartRequest>;

// Response shape (rarely consumed by clients — they usually treat any 2xx
// as "restart is underway" — but we export it so test code and the
// restart-self.mjs script can type-check the JSON they receive).
export const AdminRestartResponse = z.object({
  ok: z.literal(true),
  dryRun: z.boolean().optional(), // true in NODE_ENV=test; real restarts omit it
  restarterPid: z.number().optional(),
  port: z.number().optional(),
  log: z.string().optional(),
  pendingResult: z
    .object({ sessionId: z.string(), toolUseId: z.string() })
    .optional(),
});
export type AdminRestartResponse = z.infer<typeof AdminRestartResponse>;

// ============================================================================
// Update-and-restart — the About page's "Update now" button.
//
// POST /api/admin/update-and-restart  { tag: "v0.2.0" }
//
// Spawns a detached worker that git-fetches, checks out the given tag, runs
// pnpm install, waits for the port to drain, then relaunches the server.
// Response shape is identical to AdminRestartResponse because the client
// treats both the same: "restart is underway, poll health and reload."
// ============================================================================

export const UpdateAndRestartRequest = z.object({
  tag: z.string(), // GitHub release tag e.g. "v0.2.0"
});
export type UpdateAndRestartRequest = z.infer<typeof UpdateAndRestartRequest>;

// ============================================================================
// Files browser — read-only project file viewer served from the host disk.
//
// Three REST endpoints wire into one new screen (mockup s-14):
//   GET /api/files/tree?project=&path=      — one directory's entries
//   GET /api/files/read?project=&path=      — file contents (1 MB cap, text only)
//   GET /api/files/status?project=          — git working-tree summary
//
// SECURITY: the server resolves every `path` relative to the project root
// and rejects anything that escapes (`403 traversal_denied`). The resolver
// runs BEFORE any disk access keyed to the path — don't trust the string
// the client sent.
// ============================================================================

export const FilesTreeEntry = z.object({
  name: z.string(),
  // Relative to project root with `/` separators, even on Windows, so the
  // client can concat safely when drilling in.
  relPath: z.string(),
  isDir: z.boolean(),
  isHidden: z.boolean(), // leading-dot name (.git, .env, etc.)
  size: z.number().int().nonnegative().optional(), // bytes, files only
  mtimeMs: z.number().optional(),
  mode: z.string().optional(), // "-rw-r--r--"
  // Git status for this entry, if inside a git repo. M=modified, A=added,
  // D=deleted, R=renamed. null when outside a repo or unchanged.
  gitStatus: z.enum(["M", "A", "D", "R"]).nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type FilesTreeEntry = z.infer<typeof FilesTreeEntry>;

export const FilesTreeResponse = z.object({
  projectId: z.string(),
  projectRoot: z.string(), // absolute path, display-only
  relPath: z.string(), // dir that was listed
  entries: z.array(FilesTreeEntry),
});
export type FilesTreeResponse = z.infer<typeof FilesTreeResponse>;

export const FilesReadResponse = z.object({
  projectId: z.string(),
  relPath: z.string(),
  content: z.string(), // UTF-8, capped at 1 MB
  lines: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  mode: z.string(),
  truncated: z.boolean(), // true when file was larger than the cap
  gitStatus: z.enum(["M", "A", "D", "R"]).nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type FilesReadResponse = z.infer<typeof FilesReadResponse>;

export const FilesStatusEntry = z.object({
  relPath: z.string(),
  status: z.enum(["M", "A", "D", "R"]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type FilesStatusEntry = z.infer<typeof FilesStatusEntry>;

export const FilesStatusResponse = z.object({
  projectId: z.string(),
  branch: z.string().nullable(),
  totalAdditions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  entries: z.array(FilesStatusEntry),
  isGitRepo: z.boolean(),
});
export type FilesStatusResponse = z.infer<typeof FilesStatusResponse>;

// ============================================================================
// Session diff summary — GET /api/sessions/:id/session-diff
//
// Aggregates EVERY file-mutating tool call in the session (Edit / Write /
// MultiEdit) into a PR-shaped view. Unlike /pending-diffs (pending-only,
// for the permission card), this is the whole session's history. Mockup
// s-15. Computed on demand — no cache; sessions are bounded.
// ============================================================================

export const SessionDiffFileStatus = z.enum(["M", "A", "D", "R"]);
export type SessionDiffFileStatus = z.infer<typeof SessionDiffFileStatus>;

// How did this file change get reviewed?
//   accepted  — permission_decision: allow_once / allow_always
//   rejected  — permission_decision: deny
//   pending   — permission_request without a matching decision yet
//   auto      — no permission_request at all (acceptEdits / bypassPermissions)
export const SessionDiffApproval = z.enum([
  "accepted",
  "rejected",
  "pending",
  "auto",
]);
export type SessionDiffApproval = z.infer<typeof SessionDiffApproval>;

// One chronological step in the session timeline (right rail on desktop,
// collapsed card on mobile).
export const SessionDiffTimelineEntry = z.object({
  toolUseId: z.string(),
  action: z.enum(["write", "edit", "multiedit"]),
  filePath: z.string(),
  addCount: z.number().int().nonnegative(),
  delCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  approval: SessionDiffApproval,
});
export type SessionDiffTimelineEntry = z.infer<typeof SessionDiffTimelineEntry>;

// Aggregated diff for one file across all tool calls in the session.
export const SessionDiffFile = z.object({
  path: z.string(),
  status: SessionDiffFileStatus,
  addCount: z.number().int().nonnegative(),
  delCount: z.number().int().nonnegative(),
  hunks: z.array(DiffHunk),
  hunkCount: z.number().int().nonnegative(),
  // "Worst" approval across all edits to this file — pending wins over
  // auto, auto over accepted, accepted over rejected. Gives the file rail
  // a single status chip that tells the user whether this file still
  // needs their attention.
  approval: SessionDiffApproval,
});
export type SessionDiffFile = z.infer<typeof SessionDiffFile>;

export const SessionDiffResponse = z.object({
  files: z.array(SessionDiffFile),
  timeline: z.array(SessionDiffTimelineEntry),
  totals: z.object({
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative(),
  }),
  sessionTitle: z.string(),
  branch: z.string().nullable(),
  model: ModelId,
  status: SessionStatus,
  messageCount: z.number().int().nonnegative(),
});
export type SessionDiffResponse = z.infer<typeof SessionDiffResponse>;

// ============================================================================
// Alerts
//
// Persistent queue of "things that happened while the user may or may not
// have been looking". Replaces the earlier in-memory `completions` map on
// the web side; see migration 20 for the table shape and migration doc for
// the state-transition (not deletion) design.
//
// Each alert has two orthogonal state bits:
//   seen_at     — user opened the alerts screen / tapped the row
//   resolved_at — underlying condition cleared (e.g. session left `awaiting`)
//
// `AlertKind` is open-ended today — the three kinds below cover everything
// emitted by the status-transition hook, but we keep the union extensible
// for future kinds (routine failures, push delivery failures, …) without a
// schema bump.
// ============================================================================

export const AlertKind = z.enum([
  "permission_pending",
  "session_error",
  "session_completed",
]);
export type AlertKind = z.infer<typeof AlertKind>;

export const Alert = z.object({
  id: z.string(),
  kind: AlertKind,
  sessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  /** Kind-specific extras. Shape is left to the producer; consumers that
   *  care extract the fields they know about. `null` when there's nothing
   *  extra to carry. */
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  /** null = user has not looked yet. The badge count uses this. */
  seenAt: z.string().nullable(),
  /** null = the underlying condition is still active. */
  resolvedAt: z.string().nullable(),
});
export type Alert = z.infer<typeof Alert>;

// Response for GET /api/alerts
export const AlertsListResponse = z.object({
  alerts: z.array(Alert),
  unseenCount: z.number().int().nonnegative(),
});
export type AlertsListResponse = z.infer<typeof AlertsListResponse>;

// ============================================================================
// App settings (global user preferences for claudex itself)
// ============================================================================

/**
 * The 7 languages exposed in the Settings → Appearance picker plus "Auto"
 * (represented as `null`). The zod schema deliberately stays a free-form
 * `string` so we can add an "Other…" free-text field later without a schema
 * bump — the server stores whatever string the client sends and appends
 * `Please respond in <string>.` to the Claude Code system preset.
 */
export const SUPPORTED_LANGUAGES = [
  "chinese",
  "english",
  "japanese",
  "korean",
  "spanish",
  "french",
  "german",
] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * A user-defined custom model entry. Stored in `app_settings` as a JSON
 * array under the `custom_models` key. These models appear alongside the
 * built-in Claude models in all model selectors.
 *
 * `id` is the model string passed verbatim to the Claude Agent SDK's
 * `query({ model })` — it must match what the user's proxy accepts.
 * `label` is the human-readable display name shown in the UI.
 * `contextWindow` (optional) overrides the default 1M fallback used by
 * the context-percentage ring; omit for proxies that don't expose this.
 * `baseUrl` (optional) sets `ANTHROPIC_BASE_URL` for this model so the
 * CLI routes API requests through the user's proxy (OneAPI, New API, etc.).
 * `apiKey` (optional) sets `ANTHROPIC_API_KEY` for this model.
 */
export const CustomModel = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});
export type CustomModel = z.infer<typeof CustomModel>;

/**
 * Global claudex preferences, stored in the `app_settings` KV table
 * (migration 24). `null` on a field means "no override" — for `language`
 * that means defer to Claude Code's own `~/.claude/settings.json` (the
 * pre-feature behavior). For `customModels`, `null` or missing means no
 * custom models configured.
 */
export const AppSettings = z.object({
  language: z.string().nullable(),
  customModels: z.array(CustomModel).nullable(),
});
export type AppSettings = z.infer<typeof AppSettings>;

/**
 * `PATCH /api/app-settings` body. Every field is optional (partial update);
 * a field present with `null` clears that override.
 */
export const UpdateAppSettingsRequest = AppSettings.partial();
export type UpdateAppSettingsRequest = z.infer<typeof UpdateAppSettingsRequest>;

/** `GET /api/app-settings` response shape. */
export const AppSettingsResponse = z.object({
  settings: AppSettings,
});
export type AppSettingsResponse = z.infer<typeof AppSettingsResponse>;
