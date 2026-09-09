// ---------------------------------------------------------------------------
// Per-message action row.
//
// Rendered as an absolutely-positioned overlay at the tail end of user /
// assistant_text / tool_result bubbles in Chat.tsx. Hidden by default —
// appears only when the parent bubble has been clicked/tapped (same
// trigger on desktop and mobile). Hover does NOT reveal the row: it was
// too easy to trip while scroll-past tracking across messages, so we
// require an intentional click. Because the row collapses to zero height
// when idle, consecutive messages keep a uniform gap regardless of
// whether the row is present.
//
// Parent owns a single `revealedSeq` and passes `revealed` down so only one
// bubble ever shows its row at a time.
//
// We intentionally don't ship this on tool_use / thinking / permission_request
// pieces — those aren't user-addressable content and the actions would be
// awkward (a tool_use chip is a summary, not a message; permission_request is
// interactive).
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, FileCode, GitFork, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { api, ApiError } from "@/api/client";
import { timeAgoShort } from "@/lib/format";
import { RewindSheet } from "./RewindSheet";

async function copy(text: string, successMsg = "已复制"): Promise<void> {
  // copyText handles the async Clipboard API with a hidden-textarea
  // execCommand fallback — claudex runs over HTTP (frpc tunnel) where the
  // async API is unavailable.
  const ok = await copyText(text);
  toast(ok ? successMsg : "复制失败");
}

export interface MessageActionsProps {
  /** Plain text to copy when the user clicks "Copy text". */
  text: string;
  /** Raw Markdown source. Only passed for assistant_text pieces — when present,
   * enables the "Copy as markdown" action. */
  markdown?: string;
  /** Permalink target — the session id + seq are used to build
   * `${origin}/session/${sessionId}#seq-${seq}`. When `seq` is undefined
   * (e.g. an optimistic echo not yet persisted) we still permalink to the
   * session, dropping the anchor. */
  sessionId: string;
  seq?: number;
  /** Align the chip row with the bubble. User bubbles are right-aligned,
   * assistant / tool_result bubbles are left-aligned. */
  align?: "start" | "end";
  /** Mobile reveal override. When true, the row is forced visible regardless
   * of hover state; this is how the Chat-level `revealedSeq` pokes through
   * the default `opacity-0` on touch devices. Desktop still uses hover — the
   * `md:` hover classes override this (see the class list below). */
  revealed?: boolean;
  /** Called after any action runs. Chat uses it to clear `revealedSeq` so
   * the chips auto-dismiss once the user picked something. */
  onActionComplete?: () => void;
  /** Optional message creation timestamp to render inline next to the
   * action icons. Default-hidden together with the icons; tap or
   * desktop hover reveals the whole row. */
  createdAt?: string | number | null;
  /** Optional extra leading element (e.g. an "can't edit" indicator on
   * user bubbles with attachments). Lives in the same row so the
   * reserved height covers it too. */
  leading?: React.ReactNode;
  /**
   * True on user-message bubbles — arms the "回滚到此" text action that
   * rewinds the session's tracked files to this message (CLI checkpoint
   * feature). Only user messages are valid rewind anchors.
   */
  rewindable?: boolean;
}

function buildPermalink(sessionId: string, seq?: number): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  const base = `${origin}/session/${sessionId}`;
  return seq != null ? `${base}#seq-${seq}` : base;
}

/** Icon-only square button. Flat (no border), sits on the metadata line —
 * we want these to read as a row of subtle affordances, not a button bank. */
function ActionIcon({
  icon: Icon,
  onClick,
  title,
  disabled,
}: {
  icon: typeof Copy;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop the click from bubbling up to the bubble wrapper's tap
        // handler — otherwise tapping would immediately toggle
        // `revealedSeq` back on, racing the `onActionComplete` clear.
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="h-6 w-6 rounded-sm flex items-center justify-center text-ink-faint hover:text-ink-soft hover:bg-paper disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}

export function MessageActions({
  text,
  markdown,
  sessionId,
  seq,
  align = "start",
  revealed = false,
  onActionComplete,
  createdAt,
  leading,
  rewindable = false,
}: MessageActionsProps): JSX.Element {
  const [forking, setForking] = useState(false);
  const [showRewind, setShowRewind] = useState(false);
  const navigate = useNavigate();
  // Track mount so an in-flight fork request can't setState after unmount
  // (e.g. user navigates away mid-request). React will warn, and more
  // importantly, a stale `forking=true` could leak into the next instance
  // if this component were ever kept alive across session switches.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const done = () => {
    onActionComplete?.();
  };

  const doCopyText = () => {
    void copy(text);
    done();
  };
  const doCopyMarkdown = () => {
    if (markdown == null) return;
    void copy(markdown);
    done();
  };
  const doCopyPermalink = () => {
    const url = buildPermalink(sessionId, seq);
    void copy(url, "已复制永久链接");
    done();
  };
  // Branch this session at `seq` into a new top-level session. The fork
  // copies every event with `seq <= this event.seq`, inherits project /
  // model / mode, and lands with a fresh SDK conversation — the assistant
  // has no memory of being forked. On success we navigate straight into
  // the new session so the user can keep going from the branch point.
  const doFork = async () => {
    if (forking || seq == null) return;
    setForking(true);
    try {
      const { session } = await api.forkSession(sessionId, { upToSeq: seq });
      toast("已分支到新会话");
      done();
      navigate(`/session/${session.id}`);
    } catch (err) {
      const code =
        err instanceof ApiError ? err.code : "fork_failed";
      toast(
        code === "archived"
          ? "无法从已归档会话创建分支"
          : "创建分支失败",
      );
      done();
    } finally {
      if (mounted.current) setForking(false);
    }
  };
  // Rewind this session's tracked files to the checkpoint taken before this
  // message. Only user messages are anchors — see RewindSheet for the
  // dryRun-preview → confirm flow.
  const openRewind = () => {
    if (seq == null) return;
    setShowRewind(true);
  };
  const closeRewind = () => {
    setShowRewind(false);
    done();
  };

  return (
    <div
      className={cn(
        // Always reserve a fixed-height row so revealing it on hover/tap
        // doesn't shift the surrounding transcript. Content fades in via
        // opacity rather than expanding height.
        "h-6 mt-1 flex items-center gap-1",
        "transition-opacity duration-150",
        // Mobile reveal: parent toggles `revealed` on tap. Desktop:
        // reveal on hover (parent supplies the `group` class) or
        // keyboard focus.
        revealed
          ? "opacity-100 pointer-events-auto"
          : "opacity-0 pointer-events-none",
        "md:group-hover:opacity-100 md:group-hover:pointer-events-auto",
        "md:focus-within:opacity-100 md:focus-within:pointer-events-auto",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {align === "end" && createdAt != null && (
        <span
          className="mono text-ui-sm text-ink-faint mr-1"
          title={new Date(createdAt).toLocaleString()}
        >
          {timeAgoShort(createdAt)}
        </span>
      )}
      {leading}
      <ActionIcon
        icon={Copy}
        title="复制文本"
        onClick={doCopyText}
      />
      {markdown != null && (
        <ActionIcon
          icon={FileCode}
          title="复制为 Markdown"
          onClick={doCopyMarkdown}
        />
      )}
      <ActionIcon
        icon={LinkIcon}
        title="复制永久链接"
        onClick={doCopyPermalink}
      />
      {align === "end" ? (
        // User bubbles: the fork/rewind affordances read as labeled text
        // buttons so the "branch here" / "roll code back here" verbs are
        // discoverable on mobile, where icon-only rows are easy to miss.
        seq != null ? (
          <span className="ml-auto flex items-center gap-1.5 pl-2">
            {rewindable && (
              <TextAction
                title="把代码回滚到这条消息时的状态（只回滚文件，对话保留）"
                onClick={openRewind}
              >
                回滚到此
              </TextAction>
            )}
            <TextAction
              title="从此处创建分支到新会话"
              disabled={forking}
              onClick={() => void doFork()}
            >
              {forking ? "分支中…" : "从此分支"}
            </TextAction>
          </span>
        ) : null
      ) : (
        <>
          {seq != null && (
            <ActionIcon
              icon={GitFork}
              title="从此处创建分支到新会话"
              onClick={() => void doFork()}
              disabled={forking}
            />
          )}
          {createdAt != null && (
            <span
              className="mono text-ui-sm text-ink-faint ml-1"
              title={new Date(createdAt).toLocaleString()}
            >
              {timeAgoShort(createdAt)}
            </span>
          )}
        </>
      )}
      {showRewind && seq != null && (
        <RewindSheet
          sessionId={sessionId}
          upToSeq={seq}
          onClose={closeRewind}
        />
      )}
    </div>
  );
}

/**
 * Small labeled action button for the revealed action row. Deliberately
 * quieter than a primary button — it lives in a hover/tap-revealed row.
 */
function TextAction({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        // Stop the click from bubbling to the bubble wrapper's tap handler
        // (same rationale as ActionIcon).
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      className="h-6 px-2 rounded-sm border border-line text-ui text-ink-soft hover:text-ink hover:bg-paper disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
    >
      {children}
    </button>
  );
}
