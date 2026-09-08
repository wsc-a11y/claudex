import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapAuthedApp } from "./helpers.js";

function mkTmp(prefix: string, disposers: Array<() => void>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  disposers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedCliSession(
  root: string,
  slug: string,
  sessionId: string,
  userMsg: string,
): void {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "queue-operation" }) +
      "\n" +
      JSON.stringify({
        type: "user",
        message: { role: "user", content: userMsg },
      }) +
      "\n",
  );
}

describe("CLI session HTTP routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  const fsDisposers: Array<() => void> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
    while (fsDisposers.length) fsDisposers.pop()!();
  });

  describe("GET /api/cli/sessions", () => {
    it("rejects unauthenticated access", async () => {
      const root = mkTmp("claudex-cli-root-", fsDisposers);
      const ctx = await bootstrapAuthedApp(undefined, {
        cliProjectsRoot: root,
      });
      disposers.push(ctx.cleanup);

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/cli/sessions",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns the discovered session list for the authed caller", async () => {
      const root = mkTmp("claudex-cli-root-", fsDisposers);
      seedCliSession(root, "-tmp-proj", "uuid-xyz", "hello from cli");
      const ctx = await bootstrapAuthedApp(undefined, {
        cliProjectsRoot: root,
      });
      disposers.push(ctx.cleanup);

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/cli/sessions",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("uuid-xyz");
      expect(body.sessions[0].cwd).toBe("/tmp/proj");
      expect(body.sessions[0].title).toBe("hello from cli");
    });

    it("hides sessions that are already adopted", async () => {
      const root = mkTmp("claudex-cli-root-", fsDisposers);
      seedCliSession(root, "-tmp-proj", "uuid-adopt", "already mine");
      const ctx = await bootstrapAuthedApp(undefined, {
        cliProjectsRoot: root,
      });
      disposers.push(ctx.cleanup);

      // Adopt it first.
      const imported = await ctx.app.inject({
        method: "POST",
        url: "/api/cli/sessions/import",
        headers: { cookie: ctx.cookie },
        payload: { sessionIds: ["uuid-adopt"] },
      });
      expect(imported.statusCode).toBe(200);

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/cli/sessions",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions).toEqual([]);
    });
  });

  describe("POST /api/cli/sessions/import", () => {
    it("rejects unauthenticated access", async () => {
      const root = mkTmp("claudex-cli-root-", fsDisposers);
      const ctx = await bootstrapAuthedApp(undefined, {
        cliProjectsRoot: root,
      });
      disposers.push(ctx.cleanup);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/cli/sessions/import",
        payload: { sessionIds: ["x"] },
      });
      expect(res.statusCode).toBe(401);
    });

    it("400s on an empty sessionIds array", async () => {
      const root = mkTmp("claudex-cli-root-", fsDisposers);
      const ctx = await bootstrapAuthedApp(undefined, {
        cliProjectsRoot: root,
      });
      disposers.push(ctx.cleanup);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/cli/sessions/import",
        headers: { cookie: ctx.cookie },
        payload: { sessionIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it("adopts a discovered session and returns the new row", async () => {
      const root = mkTmp("claudex-cli-root-", fsDisposers);
      seedCliSession(root, "-work-proj", "uuid-import", "make a readme");
      const ctx = await bootstrapAuthedApp(undefined, {
        cliProjectsRoot: root,
      });
      disposers.push(ctx.cleanup);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/cli/sessions/import",
        headers: { cookie: ctx.cookie },
        payload: { sessionIds: ["uuid-import"] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.imported).toHaveLength(1);
      expect(body.imported[0].sdkSessionId).toBe("uuid-import");
      expect(body.imported[0].title).toBe("make a readme");

      // The session should now show up under /api/sessions too.
      const sess = await ctx.app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
      });
      expect(sess.statusCode).toBe(200);
      expect(sess.json().sessions).toHaveLength(1);
    });

    it("is idempotent across multiple imports of the same id", async () => {
      const root = mkTmp("claudex-cli-root-", fsDisposers);
      seedCliSession(root, "-idem-proj", "uuid-idem", "dedup me");
      const ctx = await bootstrapAuthedApp(undefined, {
        cliProjectsRoot: root,
      });
      disposers.push(ctx.cleanup);

      const once = await ctx.app.inject({
        method: "POST",
        url: "/api/cli/sessions/import",
        headers: { cookie: ctx.cookie },
        payload: { sessionIds: ["uuid-idem"] },
      });
      const twice = await ctx.app.inject({
        method: "POST",
        url: "/api/cli/sessions/import",
        headers: { cookie: ctx.cookie },
        payload: { sessionIds: ["uuid-idem"] },
      });
      expect(once.statusCode).toBe(200);
      expect(twice.statusCode).toBe(200);
      expect(once.json().imported[0].id).toBe(twice.json().imported[0].id);

      const sess = await ctx.app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
      });
      expect(sess.json().sessions).toHaveLength(1);
    });
  });
});
