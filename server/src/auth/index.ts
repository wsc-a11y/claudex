import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import bcrypt from "bcrypt";
import { authenticator } from "otplib";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type { Config } from "../lib/config.js";
import { verifyRecoveryCodeAgainstHash } from "./recovery-codes.js";

// -----------------------------------------------------------------------------
// Password hashing
// -----------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

// -----------------------------------------------------------------------------
// TOTP — otplib wrapped to a tight interface
// -----------------------------------------------------------------------------

// Tolerate ±1 step (±30s) on verification — accounts for clock skew.
authenticator.options = { window: 1, step: 30, digits: 6 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpUri(
  secret: string,
  username: string,
  issuer = "claudex",
): string {
  return authenticator.keyuri(username, issuer, secret);
}

export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

// Expose the same generator for tests that need to produce a current code.
export function currentTotp(secret: string): string {
  return authenticator.generate(secret);
}

// -----------------------------------------------------------------------------
// JWT — HS256, secret stored on disk with 0600
// -----------------------------------------------------------------------------

export interface SessionToken {
  userId: string;
  // issued at / expires at in seconds since epoch
  iat: number;
  exp: number;
  jti: string;
}

const JWT_ISSUER = "claudex";
const JWT_AUDIENCE = "claudex-web";
const ACCESS_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

export function loadOrCreateJwtSecret(config: Config): Uint8Array {
  const file = config.jwtSecretPath;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    if (raw.length >= 32) return new Uint8Array(raw);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const secret = randomBytes(48);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return new Uint8Array(secret);
}

export async function signAccessToken(
  secret: Uint8Array,
  userId: string,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setJti(nanoid(16))
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC)
    .sign(secret);
}

export async function verifyAccessToken(
  secret: Uint8Array,
  token: string,
): Promise<SessionToken> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  return {
    userId: String(payload.sub),
    iat: (payload.iat as number) ?? 0,
    exp: (payload.exp as number) ?? 0,
    jti: String(payload.jti ?? ""),
  };
}

// -----------------------------------------------------------------------------
// User store — SQL operations kept tight and typed
// -----------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  // Empty string when 2FA is disabled. `setTotpSecret` writes it; `verifyTotp`
  // never sees this value because the route gates on `totp_enabled` first.
  totp_secret: string;
  // SQLite has no native bool — stored as 0/1. Treat any non-zero as enabled.
  totp_enabled: number;
  created_at: string;
}

export class UserStore {
  constructor(private readonly db: Database.Database) {}

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM users").get() as {
      c: number;
    };
    return row.c;
  }

  findByUsername(username: string): UserRow | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username.toLowerCase()) as UserRow | undefined;
    return row ?? null;
  }

  findById(id: string): UserRow | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as UserRow | undefined;
    return row ?? null;
  }

  create(input: {
    username: string;
    passwordHash: string;
    // Empty string + totpEnabled=false means the account is created without
    // 2FA. The DB column is NOT NULL so we can't store an actual NULL —
    // the empty string never reaches `verifyTotp` because the login path
    // checks `totp_enabled` before consulting the secret.
    totpSecret: string;
    totpEnabled?: boolean;
  }): UserRow {
    const totpEnabled = input.totpEnabled ?? (input.totpSecret.length > 0);
    const row: UserRow = {
      id: nanoid(16),
      username: input.username.toLowerCase(),
      password_hash: input.passwordHash,
      totp_secret: input.totpSecret,
      totp_enabled: totpEnabled ? 1 : 0,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, totp_secret, totp_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.username,
        row.password_hash,
        row.totp_secret,
        row.totp_enabled,
        row.created_at,
      );
    return row;
  }

  /** Rotate the stored bcrypt hash for a user. Used by change-password. */
  setPasswordHash(id: string, passwordHash: string): void {
    this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(passwordHash, id);
  }

  /**
   * Atomically swap the TOTP secret and the enabled flag. Used by both the
   * "enable / rebind" confirm route (writes a fresh secret + flag=1) and the
   * disable route (clears secret + flag=0). Done in a single statement so a
   * crash mid-update can't leave a row with `totp_enabled=1` and a stale
   * secret the user no longer has access to.
   */
  setTotpState(
    id: string,
    input: { secret: string; enabled: boolean },
  ): void {
    this.db
      .prepare(
        "UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?",
      )
      .run(input.secret, input.enabled ? 1 : 0, id);
  }

  /** Wipe every recovery-code row for a user. Called on TOTP disable. */
  clearRecoveryCodes(userId: string): void {
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
  }

  /**
   * Replace the user's entire set of recovery-code hashes atomically.
   * Regenerate semantics: any previously issued code (used or unused) is
   * wiped out before the new batch lands, so old printouts stop working as
   * soon as the user clicks Regenerate. Stamped `created_at = now()` for each
   * row — shared across the batch so the UI can render "generated <relative>"
   * off the first row without needing a dedicated column on `users`.
   */
  setRecoveryCodeHashes(userId: string, hashes: string[]): void {
    const createdAt = new Date().toISOString();
    const del = this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?");
    const ins = this.db.prepare(
      `INSERT INTO recovery_codes (user_id, code_hash, used_at, created_at)
       VALUES (?, ?, NULL, ?)`,
    );
    const tx = this.db.transaction((hs: string[]) => {
      del.run(userId);
      for (const h of hs) ins.run(userId, h, createdAt);
    });
    tx(hashes);
  }

  /** Count the number of unused recovery codes remaining for this user. */
  countRemainingRecoveryCodes(userId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM recovery_codes
         WHERE user_id = ? AND used_at IS NULL`,
      )
      .get(userId) as { c: number };
    return row.c;
  }

  /**
   * ISO timestamp of when the user's current recovery-code batch was issued,
   * or null if they've never generated any. Read off the first row because
   * `setRecoveryCodeHashes` stamps a shared `created_at` across the batch.
   */
  recoveryCodesGeneratedAt(userId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT created_at FROM recovery_codes
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(userId) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  /**
   * Try to consume a single recovery code. Walks every *unused* row for this
   * user and bcrypt-compares against each until a match. On match, marks the
   * row `used_at = now()` and returns true. Returns false on no match or on
   * an already-used code (the row wouldn't even be in the candidate set).
   *
   * Note on cost: bcrypt at rounds=10 is ~65ms per compare, so the worst case
   * here is ~0.65s for a 10-code batch. That's fine for a user-initiated
   * manual recovery flow gated by an external rate limiter.
   */
  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    interface Row {
      rowid: number;
      code_hash: string;
    }
    const rows = this.db
      .prepare(
        `SELECT rowid, code_hash FROM recovery_codes
         WHERE user_id = ? AND used_at IS NULL
         ORDER BY rowid ASC`,
      )
      .all(userId) as Row[];
    for (const r of rows) {
      const ok = await verifyRecoveryCodeAgainstHash(code, r.code_hash);
      if (ok) {
        this.db
          .prepare(
            "UPDATE recovery_codes SET used_at = ? WHERE rowid = ? AND used_at IS NULL",
          )
          .run(new Date().toISOString(), r.rowid);
        return true;
      }
    }
    return false;
  }
}

// -----------------------------------------------------------------------------
// Login challenge store — short-lived, in-memory, survives a TOTP round trip
// -----------------------------------------------------------------------------

interface Challenge {
  userId: string;
  expiresAt: number;
}

export class ChallengeStore {
  private map = new Map<string, Challenge>();
  private ttlMs = 5 * 60_000;

  create(userId: string): string {
    const id = nanoid(24);
    this.map.set(id, { userId, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  /** Inspect a challenge without consuming it. Returns null if missing/expired. */
  peek(id: string): string | null {
    const c = this.map.get(id);
    if (!c) return null;
    if (c.expiresAt < Date.now()) {
      this.map.delete(id);
      return null;
    }
    return c.userId;
  }

  /** Atomically validate + remove. Returns null if missing/expired. */
  consume(id: string): string | null {
    const c = this.map.get(id);
    if (!c) return null;
    this.map.delete(id);
    if (c.expiresAt < Date.now()) return null;
    return c.userId;
  }

  // Expose for tests.
  _size(): number {
    return this.map.size;
  }
}

export const ACCESS_COOKIE_NAME = "claudex_session";
