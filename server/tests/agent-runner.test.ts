import { describe, it, expect } from "vitest";
import { AgentRunner } from "../src/sessions/agent-runner.js";
import type { RunnerEvent } from "../src/sessions/runner.js";

/**
 * These tests reach into AgentRunner's private translate() method to exercise
 * the SDK → RunnerEvent mapping deterministically, without spawning a real
 * `claude` subprocess. Unit-level confidence that the wire-format handling
 * matches what the SDK sends lives here; live integration coverage comes
 * later when we can point at a real claude install.
 */
describe("AgentRunner.translate (SDK message → RunnerEvent)", () => {
  function collect(): {
    runner: AgentRunner;
    events: RunnerEvent[];
    translate: (msg: any) => void;
  } {
    const runner = new AgentRunner({
      sessionId: "sess-1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "default",
    });
    const events: RunnerEvent[] = [];
    runner.on((e) => events.push(e));
    return {
      runner,
      events,
      translate: (runner as any).translate.bind(runner),
    };
  }

  it("captures sdk session id from system/init", () => {
    const { runner, events, translate } = collect();
    translate({
      type: "system",
      subtype: "init",
      session_id: "sdk-abc-123",
      model: "claude-opus-4-8",
      tools: [],
      cwd: "/tmp",
      mcp_servers: [],
      permissionMode: "default",
    });
    expect(runner.sdkSessionId).toBe("sdk-abc-123");
    expect(events).toContainEqual({
      type: "sdk_session_id",
      sdkSessionId: "sdk-abc-123",
    });
  });

  it("does not overwrite sdk session id on duplicate init", () => {
    const { runner, translate } = collect();
    translate({ type: "system", subtype: "init", session_id: "a" });
    translate({ type: "system", subtype: "init", session_id: "b" });
    expect(runner.sdkSessionId).toBe("a");
  });

  it("maps assistant text blocks", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [{ type: "text", text: "hello world" }],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "assistant_text",
      messageId: "msg-1",
      text: "hello world",
      done: true,
    });
  });

  it("maps thinking blocks", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [{ type: "thinking", thinking: "let me check…" }],
      },
    });
    expect(events).toContainEqual({
      type: "thinking",
      text: "let me check…",
    });
  });

  it("maps tool_use blocks with input intact", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "Bash",
            input: { command: "ls -la" },
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: "tool_use",
      toolUseId: "tu-1",
      name: "Bash",
      input: { command: "ls -la" },
    });
  });

  it("maps tool_result string content", () => {
    const { events, translate } = collect();
    translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: "hello\nworld",
            is_error: false,
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tu-1",
      content: "hello\nworld",
      isError: false,
    });
  });

  it("maps tool_result with array content (text blocks)", () => {
    const { events, translate } = collect();
    translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
            is_error: false,
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tu-2",
      content: "line 1\nline 2",
      isError: false,
    });
  });

  it("marks tool_result as error when is_error=true", () => {
    const { events, translate } = collect();
    translate({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-3",
            content: "command not found",
            is_error: true,
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tu-3",
      content: "command not found",
      isError: true,
    });
  });

  it("maps result message to turn_end and status idle", () => {
    const { events, translate } = collect();
    translate({
      type: "result",
      subtype: "success",
      result: "Done.",
      total_cost_usd: 0,
      usage: { input_tokens: 100, output_tokens: 50 },
      num_turns: 1,
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("turn_end");
    expect(kinds).toContain("status");
    const turnEnd = events.find((e) => e.type === "turn_end")!;
    // No prior assistant message → `usage` falls back to result.usage
    // (rare edge case, but preserves backward-compat for synthetic tests
    // that drive `result` directly). `billingUsage` always carries the
    // cumulative `result.usage` shape.
    expect(turnEnd).toMatchObject({
      type: "turn_end",
      stopReason: "success",
      usage: { inputTokens: 100, outputTokens: 50 },
      billingUsage: { inputTokens: 100, outputTokens: 50 },
    });
  });

  it("turn_end usage = last assistant per-call; billingUsage = cumulative result.usage", () => {
    // Multi-tool-use turn: SDK delivers two `assistant` messages (one per
    // API sub-call) before the `result`. The ring needs the LAST sub-call's
    // per-call usage (`message.usage` on the final assistant), not the
    // cumulative `result.usage` — that one sums every sub-call's
    // cache-read and pushes the ring above 100% on long turns.
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "asst-1",
      message: {
        content: [{ type: "text", text: "first call" }],
        usage: {
          input_tokens: 5,
          output_tokens: 20,
          cache_read_input_tokens: 100_000,
          cache_creation_input_tokens: 0,
        },
      },
    });
    translate({
      type: "assistant",
      uuid: "asst-2",
      message: {
        content: [{ type: "text", text: "final" }],
        usage: {
          input_tokens: 10,
          output_tokens: 30,
          cache_read_input_tokens: 150_000,
          cache_creation_input_tokens: 0,
        },
      },
    });
    translate({
      type: "result",
      subtype: "success",
      result: "Done.",
      total_cost_usd: 0,
      // Cumulative across both sub-calls. Note cache_read = 100k + 150k.
      usage: {
        input_tokens: 15,
        output_tokens: 50,
        cache_read_input_tokens: 250_000,
        cache_creation_input_tokens: 0,
      },
      num_turns: 1,
    });
    const turnEnd = events.find((e) => e.type === "turn_end")! as Extract<
      RunnerEvent,
      { type: "turn_end" }
    >;
    // Per-call: from the LAST assistant — 150k cache read, not 250k.
    expect(turnEnd.usage).toEqual({
      inputTokens: 10,
      outputTokens: 30,
      cacheReadInputTokens: 150_000,
      cacheCreationInputTokens: 0,
    });
    // Cumulative: from result.usage — 250k cache read.
    expect(turnEnd.billingUsage).toEqual({
      inputTokens: 15,
      outputTokens: 50,
      cacheReadInputTokens: 250_000,
      cacheCreationInputTokens: 0,
    });
  });

  it("subagent assistant messages do not drive parent turn_end usage", () => {
    // Only top-level assistants (no parent_tool_use_id) carry the parent
    // session's context body. A subagent's per-call usage describes the
    // subagent's prompt, not the parent's — wiring it into lastAssistantUsage
    // would make the ring jump to the subagent's context size.
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "parent-1",
      message: {
        content: [{ type: "text", text: "parent" }],
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 0,
        },
      },
    });
    translate({
      type: "assistant",
      uuid: "subagent-1",
      parent_tool_use_id: "tu-sub",
      message: {
        content: [{ type: "text", text: "subagent" }],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 999_999,
          cache_creation_input_tokens: 0,
        },
      },
    });
    translate({
      type: "result",
      subtype: "success",
      result: "Done.",
      total_cost_usd: 0,
      usage: {
        input_tokens: 6,
        output_tokens: 12,
        cache_read_input_tokens: 1_049_999,
        cache_creation_input_tokens: 0,
      },
      num_turns: 1,
    });
    const turnEnd = events.find((e) => e.type === "turn_end")! as Extract<
      RunnerEvent,
      { type: "turn_end" }
    >;
    // Per-call snapshot stays on the parent's 50k, NOT the subagent's 999_999.
    expect(turnEnd.usage?.cacheReadInputTokens).toBe(50_000);
  });

  it("maps error result subtype", () => {
    const { events, translate } = collect();
    translate({
      type: "result",
      subtype: "error_during_execution",
      errors: ["boom"],
      total_cost_usd: 0,
      num_turns: 1,
    });
    const turnEnd = events.find((e) => e.type === "turn_end")!;
    expect((turnEnd as any).stopReason).toBe("error_during_execution");
  });

  it("emits subagent_start / progress / update / end for system/task_* subtypes", () => {
    const { events, translate } = collect();
    translate({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "tu-parent-1",
      description: "Trace hydration warning",
      task_type: "local_agent",
      prompt: "Inspect lib/date.ts for hydration source",
      uuid: "u1",
      session_id: "sdk-a",
    });
    translate({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      description: "Analyzing formatDate",
      last_tool_name: "Grep",
      summary: "Close to identifying the offender",
      usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 8200 },
      uuid: "u2",
      session_id: "sdk-a",
    });
    translate({
      type: "system",
      subtype: "task_updated",
      task_id: "t1",
      patch: { status: "running", is_backgrounded: true },
      uuid: "u3",
      session_id: "sdk-a",
    });
    translate({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "tu-parent-1",
      status: "completed",
      output_file: "/tmp/explorer.jsonl",
      summary: "Found 3 call sites in app/(marketing)",
      usage: { total_tokens: 9000, tool_uses: 12, duration_ms: 42000 },
      uuid: "u4",
      session_id: "sdk-a",
    });

    const start = events.find((e) => e.type === "subagent_start")!;
    expect(start).toMatchObject({
      type: "subagent_start",
      taskId: "t1",
      parentToolUseId: "tu-parent-1",
      description: "Trace hydration warning",
      taskType: "local_agent",
      prompt: "Inspect lib/date.ts for hydration source",
    });

    const progress = events.find((e) => e.type === "subagent_progress")!;
    expect(progress).toMatchObject({
      type: "subagent_progress",
      taskId: "t1",
      description: "Analyzing formatDate",
      lastToolName: "Grep",
      summary: "Close to identifying the offender",
      usage: { totalTokens: 1234, toolUses: 3, durationMs: 8200 },
    });

    const update = events.find((e) => e.type === "subagent_update")!;
    expect(update).toMatchObject({
      type: "subagent_update",
      taskId: "t1",
      patch: { status: "running", isBackgrounded: true },
    });

    const end = events.find((e) => e.type === "subagent_end")!;
    expect(end).toMatchObject({
      type: "subagent_end",
      taskId: "t1",
      status: "completed",
      outputFile: "/tmp/explorer.jsonl",
      summary: "Found 3 call sites in app/(marketing)",
      toolUseId: "tu-parent-1",
      usage: { totalTokens: 9000, toolUses: 12, durationMs: 42000 },
    });
  });

  it("remaps task_updated.patch.status='killed' to 'stopped'", () => {
    const { events, translate } = collect();
    translate({
      type: "system",
      subtype: "task_updated",
      task_id: "t2",
      patch: { status: "killed" },
      uuid: "u",
      session_id: "sdk-a",
    });
    const update = events.find((e) => e.type === "subagent_update")!;
    expect((update as any).patch.status).toBe("stopped");
  });

  it("emits subagent_tool_progress for tool_progress with parent_tool_use_id", () => {
    const { events, translate } = collect();
    translate({
      type: "tool_progress",
      tool_use_id: "tu-inner",
      tool_name: "Grep",
      parent_tool_use_id: "tu-parent-1",
      elapsed_time_seconds: 4.2,
      task_id: "t1",
      uuid: "u",
      session_id: "sdk-a",
    });
    const tp = events.find((e) => e.type === "subagent_tool_progress")!;
    expect(tp).toMatchObject({
      type: "subagent_tool_progress",
      toolUseId: "tu-inner",
      toolName: "Grep",
      parentToolUseId: "tu-parent-1",
      elapsedSeconds: 4.2,
      taskId: "t1",
    });
  });

  it("threads parent_tool_use_id through assistant/user/tool blocks", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-child",
      parent_tool_use_id: "tu-parent-1",
      message: {
        content: [
          { type: "text", text: "Looking for Intl.DateTimeFormat usage" },
          { type: "thinking", thinking: "This is a render boundary bug" },
          {
            type: "tool_use",
            id: "tu-inner-grep",
            name: "Grep",
            input: { pattern: "Intl.DateTimeFormat" },
          },
        ],
      },
    });
    translate({
      type: "user",
      parent_tool_use_id: "tu-parent-1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-inner-grep",
            content: "7 hits",
            is_error: false,
          },
        ],
      },
    });
    const text = events.find((e) => e.type === "assistant_text")!;
    const think = events.find((e) => e.type === "thinking")!;
    const use = events.find((e) => e.type === "tool_use")!;
    const result = events.find((e) => e.type === "tool_result")!;
    expect((text as any).parentToolUseId).toBe("tu-parent-1");
    expect((think as any).parentToolUseId).toBe("tu-parent-1");
    expect((use as any).parentToolUseId).toBe("tu-parent-1");
    expect((result as any).parentToolUseId).toBe("tu-parent-1");
  });

  it("leaves parentToolUseId undefined on main-thread messages", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-main",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "main thread reply" }] },
    });
    const text = events.find((e) => e.type === "assistant_text")!;
    expect((text as any).parentToolUseId).toBeUndefined();
  });

  it("ignores unrelated system subtypes and truly unknown message types silently", () => {
    const { events, translate } = collect();
    translate({ type: "system", subtype: "totally_unknown_subtype" });
    translate({ type: "made_up_type" });
    expect(events).toEqual([]);
  });

  it("emits compact_status for system/status compacting + end transitions", () => {
    const { events, translate } = collect();
    translate({
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "u1",
      session_id: "sdk-a",
    });
    translate({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      uuid: "u2",
      session_id: "sdk-a",
    });
    const compactEvents = events.filter((e) => e.type === "compact_status");
    expect(compactEvents).toHaveLength(2);
    expect(compactEvents[0]).toMatchObject({ type: "compact_status", phase: "start" });
    expect(compactEvents[1]).toMatchObject({
      type: "compact_status",
      phase: "end",
      result: "success",
    });
  });

  it("emits compact_status with error message on failed compaction", () => {
    const { events, translate } = collect();
    translate({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "context too large to summarize",
      uuid: "u",
      session_id: "sdk-a",
    });
    const ce = events.find((e) => e.type === "compact_status")!;
    expect(ce).toMatchObject({
      type: "compact_status",
      phase: "end",
      result: "failed",
      error: "context too large to summarize",
    });
  });

  it("ignores system/status transitions that aren't about compaction", () => {
    const { events, translate } = collect();
    translate({
      type: "system",
      subtype: "status",
      status: "requesting",
      uuid: "u",
      session_id: "sdk-a",
    });
    expect(events.filter((e) => e.type === "compact_status")).toEqual([]);
  });

  it("emits compact_boundary from system/compact_boundary with metadata", () => {
    const { events, translate } = collect();
    translate({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "manual",
        pre_tokens: 178000,
        post_tokens: 12000,
        duration_ms: 4200,
      },
      uuid: "u",
      session_id: "sdk-a",
    });
    const cb = events.find((e) => e.type === "compact_boundary")!;
    expect(cb).toMatchObject({
      type: "compact_boundary",
      trigger: "manual",
      preTokens: 178000,
      postTokens: 12000,
      durationMs: 4200,
    });
    expect(typeof (cb as any).at).toBe("string");
  });

  it("defaults compact_boundary trigger to 'manual' when SDK omits it", () => {
    const { events, translate } = collect();
    translate({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 1000 },
      uuid: "u",
      session_id: "sdk-a",
    });
    const cb = events.find((e) => e.type === "compact_boundary")!;
    expect((cb as any).trigger).toBe("manual");
    expect((cb as any).preTokens).toBe(1000);
    expect((cb as any).postTokens).toBeUndefined();
  });

  it("clears the per-call usage snapshot on compact_boundary", () => {
    const { runner, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-pre-compact",
      message: {
        content: [{ type: "text", text: "before compaction" }],
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 150_000,
          cache_creation_input_tokens: 0,
        },
      },
    });
    expect((runner as any).lastAssistantUsage).not.toBeNull();
    translate({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 178000 },
      uuid: "u",
      session_id: "sdk-a",
    });
    expect((runner as any).lastAssistantUsage).toBeNull();
  });

  it("ignores malformed assistant blocks instead of crashing", () => {
    const { events, translate } = collect();
    translate({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          { type: "text" }, // missing text
          { type: "thinking", thinking: 123 as any }, // wrong type
          { type: "totally_unknown", data: 1 },
        ],
      },
    });
    // None of those should emit (text requires string text; thinking requires string)
    expect(events).toEqual([]);
  });
});

describe("AgentRunner.resolvePermission", () => {
  it("resolves the matching pending permission and is a no-op otherwise", async () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "default",
    });
    const resolutions: Array<{ id: string; behavior: string }> = [];
    // Manually insert a resolver
    const promise = new Promise<void>((done) => {
      (runner as any).pendingPermissions.set("tu-1", (d: any) => {
        resolutions.push({ id: "tu-1", behavior: d.behavior });
        done();
      });
    });
    runner.resolvePermission("bogus", { behavior: "allow" });
    runner.resolvePermission("tu-1", { behavior: "deny", reason: "no" });
    await promise;
    expect(resolutions).toEqual([{ id: "tu-1", behavior: "deny" }]);
    // pending should be cleared
    expect((runner as any).pendingPermissions.size).toBe(0);
  });
});

describe("AgentRunner listener lifecycle", () => {
  it("supports multiple listeners and isolates errors", () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "default",
    });
    const calls: string[] = [];
    runner.on(() => {
      throw new Error("boom");
    });
    runner.on((e) => calls.push(e.type));
    (runner as any).emit({ type: "status", status: "running" });
    expect(calls).toEqual(["status"]);
    expect(runner.listenerCount()).toBe(2);
  });

  it("unsubscribes listeners via the returned disposer", () => {
    const runner = new AgentRunner({
      sessionId: "s1",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      permissionMode: "default",
    });
    const calls: RunnerEvent[] = [];
    const off = runner.on((e) => calls.push(e));
    (runner as any).emit({ type: "status", status: "idle" });
    off();
    (runner as any).emit({ type: "status", status: "terminated" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "idle" });
    expect(runner.listenerCount()).toBe(0);
  });
});
