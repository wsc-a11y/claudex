import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { importCliSession } from "../src/sessions/cli-import.js";
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

describe("importCliSession", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("creates a project + session and stamps the sdk_session_id", async () => {
    const { projects, sessions, cleanup } = setup();
    cleanups.push(cleanup);

    const { session, wasNew } = await importCliSession(
      { projects, sessions },
      {
        sessionId: "uuid-1",
        cwd: "/Users/hao/Code/demo",
        title: "first hello",
      },
    );

    expect(wasNew).toBe(true);
    expect(session.title).toBe("first hello");
    expect(session.sdkSessionId).toBe("uuid-1");
    expect(session.worktreePath).toBeNull();

    const project = projects.findById(session.projectId);
    expect(project?.path).toBe("/Users/hao/Code/demo");
    expect(project?.name).toBe("demo");
    expect(project?.trusted).toBe(true);
  });

  it("is idempotent: re-importing the same sessionId returns the same row", async () => {
    const { projects, sessions, cleanup } = setup();
    cleanups.push(cleanup);

    const first = await importCliSession(
      { projects, sessions },
      { sessionId: "uuid-2", cwd: "/p/proj", title: "hi" },
    );
    const second = await importCliSession(
      { projects, sessions },
      { sessionId: "uuid-2", cwd: "/p/proj", title: "hi (again)" },
    );

    expect(first.wasNew).toBe(true);
    expect(second.wasNew).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    // Title does not change on re-import — user's pre-existing row wins.
    expect(second.session.title).toBe("hi");
    expect(sessions.list()).toHaveLength(1);
    expect(projects.list()).toHaveLength(1);
  });

  it("reuses an existing project when the cwd already has one", async () => {
    const { projects, sessions, cleanup } = setup();
    cleanups.push(cleanup);

    const p = projects.create({
      name: "pre-existing",
      path: "/p/shared",
      trusted: false,
    });
    const { session } = await importCliSession(
      { projects, sessions },
      { sessionId: "uuid-3", cwd: "/p/shared", title: "adopt" },
    );
    expect(session.projectId).toBe(p.id);
    expect(projects.list()).toHaveLength(1);
  });

  it("falls back to cwd as project name when basename is empty", async () => {
    const { projects, sessions, cleanup } = setup();
    cleanups.push(cleanup);

    // `basename("/")` is empty — ensure we pick something non-empty.
    const { session } = await importCliSession(
      { projects, sessions },
      { sessionId: "uuid-4", cwd: "/", title: "root session" },
    );
    const project = projects.findById(session.projectId);
    expect(project?.name.length).toBeGreaterThan(0);
  });
});
