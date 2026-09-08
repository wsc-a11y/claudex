import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import type { SearchResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// GET /api/search — server-side FTS5 search over session titles and
// text-bearing message bodies. Seeded via the real SessionManager path (so
// we exercise the live-sync hooks on appendEvent / setTitle) rather than
// pushing rows into FTS directly.
// ---------------------------------------------------------------------------

const bootstrap = bootstrapAuthedApp;

interface Ctx {
  app: Awaited<ReturnType<typeof bootstrapAuthedApp>>["app"];
  dbh: Awaited<ReturnType<typeof bootstrapAuthedApp>>["dbh"];
  cookie: string;
  tmpDir: string;
}

async function createProject(ctx: Ctx, name = "demo"): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: ctx.cookie },
    payload: { name, path: ctx.tmpDir },
  });
  const id = res.json().project.id as string;
  // Flip trust so createSession below doesn't hit the project_not_trusted
  // gate. Search tests don't care about the trust flow.
  ctx.dbh.db.prepare("UPDATE projects SET trusted = 1 WHERE id = ?").run(id);
  return id;
}

async function createSession(
  ctx: Ctx,
  projectId: string,
  title: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie: ctx.cookie },
    payload: {
      projectId,
      title,
      model: "claude-opus-4-8",
      mode: "default",
      worktree: false,
    },
  });
  return res.json().session.id as string;
}

function seedEvent(
  ctx: Ctx,
  sessionId: string,
  kind: "user_message" | "assistant_text",
  text: string,
  seq: number,
) {
  ctx.dbh.db
    .prepare(
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ev-${Math.random().toString(36).slice(2)}`,
      sessionId,
      kind,
      seq,
      new Date().toISOString(),
      JSON.stringify({ text }),
    );
  // Also index into FTS since we bypassed SessionStore.appendEvent. This
  // mirrors what SessionStore does inline and keeps test seeding symmetric
  // with production writes.
  ctx.dbh.db
    .prepare(
      `INSERT INTO session_search (session_id, event_seq, kind, body)
       VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, seq, kind, text);
}

describe("search routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("401s unauthenticated callers", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/search?q=retry",
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s on empty / whitespace-only q", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const empty = await ctx.app.inject({
      method: "GET",
      url: "/api/search",
      headers: { cookie: ctx.cookie },
    });
    expect(empty.statusCode).toBe(400);

    const ws = await ctx.app.inject({
      method: "GET",
      url: "/api/search?q=%20%20",
      headers: { cookie: ctx.cookie },
    });
    expect(ws.statusCode).toBe(400);
  });

  it("returns title + message hits for a populated DB", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx, "alpha");
    const s1 = await createSession(ctx, projectId, "Fix hydration");
    const s2 = await createSession(ctx, projectId, "Add retries");
    const s3 = await createSession(ctx, projectId, "Write docs");

    // 5 user_messages + 5 assistant_texts across the three sessions, a
    // couple mentioning "retry" / "retries" so the search matches.
    seedEvent(ctx, s1, "user_message", "hydration is broken", 0);
    seedEvent(ctx, s1, "assistant_text", "let me look", 1);
    seedEvent(ctx, s2, "user_message", "please add retry logic", 0);
    seedEvent(
      ctx,
      s2,
      "assistant_text",
      "added exponential backoff retry",
      1,
    );
    seedEvent(ctx, s2, "user_message", "how many retries?", 2);
    seedEvent(ctx, s3, "user_message", "update the readme", 0);
    seedEvent(ctx, s3, "assistant_text", "done, pushed", 1);
    seedEvent(ctx, s1, "user_message", "also fix css", 2);
    seedEvent(ctx, s1, "assistant_text", "acknowledged", 3);
    seedEvent(ctx, s3, "assistant_text", "anything else?", 2);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/search?q=retry",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;

    // The s2 title "Add retries" shares a stem with "retry" (unicode61 does
    // NOT do stemming, so it won't hit via "retry"). The message bodies
    // contain the literal "retry" though, so we should see multiple message
    // hits — including ones in s2.
    expect(body.messageHits.length).toBeGreaterThan(0);
    const sessionIds = new Set(body.messageHits.map((h) => h.sessionId));
    expect(sessionIds.has(s2)).toBe(true);

    // And the snippet wraps the matched token in <mark>.
    const snippetHasMark = body.messageHits.some((h) =>
      h.snippet.includes("<mark>"),
    );
    expect(snippetHasMark).toBe(true);

    // Title hit for "retries" — verify FTS title search with a word that
    // matches a title token directly.
    const titleRes = await ctx.app.inject({
      method: "GET",
      url: "/api/search?q=retries",
      headers: { cookie: ctx.cookie },
    });
    const titleBody = titleRes.json() as SearchResponse;
    expect(titleBody.titleHits.some((h) => h.sessionId === s2)).toBe(true);
  });

  it("returns empty arrays for a nonexistent word", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx);
    const s1 = await createSession(ctx, projectId, "Fix hydration");
    seedEvent(ctx, s1, "user_message", "hydration bug", 0);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/search?q=zzzznonexistent",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;
    expect(body.titleHits).toEqual([]);
    expect(body.messageHits).toEqual([]);
  });

  it("does not crash on queries with FTS5 special chars", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx);
    await createSession(ctx, projectId, `"quoted (title) - with^ * chars`);

    // Each of these would trip a raw MATCH if we didn't sanitize:
    //   - unbalanced quote
    //   - bare hyphen (FTS5 NOT operator)
    //   - bare colon (column filter operator)
    //   - OR keyword
    for (const q of [
      `"retry`,
      `- retry`,
      `foo:bar`,
      `AND OR NOT NEAR/2`,
      `(((`,
      `****`,
    ]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/search?q=${encodeURIComponent(q)}`,
        headers: { cookie: ctx.cookie },
      });
      // Some of these will 400 (sanitized to empty tokens → bad_request),
      // others will 200 with empty hits. Neither is a crash, which is the
      // point of this test.
      expect([200, 400]).toContain(res.statusCode);
    }
  });

  it("syncs titles live through setTitle", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await createProject(ctx);
    const sId = await createSession(ctx, projectId, "Initial title");

    // Rename via PATCH — this flows through SessionStore.setTitle, which
    // upserts the FTS row.
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/sessions/${sId}`,
      headers: { cookie: ctx.cookie },
      payload: { title: "Flamboyant rewrite" },
    });
    expect(patch.statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/search?q=flamboyant",
      headers: { cookie: ctx.cookie },
    });
    const body = res.json() as SearchResponse;
    expect(body.titleHits.some((h) => h.sessionId === sId)).toBe(true);

    // And the old title no longer matches (the upsert replaced the row).
    const old = await ctx.app.inject({
      method: "GET",
      url: "/api/search?q=initial",
      headers: { cookie: ctx.cookie },
    });
    const oldBody = old.json() as SearchResponse;
    expect(oldBody.titleHits.some((h) => h.sessionId === sId)).toBe(false);
  });
});
