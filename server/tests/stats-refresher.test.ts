import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { StatsRefresher } from "../src/sessions/stats-refresher.js";
import { tempConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// StatsRefresher — background sweeper that re-aggregates file/line diff stats
// for sessions whose event log has moved past their stats_computed_seq cursor.
// ---------------------------------------------------------------------------

function setup() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const project = projects.create({
    name: "proj",
    path: "/p/proj",
    trusted: true,
  });
  return {
    projects,
    sessions,
    project,
    cleanup: () => {
      close();
      cleanup();
    },
  };
}

describe("StatsRefresher", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("writes totals from the event log on first tick and no-ops on the second", async () => {
    const { sessions, project, cleanup } = setup();
    cleanups.push(cleanup);

    const s = sessions.create({
      title: "t",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });

    // Two file mutations on the same path → 1 file changed. Write establishes
    // the file; Edit counts exactly one added and one removed line via the
    // line-based diff in `diffs.ts`.
    sessions.appendEvent({
      sessionId: s.id,
      kind: "tool_use",
      payload: {
        toolUseId: "tu1",
        name: "Write",
        input: {
          file_path: "/proj/src/index.ts",
          content: "const x = 1;\nconst y = 2;\n",
        },
      },
    });
    sessions.appendEvent({
      sessionId: s.id,
      kind: "tool_use",
      payload: {
        toolUseId: "tu2",
        name: "Edit",
        input: {
          file_path: "/proj/src/index.ts",
          old_string: "const x = 1;",
          new_string: "const x = 42;",
        },
      },
    });

    // Before the tick, stats columns are still at their defaults.
    const before = sessions.findById(s.id)!;
    expect(before.stats.filesChanged).toBe(0);
    expect(before.stats.linesAdded).toBe(0);
    expect(before.stats.linesRemoved).toBe(0);

    const refresher = new StatsRefresher({
      sessions,
      intervalMs: 60_000, // irrelevant — we drive tick() directly
      batchSize: 10,
    });
    await refresher.tick();

    const after = sessions.findById(s.id)!;
    expect(after.stats.filesChanged).toBe(1);
    // Write establishes two lines (additions=2 from diffForToolCall's synthetic
    // old=""). Subsequent Edit adds 1, removes 1. Totals therefore are 3 / 1.
    expect(after.stats.linesAdded).toBe(3);
    expect(after.stats.linesRemoved).toBe(1);

    // Second tick is a no-op because stats_computed_seq now matches the max
    // event seq. We verify by re-examining listStaleStats — the session must
    // not appear.
    expect(sessions.listStaleStats(10).map((r) => r.id)).not.toContain(s.id);
    await refresher.tick();
    const again = sessions.findById(s.id)!;
    expect(again.stats.filesChanged).toBe(1);
    expect(again.stats.linesAdded).toBe(3);
    expect(again.stats.linesRemoved).toBe(1);
  });

  it("leaves sessions with no diff-relevant events at zero", async () => {
    const { sessions, project, cleanup } = setup();
    cleanups.push(cleanup);

    const s = sessions.create({
      title: "t",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.appendEvent({
      sessionId: s.id,
      kind: "user_message",
      payload: { text: "hi" },
    });

    const refresher = new StatsRefresher({
      sessions,
      intervalMs: 60_000,
      batchSize: 10,
    });
    await refresher.tick();

    const after = sessions.findById(s.id)!;
    expect(after.stats.filesChanged).toBe(0);
    expect(after.stats.linesAdded).toBe(0);
    expect(after.stats.linesRemoved).toBe(0);
    // ...but the cursor did advance, so the session no longer appears stale.
    expect(sessions.listStaleStats(10).map((r) => r.id)).not.toContain(s.id);
  });

  it("prefers recently-updated sessions when the batch size is small", async () => {
    const { sessions, project, cleanup } = setup();
    cleanups.push(cleanup);

    // Two sessions, both with a stale diff stats projection. listStaleStats
    // orders by updated_at DESC, so the more-recently-touched one wins the
    // single slot. We force the ordering by directly writing updated_at to
    // demonstrably-different values — relying on wall-clock separation is
    // flaky because ISO timestamps have millisecond resolution and synchronous
    // bumpStats calls can tie within a tick.
    const older = sessions.create({
      title: "older",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.appendEvent({
      sessionId: older.id,
      kind: "user_message",
      payload: { text: "a" },
    });

    const newer = sessions.create({
      title: "newer",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.appendEvent({
      sessionId: newer.id,
      kind: "user_message",
      payload: { text: "b" },
    });

    // Pin the update order: older moves back in time, newer moves forward.
    const dbAny = (sessions as unknown as { db: import("better-sqlite3").Database })
      .db;
    dbAny
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", older.id);
    dbAny
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run("2999-01-01T00:00:00.000Z", newer.id);

    const refresher = new StatsRefresher({
      sessions,
      intervalMs: 60_000,
      batchSize: 1,
    });
    await refresher.tick();

    // Only `newer` should have been processed. `older` still appears stale.
    const stale = sessions.listStaleStats(10).map((r) => r.id);
    expect(stale).toContain(older.id);
    expect(stale).not.toContain(newer.id);
  });

  it("tick() reentrancy guard: overlapping calls no-op", async () => {
    const { sessions, project, cleanup } = setup();
    cleanups.push(cleanup);

    const s = sessions.create({
      title: "t",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.appendEvent({
      sessionId: s.id,
      kind: "user_message",
      payload: { text: "hi" },
    });

    const refresher = new StatsRefresher({
      sessions,
      intervalMs: 60_000,
      batchSize: 10,
    });
    // Fire both at once; the second must not explode or double-process.
    await Promise.all([refresher.tick(), refresher.tick()]);
    expect(sessions.findById(s.id)!.stats.filesChanged).toBe(0);
  });

  it("dispose() stops the periodic tick", async () => {
    const { sessions, cleanup } = setup();
    cleanups.push(cleanup);
    const refresher = new StatsRefresher({
      sessions,
      intervalMs: 60_000,
      batchSize: 10,
    });
    refresher.start();
    refresher.dispose();
    // After dispose tick() is gated off, so even a stale session won't be
    // touched.
    await refresher.tick();
  });
});
