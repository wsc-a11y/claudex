// error-reporter MUST be the first import — installing window.error /
// unhandledrejection / console.error hooks before React mounts is the
// whole point. Any earlier code that throws is caught too.
import "./lib/error-reporter";

import { StrictMode, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink, FileText, RefreshCw } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { FilesScreen } from "@/screens/Files";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import "./styles/globals.css";

/**
 * files-main.tsx — the standalone "文件站" entry (web/files.html; vite port
 * 5174 in dev, /files.html in the built app served by the claudex server).
 *
 * Renders the same FilesScreen as the main app's Files tab but WITHOUT the
 * claudex AppShell chrome, and gates it on main-station login: the browse
 * APIs are cookie-authed, so an unauthenticated visitor gets 401 on every
 * call — we probe /api/auth/whoami up front and show a "log in at the main
 * site first" card instead of a broken file tree. There is deliberately no
 * login form here: one login on the main station covers this page too
 * (cookies are per-host, not per-port — see mainSiteHref below).
 *
 * Back button: FilesScreen({ standalone }) pushes every dir/file navigation
 * into browser history, so the Android/iOS back button unwinds the folder
 * stack (close preview → parent dir → home) instead of exiting the page.
 */

/** URL of the claudex main station, used by the "open main site" link.
 *  Dev: the file station lives on vite port 5174 while the main entry is
 *  port 5173 of the same host — a login there is valid here because
 *  cookies are not scoped to the port. Built app: /files.html is served
 *  same-origin by the claudex server, so the main site is just "/". */
function mainSiteHref(): string {
  if (typeof window !== "undefined" && window.location.port === "5174") {
    return `${window.location.protocol}//${window.location.hostname}:5173/`;
  }
  return "/";
}

type GatePhase = "checking" | "ok" | "needLogin" | "offline";

function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<GatePhase>("checking");
  // Raw error detail behind the offline card — surfaced so the user can
  // report whether the backend refused (500/502 via vite proxy), timed out,
  // or the fetch itself failed (TypeError).
  const [probeError, setProbeError] = useState<string | null>(null);

  const recheck = useCallback(() => {
    setPhase("checking");
    setProbeError(null);
    api
      .whoami()
      .then(() => setPhase("ok"))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          setPhase("needLogin");
          return;
        }
        setPhase("offline");
        setProbeError(
          e instanceof ApiError
            ? `api ${e.status} (${e.code})`
            : e instanceof Error
              ? `${e.name}: ${e.message}`
              : String(e),
        );
      });
  }, []);

  useEffect(() => {
    recheck();
  }, [recheck]);

  // While offline, auto-retry every 3s (bounded) — dev startup races the
  // backend (5179 takes seconds longer than the vite pages) and the claudex
  // server also restarts between batches; the gate should clear itself once
  // the backend is back instead of sitting on a stale error card.
  useEffect(() => {
    if (phase !== "offline") return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > 60) {
        clearInterval(timer);
        return;
      }
      recheck();
    }, 3000);
    return () => clearInterval(timer);
  }, [phase, recheck]);

  if (phase === "checking") {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="mono text-ui text-ink-muted">检查登录状态…</div>
      </div>
    );
  }

  if (phase === "needLogin") {
    const main = mainSiteHref();
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="flex flex-col items-center gap-2">
          <FileText className="w-8 h-8 text-klein" />
          <div className="text-ink font-medium">未登录</div>
        </div>
        <p className="text-ui text-ink-muted leading-relaxed max-w-xs">
          文件站读取的是电脑磁盘上的真实文件,需要先用主站账号登录
          claudex 才能浏览。登录一次后回到本页刷新即可。
        </p>
        <a
          href={main}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded bg-klein text-white text-ui font-medium"
        >
          前往主站登录 <ExternalLink className="w-3.5 h-3.5" />
        </a>
        <button
          type="button"
          onClick={recheck}
          className="inline-flex items-center gap-1.5 text-ui text-ink-soft hover:text-ink"
        >
          <RefreshCw className="w-3.5 h-3.5" /> 我已登录,重新检查
        </button>
      </div>
    );
  }

  if (phase === "ok") {
    return <>{children}</>;
  }

  // offline — the claudex backend isn't reachable at all
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="text-ink font-medium">无法连接后端服务</div>
      <p className="text-ui text-ink-muted leading-relaxed max-w-xs">
        文件站的浏览接口由 claudex 后端提供。请确认它正在运行(pnpm dev
        或已启动的生产服务),然后重试。
      </p>
      {probeError && (
        <p className="mono text-ui-sm text-ink-faint break-all">
          {probeError}
        </p>
      )}
      <button
        type="button"
        onClick={recheck}
        className="inline-flex items-center gap-1.5 h-9 px-4 rounded border border-line bg-paper text-ui text-ink-soft"
      >
        <RefreshCw className="w-3.5 h-3.5" /> 重试
      </button>
    </div>
  );
}

function FileStation() {
  return (
    <div className="h-dvh flex flex-col overflow-hidden bg-canvas">
      {/* Thin top bar — the file station's own chrome, replacing AppShell. */}
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line bg-canvas/95 backdrop-blur">
        <FileText className="w-4 h-4 text-klein shrink-0" />
        <span className="mono text-ui text-ink-soft uppercase tracking-[0.12em]">
          文件站
        </span>
        <span className="text-ui text-ink-muted truncate">
          只读 · 需主站登录
        </span>
        <a
          href={mainSiteHref()}
          target="_blank"
          rel="noreferrer"
          className="ml-auto shrink-0 inline-flex items-center gap-1 text-ui text-ink-soft hover:text-klein"
          title="打开 claudex 主站"
        >
          主站 <ExternalLink className="w-3 h-3" />
        </a>
      </header>
      {/* flex child so FilesScreen's flex-1 views get a sized container */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <FilesScreen standalone />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <AuthGate>
        <FileStation />
      </AuthGate>
    </RootErrorBoundary>
  </StrictMode>,
);
