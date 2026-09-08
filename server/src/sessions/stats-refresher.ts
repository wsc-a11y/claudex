import type { FastifyBaseLogger } from "fastify";
import { aggregateSessionDiff } from "./session-diff.js";
import type { SessionStore } from "./store.js";

/**
 * Default tick cadence — 30 seconds. The stats projection is a UX nicety
 * for the Home list ("+X −Y · Nf" next to each session row); a perceivable
 * lag on the order of tens of seconds is fine. Tightening this mostly just
 * burns CPU on the MAX-seq subquery for every session. Override via
 * `STATS_REFRESH_INTERVAL_MS`.
 */
export const STATS_REFRESH_INTERVAL_MS = 30_000;

/**
 * How many stale sessions to process per tick. 10 is deliberately small: a
 * typical ~1 MB session deserializes + re-aggregates in single-digit ms, so
 * 10 × ~30s ≈ ~20 sessions/min refreshed in steady state — plenty for one
 * user. Override via `STATS_REFRESH_BATCH_SIZE`. If the queue consistently
 * backs up, raise both (interval and batch) or add an index; don't just
 * raise the batch and leave the cadence, you'll block the event loop.
 */
export const STATS_REFRESH_BATCH_SIZE = 10;

export interface StatsRefresherDeps {
  sessions: SessionStore;
  logger?: FastifyBaseLogger;
  /** Override the tick cadence (ms). Falls through to env, then default. */
  intervalMs?: number;
  /** Override the per-tick batch size. Falls through to env, then default. */
  batchSize?: number;
}

function resolvePositiveInt(
  override: number | undefined,
  envKey: string,
  fallback: number,
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }
  const raw = process.env[envKey];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

/**
 * Background sweeper that keeps each session's `stats_files_changed /
 * stats_lines_added / stats_lines_removed` columns in sync with its event
 * log. Mirrors the pattern in `queue/runner.ts`: `start` / `stop` /
 * `dispose`, reentrancy guard via `ticking`, `timer.unref()` so the sweeper
 * never pins the event loop open on shutdown.
 *
 * Why it exists at all: the stats columns used to be dead — nobody wrote
 * them except for `stats_messages`. The Home list therefore always showed
 * "no changes" for every session. `aggregateSessionDiff` already knows how
 * to derive the totals from the event log; all that was missing was a way
 * to persist the result so the list reader doesn't have to re-aggregate
 * every page load. That's this sweeper.
 *
 * Design choices worth noting:
 *
 *   - Pull, not push. The alternative (bump stats on every Edit/Write
 *     event append) would give instant updates but forces us to reimplement
 *     per-path dedupe, approval filtering, and MultiEdit unpacking — logic
 *     that already exists in `aggregateSessionDiff`. Pulling keeps one
 *     source of truth.
 *
 *   - `stats_computed_seq` is the cursor. Stored on the session row,
 *     compared against `MAX(session_events.seq)` for that session. A session
 *     whose cursor < max is "stale" and picked up. After re-aggregation we
 *     advance the cursor to the max we observed; any event that arrived
 *     mid-aggregation has a larger seq and will be caught on the next tick.
 *
 *   - No locking. `aggregateSessionDiff` is pure; the UPDATE is one row;
 *     overlapping ticks are barred by the `ticking` flag. Two replicas of
 *     this worker racing would be incorrect but claudex has exactly one
 *     server process, so it's not a concern.
 *
 *   - Archived sessions are excluded in `listStaleStats` — they can't
 *     receive new events and the caller would otherwise trip the "max > -1
 *     but computed = -1" corner endlessly if we ever archived a row with
 *     events before the first successful refresh.
 */
export class StatsRefresher {
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private ticking = false;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(private readonly deps: StatsRefresherDeps) {
    this.intervalMs = resolvePositiveInt(
      deps.intervalMs,
      "STATS_REFRESH_INTERVAL_MS",
      STATS_REFRESH_INTERVAL_MS,
    );
    this.batchSize = resolvePositiveInt(
      deps.batchSize,
      "STATS_REFRESH_BATCH_SIZE",
      STATS_REFRESH_BATCH_SIZE,
    );
  }

  /** Arm the periodic tick. Safe to call multiple times (idempotent). */
  start(): void {
    if (this.timer || this.disposed) return;
    // Defer the first tick by a full interval so callers that instantiate
    // the refresher inside buildApp() can finish wiring before we touch the
    // DB. Matches the QueueRunner convention.
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Background sweeper, not a load-bearing service — must not pin the
    // event loop open past SIGINT.
    this.timer.unref?.();
  }

  /** Stop the periodic tick; no-op when already stopped. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /**
   * Run a single tick. Exposed public so tests can drive the sweeper without
   * fake timers. Reentrancy-guarded: if a prior tick is still aggregating a
   * large batch when the next interval fires, the second call no-ops.
   */
  async tick(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      await this.tickInner();
    } catch (err) {
      this.deps.logger?.error({ err }, "stats refresher tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    const candidates = this.deps.sessions.listStaleStats(this.batchSize);
    if (candidates.length === 0) return;

    let refreshed = 0;
    for (const { id, maxSeq } of candidates) {
      const session = this.deps.sessions.findById(id);
      if (!session) continue; // deleted between the list query and now
      const events = this.deps.sessions.listEvents(id);
      // If aggregation throws for a single session (malformed payload,
      // disk-read hiccup, whatever), log and move on. One bad row must not
      // starve the rest of the batch.
      try {
        const diff = aggregateSessionDiff(events, session);
        this.deps.sessions.setStats(id, {
          filesChanged: diff.totals.filesChanged,
          linesAdded: diff.totals.additions,
          linesRemoved: diff.totals.deletions,
          computedSeq: maxSeq,
        });
        refreshed += 1;
      } catch (err) {
        this.deps.logger?.warn(
          { err, sessionId: id },
          "stats refresher: aggregation failed",
        );
      }
    }

    if (refreshed > 0) {
      this.deps.logger?.debug(
        { refreshed, batchSize: this.batchSize },
        "stats refresher tick",
      );
    }
  }
}
