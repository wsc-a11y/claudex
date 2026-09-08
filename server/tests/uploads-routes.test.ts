import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bootstrapAuthedApp } from "./helpers.js";

// -----------------------------------------------------------------------------
// Uploads / attachment route tests.
//
// Covers the lifecycle: upload a file via POST /api/sessions/:id/attachments,
// fetch it back via GET /api/attachments/:id/raw, DELETE an unlinked
// attachment, and the guardrails (auth, 415 unsupported mime, 413 too large,
// 404 for linked attachments on DELETE).
//
// Multipart bodies are hand-rolled — the test harness uses Fastify's
// `inject()`, not a real HTTP client, and we don't want to pull in `form-data`
// just for this.
// -----------------------------------------------------------------------------

const BOUNDARY = "----claudextest";

function multipartBody(filename: string, mime: string, bytes: Buffer): Buffer {
  const CRLF = "\r\n";
  const head =
    `--${BOUNDARY}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mime}${CRLF}${CRLF}`;
  const tail = `${CRLF}--${BOUNDARY}--${CRLF}`;
  return Buffer.concat([Buffer.from(head, "utf8"), bytes, Buffer.from(tail, "utf8")]);
}

async function createSessionFixture(ctx: {
  app: import("fastify").FastifyInstance;
  cookie: string;
  tmpDir: string;
  dbh: import("../src/db/index.js").ClaudexDb;
}) {
  // Project + session — the simplest fixture that uploads hang off of.
  const projRes = await ctx.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: ctx.cookie },
    payload: { name: "demo", path: ctx.tmpDir },
  });
  const project = projRes.json().project as { id: string };
  // Trust: these tests are about the upload surface, not the trust gate.
  ctx.dbh.db
    .prepare("UPDATE projects SET trusted = 1 WHERE id = ?")
    .run(project.id);
  const sesRes = await ctx.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie: ctx.cookie },
    payload: {
      projectId: project.id,
      title: "uploads",
      model: "claude-opus-4-8",
      mode: "default",
      worktree: false,
    },
  });
  return sesRes.json().session as { id: string };
}

describe("uploads routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("rejects upload without auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions/fake/attachments",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("a.txt", "text/plain", Buffer.from("hi")),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects raw GET without auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/attachments/xyz/raw",
    });
    expect(res.statusCode).toBe(401);
  });

  it("415 on unsupported mime", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const session = await createSessionFixture(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments`,
      headers: {
        cookie: ctx.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("x.bin", "application/octet-stream", Buffer.from([1, 2, 3])),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("unsupported_mime");
  });

  it("413 on oversize file (>5MB)", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const session = await createSessionFixture(ctx);
    // 6 MB buffer — well above the 5MB per-file cap enforced by
    // @fastify/multipart's limit.fileSize (also 5MB for per-request).
    const big = Buffer.alloc(6 * 1024 * 1024, 0x41);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments`,
      headers: {
        cookie: ctx.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("big.txt", "text/plain", big),
    });
    // Fastify may surface multipart limit as 413 from the handler OR as the
    // plugin's own rejection; both are acceptable failure modes.
    expect([413, 400]).toContain(res.statusCode);
  });

  it("upload → GET raw round-trip returns identical bytes", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const session = await createSessionFixture(ctx);
    const bytes = Buffer.from("hello from uploads test");
    const upload = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments`,
      headers: {
        cookie: ctx.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("greet.txt", "text/plain", bytes),
    });
    expect(upload.statusCode).toBe(200);
    const body = upload.json() as {
      id: string;
      filename: string;
      mime: string;
      size: number;
      previewUrl?: string;
    };
    expect(body.filename).toBe("greet.txt");
    expect(body.mime).toBe("text/plain");
    expect(body.size).toBe(bytes.length);
    // Non-image → no previewUrl
    expect(body.previewUrl).toBeUndefined();

    const raw = await ctx.app.inject({
      method: "GET",
      url: `/api/attachments/${body.id}/raw`,
      headers: { cookie: ctx.cookie },
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toBe("text/plain");
    expect(raw.rawPayload.equals(bytes)).toBe(true);
  });

  it("image upload populates previewUrl", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const session = await createSessionFixture(ctx);
    // 1x1 PNG
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001d51c8f720000000049454e44ae426082",
      "hex",
    );
    const upload = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments`,
      headers: {
        cookie: ctx.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("pixel.png", "image/png", png),
    });
    expect(upload.statusCode).toBe(200);
    const body = upload.json() as { id: string; previewUrl?: string };
    expect(body.previewUrl).toBe(`/api/attachments/${body.id}/raw`);
  });

  it("DELETE unlinked attachment removes the row + file", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const session = await createSessionFixture(ctx);
    const bytes = Buffer.from("throwaway");
    const upload = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments`,
      headers: {
        cookie: ctx.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("gone.txt", "text/plain", bytes),
    });
    const { id } = upload.json() as { id: string };

    // Locate the on-disk file for a smoke check.
    const row = ctx.dbh.db
      .prepare("SELECT path FROM attachments WHERE id = ?")
      .get(id) as { path: string };
    expect(fs.existsSync(row.path)).toBe(true);

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/attachments/${id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(del.statusCode).toBe(204);
    expect(fs.existsSync(row.path)).toBe(false);
    // Second delete → 404
    const del2 = await ctx.app.inject({
      method: "DELETE",
      url: `/api/attachments/${id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(del2.statusCode).toBe(404);
  });

  it("DELETE linked attachment returns 404", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const session = await createSessionFixture(ctx);
    const upload = await ctx.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments`,
      headers: {
        cookie: ctx.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("linked.txt", "text/plain", Buffer.from("x")),
    });
    const { id } = upload.json() as { id: string };

    // Simulate the link step that SessionManager.sendUserMessage does —
    // stamp the row with message_event_seq = 0 so the DELETE branch that
    // refuses "already sent" attachments triggers.
    ctx.dbh.db
      .prepare("UPDATE attachments SET message_event_seq = 0 WHERE id = ?")
      .run(id);

    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/attachments/${id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(del.statusCode).toBe(404);
  });

  it("migration id=7 created the attachments table with expected columns", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const cols = ctx.dbh.db
      .prepare("PRAGMA table_info(attachments)")
      .all() as Array<{ name: string; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "id",
        "session_id",
        "message_event_seq",
        "filename",
        "mime",
        "size_bytes",
        "path",
        "created_at",
      ].sort(),
    );
    const migRow = ctx.dbh.db
      .prepare("SELECT * FROM _migrations WHERE id = 7")
      .get() as { id: number; name: string } | undefined;
    expect(migRow?.name).toBe("attachments");
  });
});
