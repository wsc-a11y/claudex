import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapAuthedApp } from "./helpers.js";

// ---------------------------------------------------------------------------
// /api/projects/:id/memory — read-only CLAUDE.md preview used by the session
// settings sheet. Tests cover the auth gate, the "nothing found" shape, the
// two precedence paths inside a project, co-surfacing the user-global file,
// oversize truncation, and the symlink refusal that keeps a malicious
// `CLAUDE.md -> /etc/passwd` from exfiltrating arbitrary host files.
//
// We isolate the user-global probe by mocking `os.homedir()` for each test.
// Node caches `os.homedir()` from libuv at startup, so $HOME env mutations
// after Node boots don't take effect — a `vi.spyOn` is the reliable knob.
// ---------------------------------------------------------------------------

function makeProject(root: string, name: string): string {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe("/api/projects/:id/memory", () => {
  const disposers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    while (disposers.length) await disposers.pop()!();
  });

  /** Point `os.homedir()` at a fresh tmp dir and return its path. */
  function isolateHome(): string {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-home-"));
    disposers.push(() => fs.rmSync(fakeHome, { recursive: true, force: true }));
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    return fakeHome;
  }

  it("requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/projects/anything/memory",
    });
    expect(res.statusCode).toBe(401);
  });

  it("404s for an unknown project", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/projects/nope/memory",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("returns empty files when no CLAUDE.md exists anywhere", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    // Isolate $HOME so a CLAUDE.md on the dev's host doesn't leak in.
    const fakeHome = isolateHome();

    const projectPath = makeProject(ctx.tmpDir, "proj-empty");
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "proj", path: projectPath },
    });
    expect(created.statusCode).toBe(200);
    const projectId = created.json().project.id as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/memory`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ files: [] });
  });

  it("returns the project CLAUDE.md (top-level takes precedence over .claude/)", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const fakeHome = isolateHome();

    const projectPath = makeProject(ctx.tmpDir, "proj-memo");
    // Both candidates exist — the top-level file wins.
    fs.writeFileSync(
      path.join(projectPath, "CLAUDE.md"),
      "# Top-level memory\nHello.",
    );
    fs.mkdirSync(path.join(projectPath, ".claude"));
    fs.writeFileSync(
      path.join(projectPath, ".claude", "CLAUDE.md"),
      "# Nested memory\nNope.",
    );
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "memo", path: projectPath },
    });
    const projectId = created.json().project.id as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/memory`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      files: Array<{ scope: string; path: string; content: string }>;
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0].scope).toBe("project");
    expect(body.files[0].path).toBe(path.join(projectPath, "CLAUDE.md"));
    expect(body.files[0].content).toContain("Top-level memory");
  });

  it("falls back to .claude/CLAUDE.md when top-level is absent", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const fakeHome = isolateHome();

    const projectPath = makeProject(ctx.tmpDir, "proj-nested");
    fs.mkdirSync(path.join(projectPath, ".claude"));
    fs.writeFileSync(
      path.join(projectPath, ".claude", "CLAUDE.md"),
      "# Nested only",
    );
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "nested", path: projectPath },
    });
    const projectId = created.json().project.id as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/memory`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe(
      path.join(projectPath, ".claude", "CLAUDE.md"),
    );
  });

  it("returns both project + user CLAUDE.md together when both exist", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const fakeHome = isolateHome();
    fs.mkdirSync(path.join(fakeHome, ".claude"));
    fs.writeFileSync(
      path.join(fakeHome, ".claude", "CLAUDE.md"),
      "# Global memory",
    );

    const projectPath = makeProject(ctx.tmpDir, "proj-both");
    fs.writeFileSync(
      path.join(projectPath, "CLAUDE.md"),
      "# Project memory",
    );
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "both", path: projectPath },
    });
    const projectId = created.json().project.id as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/memory`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      files: Array<{ scope: string; path: string; content: string }>;
    };
    expect(body.files).toHaveLength(2);
    // Project comes first (precedence in the UI), user second.
    expect(body.files[0].scope).toBe("project");
    expect(body.files[0].path).toBe(path.join(projectPath, "CLAUDE.md"));
    expect(body.files[1].scope).toBe("user");
    expect(body.files[1].path).toBe(
      path.join(fakeHome, ".claude", "CLAUDE.md"),
    );
  });

  it("truncates oversize content and flags it", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const fakeHome = isolateHome();

    const projectPath = makeProject(ctx.tmpDir, "proj-big");
    const huge = "x".repeat(64 * 1024 + 500); // > MEMORY_MAX_BYTES
    fs.writeFileSync(path.join(projectPath, "CLAUDE.md"), huge);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "big", path: projectPath },
    });
    const projectId = created.json().project.id as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/memory`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      files: Array<{
        content: string;
        bytes: number;
        truncated?: boolean;
      }>;
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0].truncated).toBe(true);
    // Reported bytes is the real on-disk size, not the truncated length.
    expect(body.files[0].bytes).toBe(huge.length);
    expect(body.files[0].content.length).toBeLessThanOrEqual(64 * 1024);
    expect(body.files[0].content.length).toBeGreaterThan(0);
  });

  it("refuses to follow a symlink CLAUDE.md that points outside the project", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const fakeHome = isolateHome();

    // Put a secret file somewhere outside the project. A naive `readFile`
    // through a symlink would leak this.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-secret-"));
    disposers.push(() => fs.rmSync(secretDir, { recursive: true, force: true }));
    const secretPath = path.join(secretDir, "secret.txt");
    fs.writeFileSync(secretPath, "TOP SECRET");

    const projectPath = makeProject(ctx.tmpDir, "proj-symlink");
    // Symlink project CLAUDE.md -> outside-the-project secret.
    fs.symlinkSync(secretPath, path.join(projectPath, "CLAUDE.md"));
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "sym", path: projectPath },
    });
    const projectId = created.json().project.id as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/memory`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: Array<{ content: string }> };
    // Symlink skipped. There's no .claude/CLAUDE.md and no user-global file,
    // so the response is empty.
    expect(body.files).toHaveLength(0);
    // Belt-and-braces: nothing we return should contain the secret.
    for (const f of body.files) {
      expect(f.content).not.toContain("TOP SECRET");
    }
  });
});
