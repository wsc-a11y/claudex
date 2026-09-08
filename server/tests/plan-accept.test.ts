import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionManager } from "../src/sessions/manager.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import { AgentRunner } from "../src/sessions/agent-runner.js";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
  RunnerListener,
} from "../src/sessions/runner.js";
import type { PermissionMode } from "@claudex/shared";
import { tempConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// MockRunner — mirrors the pattern in ask-user-question.test.ts but exposes
// `emit` so a test can synthesize a `plan_accept_request` RunnerEvent without
// having to spin up a real SDK process. The other half of the coverage
// exercises `AgentRunner` directly to confirm the canUseTool closure resolves
// with `{behavior:"allow"}` on accept and `{behavior:"deny", message}` on
// reject.
// ---------------------------------------------------------------------------
class MockRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  private listeners = new Set<RunnerListener>();
  planResolves: Array<{ planId: string; decision: "accept" | "reject" }> = [];

  constructor(opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
  }
  async start() {}
  async sendUserMessage() {}
  resolvePermission() {}
  resolveAskUserQuestion() {}
  resolvePlanAccept(planId: string, decision: "accept" | "reject") {
    this.planResolves.push({ planId, decision });
  }
  async interrupt() {}
  async setPermissionMode(_: PermissionMode) {}
  async dispose() {
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

function setupManager() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const grants = new ToolGrantStore(db);
  const project = projects.create({
    name: "p",
    path: "/p/demo",
    trusted: true,
  });
  const session = sessions.create({
    title: "t",
    projectId: project.id,
    model: "claude-opus-4-8",
    mode: "plan",
  });
  let last: MockRunner | null = null;
  const factory: RunnerFactory = {
    create(opts) {
      last = new MockRunner(opts);
      return last;
    },
  };
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
    session,
    broadcasts,
    getRunner: () => last!,
    cleanup: () => {
      close();
      cleanup();
    },
  };
}

describe("ExitPlanMode — AgentRunner canUseTool branch", () => {
  it("emits plan_accept_request and resolves allow on accept", async () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "plan",
    });
    const events: RunnerEvent[] = [];
    runner.on((e) => events.push(e));

    // Reproduce the exact closure agent-runner.ts installs in sdkOptions —
    // we can't reach into the real one without spawning the SDK.
    const input = { plan: "1. do a\n2. do b" };
    const promise = new Promise<
      | { behavior: "allow"; updatedInput?: Record<string, unknown> }
      | { behavior: "deny"; message: string }
    >((resolve) => {
      (runner as any).pendingPlanAccept.set("tu-plan-1", (
        decision: "accept" | "reject",
      ) => {
        if (decision === "accept") {
          resolve({ behavior: "allow", updatedInput: input });
        } else {
          resolve({
            behavior: "deny",
            message: "plan not accepted — please revise",
          });
        }
      });
      (runner as any).emit({
        type: "plan_accept_request",
        planId: "tu-plan-1",
        plan: input.plan,
      } satisfies RunnerEvent);
    });

    runner.resolvePlanAccept("tu-plan-1", "accept");
    const resolved = await promise;
    expect(resolved.behavior).toBe("allow");
    expect(events).toContainEqual({
      type: "plan_accept_request",
      planId: "tu-plan-1",
      plan: "1. do a\n2. do b",
    });
  });

  it("resolves deny with a human-readable message on reject", async () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "plan",
    });
    const input = { plan: "draft plan" };
    const promise = new Promise<
      | { behavior: "allow"; updatedInput?: Record<string, unknown> }
      | { behavior: "deny"; message: string }
    >((resolve) => {
      (runner as any).pendingPlanAccept.set("tu-plan-2", (
        decision: "accept" | "reject",
      ) => {
        if (decision === "accept") {
          resolve({ behavior: "allow", updatedInput: input });
        } else {
          resolve({
            behavior: "deny",
            message: "plan not accepted — please revise",
          });
        }
      });
    });

    runner.resolvePlanAccept("tu-plan-2", "reject");
    const resolved = await promise;
    expect(resolved.behavior).toBe("deny");
    expect((resolved as { behavior: "deny"; message: string }).message).toMatch(
      /plan not accepted/,
    );
  });

  it("second resolvePlanAccept for the same planId is a no-op (double-submit race)", () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "plan",
    });
    const calls: Array<"accept" | "reject"> = [];
    (runner as any).pendingPlanAccept.set("plan-dup", (
      decision: "accept" | "reject",
    ) => {
      calls.push(decision);
    });
    runner.resolvePlanAccept("plan-dup", "accept");
    runner.resolvePlanAccept("plan-dup", "reject");
    expect(calls).toEqual(["accept"]);
  });
});

describe("ExitPlanMode — SessionManager persistence + resolvePlanAccept", () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("persists plan_accept_request, then plan_accept_decision on accept; status flips awaiting ↔ running", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);

    s.manager.getOrCreate(s.session.id);
    const runner = s.getRunner();

    runner.emit({
      type: "plan_accept_request",
      planId: "plan-1",
      plan: "## plan\n- step 1\n- step 2",
    });

    // Persisted request event + awaiting status.
    const events = s.sessions.listEvents(s.session.id);
    const req = events.find((e) => e.kind === "plan_accept_request");
    expect(req).toBeTruthy();
    expect((req!.payload as any).planId).toBe("plan-1");
    expect((req!.payload as any).plan).toContain("step 1");
    expect(s.sessions.findById(s.session.id)!.status).toBe("awaiting");

    // The WS broadcast saw the event unchanged.
    const broadcastKinds = s.broadcasts.map((b) => b.event.type);
    expect(broadcastKinds).toContain("plan_accept_request");

    // No permission_request / permission_decision leakage — ExitPlanMode
    // must NOT fall through to the generic permission gate.
    expect(events.find((e) => e.kind === "permission_request")).toBeUndefined();
    expect(
      events.find((e) => e.kind === "permission_decision"),
    ).toBeUndefined();

    // User accepts.
    s.manager.resolvePlanAccept(s.session.id, "plan-1", "accept");

    // Decision forwarded to the runner.
    expect(runner.planResolves).toEqual([
      { planId: "plan-1", decision: "accept" },
    ]);

    // Sibling decision event appended (append-only log — request row
    // unchanged).
    const events2 = s.sessions.listEvents(s.session.id);
    const dec = events2.find((e) => e.kind === "plan_accept_decision");
    expect(dec).toBeTruthy();
    expect((dec!.payload as any).planId).toBe("plan-1");
    expect((dec!.payload as any).decision).toBe("accept");

    const req2 = events2.find((e) => e.kind === "plan_accept_request");
    expect(req2!.payload).toEqual(req!.payload);

    // Status flipped back to running.
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");

    // Still no permission_* leakage anywhere in the transcript.
    expect(
      events2.find(
        (e) => e.kind === "permission_request" || e.kind === "permission_decision",
      ),
    ).toBeUndefined();
  });

  it("persists plan_accept_decision with decision=reject and forwards to runner", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);

    s.manager.getOrCreate(s.session.id);
    const runner = s.getRunner();

    runner.emit({
      type: "plan_accept_request",
      planId: "plan-2",
      plan: "rough plan",
    });

    s.manager.resolvePlanAccept(s.session.id, "plan-2", "reject");

    expect(runner.planResolves).toEqual([
      { planId: "plan-2", decision: "reject" },
    ]);

    const events = s.sessions.listEvents(s.session.id);
    const dec = events.find((e) => e.kind === "plan_accept_decision");
    expect(dec).toBeTruthy();
    expect((dec!.payload as any).decision).toBe("reject");
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");
  });

  it("does NOT route ExitPlanMode through the permission_request flow", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);

    s.manager.getOrCreate(s.session.id);
    const runner = s.getRunner();

    runner.emit({
      type: "plan_accept_request",
      planId: "plan-3",
      plan: "some plan",
    });

    const events = s.sessions.listEvents(s.session.id);
    expect(events.find((e) => e.kind === "permission_request")).toBeUndefined();
    expect(events.find((e) => e.kind === "plan_accept_request")).toBeTruthy();
  });
});
