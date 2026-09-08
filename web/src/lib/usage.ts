import type { ModelId, SessionEvent } from "@claudex/shared";
import { scanTurnEnds } from "@claudex/shared";
import { estimateCostUsd } from "./pricing";

// Re-exported for components that imported these from this module before
// they moved to `@claudex/shared`. New code should import directly from
// the shared package.
export {
  HISTORICAL_TURN_THRESHOLD,
  contextWindowTokens,
} from "@claudex/shared";

/**
 * Per-model usage breakdown. Tokens are cumulative across every `turn_end`
 * attributed to that model.
 */
export interface PerModelUsage {
  model: ModelId | string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SessionUsage {
  totalInput: number;
  totalOutput: number;
  costUsd: number;
  /** Present when the session spanned more than one model; otherwise a single row. */
  perModel: PerModelUsage[];
  /** Count of turn_end events that contributed usage (debug + sanity check). */
  turnCount: number;
  /**
   * "How full is the context window right now" — the real size of the body
   * shipped to the model on the most recent turn:
   * `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`. With
   * prompt caching on, the SDK's `input_tokens` alone only counts *new*
   * uncached input and severely underreports context; cache-read/creation
   * carry the bulk. Zero when no `turn_end` with usage has been seen.
   */
  lastTurnInput: number;
  /**
   * *New* (billable-style) input tokens on the most recent turn — what the
   * SDK calls `input_tokens`, before adding cache reads / creations. Exposed
   * separately from `lastTurnInput` for UIs that want to show "new tokens
   * billed this turn" alongside the full context-body number.
   */
  lastTurnNewInput: number;
  /**
   * Whether `lastTurnInput` is trustworthy as a context-size estimate.
   *
   * False when:
   *   - no `turn_end` with usage has been seen at all, OR
   *   - the most recent turn was persisted before cache fields were emitted
   *     by agent-runner (so the payload has only `inputTokens` +
   *     `outputTokens`, yielding a total of a few dozen — well below any
   *     real turn's context body which is always thousands of tokens).
   *
   * The UI uses this to render `—` instead of a misleading "0%" / "1%" on
   * the context ring. Historical turns stay in this state until the user
   * sends one more message (whose turn_end will carry the full cache
   * breakdown).
   */
  lastTurnContextKnown: boolean;
}

/**
 * Aggregate token usage + cost from a list of persisted `SessionEvent`s.
 *
 * Pure: no network, no state. The caller passes raw events (e.g. the
 * response of `/api/sessions/:id/events`) plus the session's current
 * `ModelId`. Every `turn_end` event whose payload has
 * `usage.inputTokens` / `usage.outputTokens` contributes.
 *
 * Thin wrapper over the shared `scanTurnEnds` scanner; this function keeps
 * the cost-enrichment on top (the pricing table lives in the web bundle).
 *
 * Model attribution: the server does not persist a per-turn model on
 * `turn_end` today, so we attribute every turn to the session's current
 * model. This means a session that swapped models mid-stream will look like
 * a single-model session in the breakdown — a known simplification. Future
 * work: have the server stamp `model` on each `turn_end` payload, then this
 * function can partition correctly.
 */
export function computeSessionUsage(
  events: SessionEvent[],
  sessionModel: ModelId | string,
): SessionUsage {
  const scan = scanTurnEnds(events, sessionModel);

  const perModel: PerModelUsage[] = Array.from(scan.perModel.entries())
    .map(([model, row]) => ({
      model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: estimateCostUsd(model, row.inputTokens, row.outputTokens),
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );

  const costUsd = perModel.reduce((n, r) => n + r.costUsd, 0);

  const lastTurnInput = scan.lastTurn
    ? scan.lastTurn.inputTokens +
      scan.lastTurn.cacheReadInputTokens +
      scan.lastTurn.cacheCreationInputTokens
    : 0;
  const lastTurnNewInput = scan.lastTurn ? scan.lastTurn.inputTokens : 0;

  return {
    totalInput: scan.totalInput,
    totalOutput: scan.totalOutput,
    costUsd,
    perModel,
    turnCount: scan.turnCount,
    lastTurnInput,
    lastTurnNewInput,
    lastTurnContextKnown: scan.lastTurnContextKnown,
  };
}

/** Format a token count as "12.3M", "612k", or "1,234". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n >= 1_000) return (n / 1_000).toFixed(2).replace(/\.00$/, "") + "k";
  return n.toLocaleString();
}

/** Format a USD amount with up to 4 decimals for small values. */
export function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}
