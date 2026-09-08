import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bootstrapAuthedApp } from "./helpers.js";
import { ProjectStore } from "../src/sessions/projects.js";

// ---------------------------------------------------------------------------
// Files browser routes. Everything JWT-gated; path-traversal rejected 403.
// We use ProjectStore.create() directly instead of POST /api/projects so
// tests don't depend on whatever project-create validation evolves to.
// ---------------------------------------------------------------------------

describe("files routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  function mkProject(
    ctx: Awaited<ReturnType<typeof bootstrapAuthedApp>>,
  ): string {
    const projects = new ProjectStore(ctx.dbh.db);
    const p = projects.create({
      name: path.basename(ctx.tmpDir),
      path: ctx.tmpDir,
      trusted: true,
    });
    return p.id;
  }

  // -- /api/files/tree -------------------------------------------------------

  it("GET /api/files/tree: rejects unauthenticated with 401", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/files/tree?project=anything",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/files/tree: 400 when project param missing", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/files/tree",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_project");
  });

  it("GET /api/files/tree: 404 for unknown project id", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/files/tree?project=nope",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
  });

  it("GET /api/files/tree: rejects path-traversal with 403 traversal_denied", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projectId = mkProject(ctx);
    for (const traversal of ["../../../etc", "subdir/../../../etc"]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/files/tree?project=${projectId}&path=${encodeURIComponent(traversal)}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("traversal_denied");
    }
  });

  it("GET /api/files/tree: lists root entries, dirs before files, alphabetical", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    fs.writeFileSync(path.join(ctx.tmpDir, "zebra.txt"), "z");
    fs.writeFileSync(path.join(ctx.tmpDir, "alpha.txt"), "a");
    fs.mkdirSync(path.join(ctx.tmpDir, "subdir"));
    const projectId = mkProject(ctx);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/files/tree?project=${projectId}`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projectId).toBe(projectId);
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(["subdir", "alpha.txt", "zebra.txt"]);
  });

  // -- /api/files/read -------------------------------------------------------

  it("GET /api/files/read: 401 unauthenticated", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/files/read?project=anything&path=x.txt",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/files/read: rejects traversal with 403", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projectId = mkProject(ctx);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/files/read?project=${projectId}&path=${encodeURIComponent("../../etc/passwd")}`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("traversal_denied");
  });

  it("GET /api/files/read: returns file contents + line count", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    fs.writeFileSync(path.join(ctx.tmpDir, "test.txt"), "hello world\nline two\n");
    const projectId = mkProject(ctx);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/files/read?project=${projectId}&path=test.txt`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toContain("hello world");
    expect(body.content).toContain("line two");
    expect(body.truncated).toBe(false);
    expect(body.lines).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/files/read: rejects .png by extension with 415", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    fs.writeFileSync(
      path.join(ctx.tmpDir, "image.png"),
      Buffer.from([137, 80, 78, 71]),
    );
    const projectId = mkProject(ctx);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/files/read?project=${projectId}&path=image.png`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("binary_file");
  });

  it("GET /api/files/read: rejects null-byte binaries by sniff with 415", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const buf = Buffer.alloc(100, 65); // 'A' * 100
    buf[50] = 0; // null byte in first 512
    fs.writeFileSync(path.join(ctx.tmpDir, "weird.dat"), buf);
    const projectId = mkProject(ctx);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/files/read?project=${projectId}&path=weird.dat`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("binary_file");
  });

  // -- /api/files/status -----------------------------------------------------

  it("GET /api/files/status: returns isGitRepo=false for a non-git dir", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projectId = mkProject(ctx);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/files/status?project=${projectId}`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isGitRepo).toBe(false);
    expect(body.entries).toEqual([]);
  });
});
