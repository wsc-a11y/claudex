import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Eye, EyeOff, Folder, Home, Pencil, X } from "lucide-react";
import { api, ApiError } from "@/api/client";
import type { BrowseEntry } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { isAbsolutePath } from "@/lib/path";

/**
 * Full-screen (mobile) / modal (desktop) directory picker. The server exposes
 * GET /api/browse which returns immediate children of a path; this component
 * walks the tree by issuing one request per directory the user drills into.
 *
 * The user picks a directory by tapping the top "Select this folder" button,
 * which returns the currently-displayed path (whatever `data.path` is).
 */
export function FolderPicker({
  initialPath,
  onPick,
  onClose,
}: {
  initialPath?: string;
  onPick: (absPath: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [data, setData] = useState<{
    path: string;
    parent: string | null;
    entries: BrowseEntry[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // Manual path entry. Mobile users with no way to drill through
  // `C:\Users\…` into another drive (e.g. `D:\Code`) rely on this to
  // jump laterally across the filesystem.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErr(null);
      try {
        // First render with no initial path → go to home.
        if (!path) {
          const home = await api.browseHome();
          if (cancelled) return;
          setPath(home.path);
          return;
        }
        const res = await api.browse(path);
        if (cancelled) return;
        setData(res);
      } catch (e: unknown) {
        if (cancelled) return;
        const code = e instanceof ApiError ? e.code : "error";
        setErr(errorMessage(code));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [path]);

  const visible = data
    ? data.entries.filter((e) => showHidden || !e.isHidden)
    : [];
  const hiddenCount = data
    ? data.entries.filter((e) => e.isHidden).length
    : 0;

  return (
    <div className="fixed inset-0 z-30 bg-ink/50 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-xl bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-lift flex flex-col max-h-[92vh] sm:max-h-[78vh]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <div className="min-w-0 flex-1">
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              选择文件夹
            </div>
            {editing ? (
              <form
                className="mt-1 flex items-stretch gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = draft.trim();
                  if (!input) return;
                  if (!isAbsolutePath(input)) {
                    setErr("not_absolute");
                    return;
                  }
                  setErr(null);
                  setEditing(false);
                  setPath(input);
                }}
              >
                <input
                  ref={editInputRef}
                  className="flex-1 min-w-0 h-8 px-2 bg-canvas border border-line rounded-sm mono text-ui text-ink outline-none focus:border-klein"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="输入绝对路径,如 /Users/you 或 D:\\Code"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label="输入绝对路径"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(false);
                    }
                  }}
                />
                <button
                  type="submit"
                  className="h-8 w-8 rounded-sm bg-ink text-canvas flex items-center justify-center shrink-0"
                  aria-label="前往路径"
                  title="前往"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(data?.path ?? path ?? "");
                  setEditing(true);
                  queueMicrotask(() => {
                    const el = editInputRef.current;
                    if (el) {
                      el.focus();
                      el.select();
                    }
                  });
                }}
                title="点击编辑 —— 粘贴或输入任意绝对路径(如 D:\\Code)"
                className="mt-0.5 w-full flex items-center gap-1.5 text-left group"
              >
                <span className="mono text-ui text-ink-soft truncate">
                  {data?.path ?? path ?? "…"}
                </span>
                <Pencil className="w-3 h-3 text-ink-faint group-hover:text-ink shrink-0" />
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded border border-line flex items-center justify-center shrink-0"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line overflow-x-auto">
          <ToolbarButton
            onClick={async () => {
              try {
                const home = await api.browseHome();
                setPath(home.path);
              } catch {
                /* ignore */
              }
            }}
            icon={<Home className="w-3.5 h-3.5" />}
            label="主目录"
          />
          {data?.parent ? (
            <ToolbarButton
              onClick={() => setPath(data.parent!)}
              icon={<ChevronRight className="w-3.5 h-3.5 rotate-180" />}
              label="上一级"
            />
          ) : (
            <ToolbarButton
              disabled
              icon={<ChevronRight className="w-3.5 h-3.5 rotate-180" />}
              label="上一级"
            />
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-line bg-paper text-ui text-ink-soft"
            >
              {showHidden ? (
                <EyeOff className="w-3.5 h-3.5" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
              {showHidden ? "隐藏文件" : `显示隐藏文件 (${hiddenCount})`}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && !data ? (
            <div className="text-ui text-ink-muted text-center py-10 mono">
              加载中…
            </div>
          ) : err ? (
            <div className="p-4">
              <div className="rounded border border-danger/30 bg-danger-wash text-danger-ink text-ui px-3 py-2">
                {err}
              </div>
              {data?.parent && (
                <button
                  onClick={() => setPath(data.parent!)}
                  className="mt-3 w-full h-10 rounded border border-line bg-canvas text-ui"
                >
                  返回上一级
                </button>
              )}
            </div>
          ) : visible.length === 0 ? (
            <div className="text-ui text-ink-muted text-center py-10">
              {data?.entries.length === 0
                ? "此文件夹为空。"
                : "没有可见条目。切换显示隐藏文件即可查看隐藏项。"}
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {visible.map((e) => (
                <li key={e.path}>
                  <button
                    disabled={!e.isDir}
                    onClick={() => e.isDir && setPath(e.path)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 text-left",
                      e.isDir
                        ? "hover:bg-paper/60 transition-colors"
                        : "opacity-50 cursor-not-allowed",
                    )}
                  >
                    <Folder
                      className={cn(
                        "w-4 h-4 shrink-0",
                        e.isDir ? "text-klein-ink" : "text-ink-faint",
                      )}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-ui-lg",
                        e.isHidden && "text-ink-muted",
                        !e.isDir && "mono text-ui",
                      )}
                    >
                      {e.name}
                    </span>
                    {e.isDir && (
                      <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer — the "confirm" action */}
        <div className="border-t border-line p-3 flex items-center gap-2 bg-canvas">
          <div className="text-ui text-ink-muted flex-1 truncate">
            点击文件夹进入,然后在下方确认选择。
          </div>
          <button
            onClick={() => data && onPick(data.path)}
            disabled={!data}
            className="h-10 px-4 rounded bg-ink text-canvas font-medium text-ui disabled:opacity-50"
          >
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  icon,
  label,
  disabled,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-line text-ui shrink-0",
        disabled
          ? "bg-paper/40 text-ink-faint cursor-not-allowed"
          : "bg-canvas text-ink-soft hover:bg-paper/60 transition-colors",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "not_absolute":
      return "路径必须是绝对路径。";
    case "not_found":
      return "此文件夹在主机上不存在。";
    case "not_a_directory":
      return "该路径是文件,不是文件夹。";
    case "permission_denied":
      return "权限被拒绝。服务器无法读取此文件夹。";
    default:
      return `无法列出此文件夹(${code})。`;
  }
}
