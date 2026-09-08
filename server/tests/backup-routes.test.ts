import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp, trustProject } from "./helpers.js";
import { SessionStore } from "../src/sessions/store.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { RoutineStore } from "../src/routines/store.js";
import { QueueStore } from "../src/queue/store.js";
import { AuditStore } from "../src/audit/store.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import { AttachmentStore } from "../src/uploads/store.js";
import { buildBackupBundle } from "../src/backup/export.js";
import { importBackupBundle } from "../src/backup/import.js";
import { openDb } from "../src/db/index.js";
import { tempConfig } from "./helpers.js";

// -----------------------------------------------------------------------------
// backup routes + store round-trip tests
//
// Covers the export/import surface end-to-end:
//   - 401 without auth
//   - export JSON shape + secrets absent
//   - import into empty DB recreates data
//   - sparse bundle (missing optional tables) doesn't crash
//   - duplicate project path is skipped
//   - event seqs are renumbered 1..N per session on import
// -----------------------------------------------------------------------------

const BOUNDARY = "----claudexbackup";

function multipartBundle(jsonStr: string): Buffer {
  const CRLF = "\r\n";
  const head =
    `--${BOUNDARY}${CRLF}` +
    `Content-Disposition: form-data; name="bundle"; filename="bundle.json"${CRLF}` +
    `Content-Type: application/json${CRLF}${CRLF}`;
  const tail = `${CRLF}--${BOUNDARY}--${CRLF}`;
  return Buffer.concat([
    Buffer.from(head, "utf8"),
    Buffer.from(jsonStr, "utf8"),
    Buffer.from(tail, "utf8"),
  ]);
}

/**
 * Seed a little bit of every table — project, trusted, session, events,
 * routine, queued prompt, grant, attachment, audit — against the provided
 * app context. Returns the ids so tests can assert on the specific rows
 * after round-trip.
 */
async function seedDb(ctx: Awaited<ReturnType<typeof bootstrapAuthedApp>>) {
  const projRes = await ctx.app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: ctx.cookie },
    payload: { name: "demo", path: ctx.tmpDir },
  });
  const project = projRes.json().project as { id: string; path: string };
  trustProject(ctx.dbh, project.id);

  const sessions = new SessionStore(ctx.dbh.db);
  const session = sessions.create({
    title: "hello world",
    projectId: project.id,
    model: "claude-opus-4-8",
    mode: "default",
  });
  sessions.appendEvent({
    sessionId: session.id,
    kind: "user_message",
    payload: { text: "hi" },
  });
  sessions.appendEvent({
    sessionId: session.id,
    kind: "assistant_text",
    payload: { text: "hello" },
  });

  const routines = new RoutineStore(ctx.dbh.db);
  const routine = routines.create({
    name: "nightly",
    projectId: project.id,
    prompt: "check tests",
    cronExpr: "0 3 * * *",
    model: "claude-opus-4-8",
    mode: "default",
  });

  const queue = new QueueStore(ctx.dbh.db);
  const queued = queue.create({
    projectId: project.id,
    prompt: "deploy",
    title: "deploy job",
    model: "claude-opus-4-8",
    mode: "default",
    worktree: false,
  });

  const grants = new ToolGrantStore(ctx.dbh.db);
  grants.addSessionGrant(session.id, "Bash", "ls -la");

  const attachments = new AttachmentStore(ctx.dbh.db);
  const attachment = attachments.insertUnlinked({
    sessionId: session.id,
    filename: "note.txt",
    mime: "text/plain",
    sizeBytes: 12,
    path: "/tmp/fake-note.txt",
  });

  const audit = new AuditStore(ctx.dbh.db);
  audit.append({ event: "login", detail: "seed" });

  return { project, session, routine, queued, attachment };
}

describe("backup routes — export", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("401 on GET without auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({ method: "GET", url: "/api/export/all" });
    expect(res.statusCode).toBe(401);
  });

  it("401 on POST without auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/import/all",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBundle("{}"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns a well-formed JSON bundle populated with seed rows", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const seed = await seedDb(ctx);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/export/all",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(String(res.headers["content-disposition"])).toMatch(
      /attachment; filename="claudex-backup-.*\.json"/,
    );
    const body = res.json();
    expect(typeof body.claudexVersion).toBe("string");
    expect(typeof body.exportedAt).toBe("string");
    expect(body.projects.map((p: { id: string }) => p.id)).toContain(
      seed.project.id,
    );
    expect(body.sessions.map((s: { id: string }) => s.id)).toContain(
      seed.session.id,
    );
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.routines.map((r: { id: string }) => r.id)).toContain(
      seed.routine.id,
    );
    expect(body.queue.map((q: { id: string }) => q.id)).toContain(
      seed.queued.id,
    );
    expect(body.attachments.map((a: { id: string }) => a.id)).toContain(
      seed.attachment.id,
    );
    expect(Array.isArray(body.audit)).toBe(true);
    expect(body.audit.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT include secret material anywhere in the export payload", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    await seedDb(ctx);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/export/all",
      headers: { cookie: ctx.cookie },
    });
    const body = JSON.stringify(res.json());
    // Audit / table-level: no password/TOTP/recovery artifacts should ever
    // appear in the serialized JSON. We check both key names and the actual
    // sensitive row values from the DB.
    const forbiddenKeys = [
      "password_hash",
      "passwordHash",
      "totp_secret",
      "totpSecret",
      "code_hash",
      "codeHash",
      "p256dh",
      "jwtSecret",
      "vapidPrivate",
      "privateKey",
    ];
    for (const k of forbiddenKeys) {
      expect(body.includes(`"${k}"`)).toBe(false);
    }
    // Pull the real password hash + totp secret from the users row and
    // verify they are nowhere in the output — belt-and-braces against a
    // future refactor that renames the column.
    const user = ctx.dbh.db
      .prepare("SELECT password_hash, totp_secret FROM users LIMIT 1")
      .get() as { password_hash: string; totp_secret: string };
    expect(body.includes(user.password_hash)).toBe(false);
    expect(body.includes(user.totp_secret)).toBe(false);
  });
});

describe("backup routes — import", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("importing own export into a fresh DB recreates projects, sessions, events, routines, queue, audit", async () => {
    // Build source DB with a seed.
    const src = await bootstrapAuthedApp();
    disposers.push(src.cleanup);
    const seed = await seedDb(src);
    const getRes = await src.app.inject({
      method: "GET",
      url: "/api/export/all",
      headers: { cookie: src.cookie },
    });
    const bundle = getRes.body;

    // Fresh target.
    const tgt = await bootstrapAuthedApp();
    disposers.push(tgt.cleanup);

    const imp = await tgt.app.inject({
      method: "POST",
      url: "/api/import/all",
      headers: {
        cookie: tgt.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBundle(bundle),
    });
    expect(imp.statusCode).toBe(200);
    const body = imp.json();
    expect(body.imported.projects).toBe(1);
    expect(body.imported.sessions).toBe(1);
    expect(body.imported.events).toBeGreaterThanOrEqual(2);
    expect(body.imported.routines).toBe(1);
    expect(body.imported.queue).toBe(1);
    // Audit rows are NEVER imported from an untrusted bundle — they carry
    // attacker-chosen event/ip/user_agent strings. imported.audit must
    // stay at zero; skipped.audit surfaces the count that was rejected.
    expect(body.imported.audit).toBe(0);
    expect(body.skipped.audit).toBeDefined();
    expect(body.skipped.audit.count).toBeGreaterThanOrEqual(1);
    expect(body.skipped.audit.reason).toMatch(/audit rows never imported/);
    // Confirm at the DB level that no audit rows from the bundle landed in
    // the target's audit table. The target does have its own audit trail
    // (the user's /api/import/all request itself logs one), so we compare
    // against the seed's specific "login" detail="seed" row.
    const forgedCount = tgt.dbh.db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE event = 'login' AND detail = 'seed'",
      )
      .get() as { n: number };
    expect(forgedCount.n).toBe(0);
    // Grants + attachments skipped by policy.
    expect(body.skipped.grants).toBeGreaterThanOrEqual(1);
    expect(body.skipped.attachments).toBeGreaterThanOrEqual(1);

    // Target tables should contain the expected rows.
    const tgtProjects = new ProjectStore(tgt.dbh.db).list();
    expect(tgtProjects.some((p) => p.path === seed.project.path)).toBe(true);
    const tgtSessions = new SessionStore(tgt.dbh.db).list({
      includeArchived: true,
    });
    expect(tgtSessions.some((s) => s.title === "hello world")).toBe(true);

    // FTS sync: the imported user/assistant text must be searchable. The
    // seed inserts "hi" and "hello" via sessions.appendEvent on the source;
    // after import, the target's /api/search should find them.
    const searchRes = await tgt.app.inject({
      method: "GET",
      url: "/api/search?q=" + encodeURIComponent("hello"),
      headers: { cookie: tgt.cookie },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchBody = searchRes.json() as {
      titleHits: Array<{ title: string }>;
      messageHits: Array<{ snippet: string }>;
    };
    const hasHit =
      searchBody.titleHits.some((h) => /hello/i.test(h.title)) ||
      searchBody.messageHits.some((h) => /hello/i.test(h.snippet));
    expect(hasHit).toBe(true);
  });

  it("import tolerates a partial bundle with missing optional tables", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    // Minimal bundle — no routines, no queue, no audit, no grants,
    // no attachments, no events. Just a single project + no sessions.
    const minimal = {
      claudexVersion: "0.0.1",
      exportedAt: new Date().toISOString(),
      projects: [
        {
          id: "p-min",
          name: "min",
          path: "/tmp/claudex-min-import",
          trusted: false,
          createdAt: new Date().toISOString(),
        },
      ],
      sessions: [],
      events: [],
      // Intentionally omit routines/queue/grants/attachments to verify the
      // coercer falls back to [] rather than blowing up on `undefined.length`.
    };
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/import/all",
      headers: {
        cookie: ctx.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBundle(JSON.stringify(minimal)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported.projects).toBe(1);
    expect(body.imported.sessions).toBe(0);
    expect(body.imported.events).toBe(0);
    expect(body.imported.routines).toBe(0);
  });

  it("duplicate project path is skipped; children remap to the existing local project", async () => {
    // Direct-store variant — exercises importBackupBundle so we don't have
    // to spin up two separate apps just for this assertion.
    const { config, log, cleanup } = tempConfig();
    const dbh = openDb(config, log);
    try {
      // Pre-populate a project with path X.
      const projects = new ProjectStore(dbh.db);
      const local = projects.create({
        name: "local",
        path: "/tmp/claudex-shared-path",
        trusted: true,
      });
      // Bundle carries a project with the same path under a different id,
      // plus a session that references it.
      const bundle = {
        claudexVersion: "0.0.1",
        exportedAt: new Date().toISOString(),
        projects: [
          {
            id: "p-bundle",
            name: "from-bundle",
            path: "/tmp/claudex-shared-path",
            trusted: true,
            createdAt: new Date().toISOString(),
          },
        ],
        sessions: [
          {
            id: "s-bundle",
            title: "imported",
            projectId: "p-bundle",
            branch: null,
            worktreePath: null,
            status: "idle",
            model: "claude-opus-4-8",
            mode: "default",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastMessageAt: null,
            archivedAt: null,
            sdkSessionId: null,
            parentSessionId: null,
            cliJsonlSeq: 0,
            stats: {
              messages: 0,
              filesChanged: 0,
              linesAdded: 0,
              linesRemoved: 0,
              contextPct: 0,
            },
          },
        ],
        events: [],
        routines: [],
        queue: [],
        grants: [],
        attachments: [],
      };
      const res = importBackupBundle(dbh.db, bundle as any, {
        claudexVersion: "0.0.1",
      });
      expect(res.imported.projects).toBe(0); // dedupe
      expect(res.skipped.projectsByPath).toBe(1);
      expect(res.imported.sessions).toBe(1);
      // The newly imported session should live under the local project id.
      const sessions = new SessionStore(dbh.db).list({ includeArchived: true });
      const imported = sessions.find((s) => s.title === "imported");
      expect(imported).toBeDefined();
      expect(imported!.projectId).toBe(local.id);
    } finally {
      dbh.close();
      cleanup();
    }
  });

  it("event seqs are rewritten to 1..N per session on import", async () => {
    const { config, log, cleanup } = tempConfig();
    const dbh = openDb(config, log);
    try {
      const now = new Date();
      // Build a bundle with gappy source seqs (5, 17, 42) — the import
      // path should collapse those to 1, 2, 3 in the target.
      const bundle = {
        claudexVersion: "0.0.1",
        exportedAt: now.toISOString(),
        projects: [
          {
            id: "p-seq",
            name: "seq",
            path: "/tmp/claudex-seq-path",
            trusted: true,
            createdAt: now.toISOString(),
          },
        ],
        sessions: [
          {
            id: "s-seq",
            title: "seq-test",
            projectId: "p-seq",
            branch: null,
            worktreePath: null,
            status: "idle",
            model: "claude-opus-4-8",
            mode: "default",
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            lastMessageAt: null,
            archivedAt: null,
            sdkSessionId: null,
            parentSessionId: null,
            cliJsonlSeq: 0,
            stats: {
              messages: 0,
              filesChanged: 0,
              linesAdded: 0,
              linesRemoved: 0,
              contextPct: 0,
            },
          },
        ],
        events: [
          {
            id: "e-1",
            sessionId: "s-seq",
            kind: "user_message",
            seq: 5,
            createdAt: new Date(now.getTime() + 1).toISOString(),
            payload: { text: "one" },
          },
          {
            id: "e-2",
            sessionId: "s-seq",
            kind: "assistant_text",
            seq: 17,
            createdAt: new Date(now.getTime() + 2).toISOString(),
            payload: { text: "two" },
          },
          {
            id: "e-3",
            sessionId: "s-seq",
            kind: "assistant_text",
            seq: 42,
            createdAt: new Date(now.getTime() + 3).toISOString(),
            payload: { text: "three" },
          },
        ],
        routines: [],
        queue: [],
        grants: [],
        attachments: [],
      };
      const res = importBackupBundle(dbh.db, bundle as any, {
        claudexVersion: "0.0.1",
      });
      expect(res.imported.events).toBe(3);
      const sessionId = (
        new SessionStore(dbh.db).list({ includeArchived: true })[0] as {
          id: string;
        }
      ).id;
      const events = new SessionStore(dbh.db).listEvents(sessionId);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(events.map((e) => (e.payload as { text: string }).text)).toEqual([
        "one",
        "two",
        "three",
      ]);
    } finally {
      dbh.close();
      cleanup();
    }
  });

  it("round-trip via the direct export helper yields parse-equal JSON", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    await seedDb(ctx);
    const bundle = buildBackupBundle(ctx.dbh.db, { claudexVersion: "0.0.1" });
    const roundTrip = JSON.parse(JSON.stringify(bundle));
    expect(roundTrip.projects.length).toBe(bundle.projects.length);
    expect(roundTrip.sessions.length).toBe(bundle.sessions.length);
    expect(roundTrip.events.length).toBe(bundle.events.length);
  });

  it("invalid individual rows are dropped by coerceBundle; valid siblings still import", async () => {
    // Regression guard for the per-item zod validation pass in coerceBundle.
    // Previously every array was cast wholesale (`v as T[]`), meaning a
    // single bogus `events` row would flow straight into importBackupBundle
    // and crash it. The fix parses each row with the matching schema and
    // drops the bad ones silently. Here we feed a bundle where `events[2]`
    // is garbage (`{bogus: "data"}`) — we expect the two valid events to
    // import normally, and the garbage one to disappear.
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const now = new Date();
    const mixedBundle = {
      claudexVersion: "0.0.1",
      exportedAt: now.toISOString(),
      projects: [
        {
          id: "p-mixed",
          name: "mixed",
          path: "/tmp/claudex-mixed-path",
          trusted: true,
          createdAt: now.toISOString(),
        },
      ],
      sessions: [
        {
          id: "s-mixed",
          title: "mixed-test",
          projectId: "p-mixed",
          branch: null,
          worktreePath: null,
          status: "idle",
          model: "claude-opus-4-8",
          mode: "default",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          lastMessageAt: null,
          archivedAt: null,
          sdkSessionId: null,
          parentSessionId: null,
          forkedFromSessionId: null,
          cliJsonlSeq: 0,
          stats: {
            messages: 0,
            filesChanged: 0,
            linesAdded: 0,
            linesRemoved: 0,
            contextPct: 0,
          },
        },
      ],
      events: [
        {
          id: "e-good-1",
          sessionId: "s-mixed",
          kind: "user_message",
          seq: 1,
          createdAt: new Date(now.getTime() + 1).toISOString(),
          payload: { text: "first" },
        },
        {
          id: "e-good-2",
          sessionId: "s-mixed",
          kind: "assistant_text",
          seq: 2,
          createdAt: new Date(now.getTime() + 2).toISOString(),
          payload: { text: "second" },
        },
        // events[2] — intentionally malformed; the per-item parse must drop
        // this without poisoning the surrounding valid rows.
        { bogus: "data" } as unknown,
      ],
      routines: [],
      queue: [],
      grants: [],
      attachments: [],
    };
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/import/all",
      headers: {
        cookie: ctx.cookie,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBundle(JSON.stringify(mixedBundle)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported.projects).toBe(1);
    expect(body.imported.sessions).toBe(1);
    // Two of three events survive; the bogus entry is silently dropped.
    expect(body.imported.events).toBe(2);
  });
});
