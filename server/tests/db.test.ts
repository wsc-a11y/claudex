import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { tempConfig } from "./helpers.js";

describe("db migrations", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("runs migrations and creates every expected table", () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const { db, close } = openDb(config, log);
    cleanups.push(close);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r: any) => r.name);

    for (const expected of [
      "_migrations",
      "pending_approvals",
      "projects",
      "session_events",
      "sessions",
      "tool_grants",
      "users",
    ]) {
      expect(tables).toContain(expected);
    }

    // Foreign keys must be on (otherwise ON DELETE CASCADE breaks later tests).
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it("is idempotent — re-opening does not reapply migrations", () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);

    const first = openDb(config, log);
    const firstRows = first.db.prepare("SELECT * FROM _migrations").all() as any[];
    const firstCount = firstRows.length;
    first.close();

    const second = openDb(config, log);
    cleanups.push(second.close);

    const rows = second.db.prepare("SELECT * FROM _migrations").all() as any[];
    // Same number of migrations as after first open — nothing re-applied.
    expect(rows.length).toBe(firstCount);
    expect(rows.map((r) => r.name)).toContain("init");
  });

  it("cascades session_events on session delete", () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const { db, close } = openDb(config, log);
    cleanups.push(close);

    db.prepare(
      `INSERT INTO projects (id, name, path, trusted, created_at)
       VALUES ('p1', 'demo', '/tmp/demo', 1, '2026-05-08T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, title, project_id, status, model, mode, created_at, updated_at)
       VALUES ('s1', 'Demo', 'p1', 'idle', 'claude-opus-4-8', 'default', '2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
       VALUES ('e1', 's1', 'user_message', 0, '2026-05-08T00:00:00Z', '{}')`,
    ).run();

    db.prepare("DELETE FROM sessions WHERE id='s1'").run();
    const remaining = db.prepare("SELECT COUNT(*) as c FROM session_events").get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("sessions table has sdk_session_id column (nullable, default NULL)", () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const { db, close } = openDb(config, log);
    cleanups.push(close);

    const cols = db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === "sdk_session_id");
    expect(col).toBeTruthy();
    expect(col!.notnull).toBe(0);

    // Inserts without sdk_session_id should land as NULL.
    db.prepare(
      `INSERT INTO projects (id, name, path, trusted, created_at)
       VALUES ('p2', 'demo', '/tmp/demo2', 1, '2026-05-08T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, title, project_id, status, model, mode, created_at, updated_at)
       VALUES ('s2', 'Demo', 'p2', 'idle', 'claude-opus-4-8', 'default', '2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z')`,
    ).run();
    const row = db
      .prepare("SELECT sdk_session_id FROM sessions WHERE id='s2'")
      .get() as { sdk_session_id: string | null };
    expect(row.sdk_session_id).toBeNull();

    // And all migrations recorded.
    const migrations = db
      .prepare("SELECT id FROM _migrations ORDER BY id")
      .all() as Array<{ id: number }>;
    expect(migrations.map((m) => m.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29,
    ]);
  });
});
