import type { FastifyBaseLogger } from "fastify";
import type { ModelId, PermissionMode } from "@claudex/shared";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionStore } from "../sessions/store.js";
import type { ProjectStore } from "../sessions/projects.js";
import type { QueueStore } from "./store.js";

export interface QueueRunnerDeps {
  queue: QueueStore;
  sessions: SessionStore;
  projects: ProjectStore;
  manager: SessionManager;
  logger?: FastifyBaseLogger;
  /** Override the clock for tests. */
  now?: () => Date;
  /**
   * Per-dispatch watchdog timeout. If a running queue row stays `running` for
   * longer than this without its session settling to idle/error, the runner
   * gives up on the row: it interrupts the session, marks the queue row
   * `failed`, and proceeds to dispatch the next. Defaults to 30 min; can be
   * overridden per-instance or globally via `QUEUE_DISPATCH_TIMEOUT_MS`.
   */
  dispatchTimeoutMs?: number;
}

/**
 * Default fallback when a queued prompt doesn't pin a model.
 */
const DEFAULT_MODEL: ModelId = "claude-opus-4-8";
/**
 * Default fallback when a queued prompt doesn't pin a permission mode.
 */
const DEFAULT_MODE: PermissionMode = "default";

/**
 * Polling cadence for the queue runner. 2 seconds is a compromise between
 * "looks instant in the UI" and "don't hammer SQLite". The queue is not a
 * latency-sensitive path — users expect "it'll run when it runs".
 */
export const QUEUE_TICK_INTERVAL_MS = 2000;

/**
 * Default watchdog timeout for a single queued dispatch. If a running row
 * sits in `running` for longer than this without its session settling, the
 * runner assumes the dispatch is wedged (SDK hang, missing event stream,
 * etc.) and fails the row so the queue keeps draining. Configurable via
 * the `QUEUE_DISPATCH_TIMEOUT_MS` env var for operators who want tighter
 * (or looser) guardrails; tests pass an override in `QueueRunnerDeps`.
 */
export const DEFAULT_QUEUE_DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * QueueRunner — single-instance coordinator that drains the `queued_prompts`
 * table one row at a time. On each tick it:
 *
 *   1. Looks for any row with `status='running'`. If present, it inspects the
 *      underlying session's status. When the session has settled (idle/error),
 *      the queue row is transitioned to `done`/`failed` and the tick ends —
 *      the next tick will pick the next queued row. This keeps dispatch to
 *      strictly one claude subprocess at a time.
 *   2. With nothing running, it picks the lowest-seq `status='queued'` row,
 *      flips it to `running`, creates a session with the stored project /
 *      model / mode, and fires `manager.sendUserMessage(sessionId, prompt)`.
 *   3. Otherwise, idles.
 *
 * Deliberately not coupled to the SessionManager's event bus — the polling
 * approach is simpler (less state to keep in sync) and good enough for a
 * 2-second cadence.
 */
export class QueueRunner {
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private ticking = false;
  private readonly nowFn: () => Date;
  private readonly dispatchTimeoutMs: number;

  constructor(private readonly deps: QueueRunnerDeps) {
    this.nowFn = deps.now ?? (() => new Date());
    // Resolution order: explicit constructor arg > env var > default. Invalid
    // env values (non-positive / NaN) fall through to the default so a typo
    // doesn't silently disable the watchdog.
    const envRaw = process.env.QUEUE_DISPATCH_TIMEOUT_MS;
    const envParsed = envRaw !== undefined ? Number(envRaw) : NaN;
    const envValid = Number.isFinite(envParsed) && envParsed > 0;
    this.dispatchTimeoutMs =
      deps.dispatchTimeoutMs ??
      (envValid ? envParsed : DEFAULT_QUEUE_DISPATCH_TIMEOUT_MS);
  }

  /** Arm the periodic tick. Safe to call multiple times (idempotent). */
  start(): void {
    if (this.timer || this.disposed) return;
    // Don't eagerly tick so callers that start the runner during buildApp()
    // have a chance to return before we touch the DB. First tick fires after
    // the interval.
    this.timer = setInterval(() => {
      void this.tick();
    }, QUEUE_TICK_INTERVAL_MS);
    // Let the process exit even when the queue runner is armed (we are a
    // background sweeper, not a load-bearing service). Without unref the
    // interval would keep the Node event loop alive past SIGINT shutdown.
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
   * Run a single tick. Exposed public so tests can drive the runner without
   * wrestling with real timers. Guards against overlapping ticks — if a tick
   * is already in flight (e.g. `manager.sendUserMessage` is slow), the next
   * scheduled tick no-ops rather than double-dispatching.
   */
  async tick(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      await this.tickInner();
    } catch (err) {
      this.deps.logger?.error({ err }, "queue runner tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    // Step 1: reconcile any `running` rows against their underlying session's
    // status. This catches the common case where a session has settled while
    // we were asleep.
    const running = this.deps.queue.findRunning();
    for (const row of running) {
      if (!row.sessionId) {
        // Shouldn't happen — a row goes `running` only when we stamped a
        // session id onto it. Heal the inconsistency by marking the row
        // failed so the queue can move on.
        this.deps.queue.setStatus(row.id, "failed", {
          finishedAt: this.nowFn().toISOString(),
        });
        continue;
      }
      const session = this.deps.sessions.findById(row.sessionId);
      if (!session) {
        // Session was deleted out from under us. Treat as failed — we can't
        // recover the transcript to know if the prompt ever completed.
        this.deps.queue.setStatus(row.id, "failed", {
          finishedAt: this.nowFn().toISOString(),
        });
        continue;
      }
      if (session.status === "idle") {
        this.deps.queue.setStatus(row.id, "done", {
          finishedAt: this.nowFn().toISOString(),
        });
      } else if (session.status === "error") {
        this.deps.queue.setStatus(row.id, "failed", {
          finishedAt: this.nowFn().toISOString(),
        });
      } else {
        // session.status === 'running' | 'awaiting' | 'archived' → still
        // occupying the slot. Before we defer to the next tick, check the
        // watchdog: if the dispatch has been running longer than the
        // configured timeout without settling, assume it's wedged (SDK
        // hang, missing event stream, etc.), interrupt the session, and
        // fail the queue row so the queue keeps draining. Without this
        // guardrail a single hung session would wedge the queue forever.
        const startedAt = row.startedAt ? Date.parse(row.startedAt) : NaN;
        if (Number.isFinite(startedAt)) {
          const elapsed = this.nowFn().getTime() - startedAt;
          if (elapsed > this.dispatchTimeoutMs) {
            this.deps.logger?.warn(
              {
                queueId: row.id,
                sessionId: row.sessionId,
                elapsedMs: elapsed,
                timeoutMs: this.dispatchTimeoutMs,
              },
              "queue dispatch exceeded watchdog timeout — interrupting session and failing row",
            );
            // Fire-and-forget the interrupt: awaiting here would block the
            // tick on a potentially-hung runner, which is exactly the case
            // we're guarding against.
            void this.deps.manager
              .interrupt(row.sessionId)
              .catch((err) => {
                this.deps.logger?.warn(
                  { err, sessionId: row.sessionId },
                  "queue watchdog: interrupt failed",
                );
              });
            this.deps.queue.setStatus(row.id, "failed", {
              finishedAt: this.nowFn().toISOString(),
            });
          }
        }
      }
      // Archived is rare (user archived the session mid-run); we
      // treat it as "still occupying the slot" rather than guess — on the
      // next tick the user's archive probably settled the session to idle.
    }

    // Step 2: if anything is still running after reconciliation, we're done
    // for this tick — one at a time.
    if (this.deps.queue.findRunning().length > 0) return;

    // Step 3: pick the next queued row and dispatch it.
    const next = this.deps.queue.pickNextQueued();
    if (!next) return;

    const project = this.deps.projects.findById(next.projectId);
    if (!project) {
      this.deps.logger?.warn(
        { queueId: next.id, projectId: next.projectId },
        "queued prompt refers to missing project — marking failed",
      );
      this.deps.queue.setStatus(next.id, "failed", {
        finishedAt: this.nowFn().toISOString(),
      });
      return;
    }
    // Trust gate parity with `POST /api/sessions`: a queued row whose
    // project was subsequently untrusted must not spawn a session. Mark
    // the row `failed` (rather than leaving it queued) so the queue keeps
    // draining — leaving it queued would wedge every subsequent row
    // behind it until the project is re-trusted, and `pickNextQueued`
    // would re-pick the same row on every tick.
    if (!project.trusted) {
      this.deps.logger?.warn(
        {
          event: "queue_skipped_untrusted",
          queueId: next.id,
          projectId: project.id,
          projectName: project.name,
        },
        "queued prompt skipped — project not trusted",
      );
      this.deps.queue.setStatus(next.id, "failed", {
        finishedAt: this.nowFn().toISOString(),
      });
      return;
    }

    const title =
      next.title && next.title.trim().length > 0 ? next.title.trim() : "Queued";
    const session = this.deps.sessions.create({
      title,
      projectId: next.projectId,
      model: next.model ?? DEFAULT_MODEL,
      mode: next.mode ?? DEFAULT_MODE,
      // Worktree plumbing for queued prompts is deferred — we mirror the
      // Routines scheduler which creates plain (non-worktree) sessions. If
      // the user wanted a worktree they can flag it on the row; a future
      // enhancement will resolve it here. For now we accept the toggle but
      // don't act on it so the UI isn't lying about what gets stored.
    });
    // Pre-stamp the session status to `running`. Sessions are created `idle`
    // by default, and the Agent SDK only flips them to `running` once its
    // own status event arrives — that can take hundreds of ms on first
    // spawn. Without this pre-stamp our reconciliation loop would see the
    // session as `idle` on the very next tick (2s later) and prematurely
    // mark the queue row `done`. The SDK will override this when it starts
    // emitting events; we're just plugging the window in between.
    this.deps.sessions.setStatus(session.id, "running");
    this.deps.queue.setStatus(next.id, "running", {
      sessionId: session.id,
      startedAt: this.nowFn().toISOString(),
    });

    // Fire-and-forget the initial message. Awaiting it here would block the
    // tick on whatever the Agent SDK is doing — and on first spawn the SDK
    // can sit for a while before returning. The queue row is already in
    // `running` and the next tick will catch the session settling.
    this.deps.manager
      .sendUserMessage(session.id, next.prompt)
      .catch((err) => {
        this.deps.logger?.error(
          { err, queueId: next.id, sessionId: session.id },
          "failed to dispatch queued prompt's initial message",
        );
        // Flip the queue row to failed so the queue doesn't get stuck on a
        // row whose dispatch never produced any session activity.
        this.deps.queue.setStatus(next.id, "failed", {
          finishedAt: this.nowFn().toISOString(),
        });
      });
  }
}
