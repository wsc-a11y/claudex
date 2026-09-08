import type { ModelId, SessionEvent } from "./models.js";

/**
 * Minimum `lastTurn` input total below which we treat the most recent
 * `turn_end` as "historical" — i.e. persisted before the runner started
 * emitting cache fields, so callers should render `—` on the context ring
 * instead of a misleading 0%.
 *
 * Rationale: any real turn ships at least the system prompt + tool
 * definitions, which are thousands of tokens. `input_tokens` alone (without
 * cache reads) is ~6-30 on a cache-warmed turn, so anything below this
 * threshold is almost certainly a pre-cache-fields row. Using a number
 * instead of an explicit "has cache fields" bit keeps the check honest even
 * if the SDK ever returns `0` for cache reads on a cold turn.
 */
export const HISTORICAL_TURN_THRESHOLD = 500;

/**
 * Known context window sizes (in tokens) per model id. Used to render the
 * "context %" ring on the session list and the chat header as
 * `lastTurnInput / contextWindow`.
 *
 * Claude 4.x Opus + Sonnet ship with 1M windows; Haiku stays at 200k.
 */
const CONTEXT_WINDOW_TOKENS: Record<ModelId, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

/** Fallback for unknown model ids. 1M matches the current flagship default so
 * an unmapped SKU doesn't immediately render as "100% full". */
const CONTEXT_WINDOW_FALLBACK = 1_000_000;

/**
 * Context window size (tokens) for a given model id. Defined in shared so
 * both the server (persisting `stats_context_pct` at `turn_end`) and the web
 * bundle (computing the ring live from events) agree on the denominator.
 */
export function contextWindowTokens(model: ModelId | string): number {
  return (
    (CONTEXT_WINDOW_TOKENS as Record<string, number>)[String(model)] ??
    CONTEXT_WINDOW_FALLBACK
  );
}

/** Raw per-turn totals extracted from a single `turn_end` event's usage payload. */
export interface PerTurnTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Result of a single-pass scan over a session's events. Both the server
 * summary and the web session-usage compute live on top of this shape.
 *
 * `totalInput` is the sum, across every **final** (end-of-turn) `turn_end`,
 * of the full context body shipped that turn: `inputTokens +
 * cacheReadInputTokens + cacheCreationInputTokens`. Intermediate
 * `stopReason === "tool_use"` chunks are NOT accumulated — the CLI JSONL
 * writes a `turn_end` for every intermediate tool-use chunk with its own
 * `cache_read` usage, and accumulating them double- / triple-counted the
 * same warm cache block per turn. Matches Claude Code CLI's statusline
 * math (one accumulation per real conversation turn).
 *
 * `lastTurn` captures the raw per-turn totals for the most recent non-empty
 * turn — including intermediate chunks, so the context ring reflects the
 * model's current context body even mid-turn. Callers derive any
 * presentation-level fields (e.g. "new tokens billed this turn") from it
 * without re-scanning events.
 */
export interface UsageScan {
  totalInput: number;
  totalOutput: number;
  turnCount: number;
  lastTurn: PerTurnTotals | null;
  /** `true` when `lastTurn`'s context-body total is at least `HISTORICAL_TURN_THRESHOLD`. */
  lastTurnContextKnown: boolean;
  /** Per-model rollup keyed by raw model id. Today every turn is attributed
   * to the caller-provided `sessionModel` (the server doesn't persist a
   * per-turn model) — see `computeSessionUsage` for the simplification
   * note. */
  perModel: Map<
    ModelId | string,
    { inputTokens: number; outputTokens: number; count: number }
  >;
}

/**
 * Stop reasons that mark an *intermediate* chunk — NOT a true end-of-turn.
 * Anything else counts as a final turn and accumulates into `totalInput`.
 *
 * We inverted the "allow-list" direction deliberately: the CLI JSONL uses
 * Anthropic API's `stop_reason` vocabulary (`end_turn` / `stop_sequence` /
 * `max_tokens` / `pause_turn`) while the live runner forwards the SDK
 * `result.subtype` (`success` / `error_during_execution` / `error_max_turns`
 * / `error_max_budget_usd` / `error_max_structured_output_retries`). Both
 * vocabularies are end-of-turn and there's no benefit to enumerating them;
 * any new SDK subtype should count as final by default.
 *
 * The ones we *do* need to exclude:
 *   - `"tool_use"` — the CLI JSONL emits a turn_end for every intermediate
 *     tool-use chunk with its own `usage`, sharing the same warm cache block
 *     as the real end-of-turn. Accumulating them triple-counts the cache
 *     body per turn and was the source of tokens climbing to "tens of M"
 *     on long sessions (Bug A in plans/abstract-strolling-music.md).
 *   - `"unknown"` — `cli-events-import.ts` writes this when the source
 *     record had no `stop_reason`; laundering that into a fake final turn
 *     would reintroduce the same over-counting.
 */
const NON_FINAL_STOP_REASONS = new Set(["tool_use", "unknown"]);

/**
 * Canonical single-pass scan over a session's event log.
 *
 * Walks `events` once, filters to `turn_end` rows with a usage payload, and
 * returns the aggregate shape both the server-side `computeUsageSummary` and
 * the web-side `computeSessionUsage` need. Keeps the token math (what counts
 * as "context body", how to handle missing cache fields, when a turn is
 * historical) in exactly one place.
 *
 * Empty / null usage, and turns with total zero tokens, are skipped — they
 * don't contribute to any counter.
 *
 * Two accumulation rules, matching Claude Code CLI's statusline:
 *   - `lastTurn` updates on every non-empty `turn_end`, including
 *     intermediate `stopReason === "tool_use"` chunks, so the context ring
 *     reflects the model's current context body even mid-turn.
 *   - `totalInput` / `totalOutput` / `turnCount` / `perModel` only
 *     accumulate when `stopReason ∈ FINAL_STOP_REASONS` — one accumulation
 *     per real conversation turn.
 */
export function scanTurnEnds(
  events: SessionEvent[],
  sessionModel: ModelId | string,
): UsageScan {
  const perModel = new Map<
    ModelId | string,
    { inputTokens: number; outputTokens: number; count: number }
  >();
  let turnCount = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let lastTurn: PerTurnTotals | null = null;

  for (const ev of events) {
    if (ev.kind !== "turn_end") continue;
    const payload = ev.payload as Record<string, unknown>;
    type RawUsage = {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    };
    const usage = payload.usage as RawUsage | null | undefined;
    // `billingUsage` is the SDK's cumulative `result.usage` for live
    // sessions (post per-call fix). Drives totals/perModel. CLI imports
    // and pre-fix live rows omit it — fall back to per-call `usage`,
    // which preserves the existing "context body summed across final
    // turns" semantics for those rows.
    const billingUsage = (payload.billingUsage as RawUsage | null | undefined) ?? null;
    if (!usage && !billingUsage) continue;
    const inp = Number(usage?.inputTokens ?? 0) | 0;
    const out = Number(usage?.outputTokens ?? 0) | 0;
    const cacheRead = Number(usage?.cacheReadInputTokens ?? 0) | 0;
    const cacheCreate = Number(usage?.cacheCreationInputTokens ?? 0) | 0;
    const totalInputThisTurn = inp + cacheRead + cacheCreate;
    if (totalInputThisTurn === 0 && out === 0 && !billingUsage) continue;

    // Always refresh `lastTurn` from per-call `usage` — this is the
    // context ring's source, and it should follow the most recent turn's
    // final-sub-call prompt size even mid-turn. We deliberately do NOT
    // read `billingUsage` here: cumulative cache-read across sub-calls
    // double-counts the warm prefix and is what made the ring read
    // 100%+ on long turns. Skip the refresh on an empty `usage` payload
    // so a `billingUsage`-only row can't blank out a real lastTurn.
    if (usage && (totalInputThisTurn > 0 || out > 0)) {
      lastTurn = {
        inputTokens: inp,
        outputTokens: out,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreate,
      };
    }

    // Only accumulate totals on real end-of-turn records. Intermediate
    // tool_use chunks share the same warm cache block and would triple-count.
    const stopReason = String(payload.stopReason ?? "");
    if (NON_FINAL_STOP_REASONS.has(stopReason)) continue;

    // Prefer `billingUsage` (cumulative across SDK sub-calls) for
    // totals — that's the true billable breakdown for live sessions.
    // CLI imports / legacy rows fall back to `usage`.
    const billingSrc = billingUsage ?? usage;
    if (!billingSrc) continue;
    const billInp = Number(billingSrc.inputTokens ?? 0) | 0;
    const billOut = Number(billingSrc.outputTokens ?? 0) | 0;
    const billCacheRead = Number(billingSrc.cacheReadInputTokens ?? 0) | 0;
    const billCacheCreate = Number(billingSrc.cacheCreationInputTokens ?? 0) | 0;
    const billingInputThisTurn = billInp + billCacheRead + billCacheCreate;
    if (billingInputThisTurn === 0 && billOut === 0) continue;

    const key: ModelId | string = sessionModel;
    const row = perModel.get(key);
    if (row) {
      row.inputTokens += billingInputThisTurn;
      row.outputTokens += billOut;
      row.count += 1;
    } else {
      perModel.set(key, {
        inputTokens: billingInputThisTurn,
        outputTokens: billOut,
        count: 1,
      });
    }
    turnCount += 1;
    totalInput += billingInputThisTurn;
    totalOutput += billOut;
  }

  const lastTurnTotal = lastTurn
    ? lastTurn.inputTokens +
      lastTurn.cacheReadInputTokens +
      lastTurn.cacheCreationInputTokens
    : 0;

  return {
    totalInput,
    totalOutput,
    turnCount,
    lastTurn,
    lastTurnContextKnown: lastTurnTotal >= HISTORICAL_TURN_THRESHOLD,
    perModel,
  };
}
