import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, ExternalLink, Loader2, Square } from "lucide-react";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import { summarizeToolCall, toolIcon } from "@/lib/tool-summary";
import type { SubagentRun, SubagentStreamEvent, UIPiece } from "@/state/sessions";

/**
 * SubagentsPanel — grouped Running / Done / Failed / Stopped list of
 * every Task · Agent · Explore run the session has dispatched. Rendered
 * inside both the desktop right-rail and the mobile bottom-sheet above
 * the existing TasksList (which still covers non-subagent tool calls).
 *
 * Running rows expand by default and render an inline "live stream" of
 * the subagent's text chunks + nested tool chips (grep, read, edit, …)
 * — the key thing that s-17 adds over the old flat TasksList. Done /
 * Failed / Stopped rows stay collapsed until the user clicks them; on
 * expand they show the subagent's final summary + usage + a Files link
 * when the SDK handed back an `output_file`.
 *
 * A single 1-second ticker at the panel level keeps the mm:ss elapsed
 * labels fresh on every running run + nested running tool chip. The
 * ticker stops when nothing is running.
 */
export function SubagentsPanel({
  runs,
  sessionId,
  onRevealToolUse,
  onNavigate,
  variant = "inline",
}: {
  runs: SubagentRun[];
  /** Parent session id — required when we want the RunCards to render a
   *  deep-link to the full-page `/session/:id/subagent/:taskId` view.
   *  Omit to suppress the Open link (e.g. in a preview surface where we
   *  don't have a session context). */
  sessionId?: string;
  /** Jump the main transcript to a tool_use source piece. Used by the
   * nested tool chips so a user can "show me the full result" the same
   * way the main TasksList row-click does. */
  onRevealToolUse?: (toolUseId: string) => void;
  /** Invoked when a user clicks the "Open" link to navigate to the full
   *  subagent page. The sheet uses this to close itself so the back
   *  button returns to the session cleanly. */
  onNavigate?: () => void;
  /** "inline" (default) renders the panel's own "Agents" chip header,
   * used when the panel is embedded above TasksList. "embedded" is used
   * by SubagentsSheet, which supplies its own header chip/count — so we
   * skip the internal header to avoid a double-up. */
  variant?: "inline" | "embedded";
}) {
  // Panel-level ticker — one setInterval keeps mm:ss labels fresh for
  // every open running row. Matches the pattern in TasksList.
  const hasRunning = runs.some((r) => r.status === "running");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    const handle = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(handle);
  }, [hasRunning]);

  if (runs.length === 0) return null;

  // Flat ordering: all running runs first (newest-first), then everything
  // else by endedAt → startedAt (newest-first). The user-facing cue for
  // status is the row's colored strip + status icon — a grouping header
  // like "DONE · 3" was redundant and visually competed with the
  // TasksList group headers below.
  const running = runs.filter((r) => r.status === "running");
  const rest = runs.filter((r) => r.status !== "running");
  const toTime = (iso: string | null | undefined): number => {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  const runningSorted = running
    .slice()
    .sort((a, b) => toTime(b.startedAt) - toTime(a.startedAt));
  const restSorted = rest.slice().sort((a, b) => {
    const bt = toTime(b.endedAt) || toTime(b.startedAt);
    const at = toTime(a.endedAt) || toTime(a.startedAt);
    return bt - at;
  });
  const ordered = [...runningSorted, ...restSorted];

  return (
    <div className="flex flex-col border-b border-line bg-paper/30">
      {variant === "inline" && (
        <div className="px-3 py-2 flex items-center shrink-0 border-b border-line">
          <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-xs border border-purple/30 bg-purple-wash text-purple mono text-ui-sm font-medium uppercase tracking-[0.08em]">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                hasRunning ? "bg-purple animate-pulse" : "bg-purple/50",
              )}
              aria-hidden
            />
            子代理
          </span>
          <span className="ml-2 mono text-ui text-ink-muted">
            {runningSorted.length > 0
              ? `运行中 ${runningSorted.length} · 共 ${runs.length}`
              : `共 ${runs.length} 次`}
          </span>
          <span className="ml-auto mono text-ui-sm text-ink-faint hidden sm:inline">
            点击行展开
          </span>
        </div>
      )}
      <div className="flex flex-col py-1">
        {ordered.map((run) => (
          <RunCard
            key={run.taskId}
            run={run}
            sessionId={sessionId}
            defaultExpanded={run.status === "running"}
            onRevealToolUse={onRevealToolUse}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}

function RunCard({
  run,
  sessionId,
  defaultExpanded = false,
  onRevealToolUse,
  onNavigate,
}: {
  run: SubagentRun;
  sessionId?: string;
  defaultExpanded?: boolean;
  onRevealToolUse?: (toolUseId: string) => void;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const tint = tintFor(run.status);
  // Only render the Open deep-link for runs that carry a real taskId.
  // Legacy-synthesized runs use a `legacy-<toolUseId>` key — skip those
  // because the standalone page keys on taskId and wouldn't find them.
  const fullPageHref =
    sessionId && run.taskId && !run.taskId.startsWith("legacy-")
      ? `/session/${sessionId}/subagent/${encodeURIComponent(run.taskId)}`
      : null;
  return (
    <div
      className={cn(
        "mx-2.5 mb-2 rounded-lg border overflow-hidden relative",
        tint.border,
        tint.bg,
      )}
    >
      <div
        aria-hidden
        className={cn("absolute left-0 top-0 bottom-0 w-[3px]", tint.strip)}
      />
      <div
        className={cn(
          "w-full pl-3 pr-2 py-2 flex items-center gap-2 text-left",
          expanded && "border-b",
          expanded && tint.headerBorder,
          "hover:bg-paper/40 transition-colors",
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          aria-label={expanded ? "收起子代理运行" : "展开子代理运行"}
          className="flex items-center gap-2 text-left flex-1 min-w-0"
        >
          <span
            className={cn(
              "inline-flex items-center gap-1 px-1.5 h-5 rounded-xs border mono text-ui-sm shrink-0",
              tint.chip,
            )}
          >
            子代理
          </span>
          {run.agentType && (
            <span className="mono text-[10.5px] text-ink-soft shrink-0 max-w-[14ch] truncate">
              {run.agentType}
            </span>
          )}
          <StatusDot run={run} />
          <span className="text-ui text-ink truncate flex-1 font-medium">
            {run.description || "(无描述)"}
          </span>
          {run.isBackgrounded && (
            <span
              className="inline-flex items-center px-1 h-4 rounded-xs border border-purple/30 bg-purple-wash/60 text-purple mono text-[9px] uppercase tracking-[0.12em] shrink-0"
              title="后台运行"
            >
              bg
            </span>
          )}
          <span
            className={cn(
              "mono text-ui-sm shrink-0 tabular-nums",
              run.status === "failed" ? "text-danger" : "text-ink-muted",
            )}
            title={run.startedAt ? new Date(run.startedAt).toLocaleString() : undefined}
          >
            {renderRightLabel(run)}
          </span>
          <ChevronRight
            className={cn(
              "w-3 h-3 text-ink-muted shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        </button>
        {fullPageHref && (
          <Link
            to={fullPageHref}
            onClick={() => onNavigate?.()}
            className="h-6 w-6 rounded-sm border border-line bg-canvas/60 flex items-center justify-center text-ink-muted hover:text-purple hover:border-purple/40 shrink-0 transition-colors"
            aria-label="打开完整页面视图"
            title="打开完整视图"
          >
            <ExternalLink className="w-3 h-3" aria-hidden />
          </Link>
        )}
      </div>
      {expanded && <RunBody run={run} onRevealToolUse={onRevealToolUse} />}
    </div>
  );
}

function RunBody({
  run,
  onRevealToolUse,
}: {
  run: SubagentRun;
  onRevealToolUse?: (toolUseId: string) => void;
}) {
  return (
    <div className="bg-canvas/60">
      <InputPreview prompt={run.prompt} />
      <LiveStream run={run} onRevealToolUse={onRevealToolUse} />
      <RunFooter run={run} />
    </div>
  );
}

function InputPreview({ prompt }: { prompt: string | null }) {
  const [open, setOpen] = useState(false);
  if (!prompt) return null;
  return (
    <div className="px-3 pt-2 pb-1 bg-paper/40 border-b border-line/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 text-ink-muted transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span className="uppercase tracking-[0.12em] text-ui-sm font-medium text-ink-muted">
          输入
        </span>
        {!open && (
          <span className="mono text-[10.5px] text-ink-muted truncate flex-1">
            {prompt.slice(0, 200)}
          </span>
        )}
      </button>
      {open && (
        <pre className="mono text-ui leading-[1.5] text-ink-soft bg-paper border border-line rounded px-2.5 py-2 mt-1.5 mb-1.5 overflow-x-auto max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words">
          {prompt}
        </pre>
      )}
    </div>
  );
}

function LiveStream({
  run,
  onRevealToolUse,
}: {
  run: SubagentRun;
  onRevealToolUse?: (toolUseId: string) => void;
}) {
  const stream = run.stream;
  const isLive = run.status === "running";

  // Pair tool_use + tool_result by toolUseId so each chip shows its
  // status inline (spinner while pending, ok/error once the result
  // lands). Emitted as separate pieces at the store level.
  const resultsById = new Map<
    string,
    Extract<UIPiece, { kind: "tool_result" }>
  >();
  for (const ev of stream) {
    if (ev.piece.kind === "tool_result") {
      resultsById.set(ev.piece.toolUseId, ev.piece);
    }
  }
  // Events we want to render in order. Skip tool_result pieces whose
  // paired tool_use is in the same stream (rendered inline on the chip);
  // orphan tool_results (no preceding tool_use seen) still render as a
  // standalone line so the user isn't blind.
  const toolUseIds = new Set<string>();
  for (const ev of stream) {
    if (ev.piece.kind === "tool_use") toolUseIds.add(ev.piece.id);
  }
  const renderable = stream.filter((ev) => {
    if (ev.piece.kind !== "tool_result") return true;
    return !toolUseIds.has(ev.piece.toolUseId);
  });

  return (
    <div className="px-2.5 pt-2 pb-2.5">
      <div className="flex items-center gap-1.5 mb-2 pl-1">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            isLive ? "bg-purple animate-pulse" : "bg-ink-faint",
          )}
          aria-hidden
        />
        <span className="uppercase tracking-[0.12em] text-ui-sm font-medium text-purple">
          {isLive ? "实时流" : "过程记录"}
        </span>
        <span className="mono text-ui-sm text-ink-muted">
          · {renderable.length} 条记录
        </span>
      </div>
      {renderable.length === 0 ? (
        <EmptyStreamFallback run={run} isLive={isLive} />
      ) : (
        <div className="relative pl-4 space-y-2">
          <span
            className="absolute left-[7px] top-1 bottom-4 w-px bg-line-strong"
            aria-hidden
          />
          {renderable.map((ev, idx) => (
            <StreamItem
              key={`${ev.seq}-${idx}`}
              event={ev}
              resultsById={resultsById}
              trailingCaret={
                isLive &&
                idx === renderable.length - 1 &&
                (ev.piece.kind === "assistant_text" ||
                  ev.piece.kind === "thinking")
              }
              onRevealToolUse={onRevealToolUse}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyStreamFallback({
  run,
  isLive,
}: {
  run: SubagentRun;
  isLive: boolean;
}) {
  // Legacy runs (pre-Phase-1 SDK opt-in) and skipped-bash tasks land
  // here with an empty stream. The `tool_result` summary on the parent
  // Task/Agent tool_use is the only post-mortem we have — surface it
  // with the same typography as the live-stream assistant_text blocks
  // so the panel still reads like a transcript. `outputFile` is
  // emitted by backgrounded subagents and gives the user the on-disk
  // hand-off path. TODO(s-17): click-to-copy / jump once we have a
  // file-viewer surface.
  const summary = run.summary?.trim() || "";
  if (!summary && !run.outputFile) {
    return (
      <div className="text-ui text-ink-muted italic pl-4 pb-1">
        {isLive
          ? "正在等待第一个工具调用…"
          : "此处无活动，请到此回合的开始处查看详情。"}
      </div>
    );
  }
  return (
    <div className="pl-4 pb-1 space-y-2">
      {summary && (
        <div>
          <div className="uppercase tracking-[0.12em] text-ui-sm font-medium text-ink-muted mb-1">
            摘要
          </div>
          <div className="text-ui leading-[1.55] text-ink-soft whitespace-pre-wrap break-words">
            {summary}
          </div>
        </div>
      )}
      {run.outputFile && (
        <div
          className="mono text-ui text-ink-muted truncate"
          title={run.outputFile}
        >
          → {run.outputFile}
        </div>
      )}
    </div>
  );
}

function StreamItem({
  event,
  resultsById,
  trailingCaret,
  onRevealToolUse,
}: {
  event: SubagentStreamEvent;
  resultsById: Map<string, Extract<UIPiece, { kind: "tool_result" }>>;
  trailingCaret: boolean;
  onRevealToolUse?: (toolUseId: string) => void;
}) {
  const p = event.piece;
  if (p.kind === "assistant_text") {
    return (
      <div className="relative">
        <span
          className="absolute -left-[11px] top-[7px] h-1.5 w-1.5 rounded-full bg-ink-faint"
          aria-hidden
        />
        <div className="text-ui leading-[1.55] text-ink-soft whitespace-pre-wrap break-words">
          {p.text}
          {trailingCaret && <Caret />}
        </div>
      </div>
    );
  }
  if (p.kind === "thinking") {
    return (
      <div className="relative">
        <span
          className="absolute -left-[11px] top-[7px] h-1.5 w-1.5 rounded-full bg-ink-faint/70"
          aria-hidden
        />
        <div className="text-ui leading-[1.55] text-ink-muted italic whitespace-pre-wrap break-words">
          {p.text}
          {trailingCaret && <Caret />}
        </div>
      </div>
    );
  }
  if (p.kind === "tool_use") {
    const result = resultsById.get(p.id) ?? null;
    return <ToolChip use={p} result={result} onReveal={onRevealToolUse} />;
  }
  if (p.kind === "tool_result") {
    return <ToolResultLine piece={p} />;
  }
  return null;
}

function ToolChip({
  use,
  result,
  onReveal,
}: {
  use: Extract<UIPiece, { kind: "tool_use" }>;
  result: Extract<UIPiece, { kind: "tool_result" }> | null;
  onReveal?: (toolUseId: string) => void;
}) {
  const Icon = toolIcon(use.name);
  const summary = summarizeToolCall(use.name, use.input);
  const inFlight = !result;
  const failed = result?.isError === true;
  return (
    <div className="relative">
      <span
        className={cn(
          "absolute -left-[11px] top-[9px] h-1.5 w-1.5 rounded-full",
          inFlight
            ? "bg-klein animate-pulse"
            : failed
              ? "bg-danger/70"
              : "bg-success",
        )}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => onReveal?.(use.id)}
        className={cn(
          "w-full flex items-center gap-1.5 py-1 pl-1.5 pr-2 rounded-sm border text-left",
          inFlight
            ? "border-klein/30 bg-klein-wash/60"
            : failed
              ? "border-danger/25 bg-danger-wash/40"
              : "border-line bg-paper",
        )}
        title={summary || use.name}
      >
        <Icon
          className={cn(
            "w-3 h-3 shrink-0",
            inFlight ? "text-klein-ink" : failed ? "text-danger" : "text-ink-soft",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "mono text-[10.5px] shrink-0",
            inFlight
              ? "text-klein-ink"
              : failed
                ? "text-danger"
                : "text-ink-soft",
          )}
        >
          {use.name.toLowerCase()}
        </span>
        <span className="mono text-ui-sm text-ink-muted truncate flex-1">
          {summary}
        </span>
        {inFlight && (
          <Loader2 className="w-3 h-3 text-klein animate-spin shrink-0" aria-hidden />
        )}
      </button>
    </div>
  );
}

function ToolResultLine({
  piece,
}: {
  piece: Extract<UIPiece, { kind: "tool_result" }>;
}) {
  return (
    <div className="relative">
      <span
        className={cn(
          "absolute -left-[11px] top-[9px] h-1.5 w-1.5 rounded-full",
          piece.isError ? "bg-danger/70" : "bg-success",
        )}
        aria-hidden
      />
      <div
        className={cn(
          "mono text-[10.5px] leading-[1.5] rounded-sm border px-2 py-1 truncate",
          piece.isError
            ? "text-danger bg-danger-wash/40 border-danger/25"
            : "text-ink-muted bg-paper border-line",
        )}
        title={piece.content}
      >
        {piece.isError ? "出错 : " : "→ "}
        {piece.content.split("\n")[0].slice(0, 180) || "(无输出)"}
      </div>
    </div>
  );
}

function RunFooter({ run }: { run: SubagentRun }) {
  // Nothing interactive in the drawer footer — the stop control the SDK
  // would need isn't wired yet, and a permanently-disabled button just
  // takes space. The full-page SubagentRun view still carries outputFile
  // + usage stats, so users who want those details use the "Open" link
  // on each row header. Here we just keep a minimal identity line: short
  // taskId + outputFile path when present.
  if (!run.outputFile) {
    return (
      <div className="px-3 pt-2 pb-2.5 border-t border-line/70 flex items-center bg-paper/40">
        <span className="ml-auto mono text-ui-sm text-ink-muted">
          {run.taskId.slice(0, 8)}…
        </span>
      </div>
    );
  }
  return (
    <div className="px-3 pt-2 pb-2.5 border-t border-line/70 flex items-center gap-2 bg-paper/40">
      <span
        className="mono text-ui-sm text-ink-muted truncate max-w-[30ch]"
        title={run.outputFile}
      >
        → {run.outputFile}
      </span>
      <span className="ml-auto mono text-ui-sm text-ink-muted">
        {run.taskId.slice(0, 8)}…
      </span>
    </div>
  );
}

function StatusDot({ run }: { run: SubagentRun }) {
  if (run.status === "running") {
    return (
      <span
        className="relative h-2 w-2 rounded-full bg-purple animate-pulse shrink-0"
        style={{ boxShadow: "0 0 0 3px rgb(var(--c-purple)/0.22)" }}
        aria-hidden
      />
    );
  }
  if (run.status === "failed") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="w-3 h-3 text-danger shrink-0"
        aria-hidden
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    );
  }
  if (run.status === "stopped") {
    return <Square className="w-3 h-3 text-ink-muted shrink-0" aria-hidden />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      className="w-3 h-3 text-success shrink-0"
      aria-hidden
    >
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

function tintFor(status: SubagentRun["status"]): {
  strip: string;
  bg: string;
  border: string;
  chip: string;
  headerBorder: string;
} {
  if (status === "running") {
    return {
      strip: "bg-purple",
      bg: "bg-purple-wash/25",
      border: "border-purple/25",
      chip: "border-purple/40 text-purple bg-canvas/80",
      headerBorder: "border-purple/20",
    };
  }
  if (status === "failed") {
    return {
      strip: "bg-danger/70",
      bg: "bg-danger-wash/40",
      border: "border-danger/25",
      chip: "border-danger/30 text-danger bg-canvas/70",
      headerBorder: "border-danger/15",
    };
  }
  if (status === "stopped") {
    return {
      strip: "bg-ink-faint",
      bg: "bg-paper/40",
      border: "border-line",
      chip: "border-line text-ink-soft",
      headerBorder: "border-line/60",
    };
  }
  return {
    strip: "bg-success/50",
    bg: "bg-canvas",
    border: "border-line",
    chip: "border-line text-ink-soft",
    headerBorder: "border-line/60",
  };
}

function renderRightLabel(run: SubagentRun): string {
  if (run.status === "failed") return run.endedAt ? "出错" : "出错中";
  if (run.status === "running") {
    if (!run.startedAt) return "运行中";
    return formatElapsedClock(run.startedAt);
  }
  return timeAgoShort(run.endedAt ?? run.startedAt ?? null);
}

function formatElapsedClock(startedAtIso: string): string {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return "—";
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Caret() {
  // Inline blinking caret for trailing partial text. Indigo to match the
  // subagent surface palette — signals "a subagent is still streaming."
  return (
    <span
      aria-hidden
      className="inline-block w-[2px] h-[0.95em] align-[-0.1em] ml-[3px] bg-purple animate-pulse"
    />
  );
}