import { useEffect, useRef, useState } from "react";
import type { LinkPreview as LinkPreviewData } from "@claudex/shared";

// ---------------------------------------------------------------------------
// LinkPreview card.
//
// Renders a small OpenGraph-style card below a message bubble when the
// message body carries an http(s) URL. Matches the publication-style chrome
// of the chat surface — border-line / paper-bg, rounded 10px, 48×48 thumb on
// the right (when the upstream provided one).
//
// Deferred fetch: the server route is rate-limited at 60/hour per user and
// every preview runs a real upstream HTTP request, so we don't want an
// offscreen thread's worth of cards hammering it on mount. We wait for the
// card to enter the viewport via IntersectionObserver before kicking off
// `GET /api/link-preview?url=…`.
//
// Failure UX: if the URL is private / invalid / upstream 4xx the server
// returns a 4xx/5xx and we render nothing — no error card. Link previews
// are a nice-to-have; a broken one should not clutter the transcript.
// ---------------------------------------------------------------------------

interface Props {
  url: string;
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: LinkPreviewData }
  | { status: "error" };

export function LinkPreview({ url }: Props) {
  const [state, setState] = useState<State>({ status: "idle" });
  const rootRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // If the card is already in view on mount (common — most messages are
    // at the bottom of the transcript), fire immediately. Otherwise wait.
    let cancelled = false;
    const kickoff = () => {
      if (cancelled) return;
      if (state.status !== "idle") return;
      setState({ status: "loading" });
      const controller = new AbortController();
      fetch(
        `/api/link-preview?url=${encodeURIComponent(url)}`,
        {
          credentials: "same-origin",
          signal: controller.signal,
        },
      )
        .then(async (res) => {
          if (!res.ok) throw new Error(`http_${res.status}`);
          return (await res.json()) as LinkPreviewData;
        })
        .then((data) => {
          if (cancelled) return;
          setState({ status: "ready", data });
        })
        .catch(() => {
          if (cancelled) return;
          setState({ status: "error" });
        });
      return () => controller.abort();
    };

    if (typeof IntersectionObserver === "undefined") {
      kickoff();
      return () => {
        cancelled = true;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            kickoff();
            io.disconnect();
            return;
          }
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
    // Only URL identifies this preview; re-running when `state` changes
    // would loop. We intentionally read `state.status` via closure — the
    // guard inside `kickoff` handles re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Silent failure — don't pollute the thread with a broken card.
  if (state.status === "error") return null;

  // Skeleton while loading or before intersection fires. Matches the card
  // shape so the bubble height doesn't jump on resolve.
  if (state.status === "idle" || state.status === "loading") {
    return (
      <a
        ref={rootRef}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 block border border-line rounded-lg bg-paper/50 px-3 py-2 flex items-start gap-3 max-w-full hover:border-line-strong transition-colors"
      >
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="h-3 bg-line rounded w-2/3 animate-pulse" />
          <div className="h-2.5 bg-line/70 rounded w-full animate-pulse" />
          <div className="h-2.5 bg-line/70 rounded w-3/4 animate-pulse" />
        </div>
      </a>
    );
  }

  const { data } = state;
  // If the upstream had literally nothing — no title, no description, no
  // image, no site name — drop the card entirely. A card that just shows
  // the bare URL is worse than the link in the message body.
  if (!data.title && !data.description && !data.image && !data.siteName) {
    return null;
  }

  return (
    <a
      ref={rootRef}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 block border border-line rounded-lg bg-paper/50 px-3 py-2 flex items-start gap-3 max-w-full hover:border-line-strong transition-colors"
    >
      <div className="flex-1 min-w-0">
        {data.siteName && (
          <div className="mono text-ui text-ink-muted truncate">
            {data.siteName}
          </div>
        )}
        {data.title && (
          <div className="text-ui font-medium text-ink leading-snug truncate">
            {data.title}
          </div>
        )}
        {data.description && (
          <div className="text-ui text-ink-muted leading-snug mt-0.5 line-clamp-2 break-words">
            {data.description}
          </div>
        )}
      </div>
      {data.image && (
        <img
          src={data.image}
          alt=""
          className="h-12 w-12 shrink-0 object-cover rounded-sm bg-canvas"
          loading="lazy"
          onError={(e) => {
            // Hide the thumb slot if the image itself 404s — the card
            // still stands on title + description alone.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
    </a>
  );
}

/**
 * Regex-pluck the FIRST http(s) URL out of a raw text body. Returns null if
 * nothing matches. Used by message bubble renderers to decide whether to
 * render a <LinkPreview/> below the rendered markdown.
 *
 * Intentionally restrictive: we stop at whitespace, `)`, `>`, `"`, `'`, or
 * the end of the string. Common markdown shapes `[text](https://…)` and
 * `<https://…>` both land on the URL naturally.
 */
export function firstHttpUrl(source: string): string | null {
  const m = source.match(/\bhttps?:\/\/[^\s<>"')]+/i);
  if (!m) return null;
  // Trim trailing punctuation that's almost always sentence-level, not URL.
  let url = m[0];
  while (/[.,!?;:]$/.test(url)) {
    url = url.slice(0, -1);
  }
  return url || null;
}
