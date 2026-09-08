import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, FileText, Check, X, FolderOpen } from "lucide-react";
import type { PendingDiffEntry, Session } from "@claudex/shared";
import { api } from "@/api/client";
import { useSessions } from "@/state/sessions";
import { DiffView } from "@/components/DiffView";
import type { FileDiff } from "@/lib/diff";
import { cn } from "@/lib/cn";

/**
 * Full-screen Diff Review page — mockup s-06 (lines 1236-1380).
 *
 * Renders every diff-producing tool call in the session that's currently
 * awaiting user attention, aggregated server-side via
 * `GET /api/sessions/:id/pending-diffs`. Layout:
 *
 *   desktop (md+):  [260px files] [fluid diff] [320px summary]
 *   mobile:         diff only, with a "N files" chip that pops a top sheet
 *
 * The inline chat-thread diff rendering is untouched — this page is a
 * separate surface for cases where the user wants to review everything
 * before answering. Opening the page does NOT auto-approve anything;
 * it's read-only until the user taps Approve.
 *
 * `?approvalId=<id>` in the query string preselects one diff on mount —
 * used when the Chat screen's PermissionCard deep-links into the page.
 */
export function DiffReviewScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const preselectId = search.get("approvalId");
  // See the same pattern in Chat.tsx: `sessionBase` holds the REST-fetched
  // DTO; the live `status` comes from the global sessions store (populated
  // by WS `session_update` frames) so the header dot + awaiting gates
  // react to server transitions without waiting for a reload.
  const [sessionBase, setSession] = useState<Session | null>(null);
  const liveStatus = useSessions((s) =>
    id ? s.sessions.find((x) => x.id === id)?.status : undefined,
  );
  const refreshSessions = useSessions((s) => s.refreshSessions);
  useEffect(() => {
    if (!id) return;
    const present = useSessions.getState().sessions.some((x) => x.id === id);
    if (!present) void refreshSessions();
  }, [id, refreshSessions]);
  const session = useMemo<Session | null>(() => {
    if (!sessionBase) return null;
    return liveStatus !== undefined
      ? { ...sessionBase, status: liveStatus }
      : sessionBase;
  }, [sessionBase, liveStatus]);
  const [diffs, setDiffs] = useState<PendingDiffEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedToolUseId, setSelectedToolUseId] = useState<string | null>(
    null,
  );
  const [showFilesSheet, setShowFilesSheet] = useState(false);
  const { resolvePermission } = useSessions();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .getSession(id)
      .then((r) => {
        if (!cancelled) setSession(r.session);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    api
      .listPendingDiffs(id)
      .then((r) => {
        if (cancelled) return;
        setDiffs(r.diffs);
        // Preselect from the query param if it matches; otherwise pick the
        // first diff so the center panel never starts empty.
        const match = preselectId
          ? r.diffs.find((d) => d.approvalId === preselectId)
          : null;
        setSelectedToolUseId(
          match?.toolUseId ?? r.diffs[0]?.toolUseId ?? null,
        );
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, preselectId]);

  const selected = useMemo(() => {
    if (!diffs || !selectedToolUseId) return null;
    return diffs.find((d) => d.toolUseId === selectedToolUseId) ?? null;
  }, [diffs, selectedToolUseId]);

  // Derived: how many diffs have an outstanding approval pending.
  const pendingApprovals = useMemo(
    () => (diffs ?? []).filter((d) => d.approvalId),
    [diffs],
  );

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const d of diffs ?? []) {
      add += d.addCount;
      del += d.delCount;
    }
    return { add, del };
  }, [diffs]);

  function toFileDiff(entry: PendingDiffEntry): FileDiff {
    // Translate the server-shaped entry into the shape <DiffView> expects.
    // The `kind` field labels differ slightly: the UI's DiffView uses
    // "create" / "edit" / "overwrite", while the server entry uses
    // "edit" / "write" / "multiedit" (matching the UI's bucket labels).
    // We map conservatively — a MultiEdit is rendered as an edit since
    // DiffView already handles multi-hunk layouts.
    const kind: FileDiff["kind"] = entry.kind === "write" ? "overwrite" : "edit";
    return {
      path: entry.filePath,
      kind,
      addCount: entry.addCount,
      delCount: entry.delCount,
      hunks: entry.hunks,
    };
  }

  function handleApprove(entry: PendingDiffEntry) {
    if (!id || !entry.approvalId) return;
    resolvePermission(id, entry.approvalId, "allow_once");
    // Optimistically remove from the local list so the UI doesn't stay
    // stuck on an already-decided diff. A refetch would also work but
    // adds a round-trip; the server is the source of truth on navigation.
    setDiffs((prev) => (prev ?? []).filter((d) => d.toolUseId !== entry.toolUseId));
  }

  function handleReject(entry: PendingDiffEntry) {
    if (!id || !entry.approvalId) return;
    resolvePermission(id, entry.approvalId, "deny");
    setDiffs((prev) => (prev ?? []).filter((d) => d.toolUseId !== entry.toolUseId));
  }

  function handleApproveAll() {
    if (!id) return;
    for (const d of pendingApprovals) {
      resolvePermission(id, d.approvalId!, "allow_once");
    }
    // Clear the local list — the server won't return these anymore either.
    setDiffs([]);
  }

  if (!id) return null;

  return (
    <div className="flex h-[100dvh] bg-canvas">
      {/* Mobile back / title header. Hidden on desktop since the left rail
          provides its own context. */}
      <div className="md:hidden fixed inset-x-0 top-0 z-20 flex items-center gap-2 px-4 py-2.5 border-b border-line bg-canvas">
        <button
          type="button"
          onClick={() => navigate(`/session/${id}`)}
          className="h-8 w-8 rounded bg-paper border border-line flex items-center justify-center shrink-0 hover:bg-paper/80 transition-colors"
          aria-label="返回对话"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-ui-lg font-medium truncate">
            差异 {diffs ? `· ${diffs.length} 个文件` : ""}
          </div>
          <div className="mono text-ui text-ink-muted truncate">
            <span className="text-success">+{totals.add}</span>{" "}
            <span className="text-danger">−{totals.del}</span>
            {session ? ` · ${session.title}` : ""}
          </div>
        </div>
        {diffs && diffs.length > 0 && (
          <button
            type="button"
            onClick={() => setShowFilesSheet(true)}
            className="h-8 px-2.5 rounded bg-paper border border-line text-ui flex items-center gap-1.5 hover:bg-paper/80 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {diffs.length} files
          </button>
        )}
      </div>

      {/* Desktop + mobile grid. The `md:grid` activation kicks in at the
          desktop breakpoint; on mobile we let the center panel flow full
          width. `min-h-0` + `h-full` keep the grid bounded to the 100dvh
          parent so the inner `overflow-y-auto` actually scrolls instead
          of growing the page. */}
      <div className="flex-1 min-w-0 min-h-0 h-full flex md:grid md:grid-cols-[260px_minmax(0,1fr)_320px]">
        {/* Left rail — files. Desktop only. */}
        <aside className="hidden md:flex flex-col border-r border-line bg-paper/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-line flex items-center shrink-0">
            <Link
              to={`/session/${id}`}
              className="mr-2 h-7 w-7 rounded bg-canvas border border-line flex items-center justify-center shrink-0"
              aria-label="返回对话"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </Link>
            <span className="text-ui uppercase tracking-[0.12em] text-ink-muted">
              文件
            </span>
            <span className="ml-auto mono text-ui text-ink-muted">
              {diffs?.length ?? 0} 处修改
            </span>
          </div>
          <div className="overflow-y-auto flex-1 py-1">
            {diffs && diffs.length === 0 && (
              <div className="px-4 py-3 text-ui text-ink-muted">
                此会话没有待处理的差异。
              </div>
            )}
            {(diffs ?? []).map((d) => (
              <FileRow
                key={d.toolUseId}
                entry={d}
                active={d.toolUseId === selectedToolUseId}
                onClick={() => setSelectedToolUseId(d.toolUseId)}
              />
            ))}
          </div>
        </aside>

        {/* Center — selected diff. `min-h-0` is required here so the
            inner `overflow-y-auto` actually scrolls; without it the flex
            column grows to its content and the scroll leaks to the page. */}
        <section className="flex flex-col min-w-0 min-h-0 flex-1 pt-[52px] md:pt-0">
          {/* Sticky header with path / counts / per-file actions. */}
          {selected && (
            <div className="sticky top-0 z-10 bg-canvas border-b border-line px-4 md:px-5 py-3 flex items-center gap-3">
              <div className="min-w-0">
                <div className="display text-ui-heading md:text-ui-title leading-tight truncate">
                  {selected.filePath}
                </div>
                <div className="mono text-ui text-ink-muted truncate">
                  <span className="text-success">+{selected.addCount}</span>{" "}
                  <span className="text-danger">−{selected.delCount}</span>
                  {" · "}
                  {selected.hunks.length} 个差异块
                  {selected.kind ? ` · ${selected.kind}` : ""}
                </div>
              </div>
              {selected.approvalId && (
                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleReject(selected)}
                    className="h-8 px-3 rounded border border-line bg-canvas text-ui text-danger flex items-center gap-1.5 hover:bg-danger-wash transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                    拒绝
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApprove(selected)}
                    className="h-8 px-3 rounded bg-klein text-canvas text-ui font-medium flex items-center gap-1.5 hover:bg-klein/90 transition-colors"
                  >
                    <Check className="w-3.5 h-3.5" />
                    批准
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="flex-1 overflow-y-auto bg-canvas">
            {error && (
              <div className="px-5 py-4 text-ui text-danger">
                无法加载差异:{error}
              </div>
            )}
            {!error && diffs == null && (
              <div className="px-5 py-8 text-ui text-ink-muted text-center">
                加载差异中…
              </div>
            )}
            {!error && diffs && diffs.length === 0 && (
              <EmptyState sessionId={id} />
            )}
            {selected && (
              <div className="p-4 md:p-5">
                <DiffView diff={toFileDiff(selected)} defaultOpen />
              </div>
            )}
          </div>

          {/* Footer — sticky. */}
          <div className="shrink-0 border-t border-line bg-canvas px-4 md:px-5 py-3 flex items-center gap-3">
            <Link
              to={`/session/${id}`}
              className="text-ui text-ink-muted hover:text-ink-soft hidden md:inline transition-colors"
            >
              ← 返回对话
            </Link>
            <div className="mono text-ui text-ink-muted truncate hidden md:block">
              {session?.title ?? id}
              {session?.branch ? ` · ${session.branch}` : ""}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={handleApproveAll}
                disabled={pendingApprovals.length === 0}
                className="h-9 px-4 rounded bg-klein text-canvas text-ui font-medium shadow-card hover:bg-klein/90 transition-colors disabled:opacity-40"
              >
                全部批准
                {pendingApprovals.length > 0
                  ? ` (${pendingApprovals.length})`
                  : ""}
              </button>
            </div>
          </div>
        </section>

        {/* Right rail — summary / checks. Desktop only. */}
        <aside className="hidden md:flex flex-col border-l border-line bg-paper/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-line shrink-0">
            <span className="text-ui uppercase tracking-[0.12em] text-ink-muted">
              此补丁的作用
            </span>
          </div>
          <div className="overflow-y-auto flex-1 p-4 space-y-4">
            <SummaryPanel selected={selected} diffs={diffs ?? []} />
            <ChecksPanel />
          </div>
        </aside>
      </div>

      {/* Mobile files top-sheet. Only rendered when toggled. */}
      {showFilesSheet && diffs && (
        <MobileFilesSheet
          diffs={diffs}
          selectedId={selectedToolUseId}
          onPick={(toolUseId) => {
            setSelectedToolUseId(toolUseId);
            setShowFilesSheet(false);
          }}
          onClose={() => setShowFilesSheet(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File list row (desktop rail + mobile sheet share the same visuals).
// ---------------------------------------------------------------------------
function FileRow({
  entry,
  active,
  onClick,
}: {
  entry: PendingDiffEntry;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 border-b border-line/60 text-left",
        active
          ? "bg-klein-wash/40 border-l-2 border-l-klein"
          : "hover:bg-canvas/60 border-l-2 border-l-transparent transition-colors",
      )}
    >
      <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
      <span className="mono text-ui truncate flex-1">{entry.filePath}</span>
      {entry.approvalId && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-warn shrink-0"
          title="等你审批"
        />
      )}
      {entry.addCount > 0 && (
        <span className="mono text-ui text-success shrink-0">
          +{entry.addCount}
        </span>
      )}
      {entry.delCount > 0 && (
        <span className="mono text-ui text-danger shrink-0">
          −{entry.delCount}
        </span>
      )}
    </button>
  );
}

function SummaryPanel({
  selected,
  diffs,
}: {
  selected: PendingDiffEntry | null;
  diffs: PendingDiffEntry[];
}) {
  if (!selected) {
    return (
      <div className="rounded-lg border border-line bg-canvas shadow-card p-3 text-ui text-ink-muted">
        未选中差异。
      </div>
    );
  }
  const pendingCount = diffs.filter((d) => d.approvalId).length;
  return (
    <div className="rounded-lg border border-line bg-canvas shadow-card p-3 text-ui leading-[1.55] text-ink-soft">
      {selected.title ? (
        <>
          <div className="font-medium text-ink">{selected.title}</div>
          <div className="mt-1 mono text-ui text-ink-muted">
            {selected.filePath}
          </div>
        </>
      ) : (
        <>
          <div className="font-medium text-ink">进行中的编辑</div>
          <div className="mt-1 text-ui text-ink-muted">
            此改动未附加权限提示——会话正以自动接受更改的模式运行,而该工具
            调用仍在执行中。
          </div>
        </>
      )}
      <div className="mt-3 text-ui text-ink-muted">
        {pendingCount > 0
          ? `本会话中有 ${pendingCount} 个文件等待你决定。`
          : "本会话的所有更改均已被处理。"}
      </div>
    </div>
  );
}

function ChecksPanel() {
  // We don't inspect the project for CI config yet — stay honest. When
  // we wire a checks reader this panel grows.
  return (
    <div className="rounded-lg border border-line bg-paper/60 shadow-card p-3 text-ui text-ink-muted">
      <div className="text-ui uppercase tracking-[0.12em] text-ink-muted mb-1">
        检查
      </div>
      此项目未配置 CI。
    </div>
  );
}

function EmptyState({ sessionId }: { sessionId: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 px-6 text-center gap-3">
      <div className="text-ui text-ink-muted">
        此会话没有待处理的差异。
      </div>
      <Link
        to={`/session/${sessionId}`}
        className="text-ui text-klein-ink hover:underline"
      >
        ← 返回对话
      </Link>
    </div>
  );
}

function MobileFilesSheet({
  diffs,
  selectedId,
  onPick,
  onClose,
}: {
  diffs: PendingDiffEntry[];
  selectedId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm flex items-start justify-center"
      onClick={onClose}
    >
      <div
        className="w-full bg-canvas border-b border-line rounded-b-2xl shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-line flex items-center">
          <span className="text-ui uppercase tracking-[0.12em] text-ink-muted">
            文件 · {diffs.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-7 px-2 rounded-sm border border-line text-ui"
          >
            关闭
          </button>
        </div>
        <div className="max-h-[60dvh] overflow-y-auto">
          {diffs.map((d) => (
            <FileRow
              key={d.toolUseId}
              entry={d}
              active={d.toolUseId === selectedId}
              onClick={() => onPick(d.toolUseId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
