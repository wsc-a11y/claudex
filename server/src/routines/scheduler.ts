import { CronExpressionParser } from "cron-parser";
import type { FastifyBaseLogger } from "fastify";
import type { Routine } from "@claudex/shared";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionStore } from "../sessions/store.js";
import type { ProjectStore } from "../sessions/projects.js";
import type { RoutineStore } from "./store.js";

export interface SchedulerDeps {
  routines: RoutineStore;
  sessions: SessionStore;
  projects: ProjectStore;
  manager: SessionManager;
  logger?: FastifyBaseLogger;
  // Injection points so tests can pin a clock / capture timers rather than
  // wrestling with real wall-clock scheduling.
  now?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Parse a 5-field cron expression and return the next firing Date after
 * `from`, or null if it doesn't yield one (e.g. historical-only expr — which
 * a 5-field cron can't express, but guard anyway).
 *
 * Throws if the expression is invalid — callers should catch and surface a
 * `invalid_cron` error to the user.
 */
export function computeNextRun(cronExpr: string, from: Date = new Date()): Date | null {
  const iter = CronExpressionParser.parse(cronExpr, { currentDate: from });
  try {
    return iter.next().toDate();
  } catch {
    return null;
  }
}

/** True iff `cronExpr` is a valid 5-field expression cron-parser accepts. */
export function isValidCron(cronExpr: string): boolean {
  // cron-parser v5 happily accepts an empty string (treats missing fields as
  // wildcards). We don't — an empty expression is a user typo, not a valid
  // "every second forever" schedule.
  if (!cronExpr.trim()) return false;
  try {
    CronExpressionParser.parse(cronExpr);
    return true;
  } catch {
    return false;
  }
}

/**
 * RoutineScheduler — a single-timer scheduler that fires the next-due routine
 * and reschedules itself after each tick. Deliberately simple:
 *
 *  - one `setTimeout` at a time, anchored to whichever active routine's
 *    `next_run_at` is earliest
 *  - no catch-up on missed fires: if the server was down past a scheduled
 *    time, we log a warn and skip to the next slot (per CLAUDE.md / mockup
 *    discussion — catch-up is a mockup'd desktop concept we've descoped)
 *  - `reload()` is idempotent: recomputes every active routine's
 *    `next_run_at`, then rearms the next timer. Safe to call after any CRUD.
 */
export class RoutineScheduler {
  private timer: unknown = null;
  // ISO timestamp the currently-armed timer will fire at, for diagnostics.
  private armedAt: string | null = null;
  private disposed = false;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (h: unknown) => void;
  private readonly nowFn: () => Date;

  constructor(private readonly deps: SchedulerDeps) {
    this.setTimeoutFn = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      deps.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.nowFn = deps.now ?? (() => new Date());
  }

  /** Initial bootstrap — normalize every active routine's next_run_at, then arm. */
  start(): void {
    this.reload();
  }

  /** Recompute schedules and rearm. Call after any CRUD change. */
  reload(): void {
    if (this.disposed) return;
    this.cancel();
    const now = this.nowFn();
    const active = this.deps.routines.listActive();
    for (const r of active) {
      // If next_run_at is missing OR already in the past, roll forward.
      const stored = r.nextRunAt ? new Date(r.nextRunAt) : null;
      if (!stored || stored.getTime() <= now.getTime()) {
        if (stored && stored.getTime() <= now.getTime()) {
          this.deps.logger?.warn(
            { routineId: r.id, name: r.name, missedAt: r.nextRunAt },
            "routine missed scheduled fire — skipping to next slot (no catch-up)",
          );
        }
        try {
          const next = computeNextRun(r.cronExpr, now);
          this.deps.routines.setSchedule(r.id, next ? next.toISOString() : null);
        } catch (err) {
          this.deps.logger?.error(
            { err, routineId: r.id, cronExpr: r.cronExpr },
            "routine has invalid cron expression — clearing schedule",
          );
          this.deps.routines.setSchedule(r.id, null);
        }
      }
    }
    this.arm();
  }

  /** Find the next-due routine and arm a timer for it. */
  private arm(): void {
    if (this.disposed) return;
    const active = this.deps.routines.listActive();
    let soonest: Routine | null = null;
    for (const r of active) {
      if (!r.nextRunAt) continue;
      if (!soonest || new Date(r.nextRunAt) < new Date(soonest.nextRunAt!)) {
        soonest = r;
      }
    }
    if (!soonest || !soonest.nextRunAt) {
      this.armedAt = null;
      return;
    }
    const now = this.nowFn();
    const delay = Math.max(0, new Date(soonest.nextRunAt).getTime() - now.getTime());
    this.armedAt = soonest.nextRunAt;
    this.timer = this.setTimeoutFn(() => {
      // The callback captures nothing beyond `this` — re-read the routine at
      // fire-time to handle the case where it was edited/deleted in the
      // interim (reload() should have cancelled us, but belt-and-braces).
      const fresh = this.deps.routines.findById(soonest!.id);
      if (fresh && fresh.status === "active") {
        this.fire(fresh).catch((err) => {
          this.deps.logger?.error(
            { err, routineId: fresh.id },
            "routine fire failed",
          );
        });
      }
      this.arm(); // chain to the next routine regardless of this fire's result
    }, delay);
  }

  private cancel(): void {
    if (this.timer != null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.armedAt = null;
  }

  /**
   * Fire a single routine: create a session and kick it off with the stored
   * prompt. Public so `POST /api/routines/:id/run` can call it directly for
   * "Run now".
   */
  async fire(routine: Routine): Promise<string | null> {
    const project = this.deps.projects.findById(routine.projectId);
    if (!project) {
      this.deps.logger?.error(
        { routineId: routine.id, projectId: routine.projectId },
        "routine project missing — skipping fire",
      );
      return null;
    }
    // Trust gate parity with `POST /api/sessions`: a routine whose project
    // was subsequently untrusted must not spawn a session. We advance the
    // schedule so the routine doesn't re-fire immediately on every tick —
    // if the user re-trusts the project, the next scheduled slot will run
    // normally. (If we left next_run_at in the past, `reload()` would loop
    // rolling it forward every tick — same end state, noisier logs.)
    if (!project.trusted) {
      this.deps.logger?.warn(
        {
          event: "routine_skipped_untrusted",
          routineId: routine.id,
          routineName: routine.name,
          projectId: project.id,
          projectName: project.name,
          detail: `${routine.name} → ${project.name}`,
        },
        "routine fire skipped — project not trusted",
      );
      const now = this.nowFn();
      let next: string | null = null;
      try {
        const nextDate = computeNextRun(routine.cronExpr, now);
        next = nextDate ? nextDate.toISOString() : null;
      } catch {
        next = null;
      }
      // Do not set lastRunAt — the routine didn't actually run.
      this.deps.routines.setSchedule(routine.id, next);
      return null;
    }
    const now = this.nowFn();
    const title = `${routine.name} · ${now.toISOString()}`;
    const session = this.deps.sessions.create({
      title,
      projectId: routine.projectId,
      model: routine.model,
      mode: routine.mode,
    });
    // Fire-and-forget the initial message. Awaiting it inside the scheduler
    // (or inside the "Run now" HTTP route) would block the timer chain on
    // whatever the Agent SDK is doing — and on first spawn the SDK can sit
    // for a while before returning from sendUserMessage. We don't need the
    // send to complete before the route responds; the session is already
    // in the DB and the client can navigate into it and watch events stream.
    this.deps.manager
      .sendUserMessage(session.id, routine.prompt)
      .catch((err) => {
        this.deps.logger?.error(
          { err, routineId: routine.id, sessionId: session.id },
          "failed to send initial prompt for routine",
        );
      });

    // Advance the routine's schedule — even if the send failed, we recorded
    // the session (for diagnosability) and don't want to re-fire immediately.
    let next: string | null = null;
    try {
      const nextDate = computeNextRun(routine.cronExpr, now);
      next = nextDate ? nextDate.toISOString() : null;
    } catch {
      // Bad cron — leave next null, will get cleaned up on next reload.
      next = null;
    }
    this.deps.routines.setLastRun(routine.id, now.toISOString(), next);
    return session.id;
  }

  /** For diagnostics / tests. */
  debugArmedAt(): string | null {
    return this.armedAt;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
