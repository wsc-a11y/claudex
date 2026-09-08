import { create } from "zustand";
import type { Alert } from "@claudex/shared";
import { api } from "@/api/client";

// -----------------------------------------------------------------------------
// Alerts Zustand slice.
//
// Source of truth for the alerts list across the app (AppShell badge,
// /alerts screen). Populated from REST (`GET /api/alerts`) and kept fresh
// by the `alerts_update` WS frame — when the server fires it, a listener
// wired in state/sessions.ts calls `fetchAlerts()` here to reconcile.
//
// State model matches the server's: an alert has two orthogonal bits
// (seenAt, resolvedAt). The UI filters into All / Unread / Read buckets
// rather than deleting rows, mirroring the "state transitions, not
// deletion" server design.
//
// Per-session dedup: the UI only shows the latest alert per sessionId
// (alerts with null sessionId are kept as-is). The helper below is
// exported so the Alerts screen and this store compute exactly the same
// deduped list — that keeps the badge count and the list row count in
// sync, which was the source of the old "red dot with empty screen" bug.
// -----------------------------------------------------------------------------

interface AlertsState {
  alerts: Alert[];
  /** Unseen count on the DEDUPED view — one row per session — so the
   *  AppShell badge matches what the Alerts screen actually shows. */
  unseenCount: number;
  /** True between `fetchAlerts` kickoff and first resolution. Drives the
   *  spinner on the Alerts screen. */
  loading: boolean;

  fetchAlerts(): Promise<void>;
  /** Mark one alert seen. Optimistically updates local state; on server
   *  failure the next WS-driven refetch will reconcile. */
  markSeen(id: string): Promise<void>;
  /** Bulk mark-seen. Called by the "Mark all seen" button on the Alerts
   *  screen. No longer auto-fired on mount — the old auto-behavior cleared
   *  the badge the moment the user opened the screen, which combined with
   *  a default-to-Unread filter meant the screen rendered empty. */
  markAllSeen(): Promise<void>;
  /** User-initiated dismiss — stamps both resolved_at AND seen_at on the
   *  server, so the alert drops out of Unread on the next refetch. Kept
   *  in the All tab as an archival row. */
  dismiss(id: string): Promise<void>;
}

/**
 * Group alerts by sessionId and return only the latest (highest createdAt)
 * per session. Alerts with null sessionId pass through untouched — they
 * have no session to dedupe against.
 *
 * Order of the returned list matches the input order, filtered. Since the
 * server returns newest-first, this naturally preserves "newest first".
 */
export function dedupBySession(list: Alert[]): Alert[] {
  // Pick the winning id per session first (one pass), then filter the
  // original list to preserve its order. `createdAt` is ISO 8601 so
  // string compare is sufficient — no need to parse to Date.
  const winner = new Map<string, string>(); // sessionId → winning alert id
  const latestAt = new Map<string, string>(); // sessionId → createdAt
  for (const a of list) {
    if (a.sessionId === null) continue;
    const prev = latestAt.get(a.sessionId);
    if (!prev || a.createdAt > prev) {
      latestAt.set(a.sessionId, a.createdAt);
      winner.set(a.sessionId, a.id);
    }
  }
  return list.filter(
    (a) => a.sessionId === null || winner.get(a.sessionId) === a.id,
  );
}

function computeUnseen(list: Alert[]): number {
  // Dedup first so the badge reflects "distinct sessions with something
  // new", not "raw row count" (which double-counts when both a
  // permission_pending and a session_completed exist for the same session
  // in transient overlap).
  const deduped = dedupBySession(list);
  let n = 0;
  for (const a of deduped) if (a.seenAt === null) n++;
  return n;
}

export const useAlerts = create<AlertsState>((set, get) => ({
  alerts: [],
  unseenCount: 0,
  loading: false,

  async fetchAlerts() {
    set({ loading: true });
    try {
      const res = await api.listAlerts();
      // Ignore the server's `unseenCount` — it's the raw count, which
      // doesn't account for per-session dedup the UI applies. Recompute
      // locally so the badge matches what the Alerts screen renders.
      set({
        alerts: res.alerts,
        unseenCount: computeUnseen(res.alerts),
        loading: false,
      });
    } catch {
      // Keep existing state on failure; drop the loading flag so the UI
      // doesn't wedge on a spinner.
      set({ loading: false });
    }
  },

  async markSeen(id: string) {
    // Optimistic local update.
    const now = new Date().toISOString();
    const next = get().alerts.map((a) =>
      a.id === id && a.seenAt === null ? { ...a, seenAt: now } : a,
    );
    set({ alerts: next, unseenCount: computeUnseen(next) });
    try {
      await api.markAlertSeen(id);
    } catch {
      /* WS alerts_update will reconcile */
    }
  },

  async markAllSeen() {
    const now = new Date().toISOString();
    const next = get().alerts.map((a) =>
      a.seenAt === null ? { ...a, seenAt: now } : a,
    );
    set({ alerts: next, unseenCount: 0 });
    try {
      await api.markAllAlertsSeen();
    } catch {
      /* reconcile via WS */
    }
  },

  async dismiss(id: string) {
    const now = new Date().toISOString();
    const next = get().alerts.map((a) =>
      a.id === id
        ? {
            ...a,
            seenAt: a.seenAt ?? now,
            resolvedAt: a.resolvedAt ?? now,
          }
        : a,
    );
    set({ alerts: next, unseenCount: computeUnseen(next) });
    try {
      await api.dismissAlert(id);
    } catch {
      /* reconcile via WS */
    }
  },
}));
