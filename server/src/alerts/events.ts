import type { SessionStatus } from "@claudex/shared";
import type { AlertStore } from "./store.js";
import type { SessionStore } from "../sessions/store.js";

// -----------------------------------------------------------------------------
// Alert hook — maps session status transitions to alert DB writes.
//
// Wired into SessionManager.setAlertHook at app boot. Called AFTER the DB
// row has been stamped, so a findById inside the hook sees the new status.
//
// Rules:
//   from=? to=awaiting     → insert permission_pending (dedupe: only if
//                             no open one exists for this session)
//   from=awaiting to=?     → auto-resolve every open permission_pending
//                             alert for this session
//   from=? to=error        → insert session_error + auto-resolve any open
//                             permission_pending for the session (because
//                             entering error implies awaiting has cleared)
//   from=error to=?        → auto-resolve open session_error alerts
//   from=running to=idle   → insert session_completed (always; the UI
//                             filters stale rows via the seen/resolved
//                             state bits rather than gating the write)
//
// The hook MUST NOT throw — the manager swallows any throw in its
// transitionStatus wrapper, but to keep the log clean we also catch here
// and log a debug instead of warn.
// -----------------------------------------------------------------------------

export interface AlertHookDeps {
  alerts: AlertStore;
  sessions: SessionStore;
  /** Fired whenever the alerts list mutates (any insert OR any resolve that
   *  actually changed rows). Wired to SessionManager.notifyAlertsUpdate so
   *  every tab's alert badge refreshes immediately. */
  notifyUpdate: () => void;
  logger?: {
    debug?: (obj: unknown, msg?: string) => void;
  };
}

export function createAlertHook(deps: AlertHookDeps) {
  return function onTransition(
    sessionId: string,
    from: SessionStatus | null,
    to: SessionStatus,
  ): void {
    try {
      const session = deps.sessions.findById(sessionId);
      if (!session) return;

      // Exclude side-chat children from all alert generation. Their parent
      // surfaces user attention already; doubling up would spam the badge.
      if (session.parentSessionId) return;

      let mutated = false;

      // Entering awaiting (permission prompt or ask_user_question / plan
      // accept request). Dedupe: don't add another row if there's already
      // an open one for this session.
      if (to === "awaiting" && from !== "awaiting") {
        // Cheap dedupe: list all and filter. Alert count is bounded.
        const openForSession = deps.alerts
          .listAll()
          .some(
            (a) =>
              a.sessionId === sessionId &&
              a.kind === "permission_pending" &&
              a.resolvedAt === null,
          );
        if (!openForSession) {
          deps.alerts.insert({
            kind: "permission_pending",
            sessionId,
            projectId: session.projectId,
            title: session.title || "Untitled session",
            body: "Needs your approval",
            payload: null,
          });
          mutated = true;
        }
      }

      // Leaving awaiting → auto-resolve open permission_pending alerts.
      if (from === "awaiting" && to !== "awaiting") {
        const n = deps.alerts.resolveBySessionKind(
          sessionId,
          "permission_pending",
        );
        if (n > 0) mutated = true;
      }

      // Entering error → insert session_error (dedupe) + auto-resolve
      // any open permission_pending (because awaiting cleared).
      if (to === "error" && from !== "error") {
        const n = deps.alerts.resolveBySessionKind(
          sessionId,
          "permission_pending",
        );
        if (n > 0) mutated = true;

        const openErrorForSession = deps.alerts
          .listAll()
          .some(
            (a) =>
              a.sessionId === sessionId &&
              a.kind === "session_error" &&
              a.resolvedAt === null,
          );
        if (!openErrorForSession) {
          deps.alerts.insert({
            kind: "session_error",
            sessionId,
            projectId: session.projectId,
            title: session.title || "Untitled session",
            body: "Session errored — tap for details",
            payload: null,
          });
          mutated = true;
        }
      }

      // Leaving error → auto-resolve open session_error alerts.
      if (from === "error" && to !== "error") {
        const n = deps.alerts.resolveBySessionKind(
          sessionId,
          "session_error",
        );
        if (n > 0) mutated = true;
      }

      // A turn just finished (running → idle). Dedupe per session: every
      // session has at most ONE session_completed alert at any time,
      // representing the latest completion. If we inserted on every turn
      // without cleanup a long-running session would stack 10+ near-
      // identical rows and completely clog the user's alerts list — which
      // is exactly what drove the "red dot, empty screen" bug. So: delete
      // prior session_completed rows for this session before inserting
      // the fresh one. The new row carries a fresh id + createdAt +
      // unseen/unresolved bits, which drives the badge back up so the
      // user sees the new completion land.
      if (from === "running" && to === "idle") {
        deps.alerts.deleteBySessionKind(sessionId, "session_completed");
        deps.alerts.insert({
          kind: "session_completed",
          sessionId,
          projectId: session.projectId,
          title: session.title || "Untitled session",
          body: "Turn finished — tap to review",
          payload: null,
        });
        mutated = true;
      }

      if (mutated) {
        deps.notifyUpdate();
      }
    } catch (err) {
      deps.logger?.debug?.(
        { err, sessionId, from, to },
        "alert hook failed",
      );
    }
  };
}
