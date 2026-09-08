import type Database from "better-sqlite3";
import type { SessionManager } from "../sessions/manager.js";
import { PendingRestartStore } from "../admin/pending-restarts.js";
import { SessionStore } from "../sessions/store.js";

// -----------------------------------------------------------------------------
// Boot sweep: turn pending restart results into real transcript events.
//
// See server/src/db/index.ts migration 19 and
// server/src/admin/pending-restarts.ts for the why.
//
// Flow per row:
//   1. Look up the session. If it's gone (session deleted between the
//      restart and this boot), just drop the row — there's nothing to
//      write to.
//   2. Append a `tool_result` event with isError=false and a human-readable
//      "claudex restarted successfully." body. The paired tool_use came
//      from the SDK harness with the same toolUseId, so the chat UI's
//      tool_use ↔ tool_result matcher pairs them on load.
//   3. Force the session back to idle. The restart ended the in-progress
//      turn, so the composer needs to unlock. `forceIdle` also clears the
//      watchdog that sweepStuckOnBoot may have re-armed a moment earlier
//      (sweepStuckOnBoot runs first in buildApp so this step correctly
//      supersedes it).
//   4. Notify any connected WS clients so they re-fetch the transcript tail.
//      In practice this is usually a no-op — boot happens before clients
//      reconnect — but it costs nothing and handles the rare race.
//   5. Delete the row.
//
// Extracted to its own module (rather than inlined in buildApp) so the
// test suite can drive it directly without going through the full app
// bootstrap, which is gated behind NODE_ENV !== "test" in buildApp.
// -----------------------------------------------------------------------------

type SweepLogger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
};

export async function resolvePendingRestartResults(
  db: Database.Database,
  manager: SessionManager,
  logger?: SweepLogger,
): Promise<void> {
  const store = new PendingRestartStore(db);
  const sessions = new SessionStore(db);

  const pruned = store.deleteStale();
  if (pruned > 0) {
    logger?.warn?.(
      { pruned },
      "restart-sweep: pruned stale pending_restart_results rows",
    );
  }

  const pending = store.listFresh();
  for (const row of pending) {
    try {
      const session = sessions.findById(row.session_id);
      if (!session) {
        store.deleteByToolUseId(row.tool_use_id);
        logger?.warn?.(
          { sessionId: row.session_id, toolUseId: row.tool_use_id },
          "restart-sweep: session not found, discarding pending row",
        );
        continue;
      }

      sessions.appendEvent({
        sessionId: row.session_id,
        kind: "tool_result",
        payload: {
          toolUseId: row.tool_use_id,
          content: "claudex restarted successfully.",
          isError: false,
        },
      });

      // forceIdle is a no-op if the session is already idle, so it's safe
      // to call unconditionally. It also broadcasts the status change.
      manager.forceIdle(row.session_id, "restart_pending_result_resolved");
      manager.notifyTranscriptRefresh(row.session_id);
      store.deleteByToolUseId(row.tool_use_id);

      logger?.info?.(
        { sessionId: row.session_id, toolUseId: row.tool_use_id },
        "restart-sweep: resolved pending restart result",
      );
    } catch (err) {
      logger?.warn?.(
        { err, sessionId: row.session_id, toolUseId: row.tool_use_id },
        "restart-sweep: failed to resolve pending restart result",
      );
    }
  }
}
