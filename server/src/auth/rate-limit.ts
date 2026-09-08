/**
 * SlidingWindowLimiter — in-memory, single-process rate limiter.
 *
 * Designed for the auth endpoints (login + TOTP verify) so exposing claudex
 * through a tunnel (frpc, cloudflared, Tailscale funnel) doesn't turn the
 * 6-digit TOTP surface into a piñata. Single-process and in-memory is fine:
 * claudex binds to 127.0.0.1 and runs as one Node process, so we don't need
 * Redis or cross-instance coordination.
 *
 * Semantics:
 *   - Keep a per-key list of failure timestamps.
 *   - `check(key, now?)`: purge old stamps first. If remaining count >= max,
 *     the request is not allowed and `retryAfterSec` tells the caller when
 *     the oldest stamp will age out.
 *   - `recordFailure(key, now?)`: called after a failed attempt to append a
 *     timestamp. Successful attempts should call `reset(key)` instead.
 *   - Cleanup is lazy (purge on check) — no periodic GC, no intervals.
 *
 * Tests need a fake clock, so `now` is an optional override on both
 * `check` and `recordFailure`, and the constructor also accepts a
 * `clock: () => number` that is used when the call site doesn't pass one.
 */

export interface SlidingWindowLimiterOptions {
  /** Rolling window length in ms. */
  windowMs: number;
  /** Max failed attempts allowed within the window. */
  max: number;
  /** Optional injected clock — defaults to `Date.now`. */
  clock?: () => number;
}

export interface CheckResult {
  allowed: boolean;
  /** Seconds until the oldest stamp ages out — only set when allowed=false. */
  retryAfterSec?: number;
  /** Current count of in-window failures for this key after purging. */
  current: number;
}

export class SlidingWindowLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly clock: () => number;
  private readonly stamps = new Map<string, number[]>();

  constructor(opts: SlidingWindowLimiterOptions) {
    if (!(opts.windowMs > 0)) {
      throw new Error("windowMs must be > 0");
    }
    if (!(opts.max > 0)) {
      throw new Error("max must be > 0");
    }
    this.windowMs = opts.windowMs;
    this.max = opts.max;
    this.clock = opts.clock ?? (() => Date.now());
  }

  /**
   * Check whether `key` may make another attempt. Purges expired stamps as a
   * side-effect so the map doesn't grow unbounded for keys that go quiet.
   */
  check(key: string, now?: number): CheckResult {
    const t = now ?? this.clock();
    const list = this.purge(key, t);
    if (list.length >= this.max) {
      // retryAfter = window - (now - oldest). Ceil so we don't hand the
      // client a `Retry-After: 0` that it immediately retries on.
      const oldest = list[0]!;
      const waitMs = this.windowMs - (t - oldest);
      const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));
      return { allowed: false, retryAfterSec, current: list.length };
    }
    return { allowed: true, current: list.length };
  }

  /**
   * Append a failure timestamp. Does not enforce the cap itself — callers
   * should `check` first. We still purge here so a long-lived hostile key
   * can't accumulate stamps forever.
   */
  recordFailure(key: string, now?: number): void {
    const t = now ?? this.clock();
    const list = this.purge(key, t);
    list.push(t);
    this.stamps.set(key, list);
  }

  /**
   * Drop all stamps for `key`. Called after a successful attempt so that a
   * legitimate user who fat-fingered a few tries doesn't keep the counter
   * around.
   */
  reset(key: string): void {
    this.stamps.delete(key);
  }

  /**
   * Drop every key (test helper — not used in prod).
   */
  clear(): void {
    this.stamps.clear();
  }

  /** Purge stamps older than `now - windowMs` and return the live list. */
  private purge(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const prev = this.stamps.get(key);
    if (!prev || prev.length === 0) {
      return [];
    }
    // Stamps are pushed monotonically, so a linear scan from the front is
    // already sorted — we just find the first index that's still in-window.
    let firstLive = 0;
    while (firstLive < prev.length && prev[firstLive]! <= cutoff) {
      firstLive++;
    }
    if (firstLive === 0) {
      return prev;
    }
    const live = prev.slice(firstLive);
    if (live.length === 0) {
      this.stamps.delete(key);
      return [];
    }
    this.stamps.set(key, live);
    return live;
  }
}
