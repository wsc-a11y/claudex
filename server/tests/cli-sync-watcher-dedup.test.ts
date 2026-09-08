import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.js";
import { SessionStore } from "../src/sessions/store.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import { SessionManager } from "../src/sessions/manager.js";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
  RunnerListener,
} from "../src/sessions/runner.js";
import { startCliSyncWatcher } from "../src/cli-sync/watcher.js";
import { tempConfig } from "./helpers.js";

/**
 * Regression test for the duplicate-transcript bug introduced when the CLI
 * live-sync watcher landed: when claudex itself is driving a session via
 * AgentRunner, the SDK writes each turn to `~/.claude/projects/<slug>/
 * <uuid>.jsonl`. The watcher saw those writes as `change` events and re-
 * imported the same turns, so every user/assistant event landed twice in
 * `session_events` — once via `SessionManager.handleEvent`, once via
 * `resyncCliSession`.
 *
 * The fix: `onExistingChange` now checks `manager.hasRunner(sessionId)` and
 * skips the resync branch when a live runner is attached. For CLI-driven
 * sessions (Plan B's main use case: "claude running in CLI, claudex shows
 * it"), `hasRunner` is false, so resync still fires as before.
 */

// ---- Mock runner -----------------------------------------------------------

class MockRunner implements Runner {
  sessionId: string;
  private listeners = new Set<RunnerListener>();
  disposed = false;

  constructor(opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
  }

  async start() {
    /* noop */
  }
  async sendUserMessage() {
    /* noop */
  }
  resolvePermission() {
    /* noop */
  }
  resolveAskUserQuestion() {
    /* noop */
  }
  resolvePlanAccept() {
    /* noop */
  }
  async interrupt() {
    /* noop */
  }
  async setPermissionMode() {
    /* noop */
  }
  async dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
  on(l: RunnerListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(ev: RunnerEvent) {
    for (const l of this.listeners) l(ev);
  }
}

function createFactory(): {
  factory: RunnerFactory;
  last: () => MockRunner | null;
} {
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

// ---- Harness ---------------------------------------------------------------

const SDK_ID = "99887766-aaaa-bbbb-cccc-112233445566";
const SLUG = "-tmp-demo";

function setup() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const sessions = new SessionStore(db);
  const projects = new ProjectStore(db);

  const project = projects.create({
    name: "demo",
    path: "/tmp/demo",
    trusted: true,
  });
  const session = sessions.create({
    title: "t",
    projectId: project.id,
    model: "claude-opus-4-8",
    mode: "default",
  });
  sessions.setSdkSessionId(session.id, SDK_ID);
  // Simulate a CLI-adopted session so the watcher's new native-session
  // short-circuit doesn't skip us. See cli-sync/watcher.ts onExistingChange.
  sessions.setAdoptedFromCli(session.id, true);

  const cliRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-watcher-dedup-"),
  );
  const dir = path.join(cliRoot, SLUG);
  fs.mkdirSync(dir, { recursive: true });
  const jsonlPath = path.join(dir, `${SDK_ID}.jsonl`);

  const { factory, last } = createFactory();
  const broadcasts: Array<{ sessionId: string; event: RunnerEvent }> = [];
  const manager = new SessionManager({
    sessions,
    projects,
    grants: new ToolGrantStore(db),
    runnerFactory: factory,
    broadcast: (sessionId, event) => broadcasts.push({ sessionId, event }),
  });

  const watcher = startCliSyncWatcher({
    sessions,
    projects,
    manager,
    cliProjectsRoot: cliRoot,
  });

  return {
    sessions,
    session,
    manager,
    watcher,
    runnerFactory: last,
    broadcasts,
    cliRoot,
    jsonlPath,
    writeJsonl(lines: unknown[]) {
      const body = lines.map((l) => JSON.stringify(l)).join("\n");
      fs.writeFileSync(jsonlPath, body + "\n");
    },
    appendJsonl(lines: unknown[]) {
      const body = lines.map((l) => JSON.stringify(l)).join("\n");
      fs.appendFileSync(jsonlPath, body + "\n");
    },
    cleanup: async () => {
      await watcher.close();
      fs.rmSync(cliRoot, { recursive: true, force: true });
      close();
      cleanup();
    },
  };
}

describe("cli-sync watcher duplicate prevention", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it("does NOT re-import events when a live AgentRunner is attached", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);

    // Seed a pre-existing cli_jsonl_seq as if an earlier turn was already
    // tracked — this is the realistic state when claudex picks up a session
    // that's been running. Without it, resync's legacy-row branch masks the
    // bug via an unrelated heuristic.
    ctx.writeJsonl([{ type: "user", message: { role: "user", content: "seed" } }]);
    ctx.sessions.setCliJsonlSeq(ctx.session.id, 1);

    // Attach a live runner — this is what claudex does when it drives a
    // session. `hasRunner(sessionId)` is now true.
    ctx.manager.getOrCreate(ctx.session.id);
    const runner = ctx.runnerFactory()!;

    // Simulate claudex driving a turn: runner emits events, manager
    // persists them to session_events via handleEvent (normal path).
    // Also persist the user_message directly (mirrors sendUserMessage,
    // which appends user_message BEFORE the runner's own turn begins).
    ctx.sessions.appendEvent({
      sessionId: ctx.session.id,
      kind: "user_message",
      payload: { text: "hello" },
    });
    runner.emit({
      type: "assistant_text",
      messageId: "msg_abc",
      text: "hi back",
      done: true,
    });
    runner.emit({ type: "turn_end", stopReason: "end_turn", usage: null });

    const countBefore = ctx.sessions.countEvents(ctx.session.id);

    // Now the SDK mirrors the same turn to the JSONL — exactly what
    // `@anthropic-ai/claude-agent-sdk` does in real life.
    ctx.appendJsonl([
      { type: "user", message: { role: "user", content: "hello" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi back" }],
          stop_reason: "end_turn",
        },
      },
    ]);

    // The watcher fires. Before the fix this would import both JSONL lines
    // and append duplicate `user_message` + `assistant_text` + `turn_end`
    // events. After the fix it must NOT append anything — the runner is
    // still attached, claudex is the one writing.
    await ctx.watcher.__handleForTest("change", ctx.jsonlPath);

    const countAfter = ctx.sessions.countEvents(ctx.session.id);
    expect(countAfter).toBe(countBefore);

    // Dedup rule-of-thumb: only one copy of each kind for this turn.
    const events = ctx.sessions.listEvents(ctx.session.id);
    const userMsgCount = events.filter((e) => e.kind === "user_message").length;
    const assistantCount = events.filter(
      (e) => e.kind === "assistant_text",
    ).length;
    const turnEndCount = events.filter((e) => e.kind === "turn_end").length;
    expect(userMsgCount).toBe(1);
    expect(assistantCount).toBe(1);
    expect(turnEndCount).toBe(1);

    // But `cli_jsonl_seq` must be bumped so that after the runner disposes,
    // subsequent CLI edits resume from the right offset rather than
    // reimporting the whole file (1 seed + 2 new = 3 non-empty lines).
    expect(ctx.sessions.getCliJsonlSeq(ctx.session.id)).toBe(3);
  });

  it("DOES resync when no runner is attached (CLI-driven session)", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    // No `getOrCreate` — claudex is just observing a CLI-driven session.
    expect(ctx.manager.hasRunner(ctx.session.id)).toBe(false);

    ctx.writeJsonl([
      { type: "user", message: { role: "user", content: "turn 1" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "reply 1" }],
          stop_reason: "end_turn",
        },
      },
    ]);

    const countBefore = ctx.sessions.countEvents(ctx.session.id);
    await ctx.watcher.__handleForTest("change", ctx.jsonlPath);
    const countAfter = ctx.sessions.countEvents(ctx.session.id);
    expect(countAfter).toBeGreaterThan(countBefore);
    expect(ctx.sessions.getCliJsonlSeq(ctx.session.id)).toBe(2);
  });

  it("resumes resync after the runner disposes", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);

    // Phase 1: runner attached, claudex drives.
    ctx.manager.getOrCreate(ctx.session.id);
    ctx.sessions.appendEvent({
      sessionId: ctx.session.id,
      kind: "user_message",
      payload: { text: "hello" },
    });
    ctx.writeJsonl([
      { type: "user", message: { role: "user", content: "hello" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
        },
      },
    ]);
    await ctx.watcher.__handleForTest("change", ctx.jsonlPath);
    const countAfterRunnerPhase = ctx.sessions.countEvents(ctx.session.id);
    // Only our one manual append — resync was skipped.
    expect(countAfterRunnerPhase).toBe(1);

    // Phase 2: runner disposes, user resumes in CLI, new lines appear.
    await ctx.manager.dispose(ctx.session.id);
    expect(ctx.manager.hasRunner(ctx.session.id)).toBe(false);

    ctx.appendJsonl([
      { type: "user", message: { role: "user", content: "cli turn" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "cli reply" }],
          stop_reason: "end_turn",
        },
      },
    ]);
    await ctx.watcher.__handleForTest("change", ctx.jsonlPath);
    const countAfterCliPhase = ctx.sessions.countEvents(ctx.session.id);
    // Strictly more events — resync ran and picked up the CLI turn only,
    // NOT the earlier lines that the runner phase already wrote.
    expect(countAfterCliPhase).toBeGreaterThan(countAfterRunnerPhase);
    const events = ctx.sessions.listEvents(ctx.session.id);
    const userMsgs = events.filter((e) => e.kind === "user_message");
    // Phase 1 appended "hello"; phase 2 should add "cli turn" exactly once.
    expect(userMsgs).toHaveLength(2);
  });
});
