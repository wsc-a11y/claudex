/* eslint-disable no-restricted-globals */
// claudex service worker — minimal, push-first.
//
// We deliberately ship NO caching strategy. claudex is a thin client over
// a live server; serving a stale bundle from cache is worse than reloading.
// The SW exists to receive `push` events and open a window on click.

self.addEventListener("install", (event) => {
  // Skip "waiting" so an updated SW takes over immediately on the next
  // navigation — matters when the user enables notifications for the first
  // time and we don't want to force them to reload twice.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openSession(data));
});

async function handlePush(event) {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Claudex", body: "You have a new notification." };
  }
  const title = payload.title || "Claudex";
  const body = payload.body || "";
  const data = payload.data || {};
  // `tag` collapses duplicate notifications for the same session so the user
  // doesn't see a stack when claude asks three times in a row.
  const tag = data.sessionId || "claudex";
  return self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag,
    data,
    // Vibrate briefly on Android; iOS ignores this.
    vibrate: [80, 40, 80],
    // renotify so repeats of the same tag still ping the user.
    renotify: true,
  });
}

async function openSession(data) {
  const target = data.url || "/";
  const sessionId = data.sessionId || "";
  const clientsList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  // Prefer an existing tab already pointed at this session — focus rather
  // than opening a duplicate.
  for (const client of clientsList) {
    try {
      const url = new URL(client.url);
      if (
        sessionId &&
        url.pathname.startsWith(`/session/${sessionId}`) &&
        "focus" in client
      ) {
        return client.focus();
      }
    } catch {
      // ignore malformed client URLs
    }
  }
  // Next best: any claudex tab — navigate it.
  if (clientsList.length > 0 && "navigate" in clientsList[0]) {
    try {
      await clientsList[0].navigate(target);
      return clientsList[0].focus();
    } catch {
      // fall through
    }
  }
  if (self.clients.openWindow) {
    return self.clients.openWindow(target);
  }
}
