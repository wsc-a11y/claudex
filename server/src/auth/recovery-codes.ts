import { randomInt } from "node:crypto";
import bcrypt from "bcrypt";

// -----------------------------------------------------------------------------
// Recovery codes — single-use fallbacks for the TOTP second factor.
//
// Shape: `xxxx-xxxx-xxxx-xxxx`, 16 alphanumeric chars drawn from a confusion-
// free alphabet (no 0/1/o/l/i) plus three readability dashes. Generated with
// `crypto.randomInt` so callers don't have to think about modulo bias.
//
// Stored hashed with bcrypt rounds=10 — intentionally cheaper than the rounds=12
// we use on login passwords because a recovery-code login is a manual, one-off
// action where the user has already pasted in a 16-char random string; the
// bcrypt cost here exists to slow down an offline attacker who got a DB dump,
// not to rate-limit online guessing (the TOTP rate limiter handles that).
// -----------------------------------------------------------------------------

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // 31 symbols, no 0/1/o/l/i
const CHARS_PER_CODE = 16; // displayed as four groups of four
const GROUP_SIZE = 4;
const BCRYPT_ROUNDS = 10;
const DEFAULT_BATCH_SIZE = 10;

/** Generate a single formatted recovery code (`xxxx-xxxx-xxxx-xxxx`). */
export function generateRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < CHARS_PER_CODE; i++) {
    raw += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  const groups: string[] = [];
  for (let i = 0; i < CHARS_PER_CODE; i += GROUP_SIZE) {
    groups.push(raw.slice(i, i + GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Generate a batch of N distinct recovery codes. `N` defaults to 10 to match
 * the "10 unused" UI and the init-time banner. Uniqueness is enforced across
 * the returned batch — with a 31^16 space collisions are astronomically
 * unlikely, but a loop costs nothing and makes the guarantee explicit.
 */
export function generateRecoveryCodes(n: number = DEFAULT_BATCH_SIZE): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    out.add(generateRecoveryCode());
  }
  return [...out];
}

/**
 * Normalize user input before comparison: lowercase, strip whitespace and
 * dashes. Both the UI and CLI callers should route through this so a user who
 * typed `ABCD EFGH IJKL MNOP` or `abcd-efgh-ijkl-mnop` gets the same hash
 * lookup as the canonical form.
 */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}

/** Hash a plaintext recovery code with bcrypt rounds=10. */
export async function hashRecoveryCode(plaintext: string): Promise<string> {
  return bcrypt.hash(normalizeRecoveryCode(plaintext), BCRYPT_ROUNDS);
}

/** Hash a whole batch in parallel. */
export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map(hashRecoveryCode));
}

/**
 * Compare a user-supplied code against a stored hash. Normalizes the input
 * first. Returns false on any bcrypt error (malformed stored hash, etc.)
 * rather than throwing — the verify route already gates on a missing/used
 * row, so a throw here would surface as a 500 instead of a clean 401.
 */
export async function verifyRecoveryCodeAgainstHash(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  if (!plaintext || !hash) return false;
  try {
    return await bcrypt.compare(normalizeRecoveryCode(plaintext), hash);
  } catch {
    return false;
  }
}

export const RECOVERY_CODE_BATCH_SIZE = DEFAULT_BATCH_SIZE;
