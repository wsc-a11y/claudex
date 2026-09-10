import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Check, ChevronLeft, GitFork, TriangleAlert, Undo2 } from "lucide-react";
import type { SessionUserMessage } from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { Logo } from "@/components/Logo";
import { RewindSheet } from "@/components/RewindSheet";
import { useSessions } from "@/state/sessions";
import { timeAgoShort } from "@/lib/format";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

// ---------------------------------------------------------------------------
// Rewind / fork picker (full-screen).
//
// Entered from the Chat header's "更多操作" menu. Lists every user message in
// the session as a single-select radio list; the bottom action bar then
// either:
//   · 回滚 — opens the existing RewindSheet, which dry-runs the CLI rewind
//     and asks for a second confirmation. Files only; transcript kept.
//   · 分支 — forks the session at that seq into a brand-new session and
//     navigates into it. The fork has no memory of what came after.
//
// Deliberately NOT a per-message affordance on the transcript anymore: the
// action row under each user bubble was easy to miss on mobile, and having
// both verbs side-by-side in one place makes their difference explicit.
// ---------------------------------------------------------------------------

export function RewindPickerScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Prefer the live title from the sessions store so a rename while we're
  // open doesn't leave a stale header.
  const liveTitle = useSessions((s) =>
    id ? s.sessions.find((x) => x.id === id)?.title : undefined,
  );

  const [messages, setMessages] = useState<SessionUserMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // The RewindSheet opens over this screen for the currently-selected seq.
  const [rewindSeq, setRewindSeq] = useState<number | null>(null);
  const [forking, setForking] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    api
      .listUserMessages(id)
      .then((r) => {
        setMessages(r.messages);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e?.message ?? e));
        setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!id) return null;

  const selected =
    selectedSeq != null
      ? messages?.find((m) => m.seq === selectedSeq) ?? null
      : null;

  const doFork = async () => {
    if (forking || selectedSeq == null) return;
    setForking(true);
    try {
      const { session } = await api.forkSession(id, { upToSeq: selectedSeq });
      toast("已分支到新会话");
      navigate(`/session/${session.id}`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "fork_failed";
      toast(
        code === "archived" ? "无法从已归档会话创建分支" : "创建分支失败",
      );
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-canvas">
      {/* Top bar — same skeleton as SessionDiffScreen. */}
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
            回滚 / 分支
          </div>
          <div className="mono text-ui text-ink-muted truncate">
            {selected
              ? `已选第 ${selected.seq} 条消息`
              : liveTitle
                ? `${liveTitle} · 选择一条用户消息`
                : "选择一条用户消息"}
          </div>
        </div>
        <Logo className="w-5 h-5 shrink-0 opacity-70" />
      </header>

      {/* Explainer — what the two verbs actually do. */}
      <div className="shrink-0 px-4 md:px-6 py-3 border-b border-line bg-paper/40">
        <div className="flex items-start gap-1.5 text-ui text-ink-muted leading-[1.5]">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-ink-faint" />
          <span>
            <span className="text-ink font-medium">回滚</span>
            只把代码文件恢复到那一刻,对话记录保留。
            <span className="text-ink font-medium"> 分支</span>
            从那一刻开一个新会话(claude 不记得之后的内容),不动代码。
          </span>
        </div>
      </div>

      {/* Message list — scrolls; the action bar below never gets pushed off. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-5 py-6 text-ui text-ink-muted">正在加载…</div>
        )}

        {!loading && error && (
          <div className="px-5 py-6 flex flex-col items-start gap-3">
            <div className="text-ui text-danger">无法加载用户消息:{error}</div>
            <button
              type="button"
              onClick={load}
              className="h-9 px-4 rounded border border-line text-ui text-ink-soft"
            >
              重试
            </button>
          </div>
        )}

        {!loading && !error && messages?.length === 0 && (
          <div className="px-5 py-6 text-ui text-ink-muted">
            这个会话还没有用户消息。
          </div>
        )}

        {!loading &&
          !error &&
          messages?.map((m) => {
            const isSelected = selectedSeq === m.seq;
            return (
              <button
                key={m.seq}
                type="button"
                onClick={() => setSelectedSeq(isSelected ? null : m.seq)}
                aria-pressed={isSelected}
                className={cn(
                  "w-full flex items-start gap-3 px-4 md:px-6 py-3 min-h-[44px] text-left border-b border-line/70 transition-colors",
                  isSelected ? "bg-klein-wash/40" : "active:bg-paper/60",
                )}
              >
                {/* Radio dot — doubles as the touch-target's selected affordance. */}
                <span
                  className={cn(
                    "mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center",
                    isSelected
                      ? "border-klein bg-klein text-canvas"
                      : "border-line-strong bg-canvas",
                  )}
                  aria-hidden
                >
                  {isSelected && <Check className="w-2.5 h-2.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-ui leading-snug line-clamp-3 break-words">
                    {m.text || <span className="text-ink-faint">（空消息）</span>}
                  </span>
                  <span className="mt-1 block mono text-ui-sm text-ink-faint">
                    #{m.seq} · {timeAgoShort(m.createdAt)}
                  </span>
                </span>
              </button>
            );
          })}
      </div>

      {/* Bottom action bar — fixed, safe-area aware. */}
      <div
        className="shrink-0 border-t border-line bg-canvas px-4 md:px-6 py-3 flex items-center gap-2"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          disabled={selectedSeq == null}
          onClick={() => selectedSeq != null && setRewindSeq(selectedSeq)}
          className={cn(
            "flex-1 h-11 rounded text-ui font-medium flex items-center justify-center gap-1.5 border transition-colors",
            selectedSeq == null
              ? "border-line text-ink-faint"
              : "border-line text-ink hover:bg-paper",
          )}
        >
          <Undo2 className="w-3.5 h-3.5" />
          回滚
        </button>
        <button
          type="button"
          disabled={selectedSeq == null || forking}
          onClick={() => void doFork()}
          className={cn(
            "flex-1 h-11 rounded text-ui font-medium flex items-center justify-center gap-1.5 transition-colors",
            selectedSeq == null || forking
              ? "bg-paper text-ink-faint border border-line"
              : "bg-klein text-canvas hover:opacity-90",
          )}
        >
          <GitFork className="w-3.5 h-3.5" />
          {forking ? "分支中…" : "分支"}
        </button>
      </div>

      {rewindSeq != null && (
        <RewindSheet
          sessionId={id}
          upToSeq={rewindSeq}
          onClose={() => setRewindSeq(null)}
        />
      )}
    </div>
  );
}
