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
import type {
  AskUserQuestionAnnotation,
  PermissionMode,
} from "@claudex/shared";
import { tempConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// MockRunner — mirrors the pattern in session-manager.test.ts but exposes
// `emit` so a test can synthesize an `ask_user_question` RunnerEvent without
// having to spin up a real SDK process. We rely on the real `AgentRunner` for
// the other half of the coverage (`canUseTool → updatedInput` shape).
// ---------------------------------------------------------------------------
class MockRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  private listeners = new Set<RunnerListener>();
  askResolves: Array<{
    askId: string;
    answers: Record<string, string>;
    annotations?: Record<string, AskUserQuestionAnnotation>;
  }> = [];

  constructor(opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
  }
  async start() {}
  async sendUserMessage() {}
  resolvePermission() {}
  resolveAskUserQuestion(
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ) {
    this.askResolves.push({ askId, answers, annotations });
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
    mode: "default",
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

describe("AskUserQuestion — AgentRunner canUseTool branch", () => {
  it("emits an ask_user_question RunnerEvent and resolves with AskUserQuestionOutput shape", async () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "default",
    });
    const events: RunnerEvent[] = [];
    runner.on((e) => events.push(e));

    // The real sdkOptions.canUseTool closure is installed inside `start()` so
    // we can't reach it without spawning. Reproduce the exact expression here
    // — this is what the SDK will invoke.
    const input = {
      questions: [
        {
          question: "Which auth method?",
          header: "Auth",
          multiSelect: false,
          options: [
            { label: "OAuth", description: "Use Google" },
            { label: "Email", description: "Magic link" },
          ],
        },
      ],
    };
    const promise = new Promise<
      | { behavior: "allow"; updatedInput?: Record<string, unknown> }
      | { behavior: "deny"; message: string }
    >((resolve) => {
      // Private map write — same mechanism agent-runner.ts uses internally.
      (runner as any).pendingAskUserQuestion.set("tu-ask-1", (
        resp: {
          answers: Record<string, string>;
          annotations?: Record<string, AskUserQuestionAnnotation>;
        },
      ) => {
        const updatedInput: Record<string, unknown> = {
          ...input,
          answers: resp.answers,
        };
        if (resp.annotations) updatedInput.annotations = resp.annotations;
        resolve({ behavior: "allow", updatedInput });
      });
      (runner as any).emit({
        type: "ask_user_question",
        askId: "tu-ask-1",
        questions: input.questions,
      } satisfies RunnerEvent);
    });

    // Client answers.
    runner.resolveAskUserQuestion("tu-ask-1", { "Which auth method?": "OAuth" });
    const resolved = await promise;

    expect(resolved.behavior).toBe("allow");
    expect((resolved as any).updatedInput).toMatchObject({
      answers: { "Which auth method?": "OAuth" },
    });
    // The RunnerEvent was emitted to the listener.
    expect(events).toContainEqual({
      type: "ask_user_question",
      askId: "tu-ask-1",
      questions: input.questions,
    });
  });

  it("second resolveAskUserQuestion for the same askId is a no-op (double-submit race)", () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "default",
    });
    const calls: Array<{ answers: Record<string, string> }> = [];
    (runner as any).pendingAskUserQuestion.set("ask-dup", (resp: any) => {
      calls.push(resp);
    });
    runner.resolveAskUserQuestion("ask-dup", { q: "a" });
    runner.resolveAskUserQuestion("ask-dup", { q: "b" });
    expect(calls).toHaveLength(1);
    expect(calls[0].answers).toEqual({ q: "a" });
  });
});

describe("AskUserQuestion — SessionManager persistence + resolveAskUserQuestion", () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("persists ask_user_question, then ask_user_answer on resolve; status flips awaiting ↔ running", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);

    // Spin up the mock runner for this session so we can emit a RunnerEvent
    // through it (manager listens on `runner.on`).
    s.manager.getOrCreate(s.session.id);
    const runner = s.getRunner();

    const questions = [
      {
        question: "Which library?",
        header: "Library",
        multiSelect: false,
        options: [
          { label: "dayjs", description: "small" },
          { label: "date-fns", description: "functional" },
        ],
      },
    ];

    runner.emit({
      type: "ask_user_question",
      askId: "ask-1",
      questions,
    });

    // Persisted question event + awaiting status.
    const events = s.sessions.listEvents(s.session.id);
    const q = events.find((e) => e.kind === "ask_user_question");
    expect(q).toBeTruthy();
    expect((q!.payload as any).askId).toBe("ask-1");
    expect((q!.payload as any).questions).toEqual(questions);
    expect(s.sessions.findById(s.session.id)!.status).toBe("awaiting");

    // The WS broadcast saw the event unchanged (payload passes through).
    const broadcastKinds = s.broadcasts.map((b) => b.event.type);
    expect(broadcastKinds).toContain("ask_user_question");

    // User submits an answer.
    s.manager.resolveAskUserQuestion(
      s.session.id,
      "ask-1",
      { "Which library?": "dayjs" },
      { "Which library?": { notes: "seen it in the mockup" } },
    );

    // Answer was forwarded to the runner.
    expect(runner.askResolves).toEqual([
      {
        askId: "ask-1",
        answers: { "Which library?": "dayjs" },
        annotations: { "Which library?": { notes: "seen it in the mockup" } },
      },
    ]);

    // Sibling event appended (append-only log — question row is not mutated).
    const events2 = s.sessions.listEvents(s.session.id);
    const a = events2.find((e) => e.kind === "ask_user_answer");
    expect(a).toBeTruthy();
    expect((a!.payload as any).askId).toBe("ask-1");
    expect((a!.payload as any).answers).toEqual({
      "Which library?": "dayjs",
    });
    expect((a!.payload as any).annotations).toEqual({
      "Which library?": { notes: "seen it in the mockup" },
    });

    // Question row is unchanged (verify append-only).
    const q2 = events2.find((e) => e.kind === "ask_user_question");
    expect(q2!.payload).toEqual(q!.payload);

    // Status flipped back to running.
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");
  });

  it("does NOT route AskUserQuestion through the permission_request flow", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);

    s.manager.getOrCreate(s.session.id);
    const runner = s.getRunner();

    runner.emit({
      type: "ask_user_question",
      askId: "ask-2",
      questions: [
        {
          question: "Pick one",
          header: "Pick",
          multiSelect: false,
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    });

    const events = s.sessions.listEvents(s.session.id);
    expect(events.find((e) => e.kind === "permission_request")).toBeUndefined();
    expect(events.find((e) => e.kind === "ask_user_question")).toBeTruthy();
  });
});
