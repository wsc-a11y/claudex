import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import QRCode from "qrcode";
import {
  ChangePasswordRequest,
  LoginRequest,
  TotpConfirmRequest,
  TotpDisableRequest,
  VerifyRecoveryCodeRequest,
  VerifyTotpRequest,
  type LoginResponse,
  type RecoveryCodesStateResponse,
  type RegenerateRecoveryCodesResponse,
  type TotpBeginResponse,
  type TotpConfirmResponse,
  type TotpDisableResponse,
  type VerifyRecoveryCodeResponse,
  type VerifyTotpResponse,
  type WhoAmIResponse,
} from "@claudex/shared";
import {
  ACCESS_COOKIE_NAME,
  ChallengeStore,
  UserStore,
  generateTotpSecret,
  hashPassword,
  signAccessToken,
  totpUri,
  verifyAccessToken,
  verifyPassword,
  verifyTotp,
} from "./index.js";
import {
  generateRecoveryCodes,
  hashRecoveryCodes,
  RECOVERY_CODE_BATCH_SIZE,
} from "./recovery-codes.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import type { AuditStore } from "../audit/store.js";
import { getRequestCtx } from "../lib/req.js";

export interface AuthDeps {
  db: Database.Database;
  jwtSecret: Uint8Array;
  challenges: ChallengeStore;
  audit: AuditStore;
}

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * Decide whether to set the `Secure` attribute on the session cookie based
 * on how this specific request reached us. Keeping it off on plain-HTTP
 * requests is what lets claudex work behind an http-only tunnel (frp,
 * dev port-forward, a LAN box with no TLS) while still turning Secure on
 * automatically whenever a reverse proxy — or the client directly — is
 * speaking HTTPS.
 *
 * Detection order:
 *   1. request.protocol === "https" (Fastify's trust-proxy-aware check)
 *   2. X-Forwarded-Proto header (some proxies don't set .protocol)
 *   3. fall back to plain HTTP → Secure=false
 *
 * If a user insists on Secure regardless, they can force it via
 * CLAUDEX_COOKIE_SECURE=1.
 */
function isRequestSecure(req: FastifyRequest): boolean {
  if (process.env.CLAUDEX_COOKIE_SECURE === "1") return true;
  if (process.env.CLAUDEX_COOKIE_SECURE === "0") return false;
  if ((req as any).protocol === "https") return true;
  const xfp = req.headers["x-forwarded-proto"];
  if (typeof xfp === "string" && xfp.toLowerCase().includes("https")) {
    return true;
  }
  return false;
}

function cookieOpts(req: FastifyRequest) {
  return {
    httpOnly: true,
    // Lax is the right default for a session cookie: it survives top-level
    // navigation (QR-code link, email link) and blocks CSRF on state-changing
    // requests since we only accept JSON bodies. Strict used to cost us the
    // first-hop cookie on some reverse proxies.
    sameSite: "lax" as const,
    secure: isRequestSecure(req),
    path: "/",
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthDeps,
): Promise<void> {
  const users = new UserStore(deps.db);

  // Rate limiters — in-memory, per-process. The login limiter is keyed by
  // client IP (classic brute-force signal). The TOTP limiter is keyed by
  // challengeId so an attacker who's already past the password gate can't
  // grind through the 6-digit space; it also means a shared tunnel IP
  // (frpc / Cloudflare) doesn't penalize a second legitimate user whose
  // challenge is independent. TOTP is stricter (10 per 15min) because a
  // 6-digit code is 10^6 — anything looser is basically unlimited.
  const loginLimiter = new SlidingWindowLimiter({
    windowMs: 5 * 60 * 1000,
    max: 5,
  });
  const totpLimiter = new SlidingWindowLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
  });

  // Small helper: pull best-effort ip + user-agent off a Fastify request for
  // audit rows. Delegates to the shared `getRequestCtx` so we don't keep the
  // same typed-access pattern duplicated in every routes file.
  const reqCtx = (req: FastifyRequest) => {
    const ctx = getRequestCtx(req);
    return { ip: ctx.ip, userAgent: ctx.userAgent };
  };

  app.decorate(
    "requireAuth",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = req.cookies?.[ACCESS_COOKIE_NAME];
      if (!token) return reply.code(401).send({ error: "unauthenticated" });
      try {
        const claims = await verifyAccessToken(deps.jwtSecret, token);
        const row = users.findById(claims.userId);
        if (!row) return reply.code(401).send({ error: "user_gone" });
        req.userId = row.id;
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }
    },
  );

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = LoginRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    // Keyed by client IP; behind a tunnel all requests may share one IP and
    // that's fine — if the attacker shares a tunnel with a user, the user's
    // legitimate login still succeeds (success resets the counter).
    const ipKey = getRequestCtx(req).ip ?? "unknown";
    const gate = loginLimiter.check(ipKey);
    if (!gate.allowed) {
      deps.audit.append({
        event: "login_rate_limited",
        detail: `ip=${ipKey}`,
        ...reqCtx(req),
      });
      reply.header("Retry-After", String(gate.retryAfterSec ?? 1));
      return reply
        .code(429)
        .send({ error: "rate_limited", retryAfterSec: gate.retryAfterSec });
    }
    const { username, password } = parsed.data;
    const row = users.findByUsername(username);
    // Uniformly cost the request even when the user is missing so we don't
    // leak timing — always run bcrypt once.
    const ok =
      row != null && (await verifyPassword(password, row.password_hash));
    if (!ok || !row) {
      // Count against the per-IP limiter. Unknown users and wrong passwords
      // both count — otherwise an attacker could probe usernames without
      // tripping the limiter.
      loginLimiter.recordFailure(ipKey);
      // Audit: failed password / unknown user. `userId` intentionally null so
      // we record brute-force probes against any username uniformly.
      deps.audit.append({
        event: "login_failed",
        detail: "invalid_credentials",
        ...reqCtx(req),
      });
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    // Legit credentials → drop any accumulated failures for this IP so a
    // user who fat-fingered a couple times doesn't get throttled on TOTP.
    loginLimiter.reset(ipKey);

    // 2FA off → no second-factor round trip; sign the JWT immediately and tell
    // the client to skip the TOTP step. Migration 28 added `totp_enabled`,
    // defaulted to 1 for every pre-existing account, so this branch is only
    // reachable for accounts created via `claudex init --skip-totp` or for
    // accounts that explicitly disabled 2FA from Settings.
    if (!row.totp_enabled) {
      const token = await signAccessToken(deps.jwtSecret, row.id);
      reply.setCookie(ACCESS_COOKIE_NAME, token, {
        ...cookieOpts(req),
        maxAge: 60 * 60 * 24 * 30,
      });
      deps.audit.append({
        userId: row.id,
        event: "login",
        detail: "password only (2FA disabled)",
        ...reqCtx(req),
      });
      const body: LoginResponse = { requireTotp: false, challengeId: null };
      return reply.send(body);
    }

    const challengeId = deps.challenges.create(row.id);
    const body: LoginResponse = { requireTotp: true, challengeId };
    return reply.send(body);
  });

  app.post("/api/auth/verify-totp", async (req, reply) => {
    const parsed = VerifyTotpRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const { challengeId, code } = parsed.data;

    // Keyed by challenge rather than IP: the attacker has already cleared
    // bcrypt to get here, so the point is to cap guesses against _this_
    // specific challenge — 10 per 15min keeps brute-force of the 10^6
    // code space infeasible while still allowing a real user to retry
    // after fat-fingering a digit.
    const gate = totpLimiter.check(challengeId);
    if (!gate.allowed) {
      deps.audit.append({
        event: "totp_rate_limited",
        detail: `challenge=${challengeId}`,
        ...reqCtx(req),
      });
      reply.header("Retry-After", String(gate.retryAfterSec ?? 1));
      return reply
        .code(429)
        .send({ error: "rate_limited", retryAfterSec: gate.retryAfterSec });
    }

    // Peek first so a wrong code doesn't burn the challenge. Only a successful
    // TOTP consumes it; an expired/missing challenge still looks the same to
    // the caller.
    const userId = deps.challenges.peek(challengeId);
    if (!userId) {
      return reply.code(401).send({ error: "invalid_challenge" });
    }
    const row = users.findById(userId);
    if (!row) {
      deps.challenges.consume(challengeId);
      return reply.code(401).send({ error: "user_gone" });
    }
    if (!verifyTotp(row.totp_secret, code)) {
      totpLimiter.recordFailure(challengeId);
      // Audit: wrong 2FA code against a valid challenge (i.e. the password
      // already matched). userId is known here — the attacker already cleared
      // the bcrypt gate.
      deps.audit.append({
        userId: row.id,
        event: "totp_failed",
        ...reqCtx(req),
      });
      return reply.code(401).send({ error: "invalid_totp" });
    }
    // TOTP good → clear counter, consume the challenge (prevents replay of
    // this exact challenge + code pair) and issue the session cookie.
    totpLimiter.reset(challengeId);
    deps.challenges.consume(challengeId);
    const token = await signAccessToken(deps.jwtSecret, row.id);
    reply.setCookie(ACCESS_COOKIE_NAME, token, {
      ...cookieOpts(req),
      maxAge: 60 * 60 * 24 * 30,
    });
    // Audit: successful login lands here; the bcrypt/TOTP pair both cleared.
    deps.audit.append({
      userId: row.id,
      event: "login",
      detail: "2FA verified",
      ...reqCtx(req),
    });
    const body: VerifyTotpResponse = { ok: true };
    return reply.send(body);
  });

  // Recovery-code path for the second factor. Mirrors `/verify-totp`:
  //   1. Shares the per-challenge sliding-window limiter (10 failed attempts
  //      per 15min keyed on `challengeId`) — an attacker who cleared bcrypt
  //      cannot bypass TOTP *and then* shift to the recovery endpoint to
  //      grind untracked; the limiter is one pool.
  //   2. Wrong code does NOT consume the challenge (peek-then-consume), so a
  //      user who fat-fingered a group can retry without redoing bcrypt.
  //   3. Successful redemption flips `used_at` on the matched row and issues
  //      the same session cookie `/verify-totp` would have.
  // A matched code is permanently spent; if remaining hits zero the user is
  // warned from the Security tab to regenerate before they run out.
  app.post("/api/auth/verify-recovery-code", async (req, reply) => {
    const parsed = VerifyRecoveryCodeRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const { challengeId, code } = parsed.data;

    const gate = totpLimiter.check(challengeId);
    if (!gate.allowed) {
      deps.audit.append({
        event: "totp_rate_limited",
        detail: `challenge=${challengeId} (recovery)`,
        ...reqCtx(req),
      });
      reply.header("Retry-After", String(gate.retryAfterSec ?? 1));
      return reply
        .code(429)
        .send({ error: "rate_limited", retryAfterSec: gate.retryAfterSec });
    }

    const userId = deps.challenges.peek(challengeId);
    if (!userId) {
      return reply.code(401).send({ error: "invalid_challenge" });
    }
    const row = users.findById(userId);
    if (!row) {
      deps.challenges.consume(challengeId);
      return reply.code(401).send({ error: "user_gone" });
    }

    const matched = await users.consumeRecoveryCode(row.id, code);
    if (!matched) {
      totpLimiter.recordFailure(challengeId);
      deps.audit.append({
        userId: row.id,
        event: "recovery_code_failed",
        ...reqCtx(req),
      });
      return reply.code(401).send({ error: "invalid_recovery_code" });
    }

    totpLimiter.reset(challengeId);
    deps.challenges.consume(challengeId);
    const token = await signAccessToken(deps.jwtSecret, row.id);
    reply.setCookie(ACCESS_COOKIE_NAME, token, {
      ...cookieOpts(req),
      maxAge: 60 * 60 * 24 * 30,
    });
    const remaining = users.countRemainingRecoveryCodes(row.id);
    deps.audit.append({
      userId: row.id,
      event: "recovery_code_used",
      detail: `remaining=${remaining}`,
      ...reqCtx(req),
    });
    const body: VerifyRecoveryCodeResponse = { ok: true, remaining };
    return reply.send(body);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    reply.clearCookie(ACCESS_COOKIE_NAME, cookieOpts(req));
    // Audit: best-effort user id — clearCookie happens regardless, but we
    // only stamp userId when a valid session is attached (logout called with
    // no cookie records an anonymous event, still useful for probes).
    let uid: string | undefined;
    try {
      const token = req.cookies?.[ACCESS_COOKIE_NAME];
      if (token) {
        const claims = await verifyAccessToken(deps.jwtSecret, token);
        uid = claims.userId;
      }
    } catch {
      /* ignore — logout on a bad cookie is still a logout */
    }
    deps.audit.append({ userId: uid ?? null, event: "logout", ...reqCtx(req) });
    return reply.send({ ok: true });
  });

  app.get(
    "/api/auth/whoami",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const row = users.findById(req.userId!);
      if (!row) return reply.code(401).send({ error: "user_gone" });
      const body: WhoAmIResponse = {
        user: {
          id: row.id,
          username: row.username,
          createdAt: row.created_at,
          twoFactorEnabled: !!row.totp_enabled,
        },
      };
      return reply.send(body);
    },
  );

  // Change the current user's password. Mandates the current password even
  // though the caller is already logged in — defense in depth against a
  // stolen cookie, and parity with the pattern every other serious app uses.
  // On success, re-signs the session cookie: the old JWT stays valid until
  // its own exp (we don't maintain a revocation list — not worth the SQLite
  // writes for MVP), but the caller's tab keeps working seamlessly instead
  // of surprising the user with a forced re-login.
  app.post(
    "/api/auth/change-password",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = ChangePasswordRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const { currentPassword, newPassword } = parsed.data;
      const row = users.findById(req.userId!);
      if (!row) return reply.code(401).send({ error: "user_gone" });
      const ok = await verifyPassword(currentPassword, row.password_hash);
      if (!ok) return reply.code(401).send({ error: "invalid_credentials" });
      // Defense against a subtle footgun: accepting the same password back
      // would silently no-op but cost a bcrypt hash. Reject so the UI can
      // tell the user "pick a different one."
      if (currentPassword === newPassword) {
        return reply.code(400).send({ error: "same_password" });
      }
      const newHash = await hashPassword(newPassword);
      users.setPasswordHash(row.id, newHash);
      const token = await signAccessToken(deps.jwtSecret, row.id);
      reply.setCookie(ACCESS_COOKIE_NAME, token, {
        ...cookieOpts(req),
        maxAge: 60 * 60 * 24 * 30,
      });
      // Audit: password rotation succeeded. The old JWT is still technically
      // valid until its own exp (we don't keep a revocation list), but future
      // logins will require the new password.
      deps.audit.append({
        userId: row.id,
        event: "password_changed",
        ...reqCtx(req),
      });
      return reply.send({ ok: true });
    },
  );

  // How many recovery codes does the logged-in user have left, and when were
  // they last regenerated? Login-gated — pre-login callers have no business
  // polling this surface. Plaintext codes never leave `/regenerate` and only
  // on creation; there is no "show them again" endpoint by design.
  app.get(
    "/api/auth/recovery-codes/state",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const uid = req.userId!;
      const remaining = users.countRemainingRecoveryCodes(uid);
      const generatedAt = users.recoveryCodesGeneratedAt(uid);
      const body: RecoveryCodesStateResponse = {
        remaining,
        ...(generatedAt ? { generatedAt } : {}),
      };
      return reply.send(body);
    },
  );

  // Regenerate wipes the previous batch (used or unused) and issues 10 fresh
  // codes. Returns plaintext — exactly once — so the UI can show them in a
  // one-time modal with copy/download affordances. The server only stores
  // bcrypt hashes, so there is deliberately no way to retrieve the same
  // plaintext after this response ends.
  app.post(
    "/api/auth/recovery-codes/regenerate",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const uid = req.userId!;
      const codes = generateRecoveryCodes(RECOVERY_CODE_BATCH_SIZE);
      const hashes = await hashRecoveryCodes(codes);
      users.setRecoveryCodeHashes(uid, hashes);
      const generatedAt = users.recoveryCodesGeneratedAt(uid) ?? new Date().toISOString();
      deps.audit.append({
        userId: uid,
        event: "recovery_codes_regenerated",
        detail: `count=${codes.length}`,
        ...reqCtx(req),
      });
      const body: RegenerateRecoveryCodesResponse = { codes, generatedAt };
      return reply.send(body);
    },
  );

  // TOTP setup / rebind. Two-step: `/begin` mints a fresh secret + URI but
  // does NOT touch the DB; `/confirm` echoes that secret back along with a
  // current 6-digit code (proving the user actually paired the new
  // authenticator) plus a second proof of identity — `currentTotp` if 2FA
  // is already on (proves they still control the OLD authenticator → can't
  // be used by a thief who has the cookie but no device), or `password` if
  // 2FA is off (no old authenticator to consult). The route refuses if both
  // proofs are missing or both supplied.
  app.post(
    "/api/auth/totp/begin",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const row = users.findById(req.userId!);
      if (!row) return reply.code(401).send({ error: "user_gone" });
      const secret = generateTotpSecret();
      const uri = totpUri(secret, row.username);
      // Render the otpauth URI as an inline SVG so the browser can embed it
      // directly. `qrcode`'s SVG output strips the XML preamble when type=svg
      // is used via the toString API — perfect for `dangerouslySetInnerHTML`.
      const qrSvg = await QRCode.toString(uri, {
        type: "svg",
        margin: 1,
        width: 240,
        errorCorrectionLevel: "M",
      });
      const body: TotpBeginResponse = {
        secret,
        uri,
        issuer: "claudex",
        account: row.username,
        qrSvg,
      };
      return reply.send(body);
    },
  );

  app.post(
    "/api/auth/totp/confirm",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = TotpConfirmRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const { secret, code, currentTotp, password } = parsed.data;
      const row = users.findById(req.userId!);
      if (!row) return reply.code(401).send({ error: "user_gone" });

      // Exactly one proof of identity beyond the session cookie.
      const haveTotp = typeof currentTotp === "string";
      const havePassword = typeof password === "string";
      if (haveTotp === havePassword) {
        return reply.code(400).send({ error: "bad_request" });
      }
      if (row.totp_enabled) {
        // Rebinding an account that already has 2FA → must prove old device.
        if (!haveTotp) {
          return reply.code(400).send({ error: "current_totp_required" });
        }
        if (!verifyTotp(row.totp_secret, currentTotp!)) {
          deps.audit.append({
            userId: row.id,
            event: "totp_rebind_failed",
            detail: "current_totp_invalid",
            ...reqCtx(req),
          });
          return reply.code(401).send({ error: "invalid_current_totp" });
        }
      } else {
        // Enabling 2FA from off → no old TOTP exists, fall back to password.
        if (!havePassword) {
          return reply.code(400).send({ error: "password_required" });
        }
        const ok = await verifyPassword(password!, row.password_hash);
        if (!ok) {
          deps.audit.append({
            userId: row.id,
            event: "totp_enable_failed",
            detail: "invalid_password",
            ...reqCtx(req),
          });
          return reply.code(401).send({ error: "invalid_credentials" });
        }
      }

      // The new pairing code must be valid for the secret the client is
      // proposing — proves the user actually scanned the QR before clicking
      // confirm, instead of submitting any old 6 digits.
      if (!verifyTotp(secret, code)) {
        return reply.code(401).send({ error: "invalid_totp" });
      }

      const wasEnabled = !!row.totp_enabled;
      users.setTotpState(row.id, { secret, enabled: true });
      deps.audit.append({
        userId: row.id,
        event: wasEnabled ? "totp_rebound" : "totp_enabled",
        ...reqCtx(req),
      });
      const body: TotpConfirmResponse = { ok: true };
      return reply.send(body);
    },
  );

  app.post(
    "/api/auth/totp/disable",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = TotpDisableRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const row = users.findById(req.userId!);
      if (!row) return reply.code(401).send({ error: "user_gone" });
      const ok = await verifyPassword(parsed.data.password, row.password_hash);
      if (!ok) {
        deps.audit.append({
          userId: row.id,
          event: "totp_disable_failed",
          detail: "invalid_password",
          ...reqCtx(req),
        });
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      // Wipe secret + recovery codes together. Once 2FA is off, recovery
      // codes have nothing to recover; keeping them around would let an
      // attacker who finds an old printout bypass a re-enabled 2FA later.
      users.setTotpState(row.id, { secret: "", enabled: false });
      users.clearRecoveryCodes(row.id);
      deps.audit.append({
        userId: row.id,
        event: "totp_disabled",
        ...reqCtx(req),
      });
      const body: TotpDisableResponse = { ok: true };
      return reply.send(body);
    },
  );
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void | FastifyReply>;
  }
}
