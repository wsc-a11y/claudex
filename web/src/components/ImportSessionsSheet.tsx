import { useEffect, useMemo, useState } from "react";
import { X, FolderGit2, Check, RefreshCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { timeAgoShort, formatBytes } from "@/lib/format";
import { api, ApiError } from "@/api/client";
import type { CliSessionSummary, Session } from "@claudex/shared";
import { useFocusReturn } from "@/hooks/useFocusReturn";

/**
 * Adopt `claude` CLI sessions from `~/.claude/projects/...` into claudex.
 *
 * Lists every JSONL session the CLI has on disk that isn't already adopted,
 * lets the user pick a subset, and calls `POST /api/cli/sessions/import`.
 * After a successful import the caller decides what to do (navigate home,
 * refresh a list, etc.) via the `onImported` callback — this sheet is
 * intentionally agnostic so it can be hung off any entry point later.
 *
 * Wiring status: this component is NOT mounted from any screen yet. To
 * attach it from Home.tsx add a button that toggles `showImport` and
 * render `<ImportSessionsSheet onClose={…} onImported={refreshSessions} />`.
 */
export function ImportSessionsSheet({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported?: (imported: Session[]) => void;
}) {
  useFocusReturn();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CliSessionSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCliSessions();
      setCandidates(res.sessions);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `加载 CLI 会话失败：${err.code}`
          : "加载 CLI 会话失败",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selected.has(s.sessionId));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const s of filtered) next.delete(s.sessionId);
      } else {
        for (const s of filtered) next.add(s.sessionId);
      }
      return next;
    });
  }

  async function handleImport() {
    if (selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.importCliSessions(Array.from(selected));
      onImported?.(res.imported);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `导入失败：${err.code}`
          : "导入失败",
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      // The AppShell's MobileTabBar is `fixed ... z-30` and is a later DOM
      // sibling of the sheet's mount point. With equal z-index the tab bar
      // paints on top, clipping the sheet's "Import selected" footer on
      // mobile. Bump to z-40 so the sheet (and every sheet sibling at or
      // below z-30) sits above the tab bar. Matches TerminalDrawer /
      // Routines dialog patterns.
      className="fixed inset-0 z-40 bg-ink/50 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-sessions-sheet-title"
        className="w-full sm:max-w-2xl bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-overlay flex flex-col max-h-[85vh] sm:max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle (mobile) */}
        <div className="flex justify-center pt-3 sm:hidden">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>

        {/* Header */}
        <div className="px-4 pt-3 pb-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div id="import-sessions-sheet-title" className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              导入 CLI 会话
            </div>
            <div className="text-ui-lg text-ink">
              采纳{" "}
              <span className="mono text-ink-muted">~/.claude/projects/</span>
              中的会话
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="h-8 w-8 rounded border border-line flex items-center justify-center shrink-0 disabled:opacity-40"
            aria-label="刷新"
          >
            <RefreshCcw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded border border-line flex items-center justify-center shrink-0"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search + select-all */}
        <div className="px-4 pb-3 flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 h-10 px-3 rounded bg-paper border border-line">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              placeholder="按标题或路径筛选…"
              className="flex-1 bg-transparent outline-none text-[13px]"
            />
            <span className="caps text-ink-muted">
              {filtered.length} / {candidates.length}
            </span>
          </div>
          <button
            onClick={toggleAllFiltered}
            disabled={filtered.length === 0}
            className="h-10 px-3 rounded border border-line text-ui disabled:opacity-40"
          >
            {allFilteredSelected ? "清除" : "全选"}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto border-t border-line">
          {loading ? (
            <div className="text-ui text-ink-muted text-center py-10">
              正在扫描 ~/.claude/projects…
            </div>
          ) : error ? (
            <div className="text-ui text-red-600 text-center py-10 px-4">
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-ui text-ink-muted text-center py-10 px-4">
              {candidates.length === 0
                ? "未找到 CLI 会话（或都已被采纳）。"
                : `没有与“${query}”匹配的会话。`}
            </div>
          ) : (
            filtered.map((s) => {
              const isSelected = selected.has(s.sessionId);
              return (
                <button
                  key={s.sessionId}
                  onClick={() => toggle(s.sessionId)}
                  className={cn(
                    "w-full flex items-start gap-3 px-4 py-3 text-left border-b border-line hover:bg-paper/40 transition-colors",
                    isSelected && "bg-klein-wash/40",
                  )}
                >
                  <span
                    className={cn(
                      "h-5 w-5 rounded-sm border flex items-center justify-center shrink-0 mt-0.5",
                      isSelected
                        ? "bg-klein border-klein text-canvas"
                        : "bg-paper border-line",
                    )}
                  >
                    {isSelected && <Check className="w-3.5 h-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-ui-lg font-medium truncate">
                      {s.title}
                    </div>
                    <div className="text-ui text-ink-muted mono truncate flex items-center gap-1">
                      <FolderGit2 className="w-3 h-3 shrink-0" />
                      <span className="truncate">{s.cwd}</span>
                    </div>
                    <div className="text-ui text-ink-muted mt-0.5">
                      {s.lineCount} 行 · {formatBytes(s.fileSize)} ·{" "}
                      {timeAgoShort(s.lastModified)}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-line flex items-center gap-2">
          <div className="text-ui text-ink-muted">
            已选 {selected.size} 项
          </div>
          <button
            onClick={handleImport}
            disabled={selected.size === 0 || importing}
            className={cn(
              "ml-auto h-10 px-4 rounded text-ui font-medium",
              selected.size === 0 || importing
                ? "bg-paper text-ink-muted border border-line"
                : "bg-klein text-canvas",
            )}
          >
            {importing
              ? "正在导入…"
              : `导入所选${selected.size > 0 ? `（${selected.size}）` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
