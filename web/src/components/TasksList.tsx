import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import { summarizeToolCall, toolIcon } from "@/lib/tool-summary";
import { SUBAGENT_PARENT_TOOLS, type UIPiece } from "@/state/sessions";

/**
 * TasksList — shared grouped-by-tool list of every tool call in the current
 * session. Rendered inside both the desktop right rail (ChatTasksRail) and
 * the mobile bottom-sheet (TasksDrawer) so behavior is identical on both.
 *
 * Grouping:
 *   - Task / Agent / Explore tool_use rows are never surfaced here — they
 *     all live in SubagentsPanel (the store's `computeSubagentRuns`
 *     synthesizes legacy ones for pre-Phase-1 sessions too).
 *   - MCP tools (`mcp__<server>__<tool>`) are collapsed into one group
 *     per server — e.g. `mcp__chrome-devtools__close_page` and
 *     `mcp__chrome-devtools__list_pages` share a `MCP · chrome-devtools`
 *     bucket, but each row still chips its full raw name so the user
 *     can see which MCP tool actually fired.
 *   - Every other tool name gets its own group; groups are rendered in
 *     alphabetical order (Bash, Edit, Glob, Grep, …).
 *
 * Each row re-implements the mockup s-13 sub-row tile:
 *   - 3px colored left strip (klein running, success done, danger failed)
 *   - small tool chip (mono, bordered, colored per status)
 *   - truncated description derived from the tool input
 *   - right-side duration: mm:ss live timer while running, timeAgoShort for
 *     completed rows, "error" for failed.
 *
 * We do NOT own an approval queue here — the approval UI is already in the
 * main transcript as its own piece, and Chat.tsx's `pendingApprovalCount`
 * is consumed by the header strip above us, not this list. Keeping the rail
 * purely reactive to `pieces` means it survives transcript refetches for
 * free.
 */

export type TaskState = "running" | "done" | "failed";

export interface TaskRow {
  /** Stable id — the tool_use id; used as the react key and passed through
   * to onReveal so Chat can scroll to the source piece in the transcript. */
  id: string;
  /** Raw SDK tool name (e.g. "Bash", "Task"). Used for grouping + the chip. */
  name: string;
  /** One-line summary of the input — truncated. */
  summary: string;
  /** Paired tool_result-derived status. */
  state: TaskState;
  /** ISO timestamp of the tool_use piece. Used for the live timer and the
   * timeAgoShort label on finished rows. */
  startedAt?: string;
  /** Paired tool_result duration in ms, if the underlying result tracks it.
   * We don't currently — rows fall back to startedAt→finishedAt math. */
  durationMs?: number | null;
  /** ISO finishedAt for completed rows; used to render "Xs ago" via
   * timeAgoShort on done rows. Running rows use startedAt for mm:ss. */
  finishedAt?: string;
}

/**
 * Walk `pieces` once and pair every tool_use with its matching tool_result
 * (if any) by toolUseId. Orphan tool_results (no preceding tool_use) are
 * ignored — they'd have no row to attach to anyway.
 *
 * Task / Agent / Explore tool_use events are always skipped here — they
 * live in SubagentsPanel, which synthesizes legacy rows (pre-Phase-1 SDK)
 * on top of the live `subagent_start`-driven rows so the panel is the
 * single canonical subagents surface.
 *
 * Rows are returned in no particular order; the group renderer sorts them
 * (newest first within a group) so callers can trust display order.
 */
export function buildTaskRows(pieces: UIPiece[]): TaskRow[] {
  const resultsById = new Map<string, UIPiece & { kind: "tool_result" }>();
  for (const p of pieces) {
    if (p.kind === "tool_result") resultsById.set(p.toolUseId, p);
  }
  const rows: TaskRow[] = [];
  for (const p of pieces) {
    if (p.kind !== "tool_use") continue;
    // Every Task/Agent/Explore row is handled by SubagentsPanel now
    // (including legacy rows via `computeSubagentRuns`'s synthesis pass).
    if (SUBAGENT_PARENT_TOOLS.has(p.name)) continue;
    // Tool calls owned by a subagent (sync or async) carry
    // parentToolUseId. They belong to that subagent's run inside
    // SubagentsPanel, NOT to the main agent's task list. Without this
    // guard, a sync subagent's Bash/Read/Grep calls leak into the
    // main tasks rail, doubling them up and misattributing authorship.
    if (p.parentToolUseId) continue;
    const matched = resultsById.get(p.id);
    let state: TaskState = "running";
    if (matched) state = matched.isError ? "failed" : "done";
    rows.push({
      id: p.id,
      name: p.name,
      summary: summarizeToolCall(p.name, p.input),
      state,
      startedAt: p.createdAt,
      finishedAt: matched?.createdAt,
      durationMs: null,
    });
  }
  return rows;
}

interface TaskGroup {
  /** Display label — e.g. `"Bash"` for a regular tool, or
   * `"MCP · chrome-devtools"` for an MCP bucket. */
  label: string;
  rows: TaskRow[];
}

/**
 * Extract the MCP server name from a tool name like `mcp__<server>__<tool>`.
 * Returns `null` if the name doesn't match the MCP naming shape.
 */
function mcpServerFromToolName(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  const server = parts[1];
  return server && server.length > 0 ? server : null;
}

function groupRows(rows: TaskRow[]): TaskGroup[] {
  const byLabel = new Map<string, TaskRow[]>();
  for (const r of rows) {
    const mcpServer = mcpServerFromToolName(r.name);
    const label = mcpServer ? `MCP · ${mcpServer}` : r.name;
    const list = byLabel.get(label);
    if (list) list.push(r);
    else byLabel.set(label, [r]);
  }
  // Newest-first within a group. We don't have a reliable seq on every
  // UIPiece (pending / optimistic pieces can lack it) so we use the
  // position in the pieces array by proxy — rows were pushed in piece
  // order, so reverse gets us newest-first.
  const sortNewestFirst = (arr: TaskRow[]) => arr.slice().reverse();
  const alpha = [...byLabel.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out: TaskGroup[] = [];
  for (const [label, rs] of alpha) {
    if (rs.length > 0) out.push({ label, rows: sortNewestFirst(rs) });
  }
  return out;
}

/**
 * localStorage key per session for persisted collapse state. Shape is
 * `Record<groupLabel, boolean>` where `true` means "expanded". We key by
 * sessionId so opening a different session gets its own fresh default
 * (groups with running rows open, rest collapsed) rather than inheriting
 * another session's user toggles.
 */
const LS_PREFIX = "claudex:taskRailGroups:";

function readPersisted(sessionId: string | undefined): Record<string, boolean> {
  if (!sessionId) return {};
  try {
    const raw = localStorage.getItem(LS_PREFIX + sessionId);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "boolean") out[k] = v;
      }
      return out;
    }
  } catch {
    // Corrupted storage — start fresh; don't crash the rail.
  }
  return {};
}

export function TasksList({
  pieces,
  sessionId,
  onReveal,
}: {
  pieces: UIPiece[];
  /**
   * Session id used to scope persisted collapse state in localStorage.
   * Optional — when omitted (e.g. older callers) collapse state still
   * works in-memory but isn't persisted across remounts.
   */
  sessionId?: string;
  /** Scroll the main transcript to the source event when a row is clicked.
   * We only ever emit "tool-use-id"; approvals have their own card inline
   * and aren't listed here. */
  onReveal?: (attr: "tool-use-id", id: string) => void;
}) {
  const rows = useMemo(() => buildTaskRows(pieces), [pieces]);
  const groups = useMemo(() => groupRows(rows), [rows]);
  const hasRunning = rows.some((r) => r.state === "running");

  // Tick once a second while anything is running so mm:ss timers stay
  // fresh. We do a single panel-level interval instead of one per row —
  // cheap, and it stops as soon as nothing is running. Lives at the list
  // level (not the group) so the timer keeps ticking for running rows
  // even inside collapsed groups — which matters because a collapsed
  // group with a running row will re-open or reveal the right label as
  // soon as the user expands it, without a stale value flash.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    const handle = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(handle);
  }, [hasRunning]);

  // ----- Collapse state -----
  //
  // Two sources of truth, composed at render time:
  //   1. `userToggled` — labels the user has explicitly clicked in this
  //      session, with whatever boolean they landed on. This wins.
  //   2. Derived default — a group whose rows include a running row is
  //      expanded by default; everything else is collapsed by default.
  //      Re-evaluated every render from `groups` so newly-created groups
  //      (e.g. first Bash call lands mid-turn) get the right default
  //      without us having to migrate any state on each rows change.
  //
  // We persist `userToggled` to localStorage (scoped per session) so the
  // user's choices survive remounts. On mount we hydrate from storage;
  // the default rule still applies to any group not in storage yet.
  const [userToggled, setUserToggled] = useState<Record<string, boolean>>(() =>
    readPersisted(sessionId),
  );

  // If the session id changes (navigating between sessions with the rail
  // mounted) refresh the toggles from storage — otherwise session B would
  // inherit session A's user choices.
  const lastSessionIdRef = useRef<string | undefined>(sessionId);
  useEffect(() => {
    if (lastSessionIdRef.current !== sessionId) {
      lastSessionIdRef.current = sessionId;
      setUserToggled(readPersisted(sessionId));
    }
  }, [sessionId]);

  // Debounced persist. We keep a timer ref so the latest pending write
  // wins, and flush on unmount so a quick toggle → navigate doesn't drop
  // the user's choice.
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Record<string, boolean> | null>(null);
  const flush = useCallback(() => {
    if (!sessionId) return;
    const toWrite = pendingRef.current;
    if (!toWrite) return;
    pendingRef.current = null;
    try {
      localStorage.setItem(LS_PREFIX + sessionId, JSON.stringify(toWrite));
    } catch {
      // Quota / disabled storage — silent; in-memory state still works.
    }
  }, [sessionId]);
  useEffect(() => {
    pendingRef.current = userToggled;
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flush, 250);
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [userToggled, flush]);
  useEffect(() => {
    // Flush on unmount so navigation doesn't lose the latest toggle.
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flush();
    };
  }, [flush]);

  const isExpanded = useCallback(
    (label: string, groupHasRunning: boolean): boolean => {
      if (Object.prototype.hasOwnProperty.call(userToggled, label)) {
        return userToggled[label];
      }
      return groupHasRunning;
    },
    [userToggled],
  );

  const toggle = useCallback((label: string, next: boolean) => {
    setUserToggled((prev) => ({ ...prev, [label]: next }));
  }, []);

  if (groups.length === 0) return <EmptyState />;

  return (
    <div className="flex flex-col">
      {groups.map((g) => {
        const groupHasRunning = g.rows.some((r) => r.state === "running");
        const expanded = isExpanded(g.label, groupHasRunning);
        return (
          <TaskGroupView
            key={g.label}
            group={g}
            expanded={expanded}
            groupHasRunning={groupHasRunning}
            onToggle={() => toggle(g.label, !expanded)}
            onReveal={onReveal}
          />
        );
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div
        className="h-12 w-12 rounded-full bg-paper border border-line flex items-center justify-center mb-3"
        aria-hidden
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className="w-5 h-5 text-ink-muted"
        >
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      </div>
      <div className="text-ui font-medium text-ink">还没有工具调用。</div>
      <div className="text-ui text-ink-muted max-w-[30ch] mt-1">
        当 claude 使用 bash、编辑或搜索时，它们会显示在这里。
      </div>
    </div>
  );
}

function TaskGroupView({
  group,
  expanded,
  groupHasRunning,
  onToggle,
  onReveal,
}: {
  group: TaskGroup;
  expanded: boolean;
  groupHasRunning: boolean;
  onToggle: () => void;
  onReveal?: (attr: "tool-use-id", id: string) => void;
}) {
  const runCount = group.rows.length;
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "w-full px-2.5 py-1.5 flex items-center gap-1.5 text-left hover:bg-paper/60 transition-colors",
          // Subtle bottom border when collapsed — visually terminates the
          // group without the row list to do it for us.
          !expanded && "border-b border-line/40",
        )}
      >
        <ChevronRight
          className={cn(
            "w-2.5 h-2.5 text-ink-muted shrink-0 transition-transform",
            expanded ? "rotate-90" : "rotate-0",
          )}
          aria-hidden
        />
        <span className="uppercase tracking-[0.12em] text-ui-sm font-medium text-ink-soft">
          {group.label}
        </span>
        <span className="mono text-ui-sm text-ink-muted">
          · {runCount}
        </span>
        {groupHasRunning && (
          <span
            aria-hidden
            className="h-1 w-1 rounded-full bg-klein animate-pulse"
            title="存在运行中的工具调用"
          />
        )}
      </button>
      {expanded && (
        <div className="pt-0.5 pb-1">
          {group.rows.map((row) => (
            <TaskRowView key={row.id} row={row} onReveal={onReveal} />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskRowView({
  row,
  onReveal,
}: {
  row: TaskRow;
  onReveal?: (attr: "tool-use-id", id: string) => void;
}) {
  const tint = rowTint(row.state);
  const right = renderRightLabel(row);
  const RowToolIcon = toolIcon(row.name);
  return (
    <div
      className={cn(
        "mx-3 mb-1.5 rounded-lg border overflow-hidden relative",
        tint.border,
        tint.bg,
      )}
    >
      {/* 3px colored left strip — status indicator. */}
      <div
        aria-hidden
        className={cn("absolute left-0 top-0 bottom-0 w-[3px]", tint.strip)}
      />
      <button
        type="button"
        onClick={() => onReveal?.("tool-use-id", row.id)}
        className="w-full pl-3 pr-2.5 py-2 flex items-center gap-2 text-left hover:bg-paper/40 transition-colors"
        title={row.summary || row.name}
      >
        <span
          className={cn(
            "inline-flex items-center gap-1 px-1.5 h-5 rounded-xs border mono text-ui-sm shrink-0",
            tint.chip,
          )}
        >
          <RowToolIcon className="w-3 h-3" aria-hidden />
          {row.name}
        </span>
        <StatusIcon state={row.state} />
        <span className="text-ui text-ink truncate flex-1">
          {row.summary || (
            <span className="text-ink-muted italic">(无描述)</span>
          )}
        </span>
        <span
          className={cn(
            "mono text-ui-sm shrink-0 tabular-nums",
            row.state === "failed" ? "text-danger" : "text-ink-muted",
          )}
          title={row.startedAt ? new Date(row.startedAt).toLocaleString() : undefined}
        >
          {right}
        </span>
      </button>
    </div>
  );
}

function StatusIcon({ state }: { state: TaskState }) {
  if (state === "running") {
    return (
      <Loader2
        className="w-3 h-3 text-klein animate-spin shrink-0"
        aria-hidden
      />
    );
  }
  if (state === "failed") {
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

function rowTint(state: TaskState): {
  strip: string;
  bg: string;
  border: string;
  chip: string;
} {
  if (state === "failed") {
    return {
      strip: "bg-danger/70",
      bg: "bg-danger-wash/40",
      border: "border-danger/25",
      chip: "border-danger/30 text-danger bg-canvas/70",
    };
  }
  if (state === "running") {
    return {
      strip: "bg-klein",
      bg: "bg-klein-wash/35",
      border: "border-klein/25",
      chip: "border-klein/40 text-klein-ink bg-canvas/70",
    };
  }
  return {
    strip: "bg-success/50",
    bg: "bg-canvas",
    border: "border-line",
    chip: "border-line text-ink-soft",
  };
}

/**
 * Right-side label: mm:ss live timer while running, timeAgoShort on done,
 * "error" on failed. We prefer the started-at ISO for the running timer
 * because the underlying UIPiece doesn't surface a monotonic start — we
 * wall-clock against Date.now() and let the parent's 1s interval tick us.
 */
function renderRightLabel(row: TaskRow): string {
  if (row.state === "failed") return "出错";
  if (row.state === "running") {
    if (!row.startedAt) return "运行中";
    return formatElapsedClock(row.startedAt);
  }
  // done — prefer the tool_result createdAt so the label reads like a
  // "finished N ago", not "started N ago". Falls back to startedAt if the
  // paired result's createdAt is missing (older events).
  return timeAgoShort(row.finishedAt ?? row.startedAt ?? null);
}

/** mm:ss elapsed from an ISO start — compact, tabular-nums caller. */
function formatElapsedClock(startedAtIso: string): string {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return "—";
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
