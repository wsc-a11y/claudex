import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  Session,
  UsageRangeResponse,
  UsageTodayResponse,
} from "@claudex/shared";
import { AppShell } from "@/components/AppShell";
import { api } from "@/api/client";
import { useSessions } from "@/state/sessions";
import {
  computeSessionUsage,
  contextWindowTokens,
  formatTokens,
  formatUsd,
  type SessionUsage,
} from "@/lib/usage";
import { estimateCostUsd, MODEL_LABEL } from "@/lib/pricing";

// ---------------------------------------------------------------------------
// Usage analytics — full-screen `/usage` page. Desktop layout adapted from
// mockup s-08 desktop (a 4-col top row + 3-col second row). Mobile layout
// adapted from s-08 iPhone (lines 1512–1557): compact stacked cards with a
// back chevron header, big ring, plan-period empty-state, per-model rows,
// and a cost-estimate card. Both surfaces pull the same data —
// `/api/usage/today` + `/api/usage/range` + a replay of the active session's
// events through `computeSessionUsage`.
//
// Tiles shipped (everything else is an honest empty state — we don't fake
// quota / plan data that claudex doesn't have):
//
//   1. Current session: when `?session=<id>` is set *or* there's a most-
//      recent non-archived top-level session. Replays that session's events
//      through `computeSessionUsage` and renders the same ring the inline
//      Chat context ring shows.
//   2. Plan period: OMITTED. Rendered as a card with "No plan data" copy.
//   3. Today · tokens: `/api/usage/today` totals + per-model mini rows.
//   4. 7-day bar chart: `/api/usage/range?days=7`, stacked by model
//      (desktop only — the 700×160 SVG doesn't squeeze into 390px legibly).
//   5. Top sessions: from `/api/usage/today` — already sorted server-side
//      (desktop only).
//
// Time-range chips ("Today / 7 days / 30 days") — only "Today" is wired;
// the other two are visibly disabled so we don't lie about the data.
// ---------------------------------------------------------------------------

export function UsagePage() {
  const { sessions } = useSessions();
  const [params] = useSearchParams();
  const explicitSessionId = params.get("session");

  // Prefer the caller-provided session id, else the most-recent non-archived
  // top-level session in the local store. Either way, this is just for the
  // "current session" tile — the Today tile and the bar chart are independent.
  const activeSession: Session | null = useMemo(() => {
    if (explicitSessionId) {
      return sessions.find((s) => s.id === explicitSessionId) ?? null;
    }
    return (
      sessions
        .filter((s) => !s.parentSessionId && s.status !== "archived")
        .sort((a, b) =>
          (b.lastMessageAt ?? b.updatedAt).localeCompare(
            a.lastMessageAt ?? a.updatedAt,
          ),
        )[0] ?? null
    );
  }, [sessions, explicitSessionId]);

  // Per-session usage for the Current-session tile.
  const [sessionUsage, setSessionUsage] = useState<SessionUsage | null>(null);
  useEffect(() => {
    if (!activeSession) {
      setSessionUsage(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listEvents(activeSession.id);
        if (cancelled) return;
        setSessionUsage(computeSessionUsage(res.events, activeSession.model));
      } catch {
        if (!cancelled) setSessionUsage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSession?.id, activeSession?.model]);

  // Cross-session aggregates.
  const [today, setToday] = useState<UsageTodayResponse | null>(null);
  const [range, setRange] = useState<UsageRangeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, r] = await Promise.all([
          api.getUsageToday(),
          api.getUsageRange(7),
        ]);
        if (cancelled) return;
        setToday(t);
        setRange(r);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell tab="usage">
      {/* Mobile layout (<md). Adapted from mockup s-08 iPhone: a lightweight
          header, big context ring, plan-period empty-state, per-model rows,
          and a cost estimate. The 7-day bar chart + top-sessions list are
          desktop-only — a 700px SVG bar chart doesn't read at 390px and the
          equivalent info is already a tap away via the session list. */}
      <div className="md:hidden flex-1 min-h-0 flex flex-col">
        <header className="shrink-0 px-4 py-2.5 border-b border-line flex items-center gap-2 bg-canvas">
          <Link
            to="/sessions"
            aria-label="返回会话列表"
            className="h-8 w-8 rounded bg-paper border border-line flex items-center justify-center shrink-0"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="w-4 h-4"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </Link>
          <div className="min-w-0">
            <div className="caps text-ink-muted">用量</div>
            <div className="display text-ui-heading leading-tight mt-0.5 truncate">
              今日消耗
            </div>
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="rounded border border-danger/30 bg-danger-wash text-ui text-danger-ink px-3 py-2">
              无法加载用量: {error}
            </div>
          )}
          {loading && !error ? (
            <UsageSkeleton />
          ) : (
            <>
              <MobileSessionRing session={activeSession} usage={sessionUsage} />
              <MobilePlanPeriodCard />
              <MobileByModelCard today={today} />
              <MobileCostCard today={today} />
            </>
          )}
        </div>
      </div>

      <div className="hidden md:block flex-1 min-h-0 overflow-y-auto p-6">
        <header className="flex items-baseline gap-4 mb-6">
          <div>
            <div className="caps text-ink-muted">用量</div>
            <h1 className="display text-ui-display md:text-ui-display-lg leading-tight mt-0.5">
              今日消耗
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="h-8 px-3 rounded-sm border border-line bg-canvas text-ui"
              aria-pressed="true"
            >
              今日
            </button>
            <button
              type="button"
              disabled
              title="即将推出"
              className="h-8 px-3 rounded-sm border border-line bg-paper text-ui opacity-60 cursor-not-allowed"
            >
              7 天
            </button>
            <button
              type="button"
              disabled
              title="即将推出"
              className="h-8 px-3 rounded-sm border border-line bg-paper text-ui opacity-60 cursor-not-allowed"
            >
              30 天
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded border border-danger/30 bg-danger-wash text-ui text-danger-ink px-3 py-2">
            无法加载用量: {error}
          </div>
        )}

        {loading && !error ? (
          <UsageSkeleton desktop />
        ) : (
          <>
            {/* Row 1: current session (2) + plan period (1) + today tokens (1).
                At md (768–1280) the 4-col grid compresses painfully, so we drop
                to 2-col there and only expand to 4-col at lg+. Current-session
                always spans 2 cols for breathing room around its donut. */}
            <section className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
              <CurrentSessionTile session={activeSession} usage={sessionUsage} />
              <PlanPeriodTile />
              <TodayTokensTile today={today} />
            </section>

            {/* Row 2: 7-day chart (2) + top sessions (1) */}
            <section className="mt-5 grid grid-cols-3 gap-4">
              <SevenDayChartTile range={range} />
              <TopSessionsTile today={today} />
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Mobile tiles — compact stacked cards used by the <md layout. These mirror
// the iPhone column in mockup s-08: big ring card, plan-period empty-state,
// per-model rows, and a cost-estimate card. Data comes from the same
// endpoints as the desktop tiles.
// ---------------------------------------------------------------------------

// Skeleton shown while the usage endpoints resolve — three greyed placeholder
// cards so the page isn't an empty canvas on first paint. The old code
// treated `today === null` as "loading" which meant a broken endpoint looked
// identical to a mid-flight fetch; now the real null case only appears after
// `loading` flips false, at which point the tiles render their honest
// empty states instead.
function UsageSkeleton({ desktop = false }: { desktop?: boolean }) {
  if (desktop) {
    return (
      <section className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="col-span-2 rounded-lg border border-line bg-canvas p-5 min-h-[160px] bg-paper animate-pulse" />
        <div className="rounded-lg border border-line bg-paper p-5 min-h-[160px] animate-pulse" />
        <div className="rounded-lg border border-line bg-paper p-5 min-h-[160px] animate-pulse" />
      </section>
    );
  }
  return (
    <>
      <div className="rounded-lg border border-line bg-paper p-4 h-[180px] animate-pulse" />
      <div className="rounded-lg border border-line bg-paper p-4 h-[100px] animate-pulse" />
      <div className="rounded-lg border border-line bg-paper p-4 h-[120px] animate-pulse" />
    </>
  );
}

function MobileSessionRing({
  session,
  usage,
}: {
  session: Session | null;
  usage: SessionUsage | null;
}) {
  if (!session) {
    return (
      <div className="flex flex-col items-center p-4 border border-line rounded-lg bg-canvas">
        <div className="text-ui text-ink-muted text-center">
          没有活跃会话。打开或启动一个会话以在此查看其上下文用量。
        </div>
      </div>
    );
  }

  const window = contextWindowTokens(session.model);
  const lastTurnInput = usage?.lastTurnInput ?? 0;
  const known = usage?.lastTurnContextKnown ?? false;
  const pct = known ? Math.min(1, lastTurnInput / window) : 0;
  const r = 60;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct);

  return (
    <div className="flex flex-col items-center p-4 border border-line rounded-lg bg-canvas">
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
          <div className="display text-[29px]">
            {known ? `${Math.round(pct * 100)}%` : "—"}
          </div>
          <div className="caps text-ink-muted">会话</div>
        </div>
      </div>
      <div className="mt-2 text-ui text-ink-muted">
        {known ? (
          <>
            <span className="mono text-ink">
              {lastTurnInput.toLocaleString()}
            </span>{" "}
            / <span className="mono">{window.toLocaleString()}</span> tokens
          </>
        ) : (
          <>
            <span className="mono">—</span> /{" "}
            <span className="mono">{window.toLocaleString()}</span> tokens
          </>
        )}
      </div>
    </div>
  );
}

function MobilePlanPeriodCard() {
  // Same honest stance as the desktop PlanPeriodTile: we don't have plan /
  // quota data, so we render a "No plan data" empty state instead of faking
  // a 58% bar.
  return (
    <div className="rounded-lg border border-line bg-canvas p-4">
      <div className="caps text-ink-muted">计划周期</div>
      <div className="display text-ui-subhead mt-1.5 leading-tight">
        无计划数据
      </div>
      <p className="text-ui text-ink-muted mt-1.5 leading-relaxed">
        Claude Code 的计划用量由 CLI 上报,而非 claudex。在会话内运行{" "}
        <span className="mono">/cost</span> 即可查看你的计划周期消耗。
      </p>
    </div>
  );
}

function MobileByModelCard({ today }: { today: UsageTodayResponse | null }) {
  if (!today) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-4">
        <div className="caps text-ink-muted mb-2">按模型 · 今日</div>
        <div className="text-ui text-ink-muted">加载中…</div>
      </div>
    );
  }
  if (today.totalTokens === 0 || today.perModel.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-4">
        <div className="caps text-ink-muted mb-2">按模型 · 今日</div>
        <div className="text-ui text-ink-muted">
          尚无 Token 使用记录。
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-canvas p-4">
      <div className="caps text-ink-muted mb-2">按模型 · 今日</div>
      <div className="space-y-2 text-ui">
        {today.perModel.map((row, i) => (
          <div key={row.model} className="flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full bg-klein shrink-0"
              style={{ opacity: modelDotOpacity(i) }}
            />
            <span className="truncate">
              {MODEL_LABEL[row.model as keyof typeof MODEL_LABEL] ??
                row.model}
            </span>
            <span className="ml-auto mono text-ink-muted">
              {formatTokens(row.tokens)} tok
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MobileCostCard({ today }: { today: UsageTodayResponse | null }) {
  // Front-end cost estimate from the published per-token rates. Same math
  // as UsagePanel's "Cost estimate" card, applied to the aggregate token
  // counts returned by `/api/usage/today`. `/api/usage/today` only reports
  // aggregate `tokens` per model (not split input/output), so we split the
  // count 50/50 as a rough proxy — the real numbers live in UsagePanel's
  // per-session view and the desktop tiles above. We flag this in the fine
  // print so nobody treats this as a bill.
  const total = today?.totalTokens ?? 0;
  const estimate = today
    ? today.perModel.reduce((n, r) => {
        const half = Math.round(r.tokens / 2);
        return n + estimateCostUsd(r.model, half, r.tokens - half);
      }, 0)
    : 0;
  return (
    <div className="rounded-lg border border-line bg-canvas p-4">
      <div className="caps text-ink-muted mb-1.5">成本估算</div>
      <div className="display text-ui-display-xl leading-none">
        {total === 0 ? "$0.00" : formatUsd(estimate)}
      </div>
      <div className="text-ui text-ink-muted mt-1.5 leading-snug">
        根据模型公布的每 Token 费率计算的上限粗略估算。未考虑提示词缓存折扣或输入/输出拆分。你的实际计划计费可能有所不同。
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function CurrentSessionTile({
  session,
  usage,
}: {
  session: Session | null;
  usage: SessionUsage | null;
}) {
  // Hook order must be stable across renders — compute the cache-hit ratio
  // before any early return. The hook tolerates a null session.
  const cacheHitPct = useLastTurnCacheHit(session);

  if (!session) {
    return (
      <div className="col-span-2 rounded-lg border border-line bg-canvas p-5 flex items-center gap-5 min-h-[160px]">
        <div className="text-ui text-ink-muted">
          没有活跃会话。打开或启动一个会话以在此查看其上下文用量。
        </div>
      </div>
    );
  }

  const window = contextWindowTokens(session.model);
  const lastTurnInput = usage?.lastTurnInput ?? 0;
  const known = usage?.lastTurnContextKnown ?? false;
  const pct = known ? Math.min(1, lastTurnInput / window) : 0;

  // Prompt / Output from aggregate counters. The caveat (per the spec) is
  // these are cumulative across the whole session — matches the existing
  // UsagePanel's math.
  const promptLabel = usage ? formatTokens(usage.totalInput) : "—";
  const outputLabel = usage ? formatTokens(usage.totalOutput) : "—";

  return (
    <div className="col-span-2 rounded-lg border border-line bg-canvas p-5 flex items-center gap-5">
      <div className="relative shrink-0">
        <svg width={120} height={120}>
          <circle
            cx={60}
            cy={60}
            r={52}
            fill="none"
            stroke="rgb(var(--c-line))"
            strokeWidth={10}
          />
          <circle
            cx={60}
            cy={60}
            r={52}
            fill="none"
            stroke={known ? "rgb(var(--c-klein))" : "rgb(var(--c-klein) / 0.4)"}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 52}
            strokeDashoffset={2 * Math.PI * 52 * (1 - pct)}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="display text-ui-display-lg">
            {known ? `${Math.round(pct * 100)}%` : "—"}
          </div>
          <div className="caps text-ink-muted">会话</div>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="caps text-ink-muted">当前会话</div>
        <Link
          to={`/session/${session.id}`}
          className="display text-ui-display leading-tight mt-1 block truncate hover:underline"
        >
          {session.title}
        </Link>
        <div className="mono text-ui text-ink-muted mt-1 truncate">
          {known
            ? `${lastTurnInput.toLocaleString()} / ${window.toLocaleString()} tokens`
            : "— / " + window.toLocaleString() + " tokens"}{" "}
          · {MODEL_LABEL[session.model] ?? session.model}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <Stat label="提示词" value={promptLabel} />
          <Stat label="输出" value={outputLabel} />
          <Stat
            label="缓存命中"
            value={cacheHitPct === null ? "—" : `${Math.round(cacheHitPct * 100)}%`}
          />
        </div>
      </div>
    </div>
  );
}

function PlanPeriodTile() {
  // Per the task spec: we don't have plan/quota info. Render an honest empty
  // state instead of a fake 58% bar.
  return (
    <div className="rounded-lg border border-line bg-canvas p-5 min-h-[160px] flex flex-col">
      <div className="caps text-ink-muted">计划周期</div>
      <div className="display text-ui-title mt-2 leading-tight">
        无计划数据
      </div>
      <p className="text-ui text-ink-muted mt-2 leading-relaxed">
        Claude Code 的计划用量由 CLI 上报,而非 claudex。在会话内运行{" "}
        <span className="mono">/cost</span> 即可查看你的计划周期消耗。
      </p>
    </div>
  );
}

function TodayTokensTile({
  today,
}: {
  today: UsageTodayResponse | null;
}) {
  if (!today) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-5 min-h-[160px]">
        <div className="caps text-ink-muted">今日 · Token</div>
        <div className="text-ui text-ink-muted mt-2">加载中…</div>
      </div>
    );
  }
  if (today.totalTokens === 0) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-5 min-h-[160px]">
        <div className="caps text-ink-muted">今日 · Token</div>
        <div className="display text-ui-display-xl leading-none mt-2 mono">0</div>
        <div className="text-ui text-ink-muted mt-1">
          尚无 Token 使用记录。
        </div>
      </div>
    );
  }
  const max = today.perModel[0]?.tokens ?? 1;
  return (
    <div className="rounded-lg border border-line bg-canvas p-5">
      <div className="caps text-ink-muted">今日 · Token</div>
      <div className="display text-ui-display-xl leading-none mt-2 mono">
        {formatTokens(today.totalTokens)}
      </div>
      <div className="text-ui text-ink-muted">
        来自 {today.sessionCount}{" "}
        {today.sessionCount === 1 ? "个会话" : "个会话"}
      </div>
      <div className="mt-3 space-y-1.5 text-ui">
        {today.perModel.map((row, i) => {
          const opacity = modelDotOpacity(i);
          return (
            <div
              key={row.model}
              className="flex items-center gap-2"
              title={`${row.tokens.toLocaleString()} tokens`}
            >
              <span
                className="h-2 w-2 rounded-full bg-klein shrink-0"
                style={{ opacity }}
              />
              <span className="truncate">
                {MODEL_LABEL[row.model as keyof typeof MODEL_LABEL] ??
                  row.model}
              </span>
              <span className="ml-auto mono">{formatTokens(row.tokens)}</span>
              {/* non-semantic bar for visual comparison when there are >1 models */}
              {today.perModel.length > 1 && (
                <span
                  aria-hidden
                  className="hidden lg:inline-block h-1 rounded-full bg-line"
                  style={{ width: `${Math.max(8, (row.tokens / max) * 48)}px` }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SevenDayChartTile({ range }: { range: UsageRangeResponse | null }) {
  if (!range) {
    return (
      <div className="col-span-2 rounded-lg border border-line bg-canvas p-5 min-h-[200px]">
        <div className="flex items-center mb-3">
          <div className="caps text-ink-muted">最近 7 天 · 每日 Token</div>
        </div>
        <div className="text-ui text-ink-muted">加载中…</div>
      </div>
    );
  }
  const hasData = range.byDay.some((d) => d.totalTokens > 0);
  if (!hasData) {
    return (
      <div className="col-span-2 rounded-lg border border-line bg-canvas p-5 min-h-[200px]">
        <div className="flex items-center mb-3">
          <div className="caps text-ink-muted">最近 7 天 · 每日 Token</div>
        </div>
        <div className="text-ui text-ink-muted">
          尚无 Token 使用记录。启动一个会话并运行一轮即可在此看到数据。
        </div>
      </div>
    );
  }
  return (
    <div className="col-span-2 rounded-lg border border-line bg-canvas p-5">
      <div className="flex items-center mb-3">
        <div className="caps text-ink-muted">最近 7 天 · 每日 Token</div>
        <div className="ml-auto text-ui text-ink-muted">
          按模型堆叠
        </div>
      </div>
      <StackedBarChart range={range} />
    </div>
  );
}

function TopSessionsTile({ today }: { today: UsageTodayResponse | null }) {
  if (!today) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-5 min-h-[160px]">
        <div className="caps text-ink-muted mb-2">热门会话</div>
        <div className="text-ui text-ink-muted">加载中…</div>
      </div>
    );
  }
  if (today.topSessions.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-canvas p-5 min-h-[160px]">
        <div className="caps text-ink-muted mb-2">热门会话</div>
        <div className="text-ui text-ink-muted">
          今日还没有排名数据。
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-canvas p-5">
      <div className="caps text-ink-muted mb-2">热门会话</div>
      <div className="space-y-3 text-ui">
        {today.topSessions.map((s) => (
          <Link
            key={s.sessionId}
            to={`/session/${s.sessionId}`}
            className="block hover:bg-paper/60 rounded-sm -mx-1 px-1 py-0.5 transition-colors"
          >
            <div className="font-medium truncate">{s.title}</div>
            <div className="mono text-ui text-ink-muted truncate">
              {s.projectName ?? s.projectId} · {formatTokens(s.tokens)} tokens
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked bar chart. Not a full Recharts-style library — just enough SVG to
// render what mockup s-08 shows. We keep it self-contained so the Usage page
// doesn't drag a chart lib into the bundle.
// ---------------------------------------------------------------------------

function StackedBarChart({ range }: { range: UsageRangeResponse }) {
  const W = 700;
  const H = 160;
  const padTop = 10;
  const padBottom = 28;
  const padLeft = 40;
  const padRight = 10;
  const innerW = W - padLeft - padRight;
  const innerH = H - padTop - padBottom;

  const max = Math.max(1, ...range.byDay.map((d) => d.totalTokens));
  // Round to a nice axis value.
  const niceMax = niceCeiling(max);
  const bandW = innerW / range.byDay.length;
  const barW = Math.max(8, Math.min(60, bandW * 0.62));

  // Collect model ordering across days so stacking is consistent.
  const modelOrder: string[] = [];
  for (const day of range.byDay) {
    for (const m of day.perModel) {
      if (!modelOrder.includes(m.model)) modelOrder.push(m.model);
    }
  }

  // Gridlines — three intermediate ticks feels right for this size.
  const ticks = [0, niceMax / 3, (niceMax * 2) / 3, niceMax];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[160px]">
      {/* Gridlines + y labels */}
      {ticks.map((t) => {
        const y = padTop + innerH - (t / niceMax) * innerH;
        return (
          <g key={t}>
            <line
              x1={padLeft}
              x2={W - padRight}
              y1={y}
              y2={y}
              stroke="rgb(var(--c-line))"
              strokeWidth={1}
            />
            <text
              x={padLeft - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={10}
              fill="rgb(var(--c-ink-muted))"
              className="mono"
            >
              {formatTokens(Math.round(t))}
            </text>
          </g>
        );
      })}

      {/* Stacked bars */}
      {range.byDay.map((day, i) => {
        const cx = padLeft + i * bandW + bandW / 2;
        const x = cx - barW / 2;
        // Stack from the bottom up, in modelOrder for stable colors.
        let runningY = padTop + innerH;
        const segments: Array<{
          model: string;
          tokens: number;
          y: number;
          h: number;
        }> = [];
        for (const model of modelOrder) {
          const row = day.perModel.find((r) => r.model === model);
          if (!row || row.tokens === 0) continue;
          const h = (row.tokens / niceMax) * innerH;
          runningY -= h;
          segments.push({ model, tokens: row.tokens, y: runningY, h });
        }
        return (
          <g key={day.date}>
            {segments.map((seg, idx) => (
              <rect
                key={seg.model}
                x={x}
                y={seg.y}
                width={barW}
                height={Math.max(1, seg.h)}
                fill="rgb(var(--c-klein))"
                opacity={modelSegmentOpacity(
                  modelOrder.indexOf(seg.model),
                  idx === segments.length - 1,
                )}
                rx={2}
              >
                <title>
                  {day.date} · {MODEL_LABEL[seg.model as keyof typeof MODEL_LABEL] ?? seg.model}:{" "}
                  {seg.tokens.toLocaleString()} tokens
                </title>
              </rect>
            ))}
            <text
              x={cx}
              y={H - 8}
              textAnchor="middle"
              fontSize={10}
              fill="rgb(var(--c-ink-muted))"
              className="mono"
            >
              {dayAxisLabel(day.date)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function dayAxisLabel(date: string): string {
  // date is `YYYY-MM-DD`. Parse as local midnight so the weekday label
  // matches the local interpretation the bucket used.
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const dt = new Date(y, m - 1, d);
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][dt.getDay()];
}

function modelSegmentOpacity(idx: number, _top: boolean): number {
  // Top-of-stack models get the most saturation; subsequent ones fade.
  // Matches the mockup's klein / klein/60 / klein/40 triple.
  return [1, 0.7, 0.45, 0.3, 0.2][idx] ?? 0.2;
}

function modelDotOpacity(idx: number): number {
  return [1, 0.7, 0.45, 0.3, 0.2][idx] ?? 0.2;
}

function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / pow;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * pow;
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
 * Pull the most recent turn_end's cache-hit ratio. We re-fetch events here
 * rather than plumbing it through computeSessionUsage because this stat is
 * specific to the Usage page tile and doesn't warrant a new field in
 * SessionUsage.
 */
function useLastTurnCacheHit(session: Session | null): number | null {
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    if (!session) {
      setRatio(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listEvents(session.id);
        if (cancelled) return;
        let cacheRead = 0;
        let newInput = 0;
        // Walk events bottom-up so the first turn_end we hit is the newest.
        for (let i = res.events.length - 1; i >= 0; i--) {
          const ev = res.events[i];
          if (ev.kind !== "turn_end") continue;
          const usage = (ev.payload as Record<string, unknown>).usage as
            | {
                inputTokens?: number;
                cacheReadInputTokens?: number;
              }
            | undefined;
          if (!usage) continue;
          cacheRead = Number(usage.cacheReadInputTokens ?? 0) | 0;
          newInput = Number(usage.inputTokens ?? 0) | 0;
          break;
        }
        const denom = cacheRead + newInput;
        setRatio(denom > 0 ? cacheRead / denom : null);
      } catch {
        if (!cancelled) setRatio(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.id]);
  return ratio;
}
