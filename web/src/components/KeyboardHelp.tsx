import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useFocusReturn } from "@/hooks/useFocusReturn";

/**
 * Global keyboard shortcut help overlay.
 *
 * Press `?` anywhere (except inside an input/textarea/select/contenteditable)
 * to open a centered modal listing every binding claudex actually wires
 * today. `?` or `Escape` while open closes it.
 *
 * Every row in this component was verified by grep against the codebase at
 * the time of writing — the point of this overlay is a source of truth for
 * what works, not a roadmap. If you add a real binding, add a row here too.
 * If you're tempted to add a row before the binding exists: don't. An
 * aspirational help sheet is worse than no help sheet because it teaches the
 * user something that isn't true.
 *
 * Mount once at the app root (see App.tsx). No props — state is entirely
 * local because only one overlay exists at a time and no other component
 * needs to know whether it's open.
 */

type Binding = {
  keys: string[][]; // [[key pill, key pill, ...], [alt combo...]] — alternatives separated by " / "
  description: string;
};

type Group = {
  title: string;
  bindings: Binding[];
};

// Detect the rough OS so we show ⌘ on Mac and Ctrl elsewhere. navigator.platform
// is deprecated but still the least-bad synchronous signal; userAgent is a
// fallback. We intentionally don't use navigator.userAgentData here (async,
// Chromium-only) — the cost of misdetection is a cosmetic inaccuracy on the
// help sheet, not a broken binding.
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const plat = (navigator.platform || "").toLowerCase();
  if (plat.includes("mac")) return true;
  const ua = (navigator.userAgent || "").toLowerCase();
  return ua.includes("mac os") || ua.includes("macintosh");
}

function buildGroups(mac: boolean): Group[] {
  const cmd = mac ? "⌘" : "Ctrl";
  return [
    {
      title: "全局",
      bindings: [
        { keys: [["?"]], description: "显示此帮助" },
        {
          keys: [[cmd, "K"]],
          description: "聚焦会话搜索 (首页,桌面端)",
        },
        { keys: [["Esc"]], description: "关闭弹层、面板和选择器" },
      ],
    },
    {
      title: "输入框 (聚焦时)",
      bindings: [
        { keys: [["Enter"]], description: "发送消息" },
        { keys: [["Shift", "Enter"]], description: "插入换行" },
        {
          keys: [["↑"], ["↓"]],
          description: "在 / 或 @ 选择器打开时移动选中项",
        },
        {
          keys: [["Enter"]],
          description: "插入高亮的选择器行",
        },
        { keys: [["Esc"]], description: "关闭 / 或 @ 选择器" },
        {
          keys: [["↑"]],
          description:
            "调出上一条提示 (光标开头或为空;按会话,最近 30 条)",
        },
        {
          keys: [["↓"]],
          description:
            "调出下一条提示 / 恢复草稿 (正在调用时,光标在末尾)",
        },
        {
          keys: [["Esc"]],
          description: "取消提示调用并恢复草稿",
        },
      ],
    },
  ];
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center h-5 px-1.5 rounded-xs border border-line-strong bg-paper text-ui-sm mono text-ink-soft">
      {children}
    </kbd>
  );
}

function KeyCombo({ combo }: { combo: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {combo.map((k, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 ? (
            <span className="text-ui-sm text-ink-faint mono">+</span>
          ) : null}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}

function KeyAlternatives({ alternatives }: { alternatives: string[][] }) {
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {alternatives.map((combo, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 ? (
            <span className="text-ui-sm text-ink-faint mono px-0.5">/</span>
          ) : null}
          <KeyCombo combo={combo} />
        </span>
      ))}
    </span>
  );
}

export function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  useFocusReturn(open);
  const mac = useMemo(() => isMac(), []);
  const groups = useMemo(() => buildGroups(mac), [mac]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Repeat events fire continuously while a key is held — ignore them
      // so holding `?` doesn't strobe the modal open/closed.
      if (e.repeat) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          // Typing into a field — don't hijack.
          return;
        }
      }

      if (e.key === "?") {
        // On most keyboard layouts `?` arrives as Shift+/; preventDefault
        // avoids the browser's quick-find feature (Firefox) stealing focus.
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (e.key === "Escape") {
        setOpen((prev) => (prev ? false : prev));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end md:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="键盘快捷键"
    >
      <button
        type="button"
        aria-label="关闭键盘帮助"
        className="absolute inset-0 bg-ink/20 backdrop-blur-[1px]"
        onClick={() => setOpen(false)}
      />
      <div className="relative w-full md:w-[520px] md:max-w-[92vw] max-h-[85vh] overflow-auto bg-canvas border border-line shadow-lift rounded-t-[14px] md:rounded-2xl">
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-line">
          <div>
            <div className="mono uppercase text-ui-sm tracking-[0.12em] text-ink-faint">
              快捷键
            </div>
            <div className="display text-ui-display text-ink leading-tight mt-0.5">
              键盘按键映射
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="关闭"
            className="h-7 w-7 -mt-1 -mr-1 inline-flex items-center justify-center rounded-sm text-ink-muted hover:text-ink hover:bg-paper transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-5">
          {groups.map((g) => (
            <section key={g.title}>
              <div className="mono uppercase text-ui-sm tracking-[0.12em] text-ink-faint mb-2">
                {g.title}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center">
                {g.bindings.map((b, i) => (
                  <ShortcutRow key={i} binding={b} />
                ))}
              </dl>
            </section>
          ))}
          <div className="pt-2 text-ui text-ink-faint">
            更多即将推出。需要什么就去 issues 里提一下。
          </div>
        </div>
      </div>
    </div>
  );
}

function ShortcutRow({ binding }: { binding: Binding }) {
  return (
    <>
      <dt className="flex items-center">
        <KeyAlternatives alternatives={binding.keys} />
      </dt>
      <dd className="text-ui text-ink-soft">{binding.description}</dd>
    </>
  );
}
