import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bell,
  BarChart3,
  Calendar,
  Check,
  FolderTree,
  ListOrdered,
  MessageSquare,
  Settings as SettingsIcon,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { useAuth } from "@/state/auth";
import { useSessions } from "@/state/sessions";
import { useAlerts } from "@/state/alerts";
import { api } from "@/api/client";
import type { Project } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { toast, ToastHost } from "@/lib/toast";

// ---------------------------------------------------------------------------
// AppShell — the global navigation frame for all non-chat, non-login screens.
//
// Mobile: fixed bottom tab bar (h-58px). Four tabs: Sessions / Routines /
//         Alerts / Settings, mirroring mockup lines 431-436.
// Desktop: left sidebar (w-260px) with logo, nav list, divider, Projects
//         list, and a pinned user profile card. Mirrors mockup lines 449-477.
//
// Chat and Login do NOT use AppShell — they're full-viewport screens. The
// Chat screen in particular needs every vertical pixel for its transcript
// and the composer stuck to the bottom.
// ---------------------------------------------------------------------------

export type ShellTab =
  | "sessions"
  | "routines"
  | "files"
  | "queue"
  | "alerts"
  | "usage"
  | "settings";

interface NavItem {
  id: ShellTab;
  label: string;
  icon: typeof MessageSquare;
  href: string;
}

// "Usage" sits below Alerts and above Settings — a secondary navigation slot.
// Mobile keeps the four-tab bar as-is (Usage is desktop-focused); see the
// MobileTabBar below.
//
// "Subagents" (Bot icon) is a read-only observability feed of the SDK's
// `Task` / `Agent` / `Explore` tool invocations — it sits between Queue and
// Alerts so "what claude is delegating" reads next to "what's queued" and
// "what needs me".
const NAV: NavItem[] = [
  { id: "sessions", label: "会话", icon: MessageSquare, href: "/sessions" },
  { id: "routines", label: "例程", icon: Calendar, href: "/routines" },
  { id: "files", label: "文件", icon: FolderTree, href: "/files" },
  { id: "queue", label: "队列", icon: ListOrdered, href: "/queue" },
  { id: "alerts", label: "提醒", icon: Bell, href: "/alerts" },
  { id: "usage", label: "用量", icon: BarChart3, href: "/usage" },
  { id: "settings", label: "设置", icon: SettingsIcon, href: "/settings" },
];

// Mobile tab bar keeps a compact set — Usage drops off to the desktop sidebar
// (it's an analytics surface where horizontal space matters) and Queue drops
// off on mobile too so the 5-tab thumb rail reads cleanly: Sessions / Routines
// / Files / Alerts / Settings. Queue stays reachable via the desktop sidebar
// and direct /queue links; batch-from-couch still works, just from a link
// rather than a bottom tab.
const MOBILE_NAV = NAV.filter((n) => n.id !== "usage" && n.id !== "queue");

export function AppShell({
  tab,
  children,
}: {
  tab: ShellTab;
  children: React.ReactNode;
}) {
  // Alerts badge count comes from the persistent alerts store (migration
  // 20 + Zustand slice in @/state/alerts). Counting unseen rows gives us
  // the right-sized red dot: rows the user has already looked at (seenAt
  // set) don't drive the badge even if the underlying condition is still
  // active, and rows that were resolved but never seen still count (the
  // user should know the thing happened, even if it's already cleared).
  //
  // Fetched once on shell mount; kept fresh by the `alerts_update` WS
  // frame handler in @/state/sessions. Falls back to `0` on first paint
  // before the initial REST round-trip lands — that's fine, the badge
  // just lights up a beat later.
  const unseenCount = useAlerts((s) => s.unseenCount);
  const fetchAlerts = useAlerts((s) => s.fetchAlerts);
  useEffect(() => {
    void fetchAlerts();
  }, [fetchAlerts]);
  const alertCount = unseenCount;

  return (
    <div className="h-[100dvh] bg-canvas flex md:flex-row flex-col overflow-hidden">
      {/* Desktop sidebar — hidden below md; Chat never renders this because
          Chat bypasses AppShell entirely. Fixed-width column that does not
          scroll with the content; its own Projects list scrolls internally. */}
      <DesktopSidebar tab={tab} alertCount={alertCount} />

      {/* Main column. `min-h-0` + `overflow-hidden` + `flex-col` make this the
          pass-through flex container whose inner `<section flex-1 min-h-0
          overflow-y-auto>` becomes the actual scroll surface — so desktop
          sidebar and mobile bottom tab bar stay fixed while the list scrolls
          underneath. The bottom padding on mobile is to keep the tab bar from
          covering the tail of the content — plus `env(safe-area-inset-bottom)`
          so the iOS home indicator doesn't eat the last row. */}
      <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden pb-[calc(58px+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </main>

      {/* Mobile bottom tab bar. Fixed so it stays visible while the content
          scrolls; `pb-[env(safe-area-inset-bottom)]` keeps clear of the iOS
          home indicator. */}
      <MobileTabBar tab={tab} alertCount={alertCount} />

      {/* Toast host — mounted at the shell so sheets and inline editors on
          any non-chat screen (Home's ProjectsSheet rename, sidebar project
          rename) can surface transient messages without each screen having
          to wire its own host. */}
      <ToastHost />
    </div>
  );
}

function DesktopSidebar({ tab, alertCount }: { tab: ShellTab; alertCount: number }) {
  const { user, logout } = useAuth();
  const { sessions } = useSessions();
  const [projects, setProjects] = useState<Project[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeProjectId = searchParams.get("project");

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects);
      })
      .catch(() => {
        /* best-effort — sidebar without projects still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-project session counts so the sidebar rows show a live number.
  const countsByProject = new Map<string, number>();
  for (const s of sessions) {
    countsByProject.set(s.projectId, (countsByProject.get(s.projectId) ?? 0) + 1);
  }

  // Clicking a project row filters the Sessions screen to that project via a
  // `?project=<id>` query param. "All projects" clears the filter. We stay on
  // whatever route we're already on if the user is on Sessions; otherwise
  // jump to Sessions. Keeping the nav simple — no drill-in page for projects
  // yet.
  const goToProject = (projectId: string | null) => {
    const target =
      projectId === null ? "/sessions" : `/sessions?project=${projectId}`;
    navigate(target);
  };

  // Optimistic local-state patch on rename success so the sidebar reflects
  // the new name without waiting for a re-fetch. The PATCH endpoint already
  // audits the change; we just mirror the new value in-memory.
  const applyRenamed = (next: Project) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === next.id ? next : p)),
    );
  };

  return (
    <aside className="hidden md:flex border-r border-line surface-raised w-[260px] flex-col shrink-0">
      <Link
        to="/sessions"
        aria-label="前往会话"
        className="p-5 flex items-center gap-2.5 rounded-sm hover:bg-canvas/60 transition-ui-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-klein/40"
      >
        <Logo className="w-5 h-5" />
        <span className="mono text-ui-lg font-bold tracking-tight">Claudex</span>
      </Link>

      <div className="px-3 space-y-0.5">
        {NAV.map(({ id, label, icon: Icon, href }) => {
          const active = tab === id;
          const count =
            id === "sessions"
              ? sessions.length
              : id === "alerts" && alertCount > 0
                ? alertCount
                : undefined;
          const countTone =
            id === "alerts" && alertCount > 0
              ? "bg-danger text-canvas"
              : "text-ink-muted";
          return (
            <Link
              key={id}
              to={href}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-ui transition-ui-fast",
                active
                  ? "bg-canvas shadow-raised border border-line text-ink font-medium"
                  : "text-ink-soft hover:bg-canvas/60 border border-transparent transition-colors",
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
              {typeof count === "number" && (
                <span
                  className={cn(
                    "ml-auto mono text-ui-sm rounded-full px-1.5 py-0.5 leading-none",
                    countTone,
                  )}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      <div className="mx-3 my-4 h-px bg-line" />

      <div className="px-4 text-ui-sm uppercase tracking-widest text-ink-muted font-medium mb-2">项目</div>
      <div className="px-3 space-y-0.5 overflow-y-auto flex-1 min-h-0">
        <button
          type="button"
          onClick={() => goToProject(null)}
          className={cn(
            "w-full flex items-center gap-2 px-3 h-8 rounded-lg text-left transition-ui-fast",
            tab === "sessions" && !activeProjectId
              ? "bg-canvas shadow-card border border-line text-ink"
              : "hover:bg-canvas/60 border border-transparent transition-colors",
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-ink-faint shrink-0" />
          <span className="mono text-ui text-ink-soft truncate">
            全部项目
          </span>
          <span className="ml-auto text-ui-sm text-ink-muted mono">
            {sessions.length}
          </span>
        </button>
        {projects.length === 0 ? (
          <div className="px-2.5 text-ui text-ink-muted">
            还没有项目。
          </div>
        ) : (
          projects.map((p) => {
            const active = tab === "sessions" && activeProjectId === p.id;
            return (
              <SidebarProjectRow
                key={p.id}
                project={p}
                active={active}
                count={countsByProject.get(p.id) ?? 0}
                editing={editingId === p.id}
                onOpen={() => goToProject(p.id)}
                onStartEdit={() => setEditingId(p.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaved={(next) => {
                  applyRenamed(next);
                  setEditingId(null);
                }}
              />
            );
          })
        )}
      </div>

      <div className="mt-auto p-4 border-t border-line flex items-center gap-3">
        <div className="h-9 w-9 rounded-full bg-ink text-canvas flex items-center justify-center text-ui font-medium">
          {user?.username?.[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium truncate">
            {user?.username ?? "—"}
          </div>
          <div className="text-ui-sm text-ink-muted truncate">两步验证已开启</div>
        </div>
        <button
          onClick={() => logout()}
          title="退出登录"
          className="text-ui-sm text-ink-muted hover:text-ink transition-ui-fast"
        >
          退出登录
        </button>
      </div>
    </aside>
  );
}

// Sidebar project row. Default state: clickable pill that filters the Sessions
// list to this project. Double-click (desktop) or long-press ~600ms (touch
// devices with the sidebar visible, e.g. iPads) on the name flips the row
// into an inline <input> editor preloaded with the current name.
//
// - Enter saves, Escape cancels. A small Check button sits beside the input
//   to commit on touch where there's no Enter key in the default on-screen
//   keyboard layout.
// - Empty name → the input briefly shakes and we toast "Name can't be empty".
// - Save hits PATCH /api/projects/:id; success updates local state in-place
//   (the server already writes an audit row).
function SidebarProjectRow({
  project,
  active,
  count,
  editing,
  onOpen,
  onStartEdit,
  onCancelEdit,
  onSaved,
}: {
  project: Project;
  active: boolean;
  count: number;
  editing: boolean;
  onOpen: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (next: Project) => void;
}) {
  const [draft, setDraft] = useState(project.name);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  useEffect(() => {
    if (editing) {
      setDraft(project.name);
      // Focus + select-all next tick so the user can type-replace immediately.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, project.name]);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const triggerShake = () => {
    setShake(true);
    window.setTimeout(() => setShake(false), 340);
  };

  const save = async () => {
    const name = draft.trim();
    if (!name) {
      triggerShake();
      toast("名称不能为空");
      inputRef.current?.focus();
      return;
    }
    if (name === project.name) {
      onCancelEdit();
      return;
    }
    setBusy(true);
    try {
      const r = await api.updateProject(project.id, { name });
      onSaved(r.project);
    } catch {
      toast("重命名失败");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div
        className={cn(
          "w-full flex items-center gap-1.5 px-2.5 h-7 rounded-sm",
          "bg-canvas border border-line",
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-klein shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelEdit();
            }
          }}
          onBlur={(e) => {
            // Don't cancel if focus moved to the Check button — that click
            // fires save() via its own onMouseDown.
            const next = e.relatedTarget as HTMLElement | null;
            if (next?.dataset.role === "rename-commit") return;
            onCancelEdit();
          }}
          disabled={busy}
          aria-label={`重命名 ${project.name}`}
          className={cn(
            "flex-1 min-w-0 bg-transparent outline-none mono text-ui text-ink",
            shake && "animate-shake",
          )}
        />
        <button
          type="button"
          data-role="rename-commit"
          onMouseDown={(e) => {
            // mouseDown (not onClick) so the input's onBlur sees this as the
            // relatedTarget and skips the cancel branch.
            e.preventDefault();
            void save();
          }}
          title="保存"
          aria-label="保存重命名"
          disabled={busy}
          className="shrink-0 h-5 w-5 rounded-xs border border-line bg-paper flex items-center justify-center text-ink-soft hover:bg-canvas disabled:opacity-50 transition-colors"
        >
          <Check className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        // Swallow the click that follows a long-press "flip to edit" — the
        // long-press opened the editor, the synthetic click shouldn't also
        // trigger navigation.
        if (longPressFired.current) {
          longPressFired.current = false;
          return;
        }
        onOpen();
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onStartEdit();
      }}
      onTouchStart={() => {
        longPressFired.current = false;
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          longPressFired.current = true;
          onStartEdit();
        }, 600);
      }}
      onTouchEnd={clearLongPress}
      onTouchMove={clearLongPress}
      onTouchCancel={clearLongPress}
      className={cn(
        "w-full flex items-center gap-2 px-3 h-8 rounded-lg text-left select-none transition-ui-fast",
        active
          ? "bg-canvas shadow-card border border-line text-ink"
          : "hover:bg-canvas/60 border border-transparent transition-colors",
      )}
      title={`${project.path}\n双击以重命名`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-klein shrink-0" />
      <span className="mono text-ui text-ink-soft truncate">
        {project.name}
      </span>
      <span className="ml-auto text-ui-sm text-ink-muted mono">{count}</span>
    </button>
  );
}

function MobileTabBar({ tab, alertCount }: { tab: ShellTab; alertCount: number }) {
  const navigate = useNavigate();
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-line bg-canvas/95 backdrop-blur flex items-center justify-around px-2"
      style={{
        // `h-[58px]` used to be the height, but with box-sizing: border-box
        // the safe-area padding ate into it — on notched phones the content
        // area shrunk to ~23px and the icons overflowed UP through the
        // border-t. min-height w/ calc() guarantees 58px of CONTENT room
        // even when safe-area is 34px (iPhone home indicator).
        minHeight: "calc(58px + env(safe-area-inset-bottom))",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {MOBILE_NAV.map(({ id, label, icon: Icon, href }) => {
        const active = tab === id;
        const showBadge = id === "alerts" && alertCount > 0;
        return (
          <button
            key={id}
            type="button"
            onClick={() => navigate(href)}
            className={cn(
              "flex flex-col items-center gap-0.5 px-3 py-1",
              active ? "text-ink" : "text-ink-muted",
            )}
            aria-current={active ? "page" : undefined}
          >
            <span className="relative">
              <Icon className="w-4 h-4" />
              {showBadge && (
                <span
                  aria-label={`${alertCount} 条提醒`}
                  className={cn(
                    "absolute -top-1 -right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-danger text-canvas text-ui-sm font-medium",
                    "flex items-center justify-center leading-none",
                  )}
                >
                  {alertCount > 9 ? "9+" : alertCount}
                </span>
              )}
            </span>
            <span className="text-ui-sm font-medium">{label}</span>
            {/* Active indicator. Rendered as a transparent placeholder for
                inactive tabs so every button has the same content height —
                otherwise the nav's `items-center` would shift the active
                column down by 3px + gap-0.5 relative to its neighbors,
                producing the visual "border misalignment" users see. */}
            <span
              aria-hidden="true"
              className={cn(
                "h-[3px] w-8 rounded-full",
                active ? "bg-klein" : "bg-transparent",
              )}
            />
          </button>
        );
      })}
    </nav>
  );
}
