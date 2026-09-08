import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import webpush from "web-push";
import {
  PushSubscribeRequest,
  type PushStateResponse,
  type PushSubscribeResponse,
  type PushTestResponse,
  type VapidPublicResponse,
} from "@claudex/shared";
import { PushSubscriptionStore } from "./store.js";
import { configureWebPush, type VapidKeys } from "./vapid.js";
import type { AuditStore } from "../audit/store.js";
import { getRequestCtx } from "../lib/req.js";

// -----------------------------------------------------------------------------
// Push routes
//
// All login-gated. Surfaces:
//   GET  /api/push/vapid-public       — hands the browser the applicationServerKey
//   POST /api/push/subscriptions      — register this device
//   DEL  /api/push/subscriptions/:id  — revoke one device
//   DEL  /api/push/subscriptions      — revoke all ("disable notifications")
//   GET  /api/push/state              — enabled + device list for Settings
//   POST /api/push/test               — fire a test push to every device
//
// The send fan-out lives here too, exposed as `sendPushToAll`. SessionManager
// calls it fire-and-forget when a permission_request arrives. Any subscription
// that returns 404/410 from web-push gets pruned on the spot so the device
// list stays honest.
// -----------------------------------------------------------------------------

/**
 * Minimal logger contract. Accepts pino's native `Logger` and Fastify's
 * `FastifyBaseLogger` interchangeably — we only use `warn`.
 */
type WarnLogger = { warn: (obj: unknown, msg?: string) => void } | undefined;

export interface PushRoutesDeps {
  db: Database.Database;
  vapid: VapidKeys;
  logger?: WarnLogger;
  audit?: AuditStore;
}

export interface PushPayload {
  title: string;
  body: string;
  data: { sessionId: string; url: string };
}

export interface PushSender {
  sendToAll(payload: PushPayload): Promise<{ sent: number; pruned: number }>;
}

/**
 * Per-endpoint timeout for `webpush.sendNotification`. A single slow or
 * wedged push service should not hold the whole fan-out (we await all
 * endpoints in parallel, and SessionManager's permission-prompt trigger
 * awaits the fan-out's completion for logging). web-push exposes a
 * `timeout` option, but that's a socket-level timeout — it doesn't bound
 * overall wall-clock on a pathological (slow-loris-style) endpoint. We
 * race against our own timeout so the dispatcher is always bounded, and
 * we keep the socket-level `timeout` in sync so the HTTP request itself
 * gets torn down promptly.
 */
export const PUSH_SEND_TIMEOUT_MS = 8000;

class PushSendTimeoutError extends Error {
  constructor() {
    super("push send timed out");
    this.name = "PushSendTimeoutError";
  }
}

/**
 * Race a web-push send against a hard timeout. Resolves with the send's
 * result on success; rejects with `PushSendTimeoutError` when the timeout
 * fires before web-push resolves. The timer is always cleared so we don't
 * leak one per pending send.
 */
async function sendWithTimeout(
  sub: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  },
  body: string,
  timeoutMs: number,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PushSendTimeoutError()), timeoutMs);
    // Don't keep the event loop alive just for the timeout — if the process
    // is shutting down we shouldn't wedge on a pending push.
    timer.unref?.();
  });
  try {
    return await Promise.race([
      // Passing `timeout` tells web-push to also tear down the underlying
      // socket when it idles; our race bounds total wall-clock regardless.
      webpush.sendNotification(sub, body, { timeout: timeoutMs }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build a pusher that can be handed to other modules (e.g. SessionManager)
 * after `registerPushRoutes` has run. Pulls the store fresh from `deps.db`
 * on every call so tests that swap databases don't cache a stale reference.
 */
export function createPushSender(deps: PushRoutesDeps): PushSender {
  configureWebPush(deps.vapid);
  const store = new PushSubscriptionStore(deps.db);

  async function sendToAll(
    payload: PushPayload,
  ): Promise<{ sent: number; pruned: number }> {
    const subs = store.list();
    if (subs.length === 0) return { sent: 0, pruned: 0 };

    const body = JSON.stringify(payload);
    let sent = 0;
    let pruned = 0;

    // allSettled so one misbehaving endpoint can't short-circuit the others.
    // Per-endpoint we race against PUSH_SEND_TIMEOUT_MS — see sendWithTimeout.
    await Promise.allSettled(
      subs.map(async (s) => {
        const sub = {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        };
        try {
          await sendWithTimeout(sub, body, PUSH_SEND_TIMEOUT_MS);
          store.touchLastUsed(s.id);
          sent += 1;
        } catch (err) {
          if (err instanceof PushSendTimeoutError) {
            // Treat as transient — don't prune the subscription, the push
            // service may just be slow. The next dispatch will retry; if
            // the endpoint is permanently broken we'll eventually hit a
            // 404/410 and prune it then.
            deps.logger?.warn?.(
              { endpoint: s.endpoint, timeoutMs: PUSH_SEND_TIMEOUT_MS },
              "web-push send timed out",
            );
            return;
          }
          const statusCode = (err as { statusCode?: number }).statusCode;
          // 404 / 410 = the push service says this subscription is dead
          // (browser unsubscribed, PWA uninstalled, etc). Drop it so we don't
          // keep retrying indefinitely. Other errors (timeouts, network) are
          // transient and we leave the row in place.
          if (statusCode === 404 || statusCode === 410) {
            store.deleteByEndpoint(s.endpoint);
            pruned += 1;
          } else {
            deps.logger?.warn?.(
              { err, endpoint: s.endpoint, statusCode },
              "web-push send failed",
            );
          }
        }
      }),
    );

    return { sent, pruned };
  }

  return { sendToAll };
}

export async function registerPushRoutes(
  app: FastifyInstance,
  deps: PushRoutesDeps,
  sender: PushSender,
): Promise<void> {
  const store = new PushSubscriptionStore(deps.db);

  app.get(
    "/api/push/vapid-public",
    { preHandler: app.requireAuth as any },
    async () => {
      const body: VapidPublicResponse = { publicKey: deps.vapid.publicKey };
      return body;
    },
  );

  app.post(
    "/api/push/subscriptions",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = PushSubscribeRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const ctx = getRequestCtx(req);
      // Prefer the body-provided userAgent (client may post the browser's
      // navigator.userAgent verbatim), fall back to the request header.
      const ua = parsed.data.userAgent ?? ctx.userAgent;
      const row = store.upsert({
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: ua,
      });
      // Audit: pairing a new push device is security-relevant — that device
      // can now receive permission-request pings that reveal what claude is
      // doing. user-agent goes in `detail` so the Security card can render
      // "New push device: Safari on iPhone".
      deps.audit?.append({
        userId: ctx.userId,
        event: "push_subscribed",
        target: row.id,
        detail: ua ?? null,
        ip: ctx.ip,
        userAgent: ua ?? null,
      });
      const body: PushSubscribeResponse = { id: row.id, enabled: true };
      return reply.send(body);
    },
  );

  app.delete(
    "/api/push/subscriptions/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = store.findById(id);
      const ok = store.deleteById(id);
      if (!ok) return reply.code(404).send({ error: "not_found" });
      const ctx = getRequestCtx(req);
      // Audit: device revocation. Capture the UA from the row we just
      // deleted so the Security card can say which device dropped off.
      deps.audit?.append({
        userId: ctx.userId,
        event: "push_revoked",
        target: id,
        detail: existing?.userAgent ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return reply.send({ ok: true });
    },
  );

  app.delete(
    "/api/push/subscriptions",
    { preHandler: app.requireAuth as any },
    async (_req, reply) => {
      const removed = store.deleteAll();
      return reply.send({ ok: true, removed });
    },
  );

  app.get(
    "/api/push/state",
    { preHandler: app.requireAuth as any },
    async () => {
      const devices = store.listDevices();
      const body: PushStateResponse = {
        enabled: devices.length > 0,
        devices,
      };
      return body;
    },
  );

  app.post(
    "/api/push/test",
    { preHandler: app.requireAuth as any },
    async () => {
      const result = await sender.sendToAll({
        title: "claudex · test",
        body: "Push is working on this device.",
        data: { sessionId: "", url: "/settings?tab=notifications" },
      });
      const body: PushTestResponse = result;
      return body;
    },
  );
}
