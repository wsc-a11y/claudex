import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import { nanoid } from "nanoid";

// -----------------------------------------------------------------------------
// AttachmentStore
//
// CRUD around the `attachments` table. Two-phase lifecycle:
//   - `insertUnlinked` lands a row with `message_event_seq = NULL` when the
//     user uploads a file via POST /api/sessions/:id/attachments
//   - `linkToMessage` stamps the seq once the user sends the message
//   - `deleteUnlinked` removes a still-unlinked row (user changed their mind);
//     linked rows stay — once the message is out, the attachment is history
//
// The raw file bytes live on disk; this store only tracks metadata + path.
// -----------------------------------------------------------------------------

export interface AttachmentRow {
  id: string;
  sessionId: string;
  messageEventSeq: number | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  path: string;
  createdAt: string;
}

interface DbRow {
  id: string;
  session_id: string;
  message_event_seq: number | null;
  filename: string;
  mime: string;
  size_bytes: number;
  path: string;
  created_at: string;
}

function toRow(r: DbRow): AttachmentRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    messageEventSeq: r.message_event_seq,
    filename: r.filename,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    path: r.path,
    createdAt: r.created_at,
  };
}

export class AttachmentStore {
  // Prepared-statement cache. `findManyForSession` is intentionally absent —
  // its SQL interpolates a variable-length `IN (?, ?, ...)` list so we can't
  // cache a single statement.
  private readonly stmts: {
    insertUnlinked: Statement | null;
    findById: Statement | null;
    linkOne: Statement | null;
    deleteById: Statement | null;
  } = {
    insertUnlinked: null,
    findById: null,
    linkOne: null,
    deleteById: null,
  };

  constructor(private readonly db: Database.Database) {}

  private lazyStmt<K extends keyof AttachmentStore["stmts"]>(
    key: K,
    sql: string,
  ): Statement {
    return (this.stmts[key] ??= this.db.prepare(sql));
  }

  insertUnlinked(input: {
    sessionId: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    path: string;
  }): AttachmentRow {
    const id = nanoid(12);
    const createdAt = new Date().toISOString();
    this.lazyStmt(
      "insertUnlinked",
      `INSERT INTO attachments
         (id, session_id, message_event_seq, filename, mime, size_bytes, path, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.filename,
      input.mime,
      input.sizeBytes,
      input.path,
      createdAt,
    );
    return {
      id,
      sessionId: input.sessionId,
      messageEventSeq: null,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      path: input.path,
      createdAt,
    };
  }

  findById(id: string): AttachmentRow | null {
    const row = this.lazyStmt(
      "findById",
      "SELECT * FROM attachments WHERE id = ?",
    ).get(id) as DbRow | undefined;
    return row ? toRow(row) : null;
  }

  /**
   * Look up a set of attachments belonging to a specific session. Rows from
   * other sessions are silently dropped — that's a permission boundary, not a
   * bug to surface.
   */
  findManyForSession(sessionId: string, ids: string[]): AttachmentRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM attachments
         WHERE session_id = ? AND id IN (${placeholders})`,
      )
      .all(sessionId, ...ids) as DbRow[];
    return rows.map(toRow);
  }

  /** Stamp a batch of attachment rows with the user_message event seq. */
  linkToMessage(ids: string[], messageEventSeq: number): void {
    if (ids.length === 0) return;
    const stmt = this.lazyStmt(
      "linkOne",
      `UPDATE attachments SET message_event_seq = ? WHERE id = ? AND message_event_seq IS NULL`,
    );
    const tx = this.db.transaction((batch: string[]) => {
      for (const id of batch) stmt.run(messageEventSeq, id);
    });
    tx(ids);
  }

  /**
   * Delete an attachment only if it hasn't been linked to a message yet.
   * Returns the row that was removed so the caller can rm the file from disk;
   * null if no match (unknown id, or already linked).
   */
  deleteUnlinked(id: string): AttachmentRow | null {
    const existing = this.findById(id);
    if (!existing) return null;
    if (existing.messageEventSeq !== null) return null;
    this.lazyStmt(
      "deleteById",
      "DELETE FROM attachments WHERE id = ?",
    ).run(id);
    return existing;
  }
}
