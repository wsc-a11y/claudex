import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  ModelId,
  PermissionMode,
  Routine,
  RoutineStatus,
} from "@claudex/shared";

interface RoutineRow {
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
}

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    prompt: row.prompt,
    cronExpr: row.cron_expr,
    model: row.model as ModelId,
    mode: row.mode as PermissionMode,
    status: row.status as RoutineStatus,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RoutineCreateInput {
  id?: string;
  name: string;
  projectId: string;
  prompt: string;
  cronExpr: string;
  model: ModelId;
  mode: PermissionMode;
  nextRunAt?: string | null;
}

export interface RoutineUpdateInput {
  name?: string;
  prompt?: string;
  cronExpr?: string;
  model?: ModelId;
  mode?: PermissionMode;
  status?: RoutineStatus;
}

/**
 * CRUD for the `routines` table. Keeps SQL in one place so the scheduler and
 * the REST layer both go through the same API. Mirrors the shape of
 * `ProjectStore` / `SessionStore` deliberately — nothing clever.
 */
export class RoutineStore {
  constructor(private readonly db: Database.Database) {}

  list(): Routine[] {
    const rows = this.db
      .prepare(`SELECT * FROM routines ORDER BY created_at DESC`)
      .all() as RoutineRow[];
    return rows.map(toRoutine);
  }

  /** Only `active` routines — what the scheduler iterates over. */
  listActive(): Routine[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM routines WHERE status = 'active' ORDER BY created_at ASC`,
      )
      .all() as RoutineRow[];
    return rows.map(toRoutine);
  }

  findById(id: string): Routine | null {
    const row = this.db
      .prepare("SELECT * FROM routines WHERE id = ?")
      .get(id) as RoutineRow | undefined;
    return row ? toRoutine(row) : null;
  }

  create(input: RoutineCreateInput): Routine {
    const now = new Date().toISOString();
    const row: RoutineRow = {
      id: input.id ?? nanoid(12),
      name: input.name,
      project_id: input.projectId,
      prompt: input.prompt,
      cron_expr: input.cronExpr,
      model: input.model,
      mode: input.mode,
      status: "active",
      last_run_at: null,
      next_run_at: input.nextRunAt ?? null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO routines (
           id, name, project_id, prompt, cron_expr, model, mode, status,
           last_run_at, next_run_at, created_at, updated_at
         ) VALUES (
           @id, @name, @project_id, @prompt, @cron_expr, @model, @mode, @status,
           @last_run_at, @next_run_at, @created_at, @updated_at
         )`,
      )
      .run(row);
    return toRoutine(row);
  }

  update(id: string, patch: RoutineUpdateInput): Routine | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const merged = {
      name: patch.name ?? existing.name,
      prompt: patch.prompt ?? existing.prompt,
      cron_expr: patch.cronExpr ?? existing.cronExpr,
      model: patch.model ?? existing.model,
      mode: patch.mode ?? existing.mode,
      status: patch.status ?? existing.status,
      updated_at: new Date().toISOString(),
      id,
    };
    this.db
      .prepare(
        `UPDATE routines SET
           name = @name, prompt = @prompt, cron_expr = @cron_expr,
           model = @model, mode = @mode, status = @status,
           updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(merged);
    return this.findById(id);
  }

  setStatus(id: string, status: RoutineStatus): void {
    this.db
      .prepare(
        "UPDATE routines SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, new Date().toISOString(), id);
  }

  /**
   * Persist the scheduler's view of "when does this next fire?". Kept
   * separate from `update` so the scheduler doesn't have to re-read the
   * routine just to touch one column.
   */
  setSchedule(id: string, nextRunAt: string | null): void {
    this.db
      .prepare(
        "UPDATE routines SET next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(nextRunAt, new Date().toISOString(), id);
  }

  setLastRun(id: string, lastRunAt: string, nextRunAt: string | null): void {
    this.db
      .prepare(
        `UPDATE routines
         SET last_run_at = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(lastRunAt, nextRunAt, new Date().toISOString(), id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
  }
}
