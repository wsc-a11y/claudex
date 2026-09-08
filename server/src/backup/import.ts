import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import {
  BackupAttachmentMeta,
  type BackupBundle,
  type ImportAllResponse,
  Project,
  QueuedPrompt,
  Routine,
  Session,
  SessionEvent,
  ToolGrant,
} from "@claudex/shared";
import type { ZodType } from "zod";
import { SearchStore } from "../search/store.js";

// -----------------------------------------------------------------------------
// Full-data import
//
// Strategy is **merge, don't replace**:
//
//   - Projects: dedupe on `path`. A local row with the same absolute path
//     already represents "this folder on this machine"; trust the local one
//     and map the incoming id → local id so sessions/routines/queue that
//     reference the imported project still land correctly.
//
//   - Sessions: always inserted as new rows under a freshly-minted id. We
//     DO skip rows whose `sdkSessionId` already exists locally — that'd cause
//     the resume path to double-adopt the same CLI conversation and thrash
//     transcripts. The map old→new id drives child-row remapping for events,
//     parent_session_id links (side chats), queue sessionId pointers.
//
//   - Events: rebuilt seq 1..N per-session from the bundle order. We do NOT
//     preserve the bundle's original seqs because the import may collide
//     with rows already present (the bundle is merged into a potentially
//     non-empty DB). A stable per-session renumber keeps the appendEvent
//     contract (nextSeq = MAX+1) working after import.
//
//   - Routines / queue: same project-id remap; skip rows whose project can't
//     be resolved (the bundle could carry a routine whose project wasn't
//     part of the export somehow — rare but worth defending against).
//
//   - Grants: SKIPPED. Grants authorize a specific tool-use signature against
//     a specific session id in a specific security context. Carrying them
//     across installs feels like silently expanding the new install's trust
//     surface — we'd rather the user re-authorize explicitly. Count returned
//     in `skipped.grants` so the UI can surface the decision.
//
//   - Attachments (meta only): SKIPPED. The bundle has no file bytes, and an
//     attachment row that points at `/path/that/does/not/exist` serves no
//     purpose. Counted in `skipped.attachments`.
//
//   - Push subscriptions / users / recovery codes / VAPID / JWT: never
//     appeared in the bundle in the first place. See export.ts — those
//     tables are intentionally omitted.
//
//   - Audit: SKIPPED. The bundle supplies attacker-chosen `event`/`ip`/
//     `user_agent` strings, so importing them would let a malicious bundle
//     forge `login` / `import.success` entries into the local Security
//     card. Count returned under `skipped.audit` so the UI can explain why
//     the timeline didn't grow.
//
// Everything runs inside a single `db.transaction(...)` — on SQL error, the
// whole import rolls back. The route layer caps the wall-clock of the whole
// operation too.
// -----------------------------------------------------------------------------

export interface ImportResult extends ImportAllResponse {}

/**
 * Narrow the incoming JSON to a `BackupBundle` as best we can without full
 * zod parsing (that would reject any extra/future field and make the
 * operation brittle across versions). We per-item validate each array with
 * the row's zod schema — invalid rows are dropped silently, and we log a
 * `warn` when any array lost more than 5% of its entries (likely a corrupt
 * or cross-version bundle). Missing optional fields default to `[]`.
 */
export function coerceBundle(raw: unknown): BackupBundle {
  if (raw == null || typeof raw !== "object") {
    throw new Error("bundle_not_object");
  }
  const obj = raw as Record<string, unknown>;
  const ver = typeof obj.claudexVersion === "string" ? obj.claudexVersion : "";
  const exportedAt =
    typeof obj.exportedAt === "string" ? obj.exportedAt : new Date().toISOString();

  // Per-item parse: keep rows that validate, drop the rest. Returning the
  // count of dropped rows lets us emit a single-line warn per array when
  // the loss rate crosses 5% — enough signal to catch a bad bundle without
  // spamming for every corrupt row.
  const parseArray = <T>(
    name: string,
    schema: ZodType<T>,
    v: unknown,
  ): T[] => {
    if (!Array.isArray(v)) return [];
    const kept: T[] = [];
    let dropped = 0;
    for (const item of v) {
      const res = schema.safeParse(item);
      if (res.success) kept.push(res.data);
      else dropped += 1;
    }
    if (dropped > 0) {
      const total = v.length;
      // >5% loss on a non-trivial array is the sniff test for "this bundle
      // came from a different major version / was hand-edited / is corrupt".
      // We log through console.warn rather than pino because coerceBundle
      // runs outside any request context; routes.ts logs its own line when
      // the whole import later succeeds or fails.
      if (total > 0 && dropped / total > 0.05) {
        console.warn(
          `[backup/import] ${name}: dropped ${dropped}/${total} invalid entries during coerceBundle`,
        );
      }
    }
    return kept;
  };

  return {
    claudexVersion: ver,
    exportedAt,
    projects: parseArray("projects", Project, obj.projects),
    sessions: parseArray("sessions", Session, obj.sessions),
    events: parseArray("events", SessionEvent, obj.events),
    routines: parseArray("routines", Routine, obj.routines),
    queue: parseArray("queue", QueuedPrompt, obj.queue),
    // ToolGrant rows are already skipped on import by policy, but we still
    // shape-check here so the `counts.skipped.grants` tally reflects a real
    // count of well-formed grant rows rather than whatever garbage the
    // bundle shipped.
    grants: parseArray("grants", ToolGrant, obj.grants),
    attachments: parseArray(
      "attachments",
      BackupAttachmentMeta,
      obj.attachments,
    ),
    audit: Array.isArray(obj.audit) ? (obj.audit as BackupBundle["audit"]) : undefined,
  };
}

export function importBackupBundle(
  db: Database.Database,
  bundle: BackupBundle,
  opts: { claudexVersion: string },
): ImportResult {
  const versionMismatch =
    bundle.claudexVersion.length > 0 &&
    bundle.claudexVersion !== opts.claudexVersion;

  // Accumulators live outside the transaction so we can return them even if
  // a later block is empty. The transaction wraps every write below.
  const counts = {
    imported: {
      projects: 0,
      sessions: 0,
      events: 0,
      routines: 0,
      queue: 0,
      audit: 0,
    },
    skipped: {
      projectsByPath: 0,
      sessionsBySdkId: 0,
      routinesMissingProject: 0,
      queueMissingProject: 0,
      grants: bundle.grants.length,
      attachments: bundle.attachments.length,
      // Audit rows are never imported from a bundle: the bundle controls
      // `event`/`ip`/`user_agent`, so honoring them would let an attacker
      // forge "login" / "import.success" entries into the local Security
      // card. Count is surfaced so the user can see the cap applied.
      audit: bundle.audit
        ? {
            count: bundle.audit.length,
            reason: "audit rows never imported from untrusted bundles",
          }
        : undefined,
    },
    versionMismatch,
  };

  const tx = db.transaction(() => {
    // FTS mirror — kept in sync inline with every session/event insert below
    // so search hits imported content immediately. SessionStore does this on
    // the live path via SearchStore.indexMessage / upsertTitle; imports
    // bypass the store to get renumbered seqs + preserved timestamps, so we
    // call the same helpers by hand here.
    const search = new SearchStore(db);
    // --- projects -------------------------------------------------------
    //
    // Local row with the same `path` wins; we only remember its id to remap
    // children. New rows are inserted verbatim (id preserved) so that any
    // client-side bookmarks to /sessions?projectId=... remain stable after a
    // self-round-trip on the same machine.
    const projectIdMap = new Map<string, string>();
    const findProjectByPath = db.prepare(
      "SELECT id FROM projects WHERE path = ?",
    );
    const findProjectById = db.prepare(
      "SELECT id FROM projects WHERE id = ?",
    );
    const insertProject = db.prepare(
      `INSERT INTO projects (id, name, path, trusted, created_at)
       VALUES (@id, @name, @path, @trusted, @created_at)`,
    );
    for (const p of bundle.projects) {
      const hit = findProjectByPath.get(p.path) as { id: string } | undefined;
      if (hit) {
        projectIdMap.set(p.id, hit.id);
        counts.skipped.projectsByPath += 1;
        continue;
      }
      // Collision on id (path differs but id already taken) — mint fresh.
      const targetId =
        (findProjectById.get(p.id) as { id: string } | undefined) != null
          ? nanoid(12)
          : p.id;
      insertProject.run({
        id: targetId,
        name: p.name,
        path: p.path,
        trusted: p.trusted ? 1 : 0,
        created_at: p.createdAt,
      });
      projectIdMap.set(p.id, targetId);
      counts.imported.projects += 1;
    }

    // --- sessions -------------------------------------------------------
    //
    // Every session gets a fresh id — even on a single-machine round-trip we
    // don't want to shadow rows the user has since created. `parent_session_id`
    // is remapped via the same session-id map; if the parent wasn't in the
    // bundle (or was skipped), we drop the link rather than RESTRICT at FK.
    const sessionIdMap = new Map<string, string>();
    const findBySdk = db.prepare(
      "SELECT id FROM sessions WHERE sdk_session_id = ?",
    );
    const insertSession = db.prepare(
      `INSERT INTO sessions (
         id, title, project_id, branch, worktree_path, status, model, mode,
         effort,
         created_at, updated_at, last_message_at, archived_at, sdk_session_id,
         parent_session_id, forked_from_session_id,
         stats_messages, stats_files_changed, stats_lines_added,
         stats_lines_removed, stats_context_pct,
         cli_jsonl_seq, adopted_from_cli, tags
       ) VALUES (
         @id, @title, @project_id, @branch, @worktree_path, @status, @model, @mode,
         @effort,
         @created_at, @updated_at, @last_message_at, @archived_at, @sdk_session_id,
         @parent_session_id, @forked_from_session_id,
         @stats_messages, @stats_files_changed, @stats_lines_added,
         @stats_lines_removed, @stats_context_pct,
         @cli_jsonl_seq, @adopted_from_cli, @tags
       )`,
    );
    // Pass 1: insert rows with parent_session_id = NULL so we don't care
    // whether the parent has been inserted yet.
    for (const s of bundle.sessions) {
      if (s.sdkSessionId) {
        const already = findBySdk.get(s.sdkSessionId) as
          | { id: string }
          | undefined;
        if (already) {
          sessionIdMap.set(s.id, already.id);
          counts.skipped.sessionsBySdkId += 1;
          continue;
        }
      }
      const projectId = projectIdMap.get(s.projectId);
      if (!projectId) {
        // Session references a project the bundle didn't carry — skip quietly,
        // rolling up into "project missing" isn't worth a separate counter.
        continue;
      }
      const newId = nanoid(12);
      sessionIdMap.set(s.id, newId);
      insertSession.run({
        id: newId,
        title: s.title,
        project_id: projectId,
        branch: s.branch,
        worktree_path: s.worktreePath,
        status: s.status === "archived" ? "archived" : "idle", // never resurrect running/awaiting
        model: s.model,
        mode: s.mode,
        // `effort` was added by migration 23. Legacy bundles (pre-migration)
        // don't carry it; the column is NOT NULL with DEFAULT 'medium' at
        // the SQL layer, but we still pass an explicit value so the named
        // parameter binding is complete.
        effort: s.effort ?? "medium",
        created_at: s.createdAt,
        updated_at: s.updatedAt,
        last_message_at: s.lastMessageAt,
        archived_at: s.archivedAt,
        sdk_session_id: s.sdkSessionId,
        parent_session_id: null, // patched in pass 2
        // forked_from_session_id intentionally stays null on import: the
        // source session id in the bundle belongs to the exporting machine's
        // id space and isn't remapped here. The fork is still a valid
        // standalone row; the "Forked" badge just won't render.
        forked_from_session_id: null,
        stats_messages: s.stats.messages,
        stats_files_changed: s.stats.filesChanged,
        stats_lines_added: s.stats.linesAdded,
        stats_lines_removed: s.stats.linesRemoved,
        stats_context_pct: s.stats.contextPct,
        cli_jsonl_seq: s.cliJsonlSeq ?? 0,
        // Preserve the CLI-adoption flag across backup round-trips. Defaults
        // to 0 when the bundle predates the column so restored native
        // sessions stay native (the safe side — worst case the user re-
        // adopts via Import sheet if a CLI row got lost).
        adopted_from_cli: s.adoptedFromCli === true ? 1 : 0,
        // Tags ride along with the bundle verbatim — they're user-authored
        // and the schema is locked down at the HTTP surface, so round-trips
        // are safe. Fallback to `[]` when the bundle predates the column.
        tags: JSON.stringify(
          Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === "string") : [],
        ),
      });
      // Mirror SessionStore.create: a session's title participates in title
      // search from the moment it exists on disk.
      search.upsertTitle(newId, s.title ?? "");
      counts.imported.sessions += 1;
    }
    // Pass 2: patch parent_session_id now that every session has a local id.
    const patchParent = db.prepare(
      "UPDATE sessions SET parent_session_id = ? WHERE id = ?",
    );
    for (const s of bundle.sessions) {
      if (!s.parentSessionId) continue;
      const localId = sessionIdMap.get(s.id);
      const localParent = sessionIdMap.get(s.parentSessionId);
      if (!localId || !localParent) continue;
      patchParent.run(localParent, localId);
    }

    // --- events ---------------------------------------------------------
    //
    // Rebuild seq 1..N per session in the bundle's provided order (the export
    // sorts by created_at ASC, which preserves causality). Fresh event ids;
    // the original ones aren't useful and could collide with future inserts.
    const eventsBySession = new Map<string, SessionEvent[]>();
    for (const e of bundle.events) {
      const list = eventsBySession.get(e.sessionId);
      if (list) list.push(e);
      else eventsBySession.set(e.sessionId, [e]);
    }
    const insertEvent = db.prepare(
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [oldSessionId, evs] of eventsBySession) {
      const newSessionId = sessionIdMap.get(oldSessionId);
      if (!newSessionId) continue;
      // The export guarantees ASC by created_at but tests may feed arbitrary
      // bundles — sort defensively so seq rewriting stays meaningful.
      evs.sort((a, b) => {
        if (a.createdAt === b.createdAt) return a.seq - b.seq;
        return a.createdAt < b.createdAt ? -1 : 1;
      });
      let seq = 1;
      for (const e of evs) {
        insertEvent.run(
          nanoid(16),
          newSessionId,
          e.kind,
          seq,
          e.createdAt,
          JSON.stringify(e.payload ?? {}),
        );
        // Mirror SessionStore.appendEvent: text-bearing events participate
        // in global search. No-op for non-text kinds / empty payload.
        search.indexMessage({
          sessionId: newSessionId,
          seq,
          kind: e.kind,
          payload: e.payload as Record<string, unknown> | null | undefined,
        });
        seq += 1;
        counts.imported.events += 1;
      }
    }

    // --- routines -------------------------------------------------------
    const insertRoutine = db.prepare(
      `INSERT INTO routines (
         id, name, project_id, prompt, cron_expr, model, mode, status,
         last_run_at, next_run_at, created_at, updated_at
       ) VALUES (
         @id, @name, @project_id, @prompt, @cron_expr, @model, @mode, @status,
         @last_run_at, @next_run_at, @created_at, @updated_at
       )`,
    );
    const findRoutineById = db.prepare("SELECT id FROM routines WHERE id = ?");
    for (const r of bundle.routines) {
      const projectId = projectIdMap.get(r.projectId);
      if (!projectId) {
        counts.skipped.routinesMissingProject += 1;
        continue;
      }
      const targetId =
        (findRoutineById.get(r.id) as { id: string } | undefined) != null
          ? nanoid(12)
          : r.id;
      insertRoutine.run({
        id: targetId,
        name: r.name,
        project_id: projectId,
        prompt: r.prompt,
        cron_expr: r.cronExpr,
        model: r.model,
        mode: r.mode,
        // Incoming `active` routines are imported as paused so they don't
        // immediately fire on the new install without the user's blessing.
        status: r.status === "active" ? "paused" : r.status,
        last_run_at: r.lastRunAt,
        next_run_at: null,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      });
      counts.imported.routines += 1;
    }

    // --- queue ----------------------------------------------------------
    //
    // Re-seq inside the queued set so the rows land at the tail of whatever
    // the local queue already has. Running/done rows preserve their bundle
    // seq — they're historical records at this point.
    const maxSeqRow = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM queued_prompts")
      .get() as { m: number };
    let nextQueueSeq = maxSeqRow.m + 1;
    const insertQueue = db.prepare(
      `INSERT INTO queued_prompts (
         id, project_id, prompt, title, model, mode, worktree, status,
         session_id, created_at, started_at, finished_at, seq
       ) VALUES (
         @id, @project_id, @prompt, @title, @model, @mode, @worktree, @status,
         @session_id, @created_at, @started_at, @finished_at, @seq
       )`,
    );
    const findQueueById = db.prepare(
      "SELECT id FROM queued_prompts WHERE id = ?",
    );
    for (const q of bundle.queue) {
      const projectId = projectIdMap.get(q.projectId);
      if (!projectId) {
        counts.skipped.queueMissingProject += 1;
        continue;
      }
      const targetId =
        (findQueueById.get(q.id) as { id: string } | undefined) != null
          ? nanoid(12)
          : q.id;
      // Re-point sessionId through the remap table, drop the link if the
      // referenced session wasn't part of the bundle / was skipped.
      const mappedSession = q.sessionId ? sessionIdMap.get(q.sessionId) ?? null : null;
      // Mirror the session policy: queued/running rows get reset to queued.
      // Anything already terminal stays terminal.
      const status: QueuedPrompt["status"] =
        q.status === "running" ? "queued" : q.status;
      insertQueue.run({
        id: targetId,
        project_id: projectId,
        prompt: q.prompt,
        title: q.title,
        model: q.model,
        mode: q.mode,
        worktree: q.worktree ? 1 : 0,
        status,
        session_id: mappedSession,
        created_at: q.createdAt,
        started_at: q.startedAt,
        finished_at: q.finishedAt,
        seq: status === "queued" ? nextQueueSeq++ : q.seq,
      });
      counts.imported.queue += 1;
    }

    // --- audit ----------------------------------------------------------
    //
    // SKIPPED entirely. The bundle carries attacker-chosen `event`, `ip`,
    // and `user_agent` strings; importing them would let a malicious bundle
    // inject fake `login`, `import.success`, or `export.all` rows into the
    // local Security card. We always drop them and surface the count in
    // `skipped.audit` so the user can see why the import didn't replay
    // their own prior history.
    // (Previously imported with fresh ids + NULL user_id; pulled because
    //  the provenance guarantee isn't worth the trust expansion.)
  });

  tx();
  return counts;
}
