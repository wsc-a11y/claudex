import { describe, it, expect, afterEach } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  currentTotp,
  verifyTotp,
  loadOrCreateJwtSecret,
  signAccessToken,
  verifyAccessToken,
  UserStore,
  ChallengeStore,
} from "../src/auth/index.js";
import { openDb } from "../src/db/index.js";
import { tempConfig } from "./helpers.js";
import fs from "node:fs";
import { jwtVerify } from "jose";

describe("password hashing", () => {
  it("hashes and verifies correctly", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toEqual("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password!", hash)).toBe(false);
  });

  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least 8/);
  });

  it("fails safely on empty inputs", async () => {
    expect(await verifyPassword("", "some-hash")).toBe(false);
    expect(await verifyPassword("pw", "")).toBe(false);
  });
});

describe("TOTP", () => {
  it("generates a secret and verifies the current code", () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThan(10);
    const code = currentTotp(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it("rejects malformed codes without throwing", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "")).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp(secret, "1234567")).toBe(false);
  });

  it("rejects a code for a different secret", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    const codeForA = currentTotp(a);
    expect(verifyTotp(b, codeForA)).toBe(false);
  });
});

describe("JWT access tokens", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("round-trips a userId through sign/verify", async () => {
    const { config, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const secret = loadOrCreateJwtSecret(config);

    const token = await signAccessToken(secret, "user-xyz");
    const claims = await verifyAccessToken(secret, token);
    expect(claims.userId).toBe("user-xyz");
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.jti.length).toBeGreaterThan(0);
  });

  it("persists the secret across calls (file written at 0600)", () => {
    const { config, cleanup } = tempConfig();
    cleanups.push(cleanup);

    const a = loadOrCreateJwtSecret(config);
    const b = loadOrCreateJwtSecret(config);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

    const stat = fs.statSync(config.jwtSecretPath);
    // On POSIX, low bits should be exactly 0600.
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects a token signed with a different secret", async () => {
    const { config: a, cleanup: cleanA } = tempConfig();
    const { config: b, cleanup: cleanB } = tempConfig();
    cleanups.push(cleanA, cleanB);

    const secretA = loadOrCreateJwtSecret(a);
    const secretB = loadOrCreateJwtSecret(b);
    const token = await signAccessToken(secretA, "hao");
    await expect(verifyAccessToken(secretB, token)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const { config, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const secret = loadOrCreateJwtSecret(config);
    const token = await signAccessToken(secret, "hao");
    const tampered = token.slice(0, -4) + "zzzz";
    await expect(verifyAccessToken(secret, tampered)).rejects.toThrow();
  });

  it("rejects wrong issuer / audience", async () => {
    const { config, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const secret = loadOrCreateJwtSecret(config);
    // forge a token with mismatched audience
    const { SignJWT } = await import("jose");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("hao")
      .setIssuer("claudex")
      .setAudience("someone-else")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
    await expect(verifyAccessToken(secret, forged)).rejects.toThrow();
  });

  it("token expires at ~30 days in the future", async () => {
    const { config, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const secret = loadOrCreateJwtSecret(config);
    const token = await signAccessToken(secret, "hao");
    const { payload } = await jwtVerify(token, secret, {
      issuer: "claudex",
      audience: "claudex-web",
    });
    const diff = (payload.exp as number) - (payload.iat as number);
    // allow some slack
    expect(diff).toBeGreaterThanOrEqual(60 * 60 * 24 * 29);
    expect(diff).toBeLessThanOrEqual(60 * 60 * 24 * 31);
  });
});

describe("UserStore", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("creates, counts, and looks up users", async () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const { db, close } = openDb(config, log);
    cleanups.push(close);

    const users = new UserStore(db);
    expect(users.count()).toBe(0);

    const hash = await hashPassword("hunter22-trust-me");
    const secret = generateTotpSecret();
    const row = users.create({
      username: "Hao",
      passwordHash: hash,
      totpSecret: secret,
    });
    expect(row.username).toBe("hao"); // normalized to lowercase
    expect(users.count()).toBe(1);

    expect(users.findByUsername("HAO")?.id).toBe(row.id);
    expect(users.findByUsername("hao")?.id).toBe(row.id);
    expect(users.findByUsername("other")).toBeNull();
    expect(users.findById(row.id)?.username).toBe("hao");
    expect(users.findById("nope")).toBeNull();
  });

  it("rejects duplicate usernames", async () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const { db, close } = openDb(config, log);
    cleanups.push(close);

    const users = new UserStore(db);
    const hash = await hashPassword("abcdefghij");
    const secret = generateTotpSecret();
    users.create({ username: "hao", passwordHash: hash, totpSecret: secret });
    expect(() =>
      users.create({ username: "hao", passwordHash: hash, totpSecret: secret }),
    ).toThrow();
  });
});

describe("ChallengeStore", () => {
  it("creates one-shot challenges that can't be replayed", () => {
    const store = new ChallengeStore();
    const id = store.create("user-1");
    expect(store.consume(id)).toBe("user-1");
    expect(store.consume(id)).toBeNull(); // second read fails
    expect(store._size()).toBe(0);
  });

  it("returns null for unknown ids", () => {
    const store = new ChallengeStore();
    expect(store.consume("bogus")).toBeNull();
  });

  it("peek is non-destructive and consume still works after it", () => {
    const store = new ChallengeStore();
    const id = store.create("user-1");
    expect(store.peek(id)).toBe("user-1");
    expect(store.peek(id)).toBe("user-1");
    expect(store._size()).toBe(1);
    expect(store.consume(id)).toBe("user-1");
    expect(store.peek(id)).toBeNull();
  });
});
