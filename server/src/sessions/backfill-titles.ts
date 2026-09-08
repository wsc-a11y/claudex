import type { SessionStore } from "./store.js";
import { __testables } from "./manager.js";

const { shouldAutoRetitle, deriveTitleFromMessage } = __testables;

/**
 * One-shot boot pass: retitle historical top-level sessions whose current
 * title still looks like a placeholder (empty / "Untitled" / ≤3 words) by
 * deriving a title from their first persisted `user_message` event.
 *
 * Rationale: auto-title only fires on the very first `sendUserMessage` call
 * of a brand-new session. Any session that predates that code — or was
 * created with a placeholder title and has already received messages — never
 * gets retitled. A synchronous backfill at server start keeps those rows
 * from being stuck as "Untitled" forever.
 *
 * Scope:
 *   - Only non-archived, top-level (parent_session_id IS NULL) sessions.
 *     Side chats have a deliberate "Side chat" title from routes.ts.
 *   - Only sessions where `shouldAutoRetitle(title)` is true — anything with
 *     4+ words in its title is treated as user-chosen and left alone.
 *
 * Reads a single `user_message` event per session (the first one) via
 * `listEvents` + linear filter — SessionStore has no index-by-kind API and
 * we don't need one for a few hundred sessions at boot.
 */
export function backfillSessionTitles(deps: {
  sessions: SessionStore;
}): { scanned: number; retitled: number } {
  const { sessions } = deps;
  const candidates = sessions.list({ includeArchived: false });
  let scanned = 0;
  let retitled = 0;

  for (const session of candidates) {
    if (session.parentSessionId !== null) continue;
    if (!shouldAutoRetitle(session.title)) continue;
    scanned += 1;

    const events = sessions.listEvents(session.id);
    const firstUserMessage = events.find((e) => e.kind === "user_message");
    if (!firstUserMessage) continue;

    const content = (firstUserMessage.payload as Record<string, unknown>).text;
    if (typeof content !== "string") continue;

    const newTitle = deriveTitleFromMessage(content);
    if (newTitle.length === 0) continue;

    sessions.setTitle(session.id, newTitle);
    retitled += 1;
  }

  return { scanned, retitled };
}
