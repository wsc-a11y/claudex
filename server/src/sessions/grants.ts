import type Database from "better-sqlite3";
import { nanoid } from "nanoid";

/**
 * Signature conventions (how we fingerprint a tool call for reuse):
 *   Bash       → the literal command (after trim)
 *   Edit/Write → `${file_path}`
 *   Read       → `${file_path}`
 *   Glob/Grep  → the pattern/regex
 *   everything else → the tool name alone (grant a whole tool)
 *
 * Keep this file the single source of truth — tests and manager both import
 * it so we don't drift.
 */
export function signatureFor(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Bash":
      return String((input.command as string | undefined) ?? "").trim();
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
    case "Read":
      return String((input.file_path as string | undefined) ?? "");
    case "Glob":
      return String((input.pattern as string | undefined) ?? "");
    case "Grep":
      return String((input.pattern as string | undefined) ?? "");
    default:
      return "";
  }
}

interface GrantRow {
  id: string;
  session_id: string | null;
  tool_name: string;
  input_signature: string;
  created_at: string;
}

export type ToolGrantRow = GrantRow;

export class ToolGrantStore {
  constructor(private readonly db: Database.Database) {}

  /** Has the user granted this tool+signature for this session (or globally)? */
  has(sessionId: string, toolName: string, signature: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM tool_grants
         WHERE tool_name = ?
           AND input_signature = ?
           AND (session_id IS NULL OR session_id = ?)
         LIMIT 1`,
      )
      .get(toolName, signature, sessionId) as unknown;
    return row != null;
  }

  findById(id: string): GrantRow | null {
    const row = this.db
      .prepare("SELECT * FROM tool_grants WHERE id = ?")
      .get(id) as GrantRow | undefined;
    return row ?? null;
  }

  addSessionGrant(
    sessionId: string,
    toolName: string,
    signature: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tool_grants
           (id, session_id, tool_name, input_signature, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        nanoid(12),
        sessionId,
        toolName,
        signature,
        new Date().toISOString(),
      );
  }

  addGlobalGrant(toolName: string, signature: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tool_grants
           (id, session_id, tool_name, input_signature, created_at)
         VALUES (?, NULL, ?, ?, ?)`,
      )
      .run(nanoid(12), toolName, signature, new Date().toISOString());
  }

  listForSession(sessionId: string): GrantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tool_grants
         WHERE session_id = ? OR session_id IS NULL
         ORDER BY created_at DESC`,
      )
      .all(sessionId) as GrantRow[];
  }

  /**
   * Every grant on the machine, joined with the owning session's title when
   * the row is session-scoped. Used by Settings → Security's Granted-tools
   * card so the user can review and revoke grants without first drilling
   * into each session. Global rows sort first (they apply everywhere and
   * are the most consequential to revoke), then session rows, each group
   * sorted by `created_at DESC`.
   */
  listAllGrants(): Array<GrantRow & { session_title: string | null }> {
    return this.db
      .prepare(
        `SELECT g.*, s.title AS session_title
         FROM tool_grants g
         LEFT JOIN sessions s ON s.id = g.session_id
         ORDER BY
           CASE WHEN g.session_id IS NULL THEN 0 ELSE 1 END ASC,
           g.created_at DESC`,
      )
      .all() as Array<GrantRow & { session_title: string | null }>;
  }

  revoke(id: string): void {
    this.db.prepare("DELETE FROM tool_grants WHERE id = ?").run(id);
  }
}
