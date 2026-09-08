import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/transport/app.js";
import { openDb, type ClaudexDb } from "../src/db/index.js";
import {
  currentTotp,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";
import { SlidingWindowLimiter } from "../src/auth/rate-limit.js";
import { tempConfig } from "./helpers.js";

interface Ctx {
  app: FastifyInstance;
  dbh: ClaudexDb;
  username: string;
  password: string;
  totpSecret: string;
  cleanup: () => void;
}

async function bootstrap(): Promise<Ctx> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const { app } = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: false,
  });
  // Seed admin user
  const users = new UserStore(dbh.db);
  const totpSecret = generateTotpSecret();
  const passwordHash = await hashPassword("hunter22-please-work");
  users.create({
    username: "hao",
    passwordHash,
    totpSecret,
  });
  return {
    app,
    dbh,
    username: "hao",
    password: "hunter22-please-work",
    totpSecret,
    cleanup: () => {
      dbh.close();
      cleanup();
    },
  };
}

function cookieFor(res: { cookies: Array<{ name: string; value: string }> }) {
  const c = res.cookies.find((c) => c.name === "claudex_session");
  return c ? `claudex_session=${c.value}` : "";
}

describe("auth routes", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await bootstrap();
  });
  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  describe("POST /api/auth/login", () => {
    it("returns a challengeId for valid credentials", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao", password: ctx.password },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.requireTotp).toBe(true);
      expect(typeof body.challengeId).toBe("string");
    });

    it("is case-insensitive on username", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "HAO", password: ctx.password },
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns 401 for wrong password", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao", password: "wrong-one" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 for unknown user (no user enumeration)", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "nobody", password: "anything123" },
      });
      expect(res.statusCode).toBe(401);
      // Same error code whether password is wrong or user is gone
      expect(res.json().error).toBe("invalid_credentials");
    });

    it("rejects malformed bodies with 400", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao" }, // missing password
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/auth/verify-totp", () => {
    async function getChallenge() {
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao", password: ctx.password },
      });
      return login.json().challengeId as string;
    }

    it("sets an httpOnly session cookie for a valid TOTP", async () => {
      const challengeId = await getChallenge();
      const code = currentTotp(ctx.totpSecret);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      const cookie = res.cookies.find((c) => c.name === "claudex_session");
      expect(cookie).toBeDefined();
      expect(cookie!.httpOnly).toBe(true);
      // Lax — see routes.ts: strict used to break us across some reverse
      // proxies, and state changes still require a JSON body (no CSRF).
      expect(cookie!.sameSite?.toLowerCase()).toBe("lax");
    });

    it("rejects a wrong TOTP code", async () => {
      const challengeId = await getChallenge();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: "000000" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_totp");
    });

    it("keeps the challenge alive on wrong code so the user can retry", async () => {
      const challengeId = await getChallenge();
      // First attempt: wrong code
      const bad = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: "000000" },
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error).toBe("invalid_totp");
      // Second attempt with the same challenge and a correct code succeeds.
      const good = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: currentTotp(ctx.totpSecret) },
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().ok).toBe(true);
    });

    it("rejects replay of a challengeId", async () => {
      const challengeId = await getChallenge();
      const code = currentTotp(ctx.totpSecret);

      const ok = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code },
      });
      expect(ok.statusCode).toBe(200);

      // Even with a valid (next) TOTP, the challenge is already consumed.
      const replay = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: currentTotp(ctx.totpSecret) },
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error).toBe("invalid_challenge");
    });

    it("rejects malformed codes with 400", async () => {
      const challengeId = await getChallenge();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: "abc" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/auth/whoami", () => {
    async function fullLogin(): Promise<string> {
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao", password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      const code = currentTotp(ctx.totpSecret);
      const verify = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code },
      });
      return cookieFor(verify as any);
    }

    it("returns user info with a valid session cookie", async () => {
      const cookie = await fullLogin();
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.username).toBe("hao");
      expect(body.user.twoFactorEnabled).toBe(true);
    });

    it("401 without a cookie", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
      });
      expect(res.statusCode).toBe(401);
    });

    it("401 with a garbage cookie", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { cookie: "claudex_session=not-a-jwt" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears the session cookie", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/logout",
      });
      expect(res.statusCode).toBe(200);
      const cleared = res.cookies.find((c) => c.name === "claudex_session");
      expect(cleared).toBeDefined();
      // clearCookie sets an empty value with a past expiry
      expect(cleared!.value).toBe("");
    });
  });

  describe("POST /api/auth/change-password", () => {
    async function loggedInCookie(): Promise<string> {
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      const verify = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: currentTotp(ctx.totpSecret) },
      });
      return cookieFor(verify);
    }

    it("401s when not logged in", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        payload: {
          currentPassword: ctx.password,
          newPassword: "new-password-xyz",
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it("401s when the current password is wrong", async () => {
      const cookie = await loggedInCookie();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie },
        payload: {
          currentPassword: "not-the-password",
          newPassword: "new-password-xyz",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_credentials");
    });

    it("400s when the new password is too short", async () => {
      const cookie = await loggedInCookie();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie },
        payload: {
          currentPassword: ctx.password,
          newPassword: "short",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("400s when the new password equals the current one", async () => {
      const cookie = await loggedInCookie();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie },
        payload: {
          currentPassword: ctx.password,
          newPassword: ctx.password,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("same_password");
    });

    it("rotates the hash, re-signs the cookie, and lets the old password fail afterwards", async () => {
      const cookie = await loggedInCookie();
      const newPassword = "a-brand-new-one-2026";
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie },
        payload: {
          currentPassword: ctx.password,
          newPassword,
        },
      });
      expect(res.statusCode).toBe(200);
      // A fresh session cookie is issued (re-sign).
      const fresh = res.cookies.find((c) => c.name === "claudex_session");
      expect(fresh).toBeDefined();
      expect(fresh!.value.length).toBeGreaterThan(0);
      expect(fresh!.value).not.toBe(cookie.split("=")[1]);

      // Old password no longer works.
      const badLogin = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      expect(badLogin.statusCode).toBe(401);

      // New password works.
      const newLogin = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: newPassword },
      });
      expect(newLogin.statusCode).toBe(200);
    });
  });

  describe("rate limiting", () => {
    it("429s the 6th failed login attempt from the same IP with a Retry-After header", async () => {
      // Five wrong-password attempts are allowed through (each 401).
      for (let i = 0; i < 5; i++) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: ctx.username, password: "wrong-one" },
        });
        expect(res.statusCode).toBe(401);
      }
      // Sixth attempt trips the limiter — even a correct password gets
      // rejected at the gate before we ever hash.
      const blocked = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe("rate_limited");
      expect(typeof blocked.json().retryAfterSec).toBe("number");
      expect(blocked.headers["retry-after"]).toBeDefined();
    });

    it("resets the login counter for an IP after a successful login", async () => {
      // Four failures — still under the cap of 5.
      for (let i = 0; i < 4; i++) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: ctx.username, password: "wrong-one" },
        });
        expect(res.statusCode).toBe(401);
      }
      // Valid login clears the accumulated failure count.
      const ok = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      expect(ok.statusCode).toBe(200);
      // Fresh burst of five wrongs should all 401, not 429 — counter was
      // reset by the successful login.
      for (let i = 0; i < 5; i++) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: ctx.username, password: "wrong-one" },
        });
        expect(res.statusCode).toBe(401);
      }
    });

    it("429s the 11th failed TOTP attempt on the same challenge", async () => {
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      // 10 bad codes allowed through.
      for (let i = 0; i < 10; i++) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/api/auth/verify-totp",
          payload: { challengeId, code: "000000" },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe("invalid_totp");
      }
      // 11th attempt — even a legitimate code would be rejected here; use
      // a bad one to keep the test deterministic against clock skew.
      const blocked = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: "000000" },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe("rate_limited");
      expect(blocked.headers["retry-after"]).toBeDefined();
    });

    it("keeps TOTP limits independent per challengeId", async () => {
      // Challenge A — grind it up to the limit.
      const loginA = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeA = loginA.json().challengeId as string;
      for (let i = 0; i < 10; i++) {
        await ctx.app.inject({
          method: "POST",
          url: "/api/auth/verify-totp",
          payload: { challengeId: challengeA, code: "000000" },
        });
      }
      const blockedA = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId: challengeA, code: "000000" },
      });
      expect(blockedA.statusCode).toBe(429);

      // Challenge B (fresh login) — should not inherit A's counter.
      const loginB = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeB = loginB.json().challengeId as string;
      const freshB = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId: challengeB, code: "000000" },
      });
      // First attempt against B is a normal 401, not a 429.
      expect(freshB.statusCode).toBe(401);
      expect(freshB.json().error).toBe("invalid_totp");
    });
  });

  describe("recovery codes", () => {
    async function loggedInCookie(): Promise<string> {
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      const verify = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: currentTotp(ctx.totpSecret) },
      });
      return cookieFor(verify);
    }

    async function regenerate(): Promise<{
      codes: string[];
      cookie: string;
    }> {
      const cookie = await loggedInCookie();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/recovery-codes/regenerate",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      return { codes: body.codes, cookie };
    }

    it("regenerate returns 10 plaintext codes and /state reports 10 remaining", async () => {
      const { codes, cookie } = await regenerate();
      expect(codes).toHaveLength(10);
      // Each code must match the xxxx-xxxx-xxxx-xxxx layout.
      for (const c of codes) {
        expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
      }
      // Codes are unique within the batch.
      expect(new Set(codes).size).toBe(10);
      const state = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/recovery-codes/state",
        headers: { cookie },
      });
      expect(state.statusCode).toBe(200);
      const body = state.json();
      expect(body.remaining).toBe(10);
      expect(typeof body.generatedAt).toBe("string");
    });

    it("redeeming a code flips used_at and drops remaining to 9", async () => {
      const { codes } = await regenerate();
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;

      const verify = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-recovery-code",
        payload: { challengeId, code: codes[0] },
      });
      expect(verify.statusCode).toBe(200);
      const body = verify.json();
      expect(body.ok).toBe(true);
      expect(body.remaining).toBe(9);

      // Session cookie was issued.
      const cookie = cookieFor(verify);
      expect(cookie.length).toBeGreaterThan("claudex_session=".length);

      const state = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/recovery-codes/state",
        headers: { cookie },
      });
      expect(state.json().remaining).toBe(9);
    });

    it("rejects replay of an already-used code with 401", async () => {
      const { codes } = await regenerate();
      const login1 = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId1 = login1.json().challengeId as string;
      const first = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-recovery-code",
        payload: { challengeId: challengeId1, code: codes[3] },
      });
      expect(first.statusCode).toBe(200);

      const login2 = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId2 = login2.json().challengeId as string;
      const replay = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-recovery-code",
        payload: { challengeId: challengeId2, code: codes[3] },
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error).toBe("invalid_recovery_code");
    });

    it("rejects a wrong code with 401", async () => {
      await regenerate();
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-recovery-code",
        payload: { challengeId, code: "zzzz-zzzz-zzzz-zzzz" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_recovery_code");
    });

    it("regenerate invalidates the prior batch", async () => {
      const first = await regenerate();
      await regenerate();
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-recovery-code",
        payload: { challengeId, code: first.codes[0] },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_recovery_code");
    });

    it("tolerates whitespace and uppercase on the wire", async () => {
      const { codes } = await regenerate();
      const messy = codes[5].toUpperCase().replace(/-/g, " ");
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-recovery-code",
        payload: { challengeId, code: messy },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().remaining).toBe(9);
    });

    it("the TOTP rate limiter also guards the recovery endpoint", async () => {
      await regenerate();
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: ctx.username, password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      for (let i = 0; i < 10; i++) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/api/auth/verify-recovery-code",
          payload: { challengeId, code: "zzzz-zzzz-zzzz-zzzz" },
        });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-recovery-code",
        payload: { challengeId, code: "zzzz-zzzz-zzzz-zzzz" },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe("rate_limited");
    });

    it("state/regenerate require a session cookie", async () => {
      const state = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/recovery-codes/state",
      });
      expect(state.statusCode).toBe(401);
      const regen = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/recovery-codes/regenerate",
      });
      expect(regen.statusCode).toBe(401);
    });
  });
});

describe("SlidingWindowLimiter", () => {
  it("resets attempts after the window elapses (fake clock)", () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter({
      windowMs: 60_000,
      max: 3,
      clock: () => now,
    });

    // Burn the three allowed failures at t=0.
    limiter.recordFailure("ip-a");
    limiter.recordFailure("ip-a");
    limiter.recordFailure("ip-a");
    expect(limiter.check("ip-a").allowed).toBe(false);

    // Nudge past the window — old stamps age out, the key is live again.
    now += 61_000;
    const after = limiter.check("ip-a");
    expect(after.allowed).toBe(true);
    expect(after.current).toBe(0);

    // A different key was never touched, independent from "ip-a".
    expect(limiter.check("ip-b").allowed).toBe(true);
  });
});
