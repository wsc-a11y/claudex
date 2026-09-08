// -----------------------------------------------------------------------------
// Web Push client helpers
//
// Thin wrapper around the browser's PushManager + our `/api/push/*` routes.
//
// The heavy lifting on the server side is `web-push` (VAPID signing +
// AES128-GCM / AES-GCM body encryption). On the client side we only need to:
//   1. register the service worker at /sw.js
//   2. fetch the VAPID public key
//   3. PushManager.subscribe({ applicationServerKey })
//   4. POST the resulting PushSubscription to /api/push/subscriptions
//
// Platform gotchas worth surfacing in the UI:
//   - iOS Safari REQUIRES the site to be installed to the home screen as a
//     PWA before PushManager.subscribe works at all (and TLS must be valid).
//     Regular "Add to home screen" on iOS uses the web app manifest we ship
//     in /manifest.webmanifest.
//   - Chrome / Firefox / Android browsers work over HTTPS without PWA
//     install, but frpc-over-plain-HTTP does NOT work — browsers refuse to
//     register a service worker on insecure origins (except localhost).
// -----------------------------------------------------------------------------

import type {
  PushDevice,
  PushStateResponse,
  PushSubscribeRequest,
  PushSubscribeResponse,
  PushTestResponse,
  VapidPublicResponse,
} from "@claudex/shared";

const SW_URL = "/sw.js";

/**
 * One-stop check the Settings UI calls before rendering anything push-shaped.
 * Distinguishes between the three user-visible failure modes so we can give
 * an honest error instead of a generic "not supported":
 *
 *   - `"unsupported"`  — this browser has no ServiceWorker or PushManager
 *                         (old browsers, some embedded webviews)
 *   - `"insecure"`     — window.isSecureContext is false (plain-HTTP frpc)
 *   - `"ready"`        — we can proceed
 */
export type PushSupport = "ready" | "unsupported" | "insecure";

export function detectPushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!("PushManager" in window)) return "unsupported";
  if (!("Notification" in window)) return "unsupported";
  // Service workers are gated on secure context. localhost is special-cased
  // by every browser, so dev-mode still works.
  if (!window.isSecureContext) return "insecure";
  return "ready";
}

/**
 * Register (or reuse) the service worker at `/sw.js`. Idempotent — if a SW
 * is already controlling the page, the browser returns the existing
 * registration. Rejects if the browser doesn't support SW or the origin is
 * insecure; callers should gate on `detectPushSupport()` first.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (detectPushSupport() !== "ready") {
    throw new Error("push not supported in this context");
  }
  return navigator.serviceWorker.register(SW_URL, { scope: "/" });
}

/**
 * Ask the user for Notification permission. Returns the final permission
 * string — `"granted"` is the only one that lets us subscribe.
 */
export async function requestPermission(): Promise<NotificationPermission> {
  // Some old browsers (looking at you, Safari 13) used the callback form;
  // the promise form is safe on everything we target.
  return Notification.requestPermission();
}

/**
 * Subscribe this device to push notifications. Orchestrates the full flow:
 * permission → SW registration → VAPID key fetch → PushManager.subscribe →
 * POST /api/push/subscriptions. Returns the subscription id on the server.
 *
 * Throws with descriptive messages on each failure so the Settings panel
 * can render something meaningful. Specifically:
 *   - "permission_denied" — user declined the browser prompt
 *   - "vapid_fetch_failed" — server didn't return a VAPID key (500 or auth)
 *   - other errors surface the browser's own message verbatim
 */
export async function subscribeToPush(): Promise<{
  id: string;
  endpoint: string;
}> {
  const support = detectPushSupport();
  if (support !== "ready") {
    throw new Error(
      support === "insecure"
        ? "Push requires HTTPS. Run claudex behind a TLS tunnel (Cloudflare Tunnel, Tailscale, Caddy)."
        : "This browser doesn't support Web Push.",
    );
  }

  const permission = await requestPermission();
  if (permission !== "granted") {
    throw new Error("permission_denied");
  }

  const registration = await registerServiceWorker();
  // Make sure the SW is active before we try to subscribe — a brand-new
  // registration is still in `installing` for a moment.
  await navigator.serviceWorker.ready;

  const vapidRes = await fetch("/api/push/vapid-public", {
    credentials: "same-origin",
  });
  if (!vapidRes.ok) throw new Error("vapid_fetch_failed");
  const { publicKey } = (await vapidRes.json()) as VapidPublicResponse;

  // If a subscription already exists (re-enable after revoke, browser data
  // import), reuse it — PushManager.subscribe will return the same object,
  // but explicitly checking lets us skip re-POSTing identical state.
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast to BufferSource — TS's Uint8Array generic gets confused between
      // SharedArrayBuffer and ArrayBuffer on newer lib.dom, but the runtime
      // value is fine for PushManager.
      applicationServerKey: applicationServerKey as BufferSource,
    });
  }

  const payload = serializeSubscription(subscription);
  const res = await fetch("/api/push/subscriptions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`subscribe_failed_${res.status}`);
  }
  const body = (await res.json()) as PushSubscribeResponse;
  return { id: body.id, endpoint: subscription.endpoint };
}

/**
 * Revoke the local browser's push subscription AND tell the server to forget
 * every device. Mirrors the "Disable notifications on this device" action in
 * Settings. On error we still attempt the server-side cleanup so a revoke
 * half-succeeds at worst — never silently succeeds.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (detectPushSupport() !== "ready") return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const sub = await registration?.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe();
    }
  } catch {
    // Ignore — browser-side revoke failures shouldn't block server cleanup.
  }
  await fetch("/api/push/subscriptions", {
    method: "DELETE",
    credentials: "same-origin",
  });
}

/**
 * Revoke a single server-side device entry. Useful when the user wants to
 * de-authorize a phone from the desktop Settings page without logging in on
 * that phone. Does NOT touch the current browser's PushManager subscription.
 */
export async function revokeDevice(id: string): Promise<void> {
  const res = await fetch(`/api/push/subscriptions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`revoke_failed_${res.status}`);
  }
}

export async function getPushState(): Promise<PushStateResponse> {
  const res = await fetch("/api/push/state", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`state_failed_${res.status}`);
  return (await res.json()) as PushStateResponse;
}

export async function sendTestPush(): Promise<PushTestResponse> {
  const res = await fetch("/api/push/test", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`test_failed_${res.status}`);
  return (await res.json()) as PushTestResponse;
}

/**
 * Is the *current* browser currently push-subscribed? Separate from
 * `getPushState().enabled` — that's a server-side "has any device" check,
 * this one asks the local PushManager.
 */
export async function isCurrentDeviceSubscribed(): Promise<boolean> {
  if (detectPushSupport() !== "ready") return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  const sub = await registration.pushManager.getSubscription();
  return sub !== null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Convert a VAPID base64url public key to the Uint8Array shape that
 * PushManager.subscribe({applicationServerKey}) expects. Lifted from the
 * web-push docs — this transformation is universal.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

/**
 * Coerce a browser `PushSubscription` into the shape `/api/push/subscriptions`
 * expects. We pull the keys off via `toJSON()` because `getKey()` returns an
 * ArrayBuffer we'd then have to base64-encode ourselves.
 */
function serializeSubscription(sub: PushSubscription): PushSubscribeRequest {
  const json = sub.toJSON();
  const keys = json.keys as { p256dh?: string; auth?: string } | undefined;
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: keys?.p256dh ?? "",
      auth: keys?.auth ?? "",
    },
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : undefined,
  };
}

/**
 * Render a user-facing label from a stored device's raw `userAgent` string.
 * Not trying to rebuild a full UA parser — just surface the platform family
 * that matters on a phone / laptop. Returns "Unknown device" when the UA is
 * null or we can't classify it.
 */
export function deviceLabel(device: PushDevice): string {
  const ua = device.userAgent;
  if (!ua) return "Unknown device";
  if (/iPhone|iPad|iPod/i.test(ua)) return "Safari on iOS";
  if (/Android/i.test(ua)) {
    if (/Chrome/i.test(ua)) return "Chrome on Android";
    return "Browser on Android";
  }
  if (/Mac OS X/i.test(ua)) {
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return "Safari on macOS";
    if (/Chrome/i.test(ua)) return "Chrome on macOS";
    if (/Firefox/i.test(ua)) return "Firefox on macOS";
  }
  if (/Windows/i.test(ua)) {
    if (/Edg/i.test(ua)) return "Edge on Windows";
    if (/Chrome/i.test(ua)) return "Chrome on Windows";
    if (/Firefox/i.test(ua)) return "Firefox on Windows";
  }
  if (/Linux/i.test(ua)) {
    if (/Chrome/i.test(ua)) return "Chrome on Linux";
    if (/Firefox/i.test(ua)) return "Firefox on Linux";
  }
  return ua.split(" ")[0] ?? "Unknown device";
}
