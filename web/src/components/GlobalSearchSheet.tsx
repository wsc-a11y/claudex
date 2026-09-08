import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { api } from "@/api/client";
import type {
  SearchMessageHit,
  SearchResponse,
  SearchTitleHit,
} from "@claudex/shared";
import { cn } from "@/lib/cn";
import { useFocusReturn } from "@/hooks/useFocusReturn";

// ---------------------------------------------------------------------------
// GlobalSearchSheet — full-text search over sessions + messages.
//
// Mobile: bottom sheet anchored to the viewport bottom. Desktop: centered
// overlay card (max-w-[640px]). Typing is debounced 250ms so each keystroke
// doesn't fire a request; the request is cancelled on unmount via a boolean
// flag (the fetch itself isn't AbortController-aware here — the outcome of
// a stale request is simply ignored).
//
// The server embeds `<mark>…</mark>` HTML into message snippets. We do NOT
// pipe that through dangerouslySetInnerHTML; instead, the small tokenizer
// `renderSnippet` below splits on those two literal tags and renders styled
// <span> elements for the matched runs. FTS5 never emits anything else
// inside a snippet, so this is safe and also means we stay on the good side
// of the dont-trust-server-HTML hygiene rule.
//
// Clicking a result navigates to `/session/<id>` — for messages we append
// `#seq-<eventSeq>`. Chat.tsx does not yet implement scroll-to-anchor
// (that's a future PR, out of lane); the hash does no harm today.
// ---------------------------------------------------------------------------

export interface GlobalSearchSheetProps {
  onClose: () => void;
}

export function GlobalSearchSheet({ onClose }: GlobalSearchSheetProps) {
  useFocusReturn();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the sheet's own input on mount — the composer's inline input
  // also exists but we want fresh focus so the user can just start typing.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes. Trapped at the document level so the sheet closes even
  // when focus is somewhere unexpected (e.g., the user clicked a result row
  // but didn't finish the navigation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced search. Clears results when the query is empty/whitespace so
  // the empty-state copy returns. `cancelled` guards against a stale
  // response clobbering a newer one if the user types faster than 250ms.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setData(null);
      setErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const res = await api.search(trimmed);
        if (cancelled) return;
        setData(res);
        setErr(null);
      } catch (e: any) {
        if (cancelled) return;
        // 400s on pathological sanitized-to-empty queries (e.g., typing only
        // punctuation). Treat as "no results" rather than a loud error so
        // the sheet keeps feeling responsive.
        if (e?.status === 400) {
          setData({ titleHits: [], messageHits: [] });
          setErr(null);
        } else {
          setErr("搜索失败,请重试。");
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  const hasResults =
    data !== null &&
    (data.titleHits.length > 0 || data.messageHits.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-start sm:justify-center bg-ink/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        className="w-full sm:max-w-[640px] sm:mt-[10vh] bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-overlay flex flex-col max-h-[80vh] sm:max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 h-12 px-4 border-b border-line">
          <Search className="w-4 h-4 text-ink-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话和消息…"
            className="flex-1 min-w-0 h-full bg-transparent outline-none text-ui-lg text-ink placeholder:text-ink-muted"
          />
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="shrink-0 h-8 w-8 rounded border border-line flex items-center justify-center text-ink-soft hover:bg-paper transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {loading && (
          <div className="px-4 py-2 mono text-ui text-ink-muted border-b border-line">
            搜索中…
          </div>
        )}
        {err && !loading && (
          <div className="px-4 py-3 text-ui text-danger bg-danger-wash border-b border-line">
            {err}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {query.trim().length === 0 ? (
            <EmptyHint />
          ) : !data || (!hasResults && !loading) ? (
            <NoMatches query={query.trim()} />
          ) : (
            <Results
              titleHits={data.titleHits}
              messageHits={data.messageHits}
              onPickSession={(id) => {
                navigate(`/session/${id}`);
                onClose();
              }}
              onPickMessage={(id, seq) => {
                navigate(`/session/${id}#seq-${seq}`);
                onClose();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="px-4 py-8 text-center text-ui text-ink-muted">
      输入内容以搜索你的会话和消息。
    </div>
  );
}

function NoMatches({ query }: { query: string }) {
  return (
    <div className="px-4 py-8 text-center text-ui text-ink-muted">
      没有与 <span className="mono">"{query}"</span> 匹配的结果。
    </div>
  );
}

function Results({
  titleHits,
  messageHits,
  onPickSession,
  onPickMessage,
}: {
  titleHits: SearchTitleHit[];
  messageHits: SearchMessageHit[];
  onPickSession: (sessionId: string) => void;
  onPickMessage: (sessionId: string, eventSeq: number) => void;
}) {
  return (
    <div className="divide-y divide-line">
      {titleHits.length > 0 && (
        <section>
          <SectionHeader label="会话" count={titleHits.length} />
          <ul className="divide-y divide-line">
            {titleHits.map((hit) => (
              <li key={`t-${hit.sessionId}`}>
                <button
                  type="button"
                  onClick={() => onPickSession(hit.sessionId)}
                  className="w-full text-left px-4 py-2.5 hover:bg-paper/60 focus:bg-paper/60 outline-none transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-ink-faint shrink-0" />
                    <div className="text-ui-lg font-medium truncate">
                      {hit.title || "未命名"}
                    </div>
                  </div>
                  {hit.snippet && hit.snippet.trim().length > 0 && (
                    <div className="mono text-ui text-ink-muted mt-0.5 truncate">
                      {renderSnippet(hit.snippet)}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {messageHits.length > 0 && (
        <section>
          <SectionHeader label="消息" count={messageHits.length} />
          <ul className="divide-y divide-line">
            {messageHits.map((hit) => (
              <li key={`m-${hit.sessionId}-${hit.eventSeq}`}>
                <button
                  type="button"
                  onClick={() => onPickMessage(hit.sessionId, hit.eventSeq)}
                  className="w-full text-left px-4 py-2.5 hover:bg-paper/60 focus:bg-paper/60 outline-none transition-colors"
                >
                  <div className="flex items-center gap-2 text-ui text-ink-muted">
                    <KindBadge kind={hit.kind} />
                    <span className="truncate flex-1">{hit.title || "未命名"}</span>
                    <span className="shrink-0 mono">{formatRel(hit.createdAt)}</span>
                  </div>
                  <div className="text-ui text-ink mt-1 leading-snug">
                    {renderSnippet(hit.snippet)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 px-4 py-1.5 bg-paper/80 backdrop-blur border-b border-line flex items-center gap-2">
      <span className="caps text-ink-muted">{label}</span>
      <span className="mono text-ui text-ink-faint">{count}</span>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const { label, tone } = useMemoKind(kind);
  return (
    <span
      className={cn(
        "inline-flex items-center h-4 px-1.5 rounded-xs text-ui-sm uppercase tracking-widest border shrink-0",
        tone,
      )}
    >
      {label}
    </span>
  );
}

function useMemoKind(kind: string): { label: string; tone: string } {
  return useMemo(() => {
    if (kind === "user_message")
      return {
        label: "用户",
        tone: "border-line bg-paper text-ink-soft",
      };
    if (kind === "assistant_text")
      return {
        label: "claude",
        tone: "border-klein/30 bg-klein-wash text-klein-ink",
      };
    if (kind === "assistant_thinking")
      return {
        label: "想法",
        tone: "border-line bg-canvas text-ink-muted",
      };
    return {
      label: kind,
      tone: "border-line bg-paper text-ink-muted",
    };
  }, [kind]);
}

/**
 * Render an FTS5 snippet string into React nodes without dangerouslySetInnerHTML.
 *
 * FTS5 only ever injects literal `<mark>` / `</mark>` pairs (we control the
 * open/close tags via our `snippet()` call on the server). We split on those
 * tokens and wrap the marked runs in a styled span. Angle-bracket content
 * that would otherwise be HTML-escaped by the browser simply renders as
 * text — React's JSX text nodes are already escaped, so this is safe.
 */
function renderSnippet(snippet: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remainder = snippet;
  let i = 0;
  while (remainder.length > 0) {
    const openIdx = remainder.indexOf("<mark>");
    if (openIdx === -1) {
      nodes.push(<span key={`s-${i++}`}>{remainder}</span>);
      break;
    }
    if (openIdx > 0) {
      nodes.push(
        <span key={`s-${i++}`}>{remainder.slice(0, openIdx)}</span>,
      );
    }
    const afterOpen = remainder.slice(openIdx + 6); // len("<mark>")
    const closeIdx = afterOpen.indexOf("</mark>");
    if (closeIdx === -1) {
      // Defensive: unbalanced tag. Render the rest as plain text.
      nodes.push(<span key={`s-${i++}`}>{afterOpen}</span>);
      break;
    }
    const marked = afterOpen.slice(0, closeIdx);
    nodes.push(
      <span
        key={`m-${i++}`}
        className="bg-klein-wash text-klein-ink rounded-xs px-0.5"
      >
        {marked}
      </span>,
    );
    remainder = afterOpen.slice(closeIdx + 7); // len("</mark>")
  }
  return nodes;
}

function formatRel(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diff < 10) return "刚刚";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}
