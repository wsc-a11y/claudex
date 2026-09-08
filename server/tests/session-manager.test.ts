import { describe, it, expect, afterEach, vi } from "vitest";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionManager } from "../src/sessions/manager.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
  RunnerListener,
} from "../src/sessions/runner.js";
import { tempConfig } from "./helpers.js";

// ---- Mock runner ------------------------------------------------------------

class MockRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  // Stashed init options so tests can assert what the factory passed in.
  // This is test-only — we don't want to leak the full RunnerInitOptions into
  // the Runner contract.
  initOpts: RunnerInitOptions;
  private listeners = new Set<RunnerListener>();
  sent: string[] = [];
  interrupted = 0;
  permissions: Array<{ id: string; behavior: string }> = [];
  permissionModes: string[] = [];
  disposed = false;

  constructor(opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
    this.initOpts = opts;
  }

  async start(initial?: string) {
    if (initial) this.sent.push(initial);
  }
  async sendUserMessage(c: string) {
    this.sent.push(c);
  }
  resolvePermission(id: string, d: { behavior: string }) {
    this.permissions.push({ id, behavior: d.behavior });
  }
  resolveAskUserQuestion(
    _id: string,
    _answers: Record<string, string>,
    _annotations?: unknown,
  ) {
    // Mock only — real tests that care about AskUserQuestion use a dedicated harness.
  }
  resolvePlanAccept(_id: string, _d: "accept" | "reject") {
    // Mock only — plan accept tests use a dedicated harness.
  }
  async interrupt() {
    this.interrupted += 1;
  }
  async setPermissionMode(mode: import("@claudex/shared").PermissionMode) {
    this.permissionModes.push(mode);
  }
  async dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
  on(l: RunnerListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  listenerCount() {
    return this.listeners.size;
  }
  emit(ev: RunnerEvent) {
    for (const l of this.listeners) l(ev);
  }
}

function createFactory(): { factory: RunnerFactory; last: () => MockRunner | null } {
  let last: MockRunner | null = null;
  return {
    factory: {
      create(opts) {
        last = new MockRunner(opts);
        return last;
      },
    },
    last: () => last,
  };
}

// ---- Harness ----------------------------------------------------------------

function setupManager() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const grants = new ToolGrantStore(db);
  const project = projects.create({
    name: "spindle",
    path: "/p/spindle",
    trusted: true,
  });
  const session = sessions.create({
    title: "t",
    projectId: project.id,
    model: "claude-opus-4-8",
    mode: "default",
  });
  const { factory, last } = createFactory();
  const broadcasts: Array<{ sessionId: string; event: RunnerEvent }> = [];
  const manager = new SessionManager({
    sessions,
    projects,
    grants,
    runnerFactory: factory,
    broadcast: (sessionId, event) => broadcasts.push({ sessionId, event }),
  });
  return {
    manager,
    sessions,
    projects,
    grants,
    session,
    project,
    broadcasts,
    last,
    cleanup: () => {
      close();
      cleanup();
    },
  };
}

describe("SessionManager", () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("creates one runner per session and reuses it", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    const r1 = s.manager.getOrCreate(s.session.id);
    const r2 = s.manager.getOrCreate(s.session.id);
    expect(r1).toBe(r2);
  });

  it("throws for unknown session", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    expect(() => s.manager.getOrCreate("bogus")).toThrow(/not found/);
  });

  it("persists user messages and forwards them to the runner", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    await s.manager.sendUserMessage(s.session.id, "hi");
    const mock = s.last()!;
    expect(mock.sent).toEqual(["hi"]);
    const evs = s.sessions.listEvents(s.session.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("user_message");
    expect(evs[0].payload).toEqual({ text: "hi" });
  });

  it("persists assistant_text and bumps stats on turn_end", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "assistant_text",
      messageId: "m1",
      text: "hi there",
      done: true,
    });
    mock.emit({
      type: "turn_end",
      stopReason: "success",
    });

    const evs = s.sessions.listEvents(s.session.id);
    expect(evs.map((e) => e.kind)).toEqual(["assistant_text", "turn_end"]);
    const fresh = s.sessions.findById(s.session.id)!;
    expect(fresh.stats.messages).toBe(1);
    expect(fresh.lastMessageAt).not.toBeNull();
    expect(fresh.status).toBe("idle");
  });

  it("round-trips all four usage fields through turn_end payload", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "turn_end",
      stopReason: "success",
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        cacheReadInputTokens: 50_000,
        cacheCreationInputTokens: 4_000,
      },
    });

    const evs = s.sessions.listEvents(s.session.id);
    const turnEnd = evs.find((e) => e.kind === "turn_end")!;
    expect(turnEnd.payload).toEqual({
      stopReason: "success",
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        cacheReadInputTokens: 50_000,
        cacheCreationInputTokens: 4_000,
      },
    });
  });

  it("round-trips both usage (per-call) and billingUsage (cumulative) through turn_end payload", () => {
    // Live runner from the per-call fix onward emits both fields. Manager
    // must persist both so consumers downstream (`scanTurnEnds`, stats SQL,
    // export) can pick the right one for each surface.
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "turn_end",
      stopReason: "success",
      usage: {
        inputTokens: 10,
        outputTokens: 30,
        cacheReadInputTokens: 150_000,
        cacheCreationInputTokens: 0,
      },
      billingUsage: {
        inputTokens: 15,
        outputTokens: 50,
        cacheReadInputTokens: 250_000,
        cacheCreationInputTokens: 0,
      },
    });

    const evs = s.sessions.listEvents(s.session.id);
    const turnEnd = evs.find((e) => e.kind === "turn_end")!;
    expect(turnEnd.payload).toEqual({
      stopReason: "success",
      usage: {
        inputTokens: 10,
        outputTokens: 30,
        cacheReadInputTokens: 150_000,
        cacheCreationInputTokens: 0,
      },
      billingUsage: {
        inputTokens: 15,
        outputTokens: 50,
        cacheReadInputTokens: 250_000,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it("flips status to awaiting on permission_request and back to running on decision", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "permission_request",
      toolUseId: "tu-1",
      toolName: "Bash",
      input: { command: "ls" },
      title: "use Bash",
    });
    expect(s.sessions.findById(s.session.id)!.status).toBe("awaiting");

    s.manager.resolvePermission(s.session.id, "tu-1", "allow_once");
    expect(mock.permissions).toEqual([{ id: "tu-1", behavior: "allow" }]);
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");

    const kinds = s.sessions.listEvents(s.session.id).map((e) => e.kind);
    expect(kinds).toContain("permission_request");
    expect(kinds).toContain("permission_decision");
  });

  it("allow_always records a tool grant that auto-approves next matching call", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;

    mock.emit({
      type: "permission_request",
      toolUseId: "tu-1",
      toolName: "Bash",
      input: { command: "pnpm vitest run" },
      title: "use Bash",
    });
    s.manager.resolvePermission(s.session.id, "tu-1", "allow_always");

    // Second request with the same command should be auto-allowed
    // (resolved without flipping status or emitting a permission_request)
    s.sessions.setStatus(s.session.id, "running");
    mock.emit({
      type: "permission_request",
      toolUseId: "tu-2",
      toolName: "Bash",
      input: { command: "pnpm vitest run" },
      title: "use Bash",
    });
    expect(mock.permissions).toEqual([
      { id: "tu-1", behavior: "allow" },
      { id: "tu-2", behavior: "allow" },
    ]);
    // Auto-approved requests do not persist a permission_request event.
    const kinds = s.sessions.listEvents(s.session.id).map((e) => e.kind);
    const permReqs = kinds.filter((k) => k === "permission_request");
    expect(permReqs).toHaveLength(1);
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");
  });

  it("auto-approved permission (matched grant) appends a permission_decision with automatic:true and audits", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Spy-style audit store: capture every append() call. We stub the whole
    // AuditStore surface the manager touches — it only uses .append.
    const audits: Array<{ event: string; target: string | null; detail: string | null }> = [];
    const stubAudit = {
      append(input: { event: string; target?: string | null; detail?: string | null }) {
        audits.push({
          event: input.event,
          target: input.target ?? null,
          detail: input.detail ?? null,
        });
      },
    };
    // Re-wire the manager's audit dep via the same store instances — easier
    // than re-instantiating everything.
    (s.manager as unknown as { deps: { audit: typeof stubAudit } }).deps.audit =
      stubAudit;

    // Seed a GLOBAL grant matching a Bash command, then emit a matching
    // permission_request — should auto-resolve without persisting a
    // permission_request event but WITH a permission_decision event +
    // audit row carrying `automatic: true` / `auto: Bash matched …`.
    s.grants.addGlobalGrant("Bash", "pnpm vitest run");

    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "permission_request",
      toolUseId: "tu-auto",
      toolName: "Bash",
      input: { command: "pnpm vitest run" },
      title: "use Bash",
    });

    // Runner got the allow without the user doing anything.
    expect(mock.permissions).toEqual([{ id: "tu-auto", behavior: "allow" }]);

    const events = s.sessions.listEvents(s.session.id);
    // No user-facing permission_request row because it was auto-handled.
    expect(events.filter((e) => e.kind === "permission_request")).toHaveLength(0);
    // But exactly one permission_decision row with automatic: true and the
    // matched grant id threaded through.
    const decisions = events.filter((e) => e.kind === "permission_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].payload).toMatchObject({
      approvalId: "tu-auto",
      decision: "allow_always",
      automatic: true,
    });
    expect(typeof (decisions[0].payload as { matchedGrantId: unknown }).matchedGrantId).toBe(
      "string",
    );

    // And the audit trail got one permission_granted row identifying this as
    // an auto-grant.
    expect(audits).toHaveLength(1);
    expect(audits[0].event).toBe("permission_granted");
    expect(audits[0].target).toBe(s.session.id);
    expect(audits[0].detail).toMatch(/^auto: Bash matched/);
  });

  it("deny decision still resolves and does not grant", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "permission_request",
      toolUseId: "tu-1",
      toolName: "Edit",
      input: { file_path: "/x/y.ts" },
      title: "Edit",
    });
    s.manager.resolvePermission(s.session.id, "tu-1", "deny");
    expect(mock.permissions).toEqual([{ id: "tu-1", behavior: "deny" }]);
    expect(s.grants.has(s.session.id, "Edit", "/x/y.ts")).toBe(false);
  });

  it("sendUserMessage broadcasts a user_message event to subscribers", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    await s.manager.sendUserMessage(s.session.id, "hey");
    const userBroadcasts = s.broadcasts.filter(
      (b) => b.event.type === "user_message",
    );
    expect(userBroadcasts).toHaveLength(1);
    const ev = userBroadcasts[0].event as {
      type: "user_message";
      text: string;
      at: string;
    };
    expect(ev.text).toBe("hey");
    // ISO 8601 timestamp.
    expect(Number.isNaN(Date.parse(ev.at))).toBe(false);
  });

  it("broadcasts every event to subscribers", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({ type: "status", status: "running" });
    mock.emit({
      type: "assistant_text",
      messageId: "m1",
      text: "ok",
      done: true,
    });
    expect(s.broadcasts.map((b) => b.event.type)).toEqual([
      "status",
      "assistant_text",
    ]);
  });

  it("error events persist and flip session to error status", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({ type: "error", code: "boom", message: "oops" });
    const fresh = s.sessions.findById(s.session.id)!;
    expect(fresh.status).toBe("error");
    const ev = s.sessions.listEvents(s.session.id).find((e) => e.kind === "error");
    expect(ev?.payload).toMatchObject({ code: "boom", message: "oops" });
  });

  it("disposeAll cleans up all runners", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    await s.manager.disposeAll();
    expect(mock.disposed).toBe(true);
  });

  it("resolvePermission is a no-op on a stopped session", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Don't create the runner — just try to resolve
    expect(() =>
      s.manager.resolvePermission(s.session.id, "tu-1", "allow_once"),
    ).not.toThrow();
  });

  it("applyPermissionMode forwards to the live runner and is a no-op when none attached", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Nothing attached yet → returns false and doesn't throw.
    const beforeAttach = await s.manager.applyPermissionMode(
      s.session.id,
      "plan",
    );
    expect(beforeAttach).toBe(false);

    // Attach a runner and flip the mode.
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    const afterAttach = await s.manager.applyPermissionMode(
      s.session.id,
      "acceptEdits",
    );
    expect(afterAttach).toBe(true);
    expect(mock.permissionModes).toEqual(["acceptEdits"]);
    expect(s.manager.hasRunner(s.session.id)).toBe(true);
  });

  // ---- SDK session resume --------------------------------------------------

  it("first getOrCreate has no resumeSdkSessionId when DB row is NULL", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    expect(mock.initOpts.resumeSdkSessionId).toBeUndefined();
    // DB should still be NULL (nothing has emitted sdk_session_id yet).
    expect(s.sessions.findById(s.session.id)!.sdkSessionId).toBeNull();
  });

  it("sdk_session_id event persists the id to the DB row", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({ type: "sdk_session_id", sdkSessionId: "sdk-abc-123" });
    expect(s.sessions.findById(s.session.id)!.sdkSessionId).toBe("sdk-abc-123");
  });

  it("subsequent getOrCreate (after disposeAll) passes resumeSdkSessionId from the DB", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // First spawn + emit sdk_session_id.
    s.manager.getOrCreate(s.session.id);
    s.last()!.emit({ type: "sdk_session_id", sdkSessionId: "sdk-persisted" });
    // Simulate a server restart: tear down all live runners, then re-create.
    await s.manager.disposeAll();

    s.manager.getOrCreate(s.session.id);
    const second = s.last()!;
    expect(second.initOpts.resumeSdkSessionId).toBe("sdk-persisted");
    expect(second.initOpts.sessionId).toBe(s.session.id);
  });

  it("repeated sdk_session_id events are first-write-wins (DB not overwritten)", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({ type: "sdk_session_id", sdkSessionId: "sdk-first" });
    // A second emit — shouldn't happen in practice (resume echoes the same id)
    // but guard against the SDK changing ids mid-session.
    mock.emit({ type: "sdk_session_id", sdkSessionId: "sdk-second" });
    expect(s.sessions.findById(s.session.id)!.sdkSessionId).toBe("sdk-first");
  });

  // ---- Auto-title from first user message ---------------------------------

  it("auto-retitles a placeholder-titled session from the first user_message", async () => {
    // Default setupManager creates a session with title "t" (≤3 words,
    // placeholder-ish) — exactly the case we want to catch.
    const s = setupManager();
    cleanups.push(s.cleanup);
    await s.manager.sendUserMessage(s.session.id, "Fix the hydration bug");
    expect(s.sessions.findById(s.session.id)!.title).toBe(
      "Fix the hydration bug",
    );
  });

  it("auto-retitle truncates long first messages with an ellipsis at a word boundary", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    const long =
      "implement this feature in a way that doesn't break anything and also handles edge cases";
    await s.manager.sendUserMessage(s.session.id, long);
    const title = s.sessions.findById(s.session.id)!.title;
    // Ends with the single-char ellipsis when we truncated.
    expect(title.endsWith("…")).toBe(true);
    // Underlying pre-ellipsis length must be ≤ the cap.
    expect(title.length).toBeLessThanOrEqual(61); // 60 + "…"
    // Should have snapped to a word boundary, not sliced mid-word.
    const body = title.slice(0, -1);
    expect(body).toBe(body.trimEnd());
    expect(long.startsWith(body)).toBe(true);
  });

  it("auto-retitle uses only the first line of a multi-line message", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    await s.manager.sendUserMessage(
      s.session.id,
      "Add login page\n\nShould have TOTP support and a remember-me checkbox.",
    );
    expect(s.sessions.findById(s.session.id)!.title).toBe("Add login page");
  });

  it("does NOT auto-retitle once the session has prior user_message events", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Send first message — this triggers the auto-retitle.
    await s.manager.sendUserMessage(s.session.id, "First prompt about X");
    // Manually reset the title to a placeholder to simulate a user who
    // blanked it out mid-conversation; the second message must NOT retitle.
    s.sessions.setTitle(s.session.id, "");
    await s.manager.sendUserMessage(s.session.id, "Follow-up question");
    expect(s.sessions.findById(s.session.id)!.title).toBe("");
  });

  it("does NOT auto-retitle a side chat (parentSessionId set)", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Create a child session with the deliberate "Side chat" title.
    const child = s.sessions.create({
      title: "Side chat",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
      parentSessionId: s.session.id,
    });
    await s.manager.sendUserMessage(child.id, "quick lateral question here");
    expect(s.sessions.findById(child.id)!.title).toBe("Side chat");
  });

  it("does NOT auto-retitle a session with a substantive existing title", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // A 4+ word title is treated as "user-chosen" and left alone.
    const kept = s.sessions.create({
      title: "Refactor the auth middleware today",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    await s.manager.sendUserMessage(kept.id, "actually let's do something else");
    expect(s.sessions.findById(kept.id)!.title).toBe(
      "Refactor the auth middleware today",
    );
  });

  it("auto-retitle overrides the server-default 'Untitled' placeholder", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    const defaulted = s.sessions.create({
      title: "Untitled",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    await s.manager.sendUserMessage(defaulted.id, "Add a dark-mode toggle");
    expect(s.sessions.findById(defaulted.id)!.title).toBe("Add a dark-mode toggle");
  });

  // ---- Silence watchdog ----------------------------------------------------

  it("leaves status + transcript alone when the runner is silent past the watchdog window", async () => {
    // Live silence is diagnostic-only now — we emit a pino warn and stop
    // there. Any status mutation here would kick the composer into the
    // errored lockout for what may be a legitimately-running turn.
    const prev = process.env.CLAUDEX_SESSION_WATCHDOG_MS;
    process.env.CLAUDEX_SESSION_WATCHDOG_MS = "1000";
    vi.useFakeTimers();
    const s = setupManager();
    cleanups.push(() => {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.CLAUDEX_SESSION_WATCHDOG_MS;
      else process.env.CLAUDEX_SESSION_WATCHDOG_MS = prev;
      s.cleanup();
    });
    await s.manager.sendUserMessage(s.session.id, "kick off");
    expect(s.sessions.findById(s.session.id)!.status).not.toBe("error");
    s.broadcasts.length = 0;

    // Advance past the watchdog window.
    await vi.advanceTimersByTimeAsync(1100);

    // Status is untouched — no lockout.
    expect(s.sessions.findById(s.session.id)!.status).not.toBe("error");
    // No synthesized `error` RunnerEvent went out (that's the frame that
    // would have driven the composer errored-lockout on the client).
    const errorBroadcasts = s.broadcasts.filter(
      (b) => b.event.type === "error" && b.sessionId === s.session.id,
    );
    expect(errorBroadcasts).toHaveLength(0);
    // No transcript error event appended.
    const logged = s.sessions
      .listEvents(s.session.id)
      .filter((e) => e.kind === "error");
    expect(logged).toHaveLength(0);
  });

  it("runner events reset the watchdog so no spurious work happens mid-turn", async () => {
    const prev = process.env.CLAUDEX_SESSION_WATCHDOG_MS;
    process.env.CLAUDEX_SESSION_WATCHDOG_MS = "1000";
    vi.useFakeTimers();
    const s = setupManager();
    cleanups.push(() => {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.CLAUDEX_SESSION_WATCHDOG_MS;
      else process.env.CLAUDEX_SESSION_WATCHDOG_MS = prev;
      s.cleanup();
    });
    await s.manager.sendUserMessage(s.session.id, "go");
    const mock = s.last()!;
    // Emit activity just before the window expires — watchdog should reset.
    await vi.advanceTimersByTimeAsync(800);
    mock.emit({
      type: "assistant_text",
      messageId: "m1",
      text: "still thinking",
      done: false,
    });
    // Go past the original window + past the new window — status is
    // untouched either way because live silence is log-only now. We still
    // test both advances to keep the reset-on-activity invariant covered.
    await vi.advanceTimersByTimeAsync(400);
    expect(s.sessions.findById(s.session.id)!.status).not.toBe("error");
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.sessions.findById(s.session.id)!.status).not.toBe("error");
    // No error events / broadcasts ever fired.
    const errorBroadcasts = s.broadcasts.filter(
      (b) => b.event.type === "error" && b.sessionId === s.session.id,
    );
    expect(errorBroadcasts).toHaveLength(0);
  });

  it("turn_end clears the watchdog so no spurious error fires after a clean turn", async () => {
    const prev = process.env.CLAUDEX_SESSION_WATCHDOG_MS;
    process.env.CLAUDEX_SESSION_WATCHDOG_MS = "1000";
    vi.useFakeTimers();
    const s = setupManager();
    cleanups.push(() => {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.CLAUDEX_SESSION_WATCHDOG_MS;
      else process.env.CLAUDEX_SESSION_WATCHDOG_MS = prev;
      s.cleanup();
    });
    await s.manager.sendUserMessage(s.session.id, "hi");
    const mock = s.last()!;
    mock.emit({ type: "turn_end", stopReason: "end_turn" });
    // Well past the watchdog window — if turn_end cleared the timer, status
    // should still be idle (not error).
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.sessions.findById(s.session.id)!.status).toBe("idle");
  });

  it("disposeAll cancels pending watchdogs so they can't fire post-shutdown", async () => {
    const prev = process.env.CLAUDEX_SESSION_WATCHDOG_MS;
    process.env.CLAUDEX_SESSION_WATCHDOG_MS = "1000";
    vi.useFakeTimers();
    const s = setupManager();
    cleanups.push(() => {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.CLAUDEX_SESSION_WATCHDOG_MS;
      else process.env.CLAUDEX_SESSION_WATCHDOG_MS = prev;
      s.cleanup();
    });
    await s.manager.sendUserMessage(s.session.id, "go");
    await s.manager.disposeAll();
    const broadcastsBefore = s.broadcasts.length;
    await vi.advanceTimersByTimeAsync(5000);
    // No new error broadcast after disposeAll.
    const newErrors = s.broadcasts
      .slice(broadcastsBefore)
      .filter((b) => b.event.type === "error");
    expect(newErrors).toHaveLength(0);
  });

  // ---- Boot sweep ----------------------------------------------------------

  it("sweepStuckOnBoot recovers a stale row to idle (composer-unlocking) instead of flipping to error", async () => {
    // Default 5-min window — force updated_at 10 min in the past so the
    // sweep counts the row as dead. Clock math is done in-DB via UPDATE.
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Stamp the seeded session as running with a stale updated_at.
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    s.sessions.setStatus(s.session.id, "running");
    // Direct UPDATE — SessionStore doesn't expose a way to set updated_at.
    const dbh = (s.sessions as unknown as { db: import("better-sqlite3").Database }).db;
    dbh.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      stale,
      s.session.id,
    );

    s.manager.sweepStuckOnBoot();

    const fresh = s.sessions.findById(s.session.id)!;
    // Recovered to idle, not error — the composer is usable again.
    expect(fresh.status).toBe("idle");
    // A watchdog_timeout event was appended so the transcript shows why.
    const errors = s.sessions
      .listEvents(s.session.id)
      .filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ code: "watchdog_timeout" });
    // Status broadcast fired so tabs unlock; no synthesized error frame
    // (that would re-lock the composer, which is exactly what we're
    // backing out of here).
    const statusBroadcasts = s.broadcasts.filter(
      (b) =>
        b.event.type === "status" &&
        (b.event as { status: string }).status === "idle" &&
        b.sessionId === s.session.id,
    );
    expect(statusBroadcasts.length).toBeGreaterThanOrEqual(1);
    const errBroadcasts = s.broadcasts.filter(
      (b) => b.event.type === "error" && b.sessionId === s.session.id,
    );
    expect(errBroadcasts).toHaveLength(0);
  });

  it("sweepStuckOnBoot re-arms the watchdog for in-window rows but the re-armed timer is log-only", async () => {
    const prev = process.env.CLAUDEX_SESSION_WATCHDOG_MS;
    process.env.CLAUDEX_SESSION_WATCHDOG_MS = "2000";
    vi.useFakeTimers();
    const s = setupManager();
    cleanups.push(() => {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.CLAUDEX_SESSION_WATCHDOG_MS;
      else process.env.CLAUDEX_SESSION_WATCHDOG_MS = prev;
      s.cleanup();
    });
    // Seed the row as running with updated_at 1500ms ago — sweep should
    // re-arm for the remaining ~500ms.
    s.sessions.setStatus(s.session.id, "running");
    const inWindow = new Date(Date.now() - 1500).toISOString();
    const dbh = (s.sessions as unknown as { db: import("better-sqlite3").Database }).db;
    dbh.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      inWindow,
      s.session.id,
    );

    s.manager.sweepStuckOnBoot();

    // Still running right after sweep — re-armed, not force-flipped.
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");
    // Advance past the remaining window — the live timer fires, but as
    // of the watchdog refactor it only logs. Status stays put.
    await vi.advanceTimersByTimeAsync(700);
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");
    const errBroadcasts = s.broadcasts.filter(
      (b) => b.event.type === "error" && b.sessionId === s.session.id,
    );
    expect(errBroadcasts).toHaveLength(0);
  });

  it("sweepStuckOnBoot is a no-op for idle rows", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Fresh session is already idle; sweep shouldn't touch it.
    s.manager.sweepStuckOnBoot();
    expect(s.sessions.findById(s.session.id)!.status).toBe("idle");
    // No error broadcasts fired for an idle row.
    const errs = s.broadcasts.filter((b) => b.event.type === "error");
    expect(errs).toHaveLength(0);
  });

  // ---- Force idle ----------------------------------------------------------

  it("forceIdle flips an errored session back to idle and broadcasts", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.sessions.setStatus(s.session.id, "error");
    s.broadcasts.length = 0;
    const flipped = s.manager.forceIdle(s.session.id, "user_forced_idle");
    expect(flipped).toBe(true);
    expect(s.sessions.findById(s.session.id)!.status).toBe("idle");
    const statusBroadcasts = s.broadcasts.filter(
      (b) =>
        b.event.type === "status" &&
        b.sessionId === s.session.id &&
        (b.event as { status: string }).status === "idle",
    );
    expect(statusBroadcasts).toHaveLength(1);
  });

  it("forceIdle is a no-op on an already-idle session", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    const flipped = s.manager.forceIdle(s.session.id, "user_forced_idle");
    expect(flipped).toBe(false);
  });

  it("forceIdle returns false for unknown session", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    expect(s.manager.forceIdle("bogus", "user_forced_idle")).toBe(false);
  });
});
