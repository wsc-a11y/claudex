import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { tempConfig } from "./helpers.js";

function setup() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  return {
    projects,
    sessions,
    cleanup: () => {
      close();
      cleanup();
    },
  };
}

describe("ProjectStore", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("creates, looks up, and lists projects", () => {
    const { projects, cleanup } = setup();
    cleanups.push(cleanup);

    const a = projects.create({ name: "spindle", path: "/p/spindle", trusted: true });
    const b = projects.create({ name: "lumen", path: "/p/lumen", trusted: false });

    expect(projects.list()).toHaveLength(2);
    expect(projects.findById(a.id)?.name).toBe("spindle");
    expect(projects.findByPath("/p/lumen")?.id).toBe(b.id);
    expect(projects.findByPath("/nope")).toBeNull();
  });

  it("enforces unique path", () => {
    const { projects, cleanup } = setup();
    cleanups.push(cleanup);
    projects.create({ name: "spindle", path: "/p/spindle", trusted: true });
    expect(() =>
      projects.create({ name: "other", path: "/p/spindle", trusted: false }),
    ).toThrow();
  });

  it("setTrusted flips trusted flag", () => {
    const { projects, cleanup } = setup();
    cleanups.push(cleanup);
    const p = projects.create({ name: "spindle", path: "/p/spindle", trusted: false });
    projects.setTrusted(p.id, true);
    expect(projects.findById(p.id)?.trusted).toBe(true);
  });

  it("delete fails when a session references the project", () => {
    const { projects, sessions, cleanup } = setup();
    cleanups.push(cleanup);
    const p = projects.create({ name: "spindle", path: "/p/spindle", trusted: true });
    sessions.create({
      title: "t",
      projectId: p.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    expect(() => projects.delete(p.id)).toThrow();
  });
});

describe("SessionStore", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function bootstrap() {
    const s = setup();
    cleanups.push(s.cleanup);
    const project = s.projects.create({
      name: "spindle",
      path: "/p/spindle",
      trusted: true,
    });
    return { ...s, project };
  }

  it("creates sessions with defaulted fields", () => {
    const { sessions, project } = bootstrap();
    const created = sessions.create({
      title: "Fix hydration",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe("idle");
    expect(created.stats.messages).toBe(0);
    expect(created.lastMessageAt).toBeNull();
    expect(created.archivedAt).toBeNull();
  });

  it("lists in updated_at DESC order and filters archived", () => {
    const { sessions, project } = bootstrap();
    const a = sessions.create({
      title: "a",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.create({
      title: "b",
      projectId: project.id,
      model: "claude-sonnet-4-6",
      mode: "acceptEdits",
    });
    sessions.archive(a.id);

    // list() excludes archived by default
    const active = sessions.list();
    expect(active.map((s) => s.title)).toEqual(["b"]);

    // but is included when asked for
    const all = sessions.list({ includeArchived: true });
    expect(all.map((s) => s.title).sort()).toEqual(["a", "b"]);
  });

  it("listByProject scopes correctly", () => {
    const { projects, sessions, project } = bootstrap();
    const other = projects.create({ name: "lumen", path: "/p/lumen", trusted: true });
    sessions.create({
      title: "s1",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.create({
      title: "s2",
      projectId: other.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    expect(sessions.listByProject(project.id).map((s) => s.title)).toEqual(["s1"]);
    expect(sessions.listByProject(other.id).map((s) => s.title)).toEqual(["s2"]);
  });

  it("bumpStats accumulates and keeps contextPct", () => {
    const { sessions, project } = bootstrap();
    const s = sessions.create({
      title: "t",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.bumpStats(s.id, { messages: 2, linesAdded: 10 });
    sessions.bumpStats(s.id, {
      messages: 1,
      linesRemoved: 3,
      contextPct: 0.42,
    });
    const after = sessions.findById(s.id)!;
    expect(after.stats.messages).toBe(3);
    expect(after.stats.linesAdded).toBe(10);
    expect(after.stats.linesRemoved).toBe(3);
    expect(after.stats.contextPct).toBeCloseTo(0.42);
  });

  it("setStats absolutely overwrites file/line stats and leaves messages alone", () => {
    const { sessions, project } = bootstrap();
    const s = sessions.create({
      title: "t",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    // Pre-populate so we can confirm the overwrite is absolute, not additive.
    sessions.bumpStats(s.id, {
      messages: 5,
      filesChanged: 99,
      linesAdded: 999,
      linesRemoved: 123,
    });
    sessions.setStats(s.id, {
      filesChanged: 2,
      linesAdded: 7,
      linesRemoved: 1,
      computedSeq: 42,
    });
    const after = sessions.findById(s.id)!;
    expect(after.stats.filesChanged).toBe(2);
    expect(after.stats.linesAdded).toBe(7);
    expect(after.stats.linesRemoved).toBe(1);
    // messages untouched — it's bumpStats territory.
    expect(after.stats.messages).toBe(5);

    // Re-setting replaces again (not additive).
    sessions.setStats(s.id, {
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      computedSeq: 100,
    });
    const after2 = sessions.findById(s.id)!;
    expect(after2.stats.filesChanged).toBe(0);
    expect(after2.stats.linesAdded).toBe(0);
    expect(after2.stats.linesRemoved).toBe(0);
  });

  it("listStaleStats surfaces sessions whose event log is ahead of their stats cursor", () => {
    const { sessions, project } = bootstrap();
    // Session with no events — should never appear (maxSeq = -1 == cursor).
    const empty = sessions.create({
      title: "empty",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    // Session with one event but stats never refreshed (cursor still -1).
    const a = sessions.create({
      title: "a",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.appendEvent({
      sessionId: a.id,
      kind: "user_message",
      payload: { text: "hi" },
    });
    // Session already caught up.
    const b = sessions.create({
      title: "b",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.appendEvent({
      sessionId: b.id,
      kind: "user_message",
      payload: { text: "ok" },
    });
    sessions.setStats(b.id, {
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      computedSeq: 0,
    });

    const stale = sessions.listStaleStats(10);
    const ids = stale.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(empty.id);
    const row = stale.find((r) => r.id === a.id)!;
    expect(row.maxSeq).toBe(0); // first event's seq

    // After setStats advances the cursor, `a` drops out.
    sessions.setStats(a.id, {
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      computedSeq: row.maxSeq,
    });
    expect(sessions.listStaleStats(10).map((r) => r.id)).not.toContain(a.id);

    // A new event on `a` makes it stale again.
    sessions.appendEvent({
      sessionId: a.id,
      kind: "user_message",
      payload: { text: "again" },
    });
    expect(sessions.listStaleStats(10).map((r) => r.id)).toContain(a.id);
  });

  it("listStaleStats excludes archived sessions", () => {
    const { sessions, project } = bootstrap();
    const s = sessions.create({
      title: "arc",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    sessions.appendEvent({
      sessionId: s.id,
      kind: "user_message",
      payload: { text: "hi" },
    });
    expect(sessions.listStaleStats(10).map((r) => r.id)).toContain(s.id);
    sessions.archive(s.id);
    expect(sessions.listStaleStats(10).map((r) => r.id)).not.toContain(s.id);
  });

  it("event seq is monotonic per session and independent across sessions", () => {
    const { sessions, project } = bootstrap();
    const s1 = sessions.create({
      title: "s1",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    const s2 = sessions.create({
      title: "s2",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    const e1 = sessions.appendEvent({
      sessionId: s1.id,
      kind: "user_message",
      payload: { text: "hi" },
    });
    const e2 = sessions.appendEvent({
      sessionId: s1.id,
      kind: "assistant_text",
      payload: { text: "hello" },
    });
    const e3 = sessions.appendEvent({
      sessionId: s2.id,
      kind: "user_message",
      payload: { text: "yo" },
    });
    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
    expect(e3.seq).toBe(0);
    expect(sessions.listEvents(s1.id)).toHaveLength(2);
    expect(sessions.listEvents(s2.id)).toHaveLength(1);
    expect(sessions.listEvents(s1.id, 0).map((e) => e.id)).toEqual([e2.id]);
  });

  it("cascades events when session is deleted", () => {
    const { sessions, project } = bootstrap();
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
    // Direct delete through the raw db — session store doesn't expose delete
    // today; this just verifies the FK cascade we declared.
    const res = (sessions as any).db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
    expect(res.changes).toBe(1);
    expect(sessions.listEvents(s.id)).toHaveLength(0);
  });

  it("roundtrips payload JSON correctly", () => {
    const { sessions, project } = bootstrap();
    const s = sessions.create({
      title: "t",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    const complex = {
      text: "line1\nline2",
      emoji: "\u{1F389}",
      nested: { a: 1, b: [true, null, "x"] },
    };
    sessions.appendEvent({ sessionId: s.id, kind: "assistant_text", payload: complex });
    const [ev] = sessions.listEvents(s.id);
    expect(ev.payload).toEqual(complex);
  });

  it("setSdkSessionId is first-write-wins and leaves the row NULL until called", () => {
    const { sessions, project } = bootstrap();
    const s = sessions.create({
      title: "t",
      projectId: project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    // Fresh session: sdkSessionId defaults to null.
    expect(s.sdkSessionId).toBeNull();
    expect(sessions.findById(s.id)!.sdkSessionId).toBeNull();

    // First write wins; returns true.
    expect(sessions.setSdkSessionId(s.id, "sdk-first")).toBe(true);
    expect(sessions.findById(s.id)!.sdkSessionId).toBe("sdk-first");

    // Second write is a no-op; returns false and does not overwrite.
    expect(sessions.setSdkSessionId(s.id, "sdk-second")).toBe(false);
    expect(sessions.findById(s.id)!.sdkSessionId).toBe("sdk-first");
  });
});
