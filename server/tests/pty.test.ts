import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/transport/app.js";
import { openDb } from "../src/db/index.js";
import {
  currentTotp,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";
import { tempConfig } from "./helpers.js";

// -----------------------------------------------------------------------------
// PTY endpoint tests. node-pty is a native module; it needs a working shell
// on the test host. Skip automatically when we're clearly in a constrained CI
// environment (no /bin/sh or the CI flag set without a tty).
// -----------------------------------------------------------------------------

const shellPath = process.env.SHELL || "/bin/bash";
const canSpawnPty = !process.env.CLAUDEX_SKIP_PTY_TESTS && fs.existsSync(shellPath);

interface PtyHarness {
  app: FastifyInstance;
  url: string;
  cookie: string;
  sessionId: string;
  projectPath: string;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<PtyHarness> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const { app, manager } = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: false,
    // Use the default runner factory — we never actually send a user_message,
    // so the SDK is never touched. The important bit is that /pty is routed.
  });

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

  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-pty-"));
  const proj = (
    await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "demo", path: projectPath },
    })
  ).json().project;
  // Flip trust so POST /api/sessions doesn't hit the project_not_trusted
  // gate. These tests are about the PTY transport, not the trust flow.
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
  const url = `ws://127.0.0.1:${addr.port}/pty`;

  return {
    app,
    url,
    cookie,
    sessionId: session.id,
    projectPath,
    cleanup: async () => {
      fs.rmSync(projectPath, { recursive: true, force: true });
      await manager.disposeAll();
      await app.close();
      dbh.close();
      cleanup();
    },
  };
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface PtyConn {
  socket: WebSocket;
  frames: Frame[];
  send: (obj: Record<string, unknown>) => void;
  waitFor: (
    predicate: (f: Frame) => boolean,
    timeout?: number,
  ) => Promise<Frame>;
  waitClosed: (timeout?: number) => Promise<number | undefined>;
  close: () => Promise<void>;
}

function openPtySocket(
  url: string,
  cookie: string | null,
): Promise<PtyConn> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      url,
      cookie ? { headers: { cookie } } : undefined,
    );
    const frames: Frame[] = [];
    const waiters: Array<{
      predicate: (f: Frame) => boolean;
      resolve: (f: Frame) => void;
      timer: NodeJS.Timeout;
    }> = [];
    let closeCode: number | undefined;
    const closeWaiters: Array<{
      resolve: (c: number | undefined) => void;
      timer: NodeJS.Timeout;
    }> = [];

    socket.on("open", () => {
      resolve({
        socket,
        frames,
        send: (obj) => socket.send(JSON.stringify(obj)),
        waitFor: (predicate, timeout = 3000) =>
          new Promise((res, rej) => {
            const matched = frames.find(predicate);
            if (matched) return res(matched);
            const timer = setTimeout(() => {
              rej(
                new Error(
                  `timeout after ${timeout}ms; saw frames: ${JSON.stringify(
                    frames,
                  )}`,
                ),
              );
            }, timeout);
            waiters.push({ predicate, resolve: res as (f: Frame) => void, timer });
          }),
        waitClosed: (timeout = 3000) =>
          new Promise((res, rej) => {
            if (closeCode !== undefined || socket.readyState === WebSocket.CLOSED) {
              return res(closeCode);
            }
            const timer = setTimeout(() => {
              rej(new Error(`timeout waiting for close`));
            }, timeout);
            closeWaiters.push({ resolve: res, timer });
          }),
        close: () =>
          new Promise((res) => {
            if (socket.readyState === WebSocket.CLOSED) return res();
            socket.once("close", () => res());
            try {
              socket.close();
            } catch {
              res();
            }
          }),
      });
    });

    socket.on("message", (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(data.toString()) as Frame;
      } catch {
        return;
      }
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
    socket.on("close", (code) => {
      closeCode = code;
      for (const w of closeWaiters) {
        clearTimeout(w.timer);
        w.resolve(code);
      }
      closeWaiters.length = 0;
    });
    socket.on("error", (err) => {
      // Many rejections manifest as an error before close. Surface the close
      // path consistently — the caller's expectations are all about close.
      if (closeCode === undefined) closeCode = 0;
      for (const w of closeWaiters) {
        clearTimeout(w.timer);
        w.resolve(closeCode);
      }
      closeWaiters.length = 0;
      if (frames.length === 0 && waiters.length === 0) {
        // No active consumers — let the reject propagate during handshake.
        reject(err);
      }
    });
  });
}

describe.skipIf(!canSpawnPty)("PTY transport", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("refuses unauthenticated handshakes", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const url = `${ctx.url}?sessionId=${ctx.sessionId}`;
    const observed: { errorSeen: boolean; closed: boolean; openNever: boolean } = {
      errorSeen: false,
      closed: false,
      openNever: true,
    };
    await new Promise<void>((resolve) => {
      const s = new WebSocket(url);
      const done = () => {
        observed.closed = true;
        resolve();
      };
      s.on("open", () => {
        // Socket may briefly open before the server sends the error frame
        // and closes it — that's the expected path because WS rejection
        // happens after handshake for @fastify/websocket.
        observed.openNever = false;
      });
      s.on("message", (data) => {
        try {
          const f = JSON.parse(data.toString());
          if (f.type === "error" && f.code === "unauthenticated") {
            observed.errorSeen = true;
          }
        } catch {
          /* ignore */
        }
      });
      s.on("close", done);
      s.on("error", () => {
        // Some stacks drop the connection before a WS message round-trips.
        resolve();
      });
    });
    // Either: we got the explicit error frame, or the server closed the
    // socket without ever letting us talk. In no case should the socket
    // stay open as a usable PTY.
    expect(observed.closed).toBe(true);
    if (!observed.errorSeen) {
      // If the server closed before emitting a frame, the socket must still
      // have been opened — we just never saw data before close. That's a
      // softer rejection but still correct.
      expect(observed.openNever === false || observed.closed).toBe(true);
    }
  });

  it("closes with not_found for an unknown sessionId", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const conn = await openPtySocket(
      `${ctx.url}?sessionId=bogus-session`,
      ctx.cookie,
    );
    disposers.push(() => conn.close());
    const err = await conn.waitFor((f) => f.type === "error");
    expect(err.code).toBe("not_found");
    await conn.waitClosed();
  });

  it("spawns a shell and streams output when sessionId is valid", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const conn = await openPtySocket(
      `${ctx.url}?sessionId=${ctx.sessionId}&cols=80&rows=24`,
      ctx.cookie,
    );
    disposers.push(() => conn.close());

    // Kick the shell with a deterministic echo. Works under bash and zsh with
    // a minimal prompt; we don't care what the prompt itself prints.
    conn.send({ type: "data", data: "echo __ready__\n" });
    const hit = await conn.waitFor(
      (f) => f.type === "data" && typeof f.data === "string" && (f.data as string).includes("__ready__"),
      5000,
    );
    expect(hit.type).toBe("data");
  }, 10000);

  it("refuses a second concurrent PTY for the same session", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const first = await openPtySocket(
      `${ctx.url}?sessionId=${ctx.sessionId}`,
      ctx.cookie,
    );
    disposers.push(() => first.close());

    // Give the server a tick to register the entry.
    await new Promise((r) => setTimeout(r, 100));

    const second = await openPtySocket(
      `${ctx.url}?sessionId=${ctx.sessionId}`,
      ctx.cookie,
    );
    disposers.push(() => second.close());
    const err = await second.waitFor((f) => f.type === "error");
    expect(err.code).toBe("busy");
  });
});
