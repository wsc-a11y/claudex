import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, FileText } from "lucide-react";
import type {
  Session,
  SessionDiffApproval,
  SessionDiffFile,
  SessionDiffResponse,
  SessionDiffTimelineEntry,
} from "@claudex/shared";
import { api } from "@/api/client";
import { Logo } from "@/components/Logo";
import { useSessions } from "@/state/sessions";
import { DiffView } from "@/components/DiffView";
import type { FileDiff } from "@/lib/diff";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";

// ---------------------------------------------------------------------------
// Session diff summary screen (mockup s-15).
//
// A PR-shaped aggregation of every file change in the session. Entered
// from the Chat header's "Session diff" icon. Desktop layout: 3-col
// `[260px | 1fr | 280px]` — file list | single-file diff | timeline +
// review card. Clicking a file in the left rail focuses it in the
// center pane (one file at a time, GitHub-style); the first file is
// selected by default. Mobile: stacked — summary card, file rows with
// expand-to-diff, inline timeline.
//
// Non-goals for this cut:
//   - Inline comments on diff lines (would need a whole new persistence
//     layer for per-line comments)
//   - Bulk accept/reject (the "Accept all pending" button is a visual
//     placeholder; individual permission prompts already have their own
//     Accept path in /session/:id)
//   - AI review synthesis (the right-rail card is a stub explaining the
//     feature isn't wired yet — matches the mockup copy)
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<string, string> = {
  M: "bg-warn/15 text-warn-ink",
  A: "bg-success/15 text-success",
  D: "bg-danger/15 text-danger",
  R: "bg-klein/15 text-klein",
};

const APPROVAL_CHIP: Record<SessionDiffApproval, string> = {
  accepted: "border-success/30 bg-success/10 text-success-ink",
  rejected: "border-danger/30 bg-danger/10 text-danger",
  pending: "border-warn/30 bg-warn/10 text-warn-ink",
  auto: "border-line bg-paper text-ink-muted",
};

const TIMELINE_DOT: Record<SessionDiffApproval, string> = {
  accepted: "bg-success",
  rejected: "bg-danger",
  pending: "bg-warn",
  auto: "bg-ink-faint",
};

function approvalLabel(a: SessionDiffApproval): string {
  switch (a) {
    case "accepted":
      return "已接受";
    case "rejected":
      return "已拒绝";
    case "pending":
      return "待处理";
    case "auto":
      return "自动接受";
  }
}

const STATUS_LABEL: Record<string, string> = {
  A: "新增",
  M: "修改",
  D: "删除",
  R: "重命名",
};

/** Convert a SessionDiffFile to the FileDiff shape DiffView expects. The
 *  kind field is a lie of omission — FileDiff only has three kinds
 *  (create/edit/overwrite); we map status → kind as a best-effort. It
 *  only affects the tiny badge in DiffView's header. */
function toFileDiff(f: SessionDiffFile): FileDiff {
  return {
    path: f.path,
    kind: f.status === "A" ? "create" : "edit",
    addCount: f.addCount,
    delCount: f.delCount,
    hunks: f.hunks,
  };
}

export function SessionDiffScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Live status overlay — if the session is already in the sessions list
  // state, prefer its .status over the snapshot we fetched, so the dot
  // moves in real time.
  const liveStatus = useSessions((s) =>
    id ? s.sessions.find((x) => x.id === id)?.status : undefined,
  );

  const [sessionBase, setSessionBase] = useState<Session | null>(null);
  const [diff, setDiff] = useState<SessionDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Desktop: which file's diff to show in the center pane. Defaults to
  // the first file once the diff loads; if the selected path disappears
  // from a refresh (rare — the session is still open and a file rolls
  // back), fall back to the first file so we never render an empty
  // center pane while the sidebar still has rows.
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedMobile, setExpandedMobile] = useState<string | null>(null);
  // Mobile view switcher: "files" shows the per-file rows with expand-to-
  // diff, "timeline" shows the chronological entries list. Desktop keeps
  // both panes on-screen (three-col grid); mobile has to choose.
  const [mobileView, setMobileView] = useState<"files" | "timeline">("files");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .getSession(id)
      .then((r) => {
        if (!cancelled) setSessionBase(r.session);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    api
      .getSessionDiff(id)
      .then((r) => {
        if (!cancelled) setDiff(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const session = useMemo<Session | null>(() => {
    if (!sessionBase) return null;
    return liveStatus !== undefined
      ? { ...sessionBase, status: liveStatus }
      : sessionBase;
  }, [sessionBase, liveStatus]);

  // Keep `selectedFile` in sync with the file list. Default to the first
  // file once the diff loads; if the current selection isn't in the new
  // file list (e.g. tool-use rollback), fall back to the first file.
  useEffect(() => {
    if (!diff) return;
    if (diff.files.length === 0) {
      if (selectedFile !== null) setSelectedFile(null);
      return;
    }
    if (!selectedFile || !diff.files.some((f) => f.path === selectedFile)) {
      setSelectedFile(diff.files[0].path);
    }
  }, [diff, selectedFile]);

  if (!id) return null;

  const totalsLine = diff
    ? `+${diff.totals.additions} −${diff.totals.deletions} 共 ${
        diff.totals.filesChanged
      } 个文件有改动`
    : "加载中…";

  return (
    <div className="flex flex-col h-[100dvh] bg-canvas">
      {/* Top bar (both mobile + desktop — desktop gets richer info) */}
      <header className="shrink-0 border-b border-line bg-canvas/95 backdrop-blur px-4 md:px-6 py-2.5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(`/session/${id}`)}
          className="h-8 w-8 rounded bg-paper border border-line flex items-center justify-center shrink-0"
          aria-label="返回对话"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-ui md:text-ui-lg font-medium truncate">
            {session?.title ?? "会话差异"}
          </div>
          <div className="mono text-ui text-ink-muted truncate">
            {diff ? totalsLine : "加载中…"}
            {session?.branch ? ` · ${session.branch}` : ""}
          </div>
        </div>
      </header>

      {error && (
        <div className="px-5 py-4 text-ui text-danger">
          无法加载会话差异:{error}
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-[260px_minmax(0,1fr)_280px] overflow-hidden">
        {/* Desktop: left rail (file list) */}
        <aside className="hidden md:flex flex-col border-r border-line bg-paper/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-line shrink-0 flex items-center gap-2">
            <span className="caps text-ink-muted">文件</span>
            {diff && (
              <span className="ml-auto mono text-ui text-ink-muted">
                {diff.totals.filesChanged} 处修改
              </span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto py-2">
            {!diff && (
              <div className="px-4 py-2 text-ui text-ink-muted">
                加载中…
              </div>
            )}
            {diff?.files.length === 0 && (
              <div className="px-4 py-2 text-ui text-ink-muted">
                此会话没有文件改动。
              </div>
            )}
            {diff?.files.map((f) => {
              const isSelected = selectedFile === f.path;
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => setSelectedFile(f.path)}
                  aria-current={isSelected ? "true" : undefined}
                  className={cn(
                    "w-full flex items-center gap-2 px-4 py-1.5 border-l-2 text-left transition-colors",
                    isSelected
                      ? "border-l-klein bg-canvas/80 text-ink"
                      : "border-l-transparent hover:bg-canvas/60 transition-colors",
                  )}
                  title={f.path}
                >
                  <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  <span className="mono text-ui flex-1 truncate">
                    {f.path}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center px-1 rounded-xs text-[9px] font-medium uppercase tracking-widest shrink-0",
                      STATUS_BADGE[f.status],
                    )}
                  >
                    {STATUS_LABEL[f.status] ?? f.status}
                  </span>
                  {f.addCount > 0 && (
                    <span className="mono text-ui-sm text-success shrink-0">
                      +{f.addCount}
                    </span>
                  )}
                  {f.delCount > 0 && (
                    <span className="mono text-ui-sm text-danger shrink-0">
                      −{f.delCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Center: stitched diffs (desktop) / full list (mobile) */}
        <section className="flex flex-col min-w-0 overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto bg-canvas">
            {/* Mobile summary card */}
            {diff && (
              <div className="md:hidden mx-3 mt-3 mb-2 rounded-xl border border-line bg-paper/60 p-3">
                <div className="caps text-ink-muted text-ui">
                  {session?.status ?? "—"} · {diff.messageCount} 条用户消息
                </div>
                <div className="display text-ui-title leading-tight mt-1">
                  {totalsLine}
                </div>
                {session?.branch && (
                  <div className="mono text-ui text-ink-muted mt-0.5">
                    {session.branch} · {session.model}
                  </div>
                )}
              </div>
            )}

            {/* Mobile tab switcher — Files vs Timeline. Desktop uses the
                3-col layout so both panes are on-screen and this tab
                control is hidden there. */}
            {diff && (
              <div className="md:hidden px-3 mb-2">
                <div className="inline-flex rounded border border-line bg-paper/60 p-0.5">
                  <button
                    type="button"
                    onClick={() => setMobileView("files")}
                    className={cn(
                      "h-7 px-3 rounded-sm text-ui font-medium transition-colors",
                      mobileView === "files"
                        ? "bg-canvas text-ink shadow-card"
                        : "text-ink-muted",
                    )}
                  >
                    文件
                    {diff.files.length > 0 && (
                      <span className="ml-1 mono text-ui opacity-70">
                        {diff.files.length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMobileView("timeline")}
                    className={cn(
                      "h-7 px-3 rounded-sm text-ui font-medium transition-colors",
                      mobileView === "timeline"
                        ? "bg-canvas text-ink shadow-card"
                        : "text-ink-muted",
                    )}
                  >
                    时间线
                    {diff.timeline.length > 0 && (
                      <span className="ml-1 mono text-ui opacity-70">
                        {diff.timeline.length}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Mobile · Files view: file rows, tap to expand inline. */}
            {diff && mobileView === "files" && (
              <div className="md:hidden">
                {diff.files.length === 0 && (
                  <div className="px-4 py-6 text-center text-ui text-ink-muted">
                    此会话目前还没有文件改动。
                  </div>
                )}
                {diff.files.map((f) => (
                  <div key={f.path} className="border-b border-line/70">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedMobile((p) => (p === f.path ? null : f.path))
                      }
                      className="w-full px-4 py-3 text-left active:bg-paper/60"
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                        <div className="min-w-0 flex-1 mono text-ui truncate">
                          {f.path}
                        </div>
                        <span
                          className={cn(
                            "inline-flex items-center px-1.5 rounded-xs text-ui-sm font-medium uppercase tracking-widest shrink-0",
                            STATUS_BADGE[f.status],
                          )}
                        >
                          {STATUS_LABEL[f.status] ?? f.status}
                        </span>
                        <span className="mono text-ui shrink-0">
                          {f.addCount > 0 && (
                            <span className="text-success">+{f.addCount}</span>
                          )}{" "}
                          {f.delCount > 0 && (
                            <span className="text-danger">−{f.delCount}</span>
                          )}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-ui text-ink-muted">
                        <span>
                          {f.hunkCount} 个差异块
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xs border text-ui-sm font-medium uppercase tracking-widest",
                            APPROVAL_CHIP[f.approval],
                          )}
                        >
                          {approvalLabel(f.approval)}
                        </span>
                      </div>
                    </button>
                    {/* Expanded: borderless, edge-to-edge hunks — no second
                        file-path header (the row above already owns that). */}
                    {expandedMobile === f.path && f.hunks.length > 0 && (
                      <DiffView diff={toFileDiff(f)} defaultOpen headerless />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Mobile · Timeline view. Intentionally NOT wrapped in a card so
                long file paths can wrap/truncate against the viewport edge
                instead of against a card inset that makes them even harder
                to read. */}
            {diff && mobileView === "timeline" && (
              <div className="md:hidden px-4 py-2">
                {diff.timeline.length === 0 ? (
                  <div className="py-6 text-center text-ui text-ink-muted">
                    此会话目前还没有工具调用活动。
                  </div>
                ) : (
                  <TimelineList entries={diff.timeline} />
                )}
              </div>
            )}

            {/* Desktop: single selected file's diff. Clicking a file in
                the left rail swaps which one is shown here. No per-file
                collapse — there's only one file on-screen at a time, so
                collapse is redundant with the sidebar selection. */}
            {diff && (
              <div className="hidden md:block">
                {diff.files.length === 0 && (
                  <div className="px-6 py-8 text-center text-ui text-ink-muted">
                    此会话目前还没有文件改动。
                  </div>
                )}
                {diff.files
                  .filter((f) => f.path === selectedFile)
                  .map((f) => (
                    <div key={f.path}>
                      <div className="sticky top-0 z-10 bg-paper/90 backdrop-blur flex items-center gap-3 px-5 py-2 border-b border-line">
                        <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                        <span className="mono text-ui flex-1 truncate">
                          {f.path}
                        </span>
                        <span className="mono text-ui text-ink-muted">
                          <span className="text-success">+{f.addCount}</span>{" "}
                          <span className="text-danger">−{f.delCount}</span>
                          {" · "}
                          {f.hunkCount} 个差异块
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border text-ui-sm font-medium uppercase tracking-widest",
                            APPROVAL_CHIP[f.approval],
                          )}
                        >
                          {approvalLabel(f.approval)}
                        </span>
                      </div>
                      {f.hunks.length > 0 ? (
                        <DiffView
                          diff={toFileDiff(f)}
                          defaultOpen
                          headerless
                        />
                      ) : (
                        <div className="px-6 py-8 text-center text-ui text-ink-muted">
                          此文件没有文本差异。
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </section>

        {/* Desktop: right rail (timeline + AI review stub) */}
        <aside className="hidden md:flex flex-col border-l border-line bg-paper/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-line shrink-0 caps text-ink-muted">
            时间线
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            {diff?.timeline.length === 0 && (
              <div className="text-ui text-ink-muted">
                尚无文件改动。
              </div>
            )}
            {diff && diff.timeline.length > 0 && (
              <TimelineList entries={diff.timeline} desktop />
            )}
          </div>
          <div className="p-3 border-t border-line shrink-0">
            <div className="p-3 rounded-lg border border-line bg-canvas text-ui leading-[1.5] text-ink-muted">
              <div className="flex items-center gap-2 mb-1.5">
                <Logo className="w-4 h-4" />
                <span className="caps text-ink-muted">claude 审阅</span>
              </div>
              AI 审阅功能尚未接入。接入后,此卡片将汇总整个会话差异。
            </div>
          </div>
        </aside>
      </div>

      {/* Mobile: back-to-chat link at the bottom so it's thumb-reachable */}
      <div className="md:hidden shrink-0 px-3 py-2 border-t border-line bg-canvas">
        <Link
          to={`/session/${id}`}
          className="block w-full h-9 rounded bg-canvas border border-line text-center leading-9 text-ui text-ink-soft"
        >
          返回对话
        </Link>
      </div>
    </div>
  );
}

// ---- Timeline ---------------------------------------------------------------

function TimelineList({
  entries,
  desktop = false,
}: {
  entries: SessionDiffTimelineEntry[];
  desktop?: boolean;
}) {
  return (
    <div className={cn("relative pl-5", desktop ? "space-y-4" : "space-y-3")}>
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-line-strong" />
      {entries.map((e) => (
        <div key={e.toolUseId} className="relative min-w-0">
          <span
            className={cn(
              "absolute -left-5 top-1 rounded-full border-2 border-paper",
              desktop ? "h-3 w-3" : "h-2.5 w-2.5",
              TIMELINE_DOT[e.approval],
            )}
            style={
              e.approval === "pending"
                ? { boxShadow: "0 0 0 3px rgb(var(--c-warn)/0.18)" }
                : undefined
            }
          />
          <div className="font-medium text-ui min-w-0">
            {/* Verb is inline; file path is its own block below so long
                paths wrap against the viewport rather than pushing the
                verb and dot off-screen. `break-all` + overflow-wrap:
                anywhere is belt-and-suspenders for CJK paths and other
                non-space-delimited strings that the default word-wrap
                won't touch. */}
            <span>
              {e.action === "write"
                ? "写入"
                : e.action === "edit"
                  ? "编辑"
                  : "多次编辑"}
            </span>
            <div className="mono text-ui text-ink-soft break-all [overflow-wrap:anywhere] leading-snug mt-0.5">
              {e.filePath}
            </div>
          </div>
          <div className="text-ui text-ink-muted mono mt-0.5 break-all [overflow-wrap:anywhere]">
            {e.addCount > 0 && <span className="text-success">+{e.addCount}</span>}
            {e.addCount > 0 && e.delCount > 0 && " "}
            {e.delCount > 0 && <span className="text-danger">−{e.delCount}</span>}
            {(e.addCount > 0 || e.delCount > 0) && " · "}
            {timeAgoShort(e.createdAt)}
            {" · "}
            {approvalLabel(e.approval)}
          </div>
        </div>
      ))}
    </div>
  );
}
