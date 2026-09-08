import { useEffect, useMemo, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { Logo } from "@/components/Logo";
import { useSessions, type UIPiece } from "@/state/sessions";
import type { Session } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { useFocusReturn } from "@/hooks/useFocusReturn";

/**
 * Side-chat drawer (`/btw`).
 *
 * Semantics, matching the mockup s-11 contract:
 *   - Reads the parent's context (the server injects a transcript summary
 *     into the SDK on first spawn) but writes go only to this child
 *     session's own event log. The main thread stays clean.
 *   - Mobile: slides up from the bottom, covering the bottom ~55% of the
 *     viewport. The main thread's tail is still visible / blurred behind
 *     so the user remembers they didn't leave it.
 *   - Desktop: a right-side panel. The orange left border + "/btw" badge
 *     are the visual tell this is a lateral conversation.
 *
 * The drawer subscribes to its child session's WS stream like any normal
 * session. Closing the drawer leaves the session alive — re-opening `/btw`
 * from the same main thread returns the same child (server-side
 * idempotency). `onArchiveAndNew` lets the user throw away the current
 * side chat and start fresh.
 */
export function SideChatDrawer({
  parentSession,
  onClose,
}: {
  parentSession: Session;
  onClose: () => void;
}) {
  useFocusReturn();
  const {
    transcripts,
    ensureTranscript,
    subscribeSession,
    sendUserMessage,
  } = useSessions();

  // Child session lifecycle:
  //   null          → still resolving (GET .../side on mount)
  //   Session obj   → ready; we've subscribed & pulled its transcript
  //   "error"       → failed to resolve, surface to the user
  const [child, setChild] = useState<Session | null | "loading" | "error">(
    "loading",
  );
  const [errCode, setErrCode] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Resolve / create the child. GET first so we don't duplicate-create on
  // StrictMode re-mounts; POST idempotent fallback anyway.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await api.getSideSession(parentSession.id);
        if (cancelled) return;
        if (existing.session) {
          setChild(existing.session);
          return;
        }
        const created = await api.createSideSession(parentSession.id);
        if (cancelled) return;
        setChild(created.session);
      } catch (e) {
        if (cancelled) return;
        setErrCode(e instanceof ApiError ? e.code : "side_failed");
        setChild("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parentSession.id]);

  // Wire up WS / transcript once we have an id.
  const childId = typeof child === "object" && child ? child.id : null;
  useEffect(() => {
    if (!childId) return;
    ensureTranscript(childId);
    subscribeSession(childId);
  }, [childId, ensureTranscript, subscribeSession]);

  const pieces = childId ? transcripts[childId] ?? [] : [];

  useEffect(() => {
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: "smooth",
    });
  }, [pieces.length]);

  function send() {
    const content = text.trim();
    if (!content || !childId) return;
    sendUserMessage(childId, content);
    setText("");
    // Keep focus in the composer so the user can fire off follow-ups.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function archiveAndNew() {
    if (!childId) return;
    setBusy(true);
    try {
      await api.archiveSession(childId);
      const created = await api.createSideSession(parentSession.id);
      setChild(created.session);
    } catch (e) {
      setErrCode(e instanceof ApiError ? e.code : "archive_failed");
    } finally {
      setBusy(false);
    }
  }

  // Desktop vs mobile chrome share the same inner body; we swap the outer
  // shell via responsive classes.
  return (
    <div
      className="fixed inset-0 z-30 flex sm:items-stretch sm:justify-end"
      onClick={onClose}
    >
      {/* Backdrop — mobile: blurs the top half of the main thread so the
          user can see they haven't left it. Desktop: dim the left side. */}
      <div className="absolute inset-0 bg-ink/20 backdrop-blur-sm" />

      {/* Mobile: bottom drawer covering 60% of viewport. Desktop: right
          drawer full-height, capped at 420px. */}
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="侧边对话"
        className={cn(
          "relative flex flex-col bg-paper shadow-overlay",
          // mobile
          "w-full max-h-[65vh] min-h-[55vh] rounded-t-[20px] border-t-2 border-klein mt-auto",
          // desktop
          "sm:mt-0 sm:max-h-none sm:min-h-0 sm:h-full sm:w-[420px] sm:rounded-none sm:border-t-0 sm:border-l-2 sm:border-klein",
        )}
      >
        {/* Header — orange side-chat badge; read-only tell */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line bg-canvas sm:rounded-none rounded-t-[20px]">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-klein/30 bg-klein-wash text-klein-ink text-ui-sm font-medium uppercase tracking-widest">
            <span className="h-1.5 w-1.5 rounded-full bg-klein" />
            侧边对话 · /btw
          </span>
          <span className="mono text-ui text-ink-muted ml-auto truncate">
            读取主线程 · 不写回
          </span>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded-sm border border-line bg-canvas flex items-center justify-center hover:bg-paper transition-colors"
            aria-label="关闭侧边对话"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Transcript body */}
        <div
          ref={scroller}
          className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-ui"
        >
          {child === "loading" && (
            <div className="text-ui text-ink-muted mono">
              正在打开侧边对话…
            </div>
          )}
          {child === "error" && (
            <div className="text-ui text-danger bg-danger-wash/60 border border-danger/30 rounded px-3 py-2">
              无法打开侧边对话 — {errCode ?? "未知错误"}。
            </div>
          )}
          {typeof child === "object" && child && pieces.length === 0 && (
            <div className="text-ui text-ink-muted italic">
              请在侧边提出一个问题。Claude 可以读取主线程，
              但不会在此处对其采取行动。
            </div>
          )}
          {pieces.map((p, i) => (
            <SidePiece key={i} p={p} />
          ))}
        </div>

        {/* Composer — simpler than the main one: no @ / slash triggers
            because /btw is about quick lateral questions, not actions. */}
        <div className="px-3 pt-2 pb-3 border-t border-line bg-paper">
          <div className="rounded-lg border border-line bg-canvas p-2 flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="在侧边提出一个问题…"
              disabled={busy || typeof child !== "object" || !child}
              className="flex-1 bg-transparent outline-none text-ui-lg resize-none min-h-[20px] max-h-32 py-1 px-1"
            />
            <button
              onClick={send}
              disabled={!text.trim() || busy || typeof child !== "object" || !child}
              className="h-8 w-8 rounded-full bg-klein text-canvas flex items-center justify-center shadow-card disabled:opacity-40"
              aria-label="发送侧边消息"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-ui text-ink-muted">
              侧边对话不占用主线程
            </span>
            <button
              onClick={archiveAndNew}
              disabled={busy || typeof child !== "object" || !child}
              className="ml-auto h-7 px-2.5 text-ui text-ink-soft rounded-sm border border-line bg-canvas hover:bg-paper disabled:opacity-40 transition-colors"
              title="归档此侧边对话并新建一个"
            >
              归档并新建
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Lean renderer for side-chat transcript pieces. We deliberately render
 * tool calls / permission prompts as compact chips here — the side chat
 * is `plan` mode by default (read-only), so in the normal case the user
 * won't see any of those. If they do (e.g. the user flipped mode to
 * acceptEdits from the settings sheet), the chips make that visible.
 */
function SidePiece({ p }: { p: UIPiece }) {
  switch (p.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[88%] bg-ink text-canvas rounded-xl rounded-br-xs px-3 py-2 text-ui leading-[1.5]">
            {p.text}
          </div>
        </div>
      );
    case "assistant_text":
      return (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Logo className="w-3.5 h-3.5" />
            <span className="mono text-ui text-ink-muted">claude · 侧边</span>
          </div>
          <div className="leading-[1.55] whitespace-pre-wrap">{p.text}</div>
        </div>
      );
    case "thinking":
      return (
        <div className="text-ui text-ink-muted italic pl-3 border-l-2 border-line">
          {p.text}
        </div>
      );
    case "tool_use":
      return (
        <div className="mono text-ui text-ink-muted">
          · {p.name}
        </div>
      );
    case "tool_result":
      return (
        <div className="mono text-ui text-ink-muted truncate">
          → {p.content.slice(0, 120)}
          {p.content.length > 120 ? "…" : ""}
        </div>
      );
    case "permission_request":
      // In plan mode the server shouldn't surface these, but if mode was
      // flipped we at least tell the user their answer belongs in the main
      // chat (there's no permission UI in the drawer — keep it simple).
      return (
        <div className="text-ui text-warn">
          权限请求 — 请在主线程中作出答复
        </div>
      );
  }
}
