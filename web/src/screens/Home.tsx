import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, GitBranch, Pencil, Pin, Trash2, FolderOpen, Settings2, X, Download, Search, BarChart3, MoreHorizontal, ChevronDown, ChevronUp, RotateCcw, RefreshCw, Sparkles } from "lucide-react";
import { useAuth } from "@/state/auth";
import { useSessions } from "@/state/sessions";
import { api, ApiError } from "@/api/client";
import type { Project, Session, EffortLevel, ModelId, PermissionMode } from "@claudex/shared";
import { clampEffortForModel, defaultEffortForModel, effortSupportedOnModel } from "@claudex/shared";
import { FolderPicker } from "@/components/FolderPicker";
import { Button } from "@/components/Button";
import { AppShell } from "@/components/AppShell";
import { ImportSessionsSheet } from "@/components/ImportSessionsSheet";
import { GlobalSearchSheet } from "@/components/GlobalSearchSheet";
import { StatsSheet } from "@/components/StatsSheet";
import { cn } from "@/lib/cn";
import { basename as pathBasename } from "@/lib/path";
import { toast } from "@/lib/toast";
import { useFocusReturn } from "@/hooks/useFocusReturn";
import { forceReload, restartServer } from "@/lib/admin-actions";
import { getAllModelEntries } from "@/lib/pricing";
import { useAppSettings, useCustomModels } from "@/state/app-settings";

// Status dot colors for the flat row layout. `running` and `awaiting` get a
// soft glow ring (box-shadow) to match the mockup (s-02 lines 513, 533).
// `cli_running` uses the klein tone so it's visually distinct from `running`
// (SDK-driven) — signals "external `claude` CLI process is alive against
// this session" without implying claudex's composer is busy.
const STATUS_DOT: Record<string, string> = {
  running: "bg-success",
  cli_running: "bg-klein",
  awaiting: "bg-warn",
  idle: "bg-ink-faint",
  archived: "bg-line-strong",
  error: "bg-danger",
};
const DOT_GLOW: Record<string, string> = {
  running: "0 0 0 4px rgb(var(--c-success)/0.18)",
  cli_running: "0 0 0 4px rgb(var(--c-klein)/0.22)",
  awaiting: "0 0 0 4px rgb(var(--c-warn)/0.18)",
  idle: "",
  archived: "",
  error: "0 0 0 4px rgb(var(--c-danger)/0.18)",
};

// ---------------------------------------------------------------------------
// Filter chip rail (mockup s-02 lines 492–500).
//
// Six chips that slice the session list. Active chip pill-fills with ink;
// inactive chips are canvas w/ a subtle border. Counts and status dots
// (running = green, awaiting = warn) render inline so the rail surfaces
// "what needs you" at a glance.
//
// State lives in the URL (`?filter=running`) so back/forward Just Works and
// links to a filtered view are shareable. Clicking the active chip clears
// the filter by removing the param.
//
// Caveats worth calling out:
//   - "Scheduled" is visually present but greyed: the session model doesn't
//     carry a `nextRunAt` link to routines today, so we have nothing to
//     filter by. It'll light up the day we wire routines→sessions.
//   - "Mine" is a no-op on a single-user install. Rendered at 60% opacity
//     so it's visible (preserves the mockup's chip set) without lying.
//   - "Archived" swaps the data source to `listSessions({archived:true})` —
//     see `archivedSessions` state. The default source excludes archived.
// ---------------------------------------------------------------------------

type FilterId =
  | "all"
  | "running"
  | "awaiting"
  | "scheduled"
  | "mine"
  | "archived";

function chipMatches(s: Session, filter: FilterId): boolean {
  switch (filter) {
    case "all":
      // Default view is non-archived; archived rows are fetched separately
      // and only surfaced via the "archived" chip.
      return s.status !== "archived";
    case "running":
      return s.status === "running";
    case "awaiting":
      return s.status === "awaiting";
    case "scheduled":
      // No session<->routine link exists yet. Render the chip but match
      // nothing so the list empties to the "no matches" message.
      return false;
    case "mine":
      // Single-user: every session is "mine". Acts as a no-op / identity
      // filter and lets the chip appear without deceiving.
      return s.status !== "archived";
    case "archived":
      // `archivedSessions` is the source set here, so everything already
      // passes; kept explicit for symmetry.
      return s.status === "archived";
  }
}

export function HomeScreen() {
  const { user } = useAuth();
  const {
    init,
    sessions,
    refreshSessions,
    loadingSessions,
    connected,
    wsDiag,
  } = useSessions();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeProjectId = searchParams.get("project");
  const activeFilter = (searchParams.get("filter") ?? "all") as FilterId;
  // Optional tag filter sourced from `?tag=<name>`. Stored in the URL so the
  // filter is shareable + survives back/forward. Only one tag active at a
  // time for now; multi-tag intersection can come later if the UI asks.
  const activeTag = searchParams.get("tag");
  const [showNew, setShowNew] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showWsDiag, setShowWsDiag] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSearchSheet, setShowSearchSheet] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  // Admin-action state for the two header-overflow items. Restart spins up an
  // opaque overlay (the server really is gone for ~10–30s and we don't want
  // the user tapping things that race the old websocket closing); the force
  // reload path immediately navigates away so it doesn't need UI state.
  const [restartState, setRestartState] = useState<
    "idle" | "running" | "failed"
  >("idle");
  const [restartError, setRestartError] = useState<string | null>(null);
  // Data-fetch failures from the two direct API calls on this screen:
  // `listSessions({archived:true})` (only fetched when the archived chip is
  // active) and `listProjects()`. Previously swallowed with `/* best-effort */`
  // comments — which meant a broken API looked identical to "no rows". Surface
  // them as a thin dismissible banner so the user can tell the difference.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Per-group expand/collapse state. Groups collapsed by default — each
  // group shows "all non-idle + up to 3 most-recent idle" rows so long
  // lists don't dominate the screen, while rows that need the user's
  // attention (awaiting / running / error) are always in view. The set
  // holds the projectIds that the user has explicitly expanded.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const toggleGroup = (projectId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // Cmd+K / Ctrl+K opens the global search sheet (full-text across session
  // titles AND message bodies) from anywhere on the page. preventDefault so
  // the browser's own "search bookmarks" binding doesn't fight us. Works
  // even when another input is focused — users expect to jump into search
  // without first clicking out of the composer.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearchSheet(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    init();
    refreshSessions();
  }, [init, refreshSessions]);

  // Archived-chip data: fetched on demand so the default list call can stay
  // cheap. We keep this separate from the global sessions store because
  // archived rows don't get live WS updates anyway (they're read-only) and
  // merging them into the store would confuse every other screen.
  useEffect(() => {
    if (activeFilter !== "archived") return;
    let cancelled = false;
    api
      .listSessions({ archived: true })
      .then((r) => {
        if (cancelled) return;
        // The server returns archived + live in one list when archived=1;
        // narrow to archived so the chip's filter is honest.
        setArchivedSessions(r.sessions.filter((s) => s.status === "archived"));
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadErr(
          e instanceof ApiError
            ? `获取归档会话失败: ${e.code}`
            : "获取归档会话失败",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [activeFilter]);

  // Projects list is its own fetch — sessions carry projectId but no name,
  // and we want the group header to show the project's display name even if
  // there are no sessions yet under it (though empty groups are hidden).
  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadErr(
          e instanceof ApiError
            ? `获取项目失败: ${e.code}`
            : "获取项目失败",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build ordered groups: bucket sessions by projectId, drop empty buckets,
  // sort sessions inside each bucket newest-first, sort groups by their
  // newest session's timestamp. Wrapped in useMemo so the layout is stable
  // across renders caused by WS status ticks.
  // The source set depends on the active filter chip. "Archived" switches
  // to the separately-fetched archived list; everything else uses the live
  // sessions store (which already excludes archived). "All" is the default.
  const sourceSessions =
    activeFilter === "archived" ? archivedSessions : sessions;
  const groups = useMemo(() => {
    const byProject = new Map<string, Session[]>();
    const projectLookup = new Map(projects.map((p) => [p.id, p] as const));
    for (const s of sourceSessions) {
      // Hide side-chat children from the Home list. They appear inline in
      // their parent chat's side drawer, not as top-level rows.
      if (s.parentSessionId) continue;
      if (!chipMatches(s, activeFilter)) continue;
      if (activeTag) {
        const tags = s.tags ?? [];
        if (!tags.includes(activeTag)) continue;
      }
      const list = byProject.get(s.projectId);
      if (list) list.push(s);
      else byProject.set(s.projectId, [s]);
    }
    // Sort key MUST match what the row actually renders — `SessionRow`
    // shows `formatRel(s.lastMessageAt ?? s.updatedAt)`. Keying the sort
    // on `updatedAt` alone while the display shows "last activity" made
    // the list look random whenever a non-message mutation (status flip,
    // rename, mode change, tag edit, pin) had bumped `updatedAt` past a
    // session's last message — a row labelled "22h ago" would sort above
    // a row labelled "5m ago". The display is the source of truth; the
    // sort follows it.
    const sortKey = (s: Session) =>
      Date.parse(s.lastMessageAt ?? s.updatedAt) || 0;
    // Session-level ordering is pinned-first, then activity-desc. Within
    // each project group the pinned rows float; at the group level we bucket
    // groups by whether they contain any pinned session so projects with
    // pinned work surface above the rest, then break ties on the newest
    // session's activity.
    const sessionSort = (a: Session, b: Session) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return sortKey(b) - sortKey(a);
    };
    const out: Array<{ project: Project | null; projectId: string; sessions: Session[] }> = [];
    for (const [projectId, list] of byProject) {
      list.sort(sessionSort);
      out.push({
        project: projectLookup.get(projectId) ?? null,
        projectId,
        sessions: list,
      });
    }
    out.sort((a, b) => {
      const ap = a.sessions.some((s) => s.pinned) ? 1 : 0;
      const bp = b.sessions.some((s) => s.pinned) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return sortKey(b.sessions[0]) - sortKey(a.sessions[0]);
    });
    return out;
  }, [sourceSessions, projects, activeFilter, activeTag]);

  const filteredGroups = useMemo(() => {
    if (!activeProjectId) return groups;
    return groups.filter((g) => g.projectId === activeProjectId);
  }, [groups, activeProjectId]);

  const activeProject = activeProjectId
    ? projects.find((p) => p.id === activeProjectId) ?? null
    : null;

  const clearFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("project");
    setSearchParams(next, { replace: true });
  };

  // Set or clear the tag filter. When called with the currently-active tag
  // we clear; otherwise we swap. Used by both the rail chip's X and the
  // per-row tag chips. The URL stays the source of truth for the filter.
  const setTag = (name: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (!name) next.delete("tag");
    else next.set("tag", name);
    setSearchParams(next, { replace: true });
  };

  const visibleSessionCount = filteredGroups.reduce(
    (n, g) => n + g.sessions.length,
    0,
  );

  // Counts surfaced on the filter chips. Running / awaiting come from the
  // live list (archived rows can't be in either state). "All" is the
  // non-archived top-level count — the same set "All" would show when
  // clicked, minus any project filter which is orthogonal.
  const filterCounts = useMemo(() => {
    let all = 0;
    let running = 0;
    let awaiting = 0;
    for (const s of sessions) {
      if (s.parentSessionId) continue;
      if (s.status === "archived") continue;
      all += 1;
      if (s.status === "running") running += 1;
      else if (s.status === "awaiting") awaiting += 1;
    }
    return { all, running, awaiting };
  }, [sessions]);

  return (
    <AppShell tab="sessions">
      <header className="shrink-0 relative z-40 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        {/* Title = single-line breadcrumb. "Sessions" alone when nothing
            is filtered; "Sessions · <project>" when a project filter is
            on, with an inline × to clear. Beats the old caps-above-display
            stack where "Sessions / All projects" read like two titles
            fighting for the same slot. */}
        <h1 className="display text-ui-title md:text-ui-display-lg leading-tight flex items-baseline gap-1.5 min-w-0">
          <span className="shrink-0">会话</span>
          {activeProject && (
            <>
              <span
                className="text-ink-faint shrink-0 font-sans text-ui-lg md:text-ui-heading"
                aria-hidden
              >
                ·
              </span>
              <span
                className="text-ui-lg font-medium text-ink-soft truncate min-w-0"
                title={activeProject.name}
              >
                {activeProject.name}
              </span>
              <button
                type="button"
                onClick={clearFilter}
                aria-label={`清除项目筛选 ${activeProject.name}`}
                title="清除项目筛选"
                className="shrink-0 h-5 w-5 rounded-full border border-line bg-paper flex items-center justify-center hover:bg-canvas transition-colors"
              >
                <X className="w-2.5 h-2.5 text-ink-muted" aria-hidden />
              </button>
            </>
          )}
        </h1>
        <button
          type="button"
          onClick={() => setShowWsDiag((v) => !v)}
          title="WebSocket 诊断"
          aria-label="WebSocket 诊断"
          className={`inline-flex items-center gap-1.5 ml-1 px-1.5 py-0.5 rounded-xs border border-line bg-paper text-ui-sm uppercase tracking-widest ${
            connected ? "text-success" : "text-ink-muted"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected
                ? "bg-success animate-pulse"
                : wsDiag.phase === "connecting" || wsDiag.phase === "open"
                  ? "bg-warn"
                  : "bg-danger"
            }`}
          />
          {connected ? "在线" : wsDiag.phase}
        </button>
        <span className="hidden md:inline text-ui text-ink-muted ml-2">
          以 <span className="mono">{user?.username}</span> 登录
        </span>
        <button
          type="button"
          onClick={() => setShowSearchSheet(true)}
          title="搜索 (⌘K)"
          className="hidden md:flex flex-1 max-w-md mx-auto w-full text-left items-center gap-2 h-9 px-3 bg-paper border border-line rounded hover:bg-paper/80 transition-colors"
        >
          <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
          <span className="flex-1 min-w-0 text-ui text-ink-muted truncate">
            搜索会话和消息
          </span>
          <span className="ml-auto text-ui text-ink-faint mono shrink-0">
            ⌘K
          </span>
        </button>
        <div className="ml-auto flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setShowSearchSheet(true)}
            aria-label="搜索"
            title="搜索"
            className="md:hidden h-9 w-9 rounded border border-line bg-canvas flex items-center justify-center hover:bg-paper shrink-0 transition-colors"
          >
            <Search className="w-4 h-4 text-ink-soft" />
          </button>
          {/* Desktop keeps all three utilities visible. Mobile collapses
              Import / Stats / Projects into the overflow menu below so the
              New-session primary action is never clipped off-screen. */}
          <button
            onClick={() => setShowImport(true)}
            title="导入已有 CLI 会话"
            aria-label="导入 CLI 会话"
            className="hidden md:flex h-9 w-9 rounded border border-line bg-canvas items-center justify-center hover:bg-paper shrink-0 transition-colors"
          >
            <Download className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowStats(true)}
            title="统计"
            aria-label="统计"
            className="hidden md:flex h-9 w-9 rounded border border-line bg-canvas items-center justify-center hover:bg-paper shrink-0 transition-colors"
          >
            <BarChart3 className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowProjects(true)}
            title="管理项目"
            className="hidden md:flex h-9 w-9 rounded border border-line bg-canvas items-center justify-center hover:bg-paper shrink-0 transition-colors"
          >
            <Settings2 className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            type="button"
            onClick={() => {
              void forceReload();
            }}
            title="强制刷新 (清除缓存)"
            aria-label="强制刷新"
            className="h-9 w-9 rounded border border-line bg-canvas flex items-center justify-center hover:bg-paper shrink-0 transition-colors"
          >
            <RefreshCw className="w-4 h-4 text-ink-soft" />
          </button>
          <HeaderOverflowMenu
            onImport={() => setShowImport(true)}
            onStats={() => setShowStats(true)}
            onProjects={() => setShowProjects(true)}
          />
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded bg-klein text-canvas text-ui font-medium md:shadow-raised transition-ui-fast shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">新建会话</span>
            <span className="sm:hidden">新建</span>
          </button>
        </div>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto pb-20 md:pb-6">
        <FilterChipRail
          active={activeFilter}
          counts={filterCounts}
          onPick={(id) => {
            const next = new URLSearchParams(searchParams);
            if (id === "all" || id === activeFilter) next.delete("filter");
            else next.set("filter", id);
            setSearchParams(next, { replace: true });
          }}
        />
        {activeTag && (
          <div className="px-4 md:px-6 pt-3 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-klein text-canvas text-ui">
              #{activeTag}
              <button
                type="button"
                onClick={() => setTag(null)}
                aria-label={`清除标签筛选 ${activeTag}`}
                className="hover:opacity-80 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
            <span className="text-ui text-ink-muted">
              按标签筛选
            </span>
          </div>
        )}
        <div className="px-4 md:px-6 py-3 flex items-center gap-3">
          <span className="mono text-ui text-ink-muted">
            {loadingSessions
              ? "加载中…"
              : activeProjectId
                ? `本项目 ${visibleSessionCount} 个 · 共 ${sessions.length} 个`
                : `共 ${sessions.length} 个`}
          </span>
          {/* Previously had a "clear filter" button here — redundant now
              that the header title carries the project chip with its own
              inline × next to it. */}
        </div>

        {loadErr && (
          <div className="mx-4 md:mx-6 mb-3 flex items-center gap-2 rounded border border-danger/30 bg-danger-wash px-3 py-2 text-ui text-danger">
            <span className="min-w-0 flex-1 truncate">{loadErr}</span>
            <button
              type="button"
              onClick={() => setLoadErr(null)}
              aria-label="关闭"
              className="shrink-0 h-5 w-5 rounded-full flex items-center justify-center hover:bg-danger/10 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {loadingSessions && sessions.length === 0 ? (
          // Skeleton list on first paint — 3 greyed rows. Using the empty-state
          // card here would look identical to a genuine "no sessions" account
          // and confuse every freshly-loaded page.
          <div className="px-4 md:px-6 pb-6 space-y-2">
            <div className="h-[68px] rounded-lg bg-paper animate-pulse" />
            <div className="h-[68px] rounded-lg bg-paper animate-pulse" />
            <div className="h-[68px] rounded-lg bg-paper animate-pulse" />
          </div>
        ) : sessions.length === 0 && !loadingSessions ? (
          <div className="px-4 md:px-6 pb-6">
            <EmptyState onNew={() => setShowNew(true)} />
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="px-4 md:px-6 pb-6 text-ui text-ink-muted">
            {activeFilter === "all"
              ? "此项目中还没有会话。"
              : activeFilter === "scheduled"
                ? "还没有计划中的会话——设置一个例程,等例程与会话关联后就会显示在这里。"
                : activeFilter === "archived"
                  ? "没有归档的会话。"
                  : activeFilter === "running"
                    ? "目前没有运行中的会话。"
                    : activeFilter === "awaiting"
                      ? "目前没有等待处理的会话。"
                      : activeFilter === "mine"
                        ? "目前没有会话。"
                        : "目前没有会话。"}
          </div>
        ) : (
          <div className="pb-6 md:px-4 md:pt-2">
            {filteredGroups.map((g) => (
              <ProjectGroup
                key={g.projectId}
                project={g.project}
                projectId={g.projectId}
                sessions={g.sessions}
                expanded={expandedGroups.has(g.projectId)}
                onToggleExpanded={() => toggleGroup(g.projectId)}
                onPickTag={(name) => setTag(name)}
              />
            ))}
          </div>
        )}
      </section>

      {showNew && (
        <NewSessionSheet
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            navigate(`/session/${id}`);
          }}
        />
      )}
      {showProjects && (
        <ProjectsSheet onClose={() => setShowProjects(false)} />
      )}
      {showImport && (
        <ImportSessionsSheet
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            refreshSessions();
          }}
        />
      )}
      {showWsDiag && (
        <WsDiagPanel
          diag={wsDiag}
          onClose={() => setShowWsDiag(false)}
          restartDisabled={restartState === "running"}
          onRestart={() => {
            setShowWsDiag(false);
            setRestartState("running");
            setRestartError(null);
            restartServer().catch((e) => {
              setRestartState("failed");
              setRestartError(
                e instanceof Error
                  ? e.message
                  : "Timed out waiting for the server to come back up.",
              );
            });
          }}
        />
      )}
      {showSearchSheet && (
        <GlobalSearchSheet
          onClose={() => {
            setShowSearchSheet(false);
          }}
        />
      )}
      {showStats && <StatsSheet onClose={() => setShowStats(false)} />}
      {restartState !== "idle" && (
        <RestartOverlay
          state={restartState}
          error={restartError}
          onDismiss={() => {
            setRestartState("idle");
            setRestartError(null);
          }}
        />
      )}
    </AppShell>
  );
}

// Full-screen blocker shown while `restartServer()` is in flight. The helper
// polls /api/health and hard-reloads the page on success, so in the common
// path this overlay unmounts with the window — the user never sees it
// transition out. The "failed" branch exists for the 35s-timeout case
// (server stuck mid-restart, port not freed, etc.) — we surface the error
// and let the user dismiss back to the session list. Rendered as a plain
// fixed-position div rather than a sheet/portal so it paints above the
// bottom nav on mobile too.
function RestartOverlay({
  state,
  error,
  onDismiss,
}: {
  state: "running" | "failed";
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] bg-ink/50 backdrop-blur-sm flex items-center justify-center p-5">
      <div className="w-full max-w-sm rounded-xl border border-line bg-canvas shadow-lift p-5 space-y-3">
        {state === "running" ? (
          <>
            <div className="flex items-center gap-2.5">
              <RotateCcw className="w-4 h-4 text-ink-soft animate-spin" />
              <div className="text-ui-lg font-medium text-ink">
                正在重启服务器…
              </div>
            </div>
            <div className="text-ui text-ink-muted leading-relaxed">
              等待新进程就绪,随后页面将自动刷新。进行中的会话不受影响;任何正在执行的工具调用会显示为已中断。
            </div>
          </>
        ) : (
          <>
            <div className="text-ui-lg font-medium text-danger">
              重启失败
            </div>
            <div className="text-ui text-ink-muted mono break-words">
              {error ?? "等待服务器恢复超时。"}
            </div>
            <div className="pt-1 flex justify-end">
              <button
                type="button"
                onClick={onDismiss}
                className="h-8 px-3 rounded border border-line bg-canvas hover:bg-paper text-ui font-medium text-ink transition-colors"
              >
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Header overflow menu. Mobile-only — on desktop every action here has a
// direct icon button in the header, so we hide the trigger via `md:hidden`
// on the component root rather than rendering an empty popover. Keeps the
// mobile-only items (Import / Stats / Manage projects) one tap away from a
// 390px header that can't fit all three as icons.
function HeaderOverflowMenu({
  onImport,
  onStats,
  onProjects,
}: {
  onImport: () => void;
  onStats: () => void;
  onProjects: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative shrink-0 md:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多"
        className="h-9 w-9 rounded border border-line bg-canvas flex items-center justify-center hover:bg-paper transition-colors"
      >
        <MoreHorizontal className="w-4 h-4 text-ink-soft" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-30 w-[210px] rounded-lg border border-line bg-canvas shadow-lift p-1"
        >
          <button
            role="menuitem"
            onClick={() => pick(onImport)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-ui text-ink-soft hover:bg-paper/60 transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-ink-soft" />
            导入会话
          </button>
          <button
            role="menuitem"
            onClick={() => pick(onStats)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-ui text-ink-soft hover:bg-paper/60 transition-colors"
          >
            <BarChart3 className="w-3.5 h-3.5 text-ink-soft" />
            统计
          </button>
          <button
            role="menuitem"
            onClick={() => pick(onProjects)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-ui text-ink-soft hover:bg-paper/60 transition-colors"
          >
            <Settings2 className="w-3.5 h-3.5 text-ink-soft" />
            管理项目
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectGroup({
  project,
  projectId,
  sessions,
  expanded,
  onToggleExpanded,
  onPickTag,
}: {
  project: Project | null;
  projectId: string;
  sessions: Session[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onPickTag: (name: string) => void;
}) {
  // Each group is its own block so its header `sticky top-0` is scoped to
  // the group's vertical run — when you scroll past, the next project's
  // header takes over. The parent `<section>` is the scroll container.
  const displayName = project?.name ?? projectId.slice(0, 8);
  const path = project?.path ?? "";

  // Default-collapsed view: every non-idle session (awaiting / running /
  // error / cli_running) is always rendered regardless of count. Beyond
  // that, the visible list is padded with idle sessions up to a total
  // budget of 3 rows — so a group with 1 non-idle + 20 idle shows 1
  // non-idle + 2 idle (3 total), and a group with 5 non-idle + 20 idle
  // shows all 5 non-idle + 0 idle. Iterates in sort order (already
  // pinned-first + updatedAt desc) so display order is preserved.
  const { visibleSessions, hiddenCount } = useMemo(() => {
    if (expanded) {
      return { visibleSessions: sessions, hiddenCount: 0 };
    }
    const TOTAL_BUDGET = 3;
    const nonIdleCount = sessions.reduce(
      (n, s) => (s.status !== "idle" ? n + 1 : n),
      0,
    );
    const idleBudget = Math.max(0, TOTAL_BUDGET - nonIdleCount);
    const visible: Session[] = [];
    let idleShown = 0;
    for (const s of sessions) {
      if (s.status !== "idle") {
        visible.push(s);
      } else if (idleShown < idleBudget) {
        visible.push(s);
        idleShown++;
      }
    }
    return {
      visibleSessions: visible,
      hiddenCount: sessions.length - visible.length,
    };
  }, [sessions, expanded]);

  return (
    <div>
      <div className="sticky top-[45px] md:top-[53px] z-10 flex items-center gap-3 px-4 md:px-6 py-2 bg-paper/80 backdrop-blur border-b border-line">
        <span className="text-ui-heading font-medium">{displayName}</span>
        {path && (
          <span className="mono text-ui text-ink-muted truncate hidden md:inline">
            {path}
          </span>
        )}
        <span className="ml-auto mono text-ui text-ink-muted shrink-0">
          {sessions.length} 个会话
        </span>
      </div>
      <ul>
        {visibleSessions.map((s) => (
          <li key={s.id}>
            <SessionRow session={s} onPickTag={onPickTag} />
          </li>
        ))}
      </ul>
      {(hiddenCount > 0 || (expanded && sessions.length > 3)) && (
        <div className="px-4 md:px-6 py-2 border-b border-line bg-paper/40">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-line bg-canvas text-ui text-ink-soft hover:bg-paper transition-colors"
            aria-expanded={expanded}
            aria-controls={`project-group-${projectId}`}
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>收起</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>
                  展开 {hiddenCount} 个空闲会话
                </span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// Status pill text + style mapping. Mirrors the mockup (s-02 lines 523, 537,
// 555, 566, 584). `awaiting` keeps the quoted `#7a4700` color from the mockup.
function statusPillClass(status: string): string {
  switch (status) {
    case "running":
      return "border border-success/30 bg-success-wash text-success-ink";
    case "cli_running":
      return "border border-klein/30 bg-klein-wash text-klein-ink";
    case "awaiting":
      return "border border-warn/30 bg-warn-wash text-warn-ink";
    case "error":
      return "border border-danger/30 bg-danger-wash text-danger";
    case "archived":
    case "idle":
    default:
      return "border border-line bg-paper text-ink-muted";
  }
}
function statusPillLabel(status: string): string {
  switch (status) {
    case "awaiting":
      return "需要你处理";
    case "cli_running":
      return "被占用";
    case "running":
      return "运行中";
    case "error":
      return "出错";
    case "idle":
      return "空闲";
    case "archived":
      return "已归档";
    default:
      return status;
  }
}

function SessionRow({
  session: s,
  onPickTag,
}: {
  session: Session;
  onPickTag: (name: string) => void;
}) {
  const href = `/session/${s.id}`;
  const archived = s.status === "archived";
  const dotTone = STATUS_DOT[s.status] ?? "bg-ink-faint";
  const dotGlow = DOT_GLOW[s.status] ?? "";
  const rel = formatRel(s.lastMessageAt ?? s.updatedAt);
  // Branch: null comes back from the server for non-git projects or when
  // git rev-parse failed at session-creation time. Historical rows
  // (pre-migration 22 era) were always null for non-worktree sessions.
  // Render an em-dash placeholder in muted ink so the column clearly means
  // "no branch captured" rather than lying with a hard-coded "main".
  const branch = s.branch;
  const { linesAdded, linesRemoved, filesChanged, contextPct } = s.stats;
  // Inline delete confirm. Opened by the trailing trash button on the row;
  // anchored to the row itself (NOT a modal) so the user stays oriented in
  // the list. Escape closes. The Delete button is NOT autofocused — we don't
  // want a stray Enter to nuke a session on mobile keyboards.
  const forgetSession = useSessions((st) => st.forgetSession);
  const refreshSessions = useSessions((st) => st.refreshSessions);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirmOpen) return;
    const onDoc = (ev: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(ev.target as Node)) {
        setConfirmOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        setConfirmOpen(false);
      }
    };
    // mousedown so click on the row's <Link> still navigates after close —
    // but deletion via trash icon stops propagation so we don't race.
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [confirmOpen]);

  const openConfirm = (e: React.MouseEvent) => {
    // Critical: the row is a <Link> — without these two the trash click
    // would navigate to /session/:id before the popover can open.
    e.preventDefault();
    e.stopPropagation();
    setConfirmOpen(true);
  };

  const onDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (deleting) return;
    setDeleting(true);
    try {
      await api.deleteSession(s.id);
      forgetSession(s.id);
      toast("会话已删除");
      // Also refresh so grouped counts stay accurate.
      refreshSessions();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "delete_failed";
      toast(`删除失败: ${code}`);
      setDeleting(false);
      setConfirmOpen(false);
      return;
    }
    // Component will unmount on successful delete — no need to reset state.
  };
  // Up to 3 tag chips are rendered next to the title on desktop; mobile has
  // no room. Clicking a chip activates the `?tag=` filter on Home. The
  // chip intercepts the row's <Link> navigation via stopPropagation +
  // preventDefault so tapping a tag doesn't also open the session.
  const visibleTags = (s.tags ?? []).slice(0, 3);
  const extraTags = Math.max(0, (s.tags ?? []).length - visibleTags.length);
  const hasDiffs = linesAdded > 0 || linesRemoved > 0 || filesChanged > 0;
  // Progress ring geometry: r=9 → circumference ≈ 56.55. Dash offset
  // encodes remaining context. `running` shows an animated dot in place
  // of a ring (mockup s-02 line 533 uses animate-pulse on the dot; here
  // we keep the ring + pulse on the dot for visual consistency).
  const CIRC = 56.55;
  const pct = Math.max(0, Math.min(1, contextPct || 0));
  const dashoffset = CIRC * (1 - pct);
  const showRing = !archived && pct > 0;

  return (
    <div className="relative group/row">
      <Link
        to={href}
        className={cn(
          "block border-b border-line hover:bg-paper/40 cursor-pointer transition-ui-fast",
          archived && "opacity-75",
        )}
      >
      {/* Mobile stacked layout — mirrors mockup s-02 rows (lines 376-392):
          CAPS status line (dot + label + relative time) on top, title,
          optional last-user-message preview, then a single meta row that
          groups branch + diff stats on the left with the context ring
          pinned to the right. Model / permission-mode intentionally not
          shown here — they're visible inside the chat session once opened. */}
      <div className="md:hidden px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn("h-2 w-2 rounded-full shrink-0", dotTone, (s.status === "running" || s.status === "cli_running") && "animate-pulse")}
            style={dotGlow ? { boxShadow: dotGlow } : undefined}
          />
          <span className="text-ui caps text-ink-muted">
            {statusPillLabel(s.status)}
          </span>
          <span className="ml-auto text-ui text-ink-faint">{rel}</span>
          <button
            type="button"
            onClick={openConfirm}
            aria-label="删除会话"
            title="删除会话"
            className="md:hidden shrink-0 h-7 w-7 -my-1 -mr-1 flex items-center justify-center text-ink-faint active:text-danger"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2">
          {s.pinned && (
            <Pin
              className="w-3.5 h-3.5 text-klein-ink shrink-0"
              aria-label="已置顶"
            />
          )}
          <div className="text-ui-heading font-medium leading-snug truncate flex-1 min-w-0">
            {s.title || "Untitled"}
          </div>
        </div>
        {s.lastUserMessage && (
          <div className="text-ui text-ink-muted truncate mt-1">
            {s.lastUserMessage}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2 text-ui">
          <span className="mono text-ink-soft inline-flex items-center gap-1 truncate min-w-0">
            <GitBranch className="w-3 h-3 shrink-0" />
            {branch ?? <span className="text-ink-faint">—</span>}
          </span>
          {hasDiffs && (
            <span className="mono text-ink-muted shrink-0">
              <span className="text-success">+{linesAdded}</span>{" "}
              <span className="text-danger">−{linesRemoved}</span>
              {filesChanged > 0 && (
                <span className="opacity-70"> · {filesChanged}f</span>
              )}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {showRing ? (
              <svg width="20" height="20">
                <circle cx="10" cy="10" r="8" fill="none" stroke="rgb(var(--c-line))" strokeWidth="2.5" />
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  fill="none"
                  stroke="rgb(var(--c-klein))"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray="50.26"
                  strokeDashoffset={(50.26 * (1 - pct)).toString()}
                  transform="rotate(-90 10 10)"
                />
              </svg>
            ) : null}
          </span>
        </div>
      </div>

      {/* Desktop grid row */}
      <div className="hidden md:block px-5 py-3">
        <div className="grid grid-cols-[22px_minmax(0,1fr)_220px_150px_110px_48px] gap-4 items-center">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              dotTone,
              (s.status === "running" || s.status === "cli_running") && "animate-pulse",
            )}
            style={dotGlow ? { boxShadow: dotGlow } : undefined}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {s.pinned && (
                <Pin
                  className="w-3.5 h-3.5 text-klein-ink shrink-0"
                  aria-label="已置顶"
                />
              )}
              <span className="text-ui-lg font-medium truncate">
                {s.title || "无标题"}
              </span>
              {s.worktreePath && (
                <span className="text-ui caps text-ink-muted shrink-0">
                  工作树
                </span>
              )}
              {visibleTags.length > 0 && (
                <span className="hidden lg:flex items-center gap-1 shrink-0">
                  {visibleTags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onPickTag(t);
                      }}
                      className="inline-flex items-center px-1.5 h-5 rounded-full border border-line bg-paper text-ui-sm text-ink-soft hover:bg-klein-wash hover:text-klein-ink hover:border-klein/30 transition-colors"
                    >
                      #{t}
                    </button>
                  ))}
                  {extraTags > 0 && (
                    <span className="mono text-ui-sm text-ink-faint">
                      +{extraTags}
                    </span>
                  )}
                </span>
              )}
            </div>
            {/* Desktop: last sent user message preview, one line under the
                title. Same source as the mobile row — kept in sync via
                `previewUserMessage` on `user_message` WS frames. */}
            {s.lastUserMessage && (
              <div className="text-ui text-ink-muted truncate mt-0.5">
                {s.lastUserMessage}
              </div>
            )}
          </div>
          <div className="mono text-ui text-ink-soft truncate flex items-center gap-1.5">
            <GitBranch className="w-3 h-3 text-ink-faint shrink-0" />
            {branch ? (
              <span className="truncate">{branch}</span>
            ) : (
              <span className="text-ink-faint truncate">—</span>
            )}
          </div>
          <div className="mono text-ui text-ink-muted truncate">
            {hasDiffs ? (
              <>
                <span className="text-success">+{linesAdded}</span>{" "}
                <span className="text-danger">−{linesRemoved}</span>{" "}
                <span>· {filesChanged}f</span>
              </>
            ) : (
              <span className="text-ink-faint">无差异</span>
            )}
          </div>
          <div>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-ui-sm font-medium uppercase tracking-widest",
                statusPillClass(s.status),
              )}
            >
              {(s.status === "running" || s.status === "awaiting" || s.status === "cli_running") && (
                <span className={cn("h-1.5 w-1.5 rounded-full", dotTone)} />
              )}
              {statusPillLabel(s.status)}
            </span>
          </div>
          <div className="flex items-center justify-end">
            {showRing ? (
              <svg width="22" height="22">
                <circle
                  cx="11"
                  cy="11"
                  r="9"
                  fill="none"
                  stroke="rgb(var(--c-line))"
                  strokeWidth="2.5"
                />
                <circle
                  cx="11"
                  cy="11"
                  r="9"
                  fill="none"
                  stroke="rgb(var(--c-klein))"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={CIRC.toString()}
                  strokeDashoffset={dashoffset.toString()}
                  transform="rotate(-90 11 11)"
                />
              </svg>
            ) : null}
          </div>
        </div>
        {/* Compact meta row — model / permission mode intentionally dropped.
            Status pill carries the state signal and rel-time the recency;
            model + mode are surfaced inside the chat session, not here. */}
        <div className="mt-1.5 flex items-center gap-3 text-ui text-ink-muted">
          <span>{rel}</span>
        </div>
      </div>
    </Link>
      {/* Trailing quick-delete icon. Absolutely positioned so it overlays
          the row without breaking the Link's tap target. preventDefault +
          stopPropagation on click are critical — otherwise the row's
          <Link> navigates to /session/:id before the popover opens. */}
      <button
        type="button"
        onClick={openConfirm}
        aria-label="删除会话"
        title="删除会话"
        className={cn(
          // Desktop-only: absolutely positioned, hover-revealed. On mobile
          // the in-row trash button (below) is the affordance — an always-
          // visible absolute overlay covers the relative-time + context
          // ring and felt heavy.
          "hidden md:flex absolute top-3 right-3 h-8 w-8 rounded border border-line bg-canvas/95 shadow-card",
          "items-center justify-center text-ink-muted hover:text-danger hover:bg-danger-wash hover:border-danger/30 transition-colors",
          "md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100",
          confirmOpen && "md:opacity-100",
        )}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
      {confirmOpen && (
        <div
          ref={confirmRef}
          role="dialog"
          aria-label="确认删除会话"
          // Anchored below the trash button. Uses max-w so a long warning
          // still fits on a 390px viewport; z-30 to clear the sticky group
          // header (z-10) + filter rail (z-20) without going modal-tier.
          className="absolute right-2 md:right-3 top-11 md:top-12 z-30 w-[260px] rounded-lg border border-line bg-canvas shadow-lift p-3"
          onClick={(e) => {
            // Keep clicks inside the popover from bubbling up to the row's
            // <Link> (which would navigate and lose the confirm state).
            e.stopPropagation();
          }}
        >
          <div className="text-ui font-medium mb-1">删除会话?</div>
          <p className="text-ui text-ink-muted leading-snug">
            这将删除会话记录和工具运行结果,无法撤销。
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setConfirmOpen(false);
              }}
              disabled={deleting}
              className="h-8 px-3 rounded-sm border border-line bg-paper text-ui text-ink-soft hover:bg-canvas disabled:opacity-50 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="ml-auto h-8 px-3 rounded-sm bg-danger text-canvas text-ui font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {deleting ? "删除中…" : "删除"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong p-8 text-center">
      <div className="display text-ui-title-lg mb-2">还没有会话。</div>
      <p className="text-ui-lg text-ink-muted max-w-[42ch] mx-auto mb-5">
        让 claudex 指向此主机上的一个项目文件夹并开始会话。该文件夹将被信任——claudex 会让 claude 在其中执行操作。
      </p>
      <button
        onClick={onNew}
        className="inline-flex items-center gap-1.5 h-10 px-4 rounded bg-ink text-canvas text-ui-lg font-medium hover:bg-ink/90 transition-colors"
      >
        创建你的第一个会话
      </button>
    </div>
  );
}




function NewSessionSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  useFocusReturn();
  const loadSettings = useAppSettings((s) => s.load);
  const customModels = useCustomModels();
  const modelEntries = getAllModelEntries(customModels);
  useEffect(() => { loadSettings(); }, [loadSettings]);
  const NEW_PROJECT = "__new__";
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>(NEW_PROJECT);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<ModelId>("claude-opus-4-8");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [effort, setEffort] = useState<EffortLevel>(() =>
    defaultEffortForModel("claude-opus-4-8"),
  );
  const [userTouchedEffort, setUserTouchedEffort] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  // Worktree opt-in for the new session. Defaults derive from the selected
  // project's git state: git repo → on (the user runs multiple agents in
  // parallel and wants each session isolated on its own branch), non-git →
  // off (worktree: true against a non-git repo is a 400). A user toggle
  // below tracks `userTouchedWorktree` so our default-from-project logic
  // doesn't trample an explicit choice when the user flips projects.
  const [worktree, setWorktree] = useState<boolean>(false);
  const [userTouchedWorktree, setUserTouchedWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // When the target project is untrusted we pause here instead of creating
  // the session. The card below captures the user's explicit confirmation
  // before we flip the trust bit and proceed. Null = no pending trust step.
  const [trustPending, setTrustPending] = useState<Project | null>(null);
  // Refs for the bounded, scrollable project list and its currently-selected
  // card. On mount (once projects load) we nudge the preselected card into
  // view so the user doesn't stare at a list scrolled to the wrong spot.
  const projectListRef = useRef<HTMLDivElement | null>(null);
  const selectedProjectRef = useRef<HTMLLabelElement | null>(null);
  const newProjectRef = useRef<HTMLLabelElement | null>(null);
  const didInitialScroll = useRef(false);

  useEffect(() => {
    api.listProjects().then((r) => {
      setProjects(r.projects);
      if (r.projects.length > 0) setSelected(r.projects[0].id);
    });
  }, []);

  // Autoscroll the selected card into view inside the bounded list, but only
  // the first time the projects actually arrive — after that the user owns
  // the scroll position.
  useEffect(() => {
    if (didInitialScroll.current) return;
    if (projects.length === 0) return;
    const el = selectedProjectRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
    didInitialScroll.current = true;
  }, [projects]);

  // When the user switches to the "Add a new project" row, reveal the
  // inline form (which expands the card vertically) inside the scroller.
  useEffect(() => {
    if (selected !== NEW_PROJECT) return;
    const el = newProjectRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  // Derive the git-ness of the currently-selected project. For the
  // NEW_PROJECT row we can't know yet (the directory isn't added), so we
  // optimistically assume it might be one — the server will 400 if not and
  // the error surfaces below.
  const selectedProject = projects.find((p) => p.id === selected) ?? null;
  const selectedIsGitRepo =
    selected === NEW_PROJECT ? true : selectedProject?.isGitRepo ?? false;

  // Auto-pick a sensible worktree default when the project changes, but
  // never clobber an explicit user choice. Defaulting to ON for git repos
  // matches how this user runs claudex: multiple agents in parallel need
  // isolated checkouts, not a shared cwd.
  useEffect(() => {
    if (userTouchedWorktree) return;
    setWorktree(selectedIsGitRepo);
  }, [selectedIsGitRepo, userTouchedWorktree]);

  // Keep effort in sync with the chosen model. If the user hasn't picked a
  // custom level, we mirror the per-model default (Opus → xhigh, others
  // → high). If they have picked one, only clamp it when switching to a
  // model that doesn't support it (today: xhigh outside Opus → high).
  useEffect(() => {
    setEffort((prev) =>
      userTouchedEffort ? clampEffortForModel(model, prev) : defaultEffortForModel(model),
    );
  }, [model, userTouchedEffort]);

  /**
   * Resolve the project the user wants to spawn under — creating a new row
   * if the NEW_PROJECT radio is selected, or looking up the existing one.
   * Returns null on validation failure (err already set). Keeping this
   * separate from the trust step lets us funnel both "brand new project"
   * and "already-added but untrusted project" through the same confirm card.
   */
  async function resolveTargetProject(): Promise<Project | null> {
    if (selected === NEW_PROJECT) {
      const trimmedPath = projectPath.trim();
      if (!trimmedPath) {
        setErr("请为新项目填写一个绝对路径。");
        return null;
      }
      const trimmedName =
        projectName.trim() ||
        pathBasename(trimmedPath) ||
        "project";
      const p = await api.createProject({
        name: trimmedName,
        path: trimmedPath,
      });
      // Surface the new project in the in-memory list so subsequent renders
      // of this sheet (if the user re-opens after cancel) show it.
      setProjects((prev) => [p.project, ...prev]);
      return p.project;
    }
    return projects.find((p) => p.id === selected) ?? null;
  }

  async function spawnSession(projectId: string) {
    const trimmedTitle = title.trim();
    const res = await api.createSession({
      projectId,
      // Send the raw trimmed title or omit entirely — the server applies the
      // "Untitled" display default itself, and omitting here keeps the blank
      // title from bleeding into the worktree branch name (which would turn
      // every no-title session into a `claude/untitled` / `claude/untitled-…`
      // collision chain).
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
      model,
      mode,
      effort,
      worktree,
    });
    onCreated(res.session.id);
  }

  async function onPrimary() {
    setBusy(true);
    setErr(null);
    try {
      const project = await resolveTargetProject();
      if (!project) {
        setBusy(false);
        return;
      }
      if (!project.trusted) {
        // Pause on the trust card — don't spawn until the user confirms.
        setTrustPending(project);
        setBusy(false);
        return;
      }
      await spawnSession(project.id);
    } catch (e: any) {
      setErr(e?.code ?? e?.message ?? "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirmTrustAndCreate() {
    if (!trustPending) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.trustProject(trustPending.id, true);
      // Propagate the new trust state into the in-memory list so the card
      // doesn't reappear if the user creates a second session in this
      // sheet's lifetime.
      setProjects((prev) =>
        prev.map((p) => (p.id === res.project.id ? res.project : p)),
      );
      setTrustPending(null);
      await spawnSession(res.project.id);
    } catch (e: any) {
      setErr(e?.code ?? e?.message ?? "信任失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="new-session-sheet-title" className="w-full max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-overlay p-5">
        <div className="flex items-center mb-4">
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              新建会话
            </div>
            <h2 id="new-session-sheet-title" className="display text-ui-title-lg md:text-ui-display leading-tight mt-0.5">
              告诉 claude 在哪里工作。
            </h2>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              项目
            </div>
            <div
              ref={projectListRef}
              className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1"
            >
              {projects.map((p) => (
                <label
                  key={p.id}
                  ref={selected === p.id ? selectedProjectRef : undefined}
                  className={`flex items-center gap-3 px-3 py-2.5 border rounded cursor-pointer ${
                    selected === p.id
                      ? "border-klein bg-klein-wash/30"
                      : "border-line"
                  }`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    checked={selected === p.id}
                    onChange={() => setSelected(p.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-ui-lg font-medium">{p.name}</div>
                    <div className="mono text-ui text-ink-muted truncate">
                      {p.path}
                    </div>
                  </div>
                </label>
              ))}
              <label
                ref={newProjectRef}
                className={`block border rounded cursor-pointer ${
                  selected === NEW_PROJECT
                    ? "border-klein bg-klein-wash/30"
                    : "border-dashed border-line-strong"
                }`}
              >
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <input
                    type="radio"
                    className="sr-only"
                    checked={selected === NEW_PROJECT}
                    onChange={() => setSelected(NEW_PROJECT)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-ui-lg font-medium">
                      {projects.length > 0 ? "+ 添加新项目" : "添加你的第一个项目"}
                    </div>
                    <div className="text-ui text-ink-muted">
                      这台机器上任何你想让 claude 工作的目录。
                    </div>
                  </div>
                </div>
                {selected === NEW_PROJECT && (
                  <div className="px-3 pb-3 pt-1 space-y-2">
                    <input
                      className="w-full h-10 px-3 bg-canvas border border-line rounded text-ui-lg"
                      placeholder="名称 (例如:spindle)"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                    />
                    <div className="flex items-stretch gap-2">
                      <input
                        className="flex-1 min-w-0 h-10 px-3 bg-canvas border border-line rounded text-ui-lg mono"
                        placeholder="/Users/you/code/spindle 或 D:\Code\spindle"
                        value={projectPath}
                        onChange={(e) => setProjectPath(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        className="h-10 px-3 rounded border border-line bg-paper text-ui text-ink-soft hover:bg-canvas inline-flex items-center gap-1 transition-colors"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        浏览
                      </button>
                    </div>
                    <div className="text-ui text-ink-muted">
                      必须是主机上已存在的绝对路径。
                      {projectName.trim().length === 0 && projectPath.trim().length > 0 &&
                        " (名称默认使用文件夹名。)"}
                    </div>
                  </div>
                )}
              </label>
            </div>
          </div>

          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              标题 (可选)
            </div>
            <input
              className="w-full h-10 px-3 bg-canvas border border-line rounded text-ui-lg"
              placeholder="修复 /pricing 上的水合问题"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            {modelEntries.map((m) => (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
                className={`h-10 rounded text-ui font-medium border ${
                  model === m.id
                    ? "border-ink bg-canvas"
                    : "border-line bg-paper text-ink-muted"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              权限模式
            </div>
            <div className="grid grid-cols-4 gap-1 p-1 bg-paper border border-line rounded">
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
                  onClick={() => setMode(id)}
                  className={`h-9 rounded-sm text-ui font-medium ${
                    mode === id
                      ? "bg-canvas shadow-card border border-line text-ink"
                      : "text-ink-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              思考力度
            </div>
            <div className="grid grid-cols-5 gap-1 p-1 bg-paper border border-line rounded">
              {(
                [
                  ["low", "低"],
                  ["medium", "中"],
                  ["high", "高"],
                  ["xhigh", "超高"],
                  ["max", "最大"],
                ] as Array<[EffortLevel, string]>
              ).map(([id, label]) => {
                const supported = effortSupportedOnModel(model, id);
                return (
                  <button
                    key={id}
                    disabled={!supported}
                    title={
                      supported
                        ? undefined
                        : "超高仅在 Opus 4.7 上可用。"
                    }
                    onClick={() => {
                      setUserTouchedEffort(true);
                      setEffort(id);
                    }}
                    className={`h-9 rounded-sm text-ui font-medium disabled:opacity-40 disabled:cursor-not-allowed ${
                      effort === id
                        ? "bg-canvas shadow-card border border-line text-ink"
                        : "text-ink-muted"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Worktree — isolate the session on its own branch under
              <project>/.claude/worktrees/<sessionId>. Defaults to ON for
              git projects because the user runs many agents in parallel
              and each one needs its own checkout to avoid stepping on the
              others; greyed out (and forced off) for non-git projects so
              the server doesn't 400 `not_a_git_repo`. For a brand-new
              project (NEW_PROJECT row) we can't probe the filesystem yet,
              so we leave the toggle enabled with an optimistic default
              and let the server be the source of truth. */}
          <div>
            <label
              className={`flex items-start gap-3 p-3 border rounded transition-colors ${
                selectedIsGitRepo
                  ? "border-line cursor-pointer hover:bg-canvas transition-colors"
                  : "border-line bg-paper opacity-60 cursor-not-allowed"
              }`}
            >
              <span className="relative inline-flex shrink-0 items-center mt-0.5">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={worktree && selectedIsGitRepo}
                  disabled={!selectedIsGitRepo}
                  onChange={(e) => {
                    setUserTouchedWorktree(true);
                    setWorktree(e.target.checked);
                  }}
                />
                <span
                  aria-hidden
                  className="block h-5 w-9 rounded-full bg-line-strong transition-colors peer-checked:bg-klein peer-focus-visible:ring-2 peer-focus-visible:ring-klein/40 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-canvas"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-0.5 -translate-y-1/2 h-4 w-4 rounded-full bg-canvas shadow-card ring-1 ring-black/5 transition-transform peer-checked:translate-x-4"
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-ui-lg font-medium">
                  使用 git 工作树
                </div>
                <div className="text-ui text-ink-muted mt-0.5">
                  {selectedIsGitRepo
                    ? "在 .claude/worktrees/ 下的新 claude/<slug> 分支上创建会话,避免并行代理互相干扰。"
                    : selected === NEW_PROJECT
                    ? "项目添加后,如果是 git 仓库则可用。"
                    : "项目不是 git 仓库——无法使用工作树隔离。"}
                </div>
              </div>
            </label>
          </div>
        </div>

        {err && (
          <div className="mt-3 text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}

        <button
          onClick={onPrimary}
          disabled={busy}
          className="mt-4 w-full h-12 rounded bg-ink text-canvas font-medium hover:bg-ink/90 transition-colors disabled:opacity-50"
        >
          {busy ? "创建中…" : "开始会话"}
        </button>
      </div>
      {trustPending && (
        <TrustConfirmCard
          project={trustPending}
          busy={busy}
          err={err}
          onCancel={() => {
            // Dismiss the trust card without creating the session. The
            // project stays in the list (we don't roll back `createProject`
            // on cancel — having an untrusted row lying around is fine; the
            // user can either confirm next time or delete it from
            // Settings → Security).
            setTrustPending(null);
            setErr(null);
          }}
          onConfirm={confirmTrustAndCreate}
        />
      )}
      {pickerOpen && (
        <FolderPicker
          initialPath={projectPath.trim() || undefined}
          onPick={(abs) => {
            setProjectPath(abs);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

// Confirm card shown when the selected project is untrusted. claudex's rule:
// no session spawns under a project until the user has explicitly okayed
// claude touching files in that folder. The card is nested inside the
// NewSessionSheet overlay (z-50 on top of z-40) so dismissing it returns
// the user to the sheet with their model/mode selection intact.
function TrustConfirmCard({
  project,
  busy,
  err,
  onCancel,
  onConfirm,
}: {
  project: Project;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useFocusReturn();
  return (
    <div className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="trust-folder-modal-title" className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-overlay p-5">
        <div className="caps text-ink-muted">安全</div>
        <h2 id="trust-folder-modal-title" className="display text-ui-title-lg md:text-ui-display leading-tight mt-0.5">
          信任此文件夹?
        </h2>
        <div className="mt-3 rounded border border-line bg-paper px-3 py-2">
          <div className="text-ui font-medium truncate">{project.name}</div>
          <div className="mono text-ui text-ink-muted break-all">
            {project.path}
          </div>
        </div>
        <p className="mt-3 text-ui text-ink-muted leading-relaxed">
          claudex 会让 claude 在此文件夹内运行 shell 命令并编辑文件。只信任你所属的文件夹。
        </p>
        {err && (
          <div className="mt-3 text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-11 px-4 rounded border border-line bg-paper text-ui-lg disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 h-11 rounded bg-ink text-canvas text-ui-lg font-medium hover:bg-ink/90 transition-colors disabled:opacity-50"
          >
            {busy ? "信任中…" : "信任并继续"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRel(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Math.round((now - then) / 1000));
  // Sub-minute precision — sessions that flipped to idle seconds ago
  // shouldn't read identical to sessions idle for almost a minute.
  if (diff < 3) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function WsDiagPanel({
  diag,
  onClose,
  onRestart,
  restartDisabled,
}: {
  diag: import("@/api/ws").WsDiagnostics;
  onClose: () => void;
  onRestart: () => void;
  restartDisabled: boolean;
}) {
  useFocusReturn();
  // Two-step confirmation rendered inline, not via window.confirm: the
  // native dialog is ugly on mobile Safari, blocks the whole page, and
  // looks out of place next to claudex's own UI. State is local to the
  // panel — once the user picks "Yes, restart now" we hand off to the
  // parent's onRestart (which kicks off restartServer + shows the
  // full-screen RestartOverlay) and this panel unmounts with us.
  const [confirming, setConfirming] = useState(false);
  const rows: Array<[string, string]> = [
    ["状态", diag.phase],
    ["尝试次数", String(diag.attempts)],
    ["重连时间", diag.reconnectIn ? `${diag.reconnectIn}ms` : "—"],
    [
      "最近帧时间",
      diag.lastFrameAt
        ? `${Math.round((Date.now() - diag.lastFrameAt) / 1000)}秒前`
        : "—",
    ],
    ["关闭码", diag.lastCloseCode ? String(diag.lastCloseCode) : "—"],
    ["关闭原因", diag.lastCloseReason || "—"],
    ["最后的错误", diag.lastError || "—"],
    [
      "地址",
      typeof location !== "undefined"
        ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`
        : "?",
    ],
    [
      "浏览器标识",
      typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 90) : "?",
    ],
  ];
  return (
    <div className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="ws-diag-title" className="w-full sm:max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-overlay p-4">
        <div className="flex items-center mb-3">
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              WebSocket
            </div>
            <div id="ws-diag-title" className="display text-[1.1rem] leading-tight">
              连接诊断
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>
        <dl className="mono text-ui divide-y divide-line">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center gap-3 py-1.5">
              <dt className="text-ink-muted w-32 shrink-0">{k}</dt>
              <dd className="min-w-0 flex-1 break-all text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 pt-3 border-t border-line">
          <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
            管理
          </div>
          {confirming ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onRestart();
                }}
                className="h-9 px-3.5 rounded bg-danger text-canvas text-ui font-medium hover:opacity-90 transition-opacity"
              >
                是,立即重启
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="h-9 px-3.5 rounded border border-line bg-canvas hover:bg-paper text-ui text-ink transition-colors"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={restartDisabled}
              className="inline-flex items-center gap-2 h-9 px-3.5 rounded border border-line bg-canvas hover:bg-paper text-ui font-medium text-ink disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 text-ink-soft" />
              重启服务器
            </button>
          )}
          <div className="mt-2 text-ui text-ink-muted">
            进行中的会话不受影响——记录都在磁盘上——但任何正在执行的工具调用会显示为已中断。
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectsSheet({ onClose }: { onClose: () => void }) {
  useFocusReturn();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [shakeId, setShakeId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.listProjects();
      setProjects(r.projects);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(id: string) {
    setErr(null);
    const name = editingName.trim();
    if (!name) {
      // Empty name → shake the input + toast. We don't use the top-level err
      // banner for this so the visual feedback lives right next to the input.
      setShakeId(id);
      window.setTimeout(() => setShakeId(null), 340);
      toast("名称不能为空");
      return;
    }
    try {
      await api.updateProject(id, { name });
      setEditingId(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "更新失败");
    }
  }

  async function remove(p: Project) {
    setErr(null);
    if (
      !confirm(
        `删除项目 "${p.name}"?其下的会话不会被删除,仅删除项目引用。`,
      )
    ) {
      return;
    }
    try {
      await api.deleteProject(p.id);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "has_sessions") {
        setErr(
          `无法删除 "${p.name}"——它仍包含会话。请先归档或删除这些会话。`,
        );
      } else {
        setErr(e instanceof ApiError ? e.code : "删除失败");
      }
    }
  }

  async function cleanupEmpty() {
    setErr(null);
    if (
      !confirm(
        "删除所有没有会话的项目?会话不受影响;仅删除零会话的项目引用。",
      )
    ) {
      return;
    }
    setCleaning(true);
    try {
      const r = await api.cleanupEmptyProjects();
      await refresh();
      toast(
        r.removed === 0
          ? "没有可清理的空项目"
          : `已移除 ${r.removed} 个空项目`,
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "清理失败");
    } finally {
      setCleaning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="projects-sheet-title" className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-overlay flex flex-col max-h-[90vh]">
        <div className="flex items-center p-4 border-b border-line">
          <div className="min-w-0">
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              项目
            </div>
            <h2 id="projects-sheet-title" className="display text-ui-title-lg md:text-ui-display leading-tight mt-0.5">
              管理 claude 可工作的位置。
            </h2>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {projects.length > 0 && (
              <Button
                size="md"
                onClick={cleanupEmpty}
                disabled={cleaning || loading}
                title="删除所有没有会话的项目"
                className="w-8 sm:w-auto justify-center !px-0 sm:!px-2.5 whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline">{cleaning ? "清理中…" : "清理空项目"}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="md"
              onClick={onClose}
              className="w-8 justify-center !px-0"
            >
              ✕
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-ui text-ink-muted text-center py-10 mono">
              加载中…
            </div>
          ) : projects.length === 0 ? (
            <div className="text-ui text-ink-muted text-center py-10">
              还没有项目。在"新建会话"面板中添加一个。
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {projects.map((p) => (
                <li key={p.id} className="px-4 py-3">
                  {editingId === p.id ? (
                    <div className="space-y-2">
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") save(p.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className={cn(
                          "w-full h-10 px-3 bg-canvas border border-line rounded text-ui-lg",
                          shakeId === p.id && "animate-shake",
                        )}
                      />
                      <div className="mono text-ui text-ink-muted truncate">
                        {p.path}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => save(p.id)}
                          className="flex-1 h-9 rounded bg-ink text-canvas text-ui font-medium hover:bg-ink/90 transition-colors"
                        >
                          保存
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="h-9 px-3 rounded border border-line text-ui"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-ui-lg font-medium">{p.name}</div>
                        <div className="mono text-ui text-ink-muted truncate">
                          {p.path}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setEditingId(p.id);
                          setEditingName(p.name);
                          setErr(null);
                        }}
                        title="重命名"
                        className="h-8 w-8 rounded border border-line flex items-center justify-center text-ink-soft hover:bg-paper transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => remove(p)}
                        title="删除"
                        className="h-8 w-8 rounded border border-line flex items-center justify-center text-danger hover:bg-danger-wash transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && (
          <div
            className={cn(
              "m-3 text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30",
            )}
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChipRail({
  active,
  counts,
  onPick,
}: {
  active: FilterId;
  counts: { all: number; running: number; awaiting: number };
  onPick: (id: FilterId) => void;
}) {
  const chips: Array<{
    id: FilterId;
    label: string;
    count?: number;
    dot?: "running" | "awaiting";
    disabled?: boolean;
    title?: string;
  }> = [
    { id: "all", label: "全部", count: counts.all },
    { id: "running", label: "运行中", dot: "running" },
    {
      id: "awaiting",
      label: "需要处理",
      count: counts.awaiting || undefined,
      dot: "awaiting",
    },
    {
      id: "scheduled",
      label: "计划中",
      disabled: true,
      title: "一旦例程与会话关联,计划中的会话就会显示在这里",
    },
    {
      id: "mine",
      label: "我的",
      disabled: true,
      title: "单用户安装——所有会话都属于你",
    },
    { id: "archived", label: "已归档" },
  ];

  return (
    <div className="sticky top-0 z-20 bg-canvas/95 backdrop-blur border-b border-line px-4 md:px-6 py-2 md:py-3">
      <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap -mx-1 px-1">
        {chips.map((c) => {
          const isActive = active === c.id;
          const base = cn(
            "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-ui transition-colors shrink-0",
            isActive
              ? "bg-ink text-canvas border-ink"
              : "bg-canvas text-ink-soft border-line hover:bg-paper transition-colors",
            c.disabled && "opacity-60 pointer-events-none",
          );
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c.id)}
              title={c.title}
              className={base}
              aria-pressed={isActive}
            >
              {c.dot === "running" && (
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full shrink-0",
                    isActive ? "bg-canvas" : "bg-success",
                    !isActive && "animate-pulse",
                  )}
                />
              )}
              {c.dot === "awaiting" && (
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full shrink-0",
                    isActive ? "bg-canvas" : "bg-warn",
                  )}
                />
              )}
              <span>{c.label}</span>
              {typeof c.count === "number" && (
                <span
                  className={cn(
                    "mono text-ui -mr-0.5",
                    isActive ? "text-canvas/80" : "text-ink-muted",
                  )}
                >
                  {c.count}
                </span>
              )}
            </button>
          );
        })}
        <span className="ml-auto caps text-ink-muted hidden sm:inline pl-2 shrink-0">
          按项目分组
        </span>
      </div>
    </div>
  );
}
