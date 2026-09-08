import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import {
  ToolGrantStore,
  signatureFor,
} from "../src/sessions/grants.js";
import { tempConfig } from "./helpers.js";

describe("signatureFor", () => {
  it("returns the command for Bash", () => {
    expect(signatureFor("Bash", { command: "pnpm test" })).toBe("pnpm test");
    expect(signatureFor("Bash", { command: "  ls -la  " })).toBe("ls -la");
  });

  it("returns file_path for edit-family tools", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Read"]) {
      expect(signatureFor(name, { file_path: "/x/y.ts" })).toBe("/x/y.ts");
    }
  });

  it("returns pattern for Glob and Grep", () => {
    expect(signatureFor("Glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
    expect(signatureFor("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("returns empty string for unknown tools (no grant possible)", () => {
    expect(signatureFor("MysteryTool", { foo: 1 })).toBe("");
  });

  it("handles missing fields without crashing", () => {
    expect(signatureFor("Bash", {})).toBe("");
    expect(signatureFor("Edit", {})).toBe("");
  });
});

describe("ToolGrantStore", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const { config, log, cleanup } = tempConfig();
    const { db, close } = openDb(config, log);
    // Seed a project + session so FKs work.
    db.prepare(
      `INSERT INTO projects (id, name, path, trusted, created_at)
       VALUES ('p1', 'demo', '/tmp/demo', 1, '2026-05-08T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, title, project_id, status, model, mode, created_at, updated_at)
       VALUES ('s1', 'demo', 'p1', 'idle', 'claude-opus-4-8', 'default', '2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, title, project_id, status, model, mode, created_at, updated_at)
       VALUES ('s2', 'demo2', 'p1', 'idle', 'claude-opus-4-8', 'default', '2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z')`,
    ).run();
    const grants = new ToolGrantStore(db);
    return {
      grants,
      db,
      cleanup: () => {
        close();
        cleanup();
      },
    };
  }

  it("addSessionGrant is scoped to its session", () => {
    const s = setup();
    cleanups.push(s.cleanup);
    s.grants.addSessionGrant("s1", "Bash", "pnpm test");
    expect(s.grants.has("s1", "Bash", "pnpm test")).toBe(true);
    expect(s.grants.has("s2", "Bash", "pnpm test")).toBe(false);
  });

  it("addGlobalGrant is visible from every session", () => {
    const s = setup();
    cleanups.push(s.cleanup);
    s.grants.addGlobalGrant("Bash", "pnpm test");
    expect(s.grants.has("s1", "Bash", "pnpm test")).toBe(true);
    expect(s.grants.has("s2", "Bash", "pnpm test")).toBe(true);
  });

  it("insert is idempotent (UNIQUE constraint handled)", () => {
    const s = setup();
    cleanups.push(s.cleanup);
    s.grants.addSessionGrant("s1", "Bash", "pnpm test");
    s.grants.addSessionGrant("s1", "Bash", "pnpm test");
    const rows = s.grants.listForSession("s1");
    expect(rows.filter((r) => r.session_id === "s1")).toHaveLength(1);
  });

  it("listForSession includes both session-scoped and global grants", () => {
    const s = setup();
    cleanups.push(s.cleanup);
    s.grants.addSessionGrant("s1", "Edit", "/x.ts");
    s.grants.addGlobalGrant("Bash", "pnpm test");
    const rows = s.grants.listForSession("s1");
    expect(rows.map((r) => r.tool_name).sort()).toEqual(["Bash", "Edit"]);
  });

  it("revoke removes the grant", () => {
    const s = setup();
    cleanups.push(s.cleanup);
    s.grants.addSessionGrant("s1", "Bash", "ls");
    const id = s.grants.listForSession("s1")[0].id;
    s.grants.revoke(id);
    expect(s.grants.has("s1", "Bash", "ls")).toBe(false);
  });

  it("session delete cascades grants", () => {
    const s = setup();
    cleanups.push(s.cleanup);
    s.grants.addSessionGrant("s1", "Bash", "ls");
    s.db.prepare("DELETE FROM sessions WHERE id='s1'").run();
    expect(s.grants.listForSession("s1")).toEqual([]);
  });
});
