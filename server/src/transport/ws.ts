import type { FastifyInstance, FastifyRequest } from "fastify";
import websocket, { type WebSocket } from "@fastify/websocket";
import { ClientFrame, type ServerFrame } from "@claudex/shared";
import {
  ACCESS_COOKIE_NAME,
  verifyAccessToken,
  UserStore,
} from "../auth/index.js";
import type { SessionManager } from "../sessions/manager.js";
import type { RunnerEvent } from "../sessions/runner.js";
import type Database from "better-sqlite3";

export interface WsDeps {
  manager: SessionManager;
  db: Database.Database;
  jwtSecret: Uint8Array;
}

// ---- Outbound-path hardening knobs -------------------------------------------
// Hard ceiling on tool_result `content` going over the wire. Large frames
// (multi-MB grep output, file reads, image b64) are the #1 way a misbehaving
// tool can OOM the Node process: every subscriber holds its own copy in
// `ws.bufferedAmount` until the kernel drains it. We clip at 512KB chars
// here — the full event still lands in `session_events`, so the client can
// refetch via `/api/sessions/:id/events` to see the rest.
export const TOOL_RESULT_WS_LIMIT = 512_000;
// Per-connection backpressure budget. Above this, we skip frames for that
// socket instead of queueing them in Node's internal ws send buffer.
const BUFFERED_AMOUNT_LIMIT = 2 * 1024 * 1024;
// Consecutive-skip threshold before we give up and eject the client. A
// healthy phone/browser drains the buffer between every frame; ten frames
// in a row blocked on a full buffer means the client is either gone or
// fatally slow, and keeping the connection around just pins memory.
const SLOW_CLIENT_EJECT_THRESHOLD = 10;

/**
 * Registers /ws. One WebSocket per authenticated browser tab, multiplexed
 * across any number of sessions the client subscribes to.
 */
export async function registerWsRoute(
  app: FastifyInstance,
  deps: WsDeps,
): Promise<void> {
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  // Per-connection subscription state.
  interface ConnState {
    userId: string;
    subs: Set<string>;
    send: (frame: ServerFrame) => void;
    // Consecutive frames we've skipped because `socket.bufferedAmount` was
    // over `BUFFERED_AMOUNT_LIMIT`. Reset on any successful send; when it
    // crosses `SLOW_CLIENT_EJECT_THRESHOLD` we close with 1013 Try Again
    // Later and let the client reconnect from scratch.
    slowCount: number;
    ua: string;
    remote: string;
    closed: boolean;
  }
  // Map of sessionId → set of connections, so per-session broadcasts are
  // O(subscribers).
  const subscribers = new Map<string, Set<ConnState>>();
  // Every authenticated connection also lands in this "global" set. Used to
  // deliver cross-session frames (`session_update`, `user_message`) to tabs
  // that haven't explicitly subscribed to a specific sessionId — notably the
  // Home/sessions-list screen, which needs live status dots without pinning
  // one conversation. Turn payloads (assistant_text_delta, thinking,
  // tool_use, tool_result, permission_request, turn_end) still go only to
  // per-session subscribers so that idle tabs don't get firehosed.
  const globalSessionSubs = new Set<ConnState>();

  // Frame types that describe *cross-session* state (identity of a session
  // as it appears in a list view). Everything else is turn-scoped and stays
  // gated on an explicit `subscribe`.
  const GLOBAL_FRAME_TYPES = new Set<ServerFrame["type"]>([
    "session_update",
    "user_message",
    "refresh_transcript",
    "queue_update",
    "alerts_update",
  ]);

  // Wire the runner-event broadcast into the ws layer. This is a one-time
  // bridge: the SessionManager broadcasts already carries event.type. We
  // translate each event to a ServerFrame.
  const bridgeBroadcast = (sessionId: string, event: RunnerEvent): void => {
    const frame = runnerEventToFrame(sessionId, event);
    if (!frame) return;
    const bucket = subscribers.get(sessionId);
    const sent = new Set<ConnState>();
    if (bucket) {
      for (const conn of bucket) {
        conn.send(frame);
        sent.add(conn);
      }
    }
    if (GLOBAL_FRAME_TYPES.has(frame.type)) {
      for (const conn of globalSessionSubs) {
        if (sent.has(conn)) continue;
        conn.send(frame);
      }
    }
  };

  // Patch the broadcast target. SessionManager was created before WS was
  // registered (ordering in buildApp), so we expose a setter.
  attachBroadcaster(deps.manager, bridgeBroadcast);

  app.get(
    "/ws",
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const ua = String(req.headers["user-agent"] ?? "").slice(0, 80);
      const xfp = String(req.headers["x-forwarded-proto"] ?? "");
      const host = String(req.headers.host ?? "");
      const hasCookie = !!req.cookies?.[ACCESS_COOKIE_NAME];
      req.log?.info(
        { ua, xfp, host, hasCookie },
        "ws handshake begin",
      );

      const userId = await authenticateSocket(req, deps);
      if (!userId) {
        req.log?.warn({ host, hasCookie }, "ws handshake rejected: unauthenticated");
        socket.send(
          JSON.stringify({
            type: "error",
            sessionId: null,
            code: "unauthenticated",
            message: "unauthenticated",
          } satisfies ServerFrame),
        );
        socket.close();
        return;
      }

      const subs = new Set<string>();
      const remote = String(req.ip ?? "");
      const state: ConnState = {
        userId,
        subs,
        slowCount: 0,
        ua,
        remote,
        closed: false,
        send: (frame) => {
          if (state.closed) return;
          // Backpressure: a slow mobile client (weak cell signal, background
          // tab) can't drain faster than we produce. Check Node's internal
          // ws send buffer before enqueueing; if it's already over the per-
          // connection budget, drop the frame for *this* socket (others on
          // the same broadcast still get it) and count the skip. When we
          // cross SLOW_CLIENT_EJECT_THRESHOLD consecutive skips the socket
          // is effectively dead — close with 1013 so we stop pinning memory
          // on its behalf and let it reconnect from scratch.
          const buffered =
            typeof (socket as { bufferedAmount?: number }).bufferedAmount ===
            "number"
              ? (socket as { bufferedAmount: number }).bufferedAmount
              : 0;
          if (buffered > BUFFERED_AMOUNT_LIMIT) {
            state.slowCount += 1;
            if (state.slowCount > SLOW_CLIENT_EJECT_THRESHOLD) {
              state.closed = true;
              req.log?.warn(
                {
                  ua: state.ua,
                  remote: state.remote,
                  buffered,
                  slowCount: state.slowCount,
                },
                "ws ejecting slow client (bufferedAmount over budget)",
              );
              try {
                socket.close(1013, "try again later");
              } catch {
                // already closing / torn down
              }
            }
            return;
          }
          try {
            socket.send(JSON.stringify(frame));
            state.slowCount = 0;
          } catch {
            // socket torn down; ignore
          }
        },
      };

      state.send({ type: "hello_ack", serverVersion: "0.0.1" });
      // Every authed tab joins the global sessions channel so Home/list
      // screens receive `session_update` + `user_message` without needing
      // to subscribe to each sessionId individually.
      globalSessionSubs.add(state);
      req.log?.info({ userId }, "ws handshake ok, hello_ack sent");

      socket.on("message", (raw: Buffer | string) => {
        let parsed;
        try {
          const obj = JSON.parse(raw.toString());
          parsed = ClientFrame.safeParse(obj);
        } catch {
          state.send({
            type: "error",
            sessionId: null,
            code: "bad_frame",
            message: "invalid JSON",
          });
          return;
        }
        if (!parsed.success) {
          state.send({
            type: "error",
            sessionId: null,
            code: "bad_frame",
            message: parsed.error.issues[0]?.message ?? "schema violation",
          });
          return;
        }
        handleClientFrame(parsed.data, state, subscribers, deps).catch((err) => {
          state.send({
            type: "error",
            sessionId: null,
            code: "handler_error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
      });

      socket.on("close", () => {
        for (const id of subs) {
          subscribers.get(id)?.delete(state);
        }
        subs.clear();
        globalSessionSubs.delete(state);
      });
    },
  );
}

async function authenticateSocket(
  req: FastifyRequest,
  deps: WsDeps,
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

async function handleClientFrame(
  frame: ReturnType<typeof ClientFrame.parse>,
  state: {
    userId: string;
    subs: Set<string>;
    send: (f: ServerFrame) => void;
  },
  subscribers: Map<string, Set<typeof state>>,
  deps: WsDeps,
): Promise<void> {
  switch (frame.type) {
    case "hello":
      // resume-on-reconnect: could replay events from sinceSeq here; deferred.
      return;
    case "subscribe": {
      state.subs.add(frame.sessionId);
      let bucket = subscribers.get(frame.sessionId);
      if (!bucket) {
        bucket = new Set();
        subscribers.set(frame.sessionId, bucket);
      }
      bucket.add(state);
      return;
    }
    case "unsubscribe": {
      state.subs.delete(frame.sessionId);
      subscribers.get(frame.sessionId)?.delete(state);
      return;
    }
    case "user_message": {
      await deps.manager.sendUserMessage(
        frame.sessionId,
        frame.content,
        frame.attachmentIds ?? [],
        frame.echoId,
      );
      return;
    }
    case "interrupt": {
      await deps.manager.interrupt(frame.sessionId);
      return;
    }
    case "permission_decision": {
      deps.manager.resolvePermission(
        frame.sessionId,
        frame.approvalId,
        frame.decision,
      );
      return;
    }
    case "ask_user_answer": {
      deps.manager.resolveAskUserQuestion(
        frame.sessionId,
        frame.askId,
        frame.answers,
        frame.annotations,
      );
      return;
    }
    case "plan_accept_decision": {
      deps.manager.resolvePlanAccept(
        frame.sessionId,
        frame.planId,
        frame.decision,
      );
      return;
    }
  }
}

// -----------------------------------------------------------------------------
// Runner event → WS frame mapping
// -----------------------------------------------------------------------------

function runnerEventToFrame(
  sessionId: string,
  event: RunnerEvent,
): ServerFrame | null {
  switch (event.type) {
    case "status":
      return {
        type: "session_update",
        sessionId,
        status:
          event.status === "terminated"
            ? "idle"
            : event.status === "starting"
              ? "running"
              : event.status,
      };
    case "sdk_session_id":
      return null; // nothing to tell the browser
    case "assistant_text":
      return {
        type: "assistant_text_delta",
        sessionId,
        messageId: event.messageId,
        seq: 0, // not used on wire; replay handled via REST /events
        text: event.text,
        ...(event.parentToolUseId !== undefined
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "thinking":
      return {
        type: "thinking",
        sessionId,
        seq: 0,
        text: event.text,
        ...(event.parentToolUseId !== undefined
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "tool_use":
      return {
        type: "tool_use",
        sessionId,
        seq: 0,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        ...(event.parentToolUseId !== undefined
          ? { parentToolUseId: event.parentToolUseId }
          : {}),
      };
    case "tool_result": {
      // Clip tool_result `content` to a per-frame size budget so a single
      // multi-MB grep / file read / image b64 can't pin memory across every
      // subscriber's send buffer. The DB row stays intact (manager persists
      // the full payload before this mapper runs) — clients that see
      // `truncated: true` can call `GET /api/sessions/:id/events` to fetch
      // the full content. `content` is a string; we count chars, not bytes.
      const full = event.content;
      const parentFields =
        event.parentToolUseId !== undefined
          ? { parentToolUseId: event.parentToolUseId }
          : {};
      if (full.length > TOOL_RESULT_WS_LIMIT) {
        const dropped = full.length - TOOL_RESULT_WS_LIMIT;
        const clipped =
          full.slice(0, TOOL_RESULT_WS_LIMIT) +
          `\n\n… [truncated — ${dropped} chars dropped. Refetch transcript to see full content.]`;
        return {
          type: "tool_result",
          sessionId,
          seq: 0,
          toolUseId: event.toolUseId,
          content: clipped,
          isError: event.isError,
          truncated: true,
          ...parentFields,
        };
      }
      return {
        type: "tool_result",
        sessionId,
        seq: 0,
        toolUseId: event.toolUseId,
        content: full,
        isError: event.isError,
        ...parentFields,
      };
    }
    case "permission_request":
      return {
        type: "permission_request",
        sessionId,
        seq: 0,
        approvalId: event.toolUseId,
        toolName: event.toolName,
        toolInput: event.input,
        summary: event.title,
        blastRadius: null,
      };
    case "ask_user_question":
      return {
        type: "ask_user_question",
        sessionId,
        seq: 0,
        askId: event.askId,
        questions: event.questions,
      };
    case "plan_accept_request":
      return {
        type: "plan_accept_request",
        sessionId,
        seq: 0,
        planId: event.planId,
        plan: event.plan,
      };
    case "turn_end":
      return {
        type: "turn_end",
        sessionId,
        seq: 0,
        stopReason: event.stopReason,
      };
    case "user_message":
      return {
        type: "user_message",
        sessionId,
        content: event.text,
        createdAt: event.at,
        ...(event.echoId !== undefined ? { echoId: event.echoId } : {}),
        ...(event.attachments && event.attachments.length > 0
          ? { attachments: event.attachments }
          : {}),
      };
    case "refresh_transcript":
      return {
        type: "refresh_transcript",
        sessionId,
      };
    case "queue_update":
      return {
        type: "queue_update",
        at: event.at,
      };
    case "alerts_update":
      return {
        type: "alerts_update",
        at: event.at,
      };
    case "subagent_start":
      return {
        type: "subagent_start",
        sessionId,
        seq: 0,
        taskId: event.taskId,
        parentToolUseId: event.parentToolUseId,
        description: event.description,
        ...(event.agentType !== undefined ? { agentType: event.agentType } : {}),
        ...(event.taskType !== undefined ? { taskType: event.taskType } : {}),
        ...(event.workflowName !== undefined
          ? { workflowName: event.workflowName }
          : {}),
        ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
        ...(event.isBackgrounded !== undefined
          ? { isBackgrounded: event.isBackgrounded }
          : {}),
        at: event.at,
      };
    case "subagent_progress":
      return {
        type: "subagent_progress",
        sessionId,
        seq: 0,
        taskId: event.taskId,
        description: event.description,
        ...(event.lastToolName !== undefined
          ? { lastToolName: event.lastToolName }
          : {}),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        usage: event.usage,
        at: event.at,
      };
    case "subagent_update":
      return {
        type: "subagent_update",
        sessionId,
        seq: 0,
        taskId: event.taskId,
        patch: event.patch,
        at: event.at,
      };
    case "subagent_end":
      return {
        type: "subagent_end",
        sessionId,
        seq: 0,
        taskId: event.taskId,
        status: event.status,
        summary: event.summary,
        ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
        ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        at: event.at,
      };
    case "subagent_tool_progress":
      return {
        type: "subagent_tool_progress",
        sessionId,
        seq: 0,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        parentToolUseId: event.parentToolUseId,
        elapsedSeconds: event.elapsedSeconds,
        ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
        at: event.at,
      };
    case "compact_status":
      return {
        type: "compact_status",
        sessionId,
        phase: event.phase,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
    case "compact_boundary":
      return {
        type: "compact_boundary",
        sessionId,
        seq: 0,
        trigger: event.trigger,
        preTokens: event.preTokens,
        ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        at: event.at,
      };
    case "compact_summary":
      return {
        type: "compact_summary",
        sessionId,
        seq: 0,
        boundaryAt: event.boundaryAt,
        content: event.content,
      };
    case "error":
      return {
        type: "error",
        sessionId,
        code: event.code,
        message: event.message,
      };
  }
}

// Hook: SessionManager's broadcaster is set once; this is here so buildApp
// can create the manager with a no-op broadcaster and attach the real one
// after WS is registered. We do it by reflection to avoid an extra interface
// dance.
function attachBroadcaster(
  manager: SessionManager,
  broadcast: (sessionId: string, event: RunnerEvent) => void,
): void {
  (manager as any).deps.broadcast = broadcast;
}
