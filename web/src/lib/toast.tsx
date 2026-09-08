// ---------------------------------------------------------------------------
// Tiny toast singleton.
//
// One pub/sub instance, one mountable <ToastHost /> component. Callers fire
// toast("message") and get a 1600ms auto-dismissing bubble at the bottom of
// the viewport. We intentionally keep this infra tiny — no queue, no stacking,
// no actions; the next toast replaces the current one and resets the timer.
//
// Keeping this in its own module (rather than inlined into MessageActions)
// lets other callers (e.g. the chat composer, settings panels) reuse the same
// host without fighting over portal roots.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";

type Listener = (msg: string | null) => void;
const listeners = new Set<Listener>();
let current: string | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function emit(msg: string | null): void {
  current = msg;
  for (const l of listeners) l(msg);
}

export function toast(msg: string): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  emit(msg);
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    emit(null);
  }, 1600);
}

/**
 * Fixed-position toast host. Mount once near the top of the chat tree (or the
 * app shell). Renders nothing while idle so it doesn't steal pointer events.
 */
export function ToastHost(): JSX.Element | null {
  const [msg, setMsg] = useState<string | null>(current);
  useEffect(() => {
    listeners.add(setMsg);
    return () => {
      listeners.delete(setMsg);
    };
  }, []);
  if (!msg) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[70] bg-ink text-canvas px-3 py-1.5 rounded text-ui shadow-lift pointer-events-none"
    >
      {msg}
    </div>
  );
}
