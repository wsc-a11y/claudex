import { ServerFrame, type ClientFrame } from "@claudex/shared";

export type WsListener = (frame: ServerFrame) => void;
export type WsStateListener = (state: WsDiagnostics) => void;
export type WsAckedListener = () => void;

export interface WsDiagnostics {
  phase: "connecting" | "open" | "acked" | "closed" | "error";
  lastError?: string;
  reconnectIn?: number; // ms until next attempt
  attempts: number;
  lastFrameAt?: number;
  lastCloseCode?: number;
  lastCloseReason?: string;
  // Flipped true once we've observed an auth-failure signal (close code
  // 4401 OR a server `error` frame with `code: "unauthenticated"`). When
  // set, the client stops reconnecting — user must re-authenticate.
  disabled?: boolean;
}

export interface WsClient {
  send(frame: ClientFrame): void;
  subscribe(listener: WsListener): () => void;
  onState(listener: WsStateListener): () => void;
  /**
   * Fires every time the socket transitions into the `acked` phase — i.e.
   * a fresh `hello_ack` has just been received. Used by the sessions store
   * to re-`subscribe` to the active session and refetch the event tail so
   * any frames dropped during a disconnect are recovered.
   *
   * Registered as a standalone channel (not derived from `onState`) so
   * callers don't have to diff state transitions themselves. Listener is
   * NOT invoked on registration.
   */
  onAcked(listener: WsAckedListener): () => void;
  close(): void;
  readonly connected: boolean;
  readonly diagnostics: WsDiagnostics;
}

/**
 * Auto-reconnecting WS client. Exposes a simple send/subscribe surface; the
 * store layer decides which frames matter.
 *
 * iOS Safari quirks handled here:
 * - After backgrounding, a socket may appear "open" but dead. We track the
 *   time since the last frame (hello_ack or server ping) and force a
 *   reconnect from a visibility-change listener.
 * - Safari sometimes skips the `close` event after an abrupt network drop,
 *   so a visibility→reconnect path is the only way to recover.
 */
export function createWsClient(url: string): WsClient {
  const listeners = new Set<WsListener>();
  const stateListeners = new Set<WsStateListener>();
  const ackedListeners = new Set<WsAckedListener>();
  let socket: WebSocket | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  const diag: WsDiagnostics = {
    phase: "connecting",
    attempts: 0,
  };
  const emitState = () => {
    for (const l of stateListeners) l({ ...diag });
  };

  // Compute reconnect delay with ±30% jitter so multiple tabs / clients don't
  // all snap back in lock step after a shared network blip and hammer the
  // server. Formula:
  //   base   = min(1000 + 500 * attempts, 5000)           // ms
  //   jitter = base * (0.7 + Math.random() * 0.6)         // 70%-130% of base
  // Keeps the upper bound inside [700ms .. 6500ms].
  const nextBackoffMs = (): number => {
    const base = Math.min(1000 + 500 * diag.attempts, 5000);
    const jitter = base * (0.7 + Math.random() * 0.6);
    return Math.round(jitter);
  };

  // Auth-lost handling. When the server rejects the handshake (either by
  // closing with code 4401 OR by sending a `{type:"error", code:"unauthenticated"}`
  // frame before closing), we set `disabled=true` and dispatch a window event
  // so the surrounding UI can navigate to /login. We DO NOT attempt to
  // reconnect in that state — the cookie is bad and looping would just spam
  // audit logs. NB: testing this deterministically needs vi fake timers + a
  // mock socket; skipped intentionally, see the call-site for next dev.
  const markAuthLost = (reason: string) => {
    if (diag.disabled) return;
    diag.disabled = true;
    diag.phase = "closed";
    diag.lastError = reason;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    diag.reconnectIn = undefined;
    emitState();
    try {
      window.dispatchEvent(
        new CustomEvent("claudex:auth-lost", { detail: { reason } }),
      );
    } catch {
      /* SSR / no-window: ignore */
    }
  };

  const scheduleReconnect = (backoffMs: number) => {
    if (disposed || diag.disabled) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    diag.reconnectIn = backoffMs;
    emitState();
    reconnectTimer = setTimeout(() => {
      diag.reconnectIn = undefined;
      connect();
    }, backoffMs);
  };

  const connect = () => {
    if (disposed || diag.disabled) return;
    diag.attempts += 1;
    diag.phase = "connecting";
    emitState();
    try {
      socket = new WebSocket(url);
    } catch (err) {
      diag.phase = "error";
      diag.lastError = err instanceof Error ? err.message : String(err);
      emitState();
      scheduleReconnect(nextBackoffMs());
      return;
    }

    socket.addEventListener("open", () => {
      connected = true;
      diag.phase = "open";
      diag.attempts = 0;
      diag.lastError = undefined;
      emitState();
      try {
        socket?.send(
          JSON.stringify({ type: "hello", resume: {} } satisfies ClientFrame),
        );
      } catch {
        /* ignore */
      }
    });
    socket.addEventListener("message", (ev) => {
      diag.lastFrameAt = Date.now();
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      // Validate against the discriminated union so downstream handlers get
      // a precisely-typed frame and malformed server output can't crash the
      // store reducer. Drop on failure — there's nothing useful the client
      // can do with a frame it can't identify.
      const parsed = ServerFrame.safeParse(raw);
      if (!parsed.success) {
        console.warn("[ws] malformed server frame", parsed.error);
        return;
      }
      const frame = parsed.data;
      // Auth-failure error frame. The server sends this immediately before
      // calling socket.close() when the handshake is rejected; we may or may
      // not also see close code 4401 depending on the server config.
      if (frame.type === "error" && frame.code === "unauthenticated") {
        markAuthLost("unauthenticated");
        return;
      }
      if (frame.type === "hello_ack" && diag.phase !== "acked") {
        diag.phase = "acked";
        emitState();
        // Fire acked listeners AFTER state emission so subscribers that
        // key off diag can observe the new phase before acting. Wrapped
        // in try/catch so a misbehaving listener can't stop the chain.
        for (const l of ackedListeners) {
          try {
            l();
          } catch {
            /* ignore */
          }
        }
      }
      for (const l of listeners) l(frame);
    });
    socket.addEventListener("close", (ev: CloseEvent) => {
      connected = false;
      diag.phase = "closed";
      diag.lastCloseCode = ev.code;
      diag.lastCloseReason = ev.reason || undefined;
      emitState();
      if (disposed) return;
      // Dedicated auth-lost close code. Kept distinct from the error-frame
      // path above because a future server version could close without
      // sending the frame first, or vice versa.
      if (ev.code === 4401) {
        markAuthLost(`close-4401${ev.reason ? `: ${ev.reason}` : ""}`);
        return;
      }
      if (diag.disabled) return;
      scheduleReconnect(nextBackoffMs());
    });
    socket.addEventListener("error", () => {
      diag.phase = "error";
      diag.lastError = "socket error";
      emitState();
      // Let `close` drive the reconnect. Don't close() here — some iOS
      // versions fire `error` before `open` completes and we'd double-reconnect.
    });
  };

  // iOS Safari — when the page comes back from background, a socket can be
  // silently dead. Nudge it.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (disposed || diag.disabled) return;
      if (document.visibilityState !== "visible") return;
      // If the socket isn't OPEN when we come back to the foreground, reconnect.
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        connect();
        return;
      }
      // If it *claims* to be open but we haven't heard from the server in a
      // while, force a reconnect so we don't sit on a half-dead socket.
      const idle = Date.now() - (diag.lastFrameAt ?? 0);
      if (idle > 60_000) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    });
  }

  connect();

  return {
    get connected() {
      return connected;
    },
    get diagnostics() {
      return { ...diag };
    },
    send(frame) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      // Emit once so subscribers get current state without waiting for a change.
      queueMicrotask(() => listener({ ...diag }));
      return () => stateListeners.delete(listener);
    },
    onAcked(listener) {
      ackedListeners.add(listener);
      return () => ackedListeners.delete(listener);
    },
    close() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      listeners.clear();
      stateListeners.clear();
      ackedListeners.clear();
    },
  };
}
