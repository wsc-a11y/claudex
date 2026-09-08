// ---------------------------------------------------------------------------
// error-reporter — capture client-side crashes and POST them to the server
// so they survive the white screen and show up in /errors.
//
// Wired up as the VERY FIRST import in main.tsx (before React renders) so
// that window.error / unhandledrejection / console.error hooks are in place
// before any component code runs. A failed fetch here never throws — this
// module's job is to not make things worse.
//
// Notes on the HTTP transport:
//   - Plain fetch with credentials: "same-origin". The JWT cookie rides
//     along so /api/client-errors's requireAuth passes.
//   - navigator.sendBeacon would be nicer for "crash during pagehide", but
//     beacons can't carry credentials on all browsers and this isn't the
//     pagehide use case — we ship errors live while the page is still open.
//   - Buffer pre-auth reports for 60s so the first crash after reload isn't
//     lost to "we just booted and the cookie handshake isn't done". After
//     60s we drop silently to avoid an unbounded buffer.
// ---------------------------------------------------------------------------

type ClientErrorKind =
  | "render"
  | "uncaught"
  | "unhandledrejection"
  | "console-error";

interface ReportInput {
  kind: ClientErrorKind;
  error?: unknown;
  message?: string;
  componentStack?: string;
}

interface Frame {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  componentStack?: string;
  url: string;
  userAgent: string;
  clientTime: number;
}

// Avoid reporting our own POST failing via console.error — would recurse.
let inFlight = false;

// Pre-auth buffer. Bounded to keep a runaway loop from eating RAM before
// the auth cookie lands.
const BUFFER_MAX = 50;
const buffer: Frame[] = [];
let bufferUntil = Date.now() + 60_000;

// Coalesce identical frames within a 500ms window — a render loop can
// otherwise fire thousands of reports a second even with server-side
// dedup. The server still dedups by fingerprint, but the network traffic
// itself is a problem if we don't also dedup on the wire.
const recent = new Map<string, number>();
const COALESCE_WINDOW_MS = 500;

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
function errorStack(e: unknown): string | undefined {
  if (e instanceof Error && e.stack) return e.stack;
  return undefined;
}

function makeFrame(input: ReportInput): Frame {
  const message =
    input.message ??
    errorMessage(input.error) ??
    "unknown";
  return {
    kind: input.kind,
    message: String(message).slice(0, 4000),
    stack: errorStack(input.error),
    componentStack: input.componentStack,
    url: (() => {
      try {
        return location.href;
      } catch {
        return "";
      }
    })(),
    userAgent: (() => {
      try {
        return navigator.userAgent;
      } catch {
        return "";
      }
    })(),
    clientTime: Date.now(),
  };
}

async function send(frame: Frame): Promise<boolean> {
  inFlight = true;
  try {
    const res = await fetch("/api/client-errors", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(frame),
      // keepalive lets the request survive a quick pagehide
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    inFlight = false;
  }
}

function report(input: ReportInput): void {
  // Don't recurse into console.error while sending.
  if (inFlight && input.kind === "console-error") return;

  const frame = makeFrame(input);

  // Coalesce identical frames within the window.
  const dedupKey = `${frame.kind}|${frame.message.slice(0, 200)}|${(frame.stack ?? "").slice(0, 200)}`;
  const now = Date.now();
  const last = recent.get(dedupKey);
  if (last !== undefined && now - last < COALESCE_WINDOW_MS) return;
  recent.set(dedupKey, now);
  // Cheap GC: if the map grows past 200, drop the oldest half.
  if (recent.size > 200) {
    const keys = Array.from(recent.keys()).slice(0, 100);
    for (const k of keys) recent.delete(k);
  }

  // Fire. If it fails AND we're still inside the boot buffer window, stash
  // for one retry in flushBuffer(). Otherwise best-effort drop.
  void send(frame).then((ok) => {
    if (ok) return;
    if (Date.now() > bufferUntil) return;
    if (buffer.length < BUFFER_MAX) buffer.push(frame);
  });
}

async function flushBuffer() {
  while (buffer.length > 0) {
    const f = buffer.shift()!;
    // eslint-disable-next-line no-await-in-loop
    await send(f);
  }
}

/**
 * Flush any queued reports. Safe to call from anywhere — intended to be
 * triggered after successful login so crashes captured before the cookie
 * landed still make it to the server.
 */
export function flushClientErrorBuffer(): void {
  void flushBuffer();
}

/**
 * Public reporter — called by RootErrorBoundary.componentDidCatch and the
 * global handlers installed below. Safe to call from anywhere.
 */
export function reportClientError(input: ReportInput): void {
  try {
    report(input);
  } catch {
    // never let reporting errors escalate
  }
}

// ---------------------------------------------------------------------------
// Install global handlers (runs at import time — main.tsx imports this file
// first-thing so these are armed before React mounts).
// ---------------------------------------------------------------------------

(function installGlobalHandlers() {
  if (typeof window === "undefined") return;

  window.addEventListener("error", (ev) => {
    reportClientError({
      kind: "uncaught",
      error: ev.error ?? undefined,
      message: ev.message || (ev.error instanceof Error ? ev.error.message : "uncaught error"),
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const r = (ev as PromiseRejectionEvent).reason;
    // Preserve the constructor name (e.g. "TypeError: Load failed") so that
    // bare network failures are distinguishable from other rejections in the
    // client-errors log. iOS Safari's `fetch()` rejects with a TypeError
    // whose `name === "TypeError"` and whose `message === "Load failed"` —
    // without the name prefix every such rejection fingerprints identically.
    const msg =
      r instanceof Error
        ? r.name && r.name !== "Error" && !r.message.startsWith(r.name)
          ? `${r.name}: ${r.message || ""}`
          : r.message || r.name
        : errorMessage(r);
    reportClientError({
      kind: "unhandledrejection",
      error: r instanceof Error ? r : undefined,
      message: msg,
    });
  });

  // Wrap console.error so React's own warnings and any hand-rolled
  // console.error call shows up in the queue. Preserve the original so
  // the user's DevTools view is unchanged.
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      // Find the first Error in args — React passes `(message, error)`
      // for getDerivedStateFromError; ErrorBoundary passes `(label, error, stack)`.
      const err = args.find((a) => a instanceof Error) as Error | undefined;
      const msgParts = args.map((a) => {
        if (a instanceof Error) return a.stack ?? a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      });
      reportClientError({
        kind: "console-error",
        error: err,
        message: msgParts.join(" ").slice(0, 4000),
      });
    } catch {
      /* never swallow the original */
    }
    origError(...args);
  };
})();
