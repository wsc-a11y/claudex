import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Pencil,
  Search,
  X,
} from "lucide-react";
import type {
  BrowseEntry,
  BrowseReadResponse,
  Project,
} from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { AppShell } from "@/components/AppShell";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import {
  basename as pathBasename,
  buildCrumbs as buildPathCrumbs,
  dirname as pathDirname,
  isAbsolutePath,
  isWindowsPath,
  splitPath,
} from "@/lib/path";

// ---------------------------------------------------------------------------
// Files browser (mockup s-14). Read-only, general-purpose host filesystem
// viewer — not project-scoped. Defaults to the user's home directory and
// supports Home / Up / Root navigation so the user can browse anywhere on
// the host.
//
// This used to be a project-scoped tree view keyed to a Project row, but
// that made the Files tab useless for anyone trying to look at a file
// outside a project they'd already registered. The tree expansion model
// also didn't play well with crossing into directories above the project
// root, so we collapsed it to a flat one-directory-at-a-time list — same
// UX as FolderPicker and the @-file mention sheet, which were already
// doing this right.
//
// Non-goals for this cut:
//   - Editing (read-only only)
//   - Full-text search across files (we only filter the current listing)
//   - Syntax highlighting (plain <pre> with line numbers; fine for now)
//   - Git status annotations (those live in the project-scoped /api/files/*
//     endpoints; re-adding them here would require walking up to find a
//     .git and running git-status per viewed directory — scope creep)
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Cross-platform path helpers live in web/src/lib/path.ts — they handle
// POSIX roots, Windows drive letters (D:\), and UNC shares. Don't
// reintroduce `split("/")` or `endsWith("/")` checks here; they break
// the moment a Windows host ships an absolute path through /api/browse.

// Classify a file by extension so we know which preview renderer to use.
// Anything we don't recognize falls through to "text" — the server will
// 415 with binary_file if the bytes don't look like text and the UI will
// show the "no preview" message.
type PreviewKind = "text" | "image" | "pdf" | "html" | "markdown" | "audio" | "video" | "office";

function previewKindForPath(absPath: string): PreviewKind {
  const ext = (absPath.split(".").pop() ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tiff", "tif"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["html", "htm"].includes(ext)) return "html";
  if (["md", "markdown", "mdown", "mkd", "mkdn"].includes(ext)) return "markdown";
  if (["mp3", "wav", "ogg", "flac", "aac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov"].includes(ext)) return "video";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"].includes(ext)) return "office";
  return "text";
}

// Build a same-origin URL for the /api/browse/raw endpoint. Cookie auth is
// sent automatically by the browser when the <img>/<iframe>/<audio>/<video>
// tag fetches the bytes — no API client changes needed.
function rawUrl(absPath: string, download = false): string {
  const qs = new URLSearchParams({ path: absPath });
  if (download) qs.set("download", "1");
  return `/api/browse/raw?${qs.toString()}`;
}

/**
 * URL of the standalone 文件站 (`web/files.html`) seen from inside the main
 * app. Built app: the claudex server hosts both HTML entries same-origin, so
 * it's just `/files.html`. Dev: the main vite instance runs on 5173 while the
 * file station gets its own instance on 5174 — the mirror of `mainSiteHref()`
 * in files-main.tsx (which maps 5174 → 5173 the other way).
 */
function fileStationHref(): string {
  if (typeof window !== "undefined" && window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:5174/`;
  }
  return "/files.html";
}

/**
 * Corner link from the main-site Files tab to the standalone 文件站 — the
 * reverse of the "主站" link files-main.tsx renders in the file station's
 * top bar. Opens a new tab: the file station is a separate HTML entry with
 * no claudex chrome (full-screen read-only browsing + a shareable URL), so
 * it should keep its own history stack and let the main app stay put behind
 * it. Rendered only in embedded (non-standalone) mode — the file station
 * itself must not link to itself.
 */
function FileStationLink() {
  return (
    <a
      href={fileStationHref()}
      target="_blank"
      rel="noreferrer"
      title="在新标签页打开独立文件站(无侧栏的全屏文件浏览器)"
      aria-label="在新标签页打开独立文件站"
      className="ml-auto shrink-0 inline-flex items-center gap-1 text-ui text-ink-soft hover:text-klein transition-colors"
    >
      文件站 <ExternalLink className="w-3 h-3" />
    </a>
  );
}

/** Copy text to the clipboard with an HTTP (non-secure-context) fallback.
 *  claudex is served over plain HTTP through an frpc tunnel, so
 *  `navigator.clipboard.writeText` is undefined on the user's mobile; we
 *  fall back to a hidden textarea + execCommand. */
function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* give up silently — nothing else to try */
  }
  ta.remove();
}

// sessionStorage key for "last file opened in the Files tab" — restored on
// re-mount within the same browser session (tab-scoped). Deliberately not
// localStorage: the user only expects this auto-reopen within a single
// session, and sessionStorage survives SPA navigation between tabs within
// the app but not a fresh browser session.
const LAST_FILE_KEY = "claudex:files:lastOpenedFile";

function readLastOpenedFile(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(LAST_FILE_KEY);
  } catch {
    return null;
  }
}

function writeLastOpenedFile(p: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (p) window.sessionStorage.setItem(LAST_FILE_KEY, p);
    else window.sessionStorage.removeItem(LAST_FILE_KEY);
  } catch {
    /* quota / private mode — ignore */
  }
}

function errorMessage(code: string): string {
  switch (code) {
    case "not_absolute":
      return "路径必须是绝对路径。";
    case "not_found":
      return "该路径在主机上不存在。";
    case "not_a_directory":
      return "该路径是文件,不是文件夹。";
    case "is_a_directory":
      return "该路径是文件夹,不是文件。";
    case "permission_denied":
      return "权限不足,服务器无法读取该路径。";
    case "binary_file":
      return "二进制文件,无预览可用。";
    default:
      return `无法加载该路径 (${code})。`;
  }
}

// ---- screen ----------------------------------------------------------------

interface BrowseData {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

/**
 * One browser-history entry in standalone ("文件站") mode: a directory, or a
 * directory + file preview open on top of it. The whole navigation stack is
 * pushed through history.pushState so the mobile back button walks it back
 * one step at a time (close preview → parent dir → …) instead of leaving
 * the page. We never push the initial home-dir load — only user actions.
 */
interface FilesNavSnap {
  dir: string;
  file: string | null;
}

export function FilesScreen({
  standalone = false,
}: {
  /** Standalone mode ("文件站" second entry): render WITHOUT the claudex
   *  AppShell chrome (the caller supplies its own full-height frame), and
   *  push every dir/file navigation into browser history so the device
   *  back button unwinds the folder stack instead of exiting the page. */
  standalone?: boolean;
} = {}) {
  // current directory the listing is showing
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [browse, setBrowse] = useState<BrowseData | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // selected file preview
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileData, setFileData] = useState<BrowseReadResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  // Preview kind derived from the path extension. Drives which renderer
  // (text / image / pdf / html / audio / video / office) the preview
  // panel uses. Set synchronously by openFile() alongside selectedFilePath
  // so there's no flash of the wrong renderer while browseRead resolves.
  const [previewKind, setPreviewKind] = useState<PreviewKind | null>(null);
  // Size of the currently-selected file, copied out of the BrowseEntry at
  // click time. Used for the header size line when we don't have
  // fileData (i.e. non-text kinds that skip /api/browse/read).
  const [previewSize, setPreviewSize] = useState<number | null>(null);

  // projects (for the "jump to project" dropdown — a convenience, not the
  // primary nav anymore)
  const [projects, setProjects] = useState<Project[]>([]);

  const [searchQuery, setSearchQuery] = useState("");
  // Persist the show-hidden preference so users who want to see dotfiles
  // don't have to re-enable the toggle every time. localStorage is fine on
  // an HTTP (non-secure-context) origin. Guarded against missing `window`
  // for safety even though this component only ever runs in the browser.
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("claudex:files:showHidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleHidden = useCallback(() => {
    setShowHidden((v) => {
      const next = !v;
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            "claudex:files:showHidden",
            next ? "1" : "0",
          );
        }
      } catch {
        /* quota / private mode — ignore */
      }
      return next;
    });
  }, []);

  // First render: fetch user's home directory and land there. Don't
  // clobber a currentPath the sessionStorage restore may have already set
  // — openFile() now syncs the listing to the file's parent dir, so the
  // restore path and this fetch can race, and we want the restored value
  // to win.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const home = await api.browseHome();
        if (cancelled) return;
        setCurrentPath((prev) => prev ?? home.path);
      } catch {
        // Very unlikely, but if /api/browse/home fails we still try "/" so
        // the screen isn't permanently stuck.
        if (!cancelled) setCurrentPath((prev) => prev ?? "/");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load listing whenever `currentPath` changes.
  useEffect(() => {
    if (!currentPath) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    // Reset search when changing directories — stale filter would hide
    // everything in the new folder.
    setSearchQuery("");
    (async () => {
      try {
        const res = await api.browse(currentPath);
        if (cancelled) return;
        setBrowse(res);
      } catch (e) {
        if (cancelled) return;
        setListError(e instanceof ApiError ? e.code : "load_failed");
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  // Best-effort: load projects once so the "jump to project" dropdown works.
  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Run-once guard for the sessionStorage auto-restore below. Declared
  // here (near the other state) so the effect that uses it stays near
  // the `openFile` it references.
  const restoredRef = useRef(false);

  const openFile = useCallback(async (absPath: string, entry?: BrowseEntry) => {
    const kind = previewKindForPath(absPath);
    setSelectedFilePath(absPath);
    setPreviewKind(kind);
    setPreviewSize(entry?.size ?? null);
    setFileData(null);
    setFileError(null);
    // Keep the side listing in sync with the previewed file — the user
    // asked for one "location" shared between the tree and the preview.
    // If the file's parent is already the current dir this is a no-op;
    // otherwise the listing effect will refetch the new dir.
    setCurrentPath((prev) => {
      const parent = pathDirname(absPath);
      return prev === parent ? prev : parent;
    });
    // For non-text kinds the <img>/<iframe>/<audio>/<video> tag loads the
    // bytes itself — we don't need to hit /api/browse/read at all, and
    // doing so would just 415 with binary_file for images/pdfs/etc.
    // html and markdown are still fetched as text so the default view is
    // the source; the MobilePreviewSheet / Desktop preview shows a Render
    // toggle that swaps in an iframe (html) or the <Markdown> renderer (md).
    if (kind !== "text" && kind !== "html" && kind !== "markdown") {
      setFileLoading(false);
      // Persist the selection so the sessionStorage restore still works
      // for binary previews — nothing to validate server-side up front,
      // and if the file has vanished the tag's onError will surface it.
      writeLastOpenedFile(absPath);
      return;
    }
    setFileLoading(true);
    try {
      const res = await api.browseRead(absPath);
      setFileData(res);
      // Remember the successfully-opened file so a re-mount within the
      // same browser session restores it. We only persist on success —
      // paths that blow up with not_found / permission_denied aren't
      // worth re-trying on next mount.
      writeLastOpenedFile(absPath);
    } catch (e) {
      setFileError(
        e instanceof ApiError ? errorMessage(e.code) : "无法加载此文件。",
      );
      setFileData(null);
      // If the file has since vanished, stop auto-reopening it.
      if (e instanceof ApiError && e.code === "not_found") {
        writeLastOpenedFile(null);
      }
    } finally {
      setFileLoading(false);
    }
  }, []);

  const closePreview = useCallback(() => {
    setSelectedFilePath(null);
    setFileData(null);
    setFileError(null);
    setPreviewKind(null);
    setPreviewSize(null);
    // User explicitly dismissed the preview — don't resurrect it next time.
    writeLastOpenedFile(null);
  }, []);

  // ---- standalone history stack (文件站 back button) -----------------------
  // Every navigation is a history entry carrying the *target* state, so
  // popstate can simply restore what the entry describes. The browser keeps
  // the stack; we only need pushState + a popstate listener.
  const pushSnap = useCallback((snap: FilesNavSnap) => {
    if (!standalone || typeof window === "undefined") return;
    // Skip no-op pushes (re-tapping the current dir, etc.) so back never
    // walks through an unchanged frame.
    const cur = window.history.state as FilesNavSnap | null;
    if (cur && cur.dir === snap.dir && cur.file === snap.file) return;
    window.history.pushState(snap, "");
  }, [standalone]);

  /** User navigated to a directory (folder click / breadcrumb / path submit /
   *  Home / Root / Up / project jump). The callers set state themselves; this
   *  only records the frame for back. */
  const navDir = useCallback(
    (absPath: string) => {
      pushSnap({ dir: absPath, file: null });
      setCurrentPath(absPath);
    },
    [pushSnap],
  );

  /** User opened a file — push the preview frame {parent dir, file} first,
   *  then do the real (history-free) open. */
  const navOpenFile = useCallback(
    (absPath: string, entry?: BrowseEntry) => {
      pushSnap({ dir: pathDirname(absPath), file: absPath });
      void openFile(absPath, entry);
    },
    [openFile, pushSnap],
  );

  /** User dismissed the preview sheet → the frame underneath is the current
   *  directory with no file open. */
  const navClosePreview = useCallback(() => {
    pushSnap({ dir: currentPath ?? browse?.path ?? "/", file: null });
    closePreview();
  }, [pushSnap, closePreview, currentPath, browse]);

  // Device/system back button: popstate fires with the state of the entry we
  // just returned TO. Restore it exactly — reopen the file if the entry has
  // one, otherwise land on the directory with no preview. (openFile /
  // closePreview are called directly here — never through the nav wrappers —
  // so a back navigation cannot itself push another history entry.)
  useEffect(() => {
    if (!standalone) return;
    const onPop = (e: PopStateEvent) => {
      const snap = e.state as FilesNavSnap | null;
      if (!snap) return; // no in-app entry — let the browser leave the page
      if (snap.file) {
        void openFile(snap.file);
      } else {
        setCurrentPath(snap.dir);
        closePreview();
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [standalone, openFile, closePreview]);

  // Restore the last-opened file (sessionStorage) on mount. If the file
  // still exists, we pop the preview sheet back open exactly like a
  // normal click. If it's gone (not_found), openFile itself clears the
  // stashed path and shows the standard "does not exist" error — so the
  // user at least knows why nothing came up.
  //
  // `openFile` is stable (empty deps), but we still gate with a ref so a
  // stray re-run from hot-reload or dep change can't double-restore.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const last = readLastOpenedFile();
    if (last) {
      void openFile(last);
      // In standalone mode the auto-restore isn't a user action, so it must
      // not push a "file open" entry — but leave a base frame behind so the
      // first back press closes the preview (landing on its parent dir)
      // instead of leaving the file station outright.
      if (standalone) pushSnap({ dir: pathDirname(last), file: null });
    }
  }, [openFile, standalone, pushSnap]);

  const goHome = useCallback(async () => {
    try {
      const home = await api.browseHome();
      pushSnap({ dir: home.path, file: null });
      setCurrentPath(home.path);
    } catch {
      /* ignore — toolbar button is best-effort */
    }
  }, [pushSnap]);

  const goRoot = useCallback(() => {
    // On Windows we jump to the current drive's root (e.g. `D:\`) so
    // users don't land on whatever `path.resolve("/")` picks on the
    // server side. On POSIX we still go to `/` — the one true root.
    const root =
      currentPath && isWindowsPath(currentPath)
        ? splitPath(currentPath).root
        : "/";
    pushSnap({ dir: root, file: null });
    setCurrentPath(root);
  }, [currentPath, pushSnap]);

  const goUp = useCallback(() => {
    if (browse?.parent) {
      pushSnap({ dir: browse.parent, file: null });
      setCurrentPath(browse.parent);
    }
  }, [browse, pushSnap]);

  const goToProject = useCallback(
    (projectPath: string) => {
      pushSnap({ dir: projectPath, file: null });
      setCurrentPath(projectPath);
    },
    [pushSnap],
  );

  // Keep tree & preview on the same location: if the side listing moves
  // somewhere that doesn't contain the previewed file, drop the preview.
  // openFile() keeps them aligned proactively, so the only way to land
  // here is an explicit navigation (Breadcrumb, Home/Root/Up, folder
  // click, project jump, path input) — the exact cases the user wants
  // to reset the preview for.
  useEffect(() => {
    if (!currentPath || !selectedFilePath) return;
    if (pathDirname(selectedFilePath) !== currentPath) {
      closePreview();
    }
  }, [currentPath, selectedFilePath, closePreview]);

  // Resolve a user-entered path: try it as a directory first, fall back
  // to opening it as a file if the server says `not_a_directory`. Any
  // other error surfaces inline on the listing (same channel as a failed
  // browse — keeps the UX consistent with clicking a now-missing dir).
  const resolvePath = useCallback(
    async (raw: string) => {
      const input = raw.trim();
      if (!input) return;
      if (!isAbsolutePath(input)) {
        setListError("not_absolute");
        return;
      }
      setListError(null);
      try {
        await api.browse(input);
        navDir(input);
      } catch (e) {
        if (e instanceof ApiError && e.code === "not_a_directory") {
          await navOpenFile(input);
          return;
        }
        setListError(e instanceof ApiError ? e.code : "load_failed");
      }
    },
    [navDir, navOpenFile],
  );

  const visibleEntries = useMemo(() => {
    if (!browse) return [] as BrowseEntry[];
    const base = browse.entries.filter((e) => showHidden || !e.isHidden);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((e) => e.name.toLowerCase().includes(q));
  }, [browse, showHidden, searchQuery]);

  const hiddenCount = browse
    ? browse.entries.filter((e) => e.isHidden).length
    : 0;

  const filesBody = (
    <>
      {/* Mobile */}
      <div className="flex-1 min-h-0 flex flex-col md:hidden overflow-hidden">
        <MobileFilesView
          standalone={standalone}
          currentPath={currentPath}
          browse={browse}
          listLoading={listLoading}
          listError={listError}
          visibleEntries={visibleEntries}
          hiddenCount={hiddenCount}
          showHidden={showHidden}
          onToggleHidden={toggleHidden}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedFilePath={selectedFilePath}
          fileData={fileData}
          fileLoading={fileLoading}
          fileError={fileError}
          previewKind={previewKind}
          previewSize={previewSize}
          onNavigate={navDir}
          onOpenFile={navOpenFile}
          onClosePreview={navClosePreview}
          onHome={goHome}
          onRoot={goRoot}
          onUp={goUp}
          onSubmitPath={resolvePath}
          projects={projects}
          onGoToProject={goToProject}
        />
      </div>
      {/* Desktop */}
      <div className="hidden md:flex flex-1 min-h-0 overflow-hidden">
        <DesktopFilesView
          standalone={standalone}
          currentPath={currentPath}
          browse={browse}
          listLoading={listLoading}
          listError={listError}
          visibleEntries={visibleEntries}
          hiddenCount={hiddenCount}
          showHidden={showHidden}
          onToggleHidden={toggleHidden}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedFilePath={selectedFilePath}
          fileData={fileData}
          fileLoading={fileLoading}
          fileError={fileError}
          previewKind={previewKind}
          previewSize={previewSize}
          onNavigate={navDir}
          onOpenFile={navOpenFile}
          onClosePreview={navClosePreview}
          onHome={goHome}
          onRoot={goRoot}
          onUp={goUp}
          onSubmitPath={resolvePath}
          projects={projects}
          onGoToProject={goToProject}
        />
      </div>
    </>
  );
  return standalone ? (
    filesBody
  ) : (
    <AppShell tab="files">{filesBody}</AppShell>
  );
}

// ---- shared row ------------------------------------------------------------

function EntryRow({
  entry,
  active,
  onClick,
  variant,
}: {
  entry: BrowseEntry;
  active: boolean;
  onClick: () => void;
  variant: "mobile" | "desktop";
}) {
  const isMobile = variant === "mobile";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 text-left border-l-2",
        isMobile ? "px-4 py-2.5 text-ui-lg" : "px-3 py-1.5 text-ui",
        active
          ? "bg-klein-wash/50 border-l-klein"
          : "hover:bg-canvas/60 border-l-transparent transition-colors",
      )}
    >
      {entry.isDir ? (
        <Folder
          className={cn(
            "shrink-0 text-klein",
            isMobile ? "w-4 h-4" : "w-3.5 h-3.5",
          )}
        />
      ) : (
        <FileIcon
          className={cn(
            "shrink-0 text-ink-faint",
            isMobile ? "w-4 h-4" : "w-3.5 h-3.5",
          )}
        />
      )}
      <span
        className={cn(
          "mono flex-1 truncate",
          active ? "text-ink" : entry.isHidden ? "text-ink-faint" : "text-ink-soft",
        )}
      >
        {entry.name}
      </span>
      {!entry.isDir && entry.size !== undefined && (
        <span className="mono text-ui-sm text-ink-faint shrink-0">
          {formatSize(entry.size)}
        </span>
      )}
      {entry.isDir && (
        <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />
      )}
    </button>
  );
}

// ---- toolbar ---------------------------------------------------------------

function Toolbar({
  onHome,
  onRoot,
  onUp,
  canUp,
  compact,
}: {
  onHome: () => void;
  onRoot: () => void;
  onUp: () => void;
  canUp: boolean;
  compact?: boolean;
}) {
  const size = compact ? "h-7 px-2 text-ui" : "h-8 px-2.5 text-ui";
  // Compact mode lives inside the 300px desktop left panel where labels +
  // three buttons + the HiddenToggle pill overflow and scroll `Up` off the
  // right edge. Drop the labels in compact — `title` / `aria-label` keep
  // the a11y + hover affordance intact.
  const iconOnly = !!compact;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
      <ToolbarButton
        onClick={onHome}
        icon={<Home className="w-3.5 h-3.5" />}
        label="首页"
        size={size}
        iconOnly={iconOnly}
      />
      <ToolbarButton
        onClick={onRoot}
        icon={<HardDrive className="w-3.5 h-3.5" />}
        label="根目录"
        size={size}
        iconOnly={iconOnly}
      />
      <ToolbarButton
        onClick={canUp ? onUp : undefined}
        icon={<ChevronRight className="w-3.5 h-3.5 rotate-180" />}
        label="上级"
        disabled={!canUp}
        size={size}
        iconOnly={iconOnly}
      />
    </div>
  );
}

/**
 * Toggle for hidden entries (leading-dot). Pulled out of the main Toolbar
 * so it has a fixed, always-visible position on the right edge — otherwise
 * the scrolling toolbar on a 390px viewport hides it off-screen, which is
 * how users miss that the Files screen can show hidden directories at all.
 *
 * Visual language:
 *   - Off (default): outlined eye with a count badge (`12` hidden here)
 *   - On: filled Klein-wash pill with EyeOff — "you are in show-hidden mode"
 * The state is persisted in localStorage so the preference sticks across
 * navigations and page reloads.
 */
function HiddenToggle({
  showHidden,
  onToggle,
  hiddenCount,
  compact,
}: {
  showHidden: boolean;
  onToggle: () => void;
  hiddenCount: number;
  compact?: boolean;
}) {
  const size = compact ? "h-7 px-2 text-ui" : "h-8 px-2.5 text-ui";
  // Compact mode → icon-only pill. On the desktop 300px left panel the
  // full "Show hidden 1" label was crowding the Toolbar and scrolling
  // `Up` off-screen. Keep the visual language (background swap + badge)
  // so the state is still readable at a glance.
  const iconOnly = !!compact;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={showHidden}
      aria-label={
        showHidden
          ? "隐藏以点开头的条目"
          : `显示隐藏条目(当前 ${hiddenCount} 个)`
      }
      title={
        showHidden
          ? "隐藏以点开头的条目"
          : `显示隐藏条目(当前 ${hiddenCount} 个)`
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border shrink-0",
        size,
        showHidden
          ? "border-klein/50 bg-klein-wash text-klein-ink"
          : "border-line bg-paper text-ink-soft hover:bg-paper/60 transition-colors",
      )}
    >
      {showHidden ? (
        <EyeOff className="w-3.5 h-3.5" />
      ) : (
        <Eye className="w-3.5 h-3.5" />
      )}
      {!iconOnly && <span>{showHidden ? "已隐藏" : "显示隐藏"}</span>}
      {!showHidden && hiddenCount > 0 && (
        <span className="mono text-ui-sm px-1 rounded-xs bg-canvas border border-line text-ink-muted">
          {hiddenCount}
        </span>
      )}
    </button>
  );
}

function ToolbarButton({
  onClick,
  icon,
  label,
  disabled,
  size,
  iconOnly,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  size: string;
  iconOnly?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-line shrink-0",
        size,
        disabled
          ? "bg-paper/40 text-ink-faint cursor-not-allowed"
          : "bg-canvas text-ink-soft hover:bg-paper/60 transition-colors",
      )}
    >
      {icon}
      {!iconOnly && label}
    </button>
  );
}

function ProjectJumpSelect({
  projects,
  onGoToProject,
  compact,
}: {
  projects: Project[];
  onGoToProject: (path: string) => void;
  compact?: boolean;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="relative shrink-0">
      <select
        value=""
        onChange={(e) => {
          const pr = projects.find((p) => p.id === e.target.value);
          if (pr) onGoToProject(pr.path);
          // reset so the same option can be selected again
          e.target.value = "";
        }}
        className={cn(
          "appearance-none pl-2.5 pr-7 rounded-sm bg-paper border border-line mono cursor-pointer",
          compact ? "h-7 text-ui" : "h-8 text-ui",
        )}
        title="跳转到项目根目录"
      >
        <option value="">跳转到项目…</option>
        {projects.map((pr) => (
          <option key={pr.id} value={pr.id}>
            {pr.name}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
        <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
      </span>
    </div>
  );
}

// ---- breadcrumb ------------------------------------------------------------
//
// Turns `/Users/haowu/Code/AI/claudex` into a set of clickable segments. Each
// segment navigates to the absolute path up to and including itself. The
// leading "/" is rendered as its own clickable root segment so the user can
// jump straight to `/` from anywhere.

interface Crumb {
  label: string;
  path: string;
}

// Delegate to the shared cross-platform splitter. Kept as a local thunk
// so the Breadcrumb component's call site stays `buildCrumbs(path)`.
function buildCrumbs(absPath: string): Crumb[] {
  return buildPathCrumbs(absPath);
}

function Breadcrumb({
  path,
  onNavigate,
  onSubmitPath,
  className,
}: {
  path: string;
  onNavigate: (p: string) => void;
  /** Called when the user submits a raw path via the inline input. If
   *  omitted, the edit affordance is hidden. */
  onSubmitPath?: (input: string) => void | Promise<void>;
  className?: string;
}) {
  const crumbs = buildCrumbs(path);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);

  // Whenever the caller's path changes (navigation happened through some
  // other channel — click a folder, Home, etc.), reset the draft so the
  // next time the user taps edit they start from the current location
  // rather than a stale string.
  useEffect(() => {
    if (!editing) setDraft(path);
  }, [path, editing]);

  const enterEdit = useCallback(() => {
    if (!onSubmitPath) return;
    setDraft(path || "/");
    setEditing(true);
    // Select-all on next tick so the user can overwrite the path with
    // a paste/typing motion without first tapping to clear.
    queueMicrotask(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }, [onSubmitPath, path]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft(path);
  }, [path]);

  const commitEdit = useCallback(() => {
    if (!onSubmitPath) return;
    const value = draft;
    setEditing(false);
    void onSubmitPath(value);
  }, [draft, onSubmitPath]);

  if (editing && onSubmitPath) {
    return (
      <div
        className={cn(
          "flex items-center gap-1 mono text-ui",
          className,
        )}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          onBlur={cancelEdit}
          placeholder="/绝对/路径"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="输入绝对路径"
          className="flex-1 min-w-0 h-6 px-1.5 bg-canvas border border-line rounded-xs text-ink outline-none focus:border-klein"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-1 overflow-x-auto no-scrollbar mono text-ui text-ink-muted",
        className,
      )}
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.path} className="inline-flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate(c.path)}
              className={cn(
                "hover:text-ink transition-colors",
                last && "text-ink",
              )}
              title={c.path}
            >
              {c.label}
            </button>
            {!last && <span className="text-ink-faint">/</span>}
          </span>
        );
      })}
      {onSubmitPath && (
        <button
          type="button"
          onClick={enterEdit}
          aria-label="编辑路径"
          title="编辑路径"
          className="ml-1 shrink-0 text-ink-faint hover:text-ink transition-colors"
        >
          <Pencil className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ---- copy button -----------------------------------------------------------
//
// Small, self-contained copy button with a "just copied" confirmation.
// Used for both "Copy path" and "Copy content" in the preview header so
// the user gets feedback that the action landed — important because
// claudex runs on plain HTTP (no navigator.clipboard) and the fallback
// copy via execCommand is silent on mobile.

function CopyButton({
  getText,
  label,
  title,
  className,
}: {
  /** Lazily resolve the text — keeps long file contents out of the
   *  closure until the user actually taps copy. */
  getText: () => string | null | undefined;
  label: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const text = getText();
  const disabled = !text;
  return (
    <button
      type="button"
      disabled={disabled}
      title={title ?? label}
      onClick={() => {
        const t = getText();
        if (!t) return;
        copyText(t);
        setCopied(true);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border border-line bg-canvas text-ui disabled:opacity-50 shrink-0",
        className,
      )}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-success" />
      ) : (
        <Copy className="w-3.5 h-3.5 text-ink-muted" />
      )}
      <span>{copied ? "已复制" : label}</span>
    </button>
  );
}

// ---- download button -------------------------------------------------------
//
// A link styled like CopyButton that opens rawUrl(path, true) in a new
// tab so the browser fires its native download UI. The server sends
// Content-Disposition: attachment when ?download=1, so mobile Safari /
// Chrome both treat it as a save rather than a navigation.

function DownloadButton({
  absPath,
  label = "下载",
  className,
}: {
  absPath: string;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={rawUrl(absPath, true)}
      target="_blank"
      rel="noopener"
      title={`下载 ${pathBasename(absPath) || absPath}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border border-line bg-canvas text-ui shrink-0",
        className,
      )}
    >
      <Download className="w-3.5 h-3.5 text-ink-muted" />
      <span>{label}</span>
    </a>
  );
}

// ---- binary preview renderers ---------------------------------------------
//
// Renders one of image / pdf / audio / video / office inline in the preview
// pane. Text and html go through the line-numbered <pre> view; for html the
// caller can flip `renderHtml` on via the header toggle to swap that for an
// iframe of the source. Office files get a friendly "download to view" card
// because nothing renders them usefully in the browser without a heavy
// viewer library.

function BinaryPreview({
  absPath,
  kind,
  fileData,
  renderHtml,
}: {
  absPath: string;
  kind: PreviewKind;
  // For html only — when fileData is loaded we can choose between source
  // text view (handled by the caller) and iframe rendered view (handled
  // here when renderHtml is true).
  fileData: BrowseReadResponse | null;
  renderHtml: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  const basename = pathBasename(absPath) || absPath;

  // Reset image error whenever the selected file changes.
  useEffect(() => {
    setImgError(false);
  }, [absPath]);

  if (kind === "image") {
    if (imgError) {
      return (
        <div className="flex-1 flex items-center justify-center text-ui text-danger mono px-6 text-center">
          无法加载图片。
        </div>
      );
    }
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center bg-canvas p-4 overflow-auto">
        <img
          src={rawUrl(absPath)}
          alt={basename}
          onError={() => setImgError(true)}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <iframe
        src={rawUrl(absPath)}
        title={basename}
        className="flex-1 w-full h-full border-0 bg-white"
      />
    );
  }

  if (kind === "audio") {
    return (
      <div className="flex-1 flex items-center justify-center bg-canvas px-6">
        <audio controls src={rawUrl(absPath)} className="w-full max-w-md" />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center bg-canvas p-4">
        <video
          controls
          src={rawUrl(absPath)}
          className="w-full max-h-full"
        />
      </div>
    );
  }

  if (kind === "office") {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-10 bg-canvas">
        <div className="max-w-md w-full p-5 rounded-lg border border-line bg-paper/60 text-center space-y-3">
          <div className="mono text-ui text-ink truncate" title={basename}>
            {basename}
          </div>
          <p className="text-ui text-ink-muted leading-[1.55]">
            Office 文件无法在浏览器中内联预览。请下载文件,用 Word、
            Excel、Keynote、LibreOffice 或类似应用打开。
          </p>
          <div className="flex items-center justify-center">
            <DownloadButton absPath={absPath} className="h-9 px-4" />
          </div>
        </div>
      </div>
    );
  }

  if (kind === "html" && renderHtml) {
    // Render the HTML via /api/browse/raw (served as text/html; charset=utf-8,
    // Content-Disposition: inline) rather than srcDoc so the iframe has a real
    // URL to resolve relative asset paths, fonts, <link>ed stylesheets, etc.
    // against — srcDoc's `about:srcdoc` origin has no base URL and silently
    // 404s every relative reference. Using the raw endpoint also sidesteps the
    // 1 MB cap on /api/browse/read, because raw streams up to 50 MB.
    //
    // Sandbox is `allow-scripts` (NOT `allow-same-origin`): scripts execute
    // — so Tailwind Play CDN, Alpine, jQuery, inline initialization, etc.
    // all render the way they would in a real browser tab — but the iframe
    // runs in a unique opaque origin, so any JS inside can't touch the
    // claudex auth cookie or read the parent document. Loading still carries
    // the session cookie because the initial GET is same-origin from the
    // browser's POV; sandbox only constrains the document once it loads.
    return (
      <iframe
        src={rawUrl(absPath)}
        title={basename}
        sandbox="allow-scripts"
        className="flex-1 w-full h-full border-0 bg-white"
      />
    );
  }

  if (kind === "markdown" && renderHtml && fileData) {
    // Rendered markdown view: run the file contents through the same
    // <Markdown> component used for assistant replies (react-markdown +
    // remark-gfm, no HTML passthrough). Scroll container mirrors the text
    // preview so the layout doesn't jump between Source/Render modes.
    return (
      <div className="flex-1 min-h-0 overflow-auto bg-canvas">
        <div className="px-5 py-4 max-w-[72ch] mx-auto">
          <Markdown source={fileData.content} />
          {fileData.truncated && (
            <div className="mono text-ui text-ink-faint mt-4">
              文件在 1 MB 处截断
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ---- preview panel ---------------------------------------------------------

function PreviewPanel({
  fileData,
  loading,
  error,
}: {
  fileData: BrowseReadResponse | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-ui text-ink-muted mono">
        加载中…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-ui text-danger mono px-6 text-center">
        {error}
      </div>
    );
  }
  if (!fileData) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-8">
        <p className="text-ui text-ink-muted">
          选择文件以预览其内容。
        </p>
      </div>
    );
  }
  const lines = fileData.content.split("\n");
  return (
    <div className="flex-1 overflow-auto bg-canvas">
      <div className="mono text-ui leading-[1.7] px-5 py-4">
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-[42px_1fr]">
            <span className="text-right pr-3 text-ink-faint select-none">
              {i + 1}
            </span>
            <span className="whitespace-pre">{line}</span>
          </div>
        ))}
        {fileData.truncated && (
          <div className="grid grid-cols-[42px_1fr]">
            <span className="text-right pr-3 text-ink-faint select-none">…</span>
            <span className="text-ink-faint">文件在 1 MB 处截断</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- mobile view -----------------------------------------------------------

interface FilesViewProps {
  /** Standalone ("文件站") mode — hides the FileStationLink corner link
   *  because the standalone page IS the file station. */
  standalone: boolean;
  currentPath: string | null;
  browse: BrowseData | null;
  listLoading: boolean;
  listError: string | null;
  visibleEntries: BrowseEntry[];
  hiddenCount: number;
  showHidden: boolean;
  onToggleHidden: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedFilePath: string | null;
  fileData: BrowseReadResponse | null;
  fileLoading: boolean;
  fileError: string | null;
  previewKind: PreviewKind | null;
  previewSize: number | null;
  onNavigate: (absPath: string) => void;
  onOpenFile: (absPath: string, entry?: BrowseEntry) => void;
  onClosePreview: () => void;
  onHome: () => void;
  onRoot: () => void;
  onUp: () => void;
  onSubmitPath: (input: string) => void | Promise<void>;
  projects: Project[];
  onGoToProject: (path: string) => void;
}

function MobileFilesView(p: FilesViewProps) {
  return (
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-3 pt-3 pb-2 bg-canvas/95 backdrop-blur border-b border-line shrink-0 space-y-2">
        {/* Breadcrumb row — the corner link to the standalone 文件站 sits at
            its right edge, mirroring the "主站" link in files.html's top bar. */}
        <div className="flex items-center gap-1.5">
          <Breadcrumb
            path={p.currentPath ?? ""}
            onNavigate={p.onNavigate}
            onSubmitPath={p.onSubmitPath}
            className="flex-1 min-w-0 px-1"
          />
          {!p.standalone && <FileStationLink />}
        </div>
        {/* Nav row: Home/Root/Up on the left (scrollable if it overflows),
            Show-hidden toggle pinned to the right so it's always visible
            on a 390px viewport — that was the original UX bug: the toggle
            was buried inside the scrolling toolbar where users never saw
            it. */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
            <Toolbar
              onHome={p.onHome}
              onRoot={p.onRoot}
              onUp={p.onUp}
              canUp={!!p.browse?.parent}
            />
          </div>
          <HiddenToggle
            showHidden={p.showHidden}
            onToggle={p.onToggleHidden}
            hiddenCount={p.hiddenCount}
          />
        </div>
        {/* Search + jump-to-project */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 flex items-center gap-2 h-9 px-3 bg-paper border border-line rounded">
            <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            <input
              type="text"
              placeholder="筛选此文件夹…"
              value={p.searchQuery}
              onChange={(e) => p.onSearchChange(e.target.value)}
              className="flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-muted"
            />
            {p.searchQuery && (
              <button
                type="button"
                onClick={() => p.onSearchChange("")}
                className="text-ink-muted"
                aria-label="清除搜索"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <ProjectJumpSelect
            projects={p.projects}
            onGoToProject={p.onGoToProject}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {p.listLoading && (
          <div className="px-4 py-4 text-ui text-ink-muted mono">加载中…</div>
        )}
        {p.listError && !p.listLoading && (
          <div className="px-4 py-4 text-ui text-danger mono">
            {errorMessage(p.listError)}
          </div>
        )}
        {!p.listLoading && !p.listError && p.visibleEntries.length === 0 && (
          <div className="px-4 py-6 text-ui text-ink-muted text-center">
            {p.browse?.entries.length === 0
              ? "此文件夹为空。"
              : p.searchQuery
              ? `此文件夹中没有与“${p.searchQuery}”匹配的项目。`
              : "没有可见条目,开启点文件开关以查看隐藏项目。"}
          </div>
        )}
        {!p.listLoading &&
          p.visibleEntries.map((e) => (
            <EntryRow
              key={e.path}
              entry={e}
              active={p.selectedFilePath === e.path}
              onClick={() =>
                e.isDir ? p.onNavigate(e.path) : p.onOpenFile(e.path, e)
              }
              variant="mobile"
            />
          ))}
      </div>

      {p.selectedFilePath && (
        <MobilePreviewSheet
          absPath={p.selectedFilePath}
          fileData={p.fileData}
          loading={p.fileLoading}
          error={p.fileError}
          kind={p.previewKind ?? "text"}
          size={p.previewSize}
          onClose={p.onClosePreview}
        />
      )}
    </div>
  );
}

function MobilePreviewSheet({
  absPath,
  fileData,
  loading,
  error,
  kind,
  size,
  onClose,
}: {
  absPath: string;
  fileData: BrowseReadResponse | null;
  loading: boolean;
  error: string | null;
  kind: PreviewKind;
  size: number | null;
  onClose: () => void;
}) {
  // HTML / markdown source vs rendered toggle. Reset whenever the selected
  // path changes so opening a different file doesn't inherit the previous
  // file's render state. (`renderHtml` doubles as "render markdown"; kept
  // the name to avoid a sweeping rename across two view components.)
  const [renderHtml, setRenderHtml] = useState(false);
  useEffect(() => {
    setRenderHtml(false);
  }, [absPath]);

  const basename = pathBasename(absPath) || absPath;
  const isText = kind === "text";
  const isHtml = kind === "html";
  const isMarkdown = kind === "markdown";
  const isRenderable = isHtml || isMarkdown;
  const showDownload = kind === "pdf" || kind === "office" || kind === "audio" || kind === "video";
  // Copy-contents only makes sense when we actually have the text in
  // memory. For binary kinds browseRead was skipped, so disable it.
  const copyContentsEnabled = isText || isHtml || isMarkdown;

  return (
    <div className="absolute inset-0 z-30 bg-canvas flex flex-col">
      <header className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-line bg-canvas/95 backdrop-blur">
        <button
          type="button"
          onClick={onClose}
          aria-label="返回文件树"
          className="h-8 w-8 rounded bg-paper border border-line flex items-center justify-center shrink-0"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="mono text-ui truncate" title={absPath}>
            {fileData?.name ?? basename}
          </div>
          {fileData ? (
            <div className="mono text-ui text-ink-muted truncate">
              {fileData.lines} 行 · {formatSize(fileData.sizeBytes)}
              {fileData.truncated ? " · 已截断" : ""}
            </div>
          ) : size !== null ? (
            <div className="mono text-ui text-ink-muted truncate">
              {formatSize(size)}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isRenderable && (
            <button
              type="button"
              onClick={() => setRenderHtml((v) => !v)}
              aria-pressed={renderHtml}
              title={renderHtml ? "显示源代码" : isMarkdown ? "渲染 Markdown" : "渲染 HTML"}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-line bg-canvas text-ui shrink-0"
            >
              {renderHtml ? (
                <Code className="w-3.5 h-3.5 text-ink-muted" />
              ) : (
                <Eye className="w-3.5 h-3.5 text-ink-muted" />
              )}
              <span>{renderHtml ? "源代码" : "渲染"}</span>
            </button>
          )}
          {copyContentsEnabled && (
            <CopyButton
              getText={() => fileData?.content}
              label="复制"
              title="复制文件内容"
              className="h-8 px-2.5"
            />
          )}
          {showDownload && (
            <DownloadButton absPath={absPath} className="h-8 px-2.5" />
          )}
          <CopyButton
            getText={() => absPath}
            label="路径"
            title="复制文件路径"
            className="h-8 px-2.5"
          />
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto bg-canvas flex flex-col">
        {loading && (
          <div className="p-6 text-center mono text-ui text-ink-muted">
            加载中…
          </div>
        )}
        {error && !loading && (
          <div className="p-6 text-center mono text-ui text-danger">
            {error}
          </div>
        )}
        {!loading && !error && isHtml && renderHtml && fileData && (
          <BinaryPreview
            absPath={absPath}
            kind="html"
            fileData={fileData}
            renderHtml
          />
        )}
        {!loading && !error && isMarkdown && renderHtml && fileData && (
          <BinaryPreview
            absPath={absPath}
            kind="markdown"
            fileData={fileData}
            renderHtml
          />
        )}
        {!loading && !error && (isText || (isRenderable && !renderHtml)) && fileData && (
          <div className="mono text-ui leading-[1.7] px-4 py-3">
            {fileData.content.split("\n").map((line, i) => (
              <div key={i} className="grid grid-cols-[40px_1fr] gap-1">
                <span className="text-right pr-2 text-ink-faint select-none">
                  {i + 1}
                </span>
                <span className="whitespace-pre-wrap break-all [overflow-wrap:anywhere]">
                  {line || " "}
                </span>
              </div>
            ))}
            {fileData.truncated && (
              <div className="grid grid-cols-[40px_1fr] gap-1 mt-2">
                <span className="text-right pr-2 text-ink-faint select-none">
                  …
                </span>
                <span className="text-ink-faint">文件在 1 MB 处截断</span>
              </div>
            )}
          </div>
        )}
        {!loading && !error && !isText && !isRenderable && (
          <BinaryPreview
            absPath={absPath}
            kind={kind}
            fileData={null}
            renderHtml={false}
          />
        )}
      </div>
    </div>
  );
}

// ---- desktop view ----------------------------------------------------------

function DesktopFilesView(p: FilesViewProps) {
  return (
    <div className="flex-1 min-h-0 grid grid-cols-[300px_minmax(0,1fr)_240px] overflow-hidden">
      {/* Left: listing */}
      <aside className="border-r border-line bg-paper/40 flex flex-col overflow-hidden">
        <div className="px-3 py-2.5 border-b border-line shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-3.5 h-3.5 text-klein shrink-0" />
            <Breadcrumb
              path={p.currentPath ?? ""}
              onNavigate={p.onNavigate}
              onSubmitPath={p.onSubmitPath}
              className="flex-1 min-w-0"
            />
            {!p.standalone && <FileStationLink />}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
              <Toolbar
                onHome={p.onHome}
                onRoot={p.onRoot}
                onUp={p.onUp}
                canUp={!!p.browse?.parent}
                compact
              />
            </div>
            <HiddenToggle
              showHidden={p.showHidden}
              onToggle={p.onToggleHidden}
              hiddenCount={p.hiddenCount}
              compact
            />
          </div>
          <div className="flex items-center gap-1.5">
            <ProjectJumpSelect
              projects={p.projects}
              onGoToProject={p.onGoToProject}
              compact
            />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0 flex items-center gap-2 h-7 px-2.5 bg-canvas border border-line rounded-sm">
              <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
              <input
                type="text"
                placeholder="筛选…"
                value={p.searchQuery}
                onChange={(e) => p.onSearchChange(e.target.value)}
                className="flex-1 min-w-0 bg-transparent text-ui text-ink outline-none placeholder:text-ink-muted"
              />
              {p.searchQuery && (
                <button
                  type="button"
                  onClick={() => p.onSearchChange("")}
                  className="text-ink-muted shrink-0"
                  aria-label="清除搜索"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {p.listLoading && (
            <div className="px-3 py-2 text-ui text-ink-muted mono">加载中…</div>
          )}
          {p.listError && !p.listLoading && (
            <div className="px-3 py-2 text-ui text-danger mono">
              {errorMessage(p.listError)}
            </div>
          )}
          {!p.listLoading && !p.listError && p.visibleEntries.length === 0 && (
            <div className="px-3 py-4 text-ui text-ink-muted text-center">
              {p.browse?.entries.length === 0
                ? "此文件夹为空。"
                : p.searchQuery
                ? `没有与“${p.searchQuery}”匹配的项目。`
                : "没有可见条目。"}
            </div>
          )}
          {!p.listLoading &&
            p.visibleEntries.map((e) => (
              <EntryRow
                key={e.path}
                entry={e}
                active={p.selectedFilePath === e.path}
                onClick={() =>
                  e.isDir ? p.onNavigate(e.path) : p.onOpenFile(e.path, e)
                }
                variant="desktop"
              />
            ))}
        </div>
      </aside>

      {/* Middle: preview */}
      <section className="min-w-0 flex flex-col overflow-hidden border-r border-line">
        {p.selectedFilePath ? (
          <DesktopPreviewBody
            absPath={p.selectedFilePath}
            fileData={p.fileData}
            loading={p.fileLoading}
            error={p.fileError}
            kind={p.previewKind ?? "text"}
            size={p.previewSize}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-center px-8">
            <p className="text-ui text-ink-muted">
              选择文件以预览其内容。
            </p>
          </div>
        )}
      </section>

      {/* Right: meta */}
      <aside className="border-l border-line bg-paper/40 flex flex-col overflow-y-auto">
        <div className="px-4 py-3 border-b border-line caps text-ink-muted shrink-0">
          文件
        </div>
        {p.fileData ? (
          <div className="px-4 py-3 text-ui space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">大小</span>
              <span className="mono">{formatSize(p.fileData.sizeBytes)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">行数</span>
              <span className="mono">{p.fileData.lines}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">修改时间</span>
              <span className="mono">{timeAgoShort(p.fileData.mtimeMs)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">模式</span>
              <span className="mono">{p.fileData.mode}</span>
            </div>
          </div>
        ) : p.selectedFilePath ? (
          // Binary kinds skip /api/browse/read, so we don't have lines/
          // mode/mtime metadata here. Show what we know: kind + size (if
          // the EntryRow click handed us one).
          <div className="px-4 py-3 text-ui space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">类型</span>
              <span className="mono">{p.previewKind ?? "文件"}</span>
            </div>
            {p.previewSize !== null && (
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">大小</span>
                <span className="mono">{formatSize(p.previewSize)}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="px-4 py-3 text-ui text-ink-faint">
            未选择文件。
          </div>
        )}
        <div className="mt-auto mx-3 my-3">
          <div className="p-3 rounded bg-canvas border border-line text-ui text-ink-muted leading-[1.5]">
            文件浏览为只读,claudex 仅展示磁盘现状,不做写入。请在「对话」
            中让 claude 编辑文件。
          </div>
        </div>
      </aside>
    </div>
  );
}

// Body of the desktop preview pane. Extracted so the HTML source/render
// toggle can own its own state (same shape as MobilePreviewSheet) without
// leaking into the outer DesktopFilesView render.
function DesktopPreviewBody({
  absPath,
  fileData,
  loading,
  error,
  kind,
  size,
}: {
  absPath: string;
  fileData: BrowseReadResponse | null;
  loading: boolean;
  error: string | null;
  kind: PreviewKind;
  size: number | null;
}) {
  const [renderHtml, setRenderHtml] = useState(false);
  useEffect(() => {
    setRenderHtml(false);
  }, [absPath]);

  const isText = kind === "text";
  const isHtml = kind === "html";
  const isMarkdown = kind === "markdown";
  const isRenderable = isHtml || isMarkdown;
  const showDownload = kind === "pdf" || kind === "office" || kind === "audio" || kind === "video";
  const copyContentsEnabled = isText || isHtml || isMarkdown;

  return (
    <>
      <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
        <FileIcon className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="mono text-ui truncate" title={absPath}>
            {absPath}
          </div>
          {fileData ? (
            <div className="mono text-ui text-ink-muted truncate">
              {fileData.lines} 行 · {formatSize(fileData.sizeBytes)}
              {fileData.mtimeMs
                ? ` · 已修改 ${timeAgoShort(fileData.mtimeMs)}`
                : ""}
            </div>
          ) : size !== null ? (
            <div className="mono text-ui text-ink-muted truncate">
              {formatSize(size)}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isRenderable && (
            <button
              type="button"
              onClick={() => setRenderHtml((v) => !v)}
              aria-pressed={renderHtml}
              title={renderHtml ? "显示源代码" : isMarkdown ? "渲染 Markdown" : "渲染 HTML"}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-line bg-canvas text-ui shrink-0"
            >
              {renderHtml ? (
                <Code className="w-3.5 h-3.5 text-ink-muted" />
              ) : (
                <Eye className="w-3.5 h-3.5 text-ink-muted" />
              )}
              <span>{renderHtml ? "源代码" : "渲染"}</span>
            </button>
          )}
          {copyContentsEnabled && (
            <CopyButton
              getText={() => fileData?.content}
              label="复制"
              title="复制文件内容"
              className="h-8 px-3"
            />
          )}
          {showDownload && (
            <DownloadButton absPath={absPath} className="h-8 px-3" />
          )}
          <CopyButton
            getText={() => absPath}
            label="路径"
            title="复制文件路径"
            className="h-8 px-3"
          />
        </div>
      </div>
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-ui text-ink-muted mono">
          加载中…
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-ui text-danger mono px-6 text-center">
          {error}
        </div>
      ) : isHtml && renderHtml && fileData ? (
        <BinaryPreview
          absPath={absPath}
          kind="html"
          fileData={fileData}
          renderHtml
        />
      ) : isMarkdown && renderHtml && fileData ? (
        <BinaryPreview
          absPath={absPath}
          kind="markdown"
          fileData={fileData}
          renderHtml
        />
      ) : (isText || (isRenderable && !renderHtml)) && fileData ? (
        <PreviewPanel fileData={fileData} loading={false} error={null} />
      ) : !isText && !isRenderable ? (
        <BinaryPreview
          absPath={absPath}
          kind={kind}
          fileData={null}
          renderHtml={false}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-center px-8">
          <p className="text-ui text-ink-muted">
            选择文件以预览其内容。
          </p>
        </div>
      )}
    </>
  );
}
