import { Check, ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import type { PlanSnapshot, TodoItem } from "@/lib/todos";

/**
 * The full plan checklist — Done / Now / Next grouped, used inside the
 * mobile bottom-sheet (PlanSheet) and the desktop right-rail slide-over.
 * Source of truth for the plan visuals: every in-progress item shows its
 * `activeForm` in bold klein-wash, completed items strikethrough, pending
 * items in muted ink with hollow bullets. Matches mockup s-16 expanded sheet.
 *
 * Pure — no state, no effects. All callbacks come from the parent so the
 * same markup backs both the bottom sheet and an inline inspector.
 */
export function PlanPanel({
  snapshot,
  onReveal,
  className,
  showFooter = true,
}: {
  snapshot: PlanSnapshot;
  /** Jump the transcript to the TodoWrite turn that produced this plan.
   *  Delegates the actual scroll to the parent so PlanPanel stays
   *  presentation-only. */
  onReveal?: (seq: number) => void;
  className?: string;
  /** Hide the "Updated … · TodoWrite · seq N" footer when embedded in
   *  a surface that already shows its own metadata line. */
  showFooter?: boolean;
}) {
  const { items, done, total, sourceSeq, updatedAt, current } = snapshot;
  const pending = items.filter((it) => it.status === "pending");
  const completed = items.filter((it) => it.status === "completed");
  const inProgress = items.filter((it) => it.status === "in_progress");

  if (total === 0) {
    return (
      <div
        className={cn(
          "rounded-lg border border-dashed border-line-strong bg-paper/40 px-3 py-3 flex items-center gap-2",
          className,
        )}
      >
        <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-xs border border-line bg-canvas mono text-ui-sm text-ink-muted uppercase tracking-[0.08em]">
          计划
        </span>
        <span className="text-ui text-ink-muted">
          暂无计划 —— 当任务成长时 Claude 会写出计划。
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      <div className="overflow-y-auto min-h-0 flex-1">
        {completed.length > 0 && (
          <>
            <GroupHeader label="已完成" count={completed.length} />
            <ul className="px-2.5 space-y-0.5">
              {completed.map((it, i) => (
                <DoneRow key={`d-${i}`} item={it} />
              ))}
            </ul>
          </>
        )}
        {inProgress.length > 0 && (
          <>
            <GroupHeader
              label="进行中"
              count={inProgress.length}
              tone="klein"
              suffix="activeForm"
            />
            <ul className="px-2.5 space-y-1">
              {inProgress.map((it, i) => (
                <NowRow key={`n-${i}`} item={it} />
              ))}
            </ul>
          </>
        )}
        {pending.length > 0 && (
          <>
            <GroupHeader label="接下来" count={pending.length} />
            <ul className="px-2.5 space-y-0.5 pb-2">
              {pending.map((it, i) => (
                <NextRow key={`p-${i}`} item={it} />
              ))}
            </ul>
          </>
        )}
        {/* Edge case: current stale because the whole list got marked done
            but the agent hasn't rewritten yet. Show the last-current as a
            tiny hint so the panel doesn't render as a lifeless wall of
            strikethroughs. */}
        {inProgress.length === 0 && pending.length === 0 && current && (
          <div className="px-4 py-2 text-ui text-ink-muted">
            <Check className="w-3 h-3 inline-block mr-1 text-success" />
            所有步骤均已完成。
          </div>
        )}
      </div>
      {showFooter && (
        <div className="px-4 py-2.5 border-t border-line flex items-center gap-2 text-[10.5px] text-ink-muted shrink-0">
          <span>
            {updatedAt ? (
              <>
                更新于{" "}
                <time
                  className="mono text-ink-soft"
                  dateTime={updatedAt}
                  title={new Date(updatedAt).toLocaleString()}
                >
                  {timeAgoShort(updatedAt)}
                </time>
              </>
            ) : (
              <span className="text-ink-faint">更新于 · 刚才</span>
            )}
          </span>
          <span className="ml-auto mono flex items-center gap-1.5">
            <ListChecks className="w-3 h-3 text-ink-faint" />
            <span>TodoWrite</span>
            {sourceSeq != null && onReveal ? (
              <button
                type="button"
                className="hover:text-klein-ink underline-offset-2 hover:underline transition-colors"
                onClick={() => onReveal(sourceSeq)}
                title="跳转到写出此计划的回合"
              >
                · seq {sourceSeq}
              </button>
            ) : sourceSeq != null ? (
              <span>· seq {sourceSeq}</span>
            ) : null}
          </span>
          <span className="sr-only">
            {done}/{total} 已完成
          </span>
        </div>
      )}
    </div>
  );
}

function GroupHeader({
  label,
  count,
  tone = "muted",
  suffix,
}: {
  label: string;
  count: number;
  tone?: "muted" | "klein";
  suffix?: string;
}) {
  return (
    <div className="px-4 pt-3 pb-1 flex items-baseline gap-2">
      <span
        className={cn(
          "caps",
          tone === "klein" ? "text-klein" : "text-ink-soft",
        )}
      >
        {label}
      </span>
      <span className="mono text-[10.5px] text-ink-muted">
        · {count}
        {suffix ? ` · ${suffix}` : ""}
      </span>
    </div>
  );
}

function DoneRow({ item }: { item: TodoItem }) {
  return (
    <li className="flex items-start gap-2 px-1.5 py-1.5 rounded-sm hover:bg-canvas/60 transition-colors">
      <span className="mt-[2px] h-3.5 w-3.5 rounded-full bg-success flex items-center justify-center shrink-0">
        <Check className="w-2 h-2" strokeWidth={4} stroke="rgb(var(--c-canvas))" />
      </span>
      <span className="text-ui text-ink-muted line-through flex-1 break-words [overflow-wrap:anywhere]">
        {item.content}
      </span>
    </li>
  );
}

function NowRow({ item }: { item: TodoItem }) {
  // activeForm when present, falling back to content. This is the whole
  // point of the "Now" grouping — activeForm reads like a live progress
  // ticker ("Pinning server render locale to en-US") instead of an
  // imperative command ("Pin server render locale to en-US").
  const label = item.activeForm || item.content;
  return (
    <li className="relative flex items-start gap-2 px-2 py-2 rounded bg-klein-wash/40 border border-klein/25">
      <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-klein rounded-full" aria-hidden />
      <span className="mt-[2px] relative h-3.5 w-3.5 rounded-full border-2 border-klein shrink-0 ml-0.5">
        <span className="absolute inset-[2px] rounded-full bg-klein animate-pulse" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-ui font-medium text-ink leading-snug break-words [overflow-wrap:anywhere]">
          {label}
        </div>
      </div>
    </li>
  );
}

function NextRow({ item }: { item: TodoItem }) {
  return (
    <li className="flex items-start gap-2 px-1.5 py-1.5 rounded-sm">
      <span className="mt-[2px] h-3.5 w-3.5 rounded-full border-2 border-line-strong bg-canvas shrink-0" />
      <span className="text-ui text-ink flex-1 break-words [overflow-wrap:anywhere]">
        {item.content}
      </span>
    </li>
  );
}
