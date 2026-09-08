import type Database from "better-sqlite3";
import type {
  AuditEvent,
  BackupAttachmentMeta,
  BackupBundle,
  EventKind,
  ModelId,
  PermissionMode,
  Project,
  QueueStatus,
  QueuedPrompt,
  Routine,
  RoutineStatus,
  Session,
  SessionEvent,
  SessionStatus,
  ToolGrant,
  ToolGrantScope,
} from "@claudex/shared";

// -----------------------------------------------------------------------------
// Full-data export
//
// Builds a `BackupBundle` by walking the SQLite tables directly. We deliberately
// don't reuse the per-class stores (SessionStore, ProjectStore …) for two
// reasons:
//
//   1. Those stores hide filtering we'd rather not apply here — e.g.
//      SessionStore.list() suppresses side-chats and archived rows by default.
//      The backup wants every row.
//
//   2. The bundle is a flat wire format. Building it directly from rows keeps
//      the mapping obvious and lets us skip columns that aren't on the model
//      (e.g. attachments' `path` column isn't on the Attachment public shape
//      but we DO include it here for honest round-tripping).
//
// Secrets — password_hash, totp_secret, recovery codes, VAPID keys, JWT secret,
// push subscription keys — are NEVER selected. The `users` / `push_subscriptions`
// / `recovery_codes` / `auth`-adjacent tables simply don't participate in this
// export. That's a deliberate design choice: the bundle should be portable to
// another claudex install, not a credentials leak.
// -----------------------------------------------------------------------------

/**
 * Serialize the entire database into a `BackupBundle`. Audit rows are capped
 * at the last 1000 entries — the table grows unbounded over time and a full
 * dump would balloon bundle size for essentially no restore value.
 */
export function buildBackupBundle(
  db: Database.Database,
  opts: { claudexVersion: string },
): BackupBundle {
  return {
    claudexVersion: opts.claudexVersion,
    exportedAt: new Date().toISOString(),
    projects: selectProjects(db),
    sessions: selectSessions(db),
    events: selectEvents(db),
    routines: selectRoutines(db),
    queue: selectQueue(db),
    grants: selectGrants(db),
    attachments: selectAttachments(db),
    audit: selectAudit(db),
  };
}

function selectProjects(db: Database.Database): Project[] {
  const rows = db
    .prepare(
      `SELECT id, name, path, trusted, created_at FROM projects ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    path: string;
    trusted: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    path: r.path,
    trusted: r.trusted === 1,
    createdAt: r.created_at,
  }));
}

function selectSessions(db: Database.Database): Session[] {
  // Everything — archived, side-chats, the lot. A restore that silently drops
  // archived rows would be a lie.
  const rows = db
    .prepare(
      `SELECT * FROM sessions ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: string;
    title: string;
    project_id: string;
    branch: string | null;
    worktree_path: string | null;
    status: string;
    model: string;
    mode: string;
    effort: string | null;
    created_at: string;
    updated_at: string;
    last_message_at: string | null;
    archived_at: string | null;
    sdk_session_id: string | null;
    parent_session_id: string | null;
    forked_from_session_id: string | null;
    stats_messages: number;
    stats_files_changed: number;
    stats_lines_added: number;
    stats_lines_removed: number;
    stats_context_pct: number;
    cli_jsonl_seq: number;
    adopted_from_cli: number;
    tags: string;
    pinned: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    branch: r.branch,
    worktreePath: r.worktree_path,
    status: r.status as SessionStatus,
    model: r.model as ModelId,
    mode: r.mode as PermissionMode,
    // Pre-migration rows may predate the column; fall back to "medium"
    // (the SQL default) so older archives still deserialize.
    effort: (r.effort ?? "medium") as Session["effort"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at,
    archivedAt: r.archived_at,
    sdkSessionId: r.sdk_session_id,
    parentSessionId: r.parent_session_id,
    forkedFromSessionId: r.forked_from_session_id,
    cliJsonlSeq: r.cli_jsonl_seq ?? 0,
    adoptedFromCli: r.adopted_from_cli === 1,
    tags: parseTagsBlob(r.tags),
    pinned: r.pinned === 1,
    // Backups mirror persisted columns only. `lastUserMessage` is a
    // query-time projection computed from `session_events`, so on
    // restore the importing side will re-derive it the first time the
    // row is read through SessionStore. Emit null here to satisfy the
    // DTO schema without baking a stale preview into the archive.
    lastUserMessage: null,
    stats: {
      messages: r.stats_messages,
      filesChanged: r.stats_files_changed,
      linesAdded: r.stats_lines_added,
      linesRemoved: r.stats_lines_removed,
      contextPct: r.stats_context_pct,
    },
  }));
}

// Mirror of SessionStore's private parser. Duplicated (rather than exported)
// so the backup module doesn't reach into the store for a one-liner, and so
// the export path can't accidentally pick up unrelated store behavior later.
function parseTagsBlob(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Malformed / legacy rows fall through as empty.
  }
  return [];
}

function selectEvents(db: Database.Database): SessionEvent[] {
  // Order by (created_at, session_id, seq) so a blind replay on the import
  // side stays stable even across sessions. Payload parsed here; we already
  // trust the writer.
  const rows = db
    .prepare(
      `SELECT id, session_id, kind, seq, created_at, payload
         FROM session_events
         ORDER BY created_at ASC, session_id ASC, seq ASC`,
    )
    .all() as Array<{
    id: string;
    session_id: string;
    kind: string;
    seq: number;
    created_at: string;
    payload: string;
  }>;
  const out: SessionEvent[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      // A malformed payload shouldn't wedge the whole export — ship an empty
      // object and let the user notice downstream. Better than silently
      // dropping the row.
      payload = {};
    }
    out.push({
      id: r.id,
      sessionId: r.session_id,
      kind: r.kind as EventKind,
      seq: r.seq,
      createdAt: r.created_at,
      payload,
    });
  }
  return out;
}

function selectRoutines(db: Database.Database): Routine[] {
  const rows = db
    .prepare(`SELECT * FROM routines ORDER BY created_at ASC`)
    .all() as Array<{
    id: string;
    name: string;
    project_id: string;
    prompt: string;
    cron_expr: string;
    model: string;
    mode: string;
    status: string;
    last_run_at: string | null;
    next_run_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    projectId: r.project_id,
    prompt: r.prompt,
    cronExpr: r.cron_expr,
    model: r.model as ModelId,
    mode: r.mode as PermissionMode,
    status: r.status as RoutineStatus,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function selectQueue(db: Database.Database): QueuedPrompt[] {
  const rows = db
    .prepare(`SELECT * FROM queued_prompts ORDER BY seq ASC, created_at ASC`)
    .all() as Array<{
    id: string;
    project_id: string;
    prompt: string;
    title: string | null;
    model: string | null;
    mode: string | null;
    worktree: number;
    status: string;
    session_id: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    seq: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    prompt: r.prompt,
    title: r.title,
    model: (r.model ?? null) as ModelId | null,
    mode: (r.mode ?? null) as PermissionMode | null,
    worktree: r.worktree !== 0,
    status: r.status as QueueStatus,
    sessionId: r.session_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    seq: r.seq,
  }));
}

function selectGrants(db: Database.Database): ToolGrant[] {
  // Join session titles so the import side can carry them through honestly
  // (if it decides to import grants at all — today we skip, see import.ts).
  const rows = db
    .prepare(
      `SELECT g.id, g.session_id, g.tool_name, g.input_signature, g.created_at,
              s.title AS session_title
         FROM tool_grants g
         LEFT JOIN sessions s ON s.id = g.session_id
         ORDER BY g.created_at ASC`,
    )
    .all() as Array<{
    id: string;
    session_id: string | null;
    tool_name: string;
    input_signature: string;
    created_at: string;
    session_title: string | null;
  }>;
  return rows.map((r) => {
    const scope: ToolGrantScope = r.session_id == null ? "global" : "session";
    const out: ToolGrant = {
      id: r.id,
      toolName: r.tool_name,
      signature: r.input_signature,
      scope,
      createdAt: r.created_at,
    };
    if (r.session_id != null) out.sessionId = r.session_id;
    if (r.session_title != null) out.sessionTitle = r.session_title;
    return out;
  });
}

function selectAttachments(db: Database.Database): BackupAttachmentMeta[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, message_event_seq, filename, mime, size_bytes,
              path, created_at
         FROM attachments
         ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: string;
    session_id: string;
    message_event_seq: number | null;
    filename: string;
    mime: string;
    size_bytes: number;
    path: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    messageEventSeq: r.message_event_seq,
    filename: r.filename,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    path: r.path,
    createdAt: r.created_at,
  }));
}

function selectAudit(db: Database.Database): AuditEvent[] {
  // Cap at the 1000 most-recent rows: the audit table can grow without bound
  // across the lifetime of an install, and a restore cares most about
  // "recent security state" rather than the full archaeology.
  const rows = db
    .prepare(
      `SELECT id, user_id, event, target, detail, ip, user_agent, created_at
         FROM audit_events
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1000`,
    )
    .all() as Array<{
    id: string;
    user_id: string | null;
    event: string;
    target: string | null;
    detail: string | null;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
  }>;
  // The wire shape expects a joined `user` field; we surface it as null here
  // (no user table dump in the bundle) and the import route writes the rows
  // without a user_id anyway to avoid dangling FKs.
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    target: r.target,
    detail: r.detail,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    user: null,
  }));
}
