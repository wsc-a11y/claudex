import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@claudex/shared";
import { computeUsageSummary } from "../src/sessions/usage-summary.js";

function makeTurnEnd(
  seq: number,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  } | null,
  stopReason: string = "end_turn",
  billingUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  } | null,
): SessionEvent {
  return {
    id: `ev-${seq}`,
    sessionId: "s1",
    kind: "turn_end",
    seq,
    createdAt: new Date().toISOString(),
    payload: {
      stopReason,
      usage,
      ...(billingUsage !== undefined ? { billingUsage } : {}),
    },
  };
}

describe("computeUsageSummary", () => {
  it("returns zeros on an empty event list", () => {
    const out = computeUsageSummary([], "claude-opus-4-8");
    expect(out.totalInput).toBe(0);
    expect(out.totalOutput).toBe(0);
    expect(out.lastTurnInput).toBe(0);
    expect(out.lastTurnContextKnown).toBe(false);
    expect(out.turnCount).toBe(0);
    expect(out.perModel).toEqual([]);
  });

  it("sums a single turn's input + cacheRead + cacheCreation as the context body", () => {
    const events: SessionEvent[] = [
      makeTurnEnd(0, {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20000,
        cacheCreationInputTokens: 5000,
      }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-8");
    expect(out.turnCount).toBe(1);
    // 100 + 20000 + 5000 = 25100 — above HISTORICAL_TURN_THRESHOLD (500)
    expect(out.lastTurnInput).toBe(25100);
    expect(out.lastTurnContextKnown).toBe(true);
    expect(out.totalInput).toBe(25100);
    expect(out.totalOutput).toBe(50);
    expect(out.perModel).toHaveLength(1);
    expect(out.perModel[0]).toEqual({
      model: "claude-opus-4-8",
      inputTokens: 25100,
      outputTokens: 50,
    });
  });

  it("aggregates totals across multiple turns and records the last turn's input", () => {
    const events: SessionEvent[] = [
      makeTurnEnd(0, {
        inputTokens: 50,
        outputTokens: 100,
        cacheReadInputTokens: 10000,
      }),
      makeTurnEnd(1, {
        inputTokens: 70,
        outputTokens: 200,
        cacheReadInputTokens: 20000,
        cacheCreationInputTokens: 1000,
      }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-8");
    expect(out.turnCount).toBe(2);
    // Last turn: 70 + 20000 + 1000 = 21070
    expect(out.lastTurnInput).toBe(21070);
    expect(out.lastTurnContextKnown).toBe(true);
    // Totals: (50+10000) + (70+20000+1000) = 31120 input, 300 output
    expect(out.totalInput).toBe(31120);
    expect(out.totalOutput).toBe(300);
  });

  it("flips lastTurnContextKnown=false for historical rows below threshold", () => {
    // Only input_tokens present — pre-cache-fields row. Sum is 20 tokens,
    // well under the 500 threshold, so the ring should render `—`.
    const events: SessionEvent[] = [
      makeTurnEnd(0, { inputTokens: 20, outputTokens: 40 }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-8");
    expect(out.turnCount).toBe(1);
    expect(out.lastTurnInput).toBe(20);
    expect(out.lastTurnContextKnown).toBe(false);
  });

  it("ignores turn_end events with null/missing usage", () => {
    const events: SessionEvent[] = [
      makeTurnEnd(0, null),
      makeTurnEnd(1, { inputTokens: 50, cacheReadInputTokens: 1000 }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-8");
    expect(out.turnCount).toBe(1);
    expect(out.lastTurnInput).toBe(1050);
  });

  it("does not accumulate intermediate tool_use chunks into totalInput", () => {
    // Regression test for Bug A (plans/abstract-strolling-music.md): the CLI
    // JSONL importer emits one turn_end per assistant record, including
    // intermediate tool-use chunks that share the same warm cache block.
    // `scanTurnEnds` must only accumulate on FINAL stop reasons, otherwise
    // a 10-tool-call turn triple-counts ~200K cache read tokens into
    // `totalInput`.
    const cacheRead = 200_000;
    const events: SessionEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(
        makeTurnEnd(
          i,
          { inputTokens: 10, outputTokens: 50, cacheReadInputTokens: cacheRead },
          "tool_use",
        ),
      );
    }
    events.push(
      makeTurnEnd(
        10,
        {
          inputTokens: 15,
          outputTokens: 80,
          cacheReadInputTokens: cacheRead + 500,
          cacheCreationInputTokens: 200,
        },
        "end_turn",
      ),
    );

    const out = computeUsageSummary(events, "claude-opus-4-8");
    // One real turn, only the `end_turn` chunk contributes to the rollup.
    expect(out.turnCount).toBe(1);
    expect(out.totalInput).toBe(15 + (cacheRead + 500) + 200);
    expect(out.totalOutput).toBe(80);
    // But `lastTurnInput` still follows the most recent chunk — in this case
    // the end_turn chunk is last, so it also matches the final total.
    expect(out.lastTurnInput).toBe(15 + (cacheRead + 500) + 200);
  });

  it("lastTurnInput follows mid-turn tool_use chunks even though they don't accumulate", () => {
    // The context ring reads `lastTurnInput` so it reflects the model's
    // current context body, including mid-turn. If the session is observed
    // between tool calls, the most recent turn_end has
    // stopReason="tool_use" — `lastTurnInput` must still follow it.
    const events: SessionEvent[] = [
      makeTurnEnd(
        0,
        {
          inputTokens: 20,
          outputTokens: 100,
          cacheReadInputTokens: 50_000,
        },
        "end_turn",
      ),
      makeTurnEnd(
        1,
        {
          inputTokens: 15,
          outputTokens: 30,
          cacheReadInputTokens: 80_000,
        },
        "tool_use",
      ),
    ];

    const out = computeUsageSummary(events, "claude-opus-4-8");
    // Only the end_turn chunk counts toward totalInput.
    expect(out.turnCount).toBe(1);
    expect(out.totalInput).toBe(20 + 50_000);
    // But lastTurnInput reflects the most recent (tool_use) chunk.
    expect(out.lastTurnInput).toBe(15 + 80_000);
  });

  it("totals prefer billingUsage (cumulative) when present; lastTurn always reads usage (per-call)", () => {
    // Live runner from the per-call fix onward writes both fields:
    //   - `usage` = last sub-call's per-call usage (drives the ring)
    //   - `billingUsage` = SDK `result.usage` (cumulative across sub-calls)
    // The ring math must read per-call so it reflects the actual prompt
    // size; totals must read cumulative so a 10-tool-use turn's billable
    // cache reads sum correctly instead of collapsing to the final
    // sub-call's number.
    const events: SessionEvent[] = [
      makeTurnEnd(
        0,
        {
          inputTokens: 10,
          outputTokens: 30,
          cacheReadInputTokens: 150_000, // per-call: final sub-call only
          cacheCreationInputTokens: 0,
        },
        "end_turn",
        {
          inputTokens: 15,
          outputTokens: 50,
          cacheReadInputTokens: 250_000, // cumulative: all sub-calls
          cacheCreationInputTokens: 0,
        },
      ),
    ];

    const out = computeUsageSummary(events, "claude-opus-4-8");
    expect(out.turnCount).toBe(1);
    // Ring: per-call only — 10 + 150k = 150_010
    expect(out.lastTurnInput).toBe(150_010);
    // Totals: cumulative — 15 + 250k = 250_015
    expect(out.totalInput).toBe(250_015);
    expect(out.totalOutput).toBe(50);
    // perModel rolls up the cumulative numbers too
    expect(out.perModel[0]).toEqual({
      model: "claude-opus-4-8",
      inputTokens: 250_015,
      outputTokens: 50,
    });
  });

  it("falls back to usage for totals when billingUsage is absent (CLI imports / legacy live)", () => {
    // CLI JSONL importer never writes billingUsage — its turn_ends are
    // per-assistant per-call. Pre-fix live rows are the same shape (sans
    // the per-call snapshot, but the row only has `usage`). For both,
    // totals fall back to summing the per-call `usage`, preserving the
    // pre-fix semantics.
    const events: SessionEvent[] = [
      makeTurnEnd(0, {
        inputTokens: 10,
        outputTokens: 30,
        cacheReadInputTokens: 150_000,
      }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-8");
    expect(out.totalInput).toBe(150_010);
    expect(out.lastTurnInput).toBe(150_010);
  });
});
