import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../src/transport/app.js";
import { openDb } from "../src/db/index.js";
import {
  currentTotp,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerListener,
} from "../src/sessions/runner.js";
import type { ClientFrame, ServerFrame } from "@claudex/shared";
import { tempConfig } from "./helpers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

class MockRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  private listeners = new Set<RunnerListener>();
  sent: string[] = [];
  interrupted = 0;
  permissions: Array<{ id: string; behavior: string }> = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  async start(p?: string) {
    if (p) this.sent.push(p);
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
    // Mock only — covered by ask-user-question.test.ts.
  }
  resolvePlanAccept(_id: string, _decision: "accept" | "reject") {
    // Mock only — covered by plan-accept.test.ts.
  }
  async interrupt() {
    this.interrupted += 1;
  }
  async setPermissionMode() {}
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

function makeFactory(hub: {
  runners: MockRunner[];
}): RunnerFactory {
  return {
    create(opts) {
      const r = new MockRunner(opts.sessionId);
      hub.runners.push(r);
      return r;
    },
  };
}

interface WsHarness {
  app: FastifyInstance;
  url: string;
  cookie: string;
  sessionId: string;
  hub: { runners: MockRunner[] };
  cleanup: () => Promise<void>;
}

async function harness(): Promise<WsHarness> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const hub: { runners: MockRunner[] } = { runners: [] };
  const { app, manager } = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: false,
    runnerFactory: makeFactory(hub),
  });

  // admin user
  const users = new UserStore(dbh.db);
  const totpSecret = generateTotpSecret();
  users.create({
    username: "hao",
    passwordHash: await hashPassword("hunter22-please-work"),
    totpSecret,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "hao", password: "hunter22-please-work" },
  });
  const challengeId = login.json().challengeId as string;
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/verify-totp",
    payload: { challengeId, code: currentTotp(totpSecret) },
  });
  const sessionCookieHdr = verify.cookies.find(
    (c) => c.name === "claudex_session",
  )!;
  const cookie = `claudex_session=${sessionCookieHdr.value}`;

  // project + session
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-ws-"));
  const proj = (
    await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "demo", path: tmpDir },
    })
  ).json().project;
  // Projects created via HTTP land untrusted — flip the bit directly so the
  // subsequent POST /api/sessions doesn't trip the trust gate. Mirrors the
  // web NewSessionSheet's confirm-card step.
  dbh.db.prepare("UPDATE projects SET trusted = 1 WHERE id = ?").run(proj.id);
  const session = (
    await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie },
      payload: {
        projectId: proj.id,
        title: "t",
        model: "claude-opus-4-8",
        mode: "default",
        worktree: false,
      },
    })
  ).json().session;

  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  const url = `ws://127.0.0.1:${addr.port}/ws`;

  return {
    app,
    url,
    cookie,
    sessionId: session.id,
    hub,
    cleanup: async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await manager.disposeAll();
      await app.close();
      dbh.close();
      cleanup();
    },
  };
}

interface Ws {
  socket: WebSocket;
  frames: ServerFrame[];
  send: (frame: ClientFrame) => void;
  waitFor: (predicate: (f: ServerFrame) => boolean, timeout?: number) => Promise<ServerFrame>;
  close: () => Promise<void>;
}

function openSocket(url: string, cookie: string): Promise<Ws> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } });
    const frames: ServerFrame[] = [];
    const waiters: Array<{
      predicate: (f: ServerFrame) => boolean;
      resolve: (f: ServerFrame) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }> = [];
    socket.on("open", () =>
      resolve({
        socket,
        frames,
        send: (frame) => socket.send(JSON.stringify(frame)),
        waitFor: (predicate, timeout = 2000) =>
          new Promise((res, rej) => {
            const matched = frames.find(predicate);
            if (matched) return res(matched);
            const timer = setTimeout(() => {
              rej(new Error(`timeout waiting for frame`));
            }, timeout);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        close: () =>
          new Promise((res) => {
            socket.once("close", () => res());
            socket.close();
          }),
      }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.predicate(frame)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(frame);
        }
      }
    });
    socket.on("error", (err) => {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      reject(err);
    });
  });
}

describe("WebSocket transport", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("closes sockets without an auth cookie", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    await new Promise<void>((resolve, reject) => {
      const s = new WebSocket(ctx.url);
      const timer = setTimeout(
        () => reject(new Error("timeout")),
        2000,
      );
      s.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as ServerFrame;
        if (frame.type === "error" && frame.code === "unauthenticated") {
          clearTimeout(timer);
        }
      });
      s.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      s.on("error", (err) => {
        clearTimeout(timer);
        // Some stacks close with a 4xx and emit an error. Either is fine.
        resolve();
      });
    });
  });

  it("hello_ack on successful auth", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    const ack = await ws.waitFor((f) => f.type === "hello_ack");
    expect(ack).toMatchObject({ type: "hello_ack" });
  });

  it("pipes user_message through to the runner", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "hello claude",
    });

    // Give the server a tick to spawn the runner via the SessionManager.
    await new Promise((r) => setTimeout(r, 150));
    expect(ctx.hub.runners).toHaveLength(1);
    expect(ctx.hub.runners[0].sent).toContain("hello claude");
  });

  it("relays assistant_text and turn_end to subscribers", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "yo",
    });
    await new Promise((r) => setTimeout(r, 100));

    const runner = ctx.hub.runners[0];
    runner.emit({
      type: "assistant_text",
      messageId: "m1",
      text: "hi there",
      done: true,
    });
    runner.emit({ type: "turn_end", stopReason: "success" });

    const text = await ws.waitFor((f) => f.type === "assistant_text_delta");
    expect((text as any).text).toBe("hi there");
    const end = await ws.waitFor((f) => f.type === "turn_end");
    expect((end as any).stopReason).toBe("success");
  });

  it("unsubscribe stops delivery to that client", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const a = await openSocket(ctx.url, ctx.cookie);
    const b = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => a.close());
    disposers.push(() => b.close());

    await Promise.all([
      a.waitFor((f) => f.type === "hello_ack"),
      b.waitFor((f) => f.type === "hello_ack"),
    ]);

    a.send({ type: "subscribe", sessionId: ctx.sessionId });
    b.send({ type: "subscribe", sessionId: ctx.sessionId });
    // Kick the runner awake via a message.
    a.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "hi",
    });
    await new Promise((r) => setTimeout(r, 100));

    // b unsubscribes before the next emit
    b.send({ type: "unsubscribe", sessionId: ctx.sessionId });
    await new Promise((r) => setTimeout(r, 50));

    ctx.hub.runners[0].emit({
      type: "assistant_text",
      messageId: "m1",
      text: "pong",
      done: true,
    });

    await a.waitFor((f) => f.type === "assistant_text_delta");
    expect(b.frames.some((f) => f.type === "assistant_text_delta")).toBe(false);
  });

  it("permission_decision reaches the runner", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");
    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "please",
    });
    await new Promise((r) => setTimeout(r, 100));

    const runner = ctx.hub.runners[0];
    runner.emit({
      type: "permission_request",
      toolUseId: "tu-1",
      toolName: "Bash",
      input: { command: "ls" },
      title: "use Bash",
    });

    const prompt = await ws.waitFor((f) => f.type === "permission_request");
    expect((prompt as any).approvalId).toBe("tu-1");

    ws.send({
      type: "permission_decision",
      sessionId: ctx.sessionId,
      approvalId: "tu-1",
      decision: "allow_once",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(runner.permissions).toEqual([{ id: "tu-1", behavior: "allow" }]);
  });

  it("interrupt frame propagates to the runner", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    // Kick the manager so a runner actually gets spawned — interrupt() on a
    // manager with no attached runner is a no-op.
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "start working",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.hub.runners).toHaveLength(1);

    ws.send({ type: "interrupt", sessionId: ctx.sessionId });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.hub.runners[0].interrupted).toBeGreaterThanOrEqual(1);
  });

  it("broadcasts user_message to every subscribed tab (including the sender)", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const a = await openSocket(ctx.url, ctx.cookie);
    const b = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => a.close());
    disposers.push(() => b.close());

    await Promise.all([
      a.waitFor((f) => f.type === "hello_ack"),
      b.waitFor((f) => f.type === "hello_ack"),
    ]);

    a.send({ type: "subscribe", sessionId: ctx.sessionId });
    b.send({ type: "subscribe", sessionId: ctx.sessionId });
    await new Promise((r) => setTimeout(r, 50));

    // Tab A sends; both A and B should get the broadcast.
    a.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "hello from tab A",
    });

    const fromA = await a.waitFor((f) => f.type === "user_message");
    const fromB = await b.waitFor((f) => f.type === "user_message");
    expect((fromA as any).content).toBe("hello from tab A");
    expect((fromB as any).content).toBe("hello from tab A");
    expect((fromA as any).sessionId).toBe(ctx.sessionId);
    expect(Number.isNaN(Date.parse((fromA as any).createdAt))).toBe(false);
  });

  it("relays echoId verbatim on the user_message broadcast", async () => {
    // Clients attach a per-send nonce so the originating tab can match the
    // echoed broadcast to its local optimistic piece without relying on the
    // fragile text+3s heuristic. The server is required to round-trip the
    // value unchanged.
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    const echoId = "echo-abc-123";
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "ping with nonce",
      echoId,
    });

    const broadcast = await ws.waitFor((f) => f.type === "user_message");
    expect((broadcast as any).echoId).toBe(echoId);
    expect((broadcast as any).content).toBe("ping with nonce");
  });

  it("delivers cross-session frames (session_update, user_message) to tabs that never subscribed", async () => {
    // Home/list screens need live status dots without pinning a specific
    // sessionId. Every authed socket lands in the global sessions channel
    // on hello_ack and receives these cross-session frames.
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const listTab = await openSocket(ctx.url, ctx.cookie);
    const chatTab = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => listTab.close());
    disposers.push(() => chatTab.close());

    await Promise.all([
      listTab.waitFor((f) => f.type === "hello_ack"),
      chatTab.waitFor((f) => f.type === "hello_ack"),
    ]);

    // Only the chat tab subscribes to the session. listTab never does.
    chatTab.send({ type: "subscribe", sessionId: ctx.sessionId });
    chatTab.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "kick the runner",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.hub.runners).toHaveLength(1);

    // listTab should still see the user_message broadcast even though it
    // didn't subscribe.
    const listEcho = await listTab.waitFor((f) => f.type === "user_message");
    expect((listEcho as any).sessionId).toBe(ctx.sessionId);
    expect((listEcho as any).content).toBe("kick the runner");

    // And a runner status change should reach the unsubscribed listTab too.
    ctx.hub.runners[0].emit({ type: "status", status: "running" });
    const statusFrame = await listTab.waitFor(
      (f) => f.type === "session_update",
    );
    expect((statusFrame as any).status).toBe("running");

    // Sanity: non-cross-session frames (assistant_text_delta) must NOT leak
    // to the unsubscribed tab. Only chatTab gets them.
    ctx.hub.runners[0].emit({
      type: "assistant_text",
      messageId: "m1",
      text: "hi",
      done: true,
    });
    await chatTab.waitFor((f) => f.type === "assistant_text_delta");
    await new Promise((r) => setTimeout(r, 50));
    expect(
      listTab.frames.some((f) => f.type === "assistant_text_delta"),
    ).toBe(false);
  });

  it("rejects malformed frames with an error response, socket stays open", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");
    ws.socket.send("not-json");
    const err = await ws.waitFor((f) => f.type === "error");
    expect((err as any).code).toBe("bad_frame");

    // Socket should still work after a bad frame.
    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    await new Promise((r) => setTimeout(r, 50));
    // no crash; next call should still go through
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "still here",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.hub.runners[0].sent).toContain("still here");
  });

  it("truncates large tool_result frames on the wire but keeps the DB row intact", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "run a big tool",
    });
    await new Promise((r) => setTimeout(r, 100));

    const runner = ctx.hub.runners[0];
    // 600KB payload — well above the 512KB (512_000 char) WS limit.
    const big = "x".repeat(600_000);
    runner.emit({
      type: "tool_result",
      toolUseId: "tu-big",
      content: big,
      isError: false,
    });

    const frame = (await ws.waitFor(
      (f) => f.type === "tool_result",
    )) as Extract<ServerFrame, { type: "tool_result" }>;
    expect(frame.truncated).toBe(true);
    // Exactly the first 512_000 chars of original content, plus the suffix.
    expect(frame.content.startsWith("x".repeat(512_000))).toBe(true);
    expect(frame.content.length).toBeGreaterThan(512_000);
    expect(frame.content).toContain("truncated");
    expect(frame.content).toContain(`${600_000 - 512_000} chars dropped`);

    // DB persistence is NOT truncated. The manager persists the full payload
    // before the WS mapper sees it, so `GET /events` returns the untouched
    // 600KB content for refetch.
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${ctx.sessionId}/events`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const events = res.json().events as Array<{
      kind: string;
      payload: { content?: string; toolUseId?: string };
    }>;
    const tr = events.find(
      (e) => e.kind === "tool_result" && e.payload.toolUseId === "tu-big",
    );
    expect(tr).toBeDefined();
    expect(tr!.payload.content).toBe(big);
    expect(tr!.payload.content!.length).toBe(600_000);
  });

  it("small tool_result frames are not flagged truncated", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "small tool",
    });
    await new Promise((r) => setTimeout(r, 100));

    const runner = ctx.hub.runners[0];
    const small = "hello world";
    runner.emit({
      type: "tool_result",
      toolUseId: "tu-small",
      content: small,
      isError: false,
    });

    const frame = (await ws.waitFor(
      (f) => f.type === "tool_result",
    )) as Extract<ServerFrame, { type: "tool_result" }>;
    expect(frame.content).toBe(small);
    expect(frame.truncated).toBeUndefined();
  });

  it("skips frames for a slow socket with bufferedAmount over budget", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "start",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Find this socket on the server side and pin its bufferedAmount above
    // the 2MB budget. Every authed socket lives on the @fastify/websocket
    // registry via `app.websocketServer.clients`. We stub the getter on the
    // single active socket (there's only one from `openSocket`).
    const clients = (ctx.app as any).websocketServer?.clients as
      | Set<any>
      | undefined;
    expect(clients?.size ?? 0).toBe(1);
    const [serverSock] = [...(clients ?? [])];
    Object.defineProperty(serverSock, "bufferedAmount", {
      configurable: true,
      get: () => 3 * 1024 * 1024,
    });

    // Count frames already received; the next emit should NOT deliver an
    // assistant_text_delta because the socket looks slow.
    const beforeLen = ws.frames.length;
    const runner = ctx.hub.runners[0];
    runner.emit({
      type: "assistant_text",
      messageId: "m1",
      text: "should be skipped",
      done: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    // No new frame should have arrived for this socket.
    const delta = ws.frames
      .slice(beforeLen)
      .find((f) => f.type === "assistant_text_delta");
    expect(delta).toBeUndefined();
  });

  it("ejects a persistently-slow socket after too many skipped frames", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    // NOTE: we intentionally do not push ws.close() as a disposer — the
    // server ejects the socket during the test, so by the time the disposer
    // would run the client socket is already CLOSED and `ws.close()`'s
    // internal `once("close", res)` would never fire.
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "start",
    });
    await new Promise((r) => setTimeout(r, 100));

    const clients = (ctx.app as any).websocketServer?.clients as
      | Set<any>
      | undefined;
    const [serverSock] = [...(clients ?? [])];
    // Keep the stub lifted after eject so cleanup (app.close → terminate)
    // doesn't stall waiting for a permanently-stuck buffer to drain.
    let stubOn = true;
    Object.defineProperty(serverSock, "bufferedAmount", {
      configurable: true,
      get: () => (stubOn ? 3 * 1024 * 1024 : 0),
    });

    // Wait for the close event on the client socket.
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.socket.once("close", (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString() }),
      );
    });

    // Push 12 frames — more than SLOW_CLIENT_EJECT_THRESHOLD (10).
    const runner = ctx.hub.runners[0];
    for (let i = 0; i < 12; i++) {
      runner.emit({
        type: "assistant_text",
        messageId: `m-${i}`,
        text: `t-${i}`,
        done: true,
      });
    }

    const { code } = await Promise.race([
      closed,
      new Promise<{ code: number; reason: string }>((_, rej) =>
        setTimeout(() => rej(new Error("eject timeout")), 2000),
      ),
    ]);
    expect(code).toBe(1013);
    // Release the stub + hard-terminate the lingering server socket so
    // app.close() doesn't stall waiting for a permanently-stuffed buffer
    // to drain during the afterEach disposer unwinding.
    stubOn = false;
    try {
      serverSock.terminate?.();
    } catch {
      // already torn down
    }
  });
});
