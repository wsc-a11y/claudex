import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.js";
import { SessionStore } from "../src/sessions/store.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { importCliSessionEvents } from "../src/sessions/cli-events-import.js";
import { tempConfig } from "./helpers.js";

/**
 * Tests for the JSONL → session_events importer. We hand-write tiny fixture
 * files that exercise each record shape we care about; no real CLI history
 * is ever touched.
 */

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
    title: "test",
    projectId: project.id,
    model: "claude-opus-4-8",
    mode: "default",
  });
  const disposers: Array<() => void> = [];
  return {
    sessions,
    session,
    mkFile(lines: unknown[]): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-events-"));
      disposers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const filePath = path.join(dir, "transcript.jsonl");
      // Intentionally preserve the raw lines for malformed-line tests —
      // callers pass a mix of strings (already-serialized / malformed) and
      // objects (we JSON.stringify them).
      const serialized = lines
        .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
        .join("\n");
      fs.writeFileSync(filePath, serialized + "\n");
      return filePath;
    },
    cleanup: () => {
      while (disposers.length) disposers.pop()!();
      close();
      cleanup();
    },
  };
}

describe("importCliSessionEvents", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("maps a user + assistant(text+tool_use+usage) + tool_result turn", async () => {
    const { sessions, session, mkFile, cleanup } = setup();
    cleanups.push(cleanup);

    const filePath = mkFile([
      // Ignored — queue bookkeeping.
      { type: "queue-operation", operation: "enqueue", content: "hello" },
      // 1. real user turn
      {
        type: "user",
        message: { role: "user", content: "hello" },
        sessionId: "sdk-uuid",
      },
      // Ignored — attachment.
      { type: "attachment", attachment: { type: "skill_listing" } },
      // 2,3,4. assistant: text + tool_use + usage → assistant_text + tool_use + turn_end
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 5,
          },
        },
      },
      // 5. synthetic user turn carrying a tool_result
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "file1\nfile2",
              is_error: false,
            },
          ],
        },
      },
    ]);

    const n = await importCliSessionEvents(
      { sessionEvents: sessions },
      { sessionId: session.id, filePath },
    );

    // user_message, assistant_text, tool_use, turn_end, tool_result = 5
    expect(n).toBe(5);

    const events = sessions.listEvents(session.id);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message",
      "assistant_text",
      "tool_use",
      "turn_end",
      "tool_result",
    ]);

    expect(events[0].payload).toMatchObject({ text: "hello" });
    expect(events[1].payload).toMatchObject({
      messageId: "msg_1",
      text: "let me check",
      done: true,
    });
    expect(events[2].payload).toMatchObject({
      toolUseId: "tu_1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(events[3].payload).toMatchObject({
      stopReason: "tool_use",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 5,
      },
    });
    expect(events[4].payload).toMatchObject({
      toolUseId: "tu_1",
      content: "file1\nfile2",
      isError: false,
    });
  });

  it("skips malformed JSON lines and keeps going", async () => {
    const { sessions, session, mkFile, cleanup } = setup();
    cleanups.push(cleanup);

    const filePath = mkFile([
      { type: "user", message: { role: "user", content: "first" } },
      "{not valid json", // malformed in the middle
      { type: "user", message: { role: "user", content: "second" } },
    ]);

    const n = await importCliSessionEvents(
      { sessionEvents: sessions },
      { sessionId: session.id, filePath },
    );
    expect(n).toBe(2);
    const events = sessions.listEvents(session.id);
    expect(events.map((e) => (e.payload as { text: string }).text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("returns 0 for an empty file and doesn't throw", async () => {
    const { sessions, session, mkFile, cleanup } = setup();
    cleanups.push(cleanup);

    const filePath = mkFile([]);
    const n = await importCliSessionEvents(
      { sessionEvents: sessions },
      { sessionId: session.id, filePath },
    );
    expect(n).toBe(0);
    expect(sessions.listEvents(session.id)).toEqual([]);
  });

  it("treats array-of-text user content as a user_message (not tool_result)", async () => {
    const { sessions, session, mkFile, cleanup } = setup();
    cleanups.push(cleanup);

    const filePath = mkFile([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hi there" }],
        },
      },
    ]);
    const n = await importCliSessionEvents(
      { sessionEvents: sessions },
      { sessionId: session.id, filePath },
    );
    expect(n).toBe(1);
    const events = sessions.listEvents(session.id);
    expect(events[0].kind).toBe("user_message");
    expect(events[0].payload).toMatchObject({ text: "hi there" });
  });

  it("skips empty thinking blocks (CLI emits them as placeholders)", async () => {
    const { sessions, session, mkFile, cleanup } = setup();
    cleanups.push(cleanup);

    const filePath = mkFile([
      {
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "answer" },
          ],
        },
      },
    ]);
    const n = await importCliSessionEvents(
      { sessionEvents: sessions },
      { sessionId: session.id, filePath },
    );
    expect(n).toBe(1);
    const events = sessions.listEvents(session.id);
    expect(events.map((e) => e.kind)).toEqual(["assistant_text"]);
  });

  it("skips isSidechain records entirely (subagent / Task tool chatter)", async () => {
    // Sidechain records carry a child agent's own context — folding them
    // into the parent session's turn_end stream corrupted `lastTurnInput`
    // (context ring was occasionally sitting at 100% because the last
    // turn_end came from a subagent).
    const { sessions, session, mkFile, cleanup } = setup();
    cleanups.push(cleanup);

    const filePath = mkFile([
      {
        type: "user",
        message: { role: "user", content: "do the thing" },
      },
      // Child-agent assistant text — must not produce events.
      {
        type: "assistant",
        isSidechain: true,
        message: {
          id: "child_msg",
          role: "assistant",
          content: [{ type: "text", text: "child says hi" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 900_000,
            cache_creation_input_tokens: 0,
          },
        },
      },
      // Child-agent tool_result user turn — must not produce a tool_result event.
      {
        type: "user",
        isSidechain: true,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "child_tu",
              content: "ignored",
              is_error: false,
            },
          ],
        },
      },
      // Main-thread assistant still passes through.
      {
        type: "assistant",
        message: {
          id: "main_msg",
          role: "assistant",
          content: [{ type: "text", text: "main says hi" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 5,
            output_tokens: 10,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    const n = await importCliSessionEvents(
      { sessionEvents: sessions },
      { sessionId: session.id, filePath },
    );
    // user_message (main) + assistant_text (main) + turn_end (main) = 3.
    // The sidechain rows produce nothing.
    expect(n).toBe(3);

    const events = sessions.listEvents(session.id);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message",
      "assistant_text",
      "turn_end",
    ]);
    // `lastTurn` should be the main turn's usage — NOT the 900K child read.
    expect(events[2].payload).toMatchObject({
      stopReason: "end_turn",
      usage: { cacheReadInputTokens: 1000 },
    });
  });

  it("records turn_end stopReason as 'unknown' when the CLI record has no stop_reason", async () => {
    // Previously this fell back to "end_turn", which made scanTurnEnds
    // accumulate the chunk into totalInput even though the real stop_reason
    // was missing. Now we preserve "unknown" so the shared scanner skips it.
    const { sessions, session, mkFile, cleanup } = setup();
    cleanups.push(cleanup);

    const filePath = mkFile([
      {
        type: "assistant",
        message: {
          id: "msg_x",
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          // no stop_reason field
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    await importCliSessionEvents(
      { sessionEvents: sessions },
      { sessionId: session.id, filePath },
    );
    const events = sessions.listEvents(session.id);
    const turnEnd = events.find((e) => e.kind === "turn_end");
    expect(turnEnd?.payload).toMatchObject({ stopReason: "unknown" });
  });
});

describe("importCliSession + importCliSessionEvents integration", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("seeds events on first adoption and is idempotent on re-import", async () => {
    const { config, log, cleanup } = tempConfig();
    const { db, close } = openDb(config, log);
    cleanups.push(() => {
      close();
      cleanup();
    });

    const sessions = new SessionStore(db);
    const projects = new ProjectStore(db);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-events-int-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      filePath,
      [
        { type: "user", message: { role: "user", content: "hello" } },
        {
          type: "assistant",
          message: {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "hi back" }],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );

    const { importCliSession } = await import(
      "../src/sessions/cli-import.js"
    );

    const first = await importCliSession(
      { sessions, projects },
      {
        sessionId: "uuid-seed",
        cwd: "/tmp/seed",
        title: "t",
        filePath,
      },
    );
    expect(first.wasNew).toBe(true);
    expect(first.eventsImported).toBe(3); // user_message, assistant_text, turn_end

    const eventsAfterFirst = sessions.listEvents(first.session.id);
    expect(eventsAfterFirst).toHaveLength(3);

    // Re-import: short-circuits via findBySdkSessionId, events NOT duplicated.
    const second = await importCliSession(
      { sessions, projects },
      {
        sessionId: "uuid-seed",
        cwd: "/tmp/seed",
        title: "t",
        filePath,
      },
    );
    expect(second.wasNew).toBe(false);
    expect(second.eventsImported).toBe(0);
    const eventsAfterSecond = sessions.listEvents(first.session.id);
    expect(eventsAfterSecond).toHaveLength(3);
  });
});
