import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import webpush from "web-push";
import { bootstrapAuthedApp } from "./helpers.js";

// -----------------------------------------------------------------------------
// Push-route tests
//
// Strategy: we spin up the app with a real VAPID keypair (one ECC keygen per
// suite is cheap), but we stub `webpush.sendNotification` so we don't actually
// hit a push service. This keeps the route-level behavior under test (store
// upsert, idempotency, 401 gate, state reporting) while letting us assert on
// what the sender tried to do.
// -----------------------------------------------------------------------------

async function bootstrap() {
  const vapid = webpush.generateVAPIDKeys();
  return bootstrapAuthedApp(undefined, {
    vapid: {
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
      subject: "mailto:test@claudex.local",
    },
  });
}

describe("push routes", () => {
  let env: Awaited<ReturnType<typeof bootstrap>>;
  const sendSpy = vi.spyOn(webpush, "sendNotification");

  beforeEach(async () => {
    sendSpy.mockReset();
    sendSpy.mockResolvedValue({} as any);
    env = await bootstrap();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("rejects subscribe without auth", async () => {
    const res = await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      payload: {
        endpoint: "https://push.example/1",
        keys: { p256dh: "abc", auth: "def" },
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects state without auth", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/push/state" });
    expect(res.statusCode).toBe(401);
  });

  it("serves vapid public key", async () => {
    const res = await env.app.inject({
      method: "GET",
      url: "/api/push/vapid-public",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { publicKey: string };
    // Base64url; web-push keys are 65 raw bytes → 87 base64url chars.
    expect(body.publicKey.length).toBeGreaterThan(40);
  });

  it("subscribe → state shows enabled + 1 device", async () => {
    const sub = await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie, "user-agent": "Safari/iPhone" },
      payload: {
        endpoint: "https://push.example/device-a",
        keys: { p256dh: "pkey", auth: "akey" },
      },
    });
    expect(sub.statusCode).toBe(200);
    const subBody = sub.json() as { id: string; enabled: boolean };
    expect(subBody.enabled).toBe(true);
    expect(subBody.id).toBeTruthy();

    const state = await env.app.inject({
      method: "GET",
      url: "/api/push/state",
      headers: { cookie: env.cookie },
    });
    expect(state.statusCode).toBe(200);
    const body = state.json() as {
      enabled: boolean;
      devices: Array<{ id: string; userAgent: string | null }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].userAgent).toBe("Safari/iPhone");
  });

  it("second subscribe with same endpoint upserts (no duplicate row)", async () => {
    const payload = {
      endpoint: "https://push.example/same",
      keys: { p256dh: "k1", auth: "a1" },
    };
    const first = await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
      payload: {
        endpoint: "https://push.example/same",
        keys: { p256dh: "k2", auth: "a2" },
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id); // same row

    const state = await env.app.inject({
      method: "GET",
      url: "/api/push/state",
      headers: { cookie: env.cookie },
    });
    const body = state.json() as { devices: unknown[] };
    expect(body.devices).toHaveLength(1);
  });

  it("DELETE by id → state shows 0 devices", async () => {
    const sub = await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
      payload: {
        endpoint: "https://push.example/delete-me",
        keys: { p256dh: "p", auth: "a" },
      },
    });
    const { id } = sub.json() as { id: string };

    const del = await env.app.inject({
      method: "DELETE",
      url: `/api/push/subscriptions/${id}`,
      headers: { cookie: env.cookie },
    });
    expect(del.statusCode).toBe(200);

    const state = await env.app.inject({
      method: "GET",
      url: "/api/push/state",
      headers: { cookie: env.cookie },
    });
    const body = state.json() as { enabled: boolean; devices: unknown[] };
    expect(body.enabled).toBe(false);
    expect(body.devices).toHaveLength(0);
  });

  it("DELETE by unknown id → 404", async () => {
    const del = await env.app.inject({
      method: "DELETE",
      url: "/api/push/subscriptions/nonexistent",
      headers: { cookie: env.cookie },
    });
    expect(del.statusCode).toBe(404);
  });

  it("DELETE all → state shows 0 devices", async () => {
    for (const endpoint of ["a", "b", "c"]) {
      await env.app.inject({
        method: "POST",
        url: "/api/push/subscriptions",
        headers: { cookie: env.cookie },
        payload: {
          endpoint: `https://push.example/${endpoint}`,
          keys: { p256dh: "p", auth: "a" },
        },
      });
    }
    const del = await env.app.inject({
      method: "DELETE",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
    });
    expect(del.statusCode).toBe(200);
    const body = del.json() as { ok: boolean; removed: number };
    expect(body.removed).toBe(3);
  });

  it("test push with no subscriptions returns sent=0", async () => {
    const res = await env.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sent: number; pruned: number };
    expect(body.sent).toBe(0);
    expect(body.pruned).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("test push with one subscription calls webpush.sendNotification", async () => {
    await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
      payload: {
        endpoint: "https://push.example/active",
        keys: { p256dh: "p", auth: "a" },
      },
    });
    const res = await env.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const body = res.json() as { sent: number; pruned: number };
    expect(body.sent).toBe(1);
    expect(body.pruned).toBe(0);
  });

  it("410 Gone from push service prunes the subscription", async () => {
    await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
      payload: {
        endpoint: "https://push.example/stale",
        keys: { p256dh: "p", auth: "a" },
      },
    });
    sendSpy.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { statusCode: 410 }),
    );
    const res = await env.app.inject({
      method: "POST",
      url: "/api/push/test",
      headers: { cookie: env.cookie },
    });
    const body = res.json() as { sent: number; pruned: number };
    expect(body.sent).toBe(0);
    expect(body.pruned).toBe(1);

    const state = await env.app.inject({
      method: "GET",
      url: "/api/push/state",
      headers: { cookie: env.cookie },
    });
    const sbody = state.json() as { devices: unknown[] };
    expect(sbody.devices).toHaveLength(0);
  });

  it("per-endpoint send timeout bounds the fan-out (slow endpoint doesn't wedge sendToAll)", async () => {
    // vi.useFakeTimers + a 20s-delay stub + assertion that the 8s timeout
    // fires first. Without the per-endpoint watchdog this test would hang
    // for 20s (the delay) instead of resolving at 8s.
    await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
      payload: {
        endpoint: "https://push.example/slow",
        keys: { p256dh: "p", auth: "a" },
      },
    });
    // Replace the stub with one that resolves only after 20s of fake time.
    sendSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // setTimeout lives on the global — vi.useFakeTimers() intercepts
          // it so we can fast-forward deterministically.
          setTimeout(() => resolve({} as any), 20_000);
        }),
    );

    vi.useFakeTimers();
    try {
      const reqPromise = env.app.inject({
        method: "POST",
        url: "/api/push/test",
        headers: { cookie: env.cookie },
      });
      // Advance just past the 8s per-endpoint timeout. The dispatcher's race
      // promise should fire first and the request should resolve with
      // sent=0, pruned=0 (timeout is transient — we don't prune on it).
      await vi.advanceTimersByTimeAsync(8_500);
      const res = await reqPromise;
      const body = res.json() as { sent: number; pruned: number };
      expect(body.sent).toBe(0);
      expect(body.pruned).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    // The subscription should still exist — timeouts don't prune (could be
    // transient). Only 404/410 prune.
    const state = await env.app.inject({
      method: "GET",
      url: "/api/push/state",
      headers: { cookie: env.cookie },
    });
    expect((state.json() as { devices: unknown[] }).devices).toHaveLength(1);
  });

  it("one slow endpoint doesn't prevent a fast endpoint in the same fan-out from succeeding", async () => {
    // Two subscriptions; one stub resolves immediately, the other hangs for
    // 20s. The fast one must still be counted as `sent` — allSettled
    // semantics.
    await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
      payload: {
        endpoint: "https://push.example/slow-2",
        keys: { p256dh: "p", auth: "a" },
      },
    });
    await env.app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie: env.cookie },
      payload: {
        endpoint: "https://push.example/fast",
        keys: { p256dh: "p", auth: "a" },
      },
    });

    // Match by endpoint so the order in which the fan-out iterates doesn't
    // matter.
    sendSpy.mockImplementation(((sub: { endpoint: string }) => {
      if (sub.endpoint.includes("slow")) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({} as any), 20_000);
        });
      }
      return Promise.resolve({} as any);
    }) as any);

    vi.useFakeTimers();
    try {
      const reqPromise = env.app.inject({
        method: "POST",
        url: "/api/push/test",
        headers: { cookie: env.cookie },
      });
      await vi.advanceTimersByTimeAsync(8_500);
      const res = await reqPromise;
      const body = res.json() as { sent: number; pruned: number };
      // Fast endpoint counted; slow one timed out silently (not pruned).
      expect(body.sent).toBe(1);
      expect(body.pruned).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
