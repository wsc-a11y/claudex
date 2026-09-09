import { useEffect, useRef, useState } from "react";
import { X, Undo2, FileWarning, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { api, ApiError } from "@/api/client";
import type { RewindSessionResult } from "@claudex/shared";
import { useFocusReturn } from "@/hooks/useFocusReturn";

/**
 * Rewind confirm sheet — surfaced from the per-message action row (tap a
 * user bubble → "回滚到此").
 *
 * Opens by dry-running `POST /api/sessions/:id/rewind` so the user sees
 * exactly which files would change (+insertions/-deletions) before anything
 * touches disk. Confirming fires the same request without `dryRun`.
 *
 * Semantics: this rolls FILES back to the CLI checkpoint taken before the
 * message at `upToSeq` — the conversation transcript keeps everything after
 * it (the CLI's own rewind behavior). To continue from a clean context, use
 * "从此分支" instead, which forks at the same point.
 */
export function RewindSheet({
  sessionId,
  upToSeq,
  onClose,
}: {
  sessionId: string;
  upToSeq: number;
  onClose: () => void;
}) {
  useFocusReturn();
  const [preview, setPreview] = useState<RewindSessionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const res = await api.rewindSession(sessionId, {
          upToSeq,
          dryRun: true,
        });
        if (!stale && mounted.current) setPreview(res);
      } catch (err) {
        if (!stale && mounted.current) {
          const code = err instanceof ApiError ? err.code : "";
          setError(friendlyError(code, err));
        }
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, upToSeq]);

  async function execute() {
    if (executing) return;
    setExecuting(true);
    try {
      const res = await api.rewindSession(sessionId, { upToSeq });
      if (!res.canRewind) {
        setError(res.error ?? "回滚不可用");
        setPreview(null);
        return;
      }
      const n = res.filesChanged?.length ?? 0;
      toast(`已回滚 ${n} 个文件`);
      onClose();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(friendlyError(code, err));
    } finally {
      if (mounted.current) setExecuting(false);
    }
  }

  return (
    <div
      // Matches the ImportSessionsSheet / sheet family: fixed overlay above
      // the MobileTabBar (z-40), bottom sheet on mobile, centered card ≥sm.
      className="fixed inset-0 z-40 bg-ink/50 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="回滚文件到此消息"
        className="w-full sm:max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-overlay flex flex-col max-h-[85vh] sm:max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle (mobile) */}
        <div className="flex justify-center pt-3 sm:hidden">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>

        {/* Header */}
        <div className="px-4 pt-3 pb-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              回滚文件
            </div>
            <div className="text-ui-lg text-ink">
              把代码恢复到这条消息时的状态
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={executing}
            className="h-8 w-8 rounded border border-line flex items-center justify-center shrink-0 disabled:opacity-40"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 pb-2">
          <div className="flex items-start gap-1.5 text-ui text-ink-muted">
            <Undo2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              只回滚文件改动,这条消息之后的对话记录保留。想从干净上下文继续,
              请用「从此分支」新建会话。
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 pb-2">
          {error ? (
            <div className="rounded-lg border border-red-600/30 bg-red-600/5 px-3 py-2.5 text-ui text-red-600">
              {error}
            </div>
          ) : preview === null ? (
            <div className="text-ui text-ink-muted text-center py-8">
              正在预览回滚影响…
            </div>
          ) : !preview.canRewind ? (
            <div className="rounded-lg border border-red-600/30 bg-red-600/5 px-3 py-2.5 text-ui text-red-600">
              {preview.error ?? "此会话没有可用的文件检查点。"}
              <div className="text-ink-muted mt-1">
                检查点只对开启文件快照后运行的会话生效(此功能上线前的老会话没有)。
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="rounded-lg border border-line bg-paper px-3 py-2 text-ui flex items-center gap-2">
                <FileWarning className="w-4 h-4 text-amber-600 shrink-0" />
                <span>
                  将修改{" "}
                  <span className="font-medium text-ink">
                    {(preview.filesChanged?.length ?? 0).toLocaleString()}
                  </span>{" "}
                  个文件 ·
                  新增 <span className="mono">{preview.insertions ?? 0}</span> 行 ·
                  删除 <span className="mono">{preview.deletions ?? 0}</span> 行
                </span>
              </div>
              {preview.filesChanged && preview.filesChanged.length > 0 ? (
                <div className="rounded-lg border border-line bg-paper divide-y divide-line overflow-hidden">
                  {preview.filesChanged.map((f) => (
                    <div
                      key={f}
                      className="px-3 py-2 text-ui mono text-ink-muted truncate"
                      title={f}
                    >
                      {f}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-line flex items-center gap-2">
          <button
            onClick={onClose}
            disabled={executing}
            className="h-10 px-4 rounded text-ui font-medium border border-line disabled:opacity-40"
          >
            取消
          </button>
          <button
            onClick={execute}
            disabled={
              executing ||
              preview === null ||
              !preview.canRewind ||
              error !== null
            }
            className={cn(
              "ml-auto h-10 px-4 rounded text-ui font-medium flex items-center gap-1.5",
              executing || preview === null || !preview.canRewind || error
                ? "bg-paper text-ink-muted border border-line"
                : "bg-red-600 text-white",
            )}
          >
            <Undo2 className="w-3.5 h-3.5" />
            {executing ? "正在回滚…" : "执行回滚"}
          </button>
        </div>
      </div>
    </div>
  );
}

function friendlyError(code: string, err: unknown): string {
  const message =
    err instanceof Error && err.message ? err.message : "请求失败";
  switch (code) {
    case "archived":
      return "已归档的会话不能回滚,先取消归档再试。";
    case "no_cli_session":
      return "这个会话还没建立过 CLI 会话(从未发过消息),没有可回滚的检查点。";
    case "not_a_user_message":
      return "目标不是一条用户消息,无法作为回滚点。";
    case "anchor_unresolved":
      return "无法把这条消息对应到 CLI 会话记录,回滚点解析失败。";
    case "rewind_failed":
      return "回滚执行失败,CLI 返回了错误。";
    default:
      return `${message}${code ? `（${code}）` : ""}`;
  }
}
