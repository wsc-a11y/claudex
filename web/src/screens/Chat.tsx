import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitCompareArrows,
  GitFork,
  ListChecks,
  Loader2,
  MessageCircle,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Settings2,
  StopCircle,
  Terminal,
  Brain,
  X,
} from "lucide-react";
import { ChatSessionsRail } from "@/components/ChatSessionsRail";
import { Logo } from "@/components/Logo";
import { ChatTasksRail } from "@/components/ChatTasksRail";
import { TasksDrawer } from "@/components/TasksDrawer";
import { PlanStrip } from "@/components/PlanStrip";
import { SubagentsStrip } from "@/components/SubagentsStrip";
import { PlanSheet } from "@/components/PlanSheet";
import { SubagentsSheet } from "@/components/SubagentsSheet";
import { selectLatestTodos } from "@/lib/todos";
import { useSessions } from "@/state/sessions";
import { useSubagentRuns } from "@/state/sessions";
import { api } from "@/api/client";
import type {
  AskUserQuestionAnnotation,
  Attachment,
  EffortLevel,
  ModelId,
  PermissionMode,
  Project,
  Session,
  SlashClaudexAction,
} from "@claudex/shared";
import { effortSupportedOnModel } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import { DiffView, toolCallToDiff } from "@/components/DiffView";
import { diffForToolCall } from "@/lib/diff";
import { SessionSettingsSheet } from "@/components/SessionSettingsSheet";
import { AskUserQuestionCard } from "@/components/AskUserQuestionCard";
import { PlanAcceptCard } from "@/components/PlanAcceptCard";
import { SideChatDrawer } from "@/components/SideChatDrawer";
import { SlashCommandSheet, type PickerHandle } from "@/components/SlashCommandSheet";
import { FileMentionSheet } from "@/components/FileMentionSheet";
import { TerminalDrawer } from "@/components/TerminalDrawer";
import { ContextRingButton, UsagePanel } from "@/components/UsagePanel";
import { ContextPanel } from "@/components/ContextPanel";
import { Markdown } from "@/components/Markdown";
import { LinkPreview, firstHttpUrl } from "@/components/LinkPreview";
import { ImageLightbox } from "@/components/ImageLightbox";
import { MessageActions } from "@/components/MessageActions";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastHost, toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { summarizeToolCall, toolIcon } from "@/lib/tool-summary";
import type { SlashCommand } from "@/lib/slash-commands";
import { BUILTIN_FALLBACK_SLASH_COMMANDS } from "@/lib/slash-commands";
import type { UIPiece } from "@/state/sessions";
import { contextWindowTokens } from "@/lib/usage";
import { getModelLabel, getAllModelEntries } from "@/lib/pricing";
import { useAppSettings, useCustomModels } from "@/state/app-settings";
import { extractImagesFromText, type ImageRef } from "@/lib/images";
import { useVisualViewport } from "@/hooks/useVisualViewport";

// ---------------------------------------------------------------------------
// Model / mode label tables shared by the desktop header pills and the chat
// overflow sheet. Built-in list from pricing.ts + custom models from app settings.
// ---------------------------------------------------------------------------
const MODE_LABEL: Record<PermissionMode, string> = {
  default: "询问",
  acceptEdits: "接受编辑",
  plan: "计划",
  bypassPermissions: "绕过权限",
  auto: "自动",
};
const MODE_IDS: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

// Effort-level labels for the Chat header pill + composer meta line. Values
// match `EffortLevel` in shared/src/models.ts; kept here (rather than in a
// shared web util) because the Chat screen is the only surface that reads
// them today. Order is low → max so the picker reads left-to-right as
// "cheaper & faster" → "slower & deeper".
const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};
const EFFORT_IDS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// ---------------------------------------------------------------------------
// Render-entry types + builder for collapsible tool groups (mockup s-19).
//
// The chat render loop iterates `RenderEntry[]` instead of `UIPiece[]`:
// `single` entries render via `<Piece>` unchanged, `group` entries render
// via `<ToolGroup>` which owns collapse/expand state and wraps a run of
// consecutive "plain" tool_use pieces behind a summary pill.
// ---------------------------------------------------------------------------

type ToolUsePiece = Extract<UIPiece, { kind: "tool_use" }>;

type RenderEntry =
  | { kind: "single"; piece: UIPiece; key: string }
  | {
      kind: "group";
      pieces: ToolUsePiece[];
      key: string;
      /** True when a "finalizer" piece (assistant_text / thinking / user /
       * permission_request / ask_user_question / plan_accept_request) has
       * landed AFTER this group in the transcript. A non-finalized group
       * is conceptually "claude is still operating in tool mode, no prose
       * yet" — keeps itself expanded even if all its own tool_results
       * have landed, so back-to-back tool runs with brief gaps don't
       * flicker the group open/closed/open/closed. */
      finalized: boolean;
    };

/** True when a tool_use should fold into an adjacent group. Only two
 * kinds of tool_use opt out: pieces owned by a subagent (filtered by
 * applyViewMode upstream — guard defensively here), and the Task/Agent/
 * Explore dispatches that render as purple pointers + have their own
 * drawer. Everything else groups, including Edit/Write/MultiEdit (diff
 * cards) and TodoWrite (plan pointer) — when expanded, each child still
 * renders its existing rich surface inside the group body. */
function isGroupableToolUse(p: UIPiece): p is ToolUsePiece {
  if (p.kind !== "tool_use") return false;
  if (p.parentToolUseId) return false;
  // Subagent dispatches are semantically "delegate work elsewhere", not a
  // regular tool call — folding them into a tool summary would hide the
  // "I spawned a subagent" moment. The /agents drawer is their home.
  if (p.name === "Task" || p.name === "Agent" || p.name === "Explore")
    return false;
  return true;
}

function pieceKey(p: UIPiece, idx: number): string {
  switch (p.kind) {
    case "tool_use":
      return `tu:${p.id}`;
    case "tool_result":
      return `tr:${p.toolUseId}:${p.seq ?? idx}`;
    case "permission_request":
      return `pr:${p.approvalId}`;
    case "ask_user_question":
      return `auq:${p.askId}`;
    case "plan_accept_request":
      return `pa:${p.planId}`;
    case "pending":
      return `pd:${p.id}`;
    default:
      return `p:${p.kind}:${p.seq ?? idx}`;
  }
}

/** Walks `pieces` and folds consecutive groupable tool_use runs of length ≥ 2
 * into a `group` entry. A `tool_result` whose toolUseId is in `absorbed`
 * belongs to its matching tool_use block and is transparent to grouping —
 * it neither starts nor breaks a group, and renders nothing itself (its
 * matching tool_use already shows the result). After the first pass, a
 * second reverse walk annotates each group's `finalized` flag based on
 * whether a "finalizer" piece (assistant_text / thinking / user
 * / permission / ask / plan_accept) appears later in the list — groups
 * without a finalizer stay expanded by default to prevent back-to-back
 * tool runs from flickering open/closed/open while claude is still
 * operating in tool mode. */
function buildRenderEntries(
  pieces: UIPiece[],
  absorbed: Set<string>,
): RenderEntry[] {
  const out: RenderEntry[] = [];
  let run: ToolUsePiece[] = [];
  let runStartIdx = -1;
  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= 2) {
      out.push({
        kind: "group",
        pieces: run,
        key: `group:${run[0].id}`,
        finalized: false,
      });
    } else {
      out.push({
        kind: "single",
        piece: run[0],
        key: pieceKey(run[0], runStartIdx),
      });
    }
    run = [];
    runStartIdx = -1;
  };
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (isGroupableToolUse(p)) {
      if (run.length === 0) runStartIdx = i;
      run.push(p);
      continue;
    }
    // Absorbed tool_result: transparent — it belongs to the preceding
    // tool_use and renders nothing on its own. Don't break the run.
    if (p.kind === "tool_result" && absorbed.has(p.toolUseId)) {
      continue;
    }
    flush();
    out.push({ kind: "single", piece: p, key: pieceKey(p, i) });
  }
  flush();
  // Second pass — walk in reverse, mark groups finalized once we've
  // passed a "finalizer" piece on the tail side.
  let seenFinalizer = false;
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i];
    if (e.kind === "single") {
      if (isFinalizerPiece(e.piece)) seenFinalizer = true;
    } else if (seenFinalizer) {
      e.finalized = true;
    }
  }
  return out;
}

/** A piece that ends a "claude is still in tool mode" streak. Once any of
 * these lands, every preceding tool group is treated as closed business
 * and can auto-collapse. Tool events (tool_use, tool_result) and pending
 * do NOT count — we explicitly want back-to-back tool activity to stay
 * expanded even if the per-group `anyRunning` flag momentarily flips
 * false between runs. */
function isFinalizerPiece(p: UIPiece): boolean {
  return (
    p.kind === "assistant_text" ||
    p.kind === "thinking" ||
    p.kind === "user" ||
    p.kind === "permission_request" ||
    p.kind === "ask_user_question" ||
    p.kind === "plan_accept_request" ||
    // A compact boundary closes out the previous turn's business — any tool
    // group above it should auto-collapse since the conversation has moved
    // on past those calls.
    p.kind === "compact_boundary"
  );
}

export function ChatScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const loadSettings = useAppSettings((s) => s.load);
  const customModels = useCustomModels();
  const modelEntries = getAllModelEntries(customModels);
  useEffect(() => { loadSettings(); }, [loadSettings]);
  // `sessionBase` holds the full session DTO we fetched via REST (title,
  // model, mode, tags, worktree path, etc). It's write-authoritative for
  // those fields and gets updated on explicit user edits (PATCH, settings
  // sheet). But `status` is driven entirely by the server via WS
  // `session_update` frames, which update the sessions store — the local
  // copy would otherwise go stale the moment claude starts running. See
  // `session` below: we merge the live status from the store over the
  // local base so every status-dependent render reacts to the wire.
  const [sessionBase, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showSideChat, setShowSideChat] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  // Mobile-only bottom-sheet for the per-session Tasks list. Desktop uses
  // the right-rail <ChatTasksRail /> instead (gated by `showTasks`).
  const [showTasksDrawer, setShowTasksDrawer] = useState(false);
  // Plan (TodoWrite) sheet — opened from the sticky PlanStrip, from the
  // inline chat pointer, and from the mobile header. One surface works
  // for both mobile (bottom sheet) and desktop (right slide-over); see
  // PlanSheet for the responsive DOM.
  const [showPlanSheet, setShowPlanSheet] = useState(false);
  // Subagents drawer (mockup s-18) — twin of PlanSheet. Opens from the
  // SubagentsStrip, the purple "Agent started" pointer inside the
  // thread, and the Bot icon in the chat header.
  const [showSubagentsSheet, setShowSubagentsSheet] = useState(false);
  // Click-to-expand image overlay. Populated by the thumbnail click handlers
  // in Piece below — we hold the state here so the lightbox renders at the
  // Chat root, above every other drawer / sheet.
  const [lightbox, setLightbox] = useState<{
    images: ImageRef[];
    index: number;
  } | null>(null);
  // Tap/click-to-reveal state for the per-message action row. Only one
  // bubble's chips can be shown at a time — clicking a different bubble flips
  // `revealedSeq` to that bubble's seq, and clicking the revealed bubble
  // again (or running an action) clears it. Desktop and mobile share this
  // trigger — hover no longer reveals the row because it was too easy to
  // trip during scroll-past tracking. Optimistic echoes without a persisted
  // seq can't be revealed — acceptable tradeoff, they're short-lived.
  const [revealedSeq, setRevealedSeq] = useState<number | null>(null);
  const [showThinking, setShowThinking] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("claudex.chat.showThinking") === "1";
  });
  // iOS Safari collapses its layout viewport when the software keyboard
  // opens, which used to park the composer *under* the keyboard. We read
  // the visual viewport's bottom offset and lift the composer wrapper by
  // that many pixels on mobile (the `md:hidden` media check below no-ops
  // this on desktop where `offsetBottom` is always 0). A zero-offset path
  // leaves the desktop transform undefined so layout stays pristine.
  const { offsetBottom: kbOffset } = useVisualViewport();
  // Mobile three-dot menu — opens the full ChatMoreSheet bottom sheet.
  // Desktop has its own compact dropdown (DesktopMoreMenu) inside the
  // header that folds secondary actions (session diff / /btw / settings
  // / terminal) behind a single "⋯" so the header stays breathable on
  // tablet widths where the sessions + tasks rails are both open.
  const [showMore, setShowMore] = useState(false);
  // Desktop tasks rail visibility. Persisted across navigations so users
  // who prefer the condensed layout stay condensed. Mobile ignores this —
  // the rail itself is `hidden md:flex`. Default `false` since the Settings
  // rail (below) is the desktop default now — Tasks is on-demand.
  const [showTasks, setShowTasks] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("claudex.chat.tasksRail");
    if (stored === "0") return false;
    if (stored === "1") return true;
    return false;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "claudex.chat.tasksRail",
        showTasks ? "1" : "0",
      );
    } catch {
      /* private browsing etc. — ignore */
    }
  }, [showTasks]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "claudex.chat.showThinking",
        showThinking ? "1" : "0",
      );
    } catch {
      /* private browsing etc. — ignore */
    }
  }, [showThinking]);
  // Desktop settings rail visibility — the new default persistent right
  // rail (mockup s-10). Mirrors the `showTasks` persistence so either rail
  // remembers the user's preference independently.
  const [showSettingsRail, setShowSettingsRail] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("claudex.chat.settingsRail");
    if (stored === "0") return false;
    if (stored === "1") return true;
    // Default: open at md+ (desktop), closed at narrower viewports. We
    // sample `matchMedia` once at mount; the rail component itself is
    // still hidden under md via Tailwind so this is just for desktop.
    return window.matchMedia("(min-width: 768px)").matches;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "claudex.chat.settingsRail",
        showSettingsRail ? "1" : "0",
      );
    } catch {
      /* private browsing etc. — ignore */
    }
  }, [showSettingsRail]);
  // Right-rail slot arbitration — Settings / Plan / Subagents share one
  // desktop rail slot, so opening any of them must close the other two.
  // Without this, the previous "gate Settings render on !plan && !subagents"
  // hack made the Settings button silently no-op whenever Plan/Subagents
  // were already open: state flipped but render stayed suppressed. Routing
  // every open/toggle through these helpers keeps button behavior
  // predictable — last click wins, and the visible panel always matches
  // the state flags. Mobile overlays are driven off the same flags; the
  // mutex is harmless there because the overlay variants already block
  // each other visually and the rail-only state is unused at <md.
  const openPlanRail = () => {
    setShowPlanSheet(true);
    setShowSubagentsSheet(false);
    setShowSettingsRail(false);
  };
  const openSubagentsRail = () => {
    setShowSubagentsSheet(true);
    setShowPlanSheet(false);
    setShowSettingsRail(false);
  };
  const toggleSettingsRail = () => {
    setShowSettingsRail((v) => {
      const next = !v;
      if (next) {
        setShowPlanSheet(false);
        setShowSubagentsSheet(false);
      }
      return next;
    });
  };
  const toggleSubagentsRail = () => {
    setShowSubagentsSheet((v) => {
      const next = !v;
      if (next) {
        setShowPlanSheet(false);
        setShowSettingsRail(false);
      }
      return next;
    });
  };
  const {
    transcripts,
    transcriptMeta,
    init,
    ensureTranscript,
    loadOlderTranscript,
    subscribeSession,
    sendUserMessage,
    interruptSession,
    ensurePendingFor,
    resolvePermission,
    resolveAskUserQuestion,
    resolvePlanAccept,
  } = useSessions();

  // Live status subscription from the global sessions store. Populated by
  // `session_update` WS frames (see state/sessions.ts). When present, it
  // overrides the stale `sessionBase.status` so the composer lock, status
  // dot, and status-gated UI all react to server-side transitions
  // (running / awaiting / idle / error) without waiting for a page reload.
  // Falls back to undefined when the store hasn't seen this session yet
  // (direct-nav / no Home visit); in that case we use the base status.
  const liveStatus = useSessions((s) =>
    id ? s.sessions.find((x) => x.id === id)?.status : undefined,
  );
  // Live "compacting…" hint from the SDK's `compact_status` lifecycle. Set
  // while the SDK is summarizing the conversation; drives a small pill in
  // the chat header so the user sees activity even though the assistant
  // turn looks frozen (no token deltas land during compaction).
  const isCompacting = useSessions((s) => (id ? Boolean(s.compacting[id]) : false));
  // Ensure the global sessions store knows about this session so live
  // `session_update` frames have a row to update. Fires once per id change.
  // Cheap — `/api/sessions` returns the full list and is an indexed query.
  const refreshSessions = useSessions((s) => s.refreshSessions);
  useEffect(() => {
    if (!id) return;
    // Skip if the store already has it (came from Home or a prior load).
    const present = useSessions.getState().sessions.some((x) => x.id === id);
    if (!present) void refreshSessions();
  }, [id, refreshSessions]);
  const session = useMemo<Session | null>(() => {
    if (!sessionBase) return null;
    return liveStatus !== undefined
      ? { ...sessionBase, status: liveStatus }
      : sessionBase;
  }, [sessionBase, liveStatus]);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (!id) return;
    api.getSession(id).then((r) => {
      setSession(r.session);
      if (r.session.status === "running" || r.session.status === "awaiting") {
        ensurePendingFor(id);
      }
    });
    ensureTranscript(id);
    subscribeSession(id);
  }, [id, ensureTranscript, subscribeSession, ensurePendingFor]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (cancelled) return;
        const hit = r.projects.find((p) => p.id === session.projectId) ?? null;
        setProject(hit);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session?.projectId]);

  const pieces = id ? transcripts[id] ?? [] : [];
  const meta = id ? transcriptMeta[id] : undefined;

  const visiblePieces = useMemo(
    () => filterPiecesForView(pieces, showThinking),
    [pieces, showThinking],
  );

  const latestThinkingIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < visiblePieces.length; i++) {
      if (visiblePieces[i].kind === "thinking") idx = i;
    }
    return idx;
  }, [visiblePieces]);

  // Latest TodoWrite snapshot — drives the sticky PlanStrip, the PlanSheet,
  // and the inline lightweight pointer. Empty snapshot (total === 0)
  // hides every plan surface so we don't eat space on sessions that
  // never call TodoWrite. Recomputed O(n) walk when pieces change, but
  // the walk is a tight loop and pieces.length is bounded by the
  // transcript size the user is already paying for to render.
  const planSnapshot = useMemo(() => selectLatestTodos(pieces), [pieces]);
  // Subagent lifecycle rollup used by the SubagentsStrip (always mounted)
  // + the SubagentsPanel inside the rail/drawer. Memoized internally by
  // the store against the transcript array reference so re-renders on
  // every WS frame are cheap.
  const subagentRuns = useSubagentRuns(id ?? "");

  // Index of the newest user-message piece in the current visible list.
  // Drives the "Edit" affordance on that bubble only — older user turns
  // aren't editable because the truncation semantics only make sense for
  // the tail. Falls back to -1 when the visible list has no user piece
  // (pre-first-turn or Verbose-only reply).
  const lastUserVisibleIndex = useMemo(() => {
    for (let i = visiblePieces.length - 1; i >= 0; i--) {
      if (visiblePieces[i].kind === "user") return i;
    }
    return -1;
  }, [visiblePieces]);

  // Map a tool_use piece's id to its matching tool_result (if present in the
  // current visible list). Used to merge the two into a single collapsible
  // block: the `tool_use` branch reads the matched result from here; the
  // `tool_result` branch checks the matchedIds set and skips rendering to
  // avoid a duplicate bubble. Orphan tool_results (no preceding tool_use)
  // continue to render on their own.
  const { matchedResultByToolUseId, matchedToolUseIds } = useMemo(() => {
    const byId = new Map<
      string,
      { content: string; isError: boolean; createdAt?: string }
    >();
    const absorbed = new Set<string>();
    const seenToolUse = new Set<string>();
    for (const p of visiblePieces) {
      if (p.kind === "tool_use") {
        seenToolUse.add(p.id);
      } else if (p.kind === "tool_result" && p.toolUseId) {
        if (seenToolUse.has(p.toolUseId) && !byId.has(p.toolUseId)) {
          byId.set(p.toolUseId, {
            content: p.content,
            isError: p.isError,
            createdAt: p.createdAt,
          });
          absorbed.add(p.toolUseId);
        }
      }
    }
    return { matchedResultByToolUseId: byId, matchedToolUseIds: absorbed };
  }, [visiblePieces]);

  // -------------------------------------------------------------------------
  // Collapsible tool groups (mockup s-19). A run of 2+ consecutive "plain"
  // tool_use pieces (Bash/Read/Grep/Glob/WebFetch/…) inside one claude turn
  // collapses into a single summary pill. Any other piece kind — text chunk,
  // user message, permission prompt, ask_user_question, plan accept, pending
  // placeholder, orphan tool_result, or a subagent/diff/plan-pointer tool —
  // terminates the current run. Absorbed tool_results (already folded into
  // their matching tool_use block) are transparent to grouping: they don't
  // break the run. Disabled in Verbose mode (user wants every call laid out)
  // and Summary mode (tool_use pieces don't reach the render loop anyway).
  // -------------------------------------------------------------------------
  const renderEntries = useMemo(
    () => buildRenderEntries(visiblePieces, matchedToolUseIds),
    [visiblePieces, matchedToolUseIds],
  );

  // Any still-pending permission request for a diff-producing tool
  // (Edit / Write / MultiEdit) surfaces a "Review diff" klein chip in the
  // desktop header so the full-screen review page is one click away.
  // We derive this from the live transcript instead of calling
  // /pending-diffs — the permission pieces are already in memory.
  const pendingDiffApprovalId = useMemo(() => {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      if (p.kind !== "permission_request") continue;
      const d = diffForToolCall(p.toolName, p.input);
      if (d) return p.approvalId;
    }
    return null;
  }, [pieces]);

  const scroller = useRef<HTMLDivElement>(null);
  // When a permalink hash is being resolved, we suppress tail-autoscroll so
  // it doesn't yank the viewport away from the target event while the
  // polling scroll-to-seq is still in flight. The hash-nav effect below
  // flips this on mount (and on hashchange) and releases it after the
  // target is scrolled or the 10-page lazy-load budget runs out.
  const hashScrollActiveRef = useRef(false);
  // Autoscroll-to-bottom only when pieces are appended at the tail, not when
  // older pages are prepended (lazy-load). We track the previous pieces
  // length; a decrease in tail-delta means older pieces landed, so we
  // explicitly skip the smooth-scroll. The loadOlder path anchors scroll
  // position itself (see onScroll).
  const prevTailLenRef = useRef(0);
  useEffect(() => {
    const list = id ? transcripts[id] ?? [] : [];
    const tail = list.length;
    const grew = tail > prevTailLenRef.current;
    prevTailLenRef.current = tail;
    // Also skip autoscroll on the very first render after an initial load —
    // we want to land at the bottom without a visible smooth animation.
    if (grew && !hashScrollActiveRef.current) {
      scroller.current?.scrollTo({
        top: scroller.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [visiblePieces.length, id, transcripts]);

  // One-shot: after the initial transcript load finishes, jump to the
  // bottom instantly so big imported sessions land at the tail. Skipped
  // when the URL carries a `#seq-N` anchor — the hash-nav effect below
  // handles that case and we don't want to race it to the bottom.
  const didInitialJumpRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !meta || meta.initialLoading) return;
    if (didInitialJumpRef.current === id) return;
    if (pieces.length === 0) return;
    didInitialJumpRef.current = id;
    if (/^#seq-\d+$/.test(location.hash)) return;
    // rAF so the browser has painted the rows once; otherwise
    // scrollHeight can be stale right after the state write.
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }, [id, meta?.initialLoading, pieces.length, location.hash]);

  // Keyboard-open autoscroll. When `kbOffset` jumps from 0 to a positive
  // value the iOS software keyboard has just appeared and the composer has
  // been lifted above it — scroll the transcript tail into view so the user
  // sees the latest message while they type. Desktop never sets kbOffset so
  // this is a mobile-only effect in practice.
  useEffect(() => {
    if (kbOffset <= 0) return;
    const el = scroller.current;
    if (!el) return;
    // rAF so the transform on the composer wrapper has actually landed
    // before we measure scrollHeight — avoids a one-frame mis-scroll.
    requestAnimationFrame(() => {
      if (!scroller.current) return;
      scroller.current.scrollTop = scroller.current.scrollHeight;
    });
  }, [kbOffset]);

  // Hash-anchored scroll-to-event. Permalinks from MessageActions / global
  // search look like `/session/<id>#seq-42`. We want that anchor to land
  // the transcript centered on the matching event, even if the event lives
  // on an older page that hasn't been lazy-loaded yet.
  //
  // Strategy:
  //   1. Poll the DOM for `[data-event-seq="N"]` every 120ms up to 2s —
  //      transcripts stream in asynchronously, so we can't just scroll
  //      once on mount. If found, scrollIntoView + flash ring for 1.2s.
  //   2. If not found and there's older history, call `loadOlderTranscript`
  //      up to 10 times until the element appears (or no more pages).
  //   3. Re-run on `hashchange` so in-session nav from GlobalSearchSheet
  //      works without a page reload.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function scrollToSeq(seq: number) {
      const container = scroller.current;
      if (!container) return;
      hashScrollActiveRef.current = true;
      const deadline = Date.now() + 2000;
      let olderLoads = 0;

      const find = () =>
        container.querySelector(`[data-event-seq="${seq}"]`) as
          | HTMLElement
          | null;

      try {
        while (!cancelled) {
          const el = find();
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            // Flash a klein ring for 1.2s so the user can spot the target
            // after the scroll settles. Added as literal classes so they
            // survive the removal step without other transitions kicking in.
            const flashClasses = [
              "ring-2",
              "ring-klein/60",
              "rounded-lg",
            ];
            el.classList.add(...flashClasses);
            window.setTimeout(() => {
              if (!cancelled) el.classList.remove(...flashClasses);
            }, 1200);
            return;
          }
          // Not yet in the DOM. If we still have budget, wait 120ms and retry.
          // If the poll window is up, try loading an older page (up to 10x)
          // before giving up — the target may live above the initial tail.
          if (Date.now() < deadline) {
            await new Promise((r) => window.setTimeout(r, 120));
            continue;
          }
          if (olderLoads >= 10) return;
          const m = id ? transcriptMeta[id] : undefined;
          if (!m || !m.hasMore || m.loadingOlder) return;
          olderLoads += 1;
          try {
            await loadOlderTranscript(id!);
          } catch {
            return;
          }
          // After loading, give the freshly prepended rows a tick to mount
          // before the next poll.
          await new Promise((r) => window.setTimeout(r, 60));
        }
      } finally {
        hashScrollActiveRef.current = false;
      }
    }

    function tryHash() {
      const m = /^#seq-(\d+)$/.exec(window.location.hash);
      if (!m) return;
      const seq = Number(m[1]);
      if (!Number.isFinite(seq)) return;
      void scrollToSeq(seq);
    }

    tryHash();
    window.addEventListener("hashchange", tryHash);
    return () => {
      cancelled = true;
      hashScrollActiveRef.current = false;
      window.removeEventListener("hashchange", tryHash);
    };
    // Re-run on session change AND on hash change via the listener. pieces
    // length is intentionally omitted — the internal poll covers that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, location.hash]);

  /**
   * Scroll-to-top trigger for lazy-loading older messages. We:
   *   1. record scrollHeight BEFORE the fetch,
   *   2. await the store action (which prepends pieces),
   *   3. measure scrollHeight AFTER the new pieces paint, and
   *   4. bump scrollTop by the delta so the user's visible window stays put.
   * This keeps the reading position stable while more history drops in.
   */
  const onScrollerScroll = () => {
    const el = scroller.current;
    if (!el || !id) return;
    if (!meta || !meta.hasMore || meta.loadingOlder) return;
    if (el.scrollTop >= 80) return;
    const beforeHeight = el.scrollHeight;
    loadOlderTranscript(id).finally(() => {
      // rAF so we measure after React commits the prepended pieces.
      requestAnimationFrame(() => {
        const cur = scroller.current;
        if (!cur) return;
        const delta = cur.scrollHeight - beforeHeight;
        if (delta > 0) cur.scrollTop = el.scrollTop + delta;
      });
    });
  };

  const [headerContext, setHeaderContext] = useState<{ pct: number; known: boolean }>({
    pct: 0,
    known: false,
  });
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const u = await api.getUsageSummary(session.id);
        if (cancelled) return;
        const w = contextWindowTokens(session.model);
        const pct = w > 0 && u.lastTurnContextKnown
          ? Math.min(1, u.lastTurnInput / w)
          : 0;
        setHeaderContext({ pct, known: u.lastTurnContextKnown });
      } catch {
        /* leave at last value */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.id, session?.model, pieces.length]);

  // Helper: update a field on the session via the REST patch endpoint and
  // reflect the result in local state. Used by both the desktop header
  // pills and the mobile overflow sheet so they share one code path.
  async function patchSession(partial: {
    model?: ModelId;
    mode?: PermissionMode;
    effort?: EffortLevel;
  }) {
    if (!id || !session) return;
    try {
      const r = await api.updateSession(id, partial);
      setSession(r.session);
    } catch {
      // Silent: the session settings sheet has a more explicit error UI.
      // Quick header changes degrade gracefully.
    }
  }

  if (!id) return null;

  const busy = session?.status === "running" || session?.status === "awaiting";
  const statusDot = cn(
    "h-2 w-2 rounded-full shrink-0",
    session?.status === "running" && "bg-success animate-pulse",
    session?.status === "cli_running" && "bg-klein animate-pulse",
    session?.status === "awaiting" && "bg-warn",
    session?.status === "idle" && "bg-ink-faint",
    session?.status === "archived" && "bg-line-strong",
    session?.status === "error" && "bg-danger",
    !session && "bg-line-strong",
  );
  const metaLine = (
    <>
      {project && (
        <>
          <span className="mono whitespace-nowrap truncate">{project.name}</span>
          <span className="whitespace-nowrap">·</span>
        </>
      )}
      <span className="mono whitespace-nowrap">
        {session ? getModelLabel(session.model, customModels) : "—"}
      </span>
      <span className="whitespace-nowrap">·</span>
      <span className="whitespace-nowrap">
        {session ? MODE_LABEL[session.mode] ?? session.mode : "—"}
      </span>
    </>
  );

  return (
    // Full-viewport layout. On mobile it's a single flex column (the
    // existing behavior). On desktop (md+) the three-column grid from
    // mockup s-04 kicks in: 220px sessions rail · fluid center · 300px
    // tasks rail. The center column keeps its own flex-col so messages
    // scroll internally and the composer stays pinned.
    <div className="flex h-[100dvh] bg-canvas overflow-hidden">
      <ChatSessionsRail currentId={id} />
      <main className="flex flex-col flex-1 min-w-0 min-h-0">
      {/* Mobile header — shown below md breakpoint (mockup 860-868). */}
      <header className="md:hidden shrink-0 px-4 py-2.5 border-b border-line flex items-center gap-2 bg-canvas">
        <button
          type="button"
          onClick={() => navigate("/sessions")}
          className="h-9 w-9 rounded bg-paper border border-line flex items-center justify-center shrink-0 hover:bg-paper/80 transition-colors"
          aria-label="返回会话列表"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={statusDot} />
            <div className="text-ui-lg font-medium truncate">
              {session?.title ?? "会话"}
            </div>
            {session?.forkedFromSessionId ? (
              <span
                className="shrink-0 inline-flex items-center gap-1 px-1.5 h-[18px] rounded-xs border border-line bg-paper text-ink-muted text-ui-sm font-medium"
                title="此会话是派生出来的 — claude 不记得父会话在此之后的内容。"
              >
                <GitFork className="w-3 h-3" />
                已派生
              </span>
            ) : null}
            {isCompacting && <CompactingPill />}
          </div>
          <div className="flex items-center gap-1.5 text-ui text-ink-muted mt-0.5 min-w-0 overflow-hidden">
            {metaLine}
          </div>
        </div>
        <ContextRingButton
          pct={headerContext.pct}
          known={headerContext.known}
          disabled={!session}
          onClick={() => setShowUsage(true)}
        />
        {subagentRuns.length > 0 && (
          <button
            type="button"
            onClick={openSubagentsRail}
            disabled={!session}
            aria-label="打开子代理"
            title={
              subagentRuns.some((r) => r.status === "running")
                ? `子代理 (${subagentRuns.filter((r) => r.status === "running").length} 个在运行)`
                : "子代理"
            }
            className={cn(
              "relative h-9 w-9 rounded border flex items-center justify-center shrink-0 disabled:opacity-40 transition-colors",
              showSubagentsSheet
                ? "bg-purple-wash/60 border-purple/40 text-purple"
                : "bg-paper border-line text-ink-soft hover:bg-paper/80 transition-colors",
            )}
          >
            <Bot className="w-4 h-4" />
            {subagentRuns.some((r) => r.status === "running") && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-purple animate-pulse border border-canvas"
                aria-hidden
              />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          disabled={!session}
          aria-label="会话设置"
          title="会话设置"
          className="h-9 w-9 rounded bg-paper border border-line flex items-center justify-center shrink-0 disabled:opacity-40 hover:bg-paper/80 transition-colors"
        >
          <Settings2 className="w-4 h-4 text-ink-soft" />
        </button>
        <button
          type="button"
          onClick={() => setShowMore(true)}
          disabled={!session}
          className="h-9 w-9 rounded bg-paper border border-line flex items-center justify-center shrink-0 disabled:opacity-40 hover:bg-paper/80 transition-colors"
          aria-label="更多操作"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      </header>

      {/* Desktop header — shown at md+ (mockup 967-979). Pills are live
          dropdowns bound to PATCH /api/sessions/:id. */}
      <header className="hidden md:flex relative z-20 shrink-0 px-5 py-3 border-b border-line items-center gap-3 bg-canvas/80 backdrop-blur-sm">
        <span className={statusDot} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-ui-lg font-medium truncate">
              {session?.title ?? "会话"}
            </div>
            {session?.forkedFromSessionId ? (
              <span
                className="shrink-0 inline-flex items-center gap-1 px-1.5 h-[18px] rounded-xs border border-line bg-paper text-ink-muted text-ui-sm font-medium"
                title="此会话是派生出来的 — claude 不记得父会话在此之后的内容。"
              >
                <GitFork className="w-3 h-3" />
                已派生
              </span>
            ) : null}
            {isCompacting && <CompactingPill />}
          </div>
          <div className="flex items-center gap-2 text-ui text-ink-muted mt-0.5 min-w-0 overflow-hidden">
            {metaLine}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {pendingDiffApprovalId && session?.status === "awaiting" && (
            <Link
              to={`/session/${id}/diff?approvalId=${encodeURIComponent(pendingDiffApprovalId)}`}
              className="h-8 px-2.5 rounded-sm bg-klein text-canvas text-ui font-medium flex items-center gap-1.5 shadow-card shrink-0 whitespace-nowrap hover:bg-klein/90 transition-colors"
              title="查看完整差异"
            >
              <Check className="w-3.5 h-3.5" />
              查看差异
            </Link>
          )}
          <PillPicker
            label={session ? getModelLabel(session.model, customModels) : "—"}
            disabled={!session}
            items={modelEntries.map((m) => ({
              id: m.id,
              label: m.label,
              active: session?.model === m.id,
            }))}
            onPick={(m) => patchSession({ model: m })}
          />
          <PillPicker
            label={session ? MODE_LABEL[session.mode] ?? session.mode : "—"}
            disabled={!session}
            items={MODE_IDS.map((m) => ({
              id: m,
              label: MODE_LABEL[m],
              active: session?.mode === m,
            }))}
            onPick={(m) => patchSession({ mode: m as PermissionMode })}
          />
          <PillPicker
            label={session ? EFFORT_LABEL[session.effort] ?? session.effort : "—"}
            disabled={!session}
            items={EFFORT_IDS
              .filter((e) =>
                // Hide levels the current model can't use — today that's
                // `xhigh` outside Opus 4.7. The server also clamps on PATCH
                // so a stale selection still converts cleanly.
                session ? effortSupportedOnModel(session.model, e) : true,
              )
              .map((e) => ({
                id: e,
                label: EFFORT_LABEL[e],
                active: session?.effort === e,
              }))}
            onPick={(e) => patchSession({ effort: e as EffortLevel })}
          />
          <ContextRingButton
            pct={headerContext.pct}
            known={headerContext.known}
            disabled={!session}
            onClick={() => setShowContext(true)}
          />
          <button
            type="button"
            onClick={() => setShowThinking((v) => !v)}
            aria-label={showThinking ? "隐藏思考" : "显示思考"}
            aria-pressed={showThinking}
            title={showThinking ? "隐藏思考" : "显示思考"}
            className={cn(
              "h-8 w-8 rounded-sm border flex items-center justify-center shrink-0 transition-ui-fast",
              showThinking
                ? "bg-klein text-canvas border-klein"
                : "bg-paper border-line text-ink-muted",
            )}
          >
            <Brain className="w-4 h-4" />
          </button>
          {/* Desktop overflow menu — collapses session diff, /btw, settings,
              terminal behind a single "⋯" so the header stays breathable on
              tablet widths (≈ 768–1100px) where the sessions + tasks rails
              compete for space. The tasks-rail toggle stays outside so the
              user can flick the right rail open/closed without a detour. */}
          <DesktopMoreMenu
            disabled={!session}
            onOpenSessionDiff={() =>
              session ? navigate(`/session/${id}/session-diff`) : undefined
            }
            onOpenSideChat={() => setShowSideChat(true)}
            onOpenTasks={() => setShowTasks(true)}
            onOpenTerminal={() => setShowTerminal(true)}
          />
          {subagentRuns.length > 0 && (
            <button
              type="button"
              onClick={toggleSubagentsRail}
              aria-label="打开子代理"
              aria-pressed={showSubagentsSheet}
              title={
                subagentRuns.some((r) => r.status === "running")
                  ? `子代理 (${subagentRuns.filter((r) => r.status === "running").length} 个在运行)`
                  : "子代理"
              }
              className={cn(
                "relative h-8 w-8 rounded-sm border flex items-center justify-center hover:bg-paper shrink-0 transition-ui-fast",
                showSubagentsSheet
                  ? "bg-purple-wash/60 border-purple/40 text-purple"
                  : "border-line bg-canvas text-ink-soft",
              )}
            >
              <Bot className="w-4 h-4" />
              {subagentRuns.some((r) => r.status === "running") && (
                <span
                  className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-purple animate-pulse border border-canvas"
                  aria-hidden
                />
              )}
            </button>
          )}
          <button
            onClick={toggleSettingsRail}
            title={
              showSettingsRail ? "隐藏设置栏" : "显示设置栏"
            }
            aria-label="切换设置栏"
            aria-pressed={showSettingsRail}
            className={cn(
              "h-8 w-8 rounded border flex items-center justify-center hover:bg-paper shrink-0 transition-ui-fast",
              showSettingsRail
                ? "border-klein/30 bg-klein-wash/40 text-klein-ink"
                : "border-line bg-canvas text-ink-soft",
            )}
          >
            <Settings2 className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Plan strip — sticky under both mobile and desktop session
          headers. Hidden entirely when the session has no TodoWrite
          plan yet (PlanStrip returns null). Tapping opens PlanSheet
          (bottom sheet on mobile, right slide-over on desktop). */}
      <PlanStrip
        snapshot={planSnapshot}
        onOpen={openPlanRail}
      />

      {/* Subagents strip — same always-visible pattern as PlanStrip but
          for Task/Agent/Explore runs (s-17). Sits directly below the
          plan strip so the user can tell at a glance "my agent has 2
          subagents alive, they're doing X, Y". Tapping opens the Tasks
          drawer (mobile) / scrolls the Tasks rail into view (desktop)
          — same trigger as the header Tasks icon. */}
      <SubagentsStrip
        runs={subagentRuns}
        onOpen={openSubagentsRail}
      />

      {/* Messages — `flex-1 min-h-0` is the magic pair that lets the child
          scroller take the remaining column height. Without `min-h-0` a
          flex child would grow past the viewport and the composer would
          scroll out. */}
      <div
        ref={scroller}
        onScroll={onScrollerScroll}
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4 md:px-6 md:py-6 md:space-y-6"
      >
        {meta?.loadingOlder && (
          <div className="text-center text-ui text-ink-muted mono py-2">
            正在加载更早的消息…
          </div>
        )}
        {meta?.initialLoading && pieces.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <div
              className="h-5 w-5 rounded-full border-2 border-line border-t-klein animate-spin"
              aria-hidden
            />
            <div className="text-ui text-ink-muted mono">
              正在加载对话记录…
            </div>
          </div>
        )}
        {!meta?.initialLoading && visiblePieces.length === 0 && (
          <div className="text-ui text-ink-muted text-center py-8">
            发送第一条消息来唤醒 claude。
          </div>
        )}
        {(() => {
          // Shared piece renderer — used both for top-level `single` entries
          // and for each child inside a `group` entry. Keeps prop plumbing
          // in one place so the ToolGroup body looks identical to an inline
          // rendering.
          const renderPiece = (p: UIPiece, i: number) => (
            <Piece
              p={p}
              session={session}
              project={project}
              isLastUserMessage={
                p.kind === "user" && lastUserVisibleIndex === i
              }
              canEdit={session?.status === "idle"}
              onEditLastUserMessage={
                id
                  ? async (text) => {
                      await api.editLastUserMessage(id, text);
                    }
                  : undefined
              }
              onDecide={(approvalId, decision) =>
                id && resolvePermission(id, approvalId, decision)
              }
              onAnswerAskUserQuestion={(askId, answers, annotations) => {
                if (id)
                  resolveAskUserQuestion(id, askId, answers, annotations);
              }}
              onDecidePlan={(planId, decision) => {
                if (id) resolvePlanAccept(id, planId, decision);
              }}
              onOpenLightbox={(images, index) =>
                setLightbox({ images, index })
              }
              onOpenPlan={openPlanRail}
              onOpenSubagents={openSubagentsRail}
              revealedSeq={revealedSeq}
              onToggleReveal={(seq) =>
                setRevealedSeq((current) => (current === seq ? null : seq))
              }
              onClearReveal={() => setRevealedSeq(null)}
              matchedResult={
                p.kind === "tool_use"
                  ? matchedResultByToolUseId.get(p.id) ?? null
                  : null
              }
              isAbsorbedResult={
                p.kind === "tool_result" &&
                matchedToolUseIds.has(p.toolUseId)
              }
              isLatestThinking={
                p.kind === "thinking" && i === latestThinkingIndex
              }
            />
          );
          return renderEntries.map((e) => {
            if (e.kind === "single") {
              // Find the original index in visiblePieces — needed by
              // isLastUserMessage. O(N·G) lookup but the render loop
              // already costs O(N) and groups are typically tiny, so
              // staying explicit is fine.
              const idx = visiblePieces.indexOf(e.piece);
              return (
                <div key={e.key}>{renderPiece(e.piece, idx)}</div>
              );
            }
            return (
              <ToolGroup
                key={e.key}
                pieces={e.pieces}
                matchedResultByToolUseId={matchedResultByToolUseId}
                finalized={e.finalized}
                renderPiece={(child) =>
                  renderPiece(child, visiblePieces.indexOf(child))
                }
              />
            );
          });
        })()}
        {/* Tail indicator — as long as the session is running, show three
            bouncing dots at the bottom so the user knows claude is working.
            A `pending` UIPiece already renders its own dots; only show this
            fallback when no pending piece exists in the transcript at all.
            We check the unfiltered `pieces` (not `visiblePieces`) because
            view-mode filters and the sub-agent `parentToolUseId` filter can
            hide the pending piece from `visiblePieces` while it's still
            being rendered inline by a parent tool — rendering a second
            RunningDots here in that case produces the double-dots bug. */}
        {session?.status === "running" &&
          !pieces.some((p) => p.kind === "pending") && <RunningDots />}
      </div>

      <Composer
        project={project}
        session={session}
        busy={busy}
        keyboardOffset={kbOffset}
        onSend={(text, attachmentIds) => {
          // Allow empty text when attachments are present (model can read
          // file contents via the @path prefix the server injects).
          if (!id) return;
          if (!text.trim() && (!attachmentIds || attachmentIds.length === 0))
            return;
          sendUserMessage(id, text, attachmentIds);
        }}
        onStop={() => id && interruptSession(id)}
        onOpenSideChat={() => setShowSideChat(true)}
        onCreateSession={async () => {
          if (!session) return;
          try {
            const res = await api.createSession({
              projectId: session.projectId,
              model: session.model,
              mode: session.mode,
              effort: session.effort,
              worktree: session.worktreePath !== null,
            });
            navigate(`/session/${res.session.id}`);
          } catch (e) {
            const code =
              e && typeof e === "object" && "code" in e
                ? String((e as { code: unknown }).code)
                : "create_failed";
            toast(`创建失败：${code}`);
          }
        }}
        onOpenLightbox={(images, index) =>
          setLightbox({ images, index })
        }
        onClaudexAction={(action) => {
          // Route a picked `claudex-action` slash command to the local UI
          // instead of sending the token over the WS. Each case matches one
          // of the built-ins re-mapped in slash-commands.ts — new actions
          // need a case here or they'll silently no-op.
          switch (action) {
            case "open-session-settings":
              setShowSettings(true);
              return;
            case "open-model-picker":
              // No dedicated model picker yet; the session settings sheet
              // has a Model section at the top, which is the closest thing.
              setShowSettings(true);
              return;
            case "open-usage":
              // Mobile keeps the bottom-sheet Usage panel; desktop jumps
              // straight to the full `/usage` page scoped to this session.
              if (
                typeof window !== "undefined" &&
                window.matchMedia("(min-width: 768px)").matches &&
                session
              ) {
                navigate(`/usage?session=${encodeURIComponent(session.id)}`);
              } else {
                setShowUsage(true);
              }
              return;
            case "open-plugins-settings":
              navigate("/settings?tab=plugins");
              return;
            case "open-slash-help":
            case "clear-transcript":
              // Both are planned but not yet wired. Silent no-op — the
              // picker has already closed so the user sees nothing wrong
              // happen, which is better than an ad-hoc toast system we
              // don't have infra for.
              return;
          }
        }}
      />

      {showMore && session && (
        <ChatMoreSheet
          onOpenTasks={() => {
            setShowMore(false);
            setShowTasksDrawer(true);
          }}
          onOpenSideChat={() => {
            setShowMore(false);
            setShowSideChat(true);
          }}
          onOpenTerminal={() => {
            setShowMore(false);
            setShowTerminal(true);
          }}
          onOpenSessionDiff={() => {
            setShowMore(false);
            navigate(`/session/${id}/session-diff`);
          }}
          onClose={() => setShowMore(false)}
        />
      )}
      {showSettings && session && (
        <SessionSettingsSheet
          session={session}
          project={project}
          onClose={() => setShowSettings(false)}
          onUpdated={(next) => setSession(next)}
          showThinking={showThinking}
          onToggleThinking={() => setShowThinking((v) => !v)}
        />
      )}
      {showSideChat && session && (
        <SideChatDrawer
          parentSession={session}
          onClose={() => setShowSideChat(false)}
        />
      )}
      {showTerminal && session && (
        <TerminalDrawer
          session={session}
          projectPath={project?.path ?? null}
          onClose={() => setShowTerminal(false)}
        />
      )}

      {showUsage && session && (
        <UsagePanel
          session={session}
          pieceCount={pieces.length}
          onClose={() => setShowUsage(false)}
        />
      )}
      {showContext && session && (
        <ContextPanel
          session={session}
          customModels={customModels}
          pieceCount={pieces.length}
          onClose={() => setShowContext(false)}
        />
      )}
      </main>
      {showTasks && (
        <ChatTasksRail
          session={session}
          pieces={pieces}
          pendingApprovalCount={
            pieces.filter((p) => p.kind === "permission_request").length
          }
          onReveal={(attr, revealId) => {
            const el = scroller.current?.querySelector(
              `[data-${attr}="${CSS.escape(revealId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowTasks(false)}
        />
      )}
      {showSettingsRail && session && (
        <SessionSettingsSheet
          variant="rail"
          session={session}
          project={project}
          onClose={() => setShowSettingsRail(false)}
          onUpdated={(next) => setSession(next)}
          showThinking={showThinking}
          onToggleThinking={() => setShowThinking((v) => !v)}
        />
      )}
      {/* Desktop-only push-mode rails for Plan + Subagents. They share the
          right-rail slot with the Settings rail via state-level mutex
          (see `openPlanRail` / `openSubagentsRail` / `toggleSettingsRail`
          up top) — at most one of the three flags is ever true at a time
          after any user interaction, so we don't need a render gate here.
          Mobile keeps the overlay variants that render inside <main>
          above. Both rails are self-hidden under `md:` so mobile never
          double-renders. */}
      {showPlanSheet && (
        <PlanSheet
          variant="rail"
          snapshot={planSnapshot}
          onReveal={(seq) => {
            const el = scroller.current?.querySelector(
              `[data-event-seq="${String(seq)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowPlanSheet(false)}
        />
      )}
      {showSubagentsSheet && (
        <SubagentsSheet
          variant="rail"
          runs={subagentRuns}
          sessionId={id ?? ""}
          onRevealToolUse={(toolUseId) => {
            const el = scroller.current?.querySelector(
              `[data-tool-use-id="${CSS.escape(toolUseId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowSubagentsSheet(false)}
        />
      )}
      {showTasksDrawer && id && (
        <TasksDrawer
          pieces={pieces}
          sessionId={id}
          onReveal={(attr, revealId) => {
            const el = scroller.current?.querySelector(
              `[data-${attr}="${CSS.escape(revealId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowTasksDrawer(false)}
        />
      )}
      {showPlanSheet && (
        <PlanSheet
          snapshot={planSnapshot}
          onReveal={(seq) => {
            const el = scroller.current?.querySelector(
              `[data-event-seq="${String(seq)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowPlanSheet(false)}
        />
      )}
      {showSubagentsSheet && (
        <SubagentsSheet
          runs={subagentRuns}
          sessionId={id ?? ""}
          onRevealToolUse={(toolUseId) => {
            const el = scroller.current?.querySelector(
              `[data-tool-use-id="${CSS.escape(toolUseId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowSubagentsSheet(false)}
        />
      )}
      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
      <ToastHost />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop header pill dropdowns — simple button + menu for the 3-state
// picks (model and permission mode). Click-outside + Esc close the menu.
// ---------------------------------------------------------------------------

// Small "Compacting…" pill rendered next to the session title while the SDK
// is summarizing the conversation (manual `/compact` or auto-compact). The
// pill clears as soon as the matching `compact_status` end frame lands;
// `compact_boundary` then drops a divider into the transcript.
function CompactingPill() {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 px-1.5 h-[18px] rounded-xs border border-klein/30 bg-klein-wash/50 text-klein-ink text-ui-sm font-medium"
      title="正在压缩对话 — 总结较旧的上下文以腾出空间。下一条回复将基于该摘要开始。"
      role="status"
      aria-live="polite"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-klein animate-pulse" aria-hidden />
      正在压缩…
    </span>
  );
}

function PillPicker({
  label,
  items,
  onPick,
  disabled,
}: {
  label: string;
  items: Array<{ id: string; label: string; active: boolean }>;
  onPick: (id: string) => void;
  disabled?: boolean;
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
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="h-8 px-2.5 rounded-sm border border-line bg-canvas text-ui text-ink-soft flex items-center gap-1 hover:bg-paper disabled:opacity-40 whitespace-nowrap transition-ui-fast"
      >
        <span className="mono whitespace-nowrap">{label}</span>
        <ChevronDown className="w-3 h-3 text-ink-muted shrink-0" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-30 w-[180px] rounded-lg border border-line bg-canvas shadow-lift p-1"
        >
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitemradio"
              aria-checked={it.active}
              onClick={() => {
                onPick(it.id);
                setOpen(false);
              }}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-ui",
                it.active
                  ? "bg-klein-wash/40 text-ink"
                  : "text-ink-soft hover:bg-paper/60 transition-colors",
              )}
            >
              <span
                className={cn(
                  "h-3.5 w-3.5 rounded-full border-2 shrink-0 flex items-center justify-center",
                  it.active
                    ? "border-klein bg-klein text-canvas"
                    : "border-line-strong bg-canvas",
                )}
              >
                {it.active && <Check className="w-2 h-2" />}
              </span>
              <span className="mono">{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop header overflow menu — compact popover (not a bottom sheet) that
// folds the session diff, /btw side chat, session settings, and terminal
// actions behind a single "⋯" button. Added because the desktop header
// was overflowing at tablet widths (≈ 768–1100px) with both the sessions
// and tasks rails open, causing the model pill (e.g. "Opus 4.7") to wrap
// mid-word. Keeps the full-width ChatMoreSheet (mobile) untouched.
// ---------------------------------------------------------------------------
function DesktopMoreMenu({
  disabled,
  onOpenSessionDiff,
  onOpenSideChat,
  onOpenTasks,
  onOpenTerminal,
}: {
  disabled?: boolean;
  onOpenSessionDiff: () => void;
  onOpenSideChat: () => void;
  onOpenTasks: () => void;
  onOpenTerminal: () => void;
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
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多操作"
        aria-label="更多操作"
        className="h-8 w-8 rounded border border-line bg-canvas flex items-center justify-center text-ink-soft hover:bg-paper disabled:opacity-40 transition-ui-fast"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-30 w-[220px] rounded-lg border border-line bg-canvas shadow-lift p-1"
        >
          <MenuRow
            icon={<GitCompareArrows className="w-4 h-4 text-ink-soft" />}
            label="会话差异"
            onClick={() => pick(onOpenSessionDiff)}
          />
          <MenuRow
            icon={<MessageCircle className="w-4 h-4 text-klein" />}
            label="侧边对话 (/btw)"
            onClick={() => pick(onOpenSideChat)}
          />
          <MenuRow
            icon={<ListChecks className="w-4 h-4 text-ink-soft" />}
            label="任务"
            onClick={() => pick(onOpenTasks)}
          />
          <MenuRow
            icon={<Terminal className="w-4 h-4 text-ink-soft" />}
            label="打开终端"
            onClick={() => pick(onOpenTerminal)}
          />
        </div>
      )}
    </div>
  );
}

function MenuRow({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2.5 h-9 rounded-sm text-ui text-ink-soft hover:bg-paper text-left transition-colors"
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mobile "more" bottom sheet — houses the buttons evicted from the mobile
// header (session settings, terminal, /btw side chat). Desktop uses the
// compact DesktopMoreMenu popover above instead, because a full bottom
// sheet is overkill when the overflow is only four items.
// ---------------------------------------------------------------------------
function ChatMoreSheet({
  onOpenTasks,
  onOpenSideChat,
  onOpenTerminal,
  onOpenSessionDiff,
  onClose,
}: {
  onOpenTasks: () => void;
  onOpenSideChat: () => void;
  onOpenTerminal: () => void;
  onOpenSessionDiff: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end justify-center">
      <div role="dialog" aria-modal="true" aria-label="更多操作" className="w-full bg-canvas border-t border-line rounded-t-[20px] shadow-lift p-4">
        <div className="flex justify-center mb-3">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>
        <div className="caps text-ink-muted mb-2">操作</div>
        <div className="space-y-1">
          <SheetAction
            icon={<MessageCircle className="w-4 h-4 text-klein" />}
            label="侧边对话 (/btw)"
            onClick={onOpenSideChat}
          />
          <SheetAction
            icon={<GitCompareArrows className="w-4 h-4 text-ink-soft" />}
            label="会话差异"
            onClick={onOpenSessionDiff}
          />
          <SheetAction
            icon={<ListChecks className="w-4 h-4 text-ink-soft" />}
            label="任务"
            onClick={onOpenTasks}
          />
          <SheetAction
            icon={<Terminal className="w-4 h-4 text-ink-soft" />}
            label="打开终端"
            onClick={onOpenTerminal}
          />
        </div>
        <button
          onClick={onClose}
          className="mt-4 w-full h-11 rounded border border-line text-ui"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

function SheetAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 h-11 rounded border border-line bg-canvas text-ui-lg hover:bg-paper transition-colors"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Piece({
  p,
  session,
  project,
  onDecide,
  onAnswerAskUserQuestion,
  onDecidePlan,
  onOpenLightbox,
  onOpenPlan,
  onOpenSubagents,
  isLastUserMessage,
  canEdit,
  onEditLastUserMessage,
  revealedSeq,
  onToggleReveal,
  onClearReveal,
  matchedResult,
  isAbsorbedResult,
  isLatestThinking,
}: {
  p: UIPiece;
  session: Session | null;
  project: Project | null;
  onDecide: (
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
  onAnswerAskUserQuestion: (
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ) => void;
  onDecidePlan: (planId: string, decision: "accept" | "reject") => void;
  onOpenLightbox: (images: ImageRef[], index: number) => void;
  /** Open the session's plan sheet from an inline TodoWrite pointer.
   *  Omitted when the parent doesn't want to expose the quick-jump
   *  (e.g. embedded preview surfaces). */
  onOpenPlan?: () => void;
  /** Open the subagents drawer/rail from an inline Task/Agent/Explore
   *  pointer. Same omission rule as onOpenPlan. */
  onOpenSubagents?: () => void;
  /** True when this piece is the newest user_message currently visible. */
  isLastUserMessage?: boolean;
  /** True when the session is idle and the user can actually submit an edit. */
  canEdit?: boolean;
  /** Resolves after the server has accepted the edit. Caller handles the
   * subsequent refresh_transcript / events refetch. */
  onEditLastUserMessage?: (text: string) => Promise<void>;
  /** Shared click/tap-to-reveal state. Only the bubble whose seq matches
   * `revealedSeq` shows its action chips; all others stay hidden. Hover
   * does not reveal anything on either platform. */
  revealedSeq?: number | null;
  /** Click handler — flips `revealedSeq` to this bubble's seq or clears it
   * if already revealed. */
  onToggleReveal?: (seq: number) => void;
  /** Clears `revealedSeq` unconditionally. Called from inside action chips
   * so running an action dismisses the row. */
  onClearReveal?: () => void;
  /** For tool_use pieces: the tool_result content matched by toolUseId, if
   * present in the same visible list. Triggers the merged input+result
   * rendering. */
  matchedResult?: {
    content: string;
    isError: boolean;
    createdAt?: string;
  } | null;
  /** For tool_result pieces: true when this result was absorbed into the
   * preceding tool_use's merged block — render nothing here to avoid a
   * duplicate bubble. */
  isAbsorbedResult?: boolean;
  /** True when this thinking piece is the last one in the visible
   *  transcript — expands by default so the user sees the latest thought. */
  isLatestThinking?: boolean;
}) {
  // Normal mode: tool_use chips + tool_result blocks start compact and
  // expand on click. There is no verbose/summary alternative anymore.
  const verbose = false;
  switch (p.kind) {
    case "user": {
      // User messages are rendered verbatim — never markdown-processed. If the
      // user typed literal `**` or backticks, they probably meant them. But a
      // user turn can still carry images (e.g. CLI synthetic turns that pasted
      // a screenshot), so extract those and render them as thumbs above the
      // (image-stripped) text.
      //
      // The "edit last user message" affordance is only wired on the newest
      // user bubble — older turns would need a cascading-edit UX we don't
      // ship today. Bubbles carrying attachments are also locked down
      // because the server refuses the edit (400 has_attachments), so we
      // detect the attachment case inline and demote the affordance to a
      // static hint.
      const hasAttachments =
        p.kind === "user" &&
        Array.isArray(p.attachments) &&
        p.attachments.length > 0;
      return (
        <UserBubble
          text={p.text}
          attachments={p.attachments}
          createdAt={p.createdAt ?? p.at}
          onOpenLightbox={onOpenLightbox}
          editable={
            !!isLastUserMessage &&
            !!canEdit &&
            !!onEditLastUserMessage &&
            !hasAttachments
          }
          attachmentLock={!!isLastUserMessage && hasAttachments}
          onSubmitEdit={onEditLastUserMessage}
          sessionId={session?.id ?? ""}
          seq={p.seq}
          revealed={p.seq != null && revealedSeq === p.seq}
          onToggleReveal={() => {
            if (p.seq != null) onToggleReveal?.(p.seq);
          }}
          onClearReveal={onClearReveal}
        />
      );
    }
    case "assistant_text": {
      const thisRevealed = p.seq != null && revealedSeq === p.seq;
      return (
        <div
          className="group relative max-w-[72ch] min-w-0"
          data-event-seq={p.seq}
          data-show-actions={thisRevealed ? "true" : "false"}
          onClick={() => {
            if (p.seq != null) onToggleReveal?.(p.seq);
          }}
        >
          <div className="md:[&_.markdown]:text-[13px] md:[&_.markdown]:leading-[1.65]">
            <Markdown source={p.text} />
          </div>
          {(() => {
            const previewUrl = firstHttpUrl(p.text);
            return previewUrl ? <LinkPreview url={previewUrl} /> : null;
          })()}
          {session?.id && (
            <MessageActions
              text={p.text}
              markdown={p.text}
              sessionId={session.id}
              seq={p.seq}
              align="start"
              revealed={thisRevealed}
              onActionComplete={onClearReveal}
              createdAt={p.createdAt ?? undefined}
            />
          )}
        </div>
      );
    }
    case "thinking": {
      const [open, setOpen] = useState(isLatestThinking ?? false);
      useEffect(() => {
        setOpen(isLatestThinking ?? false);
      }, [isLatestThinking]);
      // First line of thinking text for the collapsed preview.
      const firstLine = p.text.includes("\n")
        ? p.text.slice(0, p.text.indexOf("\n"))
        : p.text;
      return (
        <div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 text-ui text-ink-muted hover:text-ink-soft transition-colors w-full text-left min-w-0"
          >
            <ChevronRight
              className={cn(
                "w-3 h-3 transition-transform shrink-0",
                open && "rotate-90",
              )}
            />
            <Brain className="w-3 h-3 shrink-0" />
            {!open && (
              <span className="truncate italic">
                {firstLine}
              </span>
            )}
            {open && <span>思考中</span>}
          </button>
          {open && (
            <div className="text-ui text-ink-muted italic pl-4 border-l-2 border-line whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-w-[72ch] mt-1.5">
              {p.text}
            </div>
          )}
        </div>
      );
    }
    case "tool_use": {
      const diff = toolCallToDiff(p.name, p.input);
      if (diff) {
        // Mid-thread Edit/Write diffs render full-width so the hunk grid
        // isn't clipped; the DiffView itself handles horizontal overflow.
        // When the matched tool_result landed with isError=true (e.g. the
        // string wasn't unique, or the file changed since Claude last
        // read it), the diff shows the *proposed* hunks but the edit
        // didn't actually apply. DiffView has no error surface of its
        // own, so we tuck a small danger banner underneath — otherwise
        // a failed edit hides silently and any parent ToolGroup looks
        // like it's flagging nothing (header says ERRORED but no
        // visible culprit).
        const editErrored = matchedResult?.isError === true;
        return (
          <div
            className="w-full"
            data-tool-use-id={p.id}
            data-event-seq={p.seq}
          >
            <DiffView diff={diff} />
            {editErrored && (
              <div className="mt-1 inline-flex items-start gap-1.5 rounded-sm border border-danger/35 bg-danger-wash/60 px-2 py-1.5 text-ui text-danger w-fit max-w-full">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-danger mt-1.5 shrink-0"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 leading-[1.4]">
                  <span className="font-medium mr-1">编辑未生效。</span>
                  <span className="text-danger/90 break-words">
                    {summarizeResult(matchedResult!.content, true)}
                  </span>
                </span>
              </div>
            )}
          </div>
        );
      }
      // TodoWrite — the full list lives in the persistent PlanStrip
      // + PlanSheet surfaces (mockup s-16). Rendering it again as a
      // fat `N todos` chip in the chat would duplicate state and eat
      // vertical space on every revision. Instead emit a one-line
      // "Plan updated" pointer that opens the sheet. Keep
      // `data-event-seq` for permalink + PlanPanel → transcript
      // reveal, and `data-tool-use-id` so the tasks rail's
      // `onReveal("tool-use-id", ...)` still scrolls to this row.
      if (p.name === "TodoWrite") {
        const rawTodos = (p.input as Record<string, unknown>).todos;
        const todos = Array.isArray(rawTodos) ? rawTodos : [];
        const total = todos.length;
        const doneCount = todos.reduce((acc, t) => {
          if (t && typeof t === "object" && (t as Record<string, unknown>).status === "completed") {
            return acc + 1;
          }
          return acc;
        }, 0);
        return (
          <div data-tool-use-id={p.id} data-event-seq={p.seq}>
            <button
              type="button"
              onClick={() => onOpenPlan?.()}
              className="inline-flex items-center gap-2 py-1 pl-2.5 pr-2.5 rounded bg-klein-wash/40 border border-dashed border-klein/35 text-left hover:bg-klein-wash/60 disabled:opacity-60 transition-colors"
              disabled={!onOpenPlan}
              title="打开计划面板"
            >
              <ListChecks className="w-3.5 h-3.5 text-klein-ink shrink-0" aria-hidden />
              <span className="mono text-ui text-klein-ink uppercase tracking-widest">
                计划已更新
              </span>
              <span className="text-ui text-ink-soft">
                {total} 项 · {doneCount} 已完成
              </span>
              <span className="mono text-ui text-ink-muted">→ 查看</span>
            </button>
          </div>
        );
      }
      // Task / Agent / Explore — the subagent-family tools. Fat
      // JSON chips are duplicative: the SubagentsStrip shows the latest
      // activeForm above the thread, and the SubagentsPanel (right rail
      // / bottom sheet) streams the full live transcript. Render a
      // one-line pointer here instead, matching s-17's "Agent started
      // / done" pattern. Keep data-tool-use-id so rail "reveal" clicks
      // still scroll back to this row.
      if (p.name === "Task" || p.name === "Agent" || p.name === "Explore") {
        const resultIsError = matchedResult?.isError === true;
        const hasResult = matchedResult != null;
        const inputObj = p.input as Record<string, unknown>;
        const label =
          typeof inputObj.description === "string"
            ? inputObj.description
            : typeof inputObj.subagent_type === "string"
              ? (inputObj.subagent_type as string)
              : p.name;
        // All three non-error states share the purple wash so the row
        // reads "this is a subagent pointer" at a glance and is visually
        // distinct from main-agent tool chips (which use indigo when
        // running, neutral when done).
        // Only the status icon color differentiates running / done. Solid
        // border + slightly heavier bg than the mockup so the pointer
        // stands out from surrounding prose instead of blending in.
        const pillClass = resultIsError
          ? "bg-danger-wash/50 border-danger/40 hover:bg-danger-wash/70 transition-colors"
          : "bg-purple-wash/60 border-purple/40 hover:bg-purple-wash/80 transition-colors";
        const captionClass = resultIsError
          ? "text-danger"
          : "text-purple";
        return (
          <div data-tool-use-id={p.id} data-event-seq={p.seq}>
            <button
              type="button"
              onClick={() => onOpenSubagents?.()}
              disabled={!onOpenSubagents}
              className={`w-fit max-w-full flex items-center gap-2 py-1.5 pl-2.5 pr-2.5 rounded border text-left shadow-card ${pillClass} disabled:opacity-60`}
              title="打开子代理面板"
            >
              {hasResult && !resultIsError ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  className="w-3.5 h-3.5 text-success shrink-0"
                  aria-hidden
                >
                  <path d="M5 12l5 5 9-10" />
                </svg>
              ) : hasResult && resultIsError ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  className="w-3.5 h-3.5 text-danger shrink-0"
                  aria-hidden
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              ) : (
                <svg
                  className="w-3.5 h-3.5 text-purple animate-spin shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  aria-hidden
                >
                  <path d="M21 12a9 9 0 1 1-6.2-8.6" />
                </svg>
              )}
              <span className={`mono text-ui font-semibold ${captionClass} uppercase tracking-widest shrink-0`}>
                {hasResult
                  ? resultIsError
                    ? `${p.name} 运行失败`
                    : `${p.name} 完成`
                  : `${p.name} 进行中`}
              </span>
              <span className="text-ui text-ink font-medium flex-1 min-w-0 truncate">
                {label}
              </span>
              <span className="mono text-ui text-purple/80 shrink-0">
                → 查看
              </span>
            </button>
          </div>
        );
      }
      // AskUserQuestion — the dedicated `ask_user_question` piece renders
      // the full multiple-choice card below; the bare tool_use chip is
      // duplicative noise (it just shows a truncated JSON preview of the
      // same `questions` payload). Emit an invisible anchor so any
      // data-tool-use-id lookup still resolves, and absorb the matching
      // tool_result via the existing `isAbsorbedResult` path.
      if (p.name === "AskUserQuestion") {
        return (
          <div
            data-tool-use-id={p.id}
            data-event-seq={p.seq}
            className="hidden"
            aria-hidden
          />
        );
      }
      return (
        <div data-tool-use-id={p.id} data-event-seq={p.seq}>
          <ToolCallBlock
            name={p.name}
            input={p.input}
            resultContent={matchedResult?.content ?? null}
            isError={matchedResult?.isError ?? false}
            verbose={verbose}
            onOpenLightbox={onOpenLightbox}
          />
        </div>
      );
    }
    case "tool_result": {
      // Absorbed by the merged tool_use block above — render nothing.
      if (isAbsorbedResult) return null;
      const thisRevealed = p.seq != null && revealedSeq === p.seq;
      return (
        <div
          className="group relative"
          data-event-seq={p.seq}
          data-show-actions={thisRevealed ? "true" : "false"}
          onClick={() => {
            if (p.seq != null) onToggleReveal?.(p.seq);
          }}
        >
          <ToolResultBlock
            content={p.content}
            isError={p.isError}
            verbose={verbose}
            onOpenLightbox={onOpenLightbox}
          />
          {session?.id && (
            <MessageActions
              text={p.content}
              sessionId={session.id}
              seq={p.seq}
              align="start"
              revealed={thisRevealed}
              onActionComplete={onClearReveal}
            />
          )}
        </div>
      );
    }
    case "permission_request":
      return (
        <div data-approval-id={p.approvalId} className="max-w-full min-w-0">
          <PermissionCard
            approvalId={p.approvalId}
            toolName={p.toolName}
            input={p.input}
            summary={p.summary}
            session={session}
            project={project}
            onDecide={onDecide}
          />
          {p.createdAt && (
            <div
              className="mono text-ui-sm text-ink-faint mt-1"
              title={new Date(p.createdAt).toLocaleString()}
            >
              {timeAgoShort(p.createdAt)}
            </div>
          )}
        </div>
      );
    case "ask_user_question":
      // Wrapped in an ErrorBoundary mirroring the PermissionCard guard —
      // selecting two options in a multi-select variant has been reported
      // to white-screen the whole transcript. Boundary keeps the rest of
      // the chat alive and logs the stack to console so the root cause
      // surfaces next time. Fallback exposes a skip-style button so the
      // user isn't stuck waiting on claude (which won't continue until it
      // gets an ask_user_answer frame).
      return (
        <ErrorBoundary
          label="AskUserQuestionCard"
          fallback={
            <div className="rounded-xl border border-danger/40 bg-danger-wash/60 p-3 max-w-[72ch] min-w-0">
              <div className="text-ui text-ink font-medium">
                渲染此问题时出错。
              </div>
              <div className="text-ui text-ink-muted mt-0.5">
                错误已记录到浏览器控制台。点击下方发送一条空答案，以便 claude 继续。
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    onAnswerAskUserQuestion(
                      p.askId,
                      Object.fromEntries(
                        p.questions.map((q) => [q.question, ""]),
                      ),
                    )
                  }
                  className="h-8 px-3 rounded-sm border border-danger/40 bg-canvas text-ui text-dangerhover:bg-danger-wash transition-colors "
                >
                  跳过此问题
                </button>
              </div>
            </div>
          }
        >
          <AskUserQuestionCard
            askId={p.askId}
            questions={p.questions}
            answers={p.answers}
            onSubmit={(answers, annotations) =>
              onAnswerAskUserQuestion(p.askId, answers, annotations)
            }
          />
        </ErrorBoundary>
      );
    case "plan_accept_request":
      return (
        <PlanAcceptCard
          planId={p.planId}
          plan={p.plan}
          decision={p.decision}
          onDecide={(decision) => onDecidePlan(p.planId, decision)}
        />
      );
    case "compact_boundary":
      return (
        <CompactBoundaryDivider
          trigger={p.trigger}
          preTokens={p.preTokens}
          postTokens={p.postTokens}
          durationMs={p.durationMs}
          at={p.at ?? p.createdAt ?? new Date().toISOString()}
          summary={p.summary}
        />
      );
    case "pending":
      return <PendingBlock stalled={p.stalled} />;
  }
}

// ---------------------------------------------------------------------------
// Pending placeholder — three bouncing dots so the user can tell the request
// is alive. The Agent SDK doesn't surface partial message text, so there's
// nothing to stream in between; the dots are the whole signal.
//
// The `stalled` branch surfaces a muted informational hint after a long
// stretch of silence (see armStallTimer in state/sessions.ts). This is NOT
// an error — claude is almost always still running (long thinking / slow
// tool) — so the styling is intentionally low-key: muted foreground, no
// red, no border. The user can keep waiting or hit Stop.
// ---------------------------------------------------------------------------
function PendingBlock({ stalled }: { stalled: boolean }) {
  if (stalled) {
    return (
      <div className="flex items-center gap-2 max-w-[72ch]" role="status">
        <RunningDots />
        <span className="mono text-ui text-ink-muted">
          仍在运行 — 还没有输出。点击上方"停止"可取消。
        </span>
      </div>
    );
  }
  return <RunningDots />;
}

// Three bouncing dots, nothing else. Used both as the `pending` piece body
// and as the tail indicator any time the session is in a running state.
function RunningDots() {
  return (
    <div
      className="inline-flex items-center gap-0.5 text-ink-muted"
      aria-live="polite"
      aria-label="运行中"
    >
      <span className="pending-dot" />
      <span className="pending-dot" style={{ animationDelay: "0.15s" }} />
      <span className="pending-dot" style={{ animationDelay: "0.3s" }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact boundary divider — rendered for every `compact_boundary` piece.
// The SDK fires this after a manual `/compact` or auto-compaction; without a
// visible marker the transcript looks like the conversation just leapt
// forward in tokens. We render a hairline rule with a center chip carrying
// "compacted · {trigger} · {pre}k → {post}k · {duration}". The duration is
// human-friendly (`1.2s` / `42s` / `1m 04s`).
//
// When the SDK summary text has landed (carried separately by the
// `compact_summary` event and folded onto this piece), we append a small
// "Summary" toggle to the chip; expanding it drops a mono panel beneath the
// divider with the post-compaction summary the model will see going forward.
// The text is read-only, scrollable, and copy-able — no edit affordance,
// since editing the SDK's own summary buffer is out of scope here.
// ---------------------------------------------------------------------------
function CompactBoundaryDivider({
  trigger,
  preTokens,
  postTokens,
  durationMs,
  at,
  summary,
}: {
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens?: number;
  durationMs?: number;
  at: string;
  summary?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const fmtTokens = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
    return String(n);
  };
  const fmtDuration = (ms: number): string => {
    const s = Math.round(ms / 100) / 10;
    if (s < 60) return `${s.toFixed(1).replace(/\.0$/, "")}s`;
    const min = Math.floor(s / 60);
    const rem = Math.round(s - min * 60);
    return rem > 0 ? `${min}m ${rem.toString().padStart(2, "0")}s` : `${min}m`;
  };
  const triggerLabel = trigger === "auto" ? "自动" : "手动";
  const onCopy = async () => {
    if (!summary) return;
    const ok = await copyText(summary);
    toast(ok ? "摘要已复制" : "复制失败");
  };
  return (
    <div className="my-2">
      <div
        className="flex items-center gap-3"
        role="separator"
        aria-label={`对话已压缩（${triggerLabel}）`}
        title={new Date(at).toLocaleString()}
      >
        <div className="flex-1 h-px bg-line" aria-hidden />
        <div className="shrink-0 inline-flex items-center gap-1.5 px-2 h-6 rounded-full border border-klein/30 bg-klein-wash/40 text-klein-ink text-ui mono">
          <span className="text-ui-sm text-klein-ink/80">
            已压缩
          </span>
          <span className="text-ink-muted">·</span>
          <span>{triggerLabel}</span>
          <span className="text-ink-muted">·</span>
          <span>
            {fmtTokens(preTokens)}
            {postTokens !== undefined ? ` → ${fmtTokens(postTokens)}` : ""}
          </span>
          {durationMs !== undefined && durationMs > 0 ? (
            <>
              <span className="text-ink-muted">·</span>
              <span>{fmtDuration(durationMs)}</span>
            </>
          ) : null}
          {summary ? (
            <>
              <span className="text-ink-muted">·</span>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-klein-ink/90 hover:text-klein-ink underline-offset-2 hover:underline transition-colors"
                aria-expanded={expanded}
              >
                {expanded ? "收起摘要" : "显示摘要"}
              </button>
            </>
          ) : null}
        </div>
        <div className="flex-1 h-px bg-line" aria-hidden />
      </div>
      {summary && expanded ? (
        <div className="mt-2 rounded-md border border-line bg-surface-1">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-line">
            <span className="text-ui-sm text-ink-muted mono">
              压缩摘要
            </span>
            <button
              type="button"
              onClick={onCopy}
              className="text-ui mono text-ink-muted hover:text-ink transition-colors"
            >
              复制
            </button>
          </div>
          <pre className="m-0 px-3 py-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-ui mono text-ink">
            {summary}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call block — a tool_use + its matching tool_result rendered as ONE
// collapsible unit with a single chevron that toggles both the input JSON and
// the result body. When the result hasn't streamed yet (`resultContent` is
// null) we show a pulsing "running…" tag on the right and only the input in
// the expanded body.
//
// Folded state: single chip — chevron, tool name, summarizeInput on the
// left, summarizeResult (or "running…") on the right.
// Expanded state: dark `<pre>` with pretty-printed input, followed by the
// existing ToolResultBlock (which keeps its own inner "show N more chars"
// affordance so huge results don't blow the viewport even when the outer
// block is open).
//
// Verbose mode: always expanded, no outer toggle. Inner ToolResultBlock
// still truncates overflows because even verbose shouldn't dump 50 KB.
// Error state: folded chip gets a danger dot + subtle danger-wash tint.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared input/output pane. Unifies the visual treatment of tool_use input
// JSON and tool_result text so the pair reads as one coherent unit: same
// dark shell, same mono size, same width, same max-height, same Copy
// affordance. Error state on the output pane carries a danger-accented
// border and a ✗ in the label; otherwise the two panes are visually
// indistinguishable apart from the label.
// ---------------------------------------------------------------------------
function ToolPayloadPane({
  label,
  text,
  isError,
}: {
  label: "input" | "output";
  text: string;
  isError?: boolean;
}) {
  const onCopy = async () => {
    const ok = await copyText(text);
    toast(
      ok ? `${label === "input" ? "输入" : "输出"}已复制` : "复制失败",
    );
  };
  return (
    <div
      className={cn(
        "w-full max-w-[min(80ch,100%)] rounded-lg border bg-paper/70",
        isError ? "border-danger/40" : "border-line",
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <span
          className={cn(
            "caps text-ui-sm tracking-wider",
            isError ? "text-danger" : "text-ink-muted",
          )}
        >
          {isError && label === "output" ? (
            <span aria-hidden className="mr-1">
              ✗
            </span>
          ) : null}
          {label === "input" ? "输入" : "输出"}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="ml-auto inline-flex items-center gap-1 px-1.5 h-5 rounded-xs border border-line bg-canvas mono text-ui-sm text-ink-soft hover:bg-paper transition-colors"
          title={`复制${label === "input" ? "输入" : "输出"}`}
        >
          <Copy className="w-2.5 h-2.5" aria-hidden />
          复制
        </button>
      </div>
      <pre className="mono text-ui leading-[1.55] text-ink-soft px-3 pb-3 pt-0.5 max-h-[320px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool group (mockup s-19). A run of 2+ consecutive "plain" tool_use pieces
// folds into one summary pill with four horizontal bands:
//   [chevron] [tool chips] [count · summary] [status ✓/… · time]
// Each band carries its own background tint so the eye can resolve
// "count — which tools — outcome — how long" in a single glance.
//
// State machine for open/closed:
//   default = anyRunning || anyError           // expanded
//   actual  = manualOverride ?? default
// Tapping the header flips manualOverride to the opposite of `actual`.
// Verbose mode is pre-filtered upstream (no groups are built), so this
// component never sees a verbose render — it assumes Normal view.
//
// When expanded, each child tool_use is rendered via the `renderPiece`
// callback (same path the ChatScreen render loop uses for inline pieces),
// so the collapsible frame is pure chrome: the body reuses the existing
// ToolCallBlock / DiffView / etc. inline rendering unchanged.
// ---------------------------------------------------------------------------
function ToolGroup({
  pieces,
  matchedResultByToolUseId,
  renderPiece,
  finalized,
}: {
  pieces: ToolUsePiece[];
  matchedResultByToolUseId: Map<
    string,
    { content: string; isError: boolean; createdAt?: string }
  >;
  renderPiece: (p: ToolUsePiece) => React.ReactNode;
  /** True once a non-tool "finalizer" piece has landed AFTER this group —
   * only then does the group treat itself as historical and fold. Until
   * then, even an all-green group stays expanded so claude's continuing
   * tool run doesn't flicker the summary open/closed/open as consecutive
   * batches complete with brief gaps between them. */
  finalized: boolean;
}) {
  const meta = useMemo(() => {
    let anyRunning = false;
    let errorCount = 0;
    // Last *completed* piece's error state — drives the resting tone once
    // everything settles. A mid-group error followed by a successful tool
    // shouldn't poison the whole group (user's ask: "最终的状态展示最新一
    // 个条目的状态"); the error count chip still surfaces that it happened.
    let lastError: boolean | null = null;
    let startMs: number | null = null;
    let endMs: number | null = null;
    const names: string[] = [];
    for (const p of pieces) {
      const r = matchedResultByToolUseId.get(p.id);
      if (r == null) {
        anyRunning = true;
      } else if (r.isError) {
        errorCount++;
        lastError = true;
      } else {
        lastError = false;
      }
      names.push(p.name);
      if (p.createdAt) {
        const t = Date.parse(p.createdAt);
        if (Number.isFinite(t)) {
          if (startMs == null || t < startMs) startMs = t;
        }
      }
      if (r?.createdAt) {
        const t = Date.parse(r.createdAt);
        if (Number.isFinite(t)) {
          if (endMs == null || t > endMs) endMs = t;
        }
      }
    }
    return { anyRunning, errorCount, lastError, names, startMs, endMs };
  }, [pieces, matchedResultByToolUseId]);

  const [manualState, setManualState] = useState<"open" | "closed" | null>(
    null,
  );
  // "Still live" = at least one tool is mid-flight, OR the group hasn't
  // been closed out by a non-tool finalizer yet. The latter matters
  // because a batch of tools can all land with results while the
  // assistant is still mid-turn about to fire more — showing ✓ done in
  // that window looks disjointed against the loading dots below.
  const isLive = meta.anyRunning || !finalized;
  const defaultOpen = isLive;
  const open = manualState === "open" || (manualState === null && defaultOpen);
  const toggle = () => setManualState(open ? "closed" : "open");

  // Accent color key: live (running) trumps danger — the user would
  // rather see a running spinner than a red X while things are still
  // landing. Once the group is fully at rest, tone reflects the *last*
  // completed piece's state, not any-error aggregated over the history.
  const tone: "danger" | "indigo" | "neutral" = isLive
    ? "indigo"
    : meta.lastError
      ? "danger"
      : "neutral";
  const frameClass =
    tone === "danger"
      ? "border-danger/35 bg-danger-wash/10"
      : tone === "indigo"
        ? "border-indigo/40 bg-indigo-wash/10"
        : "border-line bg-paper";
  const headerBg =
    tone === "danger"
      ? "bg-danger-wash/70"
      : tone === "indigo"
        ? "bg-indigo-wash/55"
        : "bg-paper";
  const chipBg =
    tone === "danger"
      ? "bg-danger-wash"
      : tone === "indigo"
        ? "bg-indigo-wash/80"
        : "bg-canvas";
  const borderX =
    tone === "danger"
      ? "border-danger/30"
      : tone === "indigo"
        ? "border-indigo/30"
        : "border-line";
  const statusBandClass =
    tone === "danger"
      ? "bg-danger-wash border-l border-danger/30"
      : tone === "indigo"
        ? "bg-indigo-wash border-l border-indigo/30"
        : "bg-success-wash border-l border-success/30";

  // Summary text: consecutive-collapsed tool names joined by " · ".
  const summaryText = useMemo(() => {
    const dedup: string[] = [];
    for (const n of meta.names) {
      if (dedup[dedup.length - 1] !== n) dedup.push(n);
    }
    const displayed = dedup.slice(0, 4);
    const joined = displayed.map((n) => n.toLowerCase()).join(" · ");
    if (dedup.length > displayed.length) {
      return `${joined} · +${dedup.length - displayed.length} 更多`;
    }
    return joined;
  }, [meta.names]);

  // Tool-chip strip — up to 4 unique icons, with a "+N" bucket for the rest.
  const iconStrip = useMemo(() => {
    const unique: string[] = [];
    for (const n of meta.names) {
      if (!unique.includes(n)) unique.push(n);
    }
    const shown = unique.slice(0, 4);
    const overflow = unique.length - shown.length;
    return { shown, overflow };
  }, [meta.names]);

  // Re-render every second while running so the live elapsed counter ticks.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isLive) return;
    const i = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(i);
  }, [isLive]);

  const elapsedText = useMemo(() => {
    if (meta.startMs == null) return null;
    const end = !isLive && meta.endMs != null ? meta.endMs : Date.now();
    const ms = Math.max(0, end - meta.startMs);
    if (ms < 1000) return `${ms}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    return `${m}m ${s}s`;
  }, [meta.startMs, meta.endMs, isLive]);

  // Surfaced on the summary line. While live we say so; once finished we
  // only mention errors if there were any (silent success is fine).
  const errorSuffix =
    meta.errorCount > 0
      ? `${meta.errorCount} 个错误`
      : null;
  const countSuffix = isLive
    ? errorSuffix
      ? `运行中 · ${errorSuffix}`
      : "运行中"
    : errorSuffix;

  return (
    <div
      className={cn(
        "my-2",
        // Collapsed: shrink to the pill's intrinsic width so the summary
        // row sits left-aligned under the claude message above without
        // stretching to full column width. Expanded: grow to fit the
        // widest child (diffs, long Bash output) but cap at 80ch on
        // desktop so the frame doesn't edge-to-edge the chat column.
        open ? "w-full max-w-[min(80ch,100%)]" : "w-fit max-w-full",
      )}
    >
      <div
        className={cn(
          "rounded-lg overflow-hidden border shadow-card",
          frameClass,
        )}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            "w-full group flex items-stretch text-left focus:outline-none",
          )}
        >
          {/* chevron band */}
          <span className={cn("flex items-center pl-2 pr-1", chipBg)}>
            {open ? (
              <ChevronDown
                className={cn(
                  "w-3 h-3",
                  tone === "indigo"
                    ? "text-indigo-ink"
                    : tone === "danger"
                      ? "text-danger"
                      : "text-ink-muted",
                )}
              />
            ) : (
              <ChevronRight
                className={cn(
                  "w-3 h-3 group-hover:text-ink-soft",
                  tone === "indigo"
                    ? "text-indigo-ink"
                    : tone === "danger"
                      ? "text-danger"
                      : "text-ink-muted",
                )}
              />
            )}
          </span>
          {/* tool chip strip */}
          <span
            className={cn(
              "flex items-center gap-1 pl-0 pr-2 py-1.5 border-r shrink-0",
              chipBg,
              borderX,
            )}
          >
            {iconStrip.shown.map((name, i) => {
              const Icon = toolIcon(name);
              const chipBorder =
                tone === "indigo"
                  ? "border-indigo/30"
                  : tone === "danger"
                    ? "border-danger/30"
                    : "border-line";
              const chipTone =
                tone === "indigo"
                  ? "text-indigo-ink"
                  : tone === "danger"
                    ? "text-danger"
                    : "text-ink-soft";
              return (
                <span
                  key={`${name}-${i}`}
                  className={cn(
                    "h-5 w-5 rounded-xs border flex items-center justify-center",
                    tone === "neutral" ? "bg-paper" : "bg-canvas",
                    chipBorder,
                  )}
                  title={name}
                >
                  <Icon className={cn("w-3 h-3", chipTone)} />
                </span>
              );
            })}
            {iconStrip.overflow > 0 && (
              <span
                className={cn(
                  "h-5 min-w-[20px] px-1 rounded-xs border flex items-center justify-center mono text-ui-sm",
                  tone === "indigo"
                    ? "bg-canvas border-indigo/30 text-indigo-ink"
                    : tone === "danger"
                      ? "bg-canvas border-danger/30 text-danger"
                      : "bg-paper border-line text-ink-muted",
                )}
              >
                +{iconStrip.overflow}
              </span>
            )}
          </span>
          {/* summary band */}
          <span
            className={cn(
              "flex items-baseline gap-1.5 pl-3 pr-2 py-1.5 flex-1 min-w-0",
              headerBg,
            )}
          >
            <span
              className={cn(
                "mono text-ui font-semibold tabular-nums",
                tone === "indigo"
                  ? "text-indigo-ink"
                  : tone === "danger"
                    ? "text-danger"
                    : "text-ink",
              )}
            >
              {pieces.length}
            </span>
            <span
              className={cn(
                "text-ui-sm uppercase tracking-[0.12em] whitespace-nowrap",
                tone === "indigo"
                  ? "text-indigo-ink"
                  : tone === "danger"
                    ? "text-danger"
                    : "text-ink-muted",
              )}
            >
              {countSuffix ? `步骤 · ${countSuffix}` : "步骤"}
            </span>
            <span className="mono text-ui text-ink-muted truncate flex-1 text-left ml-1">
              {summaryText}
            </span>
          </span>
          {/* status pill */}
          <span
            className={cn(
              "flex items-center gap-1.5 px-2.5 shrink-0",
              statusBandClass,
            )}
          >
            {tone === "indigo" ? (
              <Loader2
                className="w-3.5 h-3.5 text-indigo animate-spin"
                aria-label="运行中"
              />
            ) : tone === "danger" ? (
              <X
                className="w-3.5 h-3.5 text-danger"
                strokeWidth={2.2}
                aria-label="出错"
              />
            ) : (
              <Check
                className="w-3.5 h-3.5 text-success"
                strokeWidth={2.5}
                aria-label="完成"
              />
            )}
            {elapsedText && (
              <span
                className={cn(
                  "mono text-[10.5px] tabular-nums font-semibold",
                  tone === "indigo"
                    ? "text-indigo-ink"
                    : tone === "danger"
                      ? "text-danger"
                      : "text-success",
                )}
              >
                {elapsedText}
              </span>
            )}
          </span>
        </button>
        {open && (
          <div
            className={cn(
              "px-3 py-2.5 space-y-2 border-t",
              borderX,
              tone === "neutral" ? "bg-canvas" : "bg-canvas/60",
            )}
          >
            {pieces.map((p) => (
              <div key={p.id} data-tool-group-child>
                {renderPiece(p)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call block (continued)
// ---------------------------------------------------------------------------
function ToolCallBlock({
  name,
  input,
  resultContent,
  isError,
  verbose,
  onOpenLightbox,
}: {
  name: string;
  input: Record<string, unknown>;
  /** Matched tool_result content. `null` when the result hasn't landed yet
   * (tool still running) — chip shows a pulsing indicator. */
  resultContent: string | null;
  isError: boolean;
  verbose: boolean;
  onOpenLightbox: (images: ImageRef[], index: number) => void;
}) {
  const [expanded, setExpanded] = useState(verbose);
  // Keep expand state in sync when the user flips modes mid-session so
  // switching to verbose really does open everything.
  useEffect(() => {
    if (verbose) setExpanded(true);
  }, [verbose]);

  const showBody = expanded || verbose;
  const canToggle = !verbose;
  const pretty = useMemo(() => safeStringify(input), [input]);
  const running = resultContent === null;
  // Skill tool's result is always a near-fixed "Launching skill: <name>"
  // string, which duplicates the skill name we already show in the
  // summary slot. Suppress the right-hand result hint for it.
  const rightHint =
    running || name === "Skill"
      ? null
      : summarizeResult(resultContent, isError);
  const ToolIcon = toolIcon(name);

  return (
    <div
      className={cn(
        // Expanded: cap at 80ch so desktop doesn't render the whole card
        // edge-to-edge of the chat column (matches the ToolPayloadPane cap
        // inside — before the single-frame refactor, the inner panes had
        // this cap while the header chip was intrinsically sized, so the
        // visual width was naturally ≤ 80ch). Mobile viewports fall back to
        // 100% via the min(). Collapsed: intrinsic width as before.
        showBody ? "w-full max-w-[min(80ch,100%)]" : "w-fit max-w-full",
        // Single outer frame wrapping header + expanded body. Previously the
        // header chip and the input/result panes floated as separate bordered
        // siblings, which looked loose next to the subagent page's framed
        // look. We now match SubagentRun's `ToolCallCard` — one
        // rounded+bordered container, with the expanded body sitting behind
        // a `border-t` divider. Color variants shift the whole frame.
        "rounded-lg border overflow-hidden",
        isError
          ? "bg-danger-wash/40 border-danger/30"
          : running
            ? "bg-indigo-wash/50 border-indigo/30"
            : "bg-paper border-line",
      )}
    >
      <div className="w-full max-w-full">
        <button
          type="button"
          onClick={() => canToggle && setExpanded((v) => !v)}
          disabled={!canToggle}
          className={cn(
            "w-full flex items-center gap-2 py-1.5 pl-2 pr-3 max-w-full text-left overflow-hidden",
            canToggle &&
              (running ? "hover:bg-indigo-wash/70 cursor-pointer" : "hover:bg-paper/60 cursor-pointer transition-colors"),
          )}
          aria-expanded={showBody}
        >
          {canToggle ? (
            showBody ? (
              <ChevronDown
                className={cn(
                  "w-3 h-3 shrink-0",
                  running ? "text-indigo" : "text-ink-muted",
                )}
              />
            ) : (
              <ChevronRight
                className={cn(
                  "w-3 h-3 shrink-0",
                  running ? "text-indigo" : "text-ink-muted",
                )}
              />
            )
          ) : (
            <ChevronDown
              className={cn(
                "w-3 h-3 shrink-0",
                running ? "text-indigo" : "text-ink-muted",
              )}
            />
          )}
          {isError && (
            <span className="h-1.5 w-1.5 rounded-full bg-danger shrink-0" />
          )}
          <span className="shrink-0 inline-flex" title={name}>
            <ToolIcon
              className={cn(
                "w-3.5 h-3.5",
                running ? "text-indigo-ink" : "text-ink-soft",
              )}
              aria-label={name}
            />
          </span>
          <span
            className={cn(
              "mono text-ui-lg",
              running ? "text-indigo-ink" : "text-ink-soft",
            )}
          >
            {name}
          </span>
          <span className="mono text-ui-lg text-ink-muted truncate flex-1 min-w-0">
            {summarizeToolCall(name, input)}
          </span>
          {running ? (
            <Loader2
              className="w-3.5 h-3.5 text-indigo animate-spin shrink-0"
              aria-label={`${name} 运行中`}
            />
          ) : rightHint ? (
            <span
              className={cn(
                "mono text-ui truncate max-w-[40vw] shrink min-w-0",
                isError ? "text-danger" : "text-ink-muted",
              )}
            >
              {rightHint}
            </span>
          ) : null}
        </button>
      </div>
      {showBody && (
        <div className="border-t border-line/60 bg-canvas/40 px-3 py-2.5 space-y-2">
          <ToolPayloadPane label="input" text={pretty} />
          {!running && (
            <ToolResultBlock
              content={resultContent}
              isError={isError}
              verbose={verbose}
              onOpenLightbox={onOpenLightbox}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool result block. Normal mode truncates to 1200 chars and lets the user
// expand to full. Verbose mode never truncates and never shows the toggle.
// We keep mono + whitespace-pre-wrap because tool results are most often
// command output (Bash stdout, Read file contents) — markdown rendering
// would destroy alignment for those.
// ---------------------------------------------------------------------------

// Matches the sentinel the WS mapper appends to tool_result content when it
// clipped the payload to `TOOL_RESULT_WS_LIMIT` (see
// server/src/transport/ws.ts). The full payload is in the DB — refetching
// the tail via GET /api/sessions/:id/events recovers it.
const TRUNCATION_SUFFIX_RE =
  /\n\n… \[truncated — (\d+) chars dropped\. Refetch transcript to see full content\.\]\s*$/;

function detectTruncation(content: string): {
  cleanText: string;
  dropped: number | null;
} {
  const m = content.match(TRUNCATION_SUFFIX_RE);
  if (!m) return { cleanText: content, dropped: null };
  return {
    cleanText: content.slice(0, content.length - m[0].length),
    dropped: Number(m[1]),
  };
}

function ToolResultBlock({
  content,
  isError,
  verbose,
  onOpenLightbox,
}: {
  content: string;
  isError: boolean;
  verbose: boolean;
  onOpenLightbox: (images: ImageRef[], index: number) => void;
}) {
  // Strip the WS back-pressure truncation marker (if any) before extraction +
  // measurement. We don't want the sentinel text to count against the 1200
  // char budget, AND we want to render a proper action button below the
  // block instead of leaving "Refetch transcript to see full content." as
  // opaque inline text.
  const { cleanText, dropped } = useMemo(
    () => detectTruncation(content),
    [content],
  );
  // Extract any inline images (base64 data URLs, attachment refs, or SDK
  // image blocks) before we measure for truncation — otherwise a single
  // screenshot dominates the "1200 chars" budget and hides the actual text
  // output. Memoized per piece since tool_result bodies can be large.
  const { images, remainingText } = useMemo(
    () => extractImagesFromText(cleanText),
    [cleanText],
  );
  const LIMIT = 1200;
  const overflows = remainingText.length > LIMIT;
  const [expanded, setExpanded] = useState(verbose || !overflows);
  useEffect(() => {
    if (verbose) setExpanded(true);
  }, [verbose]);

  const canToggle = !verbose && overflows;
  const shownText = expanded ? remainingText : remainingText.slice(0, LIMIT);
  const hiddenCount =
    overflows && !expanded ? remainingText.length - LIMIT : 0;
  const hasText = remainingText.trim().length > 0;

  // Pull refetchTail + the URL-bound session id without threading new props
  // through every caller. `refetchTail` hits `/api/sessions/:id/events` with
  // limit=200, which reads the DB directly (the WS truncation only clips the
  // in-flight frame, not the persisted row) — so the fresh tail will carry
  // the full payload for any truncated tool_result inside the window.
  const refetchTail = useSessions((s) => s.refetchTail);
  const { id: routeSessionId } = useParams<{ id: string }>();
  const [refetching, setRefetching] = useState(false);
  const onRefetch = async () => {
    if (!routeSessionId || refetching) return;
    setRefetching(true);
    try {
      await refetchTail(routeSessionId);
    } finally {
      setRefetching(false);
    }
  };

  if (images.length === 0 && !hasText && dropped == null) {
    // Defensive: an empty tool_result (image-only source but stripped, or
    // just plain empty). Drop the whole block — nothing useful to render.
    return null;
  }

  return (
    <div className="max-w-full space-y-1.5">
      {images.length > 0 && (
        <ImageThumbs
          images={images}
          onOpen={(i) => onOpenLightbox(images, i)}
          tone="light"
        />
      )}
      {hasText && (
        <div>
          <ToolPayloadPane label="output" text={shownText} isError={isError} />
          {canToggle && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 block text-ui mono text-klein-ink hover:underline"
              aria-expanded={expanded}
            >
              {expanded
                ? "收起"
                : `显示更多 ${hiddenCount.toLocaleString()} 个字符`}
            </button>
          )}
        </div>
      )}
      {dropped != null && (
        <button
          type="button"
          onClick={onRefetch}
          disabled={refetching || !routeSessionId}
          className="mt-1 block text-ui mono text-klein-ink underline cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          title={`WS 帧被截断了 ${dropped.toLocaleString()} 个字符。点击可从对话记录中获取完整内容。`}
        >
          {refetching
            ? "正在重新获取…"
            : `获取完整内容（已截断 ${dropped.toLocaleString()} 个字符）`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// User message bubble. Split into its own component so the `useMemo` call
// for image extraction sits on a stable hook path (calling hooks inside the
// Piece switch would violate rules-of-hooks because the kind of piece at a
// given list index can change as events arrive).
// ---------------------------------------------------------------------------
function UserBubble({
  text,
  attachments,
  createdAt,
  onOpenLightbox,
  editable,
  attachmentLock,
  onSubmitEdit,
  sessionId,
  seq,
  revealed,
  onToggleReveal,
  onClearReveal,
}: {
  text: string;
  /** Attachment metadata carried on the persisted user_message event.
   * Image MIMEs get rendered as thumbs above the bubble text (merged with
   * any images already extracted from the text body); non-image files get
   * a filename chip so the user can tell *something* was attached. The
   * server serves both shapes at `/api/attachments/:id/raw`. */
  attachments?: Array<{
    id: string;
    filename: string;
    mime: string;
    size: number;
  }>;
  /** ISO timestamp of the persisted user_message event. When present, we
   * render a small muted mono caption BELOW the bubble, right-aligned —
   * visible on both mobile and desktop. Hover reveals the absolute
   * timestamp via `title`. */
  createdAt?: string;
  onOpenLightbox: (images: ImageRef[], index: number) => void;
  /** When true, show a Pencil affordance that opens the inline editor. */
  editable?: boolean;
  /** When true (only possible on the newest bubble) show an inline hint
   * explaining why the Pencil is missing — the message has attachments the
   * server won't let us edit yet. */
  attachmentLock?: boolean;
  /** Resolves when the server has accepted the edit. Required when
   * `editable` is true. */
  onSubmitEdit?: (text: string) => Promise<void>;
  /** Session id + persisted event seq for the per-message action row. The
   * chip row renders BELOW the bubble (right-aligned to match); the pencil
   * affordance stays at the bubble's top-left corner so the two never
   * collide. */
  sessionId: string;
  seq?: number;
  /** Click/tap-to-reveal flag — when true, the action chips AND the pencil
   * are shown. Desktop and mobile share this trigger; hover does not
   * reveal anything (see MessageActions class list for the rationale). */
  revealed?: boolean;
  /** Single-click handler wired on the bubble surface. Triggers the reveal
   * toggle at the Chat level. */
  onToggleReveal?: () => void;
  /** Clears `revealedSeq` after an action fires or when starting the
   * inline editor. */
  onClearReveal?: () => void;
}) {
  const { images: textImages, remainingText } = useMemo(
    () => extractImagesFromText(text),
    [text],
  );
  // Attachments carried on the user_message event. Split into image vs
  // non-image: images render as capsule pills BELOW the bubble (see
  // ImageAttachmentCapsules) — matching iMessage/ChatGPT-style attachment
  // layout. Non-images render as a small chip row inside the bubble so the
  // user can tell a file was attached even if it's a PDF / text / other.
  const { attachmentImageCapsules, attachmentFiles } = useMemo(() => {
    const imgs: ImageCapsuleItem[] = [];
    const files: Array<{
      id: string;
      filename: string;
      mime: string;
      size: number;
    }> = [];
    for (const a of attachments ?? []) {
      if (typeof a.mime === "string" && a.mime.startsWith("image/")) {
        imgs.push({
          src: `/api/attachments/${encodeURIComponent(a.id)}/raw`,
          alt: a.filename || a.mime,
          filename: a.filename,
          mime: a.mime,
          size: a.size,
        });
      } else {
        files.push(a);
      }
    }
    return { attachmentImageCapsules: imgs, attachmentFiles: files };
  }, [attachments]);
  // Text-sourced images (base64 blocks, `@path` refs) don't carry size
  // metadata, so they render as capsules with just a thumbnail + filename.
  const textImageCapsules = useMemo<ImageCapsuleItem[]>(
    () => textImages.map((r) => ({ src: r.src, alt: r.alt })),
    [textImages],
  );
  const imageCapsules = useMemo(
    () => [...attachmentImageCapsules, ...textImageCapsules],
    [attachmentImageCapsules, textImageCapsules],
  );
  // Flat list for the lightbox — same ordering as the capsule strip so
  // clicking capsule #N opens image #N.
  const images = useMemo<ImageRef[]>(
    () => imageCapsules.map((c) => ({ src: c.src, alt: c.alt })),
    [imageCapsules],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the draft buffer in sync with the underlying text whenever it
  // shifts out from under us — e.g. the server just broadcast a new
  // user_message payload after someone else in another tab edited. We
  // only overwrite while NOT editing so an in-progress draft survives
  // unrelated rerenders.
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  const save = async () => {
    if (!onSubmitEdit) return;
    if (draft === text) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmitEdit(draft);
      setEditing(false);
    } catch (err) {
      // ApiError.code carries the server error enum ("not_idle",
      // "has_attachments", etc.). Surface it verbatim so the user sees
      // something actionable rather than a generic "failed".
      const msg =
        err instanceof Error && "code" in err
          ? String((err as { code: string }).code)
          : "edit failed";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] w-full md:w-[520px] bg-paper border border-line rounded-2xl rounded-br-xs px-3 py-2.5 shadow-card text-[12px] leading-[1.55]">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft(text);
              } else if (
                e.key === "Enter" &&
                (e.metaKey || e.ctrlKey) &&
                !saving
              ) {
                e.preventDefault();
                void save();
              }
            }}
            rows={Math.min(10, Math.max(2, draft.split("\n").length))}
            className="w-full bg-canvas border border-line rounded-lg p-2 text-ui leading-[1.55] text-ink focus:outline-none focus:border-klein/60 resize-none mono"
            disabled={saving}
          />
          {error && (
            <div className="mt-1.5 text-ui text-danger mono">
              {error === "not_idle"
                ? "claude 正在工作时无法编辑 — 请先点击停止。"
                : error === "has_attachments"
                  ? "带附件的消息尚无法编辑。"
                  : error === "no_user_message"
                    ? "此会话中没有可编辑的用户消息。"
                    : `编辑失败：${error}`}
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(text);
                setError(null);
              }}
              disabled={saving}
              className="text-ui text-ink-muted hover:text-ink px-2 py-1 rounded-sm disabled:opacity-50 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || draft === text}
              className="text-ui text-canvas bg-ink rounded-sm px-3 py-1 disabled:opacity-50 hover:bg-ink/90 transition-colors"
            >
              {saving ? "保存中…" : "保存并重新发送"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const hasBubbleContent =
    remainingText.trim().length > 0 || attachmentFiles.length > 0;

  return (
    <div
      className="flex flex-col items-end group relative"
      data-event-seq={seq}
      data-show-actions={revealed ? "true" : "false"}
    >
      {hasBubbleContent && (
        <div
          className="relative max-w-[88%] bg-ink text-canvas rounded-2xl rounded-br-xs px-3.5 py-2.5 shadow-card text-[12px] leading-[1.55] md:max-w-[75%] md:text-[13px] md:leading-[1.55] md:px-4 md:py-3"
          onClick={() => onToggleReveal?.()}
        >
          {editable && (
            <button
              type="button"
              title="编辑此消息并重新运行"
              aria-label="编辑此消息并重新运行"
              onClick={(e) => {
                // Don't let the click bubble up to the bubble's reveal toggle
                // — opening the editor already dismisses any shown chips via
                // `onClearReveal`.
                e.stopPropagation();
                onClearReveal?.();
                setDraft(text);
                setEditing(true);
                setError(null);
              }}
              className={cn(
                "absolute -top-2 -left-2 h-8 w-8 rounded-full bg-paper text-ink border border-line shadow-card transition-opacity flex items-center justify-center",
                // Desktop and mobile both respect `revealed` (click/tap on
                // the bubble toggles it). Hover no longer reveals the
                // pencil — matches the action chip row; the user has to
                // click the bubble intentionally to surface it.
                revealed ? "opacity-100" : "opacity-0",
                "md:focus:opacity-100",
              )}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {remainingText.trim() && (
            <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{remainingText}</div>
          )}
          {attachmentFiles.length > 0 && (
            <div
              className={cn(
                "flex flex-wrap gap-1.5",
                // Only add top margin when there's text above; otherwise the
                // chips sit flush against the bubble top.
                remainingText.trim() ? "mt-2" : "",
              )}
            >
              {attachmentFiles.map((a) => (
                <a
                  key={a.id}
                  href={`/api/attachments/${encodeURIComponent(a.id)}/raw`}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="h-8 pl-1.5 pr-2 rounded border border-canvas/20 bg-canvas/10 text-ui text-canvas/90 hover:bg-canvas/20 flex items-center gap-1.5 whitespace-nowrap no-underline transition-colors"
                  title={`${a.filename} — ${Math.max(1, Math.round(a.size / 1024))}kb`}
                >
                  <Paperclip className="w-3 h-3 text-canvas/80" />
                  <span className="max-w-[160px] truncate">{a.filename}</span>
                  <span className="text-canvas/60 mono text-ui-sm">
                    {Math.max(1, Math.round(a.size / 1024))}kb
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
      {imageCapsules.length > 0 && (
        <ImageAttachmentCapsules
          items={imageCapsules}
          onOpen={(i) => onOpenLightbox(images, i)}
          topMargin={hasBubbleContent}
        />
      )}
      {(() => {
        // Preview card sits BELOW the dark bubble, right-aligned with the
        // bubble edge. Rendered outside the bubble so the card inherits
        // the regular paper palette instead of getting inverted.
        const previewUrl = firstHttpUrl(remainingText);
        return previewUrl ? <LinkPreview url={previewUrl} /> : null;
      })()}
      {sessionId && (
        <MessageActions
          text={text}
          sessionId={sessionId}
          seq={seq}
          align="end"
          revealed={revealed}
          onActionComplete={onClearReveal}
          createdAt={createdAt ?? undefined}
          leading={
            attachmentLock ? (
              <span
                className="mono text-ui-sm text-ink-muted mr-1"
                title="目前尚不支持编辑带附件的消息。"
              >
                无法编辑（含附件）
              </span>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image thumbnail strip. Used by both `user` bubbles and `tool_result` blocks
// to surface inline images as clickable 120×120 tiles that open the lightbox.
// `tone` only tweaks the border so thumbs sit nicely on dark (user bubble)
// vs light (tool_result) backgrounds.
// ---------------------------------------------------------------------------
function ImageThumbs({
  images,
  onOpen,
  tone,
  topMargin,
}: {
  images: ImageRef[];
  onOpen: (index: number) => void;
  tone: "dark" | "light";
  // When true, adds a top margin so the strip sits below preceding content
  // (text or attachment chips). Callers that already place ImageThumbs inside
  // a `space-y-*` container can leave this unset.
  topMargin?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 overflow-x-auto no-scrollbar items-start",
        topMargin ? "mt-2" : "",
      )}
    >
      {images.map((img, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onOpen(i)}
          className={cn(
            // Fixed height, width follows the image's natural aspect ratio.
            // min-w keeps extremely tall images from shrinking to a sliver
            // before load; max-w prevents panoramic screenshots from pushing
            // the strip off-screen. The image itself uses object-contain so
            // nothing is cropped.
            "shrink-0 h-[120px] w-auto min-w-[60px] max-w-[240px] rounded overflow-hidden cursor-zoom-in bg-canvas",
            tone === "dark"
              ? "border border-canvas/20"
              : "border border-line",
          )}
          aria-label={`打开图片 ${i + 1}，共 ${images.length} 张`}
        >
          <img
            src={img.src}
            alt={img.alt}
            className="h-full w-auto max-w-full object-contain"
            loading="lazy"
          />
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image capsule. Renders an image attachment as a rounded pill with a small
// square thumbnail on the left and filename/size on the right — matches the
// iMessage/ChatGPT-style "attachment" visual. Rendered OUTSIDE the dark user
// bubble (see UserBubble) so the palette stays on the paper side and the
// capsule reads as a separate attached artifact, not part of the text.
//
// `size` is only present for images uploaded through the composer (we have
// the file metadata server-side). Text-extracted image refs (base64 blocks,
// `@path` mentions) get a generic "image" label on the right instead.
// ---------------------------------------------------------------------------
interface ImageCapsuleItem {
  src: string;
  alt: string;
  filename?: string;
  mime?: string;
  size?: number;
}

function ImageAttachmentCapsules({
  items,
  onOpen,
  topMargin,
}: {
  items: ImageCapsuleItem[];
  onOpen: (index: number) => void;
  topMargin?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-end gap-1 max-w-[88%] md:max-w-[75%]",
        topMargin ? "mt-1.5" : "",
      )}
    >
      {items.map((item, i) => {
        // Derive a short type label: prefer the mime subtype ("image/png"
        // → "PNG"), fall back to the filename extension, then to "IMG".
        // Matches the user's ask to drop the filename and just show type
        // + size in the pill.
        const type = (() => {
          if (item.mime) {
            const sub = item.mime.split("/")[1] ?? "";
            if (sub) return sub.toUpperCase();
          }
          if (item.filename) {
            const dot = item.filename.lastIndexOf(".");
            if (dot >= 0 && dot < item.filename.length - 1) {
              return item.filename.slice(dot + 1).toUpperCase();
            }
          }
          return "IMG";
        })();
        const kb =
          typeof item.size === "number"
            ? Math.max(1, Math.round(item.size / 1024))
            : null;
        const label = kb != null ? `${type} · ${kb}kb` : type;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onOpen(i)}
            // Fully round both ends (rounded-full) — a small pill.
            // Height h-7 = 28px, single line: type + size only (no
            // filename, per user request). 20×20 round thumb on left,
            // text centered vertically on the right.
            className="flex items-center gap-1.5 h-7 pl-1 pr-2.5 rounded-full border border-line bg-paper shadow-card hover:shadow-lift transition-shadow cursor-zoom-in"
            aria-label={`打开 ${item.filename || item.alt || "图片"}`}
            title={item.filename || item.alt || undefined}
          >
            <img
              src={item.src}
              alt={item.alt}
              className="h-5 w-5 rounded-full object-cover shrink-0 bg-canvas"
              loading="lazy"
            />
            <span className="mono text-[10.5px] text-ink-muted shrink-0 tracking-wide">
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PermissionCard — matches mockup s-05.
//
// Mobile (<md): bottom-sheet shape with stacked action buttons.
// Desktop (md+): modal-card shape with footer actions, 1-up "影响范围"
// tile (Duration and Network tiles are intentionally omitted — we don't
// track those today, see docs/FEATURES.md Permissions row), and a
// "Remember this decision" checkbox that upgrades "Allow once" to
// "allow_always".
//
// Actions always call onDecide(approvalId, "allow_once" | "allow_always" |
// "deny") so the existing resolvePermission plumbing is unchanged.
// ---------------------------------------------------------------------------
function PermissionCard({
  approvalId,
  toolName,
  input,
  summary: _summary,
  session,
  project,
  onDecide,
}: {
  approvalId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  session: Session | null;
  project: Project | null;
  onDecide: (
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
}) {
  const { id: sessionId } = useParams<{ id: string }>();
  const [remember, setRemember] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const title = deriveTitle(toolName, input);
  const cwd = deriveCwd(session, project);
  const metaLine = deriveMetaLine(session, project);
  const alwaysLabel = deriveAlwaysLabel(toolName, input);
  const command = deriveCommand(toolName, input);
  const blast = deriveBlastRadius(toolName, input);
  const diff = toolCallToDiff(toolName, input);

  // Desktop "Allow once" submits via Enter while the card has focus.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      // Ignore Enter typed into a field (none today, but keep safe).
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
        return;
      }
      e.preventDefault();
      const decision = remember ? "allow_always" : "allow_once";
      onDecide(approvalId, decision);
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [approvalId, remember, onDecide]);

  const allowOnceDecision = remember ? "allow_always" : "allow_once";

  return (
    <>
      {/* Mobile — bottom-sheet shape */}
      <div
        className="md:hidden w-full max-w-full min-w-0 rounded-t-[24px] bg-canvas border-t border-x border-line shadow-lift"
        ref={cardRef}
        tabIndex={-1}
      >
        <div className="flex justify-center pt-3">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>
        <div className="px-5 pt-3 pb-5">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-warn/30 bg-warn-wash text-warn-ink text-ui-sm font-medium uppercase tracking-widest">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
              权限
            </span>
            <span className="caps text-ink-muted">询问模式</span>
          </div>
          <h3 className="display text-ui-display leading-tight mt-2 break-words [overflow-wrap:anywhere]">{title}</h3>
          <p className="text-ui text-ink-muted mt-1 break-words [overflow-wrap:anywhere]">
            Claude 想在此目录中运行
            <span className="mono text-ink"> {cwd}</span>
          </p>

          {diff ? (
            <div className="mt-3 w-full space-y-1.5">
              <DiffView diff={diff} />
              {sessionId && (
                <Link
                  to={`/session/${sessionId}/diff?approvalId=${encodeURIComponent(approvalId)}`}
                  className="block text-right mono text-ui text-klein-ink hover:underline"
                >
                  查看完整差异 →
                </Link>
              )}
            </div>
          ) : (
            <CommandBlock command={command} />
          )}

          {/* 影响范围 summary */}
          <div
            className={cn(
              "mt-3 rounded border p-3",
              blast.danger
                ? "border-danger/30 bg-danger-wash/60"
                : "border-line bg-paper/60",
            )}
          >
            <div className="caps text-ink-muted mb-1.5">影响范围</div>
            <div className="flex items-center gap-3 text-ui">
              <div className="flex-1 min-w-0">
                <div className="text-ink font-medium break-words [overflow-wrap:anywhere]">{blast.title}</div>
                <div className="text-ink-muted mt-0.5 break-words [overflow-wrap:anywhere]">{blast.subtitle}</div>
              </div>
            </div>
          </div>

          {/* Remember toggle — mirrors the desktop card so the primary
              action can upgrade to "Always allow" without needing a
              separate button. Upgrades `allow_once` → `allow_always` at
              decision time via allowOnceDecision. */}
          <label className="mt-4 flex items-center gap-2 text-ui select-none">
            <span className="h-4 w-4 rounded-xs border border-line-strong bg-canvas flex items-center justify-center shrink-0">
              {remember && <span className="h-2 w-2 bg-klein rounded-[1px]" />}
            </span>
            <input
              type="checkbox"
              className="sr-only"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="flex-1 min-w-0 break-words [overflow-wrap:anywhere]">
              记住{" "}
              <span className="mono text-ui text-ink-muted">
                {alwaysLabel}
              </span>
            </span>
          </label>

          {/* Actions — Deny + primary on one row, primary upgrades to
              Always allow when the remember checkbox is set. */}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onDecide(approvalId, "deny")}
              className="h-12 px-4 rounded bg-canvas border border-line font-medium text-danger whitespace-nowrap shrink-0 hover:bg-danger-wash transition-colors"
            >
              拒绝
            </button>
            <button
              type="button"
              onClick={() => onDecide(approvalId, allowOnceDecision)}
              className="flex-1 min-w-0 h-12 rounded bg-ink text-canvas font-medium flex items-center justify-center gap-2 whitespace-nowrap hover:bg-ink/90 transition-colors"
            >
              <Check className="w-4 h-4" />
              {remember ? "始终允许" : "允许一次"}
            </button>
          </div>
          <div className="mt-3 text-ui text-ink-muted flex items-center justify-between">
            <span>
              保存在 <span className="mono">Claudex</span>
            </span>
          </div>
        </div>
      </div>

      {/* Desktop — modal-card shape. Left-aligned (no mx-auto) so the
          card sits in the transcript column next to the other pieces
          instead of pulling the reader's eye to the viewport center.

          Wrapped in an ErrorBoundary because a rare crash in the inner
          subtree (historically observed when toggling the "Remember this
          decision" checkbox) was taking the whole Chat screen down with
          it. The fallback still exposes a Deny path so the user isn't
          stuck on a locked permission gate, and the caught error is
          console.error'd so we can diagnose next round. */}
      <ErrorBoundary
        label="PermissionCard-desktop"
        fallback={
          <div className="hidden md:block w-[560px] max-w-full rounded-2xl bg-canvas border border-danger/40 shadow-lift overflow-hidden">
            <div className="px-6 py-4 flex items-start gap-3">
              <span className="h-8 w-8 rounded bg-danger-wash border border-danger/30 flex items-center justify-center text-danger shrink-0">
                <AlertTriangle className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0 text-ui text-ink">
                <div className="font-medium">
                  此权限卡片出现错误。
                </div>
                <div className="text-ui text-ink-muted mt-0.5">
                  您仍可拒绝下方请求。错误已记录到浏览器控制台。
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-line flex items-center gap-2">
              <button
                type="button"
                onClick={() => onDecide(approvalId, "deny")}
                className="h-10 px-4 rounded border border-line bg-canvas text-danger text-ui-lg font-medium hover:bg-danger-wash transition-colors"
              >
                拒绝
              </button>
            </div>
          </div>
        }
      >
      <div
        className="hidden md:block w-[560px] max-w-full rounded-2xl bg-canvas border border-line shadow-lift overflow-hidden"
        ref={cardRef}
        tabIndex={-1}
      >
        <div className="px-6 pt-5 pb-4 border-b border-line flex items-start gap-4">
          <span className="h-10 w-10 rounded-lg bg-warn-wash border border-warn/40 flex items-center justify-center text-warn shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-warn/30 bg-warn-wash text-warn-ink text-ui-sm font-medium uppercase tracking-widest">
                <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                权限 · 询问模式
              </span>
            </div>
            <h3 className="display text-ui-display leading-tight mt-1 break-words [overflow-wrap:anywhere]">{title}</h3>
            <div className="mono text-ui text-ink-muted mt-1 truncate">
              {metaLine}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onDecide(approvalId, "deny")}
            aria-label="关闭（拒绝）"
            className="h-8 w-8 rounded border border-line hover:bg-paper flex items-center justify-center shrink-0 transition-colors"
          >
            <X className="w-4 h-4 text-ink-soft" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {diff ? (
            <div className="w-full space-y-1.5">
              <DiffView diff={diff} />
              {sessionId && (
                <Link
                  to={`/session/${sessionId}/diff?approvalId=${encodeURIComponent(approvalId)}`}
                  className="block text-right mono text-ui text-klein-ink hover:underline"
                >
                  查看完整差异 →
                </Link>
              )}
            </div>
          ) : (
            <CommandBlock command={command} cwd={cwd} desktop />
          )}

          {/* 1-up card row (Duration/Network tiles intentionally omitted — see FEATURES.md). */}
          <div className="grid grid-cols-1 gap-2">
            <div
              className={cn(
                "border rounded p-3",
                blast.danger
                  ? "border-danger/30 bg-danger-wash/60"
                  : "border-line bg-paper/50",
              )}
            >
              <div className="caps text-ink-muted">影响范围</div>
              <div className="text-ui mt-1 font-medium break-words [overflow-wrap:anywhere]">{blast.title}</div>
              <div className="text-ui text-ink-muted mt-0.5 break-words [overflow-wrap:anywhere]">
                {blast.subtitle}
              </div>
            </div>
          </div>

          <div className="rounded border border-line bg-canvas p-3">
            <div className="caps text-ink-muted mb-2">Claude 为何询问</div>
            <div className="text-ui text-ink-muted break-words [overflow-wrap:anywhere]">
              你的权限模式为
              <span className="mono text-ink"> ask</span>，且此前尚未允许过
              <span className="mono text-ink"> {alwaysLabel}</span>。
            </div>
            <label className="flex items-center gap-2 mt-3 text-ui cursor-pointer select-none">
              <span
                className={cn(
                  "h-4 w-4 rounded-xs border border-line-strong bg-canvas flex items-center justify-center shrink-0",
                )}
              >
                {remember && (
                  <span className="h-2 w-2 bg-klein rounded-[1px]" />
                )}
              </span>
              <input
                type="checkbox"
                className="sr-only"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              记住此决定以用于匹配的命令
            </label>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-line flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDecide(approvalId, "deny")}
            className="h-10 px-4 rounded border border-line bg-canvas text-danger text-ui-lg font-medium whitespace-nowrap shrink-0 hover:bg-danger-wash transition-colors"
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={() => onDecide(approvalId, allowOnceDecision)}
            className="h-10 px-4 rounded bg-ink text-canvas text-ui-lg font-medium ml-auto inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 hover:bg-ink/90 transition-colors"
          >
            <Check className="w-4 h-4" />
            {remember ? "始终允许" : "允许一次"}
            <kbd className="ml-1 mono text-ui px-1 py-0.5 rounded border border-canvas/20 text-canvas/70">
              ⏎
            </kbd>
          </button>
        </div>
      </div>
      </ErrorBoundary>
    </>
  );
}
// Command block — dark terminal-style rendering. Used by the PermissionCard
// when the tool isn't a diff-producing Edit/Write/MultiEdit.
//
// Long bodies (>12 lines OR >1200 chars) default to a collapsed preview of
// the first 8 lines with an "Expand ({N} lines)" klein-ink button, matching
// the plan-accept fold pattern so the permission card doesn't push the
// Allow/Deny actions off-screen. Short bodies render as-is.
const COMMAND_FOLD_LINES = 12;
const COMMAND_FOLD_CHARS = 1200;
const COMMAND_PREVIEW_LINES = 8;

function CommandBlock({
  command,
  cwd,
  desktop,
}: {
  command: { header: string; lines: CommandLine[] };
  cwd?: string;
  desktop?: boolean;
}) {
  const totalLines = command.lines.length;
  const totalChars = command.lines.reduce((sum, line) => {
    if (line.kind === "bash-first") {
      return sum + line.binary.length + line.rest.length;
    }
    return sum + line.text.length;
  }, 0);
  const shouldFold =
    totalLines > COMMAND_FOLD_LINES || totalChars > COMMAND_FOLD_CHARS;
  const [expanded, setExpanded] = useState(false);
  const visibleLines =
    shouldFold && !expanded
      ? command.lines.slice(0, COMMAND_PREVIEW_LINES)
      : command.lines;

  return (
    <div
      className={cn(
        "rounded-lg border border-line overflow-hidden bg-ink",
        !desktop && "mt-3",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 bg-ink-soft border-b border-canvas/10">
        <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
        <span className="mono text-ui text-canvas/70">{command.header}</span>
        {desktop && cwd && (
          <span className="ml-auto mono text-ui text-canvas/50">
            cwd = {cwd}
          </span>
        )}
      </div>
      <div
        className={cn(
          "mono text-ui text-canvas leading-[1.55] overflow-x-auto dark-scroll",
          desktop ? "px-4 py-3" : "px-3 py-3",
        )}
      >
        {visibleLines.map((line, i) => (
          <div
            key={i}
            className="whitespace-pre-wrap [overflow-wrap:anywhere] break-all"
          >
            {line.kind === "bash-first" ? (
              <>
                <span className="text-klein-soft">{line.binary}</span>
                {line.rest && <span className="text-canvas">{line.rest}</span>}
              </>
            ) : line.kind === "bash-cont" ? (
              <span className="text-canvas/60">{line.text}</span>
            ) : (
              <span className="text-canvas">{line.text}</span>
            )}
          </div>
        ))}
        {shouldFold && !expanded && (
          <div className="text-canvas/50">…</div>
        )}
        {shouldFold && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 text-ui mono text-klein-soft underline hover:text-klein-wash transition-colors"
            aria-expanded={expanded}
          >
            {expanded
              ? "收起"
              : `展开（共 ${totalLines.toLocaleString()} 行）`}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PermissionCard derivations — mapping our generic tool input onto the
// mockup's Bash-flavored copy. Rules follow the instructions in the rebuild
// brief; when a tile can't be computed honestly we omit rather than fake.
// ---------------------------------------------------------------------------

type CommandLine =
  | { kind: "bash-first"; binary: string; rest: string }
  | { kind: "bash-cont"; text: string }
  | { kind: "plain"; text: string };

function basename(p: string): string {
  if (!p) return p;
  const clean = p.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i >= 0 ? clean.slice(i + 1) : clean;
}

function deriveTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return "要运行 shell 命令吗？";
    case "Edit":
      return `编辑 ${basename(String(input.file_path ?? ""))}？`;
    case "Write":
      return `写入 ${basename(String(input.file_path ?? ""))}？`;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits.length : 0;
      return `将 ${edits} 处修改应用到 ${basename(String(input.file_path ?? ""))}？`;
    }
    case "WebFetch":
      return "要抓取某个 URL 吗？";
    default:
      return `允许使用 ${toolName}？`;
  }
}

function deriveCwd(
  session: Session | null,
  project: Project | null,
): string {
  if (session?.worktreePath) return session.worktreePath;
  if (project?.path) return project.path;
  return "此会话";
}

function deriveMetaLine(
  session: Session | null,
  project: Project | null,
): string {
  const name = project?.name ?? "会话";
  const branch = session?.branch ?? "main";
  const cwd = session?.worktreePath ?? project?.path ?? "";
  return cwd ? `${name} · ${branch} · ${cwd}` : `${name} · ${branch}`;
}

function deriveAlwaysLabel(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "").trim();
    const first = cmd.split(/\s+/)[0] ?? "";
    const second = cmd.split(/\s+/)[1] ?? "";
    if (first && second) return `${first} ${second} *`;
    if (first) return `${first} *`;
    return "Bash *";
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return `${toolName} ${basename(String(input.file_path ?? ""))}`;
  }
  if (toolName === "WebFetch") {
    const url = String(input.url ?? "");
    try {
      const u = new URL(url);
      return `WebFetch ${u.hostname}`;
    } catch {
      return `WebFetch *`;
    }
  }
  return `${toolName} *`;
}

function deriveCommand(
  toolName: string,
  input: Record<string, unknown>,
): { header: string; lines: CommandLine[] } {
  if (toolName === "Bash") {
    const raw = String(input.command ?? "");
    // Split on backslash-continuation then on explicit newlines.
    // The mockup shows "pnpm vitest run \\ --reporter=default \\ --changed origin/main"
    // rendering as three lines; we mimic that by treating backslash-EOL and
    // actual \n identically.
    const segments = raw
      .split(/\\\n|\n/)
      .map((s) => s.replace(/\s+$/, ""));
    const lines: CommandLine[] = segments.map((seg, idx) => {
      if (idx === 0) {
        const trimmed = seg.replace(/^\s+/, "");
        const sp = trimmed.indexOf(" ");
        if (sp === -1) {
          return { kind: "bash-first", binary: trimmed, rest: "" };
        }
        return {
          kind: "bash-first",
          binary: trimmed.slice(0, sp),
          rest: trimmed.slice(sp),
        };
      }
      return { kind: "bash-cont", text: seg };
    });
    return { header: "bash · shell", lines };
  }
  // Non-Bash — pretty-print input JSON inside the same dark block.
  const pretty = safeStringify(input);
  const lines: CommandLine[] = pretty
    .split("\n")
    .map((text) => ({ kind: "plain", text }));
  return { header: `${toolName} · tool`, lines };
}

function deriveBlastRadius(
  toolName: string,
  input: Record<string, unknown>,
): { title: string; subtitle: string; danger: boolean } {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    if (/\b(rm|mv|cp -r|truncate|curl .* \| sh)\b/.test(cmd)) {
      return {
        title: "破坏性 shell 命令",
        subtitle: "可能修改或删除文件",
        danger: true,
      };
    }
    if (/^(pnpm|npm|yarn|bun|vitest|jest|cargo|go test)\b/.test(cmd.trim())) {
      return {
        title: "测试 / 构建命令",
        subtitle: "不会修改源文件",
        danger: false,
      };
    }
    return {
      title: "shell 命令",
      subtitle: "影响不明确",
      danger: false,
    };
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    const filename = basename(String(input.file_path ?? ""));
    const diff = toolCallToDiff(toolName, input);
    const subtitle = diff
      ? `+${diff.addCount} −${diff.delCount}`
      : "等待中";
    return {
      title: `修改 ${filename}`,
      subtitle,
      danger: false,
    };
  }
  if (toolName === "WebFetch") {
    const url = String(input.url ?? "");
    let domain = url;
    try {
      domain = new URL(url).hostname;
    } catch {
      /* leave as-is */
    }
    return {
      title: "网络读取",
      subtitle: domain,
      danger: false,
    };
  }
  return {
    title: toolName,
    subtitle: "影响不明确",
    danger: false,
  };
}

// --------------------------------------------------------------------------
// Composer — the bottom input. Supports two in-text triggers that pop a
// bottom-sheet picker (mockup screen 09 "Slash & @ pickers"):
//
//   `@`  at the start of input or after whitespace → file mention picker
//   `/`  with only whitespace before the cursor     → slash command picker
//
// The trigger state tracks the index of the triggering `@` or `/` inside
// `text` plus the query text typed after it, so if the user keeps typing
// while the sheet is open we can pre-filter. On select we splice the token
// into `text` replacing the trigger range.
// --------------------------------------------------------------------------

type Trigger =
  | { kind: "slash"; start: number; query: string }
  | { kind: "mention"; start: number; query: string };

function Composer({
  project,
  session,
  busy,
  onSend,
  onStop,
  onOpenSideChat,
  onCreateSession,
  onClaudexAction,
  onOpenLightbox,
  keyboardOffset = 0,
}: {
  project: Project | null;
  session: Session | null;
  busy: boolean;
  onSend: (text: string, attachmentIds?: string[]) => void;
  onStop: () => void;
  onOpenSideChat: () => void;
  /**
   * Spawn a new session in the same project, inheriting the current
   * session's model / mode / effort / worktree. Fires a single API call —
   * no dialog, no title prompt. Parent owns the busy fallback toast and
   * the post-create navigation.
   */
  onCreateSession?: () => Promise<void> | void;
  /**
   * Picker dispatched a claudex-action slash command. Chat maps these to
   * local UI toggles (settings sheet, usage panel, etc.) instead of sending
   * the `/x` token over the wire.
   */
  onClaudexAction?: (action: SlashClaudexAction) => void;
  /**
   * Click-to-expand for image attachment thumbnails in the chip row above the
   * textarea. Same lightbox the transcript uses — state is owned by
   * ChatScreen so the overlay renders above every drawer/sheet.
   */
  onOpenLightbox?: (images: ImageRef[], index: number) => void;
  /**
   * CSS pixels currently hidden under the mobile software keyboard (from
   * `visualViewport`). When > 0 we translate the composer wrapper upward by
   * that amount so it floats above the keyboard instead of disappearing
   * beneath it. Always 0 on desktop (no visual-viewport shrink) — safe to
   * apply unconditionally.
   */
  keyboardOffset?: number;
}) {
  const isArchived = session?.status === "archived";
  const customModels = useCustomModels();
  // Session errored — a hard runner error the SDK surfaced (exception
  // before turn_end, agent-runner init failure, etc). Composer is locked
  // out the same way archived sessions are, but with a different banner +
  // placeholder. The user's next move is to start a new session; trying to
  // queue messages into a dead runner would silently fail. Archived still
  // takes precedence visually if somehow both are true (archived is the
  // final state). The silence watchdog no longer lands here — it's
  // log-only now, and the on-boot sweep recovers stale rows to `idle`
  // instead of flipping to `error`, so a restart doesn't eat in-flight
  // work.
  const isErrored = session?.status === "error";
  const isLocked = isArchived || isErrored;
  const [text, setText] = useState("");
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  // Spinner lock for the quick "new session" pill in the toolbar. Local to
  // the button — the parent's create handler is fire-and-forget from its
  // perspective; we flip this to block double-clicks while the POST is
  // in flight.
  const [creating, setCreating] = useState(false);
  // Prompt history recall (↑ / ↓ like bash/readline). Scoped per-session via
  // localStorage key `claudex.prompt-history.<sessionId>` → JSON array, most-
  // recent LAST, capped at 30. Loaded into a ref (not state) because the
  // history itself doesn't drive rendering; only `historyIndex` and `stashed`
  // do, and those are stored as component state so React schedules updates.
  //
  // historyIndex semantics:
  //   null → not recalling
  //   n    → showing history[history.length - 1 - n]; 0 = most recent entry
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [stashed, setStashed] = useState<string>("");
  // Reload history when the session changes so switching sessions doesn't
  // leak history across them. Silent fallback on malformed JSON.
  useEffect(() => {
    historyRef.current = [];
    setHistoryIndex(null);
    setStashed("");
    const sid = session?.id;
    if (!sid) return;
    try {
      const raw = localStorage.getItem(`claudex.prompt-history.${sid}`);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        historyRef.current = arr.filter((x): x is string => typeof x === "string").slice(-30);
      }
    } catch {
      /* ignore — treat as empty history */
    }
  }, [session?.id]);

  function pushHistory(entry: string) {
    const trimmed = entry.trim();
    if (!trimmed) return;
    const sid = session?.id;
    if (!sid) return;
    const cur = historyRef.current;
    // Dedup adjacent duplicates — if last entry is same, don't append.
    if (cur.length > 0 && cur[cur.length - 1] === trimmed) return;
    const next = [...cur, trimmed].slice(-30);
    historyRef.current = next;
    try {
      localStorage.setItem(
        `claudex.prompt-history.${sid}`,
        JSON.stringify(next),
      );
    } catch {
      /* quota / privacy mode — history just won't persist */
    }
  }

  function setTextAndMoveCaretToEnd(next: string) {
    setText(next);
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      try {
        t.setSelectionRange(next.length, next.length);
      } catch {
        /* ignore */
      }
    });
  }

  function exitRecall() {
    setHistoryIndex(null);
    setStashed("");
  }
  // Attachments currently staged on the composer — uploaded but not yet sent.
  // Cleared on send (server links them to the appended user_message seq) or
  // on × tap (DELETE /api/attachments/:id removes unlinked rows + the file).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Slash commands are fetched from the server so the picker reflects the
  // user's `~/.claude/commands/*.md` and project-level commands, not just a
  // hardcoded fixture. We fall back to a tiny built-in list if the request
  // fails so the picker is never empty.
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(
    BUILTIN_FALLBACK_SLASH_COMMANDS,
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listSlashCommands(project?.id);
        if (!cancelled && res.commands.length > 0) {
          setSlashCommands(res.commands);
        }
      } catch {
        // Network / auth blip — stick with the fallback list we already have.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id]);
  // When the user explicitly dismisses a picker (Esc / tap backdrop /
  // insert a token), we remember the position of the dismissed sigil so
  // moving the caret back over it doesn't re-pop the picker. Cleared the
  // moment the user types a *new* `@` or `/`.
  const [suppressedAt, setSuppressedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Forwarded ↑/↓/⏎ from the composer textarea into whichever picker is open.
  // Each picker registers move/select via its imperative handle.
  const pickerRef = useRef<PickerHandle | null>(null);

  // Detect / update the active trigger from (text, cursor). Pure — only
  // reads from state, never writes.
  function detectTrigger(nextText: string, cursor: number): Trigger | null {
    // If a trigger was active and its start character is still the right
    // sigil, keep it alive and update the query — even if the user types
    // more characters. Cancel if cursor moves before the sigil or a newline
    // shows up (newlines terminate either picker).
    if (trigger) {
      const ch = nextText[trigger.start];
      const expected = trigger.kind === "slash" ? "/" : "@";
      if (ch !== expected || cursor <= trigger.start) return null;
      const q = nextText.slice(trigger.start + 1, cursor);
      if (q.includes("\n") || q.includes(" ")) {
        // Space / newline ends the trigger — `@foo bar` means "mention foo,
        // then literal bar". `/cmd arg` same. We stop tracking but leave the
        // existing text alone.
        return null;
      }
      return { kind: trigger.kind, start: trigger.start, query: q };
    }

    // Fresh detection: look at the character immediately to the left of the
    // cursor.
    if (cursor <= 0) return null;
    const last = nextText[cursor - 1];
    const sigilPos = cursor - 1;
    // If the user just dismissed a picker at this exact position, don't
    // re-open it. They'll need to delete this character and retype, or
    // place a fresh sigil somewhere else.
    if (suppressedAt === sigilPos) return null;
    if (last === "/") {
      // Only fire if everything before the `/` is whitespace — matches
      // Claude CLI's convention that slash commands are the first token.
      const before = nextText.slice(0, cursor - 1);
      if (/^\s*$/.test(before)) {
        return { kind: "slash", start: sigilPos, query: "" };
      }
      return null;
    }
    if (last === "@") {
      // `@` is valid anywhere after whitespace or at the start of input.
      const prev = cursor >= 2 ? nextText[cursor - 2] : "";
      if (cursor === 1 || /\s/.test(prev)) {
        return { kind: "mention", start: sigilPos, query: "" };
      }
      return null;
    }
    return null;
  }

  // Only called on real *input* — typing a character or pasting. Caret
  // movement (click, arrows) does NOT run this, so moving your cursor back
  // across an old `@` will not yank the picker open unexpectedly.
  function onInputChange(nextText: string, cursor: number) {
    // Clear the "recently dismissed" flag the moment the user changes the
    // character at that position (deletes it, or retypes it somewhere else).
    if (suppressedAt != null && nextText[suppressedAt] !== text[suppressedAt]) {
      setSuppressedAt(null);
    }
    // Any edit clears the "this send was blocked" hint — the user's
    // either fixing it or typing something else entirely, either way the
    // hint is stale.
    if (blockedSlash) setBlockedSlash(null);
    // If the user mutates text while recalling, exit recall mode without
    // restoring `stashed` — the user is editing the recalled entry and
    // taking ownership of it.
    if (historyIndex !== null && nextText !== text) {
      exitRecall();
    }
    setText(nextText);
    setTrigger(detectTrigger(nextText, cursor));
  }

  function dismissPicker() {
    // Remember which sigil the user just dismissed so re-entering the
    // textarea or moving the caret doesn't immediately re-pop the picker.
    if (trigger) setSuppressedAt(trigger.start);
    setTrigger(null);
  }

  function insertToken(token: string) {
    // Replace [trigger.start, cursor) with the token. If no active trigger
    // (shouldn't happen, but defensive), append to the end.
    const el = textareaRef.current;
    const cursor = el?.selectionEnd ?? text.length;
    const start = trigger?.start ?? cursor;
    const end = cursor;
    const next = text.slice(0, start) + token + " " + text.slice(end);
    setText(next);
    setTrigger(null);
    // The inserted token replaced the sigil, so we definitely don't want
    // the "suppress this sigil position" flag hanging around.
    setSuppressedAt(null);
    // Put the cursor right after the inserted token + space.
    const newPos = start + token.length + 1;
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      try {
        t.setSelectionRange(newPos, newPos);
      } catch {
        /* older browsers */
      }
    });
  }

  function mentionTokenFor(absPath: string): string {
    if (project) {
      const root = project.path.replace(/\/+$/, "");
      if (absPath === root) return "@.";
      if (absPath.startsWith(root + "/")) {
        return "@" + absPath.slice(root.length + 1);
      }
    }
    // Outside the project root — fall back to the absolute path so we never
    // silently misrepresent the reference.
    return "@" + absPath;
  }

  function handlePickMention(absPath: string) {
    insertToken(mentionTokenFor(absPath));
  }

  function handlePickSlash(cmd: SlashCommand) {
    insertToken("/" + cmd.name);
  }

  // Set of slash commands the server flagged `unsupported`. Used to block
  // sends that start with one of these tokens so the user doesn't send
  // `/doctor` to the SDK and get "isn't available in this environment".
  // We only match the top-of-message slash command: `foo /doctor` still
  // sends (it's content), and so does `/doctor later` with whitespace —
  // the send helper checks the very first token.
  const unsupportedNames = useMemo(() => {
    const s = new Set<string>();
    for (const c of slashCommands) {
      if (c.behavior.kind === "unsupported") s.add(c.name);
    }
    return s;
  }, [slashCommands]);

  // When a send is blocked, surface a one-line hint under the composer.
  // Cleared on the next input/send attempt so it doesn't linger.
  const [blockedSlash, setBlockedSlash] = useState<string | null>(null);

  function leadingUnsupported(text: string): string | null {
    const m = text.match(/^\s*\/([a-z][a-z0-9-]*)(?:\s|$)/i);
    if (!m) return null;
    const name = m[1];
    return unsupportedNames.has(name) ? name : null;
  }

  function openMentionManually() {
    // Manual "@" button when user taps the affordance rather than typing.
    // Insert `@` at the cursor so the trigger detection catches it.
    const el = textareaRef.current;
    const cursor = el?.selectionEnd ?? text.length;
    const next = text.slice(0, cursor) + "@" + text.slice(cursor);
    setText(next);
    setTrigger({ kind: "mention", start: cursor, query: "" });
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      try {
        t.setSelectionRange(cursor + 1, cursor + 1);
      } catch {
        /* ignore */
      }
    });
  }

  function openSlashManually() {
    // If the composer is empty or only whitespace, seed a `/` at the end.
    // Otherwise we pop the sheet without rewriting the buffer — the user
    // can still select a command, we just insert at the cursor.
    const el = textareaRef.current;
    const cursor = el?.selectionEnd ?? text.length;
    if (/^\s*$/.test(text)) {
      const next = text + "/";
      setText(next);
      setTrigger({ kind: "slash", start: next.length - 1, query: "" });
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        try {
          t.setSelectionRange(next.length, next.length);
        } catch {
          /* ignore */
        }
      });
    } else {
      // Fall back to inserting a `/` at the cursor; user can keep typing.
      const next = text.slice(0, cursor) + "/" + text.slice(cursor);
      setText(next);
      setTrigger({ kind: "slash", start: cursor, query: "" });
    }
  }

  const send = () => {
    if (isLocked) return;
    if (!text.trim() && attachments.length === 0) return;
    const blocked = leadingUnsupported(text);
    if (blocked) {
      setBlockedSlash(blocked);
      return;
    }
    setBlockedSlash(null);
    onSend(
      text,
      attachments.length > 0 ? attachments.map((a) => a.id) : undefined,
    );
    // Record in per-session prompt history for ↑/↓ recall. Push the raw
    // text (trimmed inside pushHistory) so the next up-arrow replays exactly
    // what the user sent.
    pushHistory(text);
    exitRecall();
    setText("");
    setTrigger(null);
    setAttachments([]);
    setAttachError(null);
  };

  // Attachment helpers.
  //
  // The composer maintains a local list of uploaded-but-unsent attachments.
  // Each file → one POST /api/sessions/:id/attachments (server returns
  // metadata). Clearing happens on send (server links them to the new
  // user_message seq) or explicit × (which fires DELETE — only works until
  // the message is sent).
  async function uploadOneFile(file: File) {
    if (!session) return;
    // Hard 5MB client-side check so we fail faster than the server.
    if (file.size > 5 * 1024 * 1024) {
      setAttachError(`文件过大 — 每个文件最大 5MB`);
      return;
    }
    try {
      const att = await api.uploadAttachment(session.id, file);
      setAttachments((prev) => [...prev, att]);
      setAttachError(null);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: string }).code)
          : "";
      if (code === "unsupported_mime") {
        setAttachError(`${file.type || "file"} 类型不被允许`);
      } else if (code === "file_too_large") {
        setAttachError(`文件过大 — 每个文件最大 5MB`);
      } else {
        setAttachError("上传失败 — 请重试");
      }
    }
  }

  async function onFilesPicked(files: FileList | File[] | null) {
    if (!files) return;
    // Serialize uploads (server caps one file per request for predictable
    // limits). User waits ~fast enough for handful-of-files scenarios.
    for (const f of Array.from(files)) {
      await uploadOneFile(f);
    }
  }

  async function removeAttachment(id: string) {
    // Optimistic remove — if the DELETE fails (e.g. 404 because the message
    // was already sent in parallel) we'd just leave the chip gone; the
    // server-side row is already linked and won't be cleaned client-side.
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try {
      await api.deleteAttachment(id);
    } catch {
      /* ignore — the row is either gone or already linked */
    }
  }

  return (
    <>
      {/* Chip rail — mockup 918-924. Horizontally scrolls; tap to pop a
          picker or fire an action. On desktop the /btw link is in the
          header but we keep it here too so the chip rail stays consistent
          across breakpoints. */}
      <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar px-3 pt-2">
        <button
          type="button"
          onClick={async () => {
            if (!onCreateSession || creating || !session) return;
            setCreating(true);
            try {
              await onCreateSession();
            } finally {
              setCreating(false);
            }
          }}
          disabled={!onCreateSession || !session || creating}
          title="在此项目中新建会话（继承当前配置）"
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-ui flex items-center gap-1.5 whitespace-nowrap text-ink-soft hover:bg-paper disabled:opacity-40 transition-ui-fast"
        >
          {creating ? (
            <Loader2 className="w-3 h-3 animate-spin text-klein" />
          ) : (
            <Plus className="w-3 h-3 text-klein" />
          )}
          新建
        </button>
        <button
          onClick={openSlashManually}
          type="button"
          disabled={isLocked}
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-ui flex items-center gap-1 whitespace-nowrap text-ink-soft hover:bg-paper disabled:opacity-40 transition-ui-fast"
        >
          <span className="mono text-klein">/</span>
          命令
        </button>
        <button
          onClick={openMentionManually}
          type="button"
          disabled={!project || isLocked}
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-ui flex items-center gap-1 whitespace-nowrap text-ink-soft hover:bg-paper disabled:opacity-40 transition-ui-fast"
        >
          <span className="mono text-klein">@</span>
          文件
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!session || isLocked}
          title={
            isArchived
              ? "会话已归档 — 只读"
              : isErrored
              ? "会话出错 — 请新建会话以继续"
              : session
              ? "向此消息附加图片或文本文件"
              : "请先创建或打开会话"
          }
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-ui flex items-center gap-1.5 whitespace-nowrap text-ink-soft hover:bg-paper disabled:opacity-40 transition-ui-fast"
        >
          <Paperclip className="w-3 h-3" />
          附加
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,.md,application/json,.json,application/xml,.xml,text/*"
          className="hidden"
          onChange={(e) => {
            void onFilesPicked(e.target.files);
            // Reset the native input so re-selecting the same file works.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={onOpenSideChat}
          disabled={!session || isLocked}
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-ui flex items-center gap-1 whitespace-nowrap text-ink-soft hover:bg-paper disabled:opacity-40 transition-ui-fast"
        >
          <MessageCircle className="w-3 h-3 text-klein" />
          /btw
        </button>
        <button
          type="button"
          onClick={() => {
            // /compact is a real slash command; insert it like any other.
            insertCompact();
          }}
          disabled={isLocked}
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-ui flex items-center gap-1 whitespace-nowrap text-ink-soft hover:bg-paper disabled:opacity-40 transition-ui-fast"
        >
          <span className="mono text-klein">/</span>compact
        </button>
      </div>

      {/* Attachment chips — one row per uploaded-but-unsent file. Image
          attachments render a 40x40 thumbnail; non-images render a filename
          chip with size in KB. × removes (DELETE /api/attachments/:id) as
          long as the message hasn't been sent. */}
      {attachments.length > 0 && (
        <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar px-3 pt-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="h-10 pl-1 pr-2 rounded-lg border border-line bg-paper/70 text-ui flex items-center gap-2 whitespace-nowrap"
            >
              {a.previewUrl ? (
                (() => {
                  // Build the lightbox set from all image attachments currently
                  // in the chip row, in display order. Clicking any image opens
                  // the full-size viewer at that image's index and lets the
                  // user arrow-nav through the whole set without closing.
                  const imageAtts = attachments.filter(
                    (x): x is typeof x & { previewUrl: string } =>
                      !!x.previewUrl,
                  );
                  const idx = imageAtts.findIndex((x) => x.id === a.id);
                  const images: ImageRef[] = imageAtts.map((x) => ({
                    src: x.previewUrl,
                    alt: x.filename,
                  }));
                  return (
                    <button
                      type="button"
                      onClick={() => onOpenLightbox?.(images, Math.max(0, idx))}
                      className="shrink-0 rounded-md focus:outline-none focus:ring-2 focus:ring-klein/40"
                      aria-label={`预览 ${a.filename}`}
                    >
                      <img
                        src={a.previewUrl}
                        alt={a.filename}
                        className="w-8 h-8 rounded-md object-cover"
                      />
                    </button>
                  );
                })()
              ) : (
                <span className="w-8 h-8 rounded-md bg-ink/5 flex items-center justify-center">
                  <Paperclip className="w-3.5 h-3.5 text-ink-soft" />
                </span>
              )}
              <span className="max-w-[160px] truncate">{a.filename}</span>
              <span className="text-ink-muted mono text-ui-sm">
                {Math.max(1, Math.round(a.size / 1024))}kb
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                className="ml-1 min-w-[32px] min-h-[32px] flex items-center justify-center text-ink-muted hover:text-danger transition-colors"
                aria-label={`移除 ${a.filename}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {attachError && (
        <div
          className="shrink-0 px-4 pt-1 text-ui text-danger/80"
          role="status"
        >
          {attachError}
        </div>
      )}

      {isArchived && (
        <div className="text-ui text-ink-muted px-3 py-1 border-t border-line bg-paper/50 flex items-center gap-1.5">
          <Archive className="w-3 h-3" />
          已归档 · 只读 — 请新建会话以继续。
        </div>
      )}
      {isErrored && !isArchived && (
        <div
          className="text-ui text-danger mono px-3 py-1 border-t border-line bg-danger-wash/40 flex items-center gap-1.5"
          role="status"
        >
          <span aria-hidden="true">●</span>
          会话出错 — 请新建会话以继续。
        </div>
      )}

      <div
        className="shrink-0 border-t border-line bg-canvas px-3 pt-2 pb-3 mt-2 md:px-5 md:pt-3 md:pb-4"
        style={{
          // Lift the composer above the mobile software keyboard. On
          // desktop `keyboardOffset` stays 0 so `transform` is `undefined`
          // and React omits the style entirely (no layout thrash). We use
          // transform instead of padding so the message thread above keeps
          // its own scroll geometry — only the composer floats up.
          transform: keyboardOffset > 0 ? `translateY(-${keyboardOffset}px)` : undefined,
          transition: "transform 120ms ease-out",
        }}
        onDragOver={(e) => {
          if (!session || isLocked) return;
          e.preventDefault();
          if (!isDragging) setIsDragging(true);
        }}
        onDragLeave={(e) => {
          // Only clear when the drag fully leaves the wrapper, not when
          // passing between children (relatedTarget null = outside).
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragging(false);
          }
        }}
        onDrop={(e) => {
          if (!session || isLocked) return;
          e.preventDefault();
          setIsDragging(false);
          void onFilesPicked(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          // Image paste → run it through the same upload path as the
          // Attach button and drag/drop. Pastes bubble up from the child
          // textarea; we only preventDefault when we actually find an
          // image item so plain-text pastes still insert normally.
          //
          // `onPaste` + `ClipboardEvent.clipboardData.items` works on plain
          // HTTP (the site is not a secure context — see CLAUDE.md). Do
          // NOT switch this to `navigator.clipboard.read()`, which is
          // secure-context-only and will silently fail behind the frpc
          // HTTP tunnel.
          if (!session || isLocked) return;
          const items = e.clipboardData?.items;
          if (!items) return;
          const imageFiles: File[] = [];
          for (const item of Array.from(items)) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
              const f = item.getAsFile();
              if (f) imageFiles.push(f);
            }
          }
          if (imageFiles.length === 0) return;
          e.preventDefault();
          void onFilesPicked(imageFiles);
        }}
      >
        <div
          className={cn(
            "rounded-xl border bg-paper/60 p-2 md:rounded-lg md:p-2.5 md:bg-paper/50 focus-within:border-klein focus-within:ring-2 focus-within:ring-klein/15 transition-colors",
            isDragging ? "border-klein border-dashed" : "border-line",
          )}
        >
          <HighlightedComposer
            textareaRef={textareaRef}
            value={text}
            onChange={(e) =>
              onInputChange(e.target.value, e.target.selectionEnd ?? 0)
            }
            onKeyDown={(e) => {
              // When a picker is open, route arrow keys + Enter to it so
              // ↑/↓ scroll the list and ⏎ inserts the highlighted row. We
              // keep focus in the textarea so typing / backspacing past the
              // trigger still works naturally. This guard MUST run first so
              // prompt-history recall never steals ↑/↓ from the picker.
              if (trigger && pickerRef.current) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  pickerRef.current.move("down");
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  pickerRef.current.move("up");
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  pickerRef.current.select();
                  return;
                }
              }
              // Prompt-history recall (↑/↓ like bash/readline). Only fires
              // when no picker is open (handled above), for a session with
              // prior history, and when the caret is at a sensible edge:
              //   ArrowUp  — caret at 0,0 OR value is empty
              //   ArrowDown — active recall AND caret at end of value
              if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                const history = historyRef.current;
                if (history.length === 0) {
                  // No recorded prompts yet for this session — do nothing
                  // and let the native caret behavior take over.
                } else {
                  const ta = e.currentTarget;
                  const atStart =
                    (ta.selectionStart === 0 && ta.selectionEnd === 0) ||
                    ta.value.length === 0;
                  if (atStart) {
                    e.preventDefault();
                    if (historyIndex === null) {
                      setStashed(text);
                      setHistoryIndex(0);
                      setTextAndMoveCaretToEnd(history[history.length - 1]);
                    } else if (historyIndex < history.length - 1) {
                      const next = historyIndex + 1;
                      setHistoryIndex(next);
                      setTextAndMoveCaretToEnd(
                        history[history.length - 1 - next],
                      );
                    }
                    return;
                  }
                }
              }
              if (
                e.key === "ArrowDown" &&
                !e.shiftKey &&
                !e.altKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                historyIndex !== null
              ) {
                const ta = e.currentTarget;
                const atEnd =
                  ta.selectionStart === ta.value.length &&
                  ta.selectionEnd === ta.value.length;
                if (atEnd) {
                  e.preventDefault();
                  const history = historyRef.current;
                  if (historyIndex > 0) {
                    const next = historyIndex - 1;
                    setHistoryIndex(next);
                    setTextAndMoveCaretToEnd(
                      history[history.length - 1 - next],
                    );
                  } else {
                    // historyIndex === 0 — restore the user's draft.
                    const toRestore = stashed;
                    exitRecall();
                    setTextAndMoveCaretToEnd(toRestore);
                  }
                  return;
                }
              }
              if (e.key === "Escape" && historyIndex !== null && !trigger) {
                // Escape while recalling (and no picker is eating the key)
                // cancels the recall and restores the stashed draft.
                e.preventDefault();
                const toRestore = stashed;
                exitRecall();
                setTextAndMoveCaretToEnd(toRestore);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
                return;
              }
              if (e.key === "Escape" && trigger) {
                e.preventDefault();
                dismissPicker();
              }
            }}
            placeholder={
              isArchived
                ? "此会话已归档 — 只读"
                : isErrored
                ? "会话出错 — 请新建会话以继续"
                : busy
                ? "可在此输入，claude 思考时消息会加入队列…"
                : "输入消息… 试试用 / 或 @"
            }
            disabled={isLocked}
          />
          <div className="flex items-center justify-between px-1 mt-1">
            {/* Mobile: show model · mode here (mockup 929). Desktop (mockup
                1066) shows model · mode · {ctx}k ctx on the composer foot. */}
            <div className="mono text-ui text-ink-muted">
              {session ? (
                <>
                  {getModelLabel(session.model, customModels)} ·{" "}
                  {MODE_LABEL[session.mode] ?? session.mode} ·{" "}
                  {EFFORT_LABEL[session.effort] ?? session.effort} ·{" "}
                  <span className="mono">
                    {(() => {
                      // Context window size formatter. Below 1M tokens we keep
                      // the familiar "200k" shape; at or above 1M we switch to
                      // "1m" / "1.2m" so 1,000,000 doesn't render as the
                      // clunky "1000k". The k→m boundary matches StatsSheet's
                      // formatCount so the whole UI agrees on vocabulary.
                      const toks = contextWindowTokens(session.model);
                      if (toks >= 1_000_000) {
                        const m = toks / 1_000_000;
                        return `${m.toFixed(1).replace(/\.0$/, "")}m`;
                      }
                      return `${Math.round(toks / 1000)}k`;
                    })()} ctx
                  </span>
                </>
              ) : (
                "—"
              )}
            </div>
            {isLocked ? null : busy ? (
              text.trim() || attachments.length > 0 ? (
                // While claude is working, if the user has typed something
                // the right-side button flips from Stop to Queue — tapping
                // it sends the draft, which the server queues behind the
                // in-flight turn. Matches the "Type while claude thinks —
                // will queue…" placeholder so the action lines up with the
                // hint. Hitting Stop in this state would throw the draft
                // away, which is the opposite of what a user who just
                // typed wants.
                <>
                  <button
                    type="button"
                    onClick={send}
                    title="将消息加入队列"
                    aria-label="将消息加入队列"
                    className="md:hidden h-8 w-8 rounded-full bg-klein text-canvas flex items-center justify-center shadow-card hover:bg-klein/90 transition-colors"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={send}
                    title="将消息加入队列"
                    aria-label="将消息加入队列"
                    className="hidden md:inline-flex h-8 px-3 rounded bg-klein text-canvas text-ui font-medium items-center gap-1.5 shadow-card hover:bg-klein/90 transition-colors"
                  >
                    加入队列
                    <Send className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onStop}
                    title="停止 claude"
                    aria-label="停止 claude"
                    className="md:hidden h-8 w-8 rounded-full bg-danger text-canvas flex items-center justify-center shadow-card hover:bg-danger/90 transition-colors"
                  >
                    <StopCircle className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={onStop}
                    title="停止 claude"
                    aria-label="停止 claude"
                    className="hidden md:inline-flex h-8 px-3 rounded bg-danger text-canvas text-ui font-medium items-center gap-1.5 shadow-card hover:bg-danger/90 transition-colors"
                  >
                    <StopCircle className="w-4 h-4" />
                    停止
                  </button>
                </>
              )
            ) : (
              <>
                <button
                  type="button"
                  onClick={send}
                  disabled={!text.trim() && attachments.length === 0}
                  className="md:hidden h-8 w-8 rounded-full bg-klein text-canvas flex items-center justify-center shadow-card disabled:opacity-40 hover:bg-klein/90 transition-colors"
                  aria-label="发送消息"
                >
                  <Send className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={send}
                  disabled={!text.trim() && attachments.length === 0}
                  className="hidden md:inline-flex h-8 px-3 rounded bg-klein text-canvas text-ui font-medium items-center gap-1.5 shadow-card disabled:opacity-40 hover:bg-klein/90 transition-colors"
                  aria-label="发送消息"
                >
                  发送
                  <Send className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Send-blocked hint — shown when the user tries to send a top-of-
          message slash command we've marked REPL-only. Renders outside the
          composer card so it doesn't steal the focus ring. Cleared by any
          further edit or a successful send. */}
      {blockedSlash && (
        <div
          className="shrink-0 px-4 pb-2 -mt-1 text-ui text-danger/80"
          role="status"
        >
          <span className="mono">/{blockedSlash}</span> 仅限 CLI 命令 — 无法从 claudex 发送。
        </div>
      )}

      {trigger?.kind === "slash" && (
        <SlashCommandSheet
          ref={pickerRef}
          commands={slashCommands}
          initialQuery={trigger.query}
          onPick={handlePickSlash}
          onClaudexAction={(action) => {
            // Close the picker + remove the half-typed `/` sigil so the
            // composer isn't left with a stray "/" after the action runs.
            const el = textareaRef.current;
            const cursor = el?.selectionEnd ?? text.length;
            const start = trigger?.start ?? cursor;
            const next = text.slice(0, start) + text.slice(cursor);
            setText(next);
            setTrigger(null);
            onClaudexAction?.(action);
          }}
          onClose={dismissPicker}
        />
      )}
      {trigger?.kind === "mention" && project && (
        <FileMentionSheet
          ref={pickerRef}
          projectRoot={project.path}
          initialQuery={trigger.query}
          onPick={handlePickMention}
          onClose={dismissPicker}
        />
      )}
    </>
  );

  // Helper: inject `/compact` at the cursor (or at the start of the buffer
  // if empty). Keeps the chip behaviour consistent with typing `/compact`
  // manually.
  function insertCompact() {
    const el = textareaRef.current;
    const cursor = el?.selectionEnd ?? text.length;
    if (/^\s*$/.test(text)) {
      const next = "/compact ";
      setText(next);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        try {
          t.setSelectionRange(next.length, next.length);
        } catch {
          /* ignore */
        }
      });
    } else {
      const next = text.slice(0, cursor) + "/compact " + text.slice(cursor);
      setText(next);
    }
  }
}

// ---------------------------------------------------------------------------
// HighlightedComposer — a textarea that renders its content with syntax
// highlighting for `/command` and `@file` tokens. The trick: stack a
// transparent `<textarea>` on top of a `<pre>` mirror that has identical
// padding/font/line-height. The textarea owns the caret + selection, the
// mirror owns the colors. We sync scroll so long-wrapped text stays aligned.
//
// The textarea is the source of truth — its `value`/`onChange` wiring is
// untouched so the parent Composer's trigger detection keeps working.
// ---------------------------------------------------------------------------
function HighlightedComposer({
  textareaRef,
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const mirrorRef = useRef<HTMLPreElement>(null);

  // Keep the mirror's scroll position in sync with the textarea so that
  // long content stays visually aligned. Fires on both input and scroll
  // (e.g. when the caret moves to a line outside the viewport).
  function syncScroll() {
    const t = textareaRef.current;
    const m = mirrorRef.current;
    if (!t || !m) return;
    m.scrollTop = t.scrollTop;
    m.scrollLeft = t.scrollLeft;
  }

  // Resize the textarea to match its content up to max-h-40 (160px). The
  // CSS clamp means scrollHeight will cap there and the browser takes over
  // with an internal scrollbar — exactly the UX we want (grow with the
  // user's keystrokes, stop at 10-ish lines, scroll within).
  function autoResize() {
    const t = textareaRef.current;
    if (!t) return;
    // Reset then measure so shrinking text also shrinks the box.
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  }

  // Fire autoResize whenever the value changes from outside (slash-command
  // insertion, edit-last-user-message hydration, reset on send, …) so the
  // box tracks programmatic updates too, not just keystrokes.
  useEffect(() => {
    autoResize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const highlighted = useMemo(() => renderHighlighted(value), [value]);

  return (
    <div className="relative">
      <pre
        ref={mirrorRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words font-sans text-[13px] leading-[1.5] text-ink py-1 px-2"
      >
        {highlighted}
      </pre>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          onChange(e);
          // Run after the textarea updates its own scroll metrics so
          // autoResize sees the new scrollHeight and syncScroll sees the
          // new scrollTop.
          requestAnimationFrame(() => {
            autoResize();
            syncScroll();
          });
        }}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        rows={1}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        className={cn(
          "relative w-full bg-transparent outline-none font-sans text-[13px] leading-[1.5] resize-none min-h-[24px] max-h-40 overflow-y-auto py-1 px-2 text-transparent caret-ink selection:bg-klein/20 selection:text-transparent placeholder:text-ink-muted",
          disabled && "opacity-70 cursor-not-allowed",
        )}
      />
    </div>
  );
}

// Tokenize the composer's raw text into a React fragment list where slash
// commands and file mentions are wrapped in colored spans. Everything else
// renders as plain text so whitespace is preserved.
//
// Regex notes:
// - `/cmd`   must be followed by a word boundary (whitespace or end). Slash-
//   only is NOT a token — users typing "/" shouldn't see a flash of color.
// - `@path`  matches until the next whitespace. `@` alone is also not a token.
// The trailing newline quirk (textarea vs pre sizing): if the string ends
// with `\n`, append a zero-width space so the mirror keeps a full final line.
function renderHighlighted(text: string): React.ReactNode {
  const display = text.endsWith("\n") ? text + "​" : text;
  const pattern = /(\/[a-z][a-z0-9-]*)(?=\s|$)|(@\S+)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(display)) !== null) {
    const start = match.index;
    const token = match[0];
    if (start > last) {
      parts.push(display.slice(last, start));
    }
    parts.push(
      <span key={key++} className="text-klein">
        {token}
      </span>,
    );
    last = start + token.length;
  }
  if (last < display.length) {
    parts.push(display.slice(last));
  }
  return parts;
}

/**
 * One-line honest summary of a tool_result for the folded merged chip.
 *
 *  - isError          → prefix with `✗` (rendered in danger color by caller).
 *  - empty            → `empty`.
 *  - image-only       → `image only` (all textual content was image markers).
 *  - explicit error   → multi-line stack / "Error:" prefix → first line + `✗`.
 *  - short one-liner  → first line verbatim, up to 80 chars.
 *  - otherwise        → `N lines, M chars`.
 */
function summarizeResult(content: string, isError: boolean): string {
  const { remainingText } = extractImagesFromText(content);
  const trimmed = remainingText.trim();
  if (trimmed.length === 0) {
    // Content might have been pure image markers; distinguish so users know
    // the result wasn't just silence.
    if (content.trim().length > 0) return "仅图片";
    return isError ? "✗ 空" : "空";
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const looksLikeError =
    isError ||
    /^Error:|Traceback \(most recent call last\):/i.test(trimmed);
  if (looksLikeError) {
    const head = firstLine.length > 80 ? firstLine.slice(0, 78) + "…" : firstLine;
    return `✗ ${head || "错误"}`;
  }
  const lineCount = trimmed.split(/\r?\n/).length;
  if (lineCount === 1 && firstLine.length <= 80) return firstLine;
  const lineLbl = `${lineCount} 行`;
  const charLbl = `${trimmed.length} 字符`;
  return `${lineLbl}，${charLbl}`;
}

/**
 * Pretty-print tool input for the expanded chip body. Defensive against
 * circular references (shouldn't happen over the wire, but the JSON we get
 * is ultimately user-controlled so we don't want a single weird call to
 * crash the component).
 */
function safeStringify(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// ---------------------------------------------------------------------------
// Transcript filtering — drops subagent-lifecycle events and subagent-owned
// children out of the main thread (they live in the Subagents rail/sheet
// instead), and hides thinking blocks from the chat. The old verbose /
// summary view modes are gone — the transcript always renders in the
// previous "Normal" shape.
// ---------------------------------------------------------------------------
function filterPiecesForView(pieces: UIPiece[], showThinking: boolean): UIPiece[] {
  return pieces.filter((p) => {
    if (
      p.kind === "subagent_start" ||
      p.kind === "subagent_progress" ||
      p.kind === "subagent_update" ||
      p.kind === "subagent_end" ||
      p.kind === "subagent_tool_progress"
    ) {
      return false;
    }
    if (
      (p.kind === "assistant_text" ||
        p.kind === "thinking" ||
        p.kind === "tool_use" ||
        p.kind === "tool_result") &&
      typeof p.parentToolUseId === "string" &&
      p.parentToolUseId.length > 0
    ) {
      return false;
    }
    if (p.kind === "thinking" && !showThinking) return false;
    if (p.kind === "thinking" && !p.text.trim()) return false;
    return true;
  });
}
