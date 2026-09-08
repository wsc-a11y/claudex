import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { Project } from "@claudex/shared";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  trusted: number;
  created_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    trusted: row.trusted === 1,
    createdAt: row.created_at,
  };
}

export class ProjectStore {
  constructor(private readonly db: Database.Database) {}

  list(): Project[] {
    return (
      this.db
        .prepare("SELECT * FROM projects ORDER BY created_at DESC")
        .all() as ProjectRow[]
    ).map(toProject);
  }

  findById(id: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  findByPath(absPath: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE path = ?")
      .get(absPath) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  /**
   * Return the existing project for `absPath` or create one with the given
   * name + `trusted: true`. Used by the CLI-session import path to anchor
   * adopted sessions against the cwd they were recorded under without
   * duplicating a project row the user may have added manually.
   */
  upsertByPath(input: { name: string; path: string }): Project {
    const existing = this.findByPath(input.path);
    if (existing) return existing;
    return this.create({
      name: input.name,
      path: input.path,
      trusted: true,
    });
  }

  create(input: {
    name: string;
    path: string;
    /**
     * Defaults to `false`. Projects created through the HTTP surface arrive
     * untrusted — the UI's "Trust this folder?" confirm step flips the bit
     * via `POST /api/projects/:id/trust` before the first session can spawn.
     * The CLI-import path (`upsertByPath`) opts into `true` because the user
     * is already operating in that cwd.
     */
    trusted?: boolean;
  }): Project {
    const trusted = input.trusted === true;
    const row: ProjectRow = {
      id: nanoid(12),
      name: input.name,
      path: input.path,
      trusted: trusted ? 1 : 0,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, trusted, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.name, row.path, row.trusted, row.created_at);
    return toProject(row);
  }

  setTrusted(id: string, trusted: boolean): void {
    this.db
      .prepare("UPDATE projects SET trusted = ? WHERE id = ?")
      .run(trusted ? 1 : 0, id);
  }

  setName(id: string, name: string): void {
    this.db
      .prepare("UPDATE projects SET name = ? WHERE id = ?")
      .run(name, id);
  }

  /**
   * Count sessions that reference this project. Used to decide whether a
   * delete would trip the FK RESTRICT. Includes archived sessions.
   */
  countSessions(id: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?")
      .get(id) as { n: number };
    return row.n;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  /**
   * Bulk-remove every project that has zero sessions. Returns the deleted
   * rows in their pre-delete shape so the caller can report names back to
   * the UI. Wrapped in a single transaction so concurrent session inserts
   * either land before the cleanup (project survives) or after (project is
   * gone, FK is gone with it) — never in between.
   */
  cleanupEmpty(): Project[] {
    const fn = this.db.transaction((): Project[] => {
      const rows = this.db
        .prepare(
          `SELECT p.* FROM projects p
           WHERE NOT EXISTS (
             SELECT 1 FROM sessions s WHERE s.project_id = p.id
           )`,
        )
        .all() as ProjectRow[];
      if (rows.length === 0) return [];
      const stmt = this.db.prepare("DELETE FROM projects WHERE id = ?");
      for (const row of rows) stmt.run(row.id);
      return rows.map(toProject);
    });
    return fn();
  }
}
