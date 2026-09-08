import type { ModelId, SessionEvent, UsageSummaryResponse } from "@claudex/shared";
import { scanTurnEnds } from "@claudex/shared";

// Re-exported for callers that imported the threshold from this module
// before it moved to `@claudex/shared`. New code should import directly
// from the shared package.
export { HISTORICAL_TURN_THRESHOLD } from "@claudex/shared";

/**
 * Server-side equivalent of `computeSessionUsage` (web/src/lib/usage.ts) —
 * scans `turn_end` events and returns the subset of fields the UsagePanel,
 * ChatTasksRail, and Chat header ring actually consume. Deliberately does
 * NOT include cost — cost computation lives client-side where the pricing
 * table is, and we want to keep server-side logic narrow.
 *
 * Thin wrapper over the shared `scanTurnEnds` scanner: maps the Map output
 * to the array shape the HTTP response expects and computes `lastTurnInput`
 * as "context body shipped that turn".
 */
export function computeUsageSummary(
  events: SessionEvent[],
  sessionModel: ModelId | string,
): UsageSummaryResponse {
  const scan = scanTurnEnds(events, sessionModel);

  const perModel = Array.from(scan.perModel.entries())
    .map(([model, row]) => ({
      model: String(model),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    }))
    .sort(
      (a, b) =>
        b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    );

  const lastTurnInput = scan.lastTurn
    ? scan.lastTurn.inputTokens +
      scan.lastTurn.cacheReadInputTokens +
      scan.lastTurn.cacheCreationInputTokens
    : 0;

  return {
    totalInput: scan.totalInput,
    totalOutput: scan.totalOutput,
    lastTurnInput,
    lastTurnContextKnown: scan.lastTurnContextKnown,
    turnCount: scan.turnCount,
    perModel,
  };
}
