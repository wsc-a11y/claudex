import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronLeft, Download, ExternalLink, Info, RefreshCw } from "lucide-react";
import { api, ApiError } from "@/api/client";
import type { LatestReleaseResponse, MetaResponse } from "@claudex/shared";
import { AppShell } from "@/components/AppShell";
import { timeAgoLong } from "@/lib/format";
import { updateAndRestart } from "@/lib/admin-actions";

// ---------------------------------------------------------------------------
// About — static "what am I running?" surface. Reached from the Settings
// sidebar (a separate `/about` route rather than a subtab, because About
// isn't really Settings — it's a logical neighbour).
//
// Everything is a plain label/value row. When we know the commit sha we
// render the short form as a GitHub blob link; otherwise a muted "—".
// ---------------------------------------------------------------------------

const GITHUB_REPO = "https://github.com/aaravarr/claudex";

export function AboutScreen() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [release, setRelease] = useState<LatestReleaseResponse | null>(null);

  useEffect(() => {
    api
      .getMeta()
      .then(setMeta)
      .catch((e) => setErr(e instanceof ApiError ? e.code : "加载失败"));
    // Release lookup is best-effort and decoupled from the main meta fetch:
    // an offline machine still gets a usable About screen, just without the
    // update-available row. Errors land as `ok: false` payloads, not throws.
    api
      .getLatestRelease()
      .then(setRelease)
      .catch(() => {
        /* fall through — UI hides the row on null */
      });
  }, []);

  return (
    <AppShell tab="settings">
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-4 sm:px-5 py-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate("/settings")}
          aria-label="返回"
          className="md:hidden h-8 w-8 rounded bg-paper border border-line flex items-center justify-center"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <div className="caps text-ink-muted">设置</div>
          <div className="display text-ui-title leading-tight truncate">关于</div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <section className="p-5 sm:p-8 pb-24 md:pb-10">
          <div className="max-w-[760px]">
            <div className="caps text-ink-muted">设置 · 关于</div>
            <h1 className="display text-ui-display md:text-ui-display-lg leading-tight mt-1">
              当前运行的是什么?
            </h1>
            <p className="text-ui-lg text-ink-muted mt-2 max-w-[60ch]">
              本 claudex 安装的服务端构建信息 —— 在提交 bug 或对比机器时很有用。
            </p>

            <div className="mt-7 space-y-5">
              {release && release.ok && release.updateAvailable ? (
                <UpdateBanner release={release} />
              ) : null}

              {err ? (
                <div className="rounded-xl border border-danger/30 bg-danger-wash p-4 text-ui text-danger">
                  无法加载服务器信息: <span className="mono">{err}</span>
                </div>
              ) : !meta ? (
                <div className="rounded-xl border border-line bg-canvas px-4 py-6 text-ui mono text-ink-muted">
                  加载中…
                </div>
              ) : (
                <MetaCard meta={meta} release={release} />
              )}

              <FooterLinks commit={meta?.commit ?? null} />
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function MetaCard({
  meta,
  release,
}: {
  meta: MetaResponse;
  release: LatestReleaseResponse | null;
}) {
  const commitHref =
    meta.commit !== null ? `${GITHUB_REPO}/commit/${meta.commit}` : null;
  return (
    <div className="rounded-xl border border-line bg-canvas overflow-hidden">
      <Row
        label="版本"
        value={<span className="mono">v{meta.version}</span>}
      />
      <Row label="最新发布" value={<LatestReleaseValue release={release} />} />
      <Row
        label="提交"
        value={
          meta.commitShort && commitHref ? (
            <a
              href={commitHref}
              target="_blank"
              rel="noreferrer noopener"
              className="mono inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink transition-colors"
            >
              {meta.commitShort}
              <ExternalLink className="w-3 h-3" />
            </a>
          ) : (
            <span className="text-ink-muted">—</span>
          )
        }
      />
      <Row
        label="构建于"
        value={
          <span>
            <span>{timeAgoLong(meta.buildTime)}</span>
            <span className="text-ink-muted mono text-ui ml-2">
              {new Date(meta.buildTime).toLocaleString()}
            </span>
          </span>
        }
      />
      <Row
        label="Node"
        value={<span className="mono">v{meta.nodeVersion}</span>}
      />
      <Row
        label="SQLite"
        value={<span className="mono">v{meta.sqliteVersion}</span>}
      />
      <Row
        label="平台"
        value={<span className="mono">{meta.platform}</span>}
      />
      <Row
        label="运行时长"
        value={<span className="mono">{formatUptime(meta.uptimeSec)}</span>}
      />
    </div>
  );
}

// Renders the right side of the "Latest release" row. Three states:
//   - null            → release fetch hasn't resolved yet (initial render)
//   - ok: false       → fetch failed; show muted error code (network, timeout, …)
//   - ok: true        → tag link + relative timestamp; "up to date" tag when
//                       the version matches the running server.
function LatestReleaseValue({
  release,
}: {
  release: LatestReleaseResponse | null;
}) {
  if (release === null) {
    return <span className="text-ink-muted">检查中…</span>;
  }
  if (!release.ok) {
    return (
      <span className="text-ink-muted">
        无法检查 ·{" "}
        <span className="mono text-ui">{release.error}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 flex-wrap">
      <a
        href={release.htmlUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mono inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink transition-colors"
      >
        {release.tag}
        <ExternalLink className="w-3 h-3" />
      </a>
      <span className="text-ink-muted text-ui mono">
        {timeAgoLong(release.publishedAt)}
      </span>
      {release.updateAvailable ? (
        <span className="text-ui uppercase tracking-[0.08em] text-warn bg-warn-wash border border-warn/30 rounded-sm px-1.5 py-0.5">
          有更新
        </span>
      ) : (
        <span className="text-ui uppercase tracking-[0.08em] text-ink-muted">
          已是最新
        </span>
      )}
    </span>
  );
}

// Shown above the meta card when a newer release is available. Two CTAs:
//   - "Update now" — triggers detached git-fetch + checkout + restart on the
//     server, then polls /api/health and reloads the page.
//   - "View release" — opens the GitHub release page in a new tab so the user
//     can read the full notes before deciding.
//
// State machine: idle → updating → waiting → reload (success) / failed.
function UpdateBanner({
  release,
}: {
  release: Extract<LatestReleaseResponse, { ok: true }>;
}) {
  const [status, setStatus] = useState<
    "idle" | "updating" | "waiting" | "failed"
  >("idle");
  const [err, setErr] = useState<string | null>(null);

  async function triggerUpdate() {
    setStatus("updating");
    setErr(null);
    try {
      await updateAndRestart(release.tag, {
        onProgress: () => setStatus("waiting"),
      });
      // updateAndRestart only returns after calling window.location.replace,
      // so we rarely reach here — but if the reload is blocked, flip to idle
      // so the button isn't stuck.
      setStatus("idle");
    } catch (e) {
      setStatus("failed");
      setErr(
        e instanceof Error
          ? e.message
          : "等待服务器重新上线超时。",
      );
    }
  }

  const busy = status === "updating" || status === "waiting";
  const notes = release.body.trim();
  const notesPreview = notes.length > 280 ? `${notes.slice(0, 280)}…` : notes;

  return (
    <div className="rounded-xl border border-warn/40 bg-warn-wash/40 p-4 flex items-start gap-3">
      <div className="h-9 w-9 rounded bg-canvas border border-warn/40 flex items-center justify-center shrink-0 text-warn">
        <Download className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1 text-ui space-y-2">
        <div className="font-medium text-ink">
          有可用更新 · <span className="mono">{release.tag}</span>
          <span className="text-ink-muted text-ui ml-2 mono">
            (当前 v{release.currentVersion})
          </span>
        </div>

        {notesPreview ? (
          <div className="text-ink-soft whitespace-pre-wrap break-words">
            {notesPreview}
          </div>
        ) : null}

        {/* ---- action row ---- */}
        <div className="flex items-center gap-2 flex-wrap">
          {status === "failed" ? (
            <>
              <button
                type="button"
                onClick={triggerUpdate}
                className="h-9 px-3.5 rounded-md border border-danger/40 bg-danger-wash text-ui font-medium text-danger hover:opacity-90 inline-flex items-center gap-1.5 transition-opacity"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                重试
              </button>
              <span className="text-ui text-danger/80 truncate max-w-[240px]">
                {err}
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={triggerUpdate}
                disabled={busy}
                className="h-9 px-3.5 rounded-md bg-warn text-canvas text-ui font-medium hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5 transition-opacity"
              >
                {busy ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : null}
                {status === "idle"
                  ? `更新到 ${release.tag}`
                  : status === "updating"
                    ? "更新中…"
                    : "等待服务器…"}
              </button>
              <a
                href={release.htmlUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink text-ink-soft transition-colors"
              >
                查看发布
                <ExternalLink className="w-3 h-3" />
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Uptime renderer — bigger buckets than `timeAgoShort` (which caps at "w"),
// so a long-running server reads "3d 4h" instead of "3d". Uses floor division
// so a process that's been up for 59 seconds reads "59s", not "0m".
function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh > 0 ? `${d}d ${hh}h` : `${d}d`;
}

function FooterLinks({ commit }: { commit: string | null }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-paper/30 px-5 py-4 flex items-start gap-4">
      <div className="h-9 w-9 rounded bg-canvas border border-line flex items-center justify-center shrink-0">
        <Info className="w-4 h-4 text-ink-muted" />
      </div>
      <div className="min-w-0 text-ui text-ink-soft space-y-1">
        <div>
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink transition-colors"
          >
            GitHub 上的源码
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div>
          <a
            href={
              commit
                ? `${GITHUB_REPO}/blob/${commit}/docs/FEATURES.md`
                : `${GITHUB_REPO}/blob/main/docs/FEATURES.md`
            }
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink transition-colors"
          >
            功能清单 (FEATURES.md)
            <ExternalLink className="w-3 h-3" />
          </a>
          <span className="text-ink-muted text-ui ml-2">
            {commit
              ? "固定到本次构建"
              : "main 分支(未检测到本地提交)"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-4 sm:px-5 py-3 text-ui border-b border-line last:border-b-0">
      <div className="text-ink-muted text-ui uppercase tracking-widest w-28 shrink-0">
        {label}
      </div>
      <div className="min-w-0 flex-1 truncate text-ink">{value}</div>
    </div>
  );
}
