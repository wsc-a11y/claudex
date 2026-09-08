import type { CustomModel, ModelId } from "@claudex/shared";
import { BUILTIN_MODELS } from "@claudex/shared";

/**
 * Per-model pricing table used by the front-end Usage panel.
 *
 * Prices are USD per 1M tokens. Values track the Anthropic public pricing
 * for the models the session selector exposes. When Anthropic publishes new
 * prices, update this table — server-side we don't track cost at all, the
 * panel is purely a local estimate.
 *
 * Note: we intentionally use only input/output tokens. Cache-read and
 * cache-write tiers exist on the Anthropic side but the SDK's `result.usage`
 * we currently persist in `session_events` only carries `input_tokens` and
 * `output_tokens` — so our estimate will over-count cost relative to a real
 * bill that benefits from caching. That's an acceptable upper bound for now.
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-opus-4-7": { inputPer1M: 5.0, outputPer1M: 25.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
};

export const MODEL_LABEL: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};

/**
 * Resolve a model id to a human-readable label. Checks custom models first
 * (from app settings), then built-in labels, then falls back to the raw id.
 */
export function getModelLabel(
  model: string,
  customModels?: CustomModel[] | null,
): string {
  if (customModels) {
    const custom = customModels.find((m) => m.id === model);
    if (custom) return custom.label;
  }
  return MODEL_LABEL[model] ?? model;
}

/** One entry in a model selector grid / pill list. */
export interface ModelEntry {
  id: string;
  label: string;
}

/**
 * Build the full model list: built-in Claude models first, then any custom
 * models the user defined in Settings → Models. Every UI model selector
 * (Chat header, NewSessionSheet, SessionSettingsSheet, Queue, Routines)
 * should call this instead of hard-coding the list.
 */
export function getAllModelEntries(
  customModels?: CustomModel[] | null,
): ModelEntry[] {
  const builtIn: ModelEntry[] = BUILTIN_MODELS.map((id) => ({
    id,
    label: MODEL_LABEL[id] ?? id,
  }));
  const custom: ModelEntry[] = (customModels ?? []).map((m) => ({
    id: m.id,
    label: m.label,
  }));
  return [...builtIn, ...custom];
}

/**
 * Cost in USD for a given (model, inputTokens, outputTokens) triple.
 * Unknown model falls back to Opus pricing so we don't silently under-count
 * when the SDK hands us something we don't yet have a row for.
 */
export function estimateCostUsd(
  model: ModelId | string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p =
    (MODEL_PRICING as Record<string, ModelPricing>)[model] ??
    MODEL_PRICING["claude-opus-4-8"];
  return (
    (inputTokens / 1_000_000) * p.inputPer1M +
    (outputTokens / 1_000_000) * p.outputPer1M
  );
}
