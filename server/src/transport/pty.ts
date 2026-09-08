import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type Database from "better-sqlite3";
import * as pty from "node-pty";
import {
  ACCESS_COOKIE_NAME,
  verifyAccessToken,
  UserStore,
} from "../auth/index.js";
import { SessionStore } from "../sessions/store.js";
import { ProjectStore } from "../sessions/projects.js";

export interface PtyDeps {
  db: Database.Database;
  jwtSecret: Uint8Array;
}

// Per-session PTY tracking. One PTY per session (simple rule — a second
// connection to the same sessionId is refused). We also store the WebSocket
// so shutdown is symmetric: closing the socket kills the pty, pty exit closes
// the socket.
interface PtyEntry {
  child: pty.IPty;
  socket: WebSocket;
}

/**
 * Registers `GET /pty` WebSocket endpoint.
 *
 * Protocol (JSON frames, utf-8):
 *
 *   server → client:
 *     { type: "data",  data: string }           raw PTY output
 *     { type: "error", code, message }          handshake/runtime error
 *     { type: "exit",  exitCode, signal }       PTY exited
 *
 *   client → server:
 *     { type: "data",   data: string }          user keystrokes
 *     { type: "resize", cols, rows }            terminal resize
 *
 * Handshake query params:
 *   sessionId (required)      — must resolve to a session the user owns
 *   cols, rows (optional)     — default 80x24; clamped to [1,500] / [1,200]
 *
 * Shell is taken from `process.env.SHELL` (falling back to /bin/zsh then
 * /bin/bash). The client CANNOT pick the shell or inject env — the server
 * side sets both, deliberately.
 */
export async function registerPtyRoutes(
  app: FastifyInstance,
  deps: PtyDeps,
): Promise<void> {
  // One entry per sessionId. Second connection for the same session is refused.
  const ptyBySession = new Map<string, PtyEntry>();

  app.get("/pty", { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const sendJson = (obj: Record<string, unknown>) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* socket torn down */
      }
    };
    const closeWithError = (code: string, message: string) => {
      sendJson({ type: "error", code, message });
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };

    // --- auth ---
    const userId = await authenticateSocket(req, deps);
    if (!userId) {
      req.log?.warn({}, "pty handshake rejected: unauthenticated");
      return closeWithError("unauthenticated", "unauthenticated");
    }

    // --- parse query ---
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const sessionId = query.sessionId;
    if (!sessionId) {
      return closeWithError("bad_request", "sessionId query param required");
    }

    const cols = clampInt(query.cols, 80, 1, 500);
    const rows = clampInt(query.rows, 24, 1, 200);

    // --- resolve session + cwd ---
    const sessions = new SessionStore(deps.db);
    const projects = new ProjectStore(deps.db);
    const session = sessions.findById(sessionId);
    if (!session) {
      return closeWithError("not_found", `session ${sessionId} not found`);
    }
    if (session.status === "archived") {
      return closeWithError("archived", "session is archived");
    }
    const project = projects.findById(session.projectId);
    if (!project) {
      return closeWithError("not_found", "project missing for session");
    }
    const cwd = session.worktreePath ?? project.path;

    // --- one pty per session ---
    if (ptyBySession.has(sessionId)) {
      return closeWithError(
        "busy",
        "another terminal is already attached to this session",
      );
    }

    // --- spawn ---
    const shell = pickShell();
    const env: Record<string, string> = {
      ...sanitizeEnv(process.env),
      TERM: "xterm-256color",
      // Force line editing to think it's interactive so prompt expansion runs.
      CLAUDEX_TERMINAL: "1",
    };

    let child: pty.IPty;
    try {
      child = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log?.error({ err, sessionId, shell, cwd }, "pty spawn failed");
      return closeWithError("spawn_failed", message);
    }

    const entry: PtyEntry = { child, socket };
    ptyBySession.set(sessionId, entry);
    req.log?.info(
      { sessionId, shell, cwd, cols, rows },
      "pty attached",
    );

    // --- wire pty → ws ---
    const dataHandler = child.onData((chunk: string) => {
      sendJson({ type: "data", data: chunk });
    });
    const exitHandler = child.onExit(({ exitCode, signal }) => {
      sendJson({ type: "exit", exitCode, signal: signal ?? null });
      // Remove the entry before closing the socket so the close handler
      // doesn't try to re-kill a dead pty.
      if (ptyBySession.get(sessionId) === entry) {
        ptyBySession.delete(sessionId);
      }
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });

    // --- ws → pty ---
    socket.on("message", (raw: Buffer | string) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        // Keep the session alive on malformed frames — the terminal is not
        // the place to be draconian about a stray byte on the wire.
        return;
      }
      if (!frame || typeof frame !== "object") return;
      const f = frame as Record<string, unknown>;
      if (f.type === "data" && typeof f.data === "string") {
        try {
          child.write(f.data);
        } catch {
          /* pty may already be dead; onExit will follow */
        }
        return;
      }
      if (f.type === "resize") {
        const nextCols = clampInt(f.cols, cols, 1, 500);
        const nextRows = clampInt(f.rows, rows, 1, 200);
        try {
          child.resize(nextCols, nextRows);
        } catch {
          /* best-effort */
        }
        return;
      }
      // Anything else is ignored on purpose.
    });

    const cleanup = (reason: string) => {
      req.log?.info({ sessionId, reason }, "pty cleanup");
      // Detach listeners first so we don't re-enter via onExit during kill().
      try {
        dataHandler.dispose();
      } catch {
        /* ignore */
      }
      try {
        exitHandler.dispose();
      } catch {
        /* ignore */
      }
      if (ptyBySession.get(sessionId) === entry) {
        ptyBySession.delete(sessionId);
      }
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    };

    socket.on("close", () => cleanup("ws_close"));
    socket.on("error", () => cleanup("ws_error"));
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function authenticateSocket(
  req: FastifyRequest,
  deps: PtyDeps,
): Promise<string | null> {
  const token = req.cookies?.[ACCESS_COOKIE_NAME];
  if (!token) return null;
  try {
    const claims = await verifyAccessToken(deps.jwtSecret, token);
    const user = new UserStore(deps.db).findById(claims.userId);
    return user?.id ?? null;
  } catch {
    return null;
  }
}

function clampInt(
  raw: unknown,
  fallback: number,
  lo: number,
  hi: number,
): number {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function pickShell(): string {
  const env = process.env.SHELL;
  if (env && env.length > 0) return env;
  // Fallback order matches what most macOS / Linux users would expect.
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * Strip `undefined` values so node-pty doesn't choke. Don't attempt to filter
 * secrets — inheriting the user's shell env is the whole point (they need
 * their PATH, API keys, etc.). The auth gate in front of this endpoint is
 * the only barrier.
 */
function sanitizeEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
