// Shared helpers for the two admin buttons ("Force reload (clear cache)" and
// "Restart server"). They were originally inline in Settings.tsx; pulled out
// here so the Home header overflow menu can expose the same behaviour without
// duplicating the cache-busting + health-poll logic. Keeping the two
// helpers co-located makes it easy to keep them in sync — they share the
// same reload tail and the same `?_r=<ts>` cache-buster convention.

import { api, ApiError } from "@/api/client";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Append a cache-busting query param and `replace()` into it so the browser
// treats this as a fresh URL and bypasses its HTTP cache for index.html.
// The server's SPA fallback ignores query strings, so the path still resolves
// to the current index.html — which references the latest hashed /assets
// bundle. Preserves pathname + hash so deep links survive the reload.
function reloadWithBust(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("_r", Date.now().toString(36));
  window.location.replace(url.toString());
}

// Best-effort: purge any Cache API stores the browser may have against
// this origin. `caches` may be undefined on plain HTTP in some browsers
// (secure-context-only variants), so guard it. Errors are swallowed —
// this is a "try to be helpful" pass, not a correctness boundary.
export async function forceReload(): Promise<void> {
  try {
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch {
    /* ignore — best effort */
  }
  reloadWithBust();
}

// Poll /api/health until a successful response, then force-reload the page
// so the UI re-connects to the fresh server. Health polls are cheap and
// give the caller a place to show a countdown instead of a blank "please
// wait"; cap at ~35s (matches the detach worker's port-drain ceiling)
// before surfacing a failure.
//
// Returns when the page is navigating away (success) or when the deadline
// elapses (throws). The `onProgress` callback, when supplied, fires on every
// unsuccessful poll so UI can animate a spinner without knowing the poll
// cadence.
export async function waitForServerAndReload(opts?: {
  onProgress?: () => void;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 35_000;
  const deadline = Date.now() + timeoutMs;
  // Give the old server a beat to tear down before the first poll so we
  // don't race a 200 from the dying process.
  await sleep(500);
  while (Date.now() < deadline) {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) {
        await sleep(400);
        reloadWithBust();
        return;
      }
    } catch {
      /* server is still coming up; keep polling */
    }
    opts?.onProgress?.();
    await sleep(800);
  }
  throw new Error("Timed out waiting for the server to come back up.");
}

// Full restart flow: fire the admin endpoint (the server drops the TCP
// connection mid-response in the common case — that's expected, not an
// error), then poll for the port to come back and reload.
export async function restartServer(opts?: {
  onProgress?: () => void;
  timeoutMs?: number;
}): Promise<void> {
  try {
    await api.adminRestart();
  } catch {
    // Expected: the server usually drops the TCP connection before the
    // JSON body flushes. Silent-ok — we'll verify via /api/health.
  }
  await waitForServerAndReload(opts);
}

// Update + restart flow: fire the update-and-restart endpoint.
// Unlike a plain restart, the server runs git fetch / checkout / pnpm install /
// web build BEFORE committing to shutdown. If any of those steps fail, the
// server returns a proper error (502) and stays alive — the user sees the
// error in the UI and can retry. Only when all steps succeed does the server
// spawn the restart worker and SIGTERM itself, so a "dropped connection" catch
// here is still expected in the success path.
export async function updateAndRestart(tag: string, opts?: {
  onProgress?: () => void;
  timeoutMs?: number;
}): Promise<void> {
  try {
    await api.adminUpdateAndRestart(tag);
  } catch (e) {
    // If the server returned a structured error (e.g. git_fetch_failed),
    // re-throw it so the UI can show what went wrong — the server is still
    // up and the user can retry.
    if (e instanceof ApiError) throw e;
    // Otherwise the server dropped the TCP connection (success path — it
    // SIGTERM'd itself after all steps passed). Fall through to health-poll.
  }
  await waitForServerAndReload(opts);
}
