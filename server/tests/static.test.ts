import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildApp } from "../src/transport/app.js";
import { openDb } from "../src/db/index.js";
import { loadOrCreateJwtSecret } from "../src/auth/index.js";
import { tempConfig } from "./helpers.js";
import type { RunnerFactory } from "../src/sessions/runner.js";

const nullFactory: RunnerFactory = {
  create: () =>
    ({
      sessionId: "",
      sdkSessionId: null,
      async start() {},
      async sendUserMessage() {},
      resolvePermission() {},
      async interrupt() {},
      async setPermissionMode() {},
      async dispose() {},
      on() {
        return () => {};
      },
      listenerCount() {
        return 0;
      },
    }) as any,
};

async function bootstrap(webDist?: string): Promise<{
  app: FastifyInstance;
  cleanup: () => Promise<void>;
}> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const { app, manager } = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: true,
    runnerFactory: nullFactory,
    webDist,
  });
  return {
    app,
    cleanup: async () => {
      await manager.disposeAll();
      await app.close();
      dbh.close();
      cleanup();
    },
  };
}

describe("static web serving", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  function makeTmpDist(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-dist-"));
    for (const [name, body] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    disposers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("serves index.html at /", async () => {
    const dist = makeTmpDist({
      "index.html": "<!doctype html><title>Claudex</title>",
    });
    const ctx = await bootstrap(dist);
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Claudex");
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("serves hashed assets with long-lived cache headers", async () => {
    const dist = makeTmpDist({
      "index.html": "<html></html>",
      "assets/app.abc123.js": "console.log('hi');",
    });
    const ctx = await bootstrap(dist);
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/assets/app.abc123.js",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/immutable/);
  });

  it("falls back to index.html for SPA routes on GET", async () => {
    const dist = makeTmpDist({
      "index.html": "<!doctype html><title>app</title>",
    });
    const ctx = await bootstrap(dist);
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/session/abc123",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<!doctype html>");
  });

  it("does NOT fall back to index.html for /api/* 404s", async () => {
    const dist = makeTmpDist({
      "index.html": "<html></html>",
    });
    const ctx = await bootstrap(dist);
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/definitely-not-a-route",
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("<html>");
  });

  it("does NOT fall back to index.html on non-GET methods", async () => {
    const dist = makeTmpDist({
      "index.html": "<html></html>",
    });
    const ctx = await bootstrap(dist);
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/session/whatever",
    });
    expect(res.statusCode).toBe(404);
  });

  it("keeps /api/health reachable when static is mounted", async () => {
    const dist = makeTmpDist({
      "index.html": "<html></html>",
    });
    const ctx = await bootstrap(dist);
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("works in the default no-webDist mode (dev)", async () => {
    const ctx = await bootstrap(undefined);
    disposers.push(ctx.cleanup);
    // /api/health still works; / returns whatever Fastify's default 404 is.
    const health = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    const root = await ctx.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(404);
  });
});
