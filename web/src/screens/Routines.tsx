import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Calendar,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type {
  ModelId,
  PermissionMode,
  Project,
  Routine,
} from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { AppShell } from "@/components/AppShell";
import { timeAgoOrInShort } from "@/lib/format";
import { getAllModelEntries } from "@/lib/pricing";
import { useAppSettings, useCustomModels } from "@/state/app-settings";

// Inlined version of RoutinesSheet contents as a full-page screen. The old
// sheet is kept around for the "Run now → navigate into session" flow but
// the tab bar is now the primary entry point, not the Home header button.

const PRESETS: Array<{ id: string; label: string; expr: string }> = [
  { id: "hourly", label: "每小时", expr: "0 * * * *" },
  { id: "daily-9", label: "每天 9:00", expr: "0 9 * * *" },
  { id: "weekdays-9", label: "工作日 9:00", expr: "0 9 * * 1-5" },
  { id: "weekly-mon-9", label: "周一 9:00", expr: "0 9 * * 1" },
  { id: "every-30m", label: "每 30 分钟", expr: "*/30 * * * *" },
];

function humanCron(expr: string): string {
  const trimmed = expr.trim();
  const hit = PRESETS.find((p) => p.expr === trimmed);
  if (hit) return hit.label;
  const m = trimmed.match(/^0 (\d{1,2}) \* \* \*$/);
  if (m) return `每天 ${m[1]}:00`;
  return trimmed;
}

function formatRel(iso: string | null): string {
  return timeAgoOrInShort(iso);
}

export function RoutinesScreen() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [creating, setCreating] = useState(false);
  // `loadErr` is the refresh() failure (blocks the list); `err` is a mutation
  // failure (run/pause/delete) rendered alongside the list. Priority in the
  // render: loadErr > loading > empty > data; the mutation banner lives below
  // the list so the list itself stays visible when a delete fails.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  async function refresh() {
    setLoading(true);
    setLoadErr(null);
    try {
      const [r, p] = await Promise.all([
        api.listRoutines(),
        api.listProjects(),
      ]);
      setRoutines(r.routines);
      setProjects(p.projects);
    } catch (e) {
      // Don't silently fall through to an empty-state card — that would look
      // identical to a genuine "no routines" account and hide a transient
      // network/API break from the user. Surface the failure as a banner with
      // a retry button so the list reflects what we know: we don't know yet.
      setLoadErr(e instanceof ApiError ? e.code : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function runNow(r: Routine) {
    setErr(null);
    try {
      const res = await api.runRoutine(r.id);
      navigate(`/session/${res.sessionId}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "运行失败");
    }
  }

  async function togglePause(r: Routine) {
    setErr(null);
    try {
      await api.updateRoutine(r.id, {
        status: r.status === "active" ? "paused" : "active",
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "更新失败");
    }
  }

  async function remove(r: Routine) {
    if (!confirm(`删除例程 "${r.name}"?`)) return;
    setErr(null);
    try {
      await api.deleteRoutine(r.id);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "删除失败");
    }
  }

  return (
    <AppShell tab="routines">
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted">例程</div>
          <h1 className="display text-ui-title-lg md:text-ui-display-lg leading-tight mt-0.5">
            定时会话
          </h1>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded bg-klein text-canvas text-ui font-medium shadow-card hover:bg-klein/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          新建例程
        </button>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto pb-20 md:pb-6">
        {loadErr ? (
          <div className="max-w-[900px] mx-auto w-full px-4 md:px-6 py-6">
            <div className="rounded border border-danger/30 bg-danger-wash px-4 py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1 text-ui text-danger">
                加载例程失败: <span className="mono">{loadErr}</span>
              </div>
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                className="shrink-0 h-8 px-3 rounded-sm border border-danger/40 bg-canvas text-ui text-danger font-medium disabled:opacity-50hover:bg-danger-wash transition-colors "
              >
                {loading ? "重试中…" : "重试"}
              </button>
            </div>
          </div>
        ) : loading ? (
          <div className="text-ui text-ink-muted text-center py-10 mono">
            加载中…
          </div>
        ) : routines.length === 0 ? (
          <div className="max-w-[900px] mx-auto w-full px-4 md:px-6 py-6">
            <div className="rounded-xl border border-dashed border-line-strong p-8 text-center">
              <Calendar className="w-6 h-6 mx-auto text-ink-muted mb-2" />
              <div className="display text-[1.1rem] mb-1">还没有例程。</div>
              <div className="text-ui text-ink-muted max-w-[40ch] mx-auto">
                例程会按 cron 计划启动一个全新会话,适合夜间审计、早晨摘要或定期健康检查。
              </div>
            </div>
          </div>
        ) : (
          <ul>
            {routines.map((r) => (
              <li
                key={r.id}
                className="px-4 md:px-6 py-3 border-b border-line hover:bg-paper/40 md:hover:shadow-raised transition-ui-fast"
              >
                {/* Mobile stacked */}
                <div className="md:hidden">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${
                        r.status === "active"
                          ? "bg-success"
                          : "bg-line-strong"
                      }`}
                    />
                    <div className="text-ui-lg font-medium truncate flex-1">
                      {r.name}
                    </div>
                    <span className="text-ui text-ink-muted shrink-0">
                      下次 {formatRel(r.nextRunAt)}
                    </span>
                  </div>
                  <div className="text-ui text-ink-muted truncate mt-0.5">
                    {humanCron(r.cronExpr)}
                  </div>
                  <div className="mono text-ui text-ink-muted truncate mt-0.5">
                    {r.cronExpr}
                  </div>
                  <div className="flex gap-1.5 mt-2">
                    <button
                      onClick={() => runNow(r)}
                      className="h-8 px-2.5 rounded-sm border border-line text-ui inline-flex items-center gap-1 hover:bg-canvas transition-colors"
                    >
                      <Play className="w-3 h-3" />
                      立即运行
                    </button>
                    <button
                      onClick={() => togglePause(r)}
                      className="h-8 px-2.5 rounded-sm border border-line text-ui inline-flex items-center gap-1 hover:bg-canvas transition-colors"
                    >
                      {r.status === "active" ? (
                        <>
                          <Pause className="w-3 h-3" />
                          暂停
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3" />
                          恢复
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => setEditing(r)}
                      className="ml-auto h-8 w-8 rounded-sm border border-line flex items-center justify-center text-ink-soft hover:bg-canvas transition-colors"
                      title="编辑"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => remove(r)}
                      className="h-8 w-8 rounded-sm border border-line flex items-center justify-center text-danger hover:bg-danger-wash transition-colors"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Desktop grid row: dot · name/cron · next · actions */}
                <div className="hidden md:grid grid-cols-[22px_minmax(0,1fr)_180px_auto] gap-4 items-center">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      r.status === "active"
                        ? "bg-success"
                        : "bg-line-strong"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-ui-heading font-medium truncate">
                      {r.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-ui text-ink-muted">
                      <span className="mono truncate">{r.cronExpr}</span>
                      <span>·</span>
                      <span className="truncate">{humanCron(r.cronExpr)}</span>
                    </div>
                  </div>
                  <div className="text-ui text-ink-muted truncate">
                    下次 {formatRel(r.nextRunAt)}
                  </div>
                  <div className="flex items-center gap-1.5 justify-end">
                    <button
                      onClick={() => runNow(r)}
                      className="h-8 px-2.5 rounded-sm border border-line text-ui inline-flex items-center gap-1 hover:bg-canvas transition-colors"
                    >
                      <Play className="w-3 h-3" />
                      立即运行
                    </button>
                    <button
                      onClick={() => togglePause(r)}
                      className="h-8 px-2.5 rounded-sm border border-line text-ui inline-flex items-center gap-1 hover:bg-canvas transition-colors"
                    >
                      {r.status === "active" ? (
                        <>
                          <Pause className="w-3 h-3" />
                          暂停
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3" />
                          恢复
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => setEditing(r)}
                      className="h-8 w-8 rounded-sm border border-line flex items-center justify-center text-ink-soft hover:bg-canvas transition-colors"
                      title="编辑"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => remove(r)}
                      className="h-8 w-8 rounded-sm border border-line flex items-center justify-center text-danger hover:bg-danger-wash transition-colors"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {err && (
          <div className="mx-4 md:mx-6 my-3 text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
      </section>

      {(editing || creating) && (
        <RoutineEditor
          initial={editing}
          projects={projects}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={async () => {
            setEditing(null);
            setCreating(false);
            await refresh();
          }}
        />
      )}
    </AppShell>
  );
}

function RoutineEditor({
  initial,
  projects,
  onCancel,
  onSaved,
}: {
  initial: Routine | null;
  projects: Project[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const loadSettings = useAppSettings((s) => s.load);
  const customModels = useCustomModels();
  const modelEntries = getAllModelEntries(customModels);
  useEffect(() => { loadSettings(); }, [loadSettings]);
  const [name, setName] = useState(initial?.name ?? "");
  const [projectId, setProjectId] = useState(
    initial?.projectId ?? projects[0]?.id ?? "",
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [cronPreset, setCronPreset] = useState<string>(() => {
    if (!initial) return "daily-9";
    const found = PRESETS.find((p) => p.expr === initial.cronExpr);
    return found ? found.id : "custom";
  });
  const [cronExpr, setCronExpr] = useState(
    initial?.cronExpr ?? PRESETS[1].expr,
  );
  const [model, setModel] = useState<ModelId>(initial?.model ?? "claude-opus-4-8");
  const [mode, setMode] = useState<PermissionMode>(initial?.mode ?? "default");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (cronPreset === "custom") return;
    const hit = PRESETS.find((p) => p.id === cronPreset);
    if (hit) setCronExpr(hit.expr);
  }, [cronPreset]);

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr("名称不能为空。");
    if (!projectId) return setErr("请先选择项目。");
    if (!prompt.trim()) return setErr("提示词不能为空。");
    if (!cronExpr.trim()) return setErr("Cron 表达式不能为空。");
    setBusy(true);
    try {
      if (initial) {
        await api.updateRoutine(initial.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          cronExpr: cronExpr.trim(),
          model,
          mode,
        });
      } else {
        await api.createRoutine({
          name: name.trim(),
          projectId,
          prompt: prompt.trim(),
          cronExpr: cronExpr.trim(),
          model,
          mode,
        });
      }
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_cron") {
        setErr("该 Cron 表达式无效。请使用类似 `0 9 * * *` 的五段格式。");
      } else {
        setErr(e instanceof ApiError ? e.code : "保存失败");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-overlay flex flex-col max-h-[90vh]">
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted">
              {initial ? "编辑例程" : "新建例程"}
            </div>
            <h2 className="display text-ui-title-lg md:text-ui-display leading-tight mt-0.5">
              {initial ? "调整计划。" : "安排重复会话。"}
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="ml-auto h-8 w-8 rounded border border-line flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              名称
            </div>
            <input
              className="w-full h-10 px-3 bg-canvas border border-line rounded text-ui-lg"
              placeholder="每日依赖审计"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              项目
            </div>
            {initial ? (
              <div className="px-3 py-2.5 border border-line rounded text-ui text-ink-muted">
                {projects.find((p) => p.id === initial.projectId)?.name ??
                  initial.projectId}
                <span className="mono text-ui ml-2">
                  (创建后不可更改)
                </span>
              </div>
            ) : projects.length === 0 ? (
              <div className="px-3 py-2.5 border border-dashed border-line-strong rounded text-ui text-ink-muted">
                还没有项目。请先从新建会话面板添加一个。
              </div>
            ) : (
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full h-10 px-3 bg-canvas border border-line rounded text-ui-lg"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.path}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              提示词
            </div>
            <textarea
              rows={4}
              className="w-full px-3 py-2 bg-canvas border border-line rounded text-ui-lg"
              placeholder="运行 `pnpm audit` 并总结输出。"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              计划
            </div>
            <div className="grid grid-cols-2 gap-1.5 mb-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setCronPreset(p.id)}
                  className={`h-9 rounded-sm text-ui font-medium border text-left px-2 ${
                    cronPreset === p.id
                      ? "border-klein bg-klein-wash/30"
                      : "border-line bg-paper text-ink-muted"
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => setCronPreset("custom")}
                className={`h-9 rounded-sm text-ui font-medium border text-left px-2 ${
                  cronPreset === "custom"
                    ? "border-klein bg-klein-wash/30"
                    : "border-line bg-paper text-ink-muted"
                }`}
              >
                自定义 Cron
              </button>
            </div>
            <input
              disabled={cronPreset !== "custom"}
              className="w-full h-10 px-3 bg-canvas border border-line rounded text-ui mono disabled:opacity-60"
              placeholder="0 9 * * *"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
            />
          </div>
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              模型
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
          </div>
          <div>
            <div className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-2">
              权限模式
            </div>
            <div className="grid grid-cols-4 gap-1 p-1 bg-paper border border-line rounded">
              {(
                [
                  ["default", "询问"],
                  ["acceptEdits", "接受编辑"],
                  ["plan", "计划"],
                  ["bypassPermissions", "绕过权限"],
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
        </div>
        {err && (
          <div className="mx-4 mb-2 text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
        <div className="p-4 border-t border-line flex gap-2">
          <button
            onClick={onCancel}
            className="h-11 px-4 rounded border border-line text-ui"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="flex-1 h-11 rounded bg-ink text-canvas text-ui font-medium hover:bg-ink/90 transition-colors disabled:opacity-50"
          >
            {busy ? "保存中…" : initial ? "保存更改" : "创建例程"}
          </button>
        </div>
      </div>
    </div>
  );
}
