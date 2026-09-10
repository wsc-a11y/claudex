import fs from "node:fs";
import path from "node:path";
import type { SessionStore } from "./store.js";
import type { ProjectStore } from "./projects.js";
import {
  defaultCliProjectsRoot,
  encodeCwdToSlug,
  readCliSessionTitle,
  truncateTitle,
} from "./cli-discovery.js";

/**
 * One-shot boot pass: re-derive titles for CLI-adopted sessions from the
 * CLI's own title records.
 *
 * Why this exists: before this change claudex titled every adopted session
 * from its first user message. That diverged from what the `claude` VS Code
 * extension shows for the same session, because the CLI writes its own
 * `ai-title` / `custom-title` / `last-prompt` records and the extension
 * prefers those. `readCliSessionTitle` now mirrors the extension's
 * precedence, but sessions adopted before the fix already have the old
 * title baked into the `sessions.title` column — nothing re-reads the JSONL
 * for them, so they'd stay wrong forever.
 *
 * Only rewrites rows still carrying the OLD derived value. We recompute what
 * the previous algorithm would have produced (the truncated first user
 * message, or the "Untitled CLI session" placeholder) and require an exact
 * match before touching the column — so a title the user renamed by hand in
 * claudex is never clobbered. That check also makes this idempotent: after
 * one pass the stored title is the new one and no longer matches the old
 * derivation.
 *
 * Scope: `adopted_from_cli = 1` only (`adoptedFromCli` is the sole gate —
 * native claudex sessions have no CLI JSONL and keep first-message titles by
 * design). Archived sessions are included: they still display a title.
 */
export async function backfillCliSessionTitles(deps: {
  sessions: SessionStore;
  projects: ProjectStore;
  cliProjectsRoot?: string;
  logger?: { debug?: (obj: unknown, msg?: string) => void };
}): Promise<{ scanned: number; retitled: number }> {
  const { sessions, projects } = deps;
  const root = deps.cliProjectsRoot ?? defaultCliProjectsRoot();
  let scanned = 0;
  let retitled = 0;

  const candidates = sessions.list({ includeArchived: true });
  for (const session of candidates) {
    if (session.adoptedFromCli !== true) continue;
    const sdkId = session.sdkSessionId;
    if (!sdkId) continue;
    scanned += 1;

    // Reconstruct the pre-fix derivation. If the stored title isn't that,
    // assume it was chosen deliberately and leave it alone.
    const firstUserMessage = sessions.listUserMessages(session.id)[0];
    const oldTitle = firstUserMessage
      ? truncateTitle(firstUserMessage.text, 60)
      : "Untitled CLI session";
    if (session.title !== oldTitle) continue;

    const project = projects.findById(session.projectId);
    if (!project) continue;
    const jsonlPath = path.join(
      root,
      encodeCwdToSlug(project.path),
      `${sdkId}.jsonl`,
    );
    if (!fs.existsSync(jsonlPath)) {
      deps.logger?.debug?.(
        { sessionId: session.id, jsonlPath },
        "cli title backfill: transcript not found, skipping",
      );
      continue;
    }

    let title: string;
    try {
      title = await readCliSessionTitle(jsonlPath);
    } catch (err) {
      deps.logger?.debug?.(
        { err, sessionId: session.id },
        "cli title backfill: failed to read transcript, skipping",
      );
      continue;
    }
    if (title.length === 0 || title === session.title) continue;

    sessions.setTitle(session.id, title);
    retitled += 1;
  }

  return { scanned, retitled };
}
