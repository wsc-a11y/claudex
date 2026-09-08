import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";

// ---------------------------------------------------------------------------
// Markdown renderer used for assistant text. GitHub-flavored (tables, task
// lists, strikethrough) via remark-gfm. No syntax highlighter — we style
// code blocks with Tailwind instead of pulling in 500 KB of Prism.
//
// Design contract mirrors mockup s-04 / s-07:
//   - body copy: 14.5px, leading-[1.6]
//   - headings: .display serif, stepped down by level
//   - inline code: mono, paper bg, thin border
//   - fenced code: mono, paper bg on soft-ink text, bordered, language tag
//     top-right — warm-white to match the rest of the publication-style UI
//   - blockquote: left rule + muted ink
//   - links: klein-ink underline; external opens in a new tab
//   - tables: collapsed borders, header row tinted
//
// We intentionally do NOT enable rehype-raw or any HTML passthrough. The
// default react-markdown renderer escapes embedded HTML, which is what we
// want — the assistant output is untrusted w.r.t. the DOM.
// ---------------------------------------------------------------------------

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown text-[12.5px] text-ink leading-[1.6] min-w-0 break-words [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="display text-[19px] leading-tight mt-4 mb-2 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="display text-[16px] leading-tight mt-4 mb-2 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="display text-[14.5px] leading-tight mt-3 mb-1.5 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="display text-[12.5px] leading-tight mt-3 mb-1.5 first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="font-medium text-ui mt-2 mb-1 first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="font-medium text-ui uppercase tracking-widest text-ink-muted mt-2 mb-1 first:mt-0">
      {children}
    </h6>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
  a: ({ href, children }) => {
    // External links open in a new tab so clicking a URL in the transcript
    // doesn't blow the user out of the chat screen. noopener/noreferrer is a
    // belt-and-braces move in case an attacker ever got content in here.
    const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        className="text-klein-ink underline underline-offset-2"
        {...(isExternal
          ? { target: "_blank", rel: "noopener noreferrer" }
          : null)}
      >
        {children}
      </a>
    );
  },
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-2 space-y-0.5 marker:text-ink-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-2 space-y-0.5 marker:text-ink-muted">
      {children}
    </ol>
  ),
  li: ({ children, className, ...rest }) => {
    // GFM task list items arrive with `className="task-list-item"` and a
    // leading input checkbox. We preserve that marker and disable the
    // checkbox so the rendered transcript is read-only.
    const isTask =
      typeof className === "string" && className.includes("task-list-item");
    return (
      <li
        className={cn(
          "leading-[1.55]",
          isTask && "list-none -ml-5 flex items-start gap-2",
          className,
        )}
        {...rest}
      >
        {children}
      </li>
    );
  },
  input: ({ type, checked, ...rest }) => {
    // Only <input type="checkbox"> appears inside GFM task list items — any
    // other input form markdown somehow rendered we ignore.
    if (type !== "checkbox") return null;
    return (
      <input
        type="checkbox"
        checked={!!checked}
        readOnly
        disabled
        className="mt-[3px] accent-klein"
        {...rest}
      />
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="pl-3 border-l-2 border-line-strong text-ink-muted my-2">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse border border-line text-ui">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-paper">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-line">{children}</tr>,
  th: ({ children, style }) => (
    <th
      className="border border-line px-2.5 py-1.5 text-left font-medium"
      style={style}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="border border-line px-2.5 py-1.5 align-top" style={style}>
      {children}
    </td>
  ),
  code: ({ className, children, ...rest }) => {
    // react-markdown sends `inline` on code nodes that live inline vs in a
    // pre. The v10 API dropped the `inline` prop, so we disambiguate two
    // ways: (1) a `language-xxx` class set by remark for fenced blocks with
    // a language tag, and (2) content containing a newline — fenced blocks
    // always carry at least a trailing `\n`, inline spans never do. Without
    // check (2), a fence opened with a bare ``` (no language) falls through
    // to the pill renderer, which then nests a bordered paper pill inside
    // the <pre> container — exactly the "code block contains inline code
    // blocks" look the user flagged.
    const isBlock =
      (typeof className === "string" && /language-/.test(className)) ||
      hasNewline(children);
    if (isBlock) {
      // Block code: reset any inherited pill styling so the inner <code>
      // inside the <pre> doesn't re-introduce a background / border. The
      // <pre> renderer owns the visual container.
      return (
        <code
          className={cn(
            className,
            "mono bg-transparent border-0 p-0 rounded-none text-inherit",
          )}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="mono text-[0.85em] bg-paper px-1 py-[1px] rounded-xs border border-line break-all [overflow-wrap:anywhere]"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    // Extract the language off the embedded <code className="language-xxx">
    // so we can render a tiny tag in the top-left corner. We deliberately
    // don't syntax-highlight — just present the source cleanly. The
    // top-right corner is reserved for a Copy button so users can grab the
    // block's raw text without fiddling with text selection on mobile.
    const lang = extractLang(children);
    return (
      <div className="relative group my-2">
        {lang && (
          <span className="absolute left-3 top-2 text-ui-sm uppercase tracking-[0.14em] text-ink-muted mono pointer-events-none z-10">
            {lang}
          </span>
        )}
        <pre className="mono text-ui bg-paper text-ink-soft border border-line rounded px-3 pt-8 pb-3 overflow-x-auto">
          {children}
        </pre>
        <button
          type="button"
          onClick={() => copyCode(extractText(children))}
          className={cn(
            "absolute top-1.5 right-1.5 h-6 px-1.5 rounded-xs border border-line bg-canvas text-ui-sm mono text-ink-muted inline-flex items-center gap-1",
            "opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity",
          )}
          aria-label="复制代码"
        >
          <Copy className="w-3 h-3" /> 复制
        </button>
      </div>
    );
  },
};

/**
 * Recursively check whether a React node's text content contains a newline.
 * Used by the `code` renderer to detect fenced code blocks that lack a
 * `language-xxx` class — they still contain at least a trailing `\n`,
 * whereas inline code spans never span a line.
 */
function hasNewline(node: React.ReactNode): boolean {
  if (typeof node === "string") return node.includes("\n");
  if (typeof node === "number") return false;
  if (Array.isArray(node)) return node.some(hasNewline);
  if (node && typeof node === "object" && "props" in node) {
    return hasNewline(
      (node as { props: { children?: React.ReactNode } }).props.children,
    );
  }
  return false;
}

/**
 * Flatten a React node tree down to its raw text content. Fenced code blocks
 * render as a single <code> whose children are usually a plain string, but
 * remark-gfm / plugin variations can wrap spans inside — so we recurse
 * defensively rather than assuming `children[0]` is a string.
 */
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText(
      (node as { props: { children?: React.ReactNode } }).props.children,
    );
  }
  return "";
}

/**
 * Copy a code block's raw text. Uses the shared copyText helper which
 * falls back to a hidden textarea + execCommand on non-secure contexts
 * (claudex is served over HTTP via frpc). Fails loudly with a toast —
 * matches the existing MessageActions "Copy failed" convention.
 */
function copyCode(text: string): void {
  void copyText(text).then((ok) => {
    toast(ok ? "已复制" : "复制失败");
  });
}

/**
 * Dig the `language-xxx` class off the inner <code> node of a <pre>. Falls
 * back to null if we can't tell — the renderer just skips the tag then.
 */
function extractLang(children: unknown): string | null {
  if (!children || typeof children !== "object") return null;
  // children is typically a single ReactElement — the <code> node.
  const maybe = children as {
    props?: { className?: string };
  };
  const cls = maybe.props?.className;
  if (typeof cls !== "string") return null;
  const m = cls.match(/language-([\w-]+)/);
  return m ? m[1] : null;
}
