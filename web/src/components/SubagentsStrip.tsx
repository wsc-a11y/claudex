import { Bot, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SubagentRun } from "@/state/sessions";

/**
 * Sticky "Agents" strip that sits under the Chat session header alongside
 * the Plan strip (s-17 / mirrors s-16's PlanStrip). Visible only when the
 * session has at least one subagent run — past or present — so fresh
 * sessions that never dispatched a Task/Agent call don't eat vertical
 * space. Running runs keep it alive; once everything has finished the
 * strip switches to a muted "N total" summary and still shows the latest
 * activeForm from the most-recent run.
 *
 * Layout (see mockup screen 17 · iPhone A + Desktop frames):
 *   [Agents] [●●●●] 2 live · 4 total  ›  <agent-type> <activeForm>  ▾
 *
 * Dots map one-per-run:
 *   • running  → purple pill (animated glow)
 *   • stopped  → purple/60 pill (dimmer)
 *   • completed → small success dot
 *   • failed   → small danger dot
 *
 * The strip is a trigger only — tapping opens the panel via `onOpen`
 * (bottom sheet on mobile, right-rail Subagents panel on desktop).
 */
export function SubagentsStrip({
  runs,
  onOpen,
}: {
  runs: SubagentRun[];
  onOpen: () => void;
}) {
  if (runs.length === 0) return null;

  // Newest-first ordering for dots + activeForm lookup. The `runs` array
  // from `useSubagentRuns` is oldest-first so the panel can read top-to-
  // bottom chronologically; flip here for "what's happening right now".
  const reversed = [...runs].reverse();
  const live = reversed.filter((r) => r.status === "running");
  const done = reversed.filter((r) => r.status === "completed").length;
  const active = live[0] ?? reversed[0];

  const label = activeLabel(active);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`子代理 · ${live.length} 个运行中（共 ${runs.length}）。打开完整面板。`}
      className="w-full px-4 md:px-5 py-2 bg-paper/70 border-b border-line flex items-center gap-2 md:gap-3 shrink-0 hover:bg-paper active:bg-paper/90 transition-colors text-left"
    >
      <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-xs border border-purple/30 bg-purple-wash text-purple mono text-ui-sm font-medium uppercase tracking-[0.08em] shrink-0">
        <Bot className="w-2.5 h-2.5" aria-hidden />
        子代理
      </span>
      <StatusDots runs={reversed} />
      <span className="mono text-ui text-ink-muted shrink-0">
        {done}/{runs.length}
      </span>
      <span className="hidden md:inline-block shrink-0 text-ink-faint mono text-ui-sm">
        ›
      </span>
      {active.agentType ? (
        <span className="mono text-ui text-purple shrink-0 max-w-[32ch] truncate">
          {active.agentType}
        </span>
      ) : null}
      <span
        className={cn(
          "text-ui md:text-ui truncate flex-1 min-w-0",
          live.length > 0 ? "text-ink font-medium" : "text-ink-muted",
        )}
      >
        {label}
        {live.length > 0 ? <Caret /> : null}
      </span>
      {active.isBackgrounded && (
        <span
          className="inline-flex items-center gap-0.5 px-1 h-4 rounded-xs border border-purple/30 bg-purple-wash/60 text-purple mono text-[9px] uppercase tracking-[0.12em] shrink-0"
          title="后台运行 — 在不阻塞父回合的情况下执行"
        >
          bg
        </span>
      )}
      <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />
    </button>
  );
}

/** What text to show on the right. Present-tense, truncated. */
function activeLabel(run: SubagentRun): string {
  // If the SDK has emitted a progress description, use it — that's the
  // AI-generated present-tense "activeForm". Fall back to the start
  // description (the task subject), then to the summary on a finished
  // run, then to a generic placeholder.
  if (run.description) return run.description;
  if (run.summary) return run.summary;
  return "正在处理任务";
}

/**
 * Mirrors PlanStrip's ProgressDots — up to 8 dots inline, collapse to a
 * single progress bar when denser. Here the bar shows done / total
 * because the progress metric for subagents is "how many finished".
 */
function StatusDots({ runs }: { runs: SubagentRun[] }) {
  if (runs.length <= 8) {
    return (
      <span className="flex items-center gap-[3px] shrink-0" aria-hidden>
        {runs.map((r, i) => <StatusDot key={r.taskId || i} run={r} />)}
      </span>
    );
  }
  const done = runs.reduce(
    (acc, r) => acc + (r.status === "completed" ? 1 : 0),
    0,
  );
  const pct = runs.length > 0 ? (done / runs.length) * 100 : 0;
  return (
    <span
      className="h-1.5 w-20 md:w-28 rounded-full bg-line overflow-hidden shrink-0"
      aria-hidden
    >
      <span className="block h-full bg-purple" style={{ width: `${pct}%` }} />
    </span>
  );
}

function StatusDot({ run }: { run: SubagentRun }) {
  if (run.status === "running") {
    return (
      <span
        className="h-1.5 w-3 md:w-3.5 rounded-full bg-purple"
        style={{ boxShadow: "0 0 0 2px rgb(var(--c-purple)/0.20)" }}
      />
    );
  }
  if (run.status === "stopped") {
    return <span className="h-1.5 w-3 rounded-full bg-purple/60" />;
  }
  if (run.status === "failed") {
    return <span className="h-1.5 w-1.5 rounded-full bg-danger/70" />;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-success" />;
}

/**
 * Tiny blinking caret to hint "this is streaming live" without loading a
 * spinner (spinners pull the eye too hard for a header strip). Matches
 * the mockup's `caret` CSS animation — one token, styled inline so we
 * don't have to import a global stylesheet.
 */
function Caret() {
  return (
    <span
      aria-hidden
      className="inline-block w-[2px] h-[0.95em] align-[-0.1em] ml-[3px] bg-purple animate-pulse"
    />
  );
}

// A compact variant of the dots used by session list cards so the user
// can see at a glance "this session has 2 agents alive" without opening
// it. Returns null when no runs — the card shows its normal metadata.
export function SubagentsMiniIndicator({
  runs,
  className,
}: {
  runs: SubagentRun[];
  className?: string;
}) {
  if (runs.length === 0) return null;
  const live = runs.filter((r) => r.status === "running").length;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={`子代理 · ${live} 个运行中（共 ${runs.length}）`}
    >
      <StatusDots runs={[...runs].reverse()} />
      <span className="mono text-ui-sm text-ink-muted">
        {live > 0 ? `${live} 运行中` : `${runs.length}`}
      </span>
    </span>
  );
}
