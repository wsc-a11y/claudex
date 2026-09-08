import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { backfillSessionTitles } from "../src/sessions/backfill-titles.js";
import { tempConfig } from "./helpers.js";

function setup() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const project = projects.create({
    name: "spindle",
    path: "/p/spindle",
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

describe("backfillSessionTitles", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("retitles placeholder-titled sessions that have a first user_message", () => {
    const s = setup();
    cleanups.push(s.cleanup);

    // (a) placeholder "Untitled" + a first user_message → should retitle.
    const a = s.sessions.create({
      title: "Untitled",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    s.sessions.appendEvent({
      sessionId: a.id,
      kind: "user_message",
      payload: { text: "Fix the bug" },
    });

    // (b) substantive title ("Real topic" is 2 words — still placeholder-ish
    // under current heuristic); bump it beyond 3 words so we exercise the
    // "user-chosen → untouched" branch.
    const b = s.sessions.create({
      title: "A very deliberate real topic",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    s.sessions.appendEvent({
      sessionId: b.id,
      kind: "user_message",
      payload: { text: "should not matter" },
    });

    // (c) placeholder title, no events → can't retitle, stays untouched.
    const c = s.sessions.create({
      title: "Untitled",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });

    const result = backfillSessionTitles({ sessions: s.sessions });
    expect(result.retitled).toBe(1);

    expect(s.sessions.findById(a.id)!.title).toBe("Fix the bug");
    expect(s.sessions.findById(b.id)!.title).toBe("A very deliberate real topic");
    expect(s.sessions.findById(c.id)!.title).toBe("Untitled");
  });

  it("skips side chats even when their title is a placeholder", () => {
    const s = setup();
    cleanups.push(s.cleanup);

    const parent = s.sessions.create({
      title: "A very deliberate real topic",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    const side = s.sessions.create({
      title: "Untitled",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
      parentSessionId: parent.id,
    });
    s.sessions.appendEvent({
      sessionId: side.id,
      kind: "user_message",
      payload: { text: "nope, don't retitle me" },
    });

    const result = backfillSessionTitles({ sessions: s.sessions });
    expect(result.retitled).toBe(0);
    expect(s.sessions.findById(side.id)!.title).toBe("Untitled");
  });

  it("returns zero counts on an empty DB", () => {
    const s = setup();
    cleanups.push(s.cleanup);

    const result = backfillSessionTitles({ sessions: s.sessions });
    expect(result).toEqual({ scanned: 0, retitled: 0 });
  });
});
