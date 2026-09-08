import { useEffect, useRef, useState } from "react";
import { Brain, GitBranch, Pin, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "@/api/client";
import { Markdown } from "@/components/Markdown";
import { formatBytes, timeAgoLong } from "@/lib/format";
import { useSessions } from "@/state/sessions";
import type {
  EffortLevel,
  MemoryResponse,
  ModelId,
  PermissionMode,
  Project,
  Session,
  ToolGrant,
} from "@claudex/shared";
import { effortSupportedOnModel } from "@claudex/shared";
import { useFocusReturn } from "@/hooks/useFocusReturn";
import { getAllModelEntries, getModelLabel } from "@/lib/pricing";
import { useAppSettings, useCustomModels } from "@/state/app-settings";

/**
 * Session settings sheet. Rebuilt to match mockup s-10.
 *
 * Mobile (<md): full-height bottom-sheet-ish right slide-over with a small
 * left-aligned X header and caps+display title.
 * Desktop (≥md): 380px right rail with the mockup's right-rail header
 * (caps+display on the left, X button on the right).
 *
 * Only ships sections we can back with real data today. Notable omissions
 * vs. the mockup (documented in docs/FEATURES.md):
 *  - Effort slider (we don't expose thinking.budget_tokens today)
 *  - Worktree "Relocate…" (no backend)
 *  - Workspace "Status · clean / N staged" (no git-status reader)
 *  - "Change with ⌘⇧M" helper text (no shortcut bound)
 *  - "Duplicate session" (no clone endpoint)
 */
export function SessionSettingsSheet({
  session,
  project,
  onClose,
  onUpdated,
  showThinking,
  onToggleThinking,
  variant = "overlay",
}: {
  session: Session;
  project?: Project | null;
  onClose: () => void;
  onUpdated: (next: Session) => void;
  showThinking?: boolean;
  onToggleThinking?: () => void;
  /**
   * `"overlay"` (default): fixed inset-0 scrim + right-aligned dialog.
   * Used as an on-demand slide-over — e.g. opened from the mobile More
   * sheet or the desktop ⋯ menu.
   *
   * `"rail"`: renders as a flex-sibling `<aside>` so the sheet can live
   * permanently in the chat right column (mockup s-10). Hidden below
   * `md:` since mobile has no persistent rail. The dismiss button still
   * calls `onClose`, but the parent decides what that means (hide the
   * rail, flip a pref, etc.). No backdrop, no `fixed` positioning.
   */
  variant?: "overlay" | "rail";
}) {
  useFocusReturn(variant !== "rail");
  const loadSettings = useAppSettings((s) => s.load);
  const customModels = useCustomModels();
  useEffect(() => { loadSettings(); }, [loadSettings]);
  const [model, setModel] = useState<ModelId>(session.model);
  const [mode, setMode] = useState<PermissionMode>(session.mode);
  const [effort, setEffort] = useState<EffortLevel>(session.effort);
  const [tags, setTags] = useState<string[]>(session.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [tagErr, setTagErr] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  // Two-step confirm for destructive delete. First click flips the button
  // to "Click again to confirm" and arms a 3s timeout that resets the
  // prompt. Second click actually calls DELETE. Ref-stored timer so the
  // timeout can be cleared on unmount or re-press.
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const forgetSession = useSessions((s) => s.forgetSession);

  const [grants, setGrants] = useState<ToolGrant[] | null>(null);
  const [grantsErr, setGrantsErr] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [memoryErr, setMemoryErr] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  // Force-idle escape hatch — visible only when the row has been stuck in
  // `running` / `error` for more than 2 minutes. See `stuck` computation
  // below for the guard.
  const [forcingIdle, setForcingIdle] = useState(false);

  // Re-hydrate editable state when the parent swaps a fresh session in.
  useEffect(() => {
    setModel(session.model);
    setMode(session.mode);
    setEffort(session.effort);
    setTags(session.tags ?? []);
    setTagDraft("");
    setTagErr(null);
  }, [session.id, session.model, session.mode, session.effort, session.tags]);

  // Escape closes the sheet — but only when it's an overlay. In rail
  // mode it's a permanent sibling of the chat column; Esc would yank it
  // shut behind the user's back while they're typing.
  useEffect(() => {
    if (variant === "rail") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, variant]);

  async function loadGrants() {
    setGrantsErr(null);
    try {
      const r = await api.listGrants(session.id);
      setGrants(r.grants);
    } catch (e) {
      setGrantsErr(e instanceof ApiError ? e.code : "load_failed");
      setGrants([]);
    }
  }

  useEffect(() => {
    loadGrants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Lazy-load the CLAUDE.md preview. We fetch on sheet mount rather than on
  // Chat mount because it's only needed once the user opens settings — and
  // the sheet itself only mounts when it's opened.
  useEffect(() => {
    let cancelled = false;
    setMemoryErr(null);
    setMemory(null);
    api
      .getProjectMemory(session.projectId)
      .then((r) => {
        if (!cancelled) setMemory(r);
      })
      .catch((e) => {
        if (cancelled) return;
        setMemoryErr(e instanceof ApiError ? e.code : "load_failed");
        setMemory({ files: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [session.projectId]);

  async function patch(partial: {
    model?: ModelId;
    mode?: PermissionMode;
    effort?: EffortLevel;
    tags?: string[];
    pinned?: boolean;
  }) {
    setSaving(true);
    setErr(null);
    try {
      const r = await api.updateSession(session.id, partial);
      onUpdated(r.session);
      setWarnings(r.warnings ?? []);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "update_failed");
    } finally {
      setSaving(false);
    }
  }

  // Normalize a user-typed tag candidate to the server-side schema
  // (`[a-z0-9-]{1,24}`). We strip rather than reject-with-error so hitting
  // Enter on "Backend Bug!" produces "backendbug" without a confusing dialog.
  // Empty string after normalization returns null → caller skips the add.
  function normalizeTag(raw: string): string | null {
    const cleaned = raw
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    return cleaned.length > 0 ? cleaned : null;
  }

  function addTagFromDraft() {
    if (archived || saving) return;
    const next = normalizeTag(tagDraft);
    if (!next) {
      setTagDraft("");
      return;
    }
    if (tags.includes(next)) {
      setTagDraft("");
      setTagErr(null);
      return;
    }
    if (tags.length >= 8) {
      setTagErr("最多 8 个标签");
      return;
    }
    const nextTags = [...tags, next];
    setTags(nextTags);
    setTagDraft("");
    setTagErr(null);
    patch({ tags: nextTags });
  }

  function removeTag(t: string) {
    if (archived || saving) return;
    const nextTags = tags.filter((x) => x !== t);
    setTags(nextTags);
    setTagErr(null);
    patch({ tags: nextTags });
  }

  async function revoke(id: string) {
    try {
      await api.revokeGrant(id);
      setGrants((prev) => (prev ?? []).filter((g) => g.id !== id));
    } catch (e) {
      setGrantsErr(e instanceof ApiError ? e.code : "revoke_failed");
    }
  }

  async function archive() {
    if (archived || archiving) return;
    setArchiving(true);
    setErr(null);
    try {
      await api.archiveSession(session.id);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "archive_failed");
      setArchiving(false);
    }
  }

  // Clean up any dangling confirm timer on unmount so it can't fire after
  // the sheet (or the whole session) is gone.
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) {
        clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
    };
  }, []);

  async function handleDelete() {
    if (deleting) return;
    if (!deleteConfirming) {
      setDeleteConfirming(true);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(() => {
        setDeleteConfirming(false);
        deleteTimerRef.current = null;
      }, 3000);
      return;
    }
    // Second click within 3s — do the thing.
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    setDeleting(true);
    setErr(null);
    try {
      await api.deleteSession(session.id);
      forgetSession(session.id);
      // Close the sheet first so the parent route doesn't try to re-render
      // a session that no longer exists before we navigate away.
      onClose();
      navigate("/sessions");
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "delete_failed");
      setDeleting(false);
      setDeleteConfirming(false);
    }
  }

  // Close the export menu on outside-click. Kept local to the sheet — a full
  // menu primitive is overkill for a 2-item popover.
  useEffect(() => {
    if (!exportOpen) return;
    function onDocClick(e: MouseEvent) {
      if (
        exportMenuRef.current &&
        !exportMenuRef.current.contains(e.target as Node)
      ) {
        setExportOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [exportOpen]);

  function runExport(format: "md" | "json") {
    setExportOpen(false);
    api.exportSession(session.id, format);
  }

  // "Stuck" heuristic for the force-idle link: the session looks active
  // (`running` / `error`) but nothing has touched it in > 2 minutes. On-boot
  // sweep + live watchdog normally catch this, but a freshly-restarted
  // server with rows that were previously active can leave them stranded
  // until the first new event arrives. Give the user an explicit way out.
  const ageMs = (() => {
    const anchor = session.lastMessageAt ?? session.updatedAt;
    if (!anchor) return 0;
    const t = Date.parse(anchor);
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0;
  })();
  const looksStuck =
    (session.status === "running" || session.status === "error") &&
    ageMs > 2 * 60 * 1000;

  async function handleForceIdle() {
    if (forcingIdle) return;
    setForcingIdle(true);
    setErr(null);
    try {
      const r = await api.forceIdleSession(session.id);
      onUpdated(r.session);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "force_idle_failed");
      setForcingIdle(false);
    }
  }

  const archived = session.status === "archived";
  const hasWorktree = !!session.worktreePath;
  const archiveLabel = hasWorktree
    ? "归档会话并移除工作树"
    : "归档";

  const allEntries = getAllModelEntries(customModels);
  const MODELS: Array<{ id: string; label: string; sub: string; subDesktop: string }> = allEntries.map((m) => {
    const builtin = m.id === "claude-opus-4-8"
      ? { sub: "最新版", subDesktop: "最新版 · 自适应" }
      : m.id === "claude-opus-4-7"
        ? { sub: "上一版", subDesktop: "上一代" }
        : m.id === "claude-sonnet-4-6"
          ? { sub: "均衡", subDesktop: "均衡" }
          : m.id === "claude-haiku-4-5"
            ? { sub: "快速", subDesktop: "快速" }
            : { sub: "自定义", subDesktop: "自定义" };
    return { id: m.id, label: m.label, ...builtin };
  });

  const MODES: Array<[PermissionMode, string]> = [
    ["default", "询问"],
    ["acceptEdits", "接受"],
    ["plan", "计划"],
    ["auto", "自动"],
    ["bypassPermissions", "绕过"],
  ];

  const modeHint: Record<PermissionMode, string> = {
    default: "Claude 在每次修改或执行命令前都会询问。",
    acceptEdits: "自动接受文件编辑与安全的文件系统操作。",
    plan: "只读探索。Claude 不会编辑文件。",
    auto: "自主模式 —— 在服务端分类器上线前,自动模式会回退为询问。",
    bypassPermissions: "不再弹出任何提示。仅在沙箱环境中使用。",
  };

  const EFFORTS: Array<[EffortLevel, string]> = [
    ["low", "低"],
    ["medium", "中"],
    ["high", "高"],
    ["xhigh", "极高"],
    ["max", "最大"],
  ];
  const effortHint: Record<EffortLevel, string> = {
    low: "最少的思考 —— 响应最快。",
    medium: "中等思考(claudex 默认)。",
    high: "深度推理 —— 更慢但更彻底。",
    xhigh: "比高更深(仅 Opus 4.7;其余情况自动回退)。",
    max: "最高强度 —— 仅支持 Opus 4.6 / 4.7。",
  };

  return (
    <div
      className={
        variant === "rail"
          ? // Rail mode — inline flex sibling to <main>. `hidden md:flex`
            // keeps mobile on the overlay-only path.
            "hidden md:flex shrink-0 border-l border-line bg-canvas"
          : "fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm flex justify-end"
      }
      onMouseDown={
        variant === "rail"
          ? undefined
          : (e) => {
              if (e.target === e.currentTarget) onClose();
            }
      }
    >
      <div
        role={variant === "rail" ? undefined : "dialog"}
        aria-modal={variant === "rail" ? undefined : true}
        aria-label="会话设置"
        className={
          variant === "rail"
            ? "w-[380px] bg-canvas flex flex-col min-h-0 h-full"
            : "w-full md:w-[380px] bg-canvas md:border-l border-line shadow-overlay flex flex-col max-h-screen h-full"
        }
      >
        {/* Mobile header: X on the left, caps+display stacked. */}
        <div className="md:hidden px-4 py-2.5 border-b border-line flex items-center gap-2">
          <button
            onClick={onClose}
            className="h-8 w-8 rounded bg-paper border border-line flex items-center justify-center"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              会话
            </div>
            <div className="display text-ui-title leading-tight">设置</div>
          </div>
        </div>

        {/* Desktop header: caps+display on the left, X on the right. */}
        <div className="hidden md:flex px-5 py-3 border-b border-line items-center">
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              设置
            </div>
            <div className="display text-ui-title leading-tight mt-0.5">
              本会话
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded border border-line hover:bg-paper flex items-center justify-center transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-5 space-y-5 md:space-y-6">
          {archived && (
            <div className="text-ui text-ink-muted rounded border border-dashed border-line-strong bg-paper/50 px-3 py-2">
              此会话已归档 —— 设置为只读。
            </div>
          )}

          {/* Pinned — bumps this session to the top of Home's list regardless
              of activity recency. Single-toggle row so it's hard to miss and
              easy to reverse; PATCH round-trips through the shared `patch()`
              helper so the parent sees the new Session DTO immediately. */}
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              置顶
            </div>
            <button
              type="button"
              disabled={archived || saving}
              onClick={() => patch({ pinned: !session.pinned })}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded border text-left disabled:opacity-60 ${
                session.pinned
                  ? "border-klein/40 bg-klein-wash/40"
                  : "border-line bg-canvas hover:bg-paper/40 transition-colors"
              }`}
              aria-pressed={session.pinned}
            >
              <Pin
                className={`w-4 h-4 shrink-0 ${
                  session.pinned ? "text-klein-ink" : "text-ink-muted"
                }`}
              />
              <span className="text-ui font-medium flex-1">
                {session.pinned ? "已置顶" : "置顶此会话"}
              </span>
              <span
                className={`shrink-0 inline-flex h-5 w-9 rounded-full border transition-colors ${
                  session.pinned
                    ? "bg-klein border-klein"
                    : "bg-paper border-line"
                }`}
              >
                <span
                  className={`h-4 w-4 rounded-full bg-canvas border border-line shadow-sm m-[1px] transition-transform ${
                    session.pinned ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </span>
            </button>
            <div className="mt-1.5 text-ui text-ink-muted">
              置顶的会话不依据最近活跃与否,始终排在主页最前。
            </div>
          </div>

          {/* Model */}
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              模型
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-paper border border-line rounded">
              {MODELS.map((m) => {
                const active = model === m.id;
                return (
                  <button
                    key={m.id}
                    disabled={archived || saving}
                    onClick={() => {
                      setModel(m.id);
                      if (m.id !== session.model) patch({ model: m.id });
                    }}
                    className={`h-10 md:h-11 rounded-sm text-ui md:text-ui font-medium leading-tight transition-colors ${
                      active
                        ? "bg-canvas shadow-card border border-line text-ink"
                        : "text-ink-muted"
                    }`}
                  >
                    <div>{m.label}</div>
                    <div
                      className={`text-ui-sm ${
                        active ? "text-ink-muted" : "opacity-70"
                      }`}
                    >
                      <span className="md:hidden">{m.sub}</span>
                      <span className="hidden md:inline">{m.subDesktop}</span>
                    </div>
                  </button>
                );
              })}
            </div>
            {warnings.includes("model_change_applies_to_next_turn") && (
              <div className="mt-2 text-ui text-warn-ink bg-warn-wash/60 border border-warn/30 rounded-sm px-2.5 py-1.5">
                模型变更自下一轮生效 —— 正在进行的这一轮仍使用之前的模型。
              </div>
            )}
          </div>

          {/* Permission mode — 5-segment on desktop. At 390px the five labels
              (Ask / Accept / Plan / Auto / Bypass) can't fit side-by-side, so
              mobile renders as a vertical stack of clickable rows with a short
              description to the right and a checkmark on the active row. */}
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              权限模式
            </div>
            {/* Mobile: stacked list of rows */}
            <div className="md:hidden rounded border border-line bg-canvas overflow-hidden divide-y divide-line">
              {MODES.map(([id, label]) => {
                const active = mode === id;
                const dim = id === "bypassPermissions" && !active;
                return (
                  <button
                    key={id}
                    disabled={archived || saving}
                    onClick={() => {
                      setMode(id);
                      if (id !== session.mode) patch({ mode: id });
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left disabled:opacity-60 ${
                      active ? "bg-paper/60" : "hover:bg-paper/40 transition-colors"
                    } ${dim ? "opacity-60" : ""}`}
                  >
                    <span
                      className={`shrink-0 h-4 w-4 rounded-full border flex items-center justify-center ${
                        active
                          ? "bg-ink border-ink"
                          : "border-line bg-canvas"
                      }`}
                    >
                      {active && (
                        <span className="h-1.5 w-1.5 rounded-full bg-canvas" />
                      )}
                    </span>
                    <span className="text-ui font-medium w-14 shrink-0">
                      {label}
                    </span>
                    <span className="text-ui text-ink-muted flex-1 min-w-0">
                      {modeHint[id]}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Desktop: 5-segment control */}
            <div className="hidden md:grid grid-cols-5 gap-1.5 p-1 bg-paper border border-line rounded">
              {MODES.map(([id, label]) => {
                const active = mode === id;
                const dim = id === "bypassPermissions" && !active;
                return (
                  <button
                    key={id}
                    disabled={archived || saving}
                    onClick={() => {
                      setMode(id);
                      if (id !== session.mode) patch({ mode: id });
                    }}
                    className={`h-9 rounded-sm text-ui font-medium ${
                      active
                        ? "bg-canvas shadow-card border border-line text-ink"
                        : "text-ink-muted"
                    } ${dim ? "opacity-60" : ""}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="hidden md:block text-ui text-ink-muted mt-2">
              {modeHint[mode]}
            </div>
          </div>

          {/* Thinking effort — 5-segment on desktop, stacked rows on mobile.
              Mirrors the Permission mode block so the two configs read as
              siblings. Effort takes effect on the NEXT SDK turn — the
              server emits `effort_change_applies_to_next_turn` when a
              runner is currently mid-turn and we surface that warning. */}
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              思考强度
            </div>
            {/* Mobile: stacked list of rows */}
            <div className="md:hidden rounded border border-line bg-canvas overflow-hidden divide-y divide-line">
              {EFFORTS.map(([id, label]) => {
                const active = effort === id;
                const supported = effortSupportedOnModel(model, id);
                return (
                  <button
                    key={id}
                    disabled={archived || saving || !supported}
                    title={
                      supported
                        ? undefined
                        : "极高强度仅在 Opus 4.7 上可用。"
                    }
                    onClick={() => {
                      setEffort(id);
                      if (id !== session.effort) patch({ effort: id });
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left disabled:opacity-60 ${
                      active ? "bg-paper/60" : "hover:bg-paper/40 transition-colors"
                    }`}
                  >
                    <span
                      className={`shrink-0 h-4 w-4 rounded-full border flex items-center justify-center ${
                        active
                          ? "bg-ink border-ink"
                          : "border-line bg-canvas"
                      }`}
                    >
                      {active && (
                        <span className="h-1.5 w-1.5 rounded-full bg-canvas" />
                      )}
                    </span>
                    <span className="text-ui font-medium w-14 shrink-0">
                      {label}
                    </span>
                    <span className="text-ui text-ink-muted flex-1 min-w-0">
                      {effortHint[id]}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Desktop: 5-segment control */}
            <div className="hidden md:grid grid-cols-5 gap-1.5 p-1 bg-paper border border-line rounded">
              {EFFORTS.map(([id, label]) => {
                const active = effort === id;
                const supported = effortSupportedOnModel(model, id);
                return (
                  <button
                    key={id}
                    disabled={archived || saving || !supported}
                    title={
                      supported
                        ? undefined
                        : "极高强度仅在 Opus 4.7 上可用。"
                    }
                    onClick={() => {
                      setEffort(id);
                      if (id !== session.effort) patch({ effort: id });
                    }}
                    className={`h-9 rounded-sm text-ui font-medium disabled:cursor-not-allowed ${
                      active
                        ? "bg-canvas shadow-card border border-line text-ink"
                        : "text-ink-muted"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="hidden md:block text-ui text-ink-muted mt-2">
              {effortHint[effort]}
            </div>
            {warnings.includes("effort_change_applies_to_next_turn") && (
              <div className="mt-2 text-ui text-warn-ink bg-warn-wash/60 border border-warn/30 rounded-sm px-2.5 py-1.5">
                思考强度变更自下一轮生效 —— 正在进行的这一轮仍沿用之前的预算。
              </div>
            )}
          </div>

          {showThinking !== undefined && onToggleThinking && (
            <div>
              <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
                显示
              </div>
              <div className="rounded border border-line bg-canvas overflow-hidden">
                <button
                  type="button"
                  onClick={onToggleThinking}
                  disabled={archived}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left disabled:opacity-60 hover:bg-paper/40 transition-colors"
                >
                  <Brain className={`w-4 h-4 ${showThinking ? "text-klein" : "text-ink-soft"}`} />
                  <span className="text-ui font-medium flex-1">
                    显示思考过程
                  </span>
                  <span
                    className={`h-5 w-9 rounded-full relative transition-colors ${
                      showThinking ? "bg-klein" : "bg-line"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-canvas shadow transition-transform ${
                        showThinking ? "translate-x-[18px]" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* Workspace — read-only. Branch + worktree (or project root). */}
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              工作区
            </div>
            <div className="rounded border border-line bg-canvas p-4 space-y-2.5 text-ui">
              <div className="flex items-baseline gap-3">
                <span className="text-ui uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  分支
                </span>
                <span className="mono text-ui truncate flex items-center gap-1.5 min-w-0">
                  <GitBranch className="w-3 h-3 text-ink-muted shrink-0" />
                  <span className="truncate">
                    {session.branch ?? (
                      <span className="text-ink-faint">无</span>
                    )}
                  </span>
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-ui uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  工作树
                </span>
                <span className="mono text-ui truncate min-w-0">
                  {session.worktreePath ?? (
                    project?.path ? (
                      <span className="text-ink-muted">{project.path}</span>
                    ) : (
                      <span className="text-ink-faint">项目根目录</span>
                    )
                  )}
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-ui uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  创建时间
                </span>
                <span
                  className="mono text-ui text-ink-soft truncate min-w-0"
                  title={new Date(session.createdAt).toLocaleString()}
                >
                  {timeAgoLong(session.createdAt)}
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-ui uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  最近活跃
                </span>
                <span
                  className="mono text-ui text-ink-soft truncate min-w-0"
                  title={new Date(
                    session.lastMessageAt ?? session.updatedAt,
                  ).toLocaleString()}
                >
                  {timeAgoLong(session.lastMessageAt ?? session.updatedAt)}
                </span>
              </div>
            </div>
          </div>

          {/* Memory — read-only CLAUDE.md preview. Shows up to two files:
              the project-scoped CLAUDE.md (first match of `<project>/CLAUDE.md`
              or `<project>/.claude/CLAUDE.md`) and the user-global
              `~/.claude/CLAUDE.md`. Content is capped at 64 KB server-side;
              larger files are truncated with a flag. Fetched on sheet mount
              — not at Chat mount — so we only pay for it when the user
              actually opens settings. */}
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              记忆
            </div>
            <div className="rounded border border-line bg-canvas overflow-hidden">
              {memory === null ? (
                <div className="px-4 py-3 text-ui text-ink-muted">
                  正在读取记忆…
                </div>
              ) : memory.files.length === 0 ? (
                <div className="px-4 py-3 text-ui text-ink-muted">
                  未找到 CLAUDE.md。
                  {project?.path ? (
                    <>
                      {" "}
                      请在 <span className="mono">{project.path}/CLAUDE.md</span> 创建一份。
                    </>
                  ) : null}
                </div>
              ) : (
                memory.files.map((f) => {
                  const homeDir = deriveHomeDir(memory);
                  return (
                    <div
                      key={f.path}
                      className="border-b border-line last:border-b-0"
                    >
                      <div className="flex items-center gap-2 px-4 py-2 bg-paper/50">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-line bg-canvas text-ui-sm font-medium uppercase tracking-widest">
                          {memScopeLabel(f.scope)}
                        </span>
                        <span className="mono text-ui text-ink-muted truncate flex-1">
                          {shortenPath(f.path, homeDir)}
                        </span>
                        <span className="mono text-ui text-ink-faint">
                          {formatBytes(f.bytes)}
                          {f.truncated ? " · 已截断" : ""}
                        </span>
                      </div>
                      <div className="max-h-[240px] overflow-y-auto px-4 py-3">
                        <Markdown source={f.content} />
                      </div>
                    </div>
                  );
                })
              )}
              {memoryErr && memory !== null && memory.files.length === 0 && (
                <div className="px-4 py-2 text-ui text-danger border-t border-line">
                  {memoryErr}
                </div>
              )}
            </div>
          </div>

          {/* Tags — user-authored labels for filtering sessions from Home.
              Validation mirrors the server: lowercase `[a-z0-9-]{1,24}`,
              max 8 tags. `normalizeTag` scrubs user input before send so
              typing "Backend Bug!" + Enter commits "backendbug" instead of
              surfacing a validation error. The delete-pill X removes an
              entry with a PATCH round-trip. */}
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              标签
            </div>
            <div className="rounded border border-line bg-canvas p-3">
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 px-2 h-7 rounded-full border border-line bg-paper text-ui"
                  >
                    {t}
                    <button
                      type="button"
                      onClick={() => removeTag(t)}
                      disabled={archived || saving}
                      aria-label={`移除标签 ${t}`}
                      className="text-ink-muted hover:text-ink disabled:opacity-50 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <input
                  value={tagDraft}
                  onChange={(e) => {
                    setTagDraft(e.target.value);
                    if (tagErr) setTagErr(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTagFromDraft();
                    } else if (
                      e.key === "Backspace" &&
                      tagDraft === "" &&
                      tags.length > 0
                    ) {
                      // Empty-backspace removes the last chip — matches how
                      // most tag inputs behave and lets mobile users trim
                      // without aiming at the tiny X button.
                      e.preventDefault();
                      removeTag(tags[tags.length - 1]);
                    }
                  }}
                  onBlur={() => {
                    if (tagDraft.trim().length > 0) addTagFromDraft();
                  }}
                  disabled={archived || saving || tags.length >= 8}
                  placeholder={tags.length >= 8 ? "最多 8 个标签" : "+ 添加"}
                  className="flex-1 min-w-[120px] h-7 px-2 text-ui bg-transparent outline-none disabled:cursor-not-allowed"
                />
              </div>
              {tagErr && (
                <div className="mt-2 text-ui text-danger">{tagErr}</div>
              )}
              <div className="mt-2 text-ui text-ink-muted">
                仅限小写字母、数字和连字符,最多 8 个标签。
              </div>
            </div>
          </div>

          {/* Approved in this session */}
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              本会话内已授权
            </div>
            <div className="rounded border border-line bg-canvas p-3 space-y-2 text-ui">
              {grants === null ? (
                <div className="text-ui text-ink-muted mono">加载中…</div>
              ) : grants.length === 0 ? (
                <div className="text-ui text-ink-muted">
                  尚无工具获得授权。在权限提示中选择"始终允许"后,会记录在这里。
                </div>
              ) : (
                grants.map((g) => (
                  <div key={g.id} className="flex items-center gap-2">
                    <span
                      className={`shrink-0 inline-flex items-center h-5 px-1.5 rounded-xs text-ui-sm mono uppercase tracking-widest ${
                        g.scope === "global"
                          ? "bg-klein-wash text-klein-ink border border-klein/30"
                          : "bg-paper text-ink-muted border border-line"
                      }`}
                      title={
                        g.scope === "global"
                          ? "适用于所有会话"
                          : "仅限本会话"
                      }
                    >
                      {grantScopeLabel(g.scope)}
                    </span>
                    <span className="mono text-ui text-ink-soft shrink-0">
                      {g.toolName}
                    </span>
                    <span className="mono flex-1 truncate text-ui text-ink-muted">
                      {g.signature || "—"}
                    </span>
                    <button
                      onClick={() => revoke(g.id)}
                      disabled={archived}
                      className="h-6 px-2 text-ui rounded-xs border border-line hover:bg-paper text-ink-soft hover:text-danger disabled:opacity-60 transition-colors"
                    >
                      撤销
                    </button>
                  </div>
                ))
              )}
              {grantsErr && (
                <div className="text-ui text-danger">{grantsErr}</div>
              )}
            </div>
          </div>

          {err && (
            <div className="text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
              {err}
            </div>
          )}

          {/* Export + Archive + Delete row.
              Export is always available (even on archived sessions — you'd
              still want the transcript). Archive is reversible (row flip +
              best-effort worktree cleanup). Delete is irreversible —
              hard-drops the session row, every session_event, and any /btw
              side-chat children via FK cascade. The Delete button uses a
              two-step confirm (click → "Click again to confirm" with a 3s
              timeout) to keep an accidental tap from wiping the transcript.
              Export sits to the left as the only non-destructive action. */}
          {looksStuck && !archived && (
            <div className="pt-4 border-t border-line">
              <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-1">
                卡住了?
              </div>
              <div className="text-ui text-ink-muted leading-snug">
                此会话处于{" "}
                <span className="mono">{statusLabel(session.status)}</span> 状态,已
                {Math.round(ageMs / 60000)} 分钟没有活动。{" "}
                <button
                  type="button"
                  onClick={handleForceIdle}
                  disabled={forcingIdle}
                  className="text-klein-ink underline underline-offset-2 hover:text-klein disabled:opacity-60 transition-colors"
                >
                  {forcingIdle ? "正在重置…" : "重置为空闲"}
                </button>
              </div>
            </div>
          )}
          <div className="pt-4 border-t border-line flex flex-wrap gap-2">
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setExportOpen((v) => !v)}
                disabled={archiving || deleting}
                className="h-9 px-3 rounded border border-line text-ui text-ink-soft hover:bg-paper disabled:opacity-60 transition-colors"
                aria-haspopup="menu"
                aria-expanded={exportOpen}
              >
                导出 ⌄
              </button>
              {exportOpen && (
                <div
                  role="menu"
                  className="absolute left-0 bottom-full mb-1 min-w-[160px] rounded border border-line bg-canvas shadow-lift py-1 z-10"
                >
                  <button
                    role="menuitem"
                    onClick={() => runExport("md")}
                    className="w-full text-left px-3 py-1.5 text-ui hover:bg-paper transition-colors"
                  >
                    导出为 Markdown
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => runExport("json")}
                    className="w-full text-left px-3 py-1.5 text-ui hover:bg-paper transition-colors"
                  >
                    导出为 JSON
                  </button>
                </div>
              )}
            </div>
            {!archived && (
              <>
                <button
                  onClick={archive}
                  disabled={archiving || deleting}
                  className="h-9 px-3 rounded border border-line text-ui text-danger hover:bg-danger-wash disabled:opacity-60 transition-colors"
                >
                  {archiving ? "正在归档…" : archiveLabel}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting || archiving}
                  title="永久删除此会话。此操作无法撤销。"
                  className={`h-9 px-3 rounded text-ui disabled:opacity-60 ${
                    deleteConfirming
                      ? "bg-danger text-canvas border border-danger"
                      : "border border-danger/50 text-danger hover:bg-danger-wash transition-colors"
                  }`}
                >
                  {deleting
                    ? "正在删除…"
                    : deleteConfirming
                      ? "再次点击确认删除"
                      : "删除会话"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Shorten an absolute path for display. Replaces the host's home directory
// with `~` so the CLAUDE.md header row doesn't sprawl.
//
// The browser has no reliable handle on the host's $HOME, so we derive it
// from the user-scope CLAUDE.md path when the memory response includes one:
// the server always returns that as `<home>/.claude/CLAUDE.md`. When no
// user-scope file is visible we fall back to the raw absolute path — not
// as nice, but correct and never wrong.
// Display labels for backend scope enums rendered as chips/badges.
// Memory files are scoped "user" (global ~/.claude/CLAUDE.md) vs "project"
// (the project's own CLAUDE.md); permission grants are "global" vs "session".
// Human label for a session status enum shown inline ("running" /
// "error" / "idle" / etc.). The machine value is used elsewhere; only the
// rendered word is localized here.
function statusLabel(s: string): string {
  if (s === "running") return "运行中";
  if (s === "idle") return "空闲";
  if (s === "error") return "出错";
  if (s === "archived") return "已归档";
  return s;
}

function memScopeLabel(s: string): string {
  if (s === "user") return "用户";
  if (s === "project") return "项目";
  return s;
}

function grantScopeLabel(s: string): string {
  if (s === "global") return "全局";
  if (s === "session") return "本会话";
  return s;
}

function shortenPath(abs: string, homeDir: string | null): string {
  if (homeDir && abs === homeDir) return "~";
  if (homeDir && abs.startsWith(homeDir + "/")) {
    return "~" + abs.slice(homeDir.length);
  }
  return abs;
}

function deriveHomeDir(memory: MemoryResponse | null): string | null {
  if (!memory) return null;
  const user = memory.files.find((f) => f.scope === "user");
  if (!user) return null;
  // Strip the trailing `/.claude/CLAUDE.md` (14 chars including leading
  // slash). Guard against a server response that doesn't follow the shape.
  const suffix = "/.claude/CLAUDE.md";
  if (user.path.endsWith(suffix)) {
    return user.path.slice(0, -suffix.length);
  }
  return null;
}
