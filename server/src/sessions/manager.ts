import type { FastifyBaseLogger } from "fastify";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
} from "./runner.js";
import type { RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import type { SessionStore } from "./store.js";
import type { ProjectStore } from "./projects.js";
import { ToolGrantStore, signatureFor } from "./grants.js";
import { summarizePermission } from "./permission-summary.js";
import type { AuditStore } from "../audit/store.js";
import type { AttachmentStore } from "../uploads/store.js";
import type { AppSettingsStore } from "../settings/store.js";
import type {
  AskUserQuestionAnnotation,
  ModelId,
  SessionStatus,
} from "@claudex/shared";
import { HISTORICAL_TURN_THRESHOLD, contextWindowTokens } from "@claudex/shared";

type Broadcaster = (sessionId: string, event: RunnerEvent) => void;

/**
 * Narrow surface the manager needs from the push module. Accepts the full
 * payload shape used by `sendToAll` over in `push/routes.ts`. Kept as a
 * separate interface so we don't have to import the routes module (which
 * pulls in fastify) from the manager — and so tests can stub it with a plain
 * spy.
 */
export interface ManagerPushSender {
  sendToAll(payload: {
    title: string;
    body: string;
    data: { sessionId: string; url: string };
  }): Promise<{ sent: number; pruned: number }>;
}

export interface SessionManagerDeps {
  sessions: SessionStore;
  projects: ProjectStore;
  grants: ToolGrantStore;
  runnerFactory: RunnerFactory;
  broadcast: Broadcaster;
  logger?: FastifyBaseLogger;
  /**
   * Optional audit sink. The manager is reachable from non-HTTP paths (WS
   * handlers, scheduler) so a user id can't always be threaded in — we
   * append with userId=null in those cases and the Security card still
   * shows "Granted: Bash <cmd>" / "Denied: …" honestly.
   */
  audit?: AuditStore;
  /**
   * Optional attachment store + uploads root. When both are provided, the
   * manager resolves `attachmentIds` passed to `sendUserMessage`, prefixes
   * the outgoing SDK prompt with `@<absolute-path>` tokens so the SDK's
   * Read tool can pick up the files, and stamps each row's
   * `message_event_seq` with the user_message seq that was just appended.
   * Missing / empty is a no-op — matches the contract in tests that don't
   * need uploads.
   */
  attachments?: AttachmentStore;
  /**
   * Optional global claudex preferences. Read once per runner-create to
   * seed the SDK's `systemPrompt` with the user's language override, if
   * any. Missing in tests / contexts that don't care — the runner falls
   * back to the SDK default preset (= no override) when undefined.
   */
  appSettings?: AppSettingsStore;
}

interface SessionEntry {
  runner: Runner;
  off: () => void;
  // Side-chat context seed: a synthetic user message to send to the SDK
  // before the user's *first* real message. Captures the main thread so
  // claude has grounding, but we explicitly don't persist it into
  // `session_events` — the transcript should only show what the user
  // actually typed into the side chat.
  pendingSeed: string | null;
}

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

/**
 * Max length (code units) of an auto-generated session title before we
 * truncate + ellipsize. 60 is the Claude Code CLI feel: long enough to
 * recognize a prompt at a glance on mobile, short enough not to wrap.
 */
const AUTO_TITLE_MAX_LEN = 60;

/**
 * Should the session's current title be overwritten by an auto-title
 * derived from the user's first message?
 *
 * Heuristic: empty / whitespace-only, OR a "placeholder" single-word
 * blob of ≤3 words. Anything with 4+ words we treat as user-chosen
 * and leave alone. Mirrors how people actually fill the New Session
 * sheet: they either skip it (→ "Untitled" default), type a few
 * letters ("t", "demo", "test 1"), or write a real title.
 */
function shouldAutoRetitle(current: string): boolean {
  const trimmed = current.trim();
  if (trimmed.length === 0) return true;
  // "Untitled" is the server default when title is omitted on create.
  if (trimmed === "Untitled") return true;
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  return words.length <= 3;
}

/**
 * Turn a user's first message into a session title.
 *
 * Rules:
 *   1. trim leading/trailing whitespace
 *   2. take only up to the first newline (titles are one-line)
 *   3. if that's ≤ AUTO_TITLE_MAX_LEN chars, use it verbatim
 *   4. otherwise truncate to AUTO_TITLE_MAX_LEN, back up to the last
 *      whole-word boundary (whitespace), and append a single-char
 *      ellipsis "…". We back up at most ~15 chars to avoid
 *      pathological "one giant word" inputs producing a title of just
 *      the ellipsis; if no good boundary exists, truncate hard.
 */
function deriveTitleFromMessage(raw: string): string {
  const firstLine = raw.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "";
  if (firstLine.length <= AUTO_TITLE_MAX_LEN) return firstLine;

  const hard = firstLine.slice(0, AUTO_TITLE_MAX_LEN);
  const lastSpace = hard.lastIndexOf(" ");
  // Require the word boundary to leave us with at least ~45 chars of
  // title — otherwise we'd rather truncate mid-word than produce a
  // uselessly short title.
  const cut = lastSpace >= AUTO_TITLE_MAX_LEN - 15 ? lastSpace : AUTO_TITLE_MAX_LEN;
  return hard.slice(0, cut).trimEnd() + "…";
}

// Exposed for unit tests — these are intentionally pure helpers so they
// can be tested without spinning up a full SessionManager harness.
export const __testables = { shouldAutoRetitle, deriveTitleFromMessage };

/**
 * Pick the "most relevant" field from a tool-use input to show on a push
 * notification body. Covers every tool we currently summarize for
 * permission requests — extend here when new tool shapes land. Returns
 * null when nothing useful is present; caller falls back to the tool name.
 */
function pickPushSubject(input: Record<string, unknown>): string | null {
  const order = [
    "command", // Bash
    "file_path", // Edit / Write / MultiEdit / Read
    "path",
    "pattern", // Glob / Grep
    "url", // WebFetch
    "query", // WebSearch
  ];
  for (const key of order) {
    const v = input[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Clip a string to `max` code units for push-notification body text, adding
 * a single-char ellipsis when clipping. Kept intentionally simple — we
 * don't try to respect word boundaries because many push subjects are paths
 * or commands where a word boundary isn't well-defined.
 */
function truncateForPush(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(1, max - 1)) + "…";
}

/**
 * Default window of runner silence after which the watchdog takes action.
 *
 * Two paths with different semantics (see `logWatchdogSilence` vs
 * `recoverStaleSessionToIdle`):
 *   - **Live timer** (session active, in-process): after this long without
 *     any runner event we just log a warning. We used to force-transition
 *     the row to `error` here — that was wrong. A long tool call can
 *     legitimately go silent (a 15-min `pnpm install`, a slow WebFetch,
 *     the model chewing through a big patch) and the previous behaviour
 *     locked the composer out mid-work. Status stays put; the user keeps
 *     Send and Stop, and the existing `POST /api/sessions/:id/force-idle`
 *     escape hatch (surfaced in SessionSettingsSheet) handles the rare
 *     "runner is truly stuck" case.
 *   - **On-boot sweep**: stale rows are recovered to `idle` (not `error`).
 *     The runner subprocess definitionally did not survive a server
 *     restart, so `idle` is the accurate status; the composer unlocks and
 *     the user's next message spawns a fresh runner.
 *
 * Overridable at boot via `CLAUDEX_SESSION_WATCHDOG_MS` for tests and
 * operators who want a faster/slower leash.
 */
const DEFAULT_SESSION_WATCHDOG_MS = 5 * 60 * 1000;

export class SessionManager {
  private runners = new Map<string, SessionEntry>();
  // Track pending permission requests by toolUseId so we can look up the tool
  // name / input when the user sends back a decision (for "allow_always").
  private pendingByApproval = new Map<
    string,
    { sessionId: string; toolName: string; input: Record<string, unknown> }
  >();
  // Optional: attached by the server on boot so every `permission_request`
  // fires a Web Push to the user's paired phone. Null in tests and when VAPID
  // keys aren't configured — the rest of the manager must keep working.
  private pushSender: ManagerPushSender | null = null;

  // Per-session watchdog timers. A runner that emits NO events for
  // `CLAUDEX_SESSION_WATCHDOG_MS` (default 5 min) while the session is in
  // an active state gets a diagnostic pino warn line — **no** status change,
  // **no** transcript event, **no** broadcast. The previous force-to-`error`
  // behaviour locked the composer out whenever a long tool call went quiet;
  // in practice that fired on legitimately-running sessions far more often
  // than it caught actually-dead ones. The on-boot sweep is the path that
  // still takes action (recovers stale rows to `idle`) because at that point
  // the runner process is definitionally gone.
  private watchdogs = new Map<string, NodeJS.Timeout>();

  /**
   * Optional hook fired after every session status transition. Wired by
   * the app layer to the alerts store so that:
   *   - a transition INTO `awaiting` / `error`  → insert an alert row
   *   - a transition OUT OF `awaiting` / `error`  → auto-resolve the
   *     matching open alert(s) for that session
   *   - a transition INTO `idle` after `running`  → best-effort insert a
   *     session_completed alert (the hook decides whether to emit based on
   *     its own "was the user looking?" heuristic)
   *
   * The hook must never throw — errors are swallowed upstream so a flaky
   * alerts path can't crash the runner event loop. Null when the app
   * doesn't wire alerts (tests that build a bare manager).
   */
  private alertHook:
    | ((
        sessionId: string,
        from: SessionStatus | null,
        to: SessionStatus,
      ) => void)
    | null = null;

  constructor(private readonly deps: SessionManagerDeps) {}

  /**
   * On-boot sweep over rows stuck in active states (`running` / `awaiting`).
   * In-memory watchdog timers don't survive a server restart, so any session
   * that was active when the process exited would otherwise stay in its
   * active state forever with no timer to force-transition it.
   *
   * Policy per row:
   *   - `now - updated_at > watchdogMs`  → runner did not survive the
   *     restart. Recover to `idle` (append a `watchdog_timeout` error event
   *     for forensic visibility, audit `session_watchdog_swept`, broadcast
   *     `status:idle`). The composer unlocks and the next user message
   *     spawns a fresh runner. (We used to flip to `error` here; that made
   *     the chat banner scream "Session errored — start a new session" on
   *     every restart even though the previous work was salvageable.)
   *   - still within the window         → re-arm a watchdog timer for the
   *     *remaining* time, so it fires at the same wall-clock moment it
   *     would've on an uninterrupted server. (The re-armed live timer is
   *     now log-only, so this mostly exists for operator visibility.)
   *
   * Called explicitly by `buildApp` once after the manager is constructed so
   * tests (which inject a bare manager directly) can run without the sweep
   * mutating their DB.
   */
  sweepStuckOnBoot(): void {
    const ms = this.watchdogWindowMs();
    const now = Date.now();
    const candidates = this.deps.sessions.listByStatuses([
      "running",
      "awaiting",
    ]);
    for (const row of candidates) {
      const updatedMs = Date.parse(row.updatedAt);
      if (!Number.isFinite(updatedMs)) {
        // Malformed timestamp — treat as stale and recover to idle. Better
        // to unlock the composer than leave a row in a permanently-active
        // state we can't reason about.
        this.recoverStaleSessionToIdle(
          row.id,
          "boot_sweep_unparseable_updated_at",
          ms,
        );
        continue;
      }
      const age = now - updatedMs;
      if (age > ms) {
        this.recoverStaleSessionToIdle(row.id, "boot_sweep_stale", ms, age);
      } else {
        // Re-arm for the remaining window so the row doesn't escape
        // supervision just because of a restart.
        const remaining = Math.max(1, ms - age);
        this.armWatchdogFor(row.id, remaining);
        this.deps.logger?.info?.(
          { sessionId: row.id, remainingMs: remaining, status: row.status },
          "session watchdog: re-armed on boot",
        );
      }
    }
  }

  /**
   * One-shot boot pass that seeds `stats_context_pct` for sessions whose
   * most recent `turn_end` predates the runtime change that stamps the
   * column on each turn. Without this, every pre-existing session renders
   * an empty context ring on the list until the user sends another turn.
   *
   * Cheap: scoped to sessions where the column is still 0, and only reads
   * the last `turn_end` event per row (LIMIT 1), not the full event log.
   * Skips rows with no usable usage payload (older turns before cache
   * fields were emitted — the ring stays empty, matching `lastTurnContextKnown`).
   */
  backfillContextPctOnBoot(): void {
    let scanned = 0;
    let updated = 0;
    try {
      const candidates = this.deps.sessions.listSessionsNeedingContextBackfill();
      for (const { id, model } of candidates) {
        scanned += 1;
        const ev = this.deps.sessions.findLastEventByKind(id, "turn_end");
        if (!ev) continue;
        const usage = (ev.payload as Record<string, unknown>).usage as
          | {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            }
          | null
          | undefined;
        if (!usage) continue;
        const inp = Number(usage.inputTokens ?? 0) | 0;
        const cacheRead = Number(usage.cacheReadInputTokens ?? 0) | 0;
        const cacheCreate = Number(usage.cacheCreationInputTokens ?? 0) | 0;
        const body = inp + cacheRead + cacheCreate;
        if (body < HISTORICAL_TURN_THRESHOLD) continue;
        const windowSize = contextWindowTokens(model ?? "");
        const pct = Math.max(0, Math.min(1, body / windowSize));
        this.deps.sessions.setContextPctRaw(id, pct);
        updated += 1;
      }
    } catch (err) {
      this.deps.logger?.error?.(
        { err },
        "context_pct backfill: unexpected error",
      );
      return;
    }
    if (scanned > 0) {
      this.deps.logger?.info?.(
        { scanned, updated },
        "context_pct backfill: boot pass complete",
      );
    }
  }

  /**
   * Route every status mutation through this wrapper so we get a single
   * place that emits the `session status transition` log line (from / to /
   * reason). Callers should not invoke `sessions.setStatus` directly.
   *
   * Note: `transitionStatus` does NOT broadcast on its own. Most runner
   * events that move the status (turn_end, `status:running`, explicit
   * `status:idle`) already carry their own broadcast at the tail of
   * `handleEvent`, which the WS bridge translates to the right frame;
   * auto-broadcasting here would double-send those. Transitions that DO
   * need a broadcast but won't get one for free — `awaiting`
   * (permission_request / ask_user_question / plan_accept_request),
   * `running` on user_message_sent or on a permission/ask/plan decision —
   * call `broadcastStatus` explicitly after the transitionStatus call at
   * their respective sites.
   *
   * Idempotent — re-setting the same status is a no-op (no log) so noisy
   * callers (e.g. SDK re-emitting `status:running`) don't spam the log.
   */
  private transitionStatus(
    sessionId: string,
    to: SessionStatus,
    reason: string,
  ): void {
    const current = this.deps.sessions.findById(sessionId);
    const from = current?.status ?? null;
    if (from === to) return;
    this.deps.logger?.info?.(
      { sessionId, from, to, reason },
      "session status transition",
    );
    try {
      this.deps.sessions.setStatus(sessionId, to);
    } catch (err) {
      this.deps.logger?.debug?.(
        { err, sessionId, to, reason },
        "session status transition: setStatus failed",
      );
    }
    // Fire the alert hook AFTER the row is stamped so any downstream read
    // (inside the hook) sees the post-transition status. Never throws —
    // any alert-path failure is non-fatal to the session itself.
    if (this.alertHook) {
      try {
        this.alertHook(sessionId, from, to);
      } catch (err) {
        this.deps.logger?.debug?.(
          { err, sessionId, from, to, reason },
          "session status transition: alertHook failed",
        );
      }
    }
  }

  /** Attach (or replace) the alert hook. See the `alertHook` field for the
   *  contract. Called once at app boot after the AlertStore is constructed. */
  setAlertHook(
    hook: (
      sessionId: string,
      from: SessionStatus | null,
      to: SessionStatus,
    ) => void,
  ): void {
    this.alertHook = hook;
  }

  /** Resolve the watchdog window, honoring the env override used by tests. */
  private watchdogWindowMs(): number {
    const raw = Number(process.env.CLAUDEX_SESSION_WATCHDOG_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_WATCHDOG_MS;
  }

  /**
   * Arm (or reset) the silence watchdog for a session. Called whenever we
   * observe runner activity for that sessionId. If the timer fires we emit
   * a pino warn line via `logWatchdogSilence` — **no** status change, **no**
   * transcript event, **no** broadcast. Stop + Send stay available; if the
   * runner is genuinely stuck the user drives `POST /api/sessions/:id/force-idle`
   * (surfaced as "Reset to idle" in SessionSettingsSheet) to recover.
   */
  private startWatchdog(sessionId: string): void {
    this.armWatchdogFor(sessionId, this.watchdogWindowMs());
  }

  /**
   * Arm a watchdog timer for this session with an explicit timeout. Used by
   * both the normal `startWatchdog` path (full window) and the on-boot sweep
   * (remaining-window re-arm after a restart). The boot sweep is the only
   * path that actually mutates state when a row is stale — the live timer
   * only logs.
   */
  private armWatchdogFor(sessionId: string, ms: number): void {
    this.clearWatchdog(sessionId);
    const fullWindow = this.watchdogWindowMs();
    const timer = setTimeout(() => {
      this.watchdogs.delete(sessionId);
      this.logWatchdogSilence(sessionId, "watchdog_silence", fullWindow);
    }, ms);
    // Don't hold the Node event loop open just for the watchdog; the process
    // should be able to exit cleanly on SIGTERM even if a session has an
    // armed timer. better-sqlite3 / fastify already keep the loop alive on
    // their own during normal operation.
    if (typeof timer.unref === "function") timer.unref();
    this.watchdogs.set(sessionId, timer);
  }

  /**
   * Live silence watchdog fired — runner has been silent for the full
   * window while the session is still in an active state. Deliberately
   * side-effect-light: pino warn only. No status change (so Send / Stop
   * stay available — long tool calls that run silent are legitimate), no
   * transcript event (would render as a red error in Chat for what may
   * turn out to be a perfectly-alive session), no client broadcast. Users
   * who find themselves staring at a genuinely-stuck row reset it via
   * SessionSettingsSheet's "Reset to idle" (which calls `forceIdle`).
   */
  private logWatchdogSilence(
    sessionId: string,
    reason: string,
    windowMs: number,
  ): void {
    this.deps.logger?.warn?.(
      { sessionId, reason, windowMs },
      "session watchdog: runner silent past window — leaving status untouched",
    );
  }

  /**
   * On-boot sweep saw a row stamped `running` / `awaiting` whose
   * `updated_at` is older than the watchdog window (or unparseable). The
   * runner subprocess definitionally did not survive the server restart,
   * so the only honest status is `idle`. We:
   *
   *   - flip the row to `idle` (composer unlocks, next user message
   *     spawns a fresh runner),
   *   - append a `watchdog_timeout` error event so the transcript shows
   *     a visible marker of the recovery (red tone is appropriate — the
   *     previous turn WAS interrupted, even if the session is now usable),
   *   - broadcast `status: idle` so every subscribed tab re-renders,
   *   - audit `session_watchdog_swept` for ops forensics.
   *
   * Does NOT broadcast a synthesized `error` RunnerEvent — that was the
   * frame that drove the composer error-lockout on clients, and we
   * specifically don't want that here.
   */
  private recoverStaleSessionToIdle(
    sessionId: string,
    reason: string,
    windowMs: number,
    age?: number,
  ): void {
    this.deps.logger?.warn?.(
      { sessionId, reason, windowMs, age },
      "session watchdog: recovering stale session to idle",
    );
    const message =
      age !== undefined
        ? `Session recovered to idle — row was ${Math.round(age / 1000)}s old past a ${Math.round(windowMs / 1000)}s window (runner did not survive server restart)`
        : `Session recovered to idle after ${Math.round(windowMs / 1000)}s of runner silence`;
    this.transitionStatus(sessionId, "idle", reason);
    try {
      this.deps.sessions.appendEvent({
        sessionId,
        kind: "error",
        payload: { code: "watchdog_timeout", message },
      });
    } catch (err) {
      this.deps.logger?.debug?.(
        { err, sessionId },
        "session watchdog: appendEvent failed",
      );
    }
    // Tell every subscribed tab the row is idle now so composers unlock.
    // Intentionally NOT broadcasting a synthesized `error` RunnerEvent —
    // the web client treats that as a hard runner error and locks the
    // composer, which is the exact behaviour we're backing out of here.
    this.broadcastStatus(sessionId, "idle");
    // Audit — boot sweeps especially should leave a visible trail ("we
    // cleaned up N stuck rows at startup").
    this.deps.audit?.append({
      userId: null,
      event: "session_watchdog_swept",
      target: sessionId,
      detail: reason,
    });
  }

  /**
   * Clear the watchdog for a session if one is armed. Safe to call when no
   * timer is pending.
   */
  private clearWatchdog(sessionId: string): void {
    const t = this.watchdogs.get(sessionId);
    if (t) clearTimeout(t);
    this.watchdogs.delete(sessionId);
  }

  /**
   * Install (or clear, when `null`) the push sender. See the
   * `permission_request` branch in `handleEvent` for the one call site.
   */
  setPushSender(sender: ManagerPushSender | null): void {
    this.pushSender = sender;
  }

  getOrCreate(sessionId: string): Runner {
    const existing = this.runners.get(sessionId);
    if (existing) return existing.runner;

    const session = this.deps.sessions.findById(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const project = this.deps.projects.findById(session.projectId);
    if (!project)
      throw new Error(
        `project ${session.projectId} gone for session ${sessionId}`,
      );

    const opts: RunnerInitOptions = {
      sessionId,
      cwd: session.worktreePath ?? project.path,
      model: session.model,
      permissionMode: session.mode,
      effort: session.effort,
      // Resume the SDK-side conversation if we've seen one before. Null on
      // first ever spawn; set after the SDK's system/init echoes its id back.
      resumeSdkSessionId: session.sdkSessionId ?? undefined,
      // Global claudex preference: override the output language for this
      // session. Read once at runner-create — swapping systemPrompt on a
      // live SDK handle is not supported, so UI changes only affect
      // future/resumed sessions. Missing store (tests) → no override.
      language: this.deps.appSettings?.get().language ?? null,
      // If the session's model matches a custom model with a baseUrl, pass
      // it through so the runner sets ANTHROPIC_BASE_URL for the CLI.
      baseUrl: this.deps.appSettings
        ?.get()
        .customModels?.find((m) => m.id === session.model)?.baseUrl,
      apiKey: this.deps.appSettings
        ?.get()
        .customModels?.find((m) => m.id === session.model)?.apiKey,
      logger: this.deps.logger,
    };
    const runner = this.deps.runnerFactory.create(opts);
    const off = runner.on((event) => this.handleEvent(sessionId, event));

    // Side chat: on *first* spawn (no SDK session id yet, so we haven't talked
    // to the CLI about this conversation), prepend a synthetic context message
    // summarizing the parent thread. Resumes skip this — the SDK already has
    // the history persisted on its side.
    let pendingSeed: string | null = null;
    if (session.parentSessionId && !session.sdkSessionId) {
      pendingSeed = this.buildSideChatSeed(session.parentSessionId);
    }

    this.runners.set(sessionId, { runner, off, pendingSeed });
    return runner;
  }

  /**
   * Build the synthetic seed prompt that gives a side-chat claude the main
   * thread's context without handing it tool-call noise.
   *
   * Rules (intentional, documented):
   *   - only `user_message` and `assistant_text` events — tool_use /
   *     tool_result / thinking / permission_* are stripped; the point of
   *     /btw is to ask a quick lateral question, not re-audit the run
   *   - multi-line text is preserved verbatim — we never truncate or
   *     summarize, mirroring claudex's general "don't silently truncate"
   *     rule. The user can archive+start-new if the context grows unwieldy.
   *   - the seed ends with an explicit instruction reminding the model it
   *     must not imply action on the main thread from this side lane.
   */
  private buildSideChatSeed(parentId: string): string {
    const events = this.deps.sessions.listEvents(parentId);
    const lines: string[] = [];
    for (const ev of events) {
      const p = ev.payload as Record<string, unknown>;
      if (ev.kind === "user_message") {
        const text = typeof p.text === "string" ? p.text : "";
        if (text.length > 0) lines.push(`user: ${text}`);
      } else if (ev.kind === "assistant_text") {
        const text = typeof p.text === "string" ? p.text : "";
        if (text.length > 0) lines.push(`assistant: ${text}`);
      }
    }
    const transcript = lines.length > 0 ? lines.join("\n") : "(no messages yet)";
    return (
      "The user is asking a side question. Answer without implying any " +
      "action on the main thread — no tool calls unless the user explicitly " +
      "asks for one, no file edits, no commits.\n\n" +
      "Here's the conversation so far:\n" +
      transcript
    );
  }

  private handleEvent(sessionId: string, event: RunnerEvent) {
    // Any runner event is a heartbeat — the runner is still alive. Reset the
    // watchdog on every activity while the session looks active. Terminal
    // transitions below (turn_end, error, idle status) clear it outright.
    if (this.watchdogs.has(sessionId)) {
      this.startWatchdog(sessionId);
    }
    try {
      switch (event.type) {
        case "sdk_session_id":
          // First-write-wins: setSdkSessionId only updates NULL rows. On resume
          // the SDK re-emits the same id, and we intentionally skip that write.
          this.deps.sessions.setSdkSessionId(sessionId, event.sdkSessionId);
          break;
        case "assistant_text":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "assistant_text",
            payload: {
              messageId: event.messageId,
              text: event.text,
              done: event.done,
              // s-17 live subagents: thread through when the text block
              // came from a child subagent's turn so the rail can group
              // by `parentToolUseId`. Absent on main-thread text.
              ...(event.parentToolUseId !== undefined
                ? { parentToolUseId: event.parentToolUseId }
                : {}),
            },
          });
          break;
        case "thinking":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "assistant_thinking",
            payload: {
              text: event.text,
              ...(event.parentToolUseId !== undefined
                ? { parentToolUseId: event.parentToolUseId }
                : {}),
            },
          });
          break;
        case "tool_use":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "tool_use",
            payload: {
              toolUseId: event.toolUseId,
              name: event.name,
              input: event.input,
              ...(event.parentToolUseId !== undefined
                ? { parentToolUseId: event.parentToolUseId }
                : {}),
            },
          });
          break;
        case "tool_result":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "tool_result",
            payload: {
              toolUseId: event.toolUseId,
              content: event.content,
              isError: event.isError,
              ...(event.parentToolUseId !== undefined
                ? { parentToolUseId: event.parentToolUseId }
                : {}),
            },
          });
          break;
        // ------------------------------------------------------------
        // Live subagents (s-17). Persist each SDK `task_*` / `tool_progress`
        // flavour as its own `session_events` row so the rail can replay
        // the live stream after reload / resume. The `break` after each
        // lets the default "broadcast the event verbatim" path below the
        // switch fire — subscribed tabs receive the frame in real time.
        // ------------------------------------------------------------
        case "subagent_start":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "subagent_start",
            payload: {
              taskId: event.taskId,
              parentToolUseId: event.parentToolUseId,
              description: event.description,
              ...(event.agentType !== undefined
                ? { agentType: event.agentType }
                : {}),
              ...(event.taskType !== undefined
                ? { taskType: event.taskType }
                : {}),
              ...(event.workflowName !== undefined
                ? { workflowName: event.workflowName }
                : {}),
              ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
              ...(event.isBackgrounded !== undefined
                ? { isBackgrounded: event.isBackgrounded }
                : {}),
              at: event.at,
            },
          });
          break;
        case "subagent_progress":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "subagent_progress",
            payload: {
              taskId: event.taskId,
              description: event.description,
              ...(event.lastToolName !== undefined
                ? { lastToolName: event.lastToolName }
                : {}),
              ...(event.summary !== undefined ? { summary: event.summary } : {}),
              usage: event.usage,
              at: event.at,
            },
          });
          break;
        case "subagent_update":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "subagent_update",
            payload: {
              taskId: event.taskId,
              patch: event.patch,
              at: event.at,
            },
          });
          break;
        case "subagent_end":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "subagent_end",
            payload: {
              taskId: event.taskId,
              status: event.status,
              summary: event.summary,
              ...(event.outputFile !== undefined
                ? { outputFile: event.outputFile }
                : {}),
              ...(event.toolUseId !== undefined
                ? { toolUseId: event.toolUseId }
                : {}),
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
              at: event.at,
            },
          });
          break;
        case "subagent_tool_progress":
          // Don't persist — `tool_progress` is a heartbeat with an
          // ever-growing `elapsed_time_seconds` that gets superseded by
          // the next heartbeat. Keeping every tick would bloat the event
          // log without adding replayable value (the final elapsed lives
          // on `subagent_end.usage.durationMs`). Still broadcast so
          // subscribed tabs can animate the "still alive" indicator.
          break;
        case "permission_request": {
          // Auto-approve if an existing grant matches. "allow_once" here because
          // the grant itself already represents the "always" decision.
          const sig = signatureFor(event.toolName, event.input);
          if (sig && this.deps.grants.has(sessionId, event.toolName, sig)) {
            const entry = this.runners.get(sessionId);
            entry?.runner.resolvePermission(event.toolUseId, {
              behavior: "allow",
              reason: "auto-approved by saved grant",
            });
            // Resolve which grant row actually matched so the audit trail
            // and transcript can point back at it. listForSession returns
            // both session-scoped and global rows — filter by (toolName, sig)
            // and pick the newest (first entry is created_at DESC).
            const matched = this.deps.grants
              .listForSession(sessionId)
              .find(
                (g) =>
                  g.tool_name === event.toolName && g.input_signature === sig,
              );
            // Append a permission_decision event so auto-approvals show up
            // in the transcript next to the tool_use they authorized. The
            // `automatic: true` flag lets the UI render them differently
            // (no Approve/Deny buttons, greyed-out "auto" label).
            this.deps.sessions.appendEvent({
              sessionId,
              kind: "permission_decision",
              payload: {
                approvalId: event.toolUseId,
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                decision: "allow_always",
                automatic: true,
                matchedGrantId: matched?.id ?? null,
              },
            });
            // And audit, so the Security card shows the invisible grants are
            // firing. userId is null here — decisions arrive over the runner
            // bus with no FastifyRequest in scope.
            this.deps.audit?.append({
              userId: null,
              event: "permission_granted",
              target: sessionId,
              detail: `auto: ${event.toolName} matched ${matched?.input_signature ?? sig}`,
            });
            // Don't persist this as a user-facing permission_request.
            return;
          }

          // Enrich with a summary for the UI.
          const { summary, blastRadius } = summarizePermission(
            event.toolName,
            event.input,
          );
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "permission_request",
            payload: {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
              title: summary,
              blastRadius,
            },
          });
          this.pendingByApproval.set(event.toolUseId, {
            sessionId,
            toolName: event.toolName,
            input: event.input,
          });
          this.transitionStatus(sessionId, "awaiting", "permission_request");
          // Synthesize a session_update so every subscribed tab's status dot
          // flips to awaiting. The runner itself never emits a status frame
          // for awaiting — that's a claudex-side concept.
          this.broadcastStatus(sessionId, "awaiting");
          // Propagate enriched event to subscribers.
          this.deps.broadcast(sessionId, {
            ...event,
            title: summary,
          });
          // Fire a web push so the user's phone lights up even when the
          // tab is backgrounded / the PWA is closed. Fire-and-forget —
          // any failure inside the sender is caught here so runtime is
          // never held up on a flaky push service.
          this.firePermissionPush(sessionId, event.toolName, event.input);
          return;
        }
        case "ask_user_question": {
          // Persist as append-only — sibling `ask_user_answer` event lands
          // when the user submits. Flip status to `awaiting` so the chat
          // header and session list both surface that claude is blocked on
          // user input (same treatment as a permission_request).
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "ask_user_question",
            payload: {
              askId: event.askId,
              questions: event.questions,
            },
          });
          this.transitionStatus(sessionId, "awaiting", "ask_user_question");
          // Synthesize a session_update so Home/Chat status dots flip to
          // awaiting — AskUserQuestion is a blocking interaction just like a
          // permission_request.
          this.broadcastStatus(sessionId, "awaiting");
          // Forward the event to the WS layer — ws.ts will translate it into
          // a `ServerAskUserQuestion` frame. Short-circuit the generic
          // broadcast at the bottom of handleEvent so we don't double-send.
          this.deps.broadcast(sessionId, event);
          return;
        }
        case "plan_accept_request": {
          // Persist as append-only — sibling `plan_accept_decision` event
          // lands when the user accepts/rejects. Flip status to `awaiting`
          // so the chat header and session list both surface that claude is
          // blocked on user input (same treatment as ask_user_question).
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "plan_accept_request",
            payload: {
              planId: event.planId,
              plan: event.plan,
            },
          });
          this.transitionStatus(sessionId, "awaiting", "plan_accept_request");
          // Same reasoning as ask_user_question — ExitPlanMode is a blocking
          // interaction, the status dot needs to move.
          this.broadcastStatus(sessionId, "awaiting");
          this.deps.broadcast(sessionId, event);
          return;
        }
        case "turn_end": {
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "turn_end",
            payload: {
              stopReason: event.stopReason,
              usage: event.usage ?? null,
              ...(event.billingUsage !== undefined
                ? { billingUsage: event.billingUsage }
                : {}),
            },
          });
          // Compute context-window fill % for the session list ring.
          // Skip when usage is missing or below the historical threshold
          // (e.g. cache fields absent) — leaving stats_context_pct at its
          // previous value rather than stamping a misleading ~0%.
          //
          // We deliberately use `event.usage` (per-call) here, NOT
          // `event.billingUsage` (cumulative). The ring answers "how full
          // is the context window right now"; the cumulative number sums
          // every sub-call's cache-read across a multi-tool-use turn and
          // pushes the ring well past 100% on long turns. See
          // `shared/src/usage.ts` and `RunnerEvent.turn_end` for the
          // semantics.
          const u = event.usage;
          let contextPct: number | undefined;
          if (u) {
            const inp = Number(u.inputTokens ?? 0) | 0;
            const cacheRead = Number(u.cacheReadInputTokens ?? 0) | 0;
            const cacheCreate = Number(u.cacheCreationInputTokens ?? 0) | 0;
            const body = inp + cacheRead + cacheCreate;
            if (body >= HISTORICAL_TURN_THRESHOLD) {
              const session = this.deps.sessions.findById(sessionId);
              const window = contextWindowTokens(session?.model ?? "");
              contextPct = Math.max(0, Math.min(1, body / window));
            }
          }
          this.deps.sessions.bumpStats(sessionId, {
            messages: 1,
            ...(contextPct !== undefined ? { contextPct } : {}),
          });
          this.deps.sessions.touchLastMessage(sessionId);
          this.transitionStatus(sessionId, "idle", "turn_end");
          // Turn wrapped cleanly — cancel the silence watchdog. If a follow-up
          // turn starts, sendUserMessage / status=running will re-arm it.
          this.clearWatchdog(sessionId);
          break;
        }
        case "status":
          if (event.status === "running") {
            this.transitionStatus(sessionId, "running", "runner_status_running");
            // Fresh "running" signal → arm (or reset) the silence watchdog.
            this.startWatchdog(sessionId);
          } else if (event.status === "idle") {
            this.transitionStatus(sessionId, "idle", "runner_status_idle");
            this.clearWatchdog(sessionId);
          } else if (event.status === "terminated") {
            this.transitionStatus(sessionId, "idle", "runner_status_terminated");
            this.clearWatchdog(sessionId);
          }
          break;
        case "error":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "error",
            payload: { code: event.code, message: event.message },
          });
          this.transitionStatus(sessionId, "error", `runner_error:${event.code}`);
          // Runner reported a hard error — no point in keeping the timer
          // armed; the session is already in a terminal-visible state.
          this.clearWatchdog(sessionId);
          break;
        case "compact_status":
          // Transient UI hint — drives the chat header's "Compacting…" pill
          // when phase=start, clears it on phase=end. Not persisted; the
          // boundary event below carries the durable record.
          break;
        case "compact_boundary":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "compact_boundary",
            payload: {
              trigger: event.trigger,
              preTokens: event.preTokens,
              ...(event.postTokens !== undefined
                ? { postTokens: event.postTokens }
                : {}),
              ...(event.durationMs !== undefined
                ? { durationMs: event.durationMs }
                : {}),
              at: event.at,
            },
          });
          break;
        case "compact_summary":
          // Persisted body of the SDK's post-compaction summary. Arrives a
          // few seconds after the matching `compact_boundary` because the
          // SDK only writes it to its own JSONL — the runner harvests it
          // from disk and emits this event. UI folds it under the divider
          // by `boundaryAt`.
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "compact_summary",
            payload: {
              boundaryAt: event.boundaryAt,
              content: event.content,
            },
          });
          break;
      }
    } catch (err) {
      this.deps.logger?.error(
        { err, sessionId, event: event.type },
        "failed to persist runner event",
      );
    }
    this.deps.broadcast(sessionId, event);
  }

  /**
   * Fire-and-forget Web Push when a session starts awaiting user input.
   * Skips cleanly when no push sender is attached (tests, no VAPID config).
   *
   * Body text mirrors what the Permission card shows inline: tool name +
   * truncated primary argument (command / file_path / pattern / url) so the
   * user sees "what's claude trying to do" without opening the app. 60 chars
   * because iOS lock-screen notifications collapse at ~90 and we still want
   * the tool name legible at the front.
   */
  private firePermissionPush(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const sender = this.pushSender;
    if (!sender) return;
    const session = this.deps.sessions.findById(sessionId);
    const title =
      session && session.title.trim().length > 0
        ? session.title
        : "Claude wants permission";
    const primary =
      pickPushSubject(input) ?? `${toolName}`;
    const body = `${toolName} · ${truncateForPush(primary, 60)}`;
    sender
      .sendToAll({
        title,
        body,
        data: { sessionId, url: `/session/${sessionId}` },
      })
      .catch((err) => {
        this.deps.logger?.warn?.(
          { err, sessionId, toolName },
          "firePermissionPush failed",
        );
      });
  }


  async sendUserMessage(
    sessionId: string,
    content: string,
    attachmentIds: string[] = [],
    echoId?: string,
  ): Promise<void> {
    const runner = this.getOrCreate(sessionId);
    // Flip the session to `running` the moment we accept the user's message.
    // The AgentRunner only emits `status:running` once, at the top of its
    // consume loop — so on second-and-later turns (when the runner is
    // already iterating) the SDK itself never tells us the session became
    // active again. Without this transition + broadcast, a session would
    // sit on `idle` (its terminal state from the previous turn_end)
    // through the entire follow-up turn until the next turn_end, and the
    // UI's "thinking" dot would never light up. transitionStatus is
    // idempotent when already running — only the broadcast fires on
    // first-turn as well, keeping the wire in sync with the DB.
    const before = this.deps.sessions.findById(sessionId);
    if (before?.status !== "running") {
      this.transitionStatus(sessionId, "running", "user_message_sent");
      this.broadcastStatus(sessionId, "running");
    }
    // If this is a side chat whose runner has a pending context seed,
    // flush it to the SDK first. We do NOT append the seed to
    // session_events — the transcript only shows what the user typed.
    const entry = this.runners.get(sessionId);
    if (entry?.pendingSeed) {
      const seed = entry.pendingSeed;
      entry.pendingSeed = null;
      await runner.sendUserMessage(seed);
    }

    // Resolve attachments against this session only — cross-session ids get
    // silently dropped, which is the correct permission boundary. An id that
    // was already linked to a previous message also drops here because we
    // filter on `messageEventSeq === null`. The resulting rows are what the
    // UI chose to send *this* turn.
    const resolvedAttachments = this.resolveAttachments(
      sessionId,
      attachmentIds,
    );

    // Auto-title from the first user message, mirroring Claude Code CLI
    // behavior. Snapshot the session + count prior user_messages *before*
    // appending so "is this the very first user message?" is unambiguous.
    //
    // Skip retitle when:
    //   - session is a side chat (parentSessionId set) — those already
    //     have a deliberate "Side chat" title from routes.ts
    //   - the session already has a substantive user-chosen title
    //     (>3 words is our "looks deliberate" heuristic)
    //   - there are already prior user_message events (retitle is
    //     strictly a first-message thing)
    //
    // Intentionally NOT broadcast: the sibling agent is reshaping ws.ts
    // and adding a global session channel that will make live title
    // updates trivial. Until that lands, the new title persists to
    // SQLite only and surfaces on the next Home refresh.
    const beforeAppend = this.deps.sessions.findById(sessionId);
    const priorUserMessages = beforeAppend
      ? this.countPriorUserMessages(sessionId)
      : 0;

    // Stamp the user_message payload with attachment metadata so the web
    // transcript can render the chips alongside the text. Keep it minimal:
    // the raw bytes are served by the /api/attachments/:id/raw endpoint.
    const payload: Record<string, unknown> = { text: content };
    if (resolvedAttachments.length > 0) {
      payload.attachments = resolvedAttachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        size: a.sizeBytes,
      }));
    }
    const appended = this.deps.sessions.appendEvent({
      sessionId,
      kind: "user_message",
      payload,
    });
    this.deps.sessions.touchLastMessage(sessionId);

    // Link the attachments to the just-appended user_message seq so the UI
    // can no longer delete them and so cleanup knows they're owned. Batched
    // in a single transaction inside AttachmentStore.linkToMessage.
    if (resolvedAttachments.length > 0 && this.deps.attachments) {
      this.deps.attachments.linkToMessage(
        resolvedAttachments.map((a) => a.id),
        appended.seq,
      );
    }

    if (
      beforeAppend &&
      priorUserMessages === 0 &&
      beforeAppend.parentSessionId === null &&
      shouldAutoRetitle(beforeAppend.title)
    ) {
      const newTitle = deriveTitleFromMessage(content);
      if (newTitle.length > 0) {
        this.deps.sessions.setTitle(sessionId, newTitle);
        // TODO(ws-refactor): once the sibling agent's global session
        // channel lands, broadcast a session_update with the new title
        // so Home updates live. For now Home re-fetches on mount which
        // is acceptable for the first-message retitle case.
      }
    }

    // Broadcast the user message to every subscriber — including the tab
    // that sent it. Multi-tab sees the message show up instantly; the
    // sending tab reconciles against its local optimistic echo using the
    // per-send `echoId` nonce it attached to the original frame (see
    // web/src/state/sessions.ts). `echoId` is undefined for legacy
    // clients, in which case the web store falls back to a text+3s
    // heuristic.
    this.deps.broadcast(sessionId, {
      type: "user_message",
      text: content,
      at: new Date().toISOString(),
      ...(echoId !== undefined ? { echoId } : {}),
      ...(resolvedAttachments.length > 0
        ? {
            attachments: resolvedAttachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mime: a.mime,
              size: a.sizeBytes,
            })),
          }
        : {}),
    });

    // Flip to `running` before we push the prompt into the runner. After the
    // first turn_end lands, the session sits at `idle` until another runner
    // event arrives — but the AgentRunner only emits `status: running` ONCE
    // at the top of `consume()`, so second/third/nth turns would otherwise
    // stay visually idle through the entire streamed reply. Doing the flip
    // here (instead of relying on the runner) also covers the first turn
    // cleanly: the transition is a no-op when status is already running.
    // Idempotent via `transitionStatus`'s from===to guard.
    this.transitionStatus(sessionId, "running", "user_message_sent");

    // Build the outgoing SDK prompt by prefixing `@<absolute-path>` tokens
    // so the SDK's Read tool picks the files up in-line — this is how the
    // `claude` CLI handles `@path` references, and the SDK inherits that
    // behavior. Using an absolute path under `~/.claudex/uploads/<session>/`
    // means the Read tool resolves them regardless of the session's cwd.
    // When the user's message is empty but attachments are present, we
    // still send the prefix so the model has something to reason about.
    const sdkPrompt =
      resolvedAttachments.length > 0
        ? resolvedAttachments
            .map((a) => `@${a.path}`)
            .join("\n") +
          (content.length > 0 ? `\n\n${content}` : "")
        : content;
    await runner.sendUserMessage(sdkPrompt);
    // Arm the silence watchdog. We start it here (not only on status=running)
    // because the SDK can take several seconds to emit its first event after
    // a sendUserMessage — if that first event never arrives the watchdog
    // still fires so we get a pino warn line for ops forensics. (It no
    // longer mutates status; the previous force-to-`error` behaviour locked
    // the composer out on long-silent-but-still-alive turns.)
    this.startWatchdog(sessionId);
  }

  /**
   * Re-trigger the SDK runner for a session whose most recent user_message
   * was edited in-place (by `POST /api/sessions/:id/edit-last-user-message`).
   * Unlike `sendUserMessage`, this does NOT append a new `user_message` event
   * — the edit path has already rewritten the existing row's payload, so
   * appending again would duplicate it in the transcript.
   *
   * Flips the session to `running`, broadcasts a `refresh_transcript` so
   * every subscribed tab refetches the now-truncated transcript, then pushes
   * the edited prompt into the SDK's async input queue so a fresh assistant
   * turn follows.
   *
   * Caveat (mirrored in docs/FEATURES.md): the SDK's own persisted history
   * under `~/.claude/projects/` still contains the pre-edit message and any
   * assistant reply. When the SDK formulates the next reply it will see both
   * the old exchange and the edited message. We ship it anyway — the web UX
   * win (typo recovery without resending) outweighs the CLI-side divergence.
   */
  async rerunFromEditedMessage(
    sessionId: string,
    editedText: string,
  ): Promise<void> {
    const runner = this.getOrCreate(sessionId);
    // Side-chat seed edge case: a brand-new side chat with a pending seed
    // can't have been edited (nothing to edit yet). Guard anyway — flushing
    // the seed first is cheap and preserves the one-time-seed invariant.
    const entry = this.runners.get(sessionId);
    if (entry?.pendingSeed) {
      const seed = entry.pendingSeed;
      entry.pendingSeed = null;
      await runner.sendUserMessage(seed);
    }
    this.transitionStatus(sessionId, "running", "rerun_from_edited_message");
    this.deps.broadcast(sessionId, { type: "refresh_transcript" });
    await runner.sendUserMessage(editedText);
    this.startWatchdog(sessionId);
  }

  /**
   * Look up `ids` in the attachment store, keeping only rows whose session
   * matches and that are still unlinked. Empty + no-op when the store wasn't
   * wired (tests, legacy).
   */
  private resolveAttachments(sessionId: string, ids: string[]) {
    if (!this.deps.attachments || ids.length === 0) return [];
    return this.deps.attachments
      .findManyForSession(sessionId, ids)
      .filter((a) => a.messageEventSeq === null);
  }

  /**
   * Count how many `user_message` events are already persisted for this
   * session. Used by auto-title to detect "this is the first user_message
   * for this session". Linear scan over listEvents — session transcripts
   * are bounded by human attention span, so not worth a dedicated index.
   */
  private countPriorUserMessages(sessionId: string): number {
    let n = 0;
    for (const ev of this.deps.sessions.listEvents(sessionId)) {
      if (ev.kind === "user_message") n += 1;
    }
    return n;
  }

  /**
   * Broadcast a `refresh_transcript` signal to every WS subscriber for this
   * session. Used by out-of-band appenders (e.g. CLI JSONL resync) that
   * don't go through the live runner and therefore aren't on the runner
   * event bus. The web client reacts by refetching `/events?limit=200`.
   */
  notifyTranscriptRefresh(sessionId: string): void {
    this.deps.broadcast(sessionId, { type: "refresh_transcript" });
  }

  /**
   * Broadcast a synthesized `status` RunnerEvent so the WS bridge emits a
   * `session_update` frame. Used by:
   *   - the CLI file-watcher which derives status from the JSONL's mtime +
   *     tail and never goes through AgentRunner;
   *   - the manager itself, whenever it flips DB status to `awaiting` or
   *     `running` via `transitionStatus` so every subscribed tab sees the
   *     status dot move without waiting for the next runner event.
   *
   * The DB status is expected to already be stamped by the caller — this
   * method is pure broadcast. `starting` and `terminated` are mapped to
   * `running` / `idle` by the WS bridge; `awaiting` / `error` pass through.
   */
  broadcastStatus(
    sessionId: string,
    status:
      | "running"
      | "idle"
      | "terminated"
      | "starting"
      | "awaiting"
      | "error"
      | "cli_running",
  ): void {
    this.deps.broadcast(sessionId, { type: "status", status });
  }

  /**
   * Broadcast a `queue_update` frame to every authenticated tab via the
   * global WS channel. The queue runner and HTTP routes call this through
   * the QueueStore `onChange` hook; callers here pass the current timestamp
   * so clients can display "just now" in the Queue screen without an extra
   * round-trip. Not tied to any session — uses empty-string `sessionId`
   * because the frame is cross-session by design (see ws.ts
   * GLOBAL_FRAME_TYPES).
   */
  notifyQueueUpdate(): void {
    this.deps.broadcast("", {
      type: "queue_update",
      at: new Date().toISOString(),
    });
  }

  /**
   * Broadcast an `alerts_update` frame to every authenticated tab via the
   * global WS channel. Same pattern as `notifyQueueUpdate` — payload-free
   * beyond a server-side timestamp, clients refetch `GET /api/alerts` to
   * reconcile. Called by the AlertStore's own mutation paths (insert,
   * markSeen, markResolved) so every list-mutation fans out to every tab.
   */
  notifyAlertsUpdate(): void {
    this.deps.broadcast("", {
      type: "alerts_update",
      at: new Date().toISOString(),
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    const entry = this.runners.get(sessionId);
    if (!entry) return;
    await entry.runner.interrupt();
  }

  /**
   * Manually drop a session back to `idle`, regardless of its current status.
   * Used by the `POST /api/sessions/:id/force-idle` escape hatch so a user
   * staring at a permanently-"running" / errored row can reset it without
   * creating a new session. Clears any pending watchdog (the row is now idle
   * — arming a new timer would be wrong), logs the transition, broadcasts
   * the status so every tab's composer unlocks. Returns `true` if the row
   * was actually flipped, `false` if it was already idle (no-op) or the
   * session doesn't exist.
   */
  forceIdle(sessionId: string, reason: string): boolean {
    const row = this.deps.sessions.findById(sessionId);
    if (!row) return false;
    if (row.status === "idle") return false;
    this.clearWatchdog(sessionId);
    this.transitionStatus(sessionId, "idle", reason);
    // Tell every subscribed tab to re-render the session row. The WS
    // bridge translates `status:idle` into a `session_update` frame.
    this.broadcastStatus(sessionId, "idle");
    return true;
  }

  /**
   * Propagate a permission-mode change to the live runner, if any.
   * The caller is expected to have already persisted the new mode to the DB.
   * Returns true when a running runner got the call, false otherwise.
   */
  async applyPermissionMode(
    sessionId: string,
    mode: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions",
  ): Promise<boolean> {
    const entry = this.runners.get(sessionId);
    if (!entry) return false;
    await entry.runner.setPermissionMode(mode);
    return true;
  }

  /**
   * Propagate an effort-level change to the live runner, if any. The
   * runner stores the new value and picks it up on the NEXT SDK turn;
   * in-flight queries keep the budget they were launched with (matches
   * how model changes propagate). The caller is expected to have already
   * persisted the new level to the DB.
   */
  async applyEffort(
    sessionId: string,
    effort: "low" | "medium" | "high" | "xhigh" | "max",
  ): Promise<boolean> {
    const entry = this.runners.get(sessionId);
    if (!entry) return false;
    await entry.runner.setEffort(effort);
    return true;
  }

  /**
   * Propagate a model change to the live runner, if any. Routed through
   * the Agent SDK's `Query.setModel` so subsequent turns use the new
   * model without tearing the runner down. In-flight SDK queries keep
   * the model they were launched with — this matches the SDK's own
   * semantics. The caller is expected to have already persisted the new
   * model to the DB.
   *
   * Without this hop, the runner cache in `getOrCreate` returns the
   * old runner forever and the DB-side model change is silently
   * ignored, surfacing as "model picker says X but Claude still
   * answers as Sonnet 4.6".
   */
  async applyModel(sessionId: string, model: ModelId): Promise<boolean> {
    const entry = this.runners.get(sessionId);
    if (!entry) return false;
    await entry.runner.setModel(model);
    return true;
  }

  /** Is a live runner attached for this session? */
  hasRunner(sessionId: string): boolean {
    return this.runners.has(sessionId);
  }

  /**
   * Forward a `rewindFiles` control request to the session's live CLI child
   * when one is attached AND has an SDK handle (i.e. has started at least
   * once). Returns null when there's no usable live runner — the caller
   * falls back to a resume-based rewind (see cli-rewind.ts), which is safe
   * here precisely because a runner with no handle means no CLI process is
   * touching the session's transcript.
   */
  async tryRewindViaLiveRunner(
    sessionId: string,
    userMessageId: string,
    dryRun?: boolean,
  ): Promise<RewindFilesResult | null> {
    const entry = this.runners.get(sessionId);
    if (!entry) return null;
    try {
      return await entry.runner.rewindFiles(userMessageId, dryRun);
    } catch (err) {
      if (err instanceof Error && err.message === "runner_not_started") {
        return null;
      }
      throw err;
    }
  }

  resolvePermission(
    sessionId: string,
    toolUseId: string,
    decision: PermissionDecision,
  ): void {
    const entry = this.runners.get(sessionId);
    if (!entry) return;

    const pending = this.pendingByApproval.get(toolUseId);
    this.pendingByApproval.delete(toolUseId);

    if (decision === "allow_always" && pending) {
      const sig = signatureFor(pending.toolName, pending.input);
      if (sig) {
        this.deps.grants.addSessionGrant(sessionId, pending.toolName, sig);
      }
    }

    const behavior = decision === "deny" ? "deny" : "allow";
    entry.runner.resolvePermission(toolUseId, { behavior });

    this.deps.sessions.appendEvent({
      sessionId,
      kind: "permission_decision",
      payload: { toolUseId, decision, toolName: pending?.toolName ?? null },
    });
    this.transitionStatus(sessionId, "running", `permission_${decision}`);
    // Unwind awaiting → running on the wire. The SDK runner won't
    // emit its own status frame here — the next user-visible event
    // is whatever the model does next (tool_use, assistant_text, etc.),
    // and without this broadcast the session list would stay on the
    // "awaiting" dot until turn_end lands.
    this.broadcastStatus(sessionId, "running");
    // Back to active — re-arm the silence watchdog.
    this.startWatchdog(sessionId);
    // Audit: every permission decision is security-relevant — the user just
    // authorized (or refused) claude touching the host. userId is null
    // because decisions arrive over WS with no FastifyRequest in scope; the
    // audit column is nullable for exactly this reason.
    this.deps.audit?.append({
      userId: null,
      event: decision === "deny" ? "permission_denied" : "permission_granted",
      target: sessionId,
      detail: `${pending?.toolName ?? "tool"} ${decision}`,
    });
  }

  /**
   * Resolve a pending `AskUserQuestion` interaction with the user's answers.
   * Append-only: we persist a sibling `ask_user_answer` event rather than
   * mutating the question row, mirroring the rest of the event log.
   * Double-submit is harmless — the runner's own map guards against a second
   * resolve, and we skip the append when the runner didn't know the askId.
   */
  resolveAskUserQuestion(
    sessionId: string,
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ): void {
    const entry = this.runners.get(sessionId);
    if (!entry) return;
    entry.runner.resolveAskUserQuestion(askId, answers, annotations);
    this.deps.sessions.appendEvent({
      sessionId,
      kind: "ask_user_answer",
      payload: {
        askId,
        answers,
        ...(annotations ? { annotations } : {}),
      },
    });
    this.transitionStatus(sessionId, "running", "ask_user_answer");
    this.broadcastStatus(sessionId, "running");
    this.startWatchdog(sessionId);
  }

  /**
   * Resolve a pending `ExitPlanMode` interaction with the user's decision.
   * Append-only: persists a sibling `plan_accept_decision` event rather than
   * mutating the request row. `accept` lets the SDK's `canUseTool` resolve
   * as `{behavior: "allow"}` (the SDK itself handles transitioning out of
   * plan mode for the next turn); `reject` resolves as
   * `{behavior: "deny", message}` so the model sees a tool error it can
   * recover from by revising the plan.
   *
   * Double-submit is harmless — the runner's map is keyed on `planId` and
   * deleted on first resolve; a second call from a stale client is a no-op
   * on the runner side, but we still skip the append to keep the transcript
   * clean.
   */
  resolvePlanAccept(
    sessionId: string,
    planId: string,
    decision: "accept" | "reject",
  ): void {
    const entry = this.runners.get(sessionId);
    if (!entry) return;
    entry.runner.resolvePlanAccept(planId, decision);
    this.deps.sessions.appendEvent({
      sessionId,
      kind: "plan_accept_decision",
      payload: { planId, decision },
    });
    this.transitionStatus(sessionId, "running", `plan_accept_${decision}`);
    this.broadcastStatus(sessionId, "running");
    this.startWatchdog(sessionId);
  }

  async disposeAll(): Promise<void> {
    const entries = Array.from(this.runners.values());
    this.runners.clear();
    // Cancel every pending silence watchdog so a post-shutdown timer can't
    // fire against a torn-down store / broadcast channel.
    for (const id of Array.from(this.watchdogs.keys())) {
      this.clearWatchdog(id);
    }
    await Promise.all(
      entries.map(async (e) => {
        e.off();
        await e.runner.dispose();
      }),
    );
  }

  /**
   * Tear down the live runner (if any) for a single session. Used by the
   * DELETE route before dropping the session row so we don't keep a dangling
   * SDK process around writing events for a session that no longer exists.
   * No-op when no runner is attached.
   */
  async dispose(sessionId: string): Promise<void> {
    const entry = this.runners.get(sessionId);
    if (!entry) return;
    this.runners.delete(sessionId);
    // Drop any pending watchdog too — the runner is going away, a silence
    // timer against a disposed session would just produce a spurious error
    // after the fact.
    this.clearWatchdog(sessionId);
    entry.off();
    try {
      await entry.runner.dispose();
    } catch {
      // Best-effort: if the runner already exited we don't want the route
      // to fail on a secondary cleanup error.
    }
  }
}
