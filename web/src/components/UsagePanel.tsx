import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Link } from "react-router-dom";
import type { Session, UsageSummaryResponse } from "@claudex/shared";
import { api } from "@/api/client";
import {
  contextWindowTokens,
  formatTokens,
  formatUsd,
} from "@/lib/usage";
import { estimateCostUsd, MODEL_LABEL } from "@/lib/pricing";

/**
 * Usage panel — the mockup s-08 "iPhone · usage sheet" translated into a
 * real component. Bottom sheet on mobile, centered modal on desktop.
 *
 * Data: re-fetches `/api/sessions/:id/events` on open and aggregates every
 * `turn_end` payload's `usage.{inputTokens,outputTokens}`. Nothing is sent
 * back — this is read-only. Closed by backdrop, Esc, or the × button.
 *
 * Context %: computed client-side as `lastTurnInput / contextWindow(model)`.
 * We use the most recent `turn_end`'s `inputTokens` (not the cumulative
 * `totalInput`) because each turn resends the full conversation to the
 * model, so prior turns' input overlaps — summing would wildly over-count.
 * The context window is a static per-model table in `lib/usage.ts` (every
 * current Claude 4.x model is 200k). This is an estimate, not a runtime
 * report, but it's honest and actionable.
 *
 * What we intentionally do NOT show (kept explicit so future reviewers know
 * it's a known gap rather than an oversight):
 *
 *  - **Plan-period usage** (mockup shows "58% used · resets Mon 16:00"):
 *    requires cross-session + subscription-plan data we don't have. Skipped.
 *  - **Last-7-days chart / top sessions** (desktop mockup): same reason.
 */
export function UsagePanel({
  session,
  pieceCount,
  onClose,
}: {
  session: Session;
  /**
   * Transcript piece count — when provided, the usage summary is refetched
   * each time a new piece lands so the ring / token stats reflect in-flight
   * turns. Without it the panel snapshots on open.
   */
  pieceCount?: number;
  onClose: () => void;
}) {
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getUsageSummary(session.id);
        if (cancelled) return;
        setUsage(res);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "load_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id, session.model, pieceCount]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Context %: latest turn's inputTokens / known model context window. This
  // is an estimate (we don't get a live context gauge from the SDK), but
  // it's honest — prior turns' input overlaps with the current turn's, so
  // only the most recent turn's input is a meaningful proxy. Rows persisted
  // before agent-runner started emitting cache fields carry only
  // `input_tokens` (a few dozen on warm cache), which would misread as
  // "0%"; `contextPctKnown` gates that case and the ring shows `—` instead.
  const contextWindow = contextWindowTokens(session.model);
  const lastTurnInput = usage?.lastTurnInput ?? 0;
  const contextPctKnown = usage?.lastTurnContextKnown ?? false;
  const contextPct = contextPctKnown
    ? Math.min(1, lastTurnInput / contextWindow)
    : 0;
  const unknownReason =
    usage && usage.turnCount === 0
      ? "还没有回合 —— 发送一条消息试试"
      : "历史回合 —— 缓存字段未持久化;下一回合会反映真实上下文";

  return (
    <div
      className="fixed inset-0 z-30 flex items-end sm:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="会话用量"
    >
      <button
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
      />
      <div
        className={
          "relative w-full sm:max-w-[440px] bg-canvas border-t sm:border border-line " +
          "sm:rounded-2xl rounded-t-[18px] shadow-lift max-h-[88vh] sm:max-h-[86vh] " +
          "flex flex-col"
        }
      >
        <div className="flex justify-center pt-2 sm:hidden">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>
        <div className="px-4 py-3 border-b border-line flex items-center gap-2">
          <div className="min-w-0">
            <div className="text-ui-lg font-medium">用量</div>
            <div className="mono text-ui text-ink-muted">
              仅当前会话
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded bg-paper border border-line flex items-center justify-center"
            aria-label="关闭用量面板"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {err && (
            <div className="rounded border border-danger/30 bg-danger-wash text-ui text-danger-ink px-3 py-2">
              无法加载用量: {err}
            </div>
          )}

          {/* Big ring — context for the current session. */}
          <div className="flex flex-col items-center p-4 border border-line rounded-lg bg-canvas">
            <Ring
              pct={contextPct}
              known={contextPctKnown}
              label={contextPctKnown ? `${Math.round(contextPct * 100)}%` : "—"}
              sublabel="上下文"
            />
            <div
              className="mt-2 text-ui text-ink-muted mono text-center max-w-[34ch]"
              title={contextPctKnown ? undefined : unknownReason}
            >
              {contextPctKnown
                ? `${formatTokens(lastTurnInput)} / ${formatTokens(contextWindow)} tokens`
                : unknownReason}
            </div>
          </div>

          {/* Token counts for this session. */}
          <div className="rounded-lg border border-line bg-canvas p-4">
            <div className="caps text-ink-muted mb-2">Token · 本次会话</div>
            {usage == null && !err ? (
              <div className="text-ui text-ink-muted">加载中…</div>
            ) : usage && usage.turnCount === 0 ? (
              <div className="text-ui text-ink-muted">
                还没有已完成的回合。
              </div>
            ) : usage ? (
              <div className="grid grid-cols-3 gap-3 text-ui">
                <Stat label="输入" value={formatTokens(usage.totalInput)} />
                <Stat label="输出" value={formatTokens(usage.totalOutput)} />
                <Stat
                  label="总计"
                  value={formatTokens(usage.totalInput + usage.totalOutput)}
                />
              </div>
            ) : null}
          </div>

          {/* Per-model breakdown when the session spanned >1 model.
              Today there's only ever one row because we attribute all turns
              to the session's current model (see usage-summary.ts). We still
              render it so the layout is right when that changes. */}
          {usage && usage.perModel.length > 0 && (
            <div className="rounded-lg border border-line bg-canvas p-4">
              <div className="caps text-ink-muted mb-2">按模型</div>
              <div className="space-y-2 text-ui">
                {usage.perModel.map((row) => {
                  const cost = estimateCostUsd(
                    row.model,
                    row.inputTokens,
                    row.outputTokens,
                  );
                  return (
                    <div
                      key={String(row.model)}
                      className="flex items-center gap-2"
                    >
                      <span className="h-2 w-2 rounded-full bg-klein" />
                      <span>
                        {(MODEL_LABEL as Record<string, string>)[
                          String(row.model)
                        ] ?? String(row.model)}
                      </span>
                      <span className="ml-auto mono text-ink-muted">
                        {formatTokens(row.inputTokens + row.outputTokens)} tok
                      </span>
                      <span className="mono text-ink-muted shrink-0">
                        {formatUsd(cost)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Cost estimate — front-end pricing table, not a real bill. */}
          <div className="rounded-lg border border-line bg-canvas p-4">
            <div className="caps text-ink-muted mb-1.5">成本估算</div>
            <div className="display text-ui-display-xl leading-none">
              {formatUsd(
                usage
                  ? usage.perModel.reduce(
                      (n, r) =>
                        n + estimateCostUsd(r.model, r.inputTokens, r.outputTokens),
                      0,
                    )
                  : 0,
              )}
            </div>
            <div className="text-ui text-ink-muted mt-1.5 leading-snug">
              根据模型公布的每 Token 费率的前端估算。未考虑提示词缓存折扣,因此这只是一个上限。你的实际计划计费可能有所不同。
            </div>
          </div>

          {/* Mobile-only deep link to the full-screen analytics page.
              Hidden md+ because desktop users reach /usage directly via the
              sidebar nav or by clicking the desktop context ring. */}
          <div className="md:hidden">
            <Link
              to={`/usage?session=${encodeURIComponent(session.id)}`}
              onClick={onClose}
              className="block text-center text-ui text-klein hover:underline"
            >
              完整用量 →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="caps text-ink-muted">{label}</div>
      <div className="mono text-ui mt-0.5">{value}</div>
    </div>
  );
}

/**
 * Ring progress indicator. Mirrors the mockup s-08 SVG ring at 140px.
 * When `known` is false we dim the progress arc so the UI signals it's a
 * placeholder.
 */
function Ring({
  pct,
  known,
  label,
  sublabel,
}: {
  pct: number; // 0..1
  known: boolean;
  label: string;
  sublabel: string;
}) {
  const r = 60;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.max(0, Math.min(1, pct)));
  return (
    <div className="relative">
      <svg width={140} height={140}>
        <circle
          cx={70}
          cy={70}
          r={r}
          fill="none"
          stroke="rgb(var(--c-line))"
          strokeWidth={10}
        />
        <circle
          cx={70}
          cy={70}
          r={r}
          fill="none"
          stroke={known ? "rgb(var(--c-klein))" : "rgb(var(--c-klein) / 0.4)"}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 70 70)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="display text-[27px]">{label}</div>
        <div className="caps text-ink-muted">{sublabel}</div>
      </div>
    </div>
  );
}

/**
 * Small header-mounted context ring button. Mirrors the tiny ring on each
 * home-screen session row in the mockup. Click to open the `UsagePanel`.
 */
export function ContextRingButton({
  pct,
  known,
  onClick,
  disabled,
}: {
  pct: number; // 0..1
  known: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const r = 9;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  const offset = circumference * (1 - clamped);
  const pctLabel = known ? `${Math.round(clamped * 100)}%` : "—";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={known ? `上下文 ${pctLabel} · 点按查看用量` : "会话用量"}
      aria-label="打开用量面板"
      className="h-8 w-8 rounded border border-line bg-canvas flex items-center justify-center hover:bg-paper disabled:opacity-40 shrink-0 transition-colors"
    >
      <svg width={22} height={22} viewBox="0 0 24 24">
        <circle
          cx={12}
          cy={12}
          r={r}
          fill="none"
          stroke="rgb(var(--c-line))"
          strokeWidth={2.5}
        />
        <circle
          cx={12}
          cy={12}
          r={r}
          fill="none"
          stroke={known ? "rgb(var(--c-klein))" : "rgb(var(--c-klein) / 0.6)"}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 12 12)"
        />
      </svg>
    </button>
  );
}
