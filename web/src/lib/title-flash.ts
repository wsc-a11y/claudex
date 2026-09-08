// ---------------------------------------------------------------------------
// document.title flasher.
//
// Lightweight "you have unread activity" signal for when the user is on
// another tab. We prepend a marker ("* ") to document.title whenever the
// page is hidden, and automatically strip it the next time the user brings
// the tab back to the foreground. Used by the sessions store to surface
// session-completed events since Web Push isn't available on the user's
// HTTP deployment.
//
// Design notes:
//  - Only one marker is ever visible at a time — chaining "* * * Foo" adds
//    visual noise without signaling "more events". Subsequent flashes while
//    the tab is still hidden are no-ops.
//  - We capture the "original" title lazily on each flash rather than at
//    module load, so SPA route changes that update document.title don't
//    strand us with a stale baseline.
//  - A single visibilitychange listener is lazily attached; it survives
//    hot-reloads in dev because the module is re-imported but we check
//    before re-attaching.
// ---------------------------------------------------------------------------

const MARKER = "* ";
let listenerAttached = false;
let flashed = false;

function ensureListener(): void {
  if (listenerAttached) return;
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && flashed) {
      restoreTitle();
    }
  });
  listenerAttached = true;
}

function restoreTitle(): void {
  if (!flashed) return;
  if (document.title.startsWith(MARKER)) {
    document.title = document.title.slice(MARKER.length);
  }
  flashed = false;
}

/**
 * Prepend a marker to document.title if the tab is currently hidden.
 * No-op if the tab is visible (user is already looking at the app) or if
 * the marker is already present. The marker is removed automatically the
 * next time the tab becomes visible.
 */
export function flashTitle(): void {
  if (typeof document === "undefined") return;
  ensureListener();
  if (!document.hidden) return;
  if (document.title.startsWith(MARKER)) return;
  document.title = MARKER + document.title;
  flashed = true;
}
