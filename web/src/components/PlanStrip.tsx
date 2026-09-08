import { ChevronDown, ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PlanSnapshot } from "@/lib/todos";

/**
 * Sticky "Plan" strip under the Chat session header. Always visible when
 * the session has at least one todo — disappears entirely otherwise so
 * we don't eat vertical space on sessions that never call TodoWrite.
 *
 * Glanceable layout (mockup s-16):
 *   [Plan] [●●⬤○○] 2/5  →  <in-progress activeForm>  ▾
 *
 * Tapping the strip opens a full sheet via `onOpen`. On desktop, the
 * same click opens a right slide-over (parent decides). Keep the strip
 * itself dumb — it's a trigger + status summary, nothing more.
 */
export function PlanStrip({
  snapshot,
  onOpen,
}: {
  snapshot: PlanSnapshot;
  onOpen: () => void;
}) {
  const { items, done, total, current } = snapshot;
  if (total === 0) return null;

  // Pick a label: the in-progress activeForm is the lede; fall back to
  // the next pending item if the agent has marked everything done but
  // not rewritten the list yet; finally, a static "all done" summary.
  const activeLabel = current?.activeForm || current?.content;
  const nextPending = items.find((it) => it.status === "pending");
  const label = activeLabel
    ? activeLabel
    : nextPending
      ? `接下来 · ${nextPending.content}`
      : "所有步骤均已完成";

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`计划 · ${done}/${total} 已完成。打开完整列表。`}
      className="w-full px-4 md:px-5 py-2 bg-paper/70 border-b border-line flex items-center gap-2 md:gap-3 shrink-0 hover:bg-paper active:bg-paper/90 transition-colors text-left"
    >
      <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-xs border border-klein/30 bg-klein-wash text-klein-ink mono text-ui-sm font-medium uppercase tracking-[0.08em] shrink-0">
        <ListChecks className="w-2.5 h-2.5" aria-hidden />
        计划
      </span>
      <ProgressDots items={items} />
      <span className="mono text-ui text-ink-muted shrink-0">
        {done}/{total}
      </span>
      <span className="hidden md:inline-block shrink-0 text-ink-faint mono text-ui-sm">
        ›
      </span>
      <span
        className={cn(
          "text-ui md:text-ui truncate flex-1 min-w-0",
          current ? "text-ink font-medium" : "text-ink-muted",
        )}
      >
        {label}
      </span>
      <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />
    </button>
  );
}

/**
 * One dot per todo when the list is short (≤8); collapses to a single
 * progress bar when dense so the strip stays compact (mockup s-16
 * "progress dots · fallback" card).
 */
function ProgressDots({
  items,
}: {
  items: PlanSnapshot["items"];
}) {
  if (items.length <= 8) {
    return (
      <span className="flex items-center gap-[3px] shrink-0" aria-hidden>
        {items.map((it, i) => {
          if (it.status === "completed") {
            return (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-success"
              />
            );
          }
          if (it.status === "in_progress") {
            return (
              <span
                key={i}
                className="h-1.5 w-3 md:w-3.5 rounded-full bg-klein shadow-[0_0_0_2px_rgb(var(--c-klein)/0.18)]"
              />
            );
          }
          return (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full border border-line-strong"
            />
          );
        })}
      </span>
    );
  }
  const done = items.reduce(
    (acc, it) => acc + (it.status === "completed" ? 1 : 0),
    0,
  );
  const pct = items.length > 0 ? (done / items.length) * 100 : 0;
  return (
    <span
      className="h-1.5 w-20 md:w-28 rounded-full bg-line overflow-hidden shrink-0"
      aria-hidden
    >
      <span
        className="block h-full bg-klein"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

/**
 * Small read-only variant of the strip for places that just want the
 * progress pill (e.g. session cards in the left rail). Hidden when
 * there's no plan yet. Not exported from index — kept next to the strip
 * so the two share their dot visual.
 */
export function PlanProgressPill({
  snapshot,
  className,
}: {
  snapshot: PlanSnapshot;
  className?: string;
}) {
  if (snapshot.total === 0) return null;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={`计划 · ${snapshot.done}/${snapshot.total} 已完成`}
    >
      <ProgressDots items={snapshot.items} />
      <span className="mono text-ui-sm text-ink-muted">
        {snapshot.done}/{snapshot.total}
      </span>
    </span>
  );
}
