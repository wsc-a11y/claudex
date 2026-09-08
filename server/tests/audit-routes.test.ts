import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { AuditStore } from "../src/audit/store.js";
import { bootstrapAuthedApp } from "./helpers.js";

// -----------------------------------------------------------------------------
// Audit-route tests
//
// We lean on bootstrapAuthedApp (which wires AuditStore via buildApp) so the
// store is the same instance the routes see. Direct `audit.append` calls stand
// in for wiring that lives in auth/session/push routes — those paths are
// covered by their own suites, here we just verify the GET route returns what
// was appended.
// -----------------------------------------------------------------------------

describe("audit routes", () => {
  let env: Awaited<ReturnType<typeof bootstrapAuthedApp>>;
  let audit: AuditStore;

  beforeEach(async () => {
    env = await bootstrapAuthedApp();
    // bootstrapAuthedApp performs a real login which writes an audit row
    // before every `it` block. Start from a clean slate so row counts match
    // what each test explicitly appended.
    env.dbh.db.prepare("DELETE FROM audit_events").run();
    // Same db handle buildApp used — the store is stateless other than the
    // db pointer, so a fresh instance here writes to the same table.
    audit = new AuditStore(env.dbh.db);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("rejects GET without auth cookie", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(401);
  });

  it("returns appended rows newest-first", async () => {
    audit.append({ event: "login_failed", detail: "a", ip: "1.1.1.1" });
    audit.append({ event: "login", detail: "b" });
    audit.append({ event: "logout", detail: "c" });

    const res = await env.app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCount).toBe(3);
    expect(body.events).toHaveLength(3);
    // Newest-first — last appended (`logout`) comes first.
    expect(body.events.map((e: { event: string }) => e.event)).toEqual([
      "logout",
      "login",
      "login_failed",
    ]);
    // The login_failed row preserved its ip.
    const failed = body.events.find(
      (e: { event: string }) => e.event === "login_failed",
    );
    expect(failed.ip).toBe("1.1.1.1");
    expect(failed.user).toBeNull();
  });

  it("filters by the events query parameter", async () => {
    audit.append({ event: "login", detail: "a" });
    audit.append({ event: "logout", detail: "b" });
    audit.append({ event: "password_changed", detail: "c" });

    const res = await env.app.inject({
      method: "GET",
      url: "/api/audit?events=login,password_changed",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.events.map((e: { event: string }) => e.event).sort();
    expect(names).toEqual(["login", "password_changed"]);
    // totalCount respects the filter — the Security card's header renders
    // "N events · past 30 days" for whatever filter the UI currently
    // applies, so totalCount is the match count for that filter (2 here),
    // not the table-wide row count (3).
    expect(body.totalCount).toBe(2);
  });

  it("countFiltered on a bulk-seeded table returns the filtered total, not the table size", async () => {
    // Seed 10 A events + 5 B events; ?events=A should return 10 rows inline
    // (all fit under the 200 cap) and totalCount=10 (NOT 15).
    for (let i = 0; i < 10; i += 1) {
      audit.append({ event: "login", detail: `a-${i}` });
    }
    for (let i = 0; i < 5; i += 1) {
      audit.append({ event: "logout", detail: `b-${i}` });
    }
    const res = await env.app.inject({
      method: "GET",
      url: "/api/audit?events=login",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(10);
    expect(body.totalCount).toBe(10);
  });

  it("caps limit at 200 even when a bigger value is requested", async () => {
    // Seed 205 rows — tight loop, SQLite handles this in <100ms.
    for (let i = 0; i < 205; i += 1) {
      audit.append({ event: "login", detail: `burst-${i}` });
    }
    const res = await env.app.inject({
      method: "GET",
      url: "/api/audit?limit=500",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(200);
    expect(body.totalCount).toBe(205);
  });

  it("paginates via the before=<iso> cursor", async () => {
    // Seed 100 rows with staggered, strictly-increasing createdAt so the
    // DESC ordering is unambiguous (appending in a tight loop can coin-flip
    // two rows with the same ms-truncated ISO string). We go straight to the
    // DB to set created_at explicitly — the public API deliberately stamps
    // "now" so it can't help us here.
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const insert = env.dbh.db.prepare(
      `INSERT INTO audit_events
         (id, user_id, event, target, detail, ip, user_agent, created_at)
       VALUES (?, NULL, 'login', NULL, ?, NULL, NULL, ?)`,
    );
    for (let i = 0; i < 100; i += 1) {
      const ts = new Date(base + i * 1000).toISOString();
      insert.run(`evt-${String(i).padStart(3, "0")}`, `n=${i}`, ts);
    }

    // First page: newest 50 (details "n=99" … "n=50").
    const first = await env.app.inject({
      method: "GET",
      url: "/api/audit?limit=50",
      headers: { cookie: env.cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.events).toHaveLength(50);
    expect(firstBody.totalCount).toBe(100);
    expect(firstBody.events[0].detail).toBe("n=99");
    expect(firstBody.events[49].detail).toBe("n=50");

    // Second page: rows strictly older than the 50th row's createdAt —
    // "n=49" … "n=0". totalCount stays at 100 (absolute, not page-scoped).
    const cursor = firstBody.events[49].createdAt as string;
    const second = await env.app.inject({
      method: "GET",
      url: `/api/audit?limit=50&before=${encodeURIComponent(cursor)}`,
      headers: { cookie: env.cookie },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.events).toHaveLength(50);
    expect(secondBody.totalCount).toBe(100);
    expect(secondBody.events[0].detail).toBe("n=49");
    expect(secondBody.events[49].detail).toBe("n=0");
    // No overlap with the first page.
    const firstIds = new Set(
      (firstBody.events as Array<{ id: string }>).map((e) => e.id),
    );
    for (const row of secondBody.events as Array<{ id: string }>) {
      expect(firstIds.has(row.id)).toBe(false);
    }
  });

  it("records a password_changed row after a real change-password call", async () => {
    // Drive the actual route rather than calling .append directly — we want
    // to confirm the wire-in in auth/routes.ts fires. bootstrapAuthedApp
    // left the user with password "hunter22-please-work".
    const res = await env.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: env.cookie },
      payload: {
        currentPassword: "hunter22-please-work",
        newPassword: "brand-new-pass-9",
      },
    });
    expect(res.statusCode).toBe(200);

    const list = await env.app.inject({
      method: "GET",
      url: "/api/audit?events=password_changed",
      headers: { cookie: env.cookie },
    });
    const body = list.json();
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    const row = body.events[0];
    expect(row.event).toBe("password_changed");
    // userId was threaded in by the route — the user object is resolved via
    // UserStore.findById so this hits the lookup path too.
    expect(row.user).not.toBeNull();
    expect(row.user.username).toBe("hao");
  });

  // ---------------------------------------------------------------------
  // Defense in depth: audit rows are visible to any authed user (single-user
  // deployment today, but still — the Security tab renders them verbatim).
  // A `detail` string or a `userAgent` crafted by an attacker must never
  // leak DB-side secrets (password_hash / totp_secret / recovery code hash)
  // by reflection or by accident. These tests confirm:
  //   1. A caller-supplied detail that itself contains the literal string
  //      "password: secretpass" is stored (audit detail is free-form) but
  //      the response never carries a `password_hash` or `totp_secret`
  //      field, and the row is otherwise unaltered.
  //   2. For every event kind the server emits itself (login, login_failed,
  //      totp_failed, password_changed, etc.), the resulting audit row's
  //      free-form fields don't carry raw secrets copied out of the user
  //      row.
  // ---------------------------------------------------------------------
  it("audit rows do not leak password_hash / totp_secret / recovery_code_hash fields", async () => {
    // Caller-supplied detail that looks like a secret string.
    audit.append({
      event: "login",
      detail: "password: secretpass",
      userAgent: "totp_secret=ABCDEFGHIJK",
    });
    const listRes = await env.app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: env.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json() as {
      events: Array<Record<string, unknown>>;
    };
    expect(body.events.length).toBeGreaterThanOrEqual(1);

    // The actual password hash + totp secret for the bootstrapped user.
    const userRow = env.dbh.db
      .prepare("SELECT password_hash, totp_secret FROM users LIMIT 1")
      .get() as { password_hash: string; totp_secret: string };
    expect(userRow.password_hash).toBeTruthy();
    expect(userRow.totp_secret).toBeTruthy();

    const serialized = JSON.stringify(body);
    // No row should ever surface the user's actual password_hash or TOTP
    // secret — even if the caller stuffed a decoy secret string into the
    // detail. Substring check because the secrets are opaque + unique
    // enough that a false positive is effectively impossible.
    expect(serialized).not.toContain(userRow.password_hash);
    expect(serialized).not.toContain(userRow.totp_secret);

    // None of the exposed fields should include the keys we care about.
    for (const row of body.events) {
      expect(Object.keys(row)).not.toContain("password_hash");
      expect(Object.keys(row)).not.toContain("totp_secret");
      expect(Object.keys(row)).not.toContain("recovery_code_hash");
      if (row.user && typeof row.user === "object") {
        expect(Object.keys(row.user as Record<string, unknown>)).not.toContain(
          "password_hash",
        );
        expect(Object.keys(row.user as Record<string, unknown>)).not.toContain(
          "totp_secret",
        );
      }
    }

    // The stored detail roundtripped — the store clips at 140 chars but
    // doesn't redact ("password: secretpass" is 20 chars so it survives).
    const match = body.events.find((e) => e.event === "login");
    expect(match).toBeDefined();
    expect(match!.detail).toBe("password: secretpass");
  });

  it("fires-then-audits every emitted event kind without leaking the user row's secrets", async () => {
    // Drive the auth routes that emit the non-detail events we care about,
    // then do a broad substring check on the whole audit list. The core
    // invariant: no matter which kind fired, the response must never echo
    // back the user's password_hash or totp_secret.
    //
    // 1. login_failed (bad password)
    await env.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "hao", password: "wrong-password" },
    });
    // 2. totp_failed (valid password, bad TOTP)
    const login = await env.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "hao", password: "hunter22-please-work" },
    });
    const challengeId = login.json().challengeId as string;
    await env.app.inject({
      method: "POST",
      url: "/api/auth/verify-totp",
      payload: { challengeId, code: "000000" },
    });
    // 3. password_changed (real path, via the already-authed cookie)
    await env.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: env.cookie },
      payload: {
        currentPassword: "hunter22-please-work",
        newPassword: "rotate-once-please",
      },
    });
    // 4. logout
    await env.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: env.cookie },
    });
    // 5. session_deleted — append directly (the route path is covered by
    // session-routes.test.ts; here we're just confirming the kind doesn't
    // leak, same as every other kind).
    audit.append({
      event: "session_deleted",
      target: "sess-ghost",
      detail: "deleted",
    });
    // 6. permission_granted — append directly (same rationale).
    audit.append({
      event: "permission_granted",
      target: "sess-xyz",
      detail: "tool=Bash",
    });

    // Post-change, the DB now holds the new password hash. Grab both old
    // and new — the response must leak neither.
    const userRow = env.dbh.db
      .prepare("SELECT password_hash, totp_secret FROM users LIMIT 1")
      .get() as { password_hash: string; totp_secret: string };

    const listRes = await env.app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: env.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json();
    const kinds = new Set(
      (body.events as Array<{ event: string }>).map((e) => e.event),
    );
    // Sanity: every kind we intentionally fired shows up in the list.
    expect(kinds.has("login_failed")).toBe(true);
    expect(kinds.has("totp_failed")).toBe(true);
    expect(kinds.has("password_changed")).toBe(true);
    expect(kinds.has("logout")).toBe(true);
    expect(kinds.has("session_deleted")).toBe(true);
    expect(kinds.has("permission_granted")).toBe(true);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(userRow.password_hash);
    expect(serialized).not.toContain(userRow.totp_secret);
    // Raw bcrypt hashes start with "$2" — a broad substring check catches
    // any accidental hash leak even if the in-memory hash rotated since we
    // snapshot'd it above.
    expect(serialized).not.toMatch(/\$2[aby]\$\d{2}\$/);
  });
});
