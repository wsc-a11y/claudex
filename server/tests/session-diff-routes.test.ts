import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import type { SessionDiffResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// /api/sessions/:id/session-diff — whole-session PR-shaped diff aggregation.
// ---------------------------------------------------------------------------

describe("session-diff routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  function mkProjectAndSession(
    ctx: Awaited<ReturnType<typeof bootstrapAuthedApp>>,
  ): { projectId: string; sessionId: string } {
    const projects = new ProjectStore(ctx.dbh.db);
    const sessions = new SessionStore(ctx.dbh.db);
    const project = projects.create({
      name: "proj",
      path: ctx.tmpDir,
      trusted: true,
    });
    const session = sessions.create({
      projectId: project.id,
      title: "test session",
      model: "claude-sonnet-4-6",
      mode: "default",
      branch: "main",
      worktreePath: null,
      parentSessionId: null,
      forkedFromSessionId: null,
    });
    return { projectId: project.id, sessionId: session.id };
  }

  it("rejects unauthenticated with 401", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/sessions/nope/session-diff",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for an unknown session id", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/sessions/no-such/session-diff",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("returns empty files/timeline for a session with no edits", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const { sessionId } = mkProjectAndSession(ctx);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/session-diff`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionDiffResponse;
    expect(body.files).toEqual([]);
    expect(body.timeline).toEqual([]);
    expect(body.totals).toEqual({
      additions: 0,
      deletions: 0,
      filesChanged: 0,
    });
    expect(body.sessionTitle).toBe("test session");
  });

  it("aggregates a Write (create) then an Edit on the same file as one M file", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const { sessionId } = mkProjectAndSession(ctx);
    const sessions = new SessionStore(ctx.dbh.db);

    sessions.appendEvent({
      sessionId,
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
      sessionId,
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

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/session-diff`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionDiffResponse;

    expect(body.files).toHaveLength(1);
    const file = body.files[0];
    expect(file.path).toBe("/proj/src/index.ts");
    // Write + subsequent Edit → status M (file existed by the time we edited)
    expect(file.status).toBe("M");
    expect(file.approval).toBe("auto"); // no permission_request events
    expect(file.hunkCount).toBe(2);

    expect(body.timeline).toHaveLength(2);
    expect(body.timeline[0].action).toBe("write");
    expect(body.timeline[1].action).toBe("edit");
    expect(body.totals.filesChanged).toBe(1);
  });

  it("marks a file as pending when its Edit has a permission_request but no decision", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const { sessionId } = mkProjectAndSession(ctx);
    const sessions = new SessionStore(ctx.dbh.db);

    sessions.appendEvent({
      sessionId,
      kind: "permission_request",
      payload: {
        toolUseId: "tu-pending",
        toolName: "Edit",
        input: {
          file_path: "/proj/a.ts",
          old_string: "a",
          new_string: "b",
        },
      },
    });
    sessions.appendEvent({
      sessionId,
      kind: "tool_use",
      payload: {
        toolUseId: "tu-pending",
        name: "Edit",
        input: {
          file_path: "/proj/a.ts",
          old_string: "a",
          new_string: "b",
        },
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/session-diff`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionDiffResponse;
    expect(body.files[0].approval).toBe("pending");
    expect(body.timeline[0].approval).toBe("pending");
  });

  it("marks a file as rejected when the user denied the permission", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const { sessionId } = mkProjectAndSession(ctx);
    const sessions = new SessionStore(ctx.dbh.db);

    sessions.appendEvent({
      sessionId,
      kind: "permission_request",
      payload: {
        toolUseId: "tu-r",
        toolName: "Edit",
        input: {
          file_path: "/proj/b.ts",
          old_string: "c",
          new_string: "d",
        },
      },
    });
    sessions.appendEvent({
      sessionId,
      kind: "permission_decision",
      payload: { toolUseId: "tu-r", decision: "deny", toolName: "Edit" },
    });
    sessions.appendEvent({
      sessionId,
      kind: "tool_use",
      payload: {
        toolUseId: "tu-r",
        name: "Edit",
        input: {
          file_path: "/proj/b.ts",
          old_string: "c",
          new_string: "d",
        },
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/session-diff`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SessionDiffResponse;
    expect(body.files[0].approval).toBe("rejected");
  });
});
