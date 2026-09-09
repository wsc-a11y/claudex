import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import type {
  PermissionDecision,
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
  RunnerListener,
} from "./runner.js";
import type {
  AskUserQuestionAnnotation,
  AskUserQuestionItem,
  EffortLevel,
  ModelId,
  PermissionMode,
} from "@claudex/shared";

/**
 * Real Agent SDK runner. One instance per session.
 *
 * Notes:
 *   - we drive the SDK with an async-iterable input queue so we can push
 *     follow-up user messages without restarting the subprocess
 *   - SDK session_id arrives on the first `system/init` message; we capture
 *     and emit it so the caller can persist & `resume` later turns
 *   - permission requests resolve via a per-toolUseId promise map, which
 *     the transport fulfils after the UI responds
 *   - env MUST be merged with process.env — the SDK replaces rather than
 *     extends it (v0.2.113 breaking change)
 */
export class AgentRunner implements Runner {
  readonly sessionId: string;
  private _sdkSessionId: string | null = null;
  private listeners = new Set<RunnerListener>();
  private pendingPermissions = new Map<
    string,
    (decision: PermissionDecision) => void
  >();
  // Pending AskUserQuestion interactions. Separate map from permissions so the
  // SDK tool branch can't collide with a genuine permission ask and so
  // double-submit protection is trivial (delete on first resolve).
  private pendingAskUserQuestion = new Map<
    string,
    (resp: {
      answers: Record<string, string>;
      annotations?: Record<string, AskUserQuestionAnnotation>;
    }) => void
  >();
  // Pending ExitPlanMode interactions. Keyed on the SDK toolUseID. Kept in a
  // separate map so accept/reject can't collide with a genuine permission
  // prompt or an AskUserQuestion — and so double-submit is an O(1) no-op
  // (delete on first resolve).
  private pendingPlanAccept = new Map<
    string,
    (decision: "accept" | "reject") => void
  >();
  private userMessages: AsyncPush<SDKUserMessageShape>;
  private sdkHandle: ReturnType<typeof query> | null = null;
  private disposed = false;
  private permissionMode: PermissionMode;
  private effort: EffortLevel;
  private currentModel: ModelId;
  // Per-call usage from the most recent SDK `assistant` message in the
  // current turn. We snapshot it here because the SDK only delivers the
  // (cumulative) `result.usage` at end-of-turn, but the context-window
  // ring needs the FINAL sub-call's prompt size — that's the one
  // `message.usage` carries on each assistant chunk. Reset to null
  // whenever a new turn starts (start / sendUserMessage) and after we
  // emit it on `result`.
  private lastAssistantUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  } | null = null;

  constructor(private readonly opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
    this.permissionMode = opts.permissionMode;
    this.effort = opts.effort ?? "medium";
    this.currentModel = opts.model;
    this.userMessages = new AsyncPush();
  }

  get sdkSessionId(): string | null {
    return this._sdkSessionId;
  }

  on(listener: RunnerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  private emit(ev: RunnerEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // a bad listener must not take down the runner
      }
    }
  }

  async start(initialPrompt?: string): Promise<void> {
    if (this.sdkHandle) return;
    if (this.disposed) throw new Error("runner disposed");

    // Claudex-global output-language override. When set, we append a single
    // sentence to the Claude Code system preset so Claude answers in the
    // requested language — matches what Claude Code's own `language` setting
    // does in `~/.claude/settings.json`, but without writing to that file
    // (claudex is barred from `~/.claude/`). Null / empty → omit
    // `systemPrompt` entirely so the SDK uses its default preset, preserving
    // the pre-feature behavior (including Claude Code's own `language` field
    // via the default `settingSources`).
    const language = (this.opts.language ?? "").trim();
    const systemPromptOption: Options["systemPrompt"] | undefined = language
      ? {
          type: "preset",
          preset: "claude_code",
          append: `Please respond in ${language}.`,
        }
      : undefined;

    const sdkOptions: Options = {
      cwd: this.opts.cwd,
      permissionMode: mapPermissionMode(this.permissionMode),
      // Always pass allowDangerouslySkipPermissions so the user can switch
      // to bypassPermissions at runtime via setPermissionMode. Without this
      // flag the SDK CLI child rejects the mode switch with "session was not
      // launched with --dangerously-skip-permissions". The actual permission
      // gate is controlled by permissionMode — setting it to "default" still
      // prompts for every tool; this flag merely arms the upgrade path.
      allowDangerouslySkipPermissions: true,
      model: this.currentModel,
      // MUST merge — SDK replaces process.env otherwise.
      env: {
        ...process.env,
        ...(this.opts.baseUrl
          ? { ANTHROPIC_BASE_URL: this.opts.baseUrl }
          : {}),
        ...(this.opts.apiKey
          ? { ANTHROPIC_API_KEY: this.opts.apiKey }
          : {}),
      } as Record<string, string>,
      resume: this.opts.resumeSdkSessionId,
      ...(systemPromptOption ? { systemPrompt: systemPromptOption } : {}),
      // Per-session thinking-effort level. The SDK maps this onto its
      // adaptive-thinking budget for us; `medium` matches the previous
      // default the codebase shipped with. We still explicitly ask for
      // summarized thinking display because Opus 4.7's default is
      // `"omitted"` — we want the UI to be able to render the summaries.
      thinking: { type: "adaptive", display: "summarized" },
      effort: this.effort,
      // Live subagents (s-17). Turn on the two SDK knobs that make a
      // Task/Agent/Explore child turn observable from the parent stream:
      //   forwardSubagentText — emit the child's text + thinking blocks as
      //     assistant/user messages with `parent_tool_use_id` set. Without
      //     this we only see the final outer tool_result.
      //   agentProgressSummaries — wake a ~30s heartbeat that forks the
      //     subagent to generate a present-tense activeForm description
      //     (e.g. "Analyzing authentication module"). Free on prompt cache.
      // `includePartialMessages` stays off — we don't need sub-token
      // streaming for this feature; the ~30s cadence + full text blocks
      // are enough to keep the rail lively.
      forwardSubagentText: true,
      agentProgressSummaries: true,
      canUseTool: (toolName, input, { toolUseID, title }) =>
        new Promise<
          | { behavior: "allow"; updatedInput?: Record<string, unknown> }
          | { behavior: "deny"; message: string }
        >((resolve) => {
          // AskUserQuestion is a multiple-choice interaction, not a security
          // gate. Branch early so the permission_request flow never fires for
          // it. The SDK expects `updatedInput` to match
          // `AskUserQuestionOutput` (answers + optional annotations) — we fill
          // that from whatever the client posts back via `resolveAskUserQuestion`.
          if (toolName === "AskUserQuestion") {
            const questions = extractAskUserQuestions(input);
            this.pendingAskUserQuestion.set(toolUseID, ({ answers, annotations }) => {
              const updatedInput: Record<string, unknown> = {
                ...input,
                answers,
              };
              if (annotations) updatedInput.annotations = annotations;
              resolve({ behavior: "allow", updatedInput });
            });
            this.emit({
              type: "ask_user_question",
              askId: toolUseID,
              questions,
            });
            return;
          }
          // ExitPlanMode — not a permission ask, the model is signalling
          // "ready to execute this plan?". Surface a dedicated event so the
          // UI can render its own card instead of falling through to the
          // generic "use ExitPlanMode" permission prompt.
          if (toolName === "ExitPlanMode") {
            const plan =
              typeof (input as { plan?: unknown }).plan === "string"
                ? ((input as { plan: string }).plan)
                : "";
            this.pendingPlanAccept.set(toolUseID, (decision) => {
              if (decision === "accept") {
                resolve({ behavior: "allow", updatedInput: input });
              } else {
                resolve({
                  behavior: "deny",
                  message: "plan not accepted — please revise",
                });
              }
            });
            this.emit({
              type: "plan_accept_request",
              planId: toolUseID,
              plan,
            });
            return;
          }
          this.pendingPermissions.set(toolUseID, (d) => {
            if (d.behavior === "allow") {
              resolve({ behavior: "allow", updatedInput: input });
            } else {
              resolve({
                behavior: "deny",
                message: d.reason ?? "user denied",
              });
            }
          });
          this.emit({
            type: "permission_request",
            toolUseId: toolUseID,
            toolName,
            input,
            title: title ?? `use ${toolName}`,
          });
        }),
      // By default Agent SDK loads user + project + CLAUDE.md.
      ...(this.opts.useProjectSettings === false
        ? { settingSources: [] as Options["settingSources"] }
        : {}),
    };

    this.emit({ type: "status", status: "starting" });

    this.sdkHandle = query({
      prompt: this.userMessages.iterator(),
      options: sdkOptions,
    });

    // Seed an initial user message if provided.
    if (initialPrompt) {
      this.userMessages.push(userMessage(initialPrompt));
    }

    // Consume the stream in the background.
    this.consume().catch((err) => {
      this.emit({
        type: "error",
        code: "runner_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      this.emit({ type: "status", status: "terminated" });
    });
  }

  private async consume(): Promise<void> {
    if (!this.sdkHandle) return;
    this.emit({ type: "status", status: "running" });
    for await (const msg of this.sdkHandle) {
      if (this.disposed) break;
      this.translate(msg);
    }
    this.emit({ type: "status", status: "terminated" });
  }

  private translate(msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          if (!this._sdkSessionId) {
            this._sdkSessionId = msg.session_id;
            this.emit({
              type: "sdk_session_id",
              sdkSessionId: msg.session_id,
            });
          }
          return;
        }
        // Live subagents (s-17). The SDK ferries the child subagent's
        // lifecycle through the parent session's SDKMessage stream as
        // `system/task_*` subtypes. `task_id` is the SDK's stable per-run
        // id; `tool_use_id` is the outer parent tool_use that launched it
        // (same id clients see on the parent's `tool_use` event). For the
        // SDK shape see agentSdkTypes.d.ts:
        //   SDKTaskStartedMessage, SDKTaskProgressMessage,
        //   SDKTaskUpdatedMessage, SDKTaskNotificationMessage.
        if (msg.subtype === "task_started") {
          const m = msg as any;
          this.emit({
            type: "subagent_start",
            taskId: String(m.task_id ?? ""),
            parentToolUseId: typeof m.tool_use_id === "string" ? m.tool_use_id : null,
            description: String(m.description ?? ""),
            agentType: typeof m.task_type === "string" ? m.task_type : undefined,
            taskType: typeof m.task_type === "string" ? m.task_type : undefined,
            workflowName:
              typeof m.workflow_name === "string" ? m.workflow_name : undefined,
            prompt: typeof m.prompt === "string" ? m.prompt : undefined,
            isBackgrounded:
              typeof m.is_backgrounded === "boolean"
                ? m.is_backgrounded
                : undefined,
            at: new Date().toISOString(),
          });
          return;
        }
        if (msg.subtype === "task_progress") {
          const m = msg as any;
          const usageSrc = (m.usage ?? {}) as Record<string, unknown>;
          this.emit({
            type: "subagent_progress",
            taskId: String(m.task_id ?? ""),
            description: String(m.description ?? ""),
            lastToolName:
              typeof m.last_tool_name === "string"
                ? m.last_tool_name
                : undefined,
            summary: typeof m.summary === "string" ? m.summary : undefined,
            usage: {
              totalTokens:
                typeof usageSrc.total_tokens === "number"
                  ? (usageSrc.total_tokens as number)
                  : undefined,
              toolUses:
                typeof usageSrc.tool_uses === "number"
                  ? (usageSrc.tool_uses as number)
                  : undefined,
              durationMs:
                typeof usageSrc.duration_ms === "number"
                  ? (usageSrc.duration_ms as number)
                  : undefined,
            },
            at: new Date().toISOString(),
          });
          return;
        }
        if (msg.subtype === "task_updated") {
          const m = msg as any;
          const p = (m.patch ?? {}) as Record<string, unknown>;
          const status =
            p.status === "running" ||
            p.status === "completed" ||
            p.status === "failed" ||
            p.status === "stopped"
              ? p.status
              : p.status === "killed"
                ? "stopped"
                : p.status === "pending"
                  ? "running"
                  : undefined;
          this.emit({
            type: "subagent_update",
            taskId: String(m.task_id ?? ""),
            patch: {
              ...(status !== undefined ? { status } : {}),
              ...(typeof p.description === "string"
                ? { description: p.description }
                : {}),
              ...(typeof p.end_time === "number" ? { endTime: p.end_time } : {}),
              ...(typeof p.error === "string" ? { error: p.error } : {}),
              ...(typeof p.is_backgrounded === "boolean"
                ? { isBackgrounded: p.is_backgrounded }
                : {}),
            },
            at: new Date().toISOString(),
          });
          return;
        }
        if (msg.subtype === "task_notification") {
          const m = msg as any;
          const usageSrc = m.usage ? (m.usage as Record<string, unknown>) : null;
          const status =
            m.status === "completed" || m.status === "failed" || m.status === "stopped"
              ? m.status
              : "completed";
          this.emit({
            type: "subagent_end",
            taskId: String(m.task_id ?? ""),
            status,
            summary: String(m.summary ?? ""),
            outputFile:
              typeof m.output_file === "string" ? m.output_file : undefined,
            toolUseId:
              typeof m.tool_use_id === "string" ? m.tool_use_id : undefined,
            usage: usageSrc
              ? {
                  totalTokens:
                    typeof usageSrc.total_tokens === "number"
                      ? (usageSrc.total_tokens as number)
                      : undefined,
                  toolUses:
                    typeof usageSrc.tool_uses === "number"
                      ? (usageSrc.tool_uses as number)
                      : undefined,
                  durationMs:
                    typeof usageSrc.duration_ms === "number"
                      ? (usageSrc.duration_ms as number)
                      : undefined,
                }
              : undefined,
            at: new Date().toISOString(),
          });
          return;
        }
        // Conversation compaction. SDK emits two distinct system messages
        // around `/compact` (manual) or auto-compaction:
        //   - `system/status` with `status: "compacting"` (start)
        //   - `system/status` with `status: null` + `compact_result`
        //     ("success"/"failed") + optional `compact_error` (end)
        //   - `system/compact_boundary` carrying the actual `compact_metadata`
        // We surface the status as a transient UI hint (no persistence) and
        // persist the boundary as a `compact_boundary` event so the
        // transcript can render a divider on reload.
        if (msg.subtype === "status") {
          const m = msg as any;
          const status = m.status;
          if (status === "compacting") {
            this.emit({ type: "compact_status", phase: "start" });
            return;
          }
          if (status === null && (m.compact_result || m.compact_error)) {
            this.emit({
              type: "compact_status",
              phase: "end",
              ...(m.compact_result === "success" || m.compact_result === "failed"
                ? { result: m.compact_result as "success" | "failed" }
                : {}),
              ...(typeof m.compact_error === "string"
                ? { error: m.compact_error }
                : {}),
            });
            return;
          }
          // Other status transitions (e.g. status: "requesting") aren't
          // surfaced today — the existing per-event flow already conveys
          // "running" / "idle" elsewhere.
          return;
        }
        if (msg.subtype === "compact_boundary") {
          const m = msg as any;
          const meta = (m.compact_metadata ?? {}) as Record<string, unknown>;
          const trigger =
            meta.trigger === "manual" || meta.trigger === "auto"
              ? (meta.trigger as "manual" | "auto")
              : "manual";
          const preTokens = Number(meta.pre_tokens ?? 0) | 0;
          const postTokens =
            typeof meta.post_tokens === "number"
              ? Math.max(0, Math.floor(meta.post_tokens as number))
              : undefined;
          const durationMs =
            typeof meta.duration_ms === "number"
              ? Math.max(0, Math.floor(meta.duration_ms as number))
              : undefined;
          // After compaction, the prompt the model will see on the next turn
          // is reconstructed from a fresh summary — the previous turn's
          // per-call snapshot has nothing to do with the post-compaction
          // window. Drop it so the next `turn_end` falls back to
          // billingUsage / historical-turn guard rather than reporting a
          // pre-compaction prompt size against the new context window.
          this.lastAssistantUsage = null;
          const at = new Date().toISOString();
          this.emit({
            type: "compact_boundary",
            trigger,
            preTokens,
            ...(postTokens !== undefined ? { postTokens } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            at,
          });
          // Kick off summary harvest. The SDK marks the summary line
          // `isVisibleInTranscriptOnly: true` so it never reaches us via the
          // streamed SDKMessage path — we have to tail its JSONL ourselves.
          // Fire-and-forget; the boundary divider already rendered, the
          // summary is just an enrichment that drops in when ready.
          this.harvestCompactSummary(at).catch(() => {});
          return;
        }
        return;
      case "tool_progress": {
        // SDK heartbeat for a long-running tool. Also carries
        // `parent_tool_use_id` so the s-17 rail can tick its "still alive"
        // indicator even while the subagent has no fresh text or tool_use
        // block. For non-subagent tools (parent_tool_use_id is null) we
        // still emit — the main-thread view can use it as a progress hint.
        const m = msg as any;
        this.emit({
          type: "subagent_tool_progress",
          toolUseId: String(m.tool_use_id ?? ""),
          toolName: String(m.tool_name ?? ""),
          parentToolUseId:
            typeof m.parent_tool_use_id === "string"
              ? m.parent_tool_use_id
              : null,
          elapsedSeconds: Number(m.elapsed_time_seconds ?? 0),
          taskId: typeof m.task_id === "string" ? m.task_id : undefined,
          at: new Date().toISOString(),
        });
        return;
      }
      case "assistant": {
        const id = (msg as any).uuid ?? nanoid(12);
        const parentToolUseId =
          typeof (msg as any).parent_tool_use_id === "string"
            ? ((msg as any).parent_tool_use_id as string)
            : undefined;
        // Snapshot per-call usage for the context-window ring. The SDK
        // attaches the underlying API response's `Usage` to each
        // assistant message; the LAST one we see in a turn carries the
        // final sub-call's prompt size (`cache_read + cache_create +
        // input` of THAT call). We overwrite each time so when `result`
        // lands we have the freshest per-call snapshot. Top-level
        // assistants only — subagent assistant messages (with
        // `parent_tool_use_id`) carry the subagent's context body, not
        // the parent session's, and shouldn't drive the parent's ring.
        if (!parentToolUseId) {
          const callUsage = (msg.message as any)?.usage;
          if (callUsage) {
            this.lastAssistantUsage = {
              inputTokens: Number(callUsage.input_tokens ?? 0),
              outputTokens: Number(callUsage.output_tokens ?? 0),
              cacheReadInputTokens: Number(
                callUsage.cache_read_input_tokens ?? 0,
              ),
              cacheCreationInputTokens: Number(
                callUsage.cache_creation_input_tokens ?? 0,
              ),
            };
          }
        }
        const content = msg.message?.content ?? [];
        for (const block of content as Array<any>) {
          if (block.type === "text" && typeof block.text === "string") {
            this.emit({
              type: "assistant_text",
              messageId: id,
              text: block.text,
              done: true,
              ...(parentToolUseId ? { parentToolUseId } : {}),
            });
          } else if (
            block.type === "thinking" &&
            typeof block.thinking === "string"
          ) {
            this.emit({
              type: "thinking",
              text: block.thinking,
              ...(parentToolUseId ? { parentToolUseId } : {}),
            });
          } else if (block.type === "tool_use") {
            this.emit({
              type: "tool_use",
              toolUseId: String(block.id ?? nanoid(12)),
              name: String(block.name ?? "unknown"),
              input: (block.input as Record<string, unknown>) ?? {},
              ...(parentToolUseId ? { parentToolUseId } : {}),
            });
          }
        }
        return;
      }
      case "user": {
        const parentToolUseId =
          typeof (msg as any).parent_tool_use_id === "string"
            ? ((msg as any).parent_tool_use_id as string)
            : undefined;
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<any>) {
            if (block.type === "tool_result") {
              const text =
                typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .map((c: any) =>
                          c.type === "text" ? c.text : JSON.stringify(c),
                        )
                        .join("\n")
                    : JSON.stringify(block.content ?? "");
              this.emit({
                type: "tool_result",
                toolUseId: String(block.tool_use_id ?? ""),
                content: text,
                isError: Boolean(block.is_error),
                ...(parentToolUseId ? { parentToolUseId } : {}),
              });
            }
          }
        }
        return;
      }
      case "result": {
        // Diagnostic: log both the cumulative `result.usage` and the
        // per-call snapshot from the last assistant message. The Usage
        // ring uses the per-call number (the FINAL sub-call's prompt
        // size); the cumulative number drives billing-style totals.
        // Logging both makes a "ring shows 100%+ on a long turn" report
        // diagnosable from server logs alone.
        const rawUsage = (msg as { usage?: unknown }).usage ?? null;
        if (this.opts.logger) {
          this.opts.logger.info(
            {
              sessionId: this.sessionId,
              billingUsage: rawUsage,
              perCallUsage: this.lastAssistantUsage,
            },
            "turn_end usage",
          );
        }
        const cumulative = msg.usage
          ? {
              inputTokens: Number((msg.usage as any).input_tokens ?? 0),
              outputTokens: Number((msg.usage as any).output_tokens ?? 0),
              cacheReadInputTokens: Number(
                (msg.usage as any).cache_read_input_tokens ?? 0,
              ),
              cacheCreationInputTokens: Number(
                (msg.usage as any).cache_creation_input_tokens ?? 0,
              ),
            }
          : undefined;
        // `usage` carries the per-call snapshot when we have one (the
        // common case: a turn with at least one top-level assistant
        // message). Fall back to the cumulative value only when no
        // assistant message arrived during the turn — extremely rare and
        // mostly preserves backward compat for historical edge cases.
        const perCall = this.lastAssistantUsage ?? cumulative;
        this.emit({
          type: "turn_end",
          stopReason: msg.subtype ?? "end_turn",
          ...(perCall ? { usage: perCall } : {}),
          ...(cumulative ? { billingUsage: cumulative } : {}),
        });
        this.lastAssistantUsage = null;
        this.emit({ type: "status", status: "idle" });
        return;
      }
    }
  }

  async sendUserMessage(content: string): Promise<void> {
    if (!this.sdkHandle) {
      await this.start(content);
      return;
    }
    this.userMessages.push(userMessage(content));
  }

  resolvePermission(toolUseId: string, decision: PermissionDecision): void {
    const resolver = this.pendingPermissions.get(toolUseId);
    if (!resolver) return;
    this.pendingPermissions.delete(toolUseId);
    resolver(decision);
  }

  resolveAskUserQuestion(
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ): void {
    const resolver = this.pendingAskUserQuestion.get(askId);
    if (!resolver) return;
    // Delete BEFORE calling so a second resolve races cleanly (no-op).
    this.pendingAskUserQuestion.delete(askId);
    resolver({ answers, annotations });
  }

  resolvePlanAccept(planId: string, decision: "accept" | "reject"): void {
    const resolver = this.pendingPlanAccept.get(planId);
    if (!resolver) return;
    // Delete BEFORE calling so a second resolve races cleanly (no-op).
    this.pendingPlanAccept.delete(planId);
    resolver(decision);
  }

  async interrupt(): Promise<void> {
    if (!this.sdkHandle) return;
    await this.sdkHandle.interrupt();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    if (this.sdkHandle) {
      await this.sdkHandle.setPermissionMode(mapPermissionMode(mode));
    }
  }

  async setModel(model: ModelId): Promise<void> {
    // Cache so a future start() (e.g. after a server restart that
    // re-instantiates the runner) picks up the latest choice. The SDK's
    // `setModel` is the live channel — it takes effect from the next SDK
    // turn (in-flight queries keep the model they were launched with,
    // mirroring how the SDK itself scopes the change).
    this.currentModel = model;
    if (this.sdkHandle) {
      await this.sdkHandle.setModel(model);
    }
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    // The SDK's `thinking` option is start-time only — there's no
    // equivalent of `setPermissionMode` for it. Store the new level so the
    // NEXT start() picks it up; an in-flight query keeps the budget it was
    // launched with. That mirrors how model changes propagate today.
    this.effort = effort;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.userMessages.close();
    // Reject all outstanding permissions so the SDK loop can exit.
    for (const [id, resolver] of this.pendingPermissions) {
      resolver({ behavior: "deny", reason: "runner disposed" });
    }
    this.pendingPermissions.clear();
    // Resolve any pending AskUserQuestion with empty answers — the SDK doesn't
    // accept a "deny" shape for allow-only tools, and leaving these hanging
    // would keep the query loop alive past dispose().
    for (const [id, resolver] of this.pendingAskUserQuestion) {
      resolver({ answers: {} });
    }
    this.pendingAskUserQuestion.clear();
    // Reject any pending plan_accept_request so the SDK loop can unwind. The
    // model sees a tool error — acceptable fallback when the runner's being
    // torn down anyway.
    for (const [id, resolver] of this.pendingPlanAccept) {
      resolver("reject");
    }
    this.pendingPlanAccept.clear();
    try {
      await this.sdkHandle?.interrupt();
    } catch {
      // ignore
    }
    this.listeners.clear();
  }

  /**
   * Tail the SDK transcript JSONL until the summary line written after a
   * `compact_boundary` shows up, then emit it as a `compact_summary` event.
   *
   * Background: the SDK writes the post-compaction summary as a `user`
   * record with `isCompactSummary: true` and `isVisibleInTranscriptOnly:
   * true`. The latter flag means it never streams as an SDKMessage, so the
   * `query()` async iterator we consume in `start()` cannot see it. The
   * only authoritative source is the JSONL file the SDK writes itself.
   *
   * Strategy:
   *   - resolve the transcript path from cwd + sdk session id (mirrors the
   *     `~/.claude/projects/<slug>/<sid>.jsonl` layout)
   *   - poll: read the last ~256 KB, scan from the end, stop on the first
   *     `isCompactSummary: true` line whose timestamp >= the boundary's `at`
   *   - retry every 250 ms for up to ~12 s — the summary normally lands
   *     within a second or two of the boundary even on long transcripts
   *
   * Failure modes are silent: the divider already rendered, missing summary
   * is recoverable (the user can still continue working). We only log on
   * unexpected exceptions to keep the boundary→summary lifecycle quiet.
   */
  private async harvestCompactSummary(boundaryAt: string): Promise<void> {
    const sdkSid = this._sdkSessionId;
    if (!sdkSid) return;
    const cwd = this.opts.cwd;
    if (!cwd) return;
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const slug = cwd.replace(/[/.]/g, "-");
    const file = path.join(home, ".claude", "projects", slug, `${sdkSid}.jsonl`);
    const boundaryMs = Date.parse(boundaryAt) || 0;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (this.disposed) return;
      try {
        const content = await readTail(fs, file, 256 * 1024);
        if (content) {
          const summary = findCompactSummary(content, boundaryMs);
          if (summary) {
            this.emit({
              type: "compact_summary",
              boundaryAt,
              content: summary,
            });
            return;
          }
        }
      } catch {
        // file not yet created / transient — retry
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Read up to `bytes` from the end of `file`. Returns null if the file is
 * missing or empty. Non-fatal — callers retry on falsy return.
 */
async function readTail(
  fs: typeof import("node:fs/promises"),
  file: string,
  bytes: number,
): Promise<string | null> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return null;
    const length = Math.min(bytes, stat.size);
    const start = stat.size - length;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Scan a tail-read JSONL chunk from the end, looking for the most recent
 * `user` row with `isCompactSummary: true` whose `timestamp` is >= the
 * boundary's. Returns the message text, or null if no match.
 *
 * The first line of `tail` is almost always partial — we drop it. The text
 * lives at `message.content` as either a string (the SDK's current shape)
 * or a content-block array; both are normalized to a single string.
 */
function findCompactSummary(tail: string, boundaryMs: number): string | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i];
    if (!line) continue;
    if (!line.includes("isCompactSummary")) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.isCompactSummary !== true) continue;
    if (boundaryMs > 0) {
      const ts = Date.parse(row?.timestamp || "");
      // Allow 1s of clock skew between SDK timestamp and our boundaryAt.
      if (!Number.isFinite(ts) || ts + 1000 < boundaryMs) continue;
    }
    const c = row?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const block of c) {
        if (block && typeof block === "object" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      const joined = parts.join("");
      return joined || null;
    }
  }
  return null;
}

export const agentRunnerFactory: RunnerFactory = {
  create(opts) {
    return new AgentRunner(opts);
  },
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Map our surface permission mode → SDK permission mode. Pass-through since
// SDK 0.2.132 typed `'auto'` (the MVP-era fallback that downgraded auto to
// "default" was written when the SDK rejected the value — it's been stale
// since the SDK shipped support). Whether auto actually behaves autonomously
// is the CLI's call: the permission classifier runs wherever the user points
// ANTHROPIC_BASE_URL, and claudex just relays the choice + the prompt cards.
function mapPermissionMode(mode: PermissionMode): NonNullable<Options["permissionMode"]> {
  switch (mode) {
    case "default":
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
    case "auto":
      return mode;
    default:
      return "default";
  }
}

type SDKUserMessageShape = SDKUserMessage;

/**
 * Narrow the AskUserQuestion tool input into the shape the rest of claudex
 * uses. The SDK's `AskUserQuestionInput` type is strict (tuples of 2-4
 * options), but at runtime we accept whatever arrives and let the UI render
 * it. Unknown fields pass through verbatim.
 */
function extractAskUserQuestions(
  input: Record<string, unknown>,
): AskUserQuestionItem[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qo = q as Record<string, unknown>;
    const question = typeof qo.question === "string" ? qo.question : "";
    if (!question) continue;
    const header = typeof qo.header === "string" ? qo.header : undefined;
    const multiSelect =
      typeof qo.multiSelect === "boolean" ? qo.multiSelect : undefined;
    const options: AskUserQuestionItem["options"] = [];
    if (Array.isArray(qo.options)) {
      for (const opt of qo.options) {
        if (!opt || typeof opt !== "object") continue;
        const oo = opt as Record<string, unknown>;
        if (typeof oo.label !== "string") continue;
        options.push({
          label: oo.label,
          description:
            typeof oo.description === "string" ? oo.description : undefined,
          preview: typeof oo.preview === "string" ? oo.preview : undefined,
        });
      }
    }
    out.push({ question, header, multiSelect, options });
  }
  return out;
}

function userMessage(text: string): SDKUserMessageShape {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessageShape;
}

/**
 * Tiny async-iterable queue. Producers call .push(); the iterator resolves
 * when values arrive and terminates when .close() is called.
 */
class AsyncPush<T> {
  private queue: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as any, done: true });
    }
  }

  iterator(): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (self.queue.length > 0) {
              return Promise.resolve({
                value: self.queue.shift()!,
                done: false,
              });
            }
            if (self.closed) {
              return Promise.resolve({ value: undefined as any, done: true });
            }
            return new Promise((res) => self.resolvers.push(res));
          },
          async return(): Promise<IteratorResult<T>> {
            self.close();
            return { value: undefined as any, done: true };
          },
        };
      },
    };
  }
}
