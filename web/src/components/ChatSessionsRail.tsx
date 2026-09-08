import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Search, X } from "lucide-react";
import type { PermissionMode, Project, Session } from "@claudex/shared";
import { useSessions } from "@/state/sessions";
import { api, ApiError } from "@/api/client";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

// Module-level cache for project id → display name. Lives outside the
// rail component so it survives the full remount that App.tsx's
// `<ChatScreen key={id} />` triggers on every session click — the
// previous in-component `useState` + `useEffect` reloaded for every
// click, which made the rail flash the opaque slug ("VAiq4lmxxz1H")
// before the fetch landed and looked like the whole list was refreshing.
// Filled once per page load; stale entries (project added after this
// fetch) fall back to the slug, same as the previous behavior.
let projectNameCache: Record<string, string> = {};
let projectNameInflight: Promise<void> | null = null;
const projectNameListeners = new Set<() => void>();

function ensureProjectNamesLoaded(): void {
  if (Object.keys(projectNameCache).length > 0) return;
  if (projectNameInflight) return;
  projectNameInflight = api
    .listProjects()
    .then((r: { projects: Project[] }) => {
      const next: Record<string, string> = {};
      for (const p of r.projects) next[p.id] = p.name;
      projectNameCache = next;
      for (const l of projectNameListeners) l();
    })
    .catch(() => {
      /* fall back to slug — rail still renders. */
    })
    .finally(() => {
      projectNameInflight = null;
    }) as Promise<void>;
}

function useProjectNames(): Record<string, string> {
  return useSyncExternalStore(
    (listener) => {
      projectNameListeners.add(listener);
      ensureProjectNamesLoaded();
      return () => {
        projectNameListeners.delete(listener);
      };
    },
    () => projectNameCache,
    () => projectNameCache,
  );
}

// Persist the user's chosen rail width across reloads. Bounded to keep the
// Chat center column sane (below 180px the rail is unreadable; above 480px
// it steals too much room from the transcript).
const WIDTH_KEY = "claudex:chatRailWidth";
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 220;

function readPersistedWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

// Compact relative-time format used inside the rail rows. Differs from the
// global `timeAgoShort` ("2m ago") on purpose: rail rows are width-pinched
// and the trailing " ago" eats space without adding meaning when every row
// is past tense already. Pattern: now / 2m / 5h / yest. / 2d / MM-DD.
function railTime(input: string): string {
  const t = Date.parse(input);
  if (!Number.isFinite(t)) return "—";
  const delta = Math.max(0, Date.now() - t);
  const m = Math.floor(delta / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  if (h < 48) return "yest.";
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const dt = new Date(t);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

/**
 * Condensed per-session rail for the desktop Chat screen (mockup s-04,
 * lines 943–962). Lists sessions **scoped to the current project** — the
 * same-project rail is how we keep the sidebar focused on the conversation
 * the user is actually in, rather than replaying the full Home list.
 *
 * Also hosts an inline "+ New session" quick-create affordance and a
 * drag-to-resize strip on the right edge. Width is persisted to
 * localStorage (`claudex:chatRailWidth`) between 180px and 480px.
 *
 * Hidden below `md:` (mobile keeps the existing single-panel layout).
 */
export function ChatSessionsRail({ currentId }: { currentId: string }) {
  const sessions = useSessions((s) => s.sessions);
  const refreshSessions = useSessions((s) => s.refreshSessions);
  const connected = useSessions((s) => s.connected);
  const navigate = useNavigate();

  // Refresh the list once on mount so the rail is populated even if Home
  // was never visited this session. Subsequent live status updates arrive
  // via the global WS channel the sessions store already subscribes to.
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Project display-name lookup. The cache is module-level (see
  // `useProjectNames` at the top of the file), so it survives the full
  // remount that `<ChatScreen key={id} />` triggers on every session
  // click — no more slug flash between clicks.
  const projectName = useProjectNames();

  // Current session drives the project scope. When it hasn't loaded yet
  // (fresh navigation, no sessions in store) we render a Loading state
  // rather than showing the full cross-project list and then flickering.
  const current = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId],
  );

  // Project-scoped list before the user-visible search/status filters get
  // applied. Sorted pinned-first then by last-activity. Memo keys:
  // [sessions, current] so live store updates re-sort but tab/search
  // changes don't.
  const scoped = useMemo(() => {
    if (!current) return [] as Session[];
    const filtered = sessions.filter(
      (s) =>
        s.status !== "archived" &&
        s.projectId === current.projectId &&
        !s.parentSessionId,
    );
    const sortKey = (s: Session) =>
      Date.parse(s.lastMessageAt ?? s.updatedAt) || 0;
    return filtered.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return sortKey(b) - sortKey(a);
    });
  }, [sessions, current]);

  // ---- Search ---------------------------------------------------------------
  const [search, setSearch] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = (search ?? "").trim().toLowerCase();
    return scoped.filter((s) => {
      if (!q) return true;
      const hay = [
        s.title,
        s.branch ?? "",
        s.projectId,
        s.lastUserMessage ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [scoped, search]);

  // Group the already-filtered list into Now / Today / Earlier — the
  // three-bucket scheme the screenshot uses. "Now" = last hour OR pinned
  // (pinned always sticks to the top of the most-active group so it stays
  // ahead of older entries), Today = within the last 24h, Earlier = the
  // rest. A small rolling-minute tick re-buckets rows whose "Now" / "Today"
  // labels just expired so headers stay correct without waiting on a WS
  // frame.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const groups = useMemo(() => {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const now: Session[] = [];
    const today: Session[] = [];
    const earlier: Session[] = [];
    for (const s of filtered) {
      const activityIso = s.lastMessageAt ?? s.updatedAt;
      const delta = nowTick - (Date.parse(activityIso) || 0);
      if (s.pinned || delta < HOUR) now.push(s);
      else if (delta < DAY) today.push(s);
      else earlier.push(s);
    }
    const out: Array<{ key: string; label: string; sessions: Session[] }> = [];
    if (now.length) out.push({ key: "now", label: "此刻", sessions: now });
    if (today.length) out.push({ key: "today", label: "今天", sessions: today });
    if (earlier.length)
      out.push({ key: "earlier", label: "更早", sessions: earlier });
    return out;
  }, [filtered, nowTick]);

  // ---- Drag-to-resize ----------------------------------------------------
  const [width, setWidth] = useState<number>(() => readPersistedWidth());
  const asideRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    // Freeze text selection on the whole document while dragging. Without
    // this the browser highlights transcript content as the cursor sweeps
    // across the center column. Restored in the cleanup below.
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const aside = asideRef.current;
      if (!aside) return;
      const left = aside.getBoundingClientRect().left;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, ev.clientX - left));
      setWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      // Persist once on release — writing every mousemove would be churn.
      try {
        window.localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* quota / disabled storage — fall back to session-only width. */
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevUserSelect;
    };
    // width is read in onUp via closure; we want the CURRENT width at release.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, width]);

  // ---- Quick-create -------------------------------------------------------
  // Quick-create now lives in a floating popover anchored to the "+ New"
  // button instead of an inline-collapsed block, so opening it never
  // squeezes the session list down. Outside-click and Escape both close.
  const [createOpen, setCreateOpen] = useState(false);
  const newBtnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!createOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCreateOpen(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (newBtnRef.current?.contains(t)) return;
      setCreateOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [createOpen]);

  return (
    <aside
      ref={asideRef}
      className="hidden md:flex relative border-r border-line bg-paper/40 flex-col shrink-0"
      style={{ width }}
    >
      {/* ── Header: title + count + search icon + black "+ New" pill ──── */}
      <div className="px-4 pt-4 pb-2 flex items-center gap-2">
        <Link
          to="/sessions"
          aria-label="前往会话列表"
          className="flex items-baseline gap-2 flex-1 min-w-0 -mx-1 px-1 py-0.5 rounded-sm hover:bg-canvas/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-klein/40 transition-colors"
        >
          <span className="text-ui-title font-semibold tracking-tight text-ink truncate">
            会话
          </span>
          <span className="text-ui text-ink-muted tabular-nums">
            {scoped.length}
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setSearch((v) => (v === null ? "" : null))}
          aria-label="切换搜索"
          title="搜索会话 (⌘K)"
          className={cn(
            "shrink-0 h-7 w-7 rounded-full flex items-center justify-center transition-colors",
            search !== null
              ? "bg-ink/10 text-ink"
              : "text-ink-muted hover:text-ink hover:bg-canvas/60 transition-colors",
          )}
        >
          <Search className="w-3.5 h-3.5" />
        </button>
        <div className="relative shrink-0">
          <button
            type="button"
            ref={newBtnRef}
            onClick={() => setCreateOpen((v) => !v)}
            disabled={!current}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-full",
              "bg-ink text-canvas text-ui font-medium",
              "hover:bg-ink/90 disabled:opacity-50 transition-colors",
            )}
            title={current ? "在此项目中新建会话" : "正在加载当前会话…"}
            aria-haspopup="dialog"
            aria-expanded={createOpen}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建</span>
            <kbd className="hidden lg:inline mono text-ui-sm opacity-70 ml-0.5">
              ⌘N
            </kbd>
          </button>

          {/* Floating quick-create popover. Anchored to the "+ New" button
              so opening doesn't squeeze the session list. Width is fixed
              at 260px — narrower rails (down to 180px) get a popover that
              overlays into the chat center column, which is preferable to
              cramming the form into half its natural width. shadow-lift
              + canvas bg lifts it cleanly above the rail's paper/40
              backdrop. */}
          {createOpen && (
            <div
              ref={popRef}
              role="dialog"
              aria-label="新建会话"
              className="absolute top-full right-0 mt-2 z-30 w-[260px] rounded-lg shadow-lift"
            >
              <QuickCreateForm
                current={current}
                onCancel={() => setCreateOpen(false)}
                onCreated={(id) => {
                  setCreateOpen(false);
                  navigate(`/session/${id}`);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Search (toggleable) ──────────────────────────────────────── */}
      {search !== null && (
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话…"
            autoFocus
            className={cn(
              "w-full h-8 pl-7 pr-8 rounded",
              "bg-canvas/70 border border-line text-ui text-ink placeholder:text-ink-faint",
              "focus:outline-none focus:border-klein/60 focus:bg-canvas",
            )}
            aria-label="搜索会话"
          />
          <button
            type="button"
            onClick={() => setSearch(null)}
            aria-label="关闭搜索"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      )}

      {/* ── Session list ───────────────────────────────────────────────── */}
      <div className="px-2 overflow-y-auto flex-1 min-h-0 border-t border-line/60">
        {!current ? (
          <div className="px-2.5 py-4 text-ui text-ink-muted mono">
            加载中…
          </div>
        ) : scoped.length === 0 ? (
          <div className="px-2.5 py-4 text-ui text-ink-muted">
            此项目中暂无其他会话。
          </div>
        ) : groups.length === 0 ? (
          <div className="px-2.5 py-4 text-ui text-ink-muted">
            没有会话符合你的筛选条件。
          </div>
        ) : (
          groups.map((g, idx) => (
            <div key={g.key} className={cn(idx > 0 && "mt-3")}>
              {/* Group header — left label + right-aligned count, in the
                  same muted weight as the status tab counts so the rail
                  reads as a single layered index. */}
              <div className="px-2.5 pt-2 pb-1 flex items-center">
                <span className="text-ui font-medium text-ink-muted">
                  {g.label}
                </span>
                <span className="ml-auto text-ui text-ink-faint tabular-nums">
                  {g.sessions.length}
                </span>
              </div>
              <div className="space-y-0.5">
                {g.sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    projectName={projectName[s.projectId] ?? s.projectId}
                    active={s.id === currentId}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Footer: live connection state ──────────────────────────────── */}
      <div className="mt-auto p-3 border-t border-line text-ui text-ink-muted mono flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0",
            connected ? "bg-success" : "bg-ink-faint",
          )}
        />
        <span>{connected ? "已连接" : "离线"}</span>
      </div>

      {/* Resize strip — 1px invisible column; a subtle hover tint is the
          only affordance, which is enough once the cursor flips to
          col-resize. `active:bg-klein/40` brightens it while the drag is
          live so the user can tell the handle "grabbed". */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话栏宽度"
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        className={cn(
          "absolute right-0 top-0 bottom-0 w-1 cursor-col-resize",
          "hover:bg-line/60 transition-colors",
          dragging && "bg-klein/40",
        )}
      />
    </aside>
  );
}

export function QuickCreateForm({
  current,
  onCancel,
  onCreated,
}: {
  current: Session | null;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Default the new session's permission mode to whatever the current session
  // is running under — matches the ergonomics of the old inherit-mode path
  // while letting the user override before spawning. Falls back to "default"
  // if `current` hasn't loaded yet (button is disabled in that case anyway).
  const [mode, setMode] = useState<PermissionMode>(
    current?.mode ?? "default",
  );
  // Worktree opt-in for the peer session. The user runs multiple agents in
  // parallel against this project, so defaulting to ON (when the project is
  // a git repo) gives each session its own checkout instead of racing on
  // the shared cwd. `projectIsGit` is looked up from /api/projects lazily
  // on mount; while it's null we optimistically assume git — if the server
  // rejects with `not_a_git_repo` the toast carries it up.
  const [projectIsGit, setProjectIsGit] = useState<boolean | null>(null);
  const [worktree, setWorktree] = useState<boolean>(true);
  const [userTouchedWorktree, setUserTouchedWorktree] = useState(false);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Resolve the project's git-ness from the list endpoint. If the current
  // session already has a worktreePath we know the project is a git repo
  // and can skip the network hop — worktrees are only created on git repos.
  useEffect(() => {
    if (!current) return;
    if (current.worktreePath) {
      setProjectIsGit(true);
      return;
    }
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (cancelled) return;
        const proj = r.projects.find((p) => p.id === current.projectId);
        setProjectIsGit(proj?.isGitRepo ?? false);
      })
      .catch(() => {
        if (!cancelled) setProjectIsGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  // Apply the git-based default once resolved — but only if the user
  // hasn't flipped the checkbox themselves.
  useEffect(() => {
    if (userTouchedWorktree) return;
    if (projectIsGit === null) return;
    setWorktree(projectIsGit);
  }, [projectIsGit, userTouchedWorktree]);

  async function submit() {
    if (!current) return;
    const trimmed = prompt.trim();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createSession({
        projectId: current.projectId,
        // Title is secondary in the quick-create flow — users almost never
        // type one here. Derive from the first prompt when present; omit
        // when the prompt is blank so the server applies its own "Untitled"
        // display default AND the worktree branch falls back to sessionId
        // instead of colliding on `claude/untitled`.
        ...(trimmed ? { title: trimmed.slice(0, 60) } : {}),
        model: current.model,
        mode,
        worktree: worktree && projectIsGit !== false,
        initialPrompt: trimmed || undefined,
      });
      onCreated(res.session.id);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "create_failed";
      setErr(code);
      toast(`创建失败：${code}`);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-canvas p-2 space-y-2">
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="首个提示词 (可选)…"
        rows={2}
        className="w-full resize-none bg-paper border border-line rounded-sm p-2 text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:border-klein/60"
      />
      {/* Compact permission-mode segmented control. Mirrors the NewSessionSheet
          control from Home, shrunk to fit the rail (h-7, 11px labels). Title
          is intentionally omitted from this form — it's a low-value field at
          this entry point and pushed to the full sheet on Home instead. */}
      <div className="grid grid-cols-4 gap-0.5 p-0.5 bg-paper border border-line rounded-sm">
        {(
          [
            ["default", "询问"],
            ["acceptEdits", "接受"],
            ["plan", "计划"],
            ["bypassPermissions", "绕过"],
          ] as Array<[PermissionMode, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            disabled={busy}
            className={cn(
              "h-7 rounded-xs text-ui font-medium transition-colors",
              mode === id
                ? "bg-canvas shadow-card border border-line text-ink"
                : "text-ink-muted hover:text-ink-soft transition-colors",
            )}
            title={`权限模式：${label}`}
          >
            {label}
          </button>
        ))}
      </div>
      {/* Worktree toggle — compact variant of the Home NewSessionSheet row.
          Disabled when we know the project isn't a git repo (projectIsGit
          resolved to false). While still resolving (null), kept enabled so
          an eager ⌘⏎ doesn't hit a spurious disabled state. */}
      <label
        className={cn(
          "flex items-center gap-2 px-1.5 py-1 rounded-xs text-ui",
          projectIsGit === false
            ? "opacity-50 cursor-not-allowed"
            : "cursor-pointer hover:bg-paper transition-colors",
        )}
        title={
          projectIsGit === false
            ? "此项目不是 git 仓库 — worktree 不可用。"
            : "在新的 claude/<slug> 分支上启动，使该并列会话不占用主 checkout。"
        }
      >
        <span className="relative inline-flex shrink-0 items-center">
          <input
            type="checkbox"
            checked={worktree && projectIsGit !== false}
            disabled={busy || projectIsGit === false}
            onChange={(e) => {
              setUserTouchedWorktree(true);
              setWorktree(e.target.checked);
            }}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="block h-4 w-7 rounded-full bg-line-strong transition-colors peer-checked:bg-klein peer-focus-visible:ring-2 peer-focus-visible:ring-klein/40 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-canvas"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-0.5 -translate-y-1/2 h-3 w-3 rounded-full bg-canvas shadow-card ring-1 ring-black/5 transition-transform peer-checked:translate-x-3"
          />
        </span>
        <span className={projectIsGit === false ? "text-ink-faint" : "text-ink-soft"}>
          使用 git worktree
        </span>
      </label>
      {err && (
        <div className="text-ui text-danger mono truncate">{err}</div>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label="取消"
          className="h-7 w-7 rounded-sm border border-line bg-paper text-ink-soft flex items-center justify-center hover:bg-canvas disabled:opacity-50 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !current}
          className="ml-auto h-7 px-3 rounded-sm bg-ink text-canvas text-ui font-medium disabled:opacity-50"
        >
          {busy ? "创建中…" : "创建"}
        </button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  projectName,
  active,
}: {
  session: Session;
  projectName: string;
  active: boolean;
}) {
  // Status palette — drives both the inactive dot fill AND the active
  // row's ring + fill + accent bar. Class names are written out in full
  // (no string concatenation) so Tailwind's static analysis picks them
  // up. `ring` is a faded variant of `fill` so the outer outline reads
  // as a halo rather than a hard second line; `pulse` is empty for
  // non-animated statuses; running / cli_running share the pulse with
  // their respective tones (green / klein) on both active and inactive
  // rows.
  const palette = (() => {
    switch (session.status) {
      case "running":
        return { ring: "border-success/40", fill: "bg-success", pulse: "animate-pulse" };
      case "cli_running":
        return { ring: "border-klein/40", fill: "bg-klein", pulse: "animate-pulse" };
      case "awaiting":
        return { ring: "border-warn/40", fill: "bg-warn", pulse: "" };
      case "error":
        return { ring: "border-danger/40", fill: "bg-danger", pulse: "" };
      case "archived":
        return { ring: "border-line-strong", fill: "bg-line-strong", pulse: "" };
      case "idle":
      default:
        return { ring: "border-ink-faint/40", fill: "bg-ink-faint", pulse: "" };
    }
  })();

  const dotClass = cn("h-2 w-2 rounded-full shrink-0", palette.fill, palette.pulse);
  const title = session.title || "未命名";
  const activityIso = session.lastMessageAt ?? session.updatedAt;
  const activityLabel = railTime(activityIso);
  const activityTitle = new Date(activityIso).toLocaleString();
  const projectLabel = projectName;
  const branchLabel = session.branch ?? "—";
  const { linesAdded, linesRemoved } = session.stats;
  const hasDiff = linesAdded > 0 || linesRemoved > 0;
  const isAwaiting = session.status === "awaiting";

  // Active row keeps the same horizontal padding as the inactive variant
  // — adding `pl-4` to make room for the bar would shift content
  // sideways every time the user clicks a session, which the user
  // explicitly called out. Bar lives inside the existing `px-2.5` pad
  // (see `accentBar` below), so content doesn't move.
  const rowBase =
    "relative block w-full text-left px-2.5 py-2 rounded-lg transition-colors";
  const activeCls = "bg-canvas border border-line shadow-card";
  const inactiveCls = "hover:bg-canvas/60 transition-colors";

  // Outer flex is `items-center` so the status dot — which is the only
  // child in the left column — vertically centers across however many
  // text lines the right column ends up with (1 if no diff stats, 2 with
  // them). The user explicitly asked for this centered alignment.
  const content = (
    <div className="flex items-center gap-2.5">
      {/* Left: status dot. Active rows paint a status-colored ring around
          a status-colored fill (e.g. running → both green) so the dot
          stays a faithful status reading rather than a fixed klein "you
          are here" override. Inactive rows render the same fill without
          the ring. */}
      <span className="shrink-0 flex items-center justify-center w-3 h-3">
        {active ? (
          <span className="relative inline-flex items-center justify-center w-3 h-3">
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 rounded-full border-[1.5px]",
                palette.ring,
              )}
            />
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                palette.fill,
                palette.pulse,
              )}
            />
          </span>
        ) : (
          <span className={dotClass} />
        )}
      </span>

      {/* Right: title row + meta row. flex-1/min-w-0 so long titles
          truncate cleanly without nudging the right column. */}
      <div className="flex-1 min-w-0 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div
            className={cn(
              "text-ui truncate leading-tight",
              active ? "font-medium text-ink" : "text-ink-soft",
            )}
            title={title}
          >
            {title}
          </div>
          <div
            className="mono text-ui text-ink-muted truncate mt-0.5"
            title={`${projectLabel} · ${branchLabel}`}
          >
            {projectLabel} <span className="text-ink-faint">·</span>{" "}
            {branchLabel}
          </div>
        </div>

        {/* Right meta column — timestamp at the top, diff stats / awaiting
            badge underneath. Sized to its own content so the title column
            takes the rest of the row width. */}
        <div className="shrink-0 flex flex-col items-end gap-0.5 pl-1">
          <span
            className="mono text-ui text-ink-muted whitespace-nowrap"
            title={activityTitle}
          >
            {activityLabel}
          </span>
          {isAwaiting ? (
            <span className="flex flex-col items-end leading-[1.15] text-ui text-warn font-medium">
              <span>待你</span>
              <span>回应</span>
            </span>
          ) : hasDiff ? (
            <span className="mono text-ui whitespace-nowrap">
              <span className="text-success">+{linesAdded}</span>{" "}
              <span className="text-danger">−{linesRemoved}</span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );

  // The active row's left bar is rendered as an absolutely-positioned 2px
  // pill — both ends rounded, status-colored to match the dot. Sits at
  // `left-1` (4px) inside the row's existing `px-2.5` (10px) left
  // padding, leaving ~4px of clearance to the dot. Critically, it does
  // NOT bump the row's left padding — selecting a session must not
  // shift the rest of the content sideways.
  const accentBar = active ? (
    <span
      aria-hidden
      className={cn(
        "absolute left-1 top-2.5 bottom-2.5 w-[2px] rounded-full",
        palette.fill,
      )}
    />
  ) : null;

  if (active) {
    return (
      <div className={cn(rowBase, activeCls)} aria-current="page">
        {accentBar}
        {content}
      </div>
    );
  }

  return (
    <Link to={`/session/${session.id}`} className={cn(rowBase, inactiveCls)}>
      {content}
    </Link>
  );
}
