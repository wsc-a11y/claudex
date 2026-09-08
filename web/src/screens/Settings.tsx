import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Bell,
  BellOff,
  Bot,
  Bug,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  FolderOpen,
  Info,
  KeyRound,
  Palette,
  Pencil,
  Plug,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  Sliders,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "@/state/auth";
import { api, ApiError, type WorktreeSummary } from "@/api/client";
import type {
  Project, PushDevice, UserEnvResponse, AuditEvent,
  ToolGrant, ImportAllResponse, SupportedLanguage, CustomModel,
} from "@claudex/shared";
import { SUPPORTED_LANGUAGES } from "@claudex/shared";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/cn";
import { timeAgoShort, timeAgoLong } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
import { forceReload as doForceReload, restartServer } from "@/lib/admin-actions";
import { AppShell } from "@/components/AppShell";
import {
  deviceLabel,
  detectPushSupport,
  getPushState,
  isCurrentDeviceSubscribed,
  revokeDevice,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push";
import { useFocusReturn } from "@/hooks/useFocusReturn";
import { useAppSettings, useCustomModels } from "@/state/app-settings";

// ---------------------------------------------------------------------------
// Settings — mockup s-12 structure.
//
// Layout shape
//   AppShell                     // global nav (logo column on desktop)
//     ├ header                   // caps "Settings" + display {activeTab}
//     ├ profile card             // avatar + username + "self-hosted" + 2FA
//     └ body
//         ├ left rail (md+)      // 240px inner rail, 8 entries
//         ├ chip row (<md)       // horizontal filter chips, 8 entries
//         └ content              // caps + display + lede + panels
//
// Honesty rule: we match the mockup's visual structure (header, inner rail,
// card language), but if we don't have the data to fill a section, we render
// an explicit empty state instead of fabricating a paired-browsers list,
// an audit log, or an exposure panel.
//
// URL state: `?tab=security` preserves the active subtab across refreshes.
// ---------------------------------------------------------------------------

type Tab =
  | "account"
  | "security"
  | "notifications"
  | "appearance"
  | "models"
  | "mcp"
  | "plugins"
  | "environment"
  | "advanced";

interface TabSpec {
  id: Tab;
  label: string;
  icon: typeof UserIcon;
  // caps header — "Settings · {caps}"
  caps: string;
  // display title at the top of the content area
  title: string;
  // lede under the display title (mockup pattern)
  lede: string;
}

const TABS: TabSpec[] = [
  {
    id: "account",
    label: "账户",
    icon: UserIcon,
    caps: "账户",
    title: "本机上的 claudex 登录凭据信息",
    lede: "本机器只保留一个用户账户。可在这里修改密码;其余凭据都通过 CLI 轮换。",
  },
  {
    id: "security",
    label: "安全",
    icon: Shield,
    caps: "安全",
    title: "守住这道门",
    lede: "claudex 向你的机器暴露了一部分接口,请像对待 SSH 一样处理:强密码、双重验证、受限访问、可审计日志。",
  },
  {
    id: "notifications",
    label: "通知",
    icon: Bell,
    caps: "通知",
    title: "及时得知 Claude 何时需要你",
    lede: "每当有权限请求到达时,claudex 都可以向你推送通知。安装到主屏幕后体验最佳。",
  },
  {
    id: "appearance",
    label: "外观",
    icon: Palette,
    caps: "外观",
    title: "今日为浅色主题",
    lede: "深色主题与文字大小后续会在此开放。目前 claudex 自带一套平静的纸感浅色主题。",
  },
  {
    id: "models",
    label: "模型",
    icon: Bot,
    caps: "模型",
    title: "为你的代理添加自定义模型",
    lede: "从自托管 API 代理(OneAPI、New API 等)添加模型 ID,与内置的 Claude 模型并列使用。",
  },
  {
    id: "mcp",
    label: "MCP 服务器",
    icon: Server,
    caps: "MCP 服务器",
    title: "MCP 配置的只读视图",
    lede: "你的 MCP 服务器来自 ~/.claude/settings.json —— claudex 不会编辑该文件。解析 mcpServers 块后,此面板会反映出其中的内容。",
  },
  {
    id: "plugins",
    label: "插件",
    icon: Plug,
    caps: "插件",
    title: "~/.claude/plugins/ 的只读视图",
    lede: "已安装的插件来自 claude CLI。用 `claude plugin install …` 安装后它们会出现在这里。",
  },
  {
    id: "environment",
    label: "环境",
    icon: TerminalIcon,
    caps: "环境",
    title: "~/.claude/settings.json 的只读视图",
    lede: "展示几个安全字段,方便你确认 claudex 看到的是与 CLI 相同的配置。",
  },
  {
    id: "advanced",
    label: "高级",
    icon: Sliders,
    caps: "高级",
    title: "底层开关与高级用户设置",
    lede: "清理过期的 claudex 管理 git 工作树。更多高级开关(JWT 轮换、暴露面诊断)将陆续放在这里。",
  },
];

function isTab(value: string | null | undefined): value is Tab {
  return TABS.some((t) => t.id === value);
}

export function SettingsScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const fromParams = params.get("tab");
  const tab: Tab = isTab(fromParams) ? fromParams : "account";
  const spec = TABS.find((t) => t.id === tab)!;

  const setTab = (next: Tab) => {
    const nextParams = new URLSearchParams(params);
    if (next === "account") nextParams.delete("tab");
    else nextParams.set("tab", next);
    setParams(nextParams, { replace: true });
  };

  return (
    <AppShell tab="settings">
      {/* Mobile-first header — caps "Settings" + display {tab}. Back button on
          mobile jumps to /sessions (AppShell's default tab). Desktop hides the
          back chevron because the sidebar already provides orientation. */}
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-4 sm:px-5 py-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate("/sessions")}
          aria-label="返回"
          className="md:hidden h-8 w-8 rounded bg-paper border border-line flex items-center justify-center"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <div className="caps text-ink-muted">设置</div>
          <div className="display text-ui-title leading-tight truncate">
            {spec.label}
          </div>
        </div>
        <div className="ml-auto text-ui text-ink-muted hidden sm:inline">
          当前登录为 <span className="mono">{user?.username ?? "—"}</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col md:min-h-0 overflow-y-auto md:overflow-hidden">
        {/* Profile card — matches mockup lines 2062–2066, honest variant.
            Rendered on every subtab so the user always sees who they are.
            On desktop it stays pinned above the split rail/content below; on
            mobile the whole column scrolls as one unit so `overflow-y-auto`
            only applies below md. */}
        <div className="shrink-0">
          <ProfileCard />
        </div>

        <div className="md:grid md:grid-cols-[240px_minmax(0,1fr)] md:flex-1 md:min-h-0">
          {/* Desktop inner rail: 8 entries, active = bg-canvas+border+shadow.
              Mockup lines 2097–2111. Independently scrollable on desktop —
              shrink-0 on its column so a long tab list can't push the content
              area off-screen. */}
          <aside className="hidden md:flex md:flex-col border-r border-line bg-paper/40 overflow-y-auto min-h-0 shrink-0">
            <div className="p-4 flex items-center gap-2">
              <Logo className="w-4 h-4" />
              <span className="mono text-ui">Claudex</span>
            </div>
            <div className="px-4 caps text-ink-muted mb-2">设置</div>
            <nav className="px-3 space-y-0.5 text-ui">
              {TABS.map(({ id, label, icon: Icon }) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={cn(
                      "w-full text-left flex items-center gap-2 px-2.5 h-8 rounded-sm",
                      active
                        ? "bg-canvas border border-line shadow-card"
                        : "hover:bg-canvas/60 border border-transparent text-ink-soft transition-colors",
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                );
              })}
              {/* "About" lives at the bottom of the rail but is a separate
                  route (`/about`), not a Tab. It's a neighbour of Settings
                  rather than a subtab — navigating instead of flipping the
                  tab param avoids polluting the Tab union with something
                  that doesn't share the rail's content-area contract. */}
              <button
                type="button"
                onClick={() => navigate("/errors")}
                className={cn(
                  "w-full text-left flex items-center gap-2 px-2.5 h-8 rounded-sm",
                  "hover:bg-canvas/60 border border-transparent text-ink-soft transition-colors",
                )}
              >
                <Bug className="w-3.5 h-3.5" />
                客户端错误
              </button>
              <button
                type="button"
                onClick={() => navigate("/about")}
                className={cn(
                  "w-full text-left flex items-center gap-2 px-2.5 h-8 rounded-sm",
                  "hover:bg-canvas/60 border border-transparent text-ink-soft transition-colors",
                )}
              >
                <Info className="w-3.5 h-3.5" />
                关于
              </button>
            </nav>
          </aside>

          {/* Mobile filter-chip row: same 8 entries, horizontal scroll. */}
          <nav className="md:hidden flex gap-1.5 px-3 py-2.5 overflow-x-auto no-scrollbar border-b border-line">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-ui border",
                    active
                      ? "bg-klein text-canvas border-klein"
                      : "bg-canvas text-ink-soft border-line",
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              );
            })}
            {/* "About" navigates to `/about` rather than flipping the tab. */}
            <button
              type="button"
              onClick={() => navigate("/errors")}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-ui border",
                "bg-canvas text-ink-soft border-line",
              )}
            >
              <Bug className="w-3.5 h-3.5" />
              客户端错误
            </button>
            <button
              type="button"
              onClick={() => navigate("/about")}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-ui border",
                "bg-canvas text-ink-soft border-line",
              )}
            >
              <Info className="w-3.5 h-3.5" />
              关于
            </button>
          </nav>

          <section className="min-w-0 p-5 sm:p-8 pb-24 md:pb-10 md:overflow-y-auto md:min-h-0">
            <div className="max-w-[760px]">
              <div className="caps text-ink-muted">
                设置 · {spec.caps}
              </div>
              <h1 className="display text-ui-display md:text-ui-display-lg leading-tight mt-1">
                {spec.title}
              </h1>
              <p className="text-ui-lg text-ink-muted mt-2 max-w-[60ch]">
                {spec.lede}
              </p>

              <div className="mt-7 space-y-5">
                {tab === "account" && <AccountPanel />}
                {tab === "security" && <SecurityPanel />}
                {tab === "notifications" && <NotificationsPanel />}
                {tab === "appearance" && <AppearancePanel />}
                {tab === "models" && <ModelsPanel />}
                {tab === "mcp" && <McpPanel onPlugins={() => setTab("plugins")} />}
                {tab === "plugins" && <PluginsPanel />}
                {tab === "environment" && <EnvironmentPanel />}
                {tab === "advanced" && <AdvancedPanel />}
              </div>
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

// ----------------------------------------------------------------------------
// Profile card — mockup lines 2062–2066, honest variant:
//   - avatar = first char of username
//   - name line = username (no display name; we don't collect one)
//   - sub line = "self-hosted" (we don't have plan tiers)
//   - 2FA pill always shows "2FA on" — TOTP is mandatory
//   - no email (we don't collect one)
// ----------------------------------------------------------------------------

function ProfileCard() {
  const { user } = useAuth();
  const initial = user?.username?.[0]?.toUpperCase() ?? "?";
  return (
    <div className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-line">
      <div className="h-12 w-12 rounded-full bg-ink text-canvas flex items-center justify-center text-ui-heading font-medium hover:bg-ink/90 transition-colors">
        {initial}
      </div>
      <div className="min-w-0">
        <div className="font-medium truncate">{user?.username ?? "—"}</div>
        <div className="text-ui text-ink-muted">自托管</div>
        {user?.createdAt && (
          <div className="text-ui text-ink-muted mt-0.5">
            自 {new Date(user.createdAt).toLocaleDateString()} 起
          </div>
        )}
      </div>
      <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-success/30 bg-success-wash text-success-ink text-ui-sm font-medium uppercase tracking-widest shrink-0">
        双重验证已开启
      </span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Account — unchanged behavior. Rows + change-password flow.
// ----------------------------------------------------------------------------

function AccountPanel() {
  const { user } = useAuth();
  const [showChange, setShowChange] = useState(false);
  const twoFactorOn = !!user?.twoFactorEnabled;
  return (
    <>
      <Card>
        <Row label="用户名" value={<span className="mono">{user?.username ?? "—"}</span>} />
        <Row
          label="创建时间"
          value={user ? new Date(user.createdAt).toLocaleString() : "—"}
        />
        <Row
          label="双重验证"
          value={
            twoFactorOn ? (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-success/30 bg-success-wash text-success-ink text-ui-sm font-medium uppercase tracking-widest">
                已开启
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-line bg-paper/60 text-ink-muted text-ui-sm font-medium uppercase tracking-widest">
                未开启
              </span>
            )
          }
        />
        <div className="px-4 py-3 border-t border-line bg-paper/40 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowChange(true)}
            className="h-9 px-3 rounded border border-line bg-canvas text-ui inline-flex items-center gap-1.5 hover:bg-paper transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5" />
            修改密码
          </button>
          <span className="text-ui text-ink-muted ml-1">
            需要输入你当前的密码。
          </span>
        </div>
      </Card>
      {showChange && (
        <ChangePasswordModal onClose={() => setShowChange(false)} />
      )}
    </>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  useFocusReturn();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (next.length < 8) {
      setErr("新密码至少需要 8 个字符。");
      return;
    }
    if (next !== confirm) {
      setErr("两次输入的新密码不一致。");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "invalid_credentials") {
          setErr("当前密码不正确。");
        } else if (e.code === "same_password") {
          setErr("新密码必须与当前密码不同。");
        } else if (e.code === "bad_request") {
          setErr("新密码至少需要 8 个字符。");
        } else {
          setErr(e.code);
        }
      } else {
        setErr("修改失败");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-ink/30 flex items-end sm:items-center justify-center">
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-password-modal-title"
        className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-lift p-5"
      >
        <div className="flex items-center mb-4">
          <div>
            <div className="caps text-ink-muted">安全</div>
            <h2 id="change-password-modal-title" className="display text-ui-title-lg md:text-ui-display leading-tight mt-0.5">
              修改密码
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>
        {done ? (
          <div className="space-y-4">
            <div className="text-ui-lg">
              密码已更新。当前标签页保持登录状态;持有旧会话的其他标签页在各自 Cookie 过期前仍可继续工作。
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full h-10 rounded bg-ink text-canvas text-ui-lg font-medium hover:bg-ink/90 transition-colors"
            >
              完成
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <LabeledInput
              label="当前密码"
              type="password"
              value={current}
              onChange={setCurrent}
              autoFocus
            />
            <LabeledInput
              label="新密码"
              type="password"
              value={next}
              onChange={setNext}
            />
            <LabeledInput
              label="确认新密码"
              type="password"
              value={confirm}
              onChange={setConfirm}
            />
            {err && (
              <div className="text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
                {err}
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full h-10 rounded bg-ink text-canvas text-ui-lg font-medium hover:bg-ink/90 transition-colors disabled:opacity-50"
            >
              {busy ? "正在更新…" : "更新密码"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <div className="caps text-ink-muted mb-1">{label}</div>
      <input
        className="w-full h-10 px-3 bg-canvas border border-line rounded text-ui-lg"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
    </label>
  );
}

// ----------------------------------------------------------------------------
// Security — mockup lines 2119–2135 + 2163–2173 (audit log card).
//
// Two-factor card now drives enable / rebind / disable flows via the
// `/api/auth/totp/*` routes; recovery codes only render when 2FA is on
// (they have nothing to recover when it's off).
// ----------------------------------------------------------------------------

function SecurityPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const fullLog = searchParams.get("audit") === "1";
  const { user } = useAuth();
  const twoFactorOn = !!user?.twoFactorEnabled;
  return (
    <div className="space-y-5">
      <TwoFactorCard />

      {twoFactorOn && <RecoveryCodesCard />}

      <GrantedToolsCard />

      <TrustedProjectsCard />

      <AuditLogCard
        expanded={fullLog}
        onExpand={() => {
          const next = new URLSearchParams(searchParams);
          next.set("audit", "1");
          setSearchParams(next, { replace: true });
        }}
        onCollapse={() => {
          const next = new URLSearchParams(searchParams);
          next.delete("audit");
          setSearchParams(next, { replace: true });
        }}
      />
    </div>
  );
}

// Two-factor card. State machine:
//   off   → "Enable" button → TwoFactorEnrollModal (password gate)
//   on    → "Rebind" button → TwoFactorEnrollModal (current TOTP gate)
//          + "Disable" button → TwoFactorDisableModal (password gate)
// `whoami` drives the on/off pill so the card reflects whichever state the
// server is in immediately after a successful confirm/disable.
function TwoFactorCard() {
  const { user, checkSession } = useAuth();
  const enabled = !!user?.twoFactorEnabled;
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  return (
    <div className="rounded-xl border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-4 border-b border-line">
        <div className="h-10 w-10 rounded-lg bg-klein-wash flex items-center justify-center text-klein-ink shrink-0">
          <Shield className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="display text-ui-title leading-tight">
            双重验证
          </div>
          <div className="text-ui text-ink-muted mt-0.5">
            {enabled
              ? "每次登录都需要。每 30 秒轮换一次。"
              : "未启用。登录时仅需密码。"}
          </div>
        </div>
        {enabled ? (
          <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-success/30 bg-success-wash text-success-ink text-ui-sm font-medium uppercase tracking-widest shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            已开启
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-line bg-paper/60 text-ink-muted text-ui-sm font-medium uppercase tracking-widest shrink-0">
            未开启
          </span>
        )}
      </div>

      <div className="px-5 py-4 text-ui text-ink-soft">
        {enabled ? (
          <div>
            你的账户在登录时需要一个来自身份验证器的 6 位验证码。你之后可将账户换绑到新设备,或彻底关闭双重验证。
          </div>
        ) : (
          <div>
            当前登录是单因素验证。开启双重验证后,每次登录都需要输入一个来自身份验证器应用(Google Authenticator、1Password、Authy 等)的轮换验证码。
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-line bg-paper/40 flex items-center gap-2 flex-wrap">
        {enabled ? (
          <>
            <button
              onClick={() => setEnrollOpen(true)}
              className="h-9 px-3 rounded border border-line bg-canvas text-ui inline-flex items-center gap-1.5 hover:bg-paper transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              重新绑定验证器
            </button>
            <button
              onClick={() => setDisableOpen(true)}
              className="h-9 px-3 rounded border border-danger/40 bg-canvas text-danger text-ui inline-flex items-center gap-1.5hover:bg-danger-wash transition-colors "
            >
              关闭双重验证
            </button>
          </>
        ) : (
          <button
            onClick={() => setEnrollOpen(true)}
            className="h-9 px-3 rounded bg-ink text-canvas text-ui font-medium inline-flex items-center gap-1.5 hover:bg-ink/90 transition-colors"
          >
            <Shield className="w-3.5 h-3.5" />
            开启双重验证
          </button>
        )}
        <span className="text-ui text-ink-muted ml-1">
          {enabled
            ? "换绑时需要提供当前设备上的验证码。"
            : "开启时需要提供你当前的密码。"}
        </span>
      </div>

      {enrollOpen && (
        <TwoFactorEnrollModal
          alreadyEnabled={enabled}
          onClose={() => setEnrollOpen(false)}
          onSuccess={async () => {
            setEnrollOpen(false);
            await checkSession();
          }}
        />
      )}
      {disableOpen && (
        <TwoFactorDisableModal
          onClose={() => setDisableOpen(false)}
          onSuccess={async () => {
            setDisableOpen(false);
            await checkSession();
          }}
        />
      )}
    </div>
  );
}

// Two-step enrollment: server mints a candidate `secret + qrSvg` on open, the
// user pairs the new authenticator, then confirms with a current 6-digit code
// against that secret PLUS one of:
//   - `currentTotp`  if 2FA is already on (proves they still control the
//                    authenticator they're replacing — stops a thief who has
//                    only the cookie from rebinding to their own device)
//   - `password`     if 2FA is currently off (no old authenticator to consult)
//
// The candidate secret is held in component state and never persisted until
// confirm — closing the modal early throws it away.
function TwoFactorEnrollModal({
  alreadyEnabled,
  onClose,
  onSuccess,
}: {
  alreadyEnabled: boolean;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
}) {
  useFocusReturn();
  const [pairing, setPairing] = useState<{
    secret: string;
    uri: string;
    qrSvg: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.beginTotp();
        if (cancelled) return;
        setPairing({ secret: res.secret, uri: res.uri, qrSvg: res.qrSvg });
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof ApiError ? e.code : "load_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function copySecret() {
    if (!pairing) return;
    const ok = await copyText(pairing.secret);
    if (ok) {
      setSecretCopied(true);
      window.setTimeout(() => setSecretCopied(false), 1500);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pairing) return;
    if (!/^\d{6}$/.test(code)) {
      setErr("请输入来自身份验证器的 6 位验证码。");
      return;
    }
    if (!proof.trim()) {
      setErr(
        alreadyEnabled
          ? "请输入你现有验证器中的当前验证码。"
          : "请输入你当前的密码。",
      );
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.confirmTotp({
        secret: pairing.secret,
        code,
        ...(alreadyEnabled
          ? { currentTotp: proof.trim() }
          : { password: proof }),
      });
      await onSuccess();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "invalid_totp") {
          setErr("配对验证码不正确 —— 请尝试最新的一枚。");
        } else if (e.code === "invalid_current_totp") {
          setErr("当前验证器的验证码不正确。");
        } else if (e.code === "invalid_credentials") {
          setErr("当前密码不正确。");
        } else if (e.code === "current_totp_required") {
          setErr("必须提供你现有验证器中的一枚验证码。");
        } else if (e.code === "password_required") {
          setErr("必须提供你当前的密码。");
        } else {
          setErr(e.code);
        }
      } else {
        setErr("确认失败");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-ink/30 flex items-end sm:items-center justify-center">
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="twofactor-enroll-title"
        className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-lift p-5 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center mb-4">
          <div>
            <div className="caps text-ink-muted">安全</div>
            <h2
              id="twofactor-enroll-title"
              className="display text-ui-title-lg md:text-ui-display leading-tight mt-0.5"
            >
              {alreadyEnabled ? "重新绑定验证器" : "开启双重验证"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded border border-line flex items-center justify-center"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {pairing === null ? (
          <div className="text-ui text-ink-muted">正在生成二维码…</div>
        ) : (
          <div className="space-y-4">
            <div className="text-ui text-ink-soft">
              用你的身份验证器应用扫描这个二维码,然后在下方输入当前的 6 位验证码以确认配对。
            </div>
            <div className="flex items-center justify-center bg-paper/40 border border-line rounded-xl p-3">
              <div
                className="w-[220px] h-[220px] [&_svg]:w-full [&_svg]:h-full bg-canvas"
                // Inline SVG from /api/auth/totp/begin — server-rendered, no
                // external resources, safe under strict-CSP webviews.
                dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
              />
            </div>
            <div className="text-ui text-ink-muted">
              或手动输入这个密钥:
            </div>
            <button
              type="button"
              onClick={copySecret}
              className="w-full mono text-ui rounded border border-line bg-paper/40 px-3 py-2 inline-flex items-center gap-2"
            >
              <span className="break-all text-left flex-1">{pairing.secret}</span>
              <Copy className="w-3.5 h-3.5 shrink-0 text-ink-muted" />
              {secretCopied && (
                <span className="text-ui text-success">已复制</span>
              )}
            </button>

            <LabeledInput
              label="配对验证码(来自新验证器)"
              value={code}
              onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
              autoFocus
            />
            <LabeledInput
              label={
                alreadyEnabled
                  ? "你现有验证器的验证码"
                  : "当前密码"
              }
              type={alreadyEnabled ? "text" : "password"}
              value={proof}
              onChange={(v) =>
                setProof(alreadyEnabled ? v.replace(/\D/g, "").slice(0, 6) : v)
              }
            />
            {err && (
              <div className="text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
                {err}
              </div>
            )}
            {!alreadyEnabled && (
              <div className="text-ui text-ink-muted">
                开启后,请在"恢复码"卡片中生成一批新的恢复码,这样即使丢失验证器也有后备方案。
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full h-10 rounded bg-ink text-canvas text-ui-lg font-medium hover:bg-ink/90 transition-colors disabled:opacity-50"
            >
              {busy
                ? "正在确认…"
                : alreadyEnabled
                  ? "确认新设备"
                  : "开启双重验证"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function TwoFactorDisableModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
}) {
  useFocusReturn();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) {
      setErr("请输入你当前的密码。");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.disableTotp({ password });
      await onSuccess();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "invalid_credentials") {
          setErr("当前密码不正确。");
        } else {
          setErr(e.code);
        }
      } else {
        setErr("关闭失败");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-ink/30 flex items-end sm:items-center justify-center">
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="twofactor-disable-title"
        className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-lift p-5"
      >
        <div className="flex items-center mb-4">
          <div>
            <div className="caps text-ink-muted">安全</div>
            <h2
              id="twofactor-disable-title"
              className="display text-ui-title-lg md:text-ui-display leading-tight mt-0.5"
            >
              关闭双重验证
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded border border-line flex items-center justify-center"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="text-ui text-ink-muted mb-3">
          此后登录将只要求输入密码。所有现有的恢复码都会失效。你可以稍后在本页重新开启双重验证。
        </div>
        <div className="space-y-3">
          <LabeledInput
            label="当前密码"
            type="password"
            value={password}
            onChange={setPassword}
            autoFocus
          />
          {err && (
            <div className="text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
              {err}
            </div>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full h-10 rounded border border-danger/40 bg-canvas text-danger text-ui-lg font-medium disabled:opacity-50hover:bg-danger-wash transition-colors "
          >
            {busy ? "正在关闭…" : "关闭双重验证"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Recovery-codes card — sits between the 2FA card and the Trusted projects
// card on the Security tab. Mirrors the TrustedProjectsCard's two-click
// commit pattern for the dangerous action (Regenerate invalidates every
// previous code) and renders plaintext exactly once, in a modal, after a
// successful regenerate. `remaining === 0` surfaces a warning pill so the
// user nags themselves into rotating before they're locked out.
function RecoveryCodesCard() {
  const [state, setState] = useState<
    { remaining: number; generatedAt?: string } | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  // Two-click arming for the Regenerate button — analogous to the Untrust
  // flow elsewhere on this tab. Cleared on a 3s timeout so a stray first
  // click doesn't linger as a hot button.
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  async function refresh() {
    setErr(null);
    try {
      const res = await api.getRecoveryCodesState();
      setState({
        remaining: res.remaining,
        ...(res.generatedAt ? { generatedAt: res.generatedAt } : {}),
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "加载失败");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);

  async function regenerate() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    setErr(null);
    try {
      const res = await api.regenerateRecoveryCodes();
      setFreshCodes(res.codes);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "重新生成失败");
    } finally {
      setBusy(false);
    }
  }

  const remaining = state?.remaining ?? 0;
  const generatedAt = state?.generatedAt;
  const exhausted = state !== null && remaining === 0;

  return (
    <div className="rounded-xl border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <div className="h-9 w-9 rounded bg-paper border border-line flex items-center justify-center shrink-0">
          <KeyRound className="w-4 h-4 text-ink-muted" />
        </div>
        <div className="min-w-0">
          <div className="display text-ui-title leading-tight">
            恢复码
          </div>
          <div className="text-ui text-ink-muted mt-0.5">
            当你丢失身份验证器时使用的单次备用码。每张码只能使用一次。
          </div>
        </div>
        {exhausted ? (
          <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-warn/40 bg-warn-wash text-warn-ink text-ui-sm font-medium uppercase tracking-widest shrink-0">
            无可用恢复码
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-line bg-paper text-ink-soft text-ui-sm font-medium uppercase tracking-widest shrink-0">
            {state === null ? "…" : `剩 ${remaining} / 10`}
          </span>
        )}
      </div>

      <div className="px-5 py-4 text-ui text-ink-soft">
        {state === null ? (
          <span className="mono text-ink-muted">加载中…</span>
        ) : (
          <>
            <div>
              <span className="font-medium">剩 {remaining} / 10 未使用。</span>{" "}
              {generatedAt
                ? `生成于 ${timeAgoShort(generatedAt)}。`
                : "尚未生成任何恢复码。"}
            </div>
            {exhausted && (
              <div className="mt-2 text-ui text-warn-ink">
                你没有剩余恢复码了。请在丢失验证器前重新生成 —— 否则将需要借助 CLI 重置。
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-5 py-3 border-t border-line bg-paper/40 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={regenerate}
          disabled={busy}
          className={cn(
            "h-9 px-3 rounded text-ui inline-flex items-center gap-1.5 disabled:opacity-50",
            armed
              ? "border border-danger/40 bg-danger-wash text-danger font-medium"
              : "border border-line bg-canvas text-ink-soft hover:bg-paper transition-colors",
          )}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {busy
            ? "正在生成…"
            : armed
              ? "再次点击以全部替换"
              : "重新生成恢复码"}
        </button>
        <span className="text-ui text-ink-muted ml-1">
          会替换现有的整批恢复码;旧的纸质备份将失效。
        </span>
      </div>

      {err && (
        <div className="m-4 text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
          {err}
        </div>
      )}

      {freshCodes && (
        <RecoveryCodesModal
          codes={freshCodes}
          onClose={() => setFreshCodes(null)}
        />
      )}
    </div>
  );
}

// One-time display of the 10 plaintext codes after a successful regenerate.
// Server stores only hashes so there's no "show me again" path — the modal
// is the single, final chance to capture them. Copy-all + Download-as-.txt
// affordances make that capture trivial on mobile.
function RecoveryCodesModal({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  useFocusReturn();
  const [copied, setCopied] = useState(false);

  async function copyAll() {
    const ok = await copyText(codes.join("\n"));
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
    /* on failure: user can still tap-hold to select */
  }

  function download() {
    const header = [
      "# claudex recovery codes",
      `# generated ${new Date().toISOString()}`,
      "# each code works ONCE; keep offline",
      "",
    ].join("\n");
    const blob = new Blob([header + codes.join("\n") + "\n"], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "claudex-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-30 bg-ink/30 flex items-end sm:items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="recovery-codes-modal-title" className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-2xl shadow-lift p-5">
        <div className="flex items-center mb-4">
          <div>
            <div className="caps text-ink-muted">安全</div>
            <h2 id="recovery-codes-modal-title" className="display text-ui-title-lg md:text-ui-display leading-tight mt-0.5">
              新恢复码
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded border border-line flex items-center justify-center"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="text-ui text-ink-muted mb-3">
          请立即保存这些恢复码 —— 之后将不再显示。若丢失验证器的访问权限,每张码可让你登录一次。
        </div>
        <ul className="mono text-ui rounded border border-line bg-paper/40 divide-y divide-line">
          {codes.map((c) => (
            <li key={c} className="px-3 py-2">
              {c}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={copyAll}
            className="h-9 px-3 rounded border border-line bg-canvas text-ui inline-flex items-center gap-1.5 hover:bg-paper transition-colors"
          >
            <Copy className="w-3.5 h-3.5" />
            {copied ? "已复制" : "全部复制"}
          </button>
          <button
            type="button"
            onClick={download}
            className="h-9 px-3 rounded border border-line bg-canvas text-ui inline-flex items-center gap-1.5 hover:bg-paper transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            下载为 .txt
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-9 px-3 rounded bg-ink text-canvas text-ui font-medium hover:bg-ink/90 transition-colors"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

// Granted-tools card. Lists every `tool_grants` row on this machine — global
// first (biggest blast radius → most important to audit), then session rows.
// Each row shows a scope pill, the tool name + signature (monospace, because
// the signature is often an exact command like `pnpm vitest run *` or a
// path), the owning session title if any, a short relative time, and a
// Revoke button. "Revoke all" is two-click armed for 3s and iterates the
// current list, refetching after each batch — keeps the UI in sync without
// baking a bulk endpoint into the server.
function GrantedToolsCard() {
  const [grants, setGrants] = useState<ToolGrant[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [armedAll, setArmedAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);

  async function refresh() {
    setErr(null);
    try {
      const res = await api.listAllGrants();
      setGrants(res.grants);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "加载失败");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!armedAll) return;
    const t = window.setTimeout(() => setArmedAll(false), 3000);
    return () => window.clearTimeout(t);
  }, [armedAll]);

  async function revokeOne(id: string) {
    setBusyId(id);
    setErr(null);
    try {
      await api.revokeGrant(id);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "撤销失败");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeAll() {
    if (!grants || grants.length === 0) return;
    if (!armedAll) {
      setArmedAll(true);
      return;
    }
    setArmedAll(false);
    setBusyAll(true);
    setErr(null);
    try {
      // Snapshot the list so a concurrent mutation (e.g. a permission prompt
      // auto-grant arriving mid-revoke) doesn't make us revoke rows we never
      // saw. Ignore individual failures — a grant that vanished between the
      // list and the delete is effectively already revoked.
      const ids = grants.map((g) => g.id);
      await Promise.all(
        ids.map((id) =>
          api.revokeGrant(id).catch(() => {
            /* best-effort */
          }),
        ),
      );
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "撤销失败");
    } finally {
      setBusyAll(false);
    }
  }

  const globalCount = grants?.filter((g) => g.scope === "global").length ?? 0;
  const sessionCount = grants?.filter((g) => g.scope === "session").length ?? 0;

  return (
    <div className="rounded-xl border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <div className="h-9 w-9 rounded bg-paper border border-line flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4 text-ink-muted" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="display text-ui-title leading-tight">
            已授权的工具
          </div>
          <div className="text-ui text-ink-muted mt-0.5">
            {grants === null
              ? "你在权限提示中通过\"始终允许\"自动批准的工具。"
              : `${globalCount} 个全局 · ${sessionCount} 个会话`}
          </div>
        </div>
      </div>
      {err ? (
        // Error wins over loading: previously `grants === null` kept the
        // "加载中…" row up even after the fetch had failed, so the user
        // waited forever for data that was never coming. Render the banner
        // first and offer a retry; only fall back to the loading row when we
        // have neither data nor an error yet.
        <div className="px-5 py-4 flex items-center gap-3">
          <div className="min-w-0 flex-1 rounded border border-danger/30 bg-danger-wash px-3 py-2 text-ui text-danger">
            无法加载已授权工具: <span className="mono">{err}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 h-8 px-3 rounded border border-danger/40 bg-canvas text-ui text-danger font-mediumhover:bg-danger-wash transition-colors "
          >
            重试
          </button>
        </div>
      ) : grants === null ? (
        <div className="px-5 py-5 text-ui mono text-ink-muted">加载中…</div>
      ) : grants.length === 0 ? (
        <div className="px-5 py-5 text-ui text-ink-muted">
          尚未授权任何工具。在权限提示中点击"始终允许"即可把工具添加到这里。
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {grants.map((g) => {
            const busy = busyId === g.id;
            return (
              <li
                key={g.id}
                className="flex items-center gap-3 px-5 py-3 text-ui"
              >
                <span
                  className={cn(
                    "shrink-0 inline-flex items-center h-5 px-1.5 rounded-xs text-ui-sm mono uppercase tracking-widest border",
                    g.scope === "global"
                      ? "bg-klein-wash text-klein-ink border-klein/30"
                      : "bg-paper text-ink-muted border-line",
                  )}
                  title={
                    g.scope === "global"
                      ? "适用于所有会话"
                      : "仅限于单个会话"
                  }
                >
                  {g.scope}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mono text-ui truncate">
                    <span className="text-ink-soft">{g.toolName}</span>
                    {g.signature ? (
                      <>
                        <span className="text-ink-muted"> </span>
                        <span className="text-ink-muted">{g.signature}</span>
                      </>
                    ) : null}
                  </div>
                  <div className="text-ui text-ink-muted truncate mt-0.5">
                    {g.scope === "global"
                      ? "所有会话"
                      : g.sessionTitle || "—"}
                  </div>
                </div>
                <span className="shrink-0 text-ui mono text-ink-muted tabular-nums">
                  {timeAgoShort(g.createdAt)}
                </span>
                <button
                  type="button"
                  onClick={() => revokeOne(g.id)}
                  disabled={busy || busyAll}
                  className="shrink-0 h-8 px-3 rounded text-ui border border-line bg-canvas text-ink-soft hover:bg-paper hover:text-danger disabled:opacity-50 transition-colors"
                >
                  {busy ? "…" : "撤销"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {grants && grants.length > 0 && (
        <div className="px-5 py-3 border-t border-line bg-paper/40 flex items-center justify-end">
          <button
            type="button"
            onClick={revokeAll}
            disabled={busyAll}
            className={cn(
              "h-8 px-3 rounded text-ui border disabled:opacity-50",
              armedAll
                ? "border-danger/40 bg-danger-wash text-danger font-medium"
                : "border-line bg-canvas text-ink-soft hover:bg-paper hover:text-danger transition-colors",
            )}
          >
            {busyAll
              ? "正在撤销…"
              : armedAll
                ? "再次点击确认全部撤销"
                : "全部撤销"}
          </button>
        </div>
      )}
      {grants !== null && err && (
        <div className="m-4 text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
          {err}
        </div>
      )}
    </div>
  );
}

// Trusted-projects card. Lists every project row with its trust state and a
// one-click toggle. Untrusting is the dangerous direction (future sessions
// under that project will refuse to spawn), so we require a second click to
// confirm — the row flips into a "click again" affordance for ~3 seconds
// and reverts if the user looks away. Trusting is a single click because the
// user has presumably already been prompted once via the NewSessionSheet.
function TrustedProjectsCard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // When non-null, the "Untrust" button on that row has been clicked once
  // and is armed — a second click commits. Cleared on timeout or on toggle.
  const [confirmUntrustId, setConfirmUntrustId] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await api.listProjects();
      setProjects(res.projects);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "加载失败");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Auto-disarm the untrust confirm after 3s so a stray click doesn't linger
  // as a hot commit button in the UI.
  useEffect(() => {
    if (!confirmUntrustId) return;
    const t = window.setTimeout(() => setConfirmUntrustId(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirmUntrustId]);

  async function toggle(p: Project) {
    setErr(null);
    if (p.trusted) {
      // Two-click commit for untrust.
      if (confirmUntrustId !== p.id) {
        setConfirmUntrustId(p.id);
        return;
      }
      setConfirmUntrustId(null);
    }
    setBusyId(p.id);
    try {
      const res = await api.trustProject(p.id, !p.trusted);
      setProjects((prev) =>
        prev ? prev.map((x) => (x.id === p.id ? res.project : x)) : prev,
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "更新失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <div className="h-9 w-9 rounded bg-paper border border-line flex items-center justify-center shrink-0">
          <FolderOpen className="w-4 h-4 text-ink-muted" />
        </div>
        <div className="min-w-0">
          <div className="display text-ui-title leading-tight">
            可信项目
          </div>
          <div className="text-ui text-ink-muted mt-0.5">
            取消信任某项目后,在该项目下新建的会话会被阻止,直到你重新确认信任。已存在的会话仍可继续运行。
          </div>
        </div>
      </div>
      {projects === null && err ? (
        // Error wins over loading: a failed refresh leaves `projects` as null
        // and would otherwise keep the spinner spinning forever. Render the
        // banner with a retry button and let the user try again.
        <div className="px-5 py-4 flex items-center gap-3">
          <div className="min-w-0 flex-1 rounded border border-danger/30 bg-danger-wash px-3 py-2 text-ui text-danger">
            无法加载项目: <span className="mono">{err}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 h-8 px-3 rounded border border-danger/40 bg-canvas text-ui text-danger font-mediumhover:bg-danger-wash transition-colors "
          >
            重试
          </button>
        </div>
      ) : projects === null ? (
        <div className="px-5 py-5 text-ui mono text-ink-muted">加载中…</div>
      ) : projects.length === 0 ? (
        <div className="px-5 py-5 text-ui text-ink-muted">
          暂无项目。可从"新建会话"中创建。
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {projects.map((p) => {
            const armed = confirmUntrustId === p.id;
            const busy = busyId === p.id;
            return (
              <li
                key={p.id}
                className="flex items-center gap-3 px-5 py-3 text-ui"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="mono text-ui text-ink-muted truncate">
                    {p.path}
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border text-ui-sm font-medium uppercase tracking-widest",
                    p.trusted
                      ? "border-success/30 bg-success-wash text-success-ink"
                      : "border-warn/30 bg-warn-wash text-warn-ink",
                  )}
                >
                  {p.trusted ? "可信" : "不可信"}
                </span>
                <button
                  type="button"
                  onClick={() => toggle(p)}
                  disabled={busy}
                  className={cn(
                    "shrink-0 h-8 px-3 rounded text-ui border disabled:opacity-50",
                    p.trusted
                      ? armed
                        ? "border-danger/40 bg-danger-wash text-danger font-medium"
                        : "border-line bg-canvas text-ink-soft hover:bg-paper transition-colors"
                      : "border-ink bg-ink text-canvas font-medium hover:bg-ink/90 transition-colors",
                  )}
                >
                  {busy
                    ? "…"
                    : p.trusted
                      ? armed
                        ? "再次点击确认取消信任"
                        : "取消信任"
                      : "信任"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {projects !== null && err && (
        <div className="m-4 text-ui text-danger bg-danger-wash rounded px-3 py-2 border border-danger/30">
          {err}
        </div>
      )}
    </div>
  );
}

// Compose a short human-readable sentence per audit event. Open-ended on
// purpose: unknown events fall back to `<event>` so new server-side kinds
// don't require a UI deploy to show up.
function renderAuditDetail(row: AuditEvent): string {
  // `deviceLabel` takes a PushDevice; we only have a UA string — wrap the UA
  // in a stub device so the classifier works without a second branch.
  const uaLabel = (ua: string | null | undefined) =>
    ua
      ? deviceLabel({
          id: "",
          userAgent: ua,
          createdAt: "",
          lastUsedAt: null,
        })
      : "未知设备";
  switch (row.event) {
    case "login":
      return `来自 ${uaLabel(row.userAgent)} 的登录已通过双重验证`;
    case "login_failed":
      return `登录失败尝试,来源 ${row.ip ?? "未知 IP"}`;
    case "logout":
      return "已退出登录";
    case "password_changed":
      return "密码已修改";
    case "totp_failed":
      return `双重验证码错误,来源 ${row.ip ?? "未知 IP"}`;
    case "session_deleted":
      return `已删除会话 "${row.detail ?? "未命名"}"`;
    case "permission_granted":
      return `已授权: ${row.detail ?? "工具允许"}`;
    case "permission_denied":
      return `已拒绝: ${row.detail ?? "工具拒绝"}`;
    case "push_subscribed":
      return `新增推送设备: ${uaLabel(row.detail)}`;
    case "push_revoked":
      return `移除推送设备: ${uaLabel(row.detail)}`;
    case "project_trusted":
      return row.detail ?? "项目已信任";
    case "project_untrusted":
      return row.detail ?? "项目已取消信任";
    default:
      return row.detail ? `${row.event}: ${row.detail}` : row.event;
  }
}

function AuditLogCard({
  expanded,
  onExpand,
  onCollapse,
}: {
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  const PAGE_SIZE = 50;
  // Initial "inline" view shows up to 6 rows; the full-log sheet shows every
  // row the card has loaded so far. Stashing the since cutoff in state keeps
  // pagination calls aligned with the initial query's filter.
  const sinceRef = useRef<string>("");

  useEffect(() => {
    // Last 30 days — matches the card's header phrasing so totalCount is
    // honest about what we're showing.
    sinceRef.current = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    setRows(null);
    setReachedEnd(false);
    setErr(null);
    void (async () => {
      try {
        const res = await api.listAudit({
          limit: PAGE_SIZE,
          since: sinceRef.current,
        });
        setRows(res.events);
        setTotalCount(res.totalCount);
        if (res.events.length < PAGE_SIZE) setReachedEnd(true);
      } catch (e) {
        setErr(e instanceof ApiError ? e.code : "加载失败");
      }
    })();
  }, [expanded]);

  async function loadMore() {
    if (!rows || rows.length === 0 || loadingMore || reachedEnd) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1]!.createdAt;
      const res = await api.listAudit({
        limit: PAGE_SIZE,
        since: sinceRef.current,
        before: cursor,
      });
      setRows((prev) => (prev ? [...prev, ...res.events] : res.events));
      setTotalCount(res.totalCount);
      if (res.events.length < PAGE_SIZE) setReachedEnd(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "加载失败");
    } finally {
      setLoadingMore(false);
    }
  }

  if (err && rows === null) {
    return (
      <div className="rounded-xl border border-line bg-canvas p-5 text-ui text-ink-muted">
        无法加载审计日志: <span className="mono">{err}</span>
      </div>
    );
  }
  if (rows === null) {
    return (
      <div className="rounded-xl border border-line bg-canvas p-5 text-ui text-ink-muted">
        正在加载审计日志…
      </div>
    );
  }

  const visible = expanded ? rows : rows.slice(0, 6);
  // "Show more" is eligible only in the expanded sheet (the inline view
  // already caps at 6) and disabled once we've either matched totalCount or
  // seen a short page. The error banner sits above it so a failure during
  // pagination doesn't swallow already-loaded rows.
  const hasMore = expanded && !reachedEnd && rows.length < totalCount;

  return (
    <div className="rounded-xl border border-line bg-canvas p-5">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-paper flex items-center justify-center text-ink-muted shrink-0">
          <ScrollText className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="caps text-ink-muted">审计日志</div>
          <div className="display text-ui-title mt-0.5">
            {totalCount} 条事件 · 最近 30 天
          </div>
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="mt-3 text-ui text-ink-muted">
          尚无与安全相关的事件。登录、密码修改和权限决定会记录在这里。
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-ui">
          {visible.map((row) => (
            <div key={row.id} className="flex items-start gap-2">
              <span className="mono text-ink-muted w-12 mt-0.5 shrink-0">
                {timeAgoShort(row.createdAt)}
              </span>
              <span className="min-w-0 break-words">
                {renderAuditDetail(row)}
              </span>
            </div>
          ))}
        </div>
      )}
      {expanded && err && (
        <div className="mt-3 text-ui text-danger bg-danger-wash rounded-sm px-2 py-1 border border-danger/30">
          {err}
        </div>
      )}
      {expanded ? (
        <div className="mt-3 flex flex-col gap-2">
          {hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="h-8 px-3 rounded border border-line bg-paper text-ui w-full disabled:opacity-50"
            >
              {loadingMore ? "正在加载…" : "显示更多"}
            </button>
          )}
          <button
            onClick={onCollapse}
            className="h-8 px-3 rounded border border-line bg-paper text-ui w-full"
          >
            收起
          </button>
        </div>
      ) : (
        rows.length > 6 && (
          <button
            onClick={onExpand}
            className="mt-3 h-8 px-3 rounded border border-line bg-paper text-ui w-full"
          >
            展开完整日志
          </button>
        )
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Notifications — real enable/disable flow + device list.
//
// Three states the panel can be in, driven by local browser capability and
// server-side subscription count:
//   1. capability lost       — browser doesn't support SW/Push, OR page is
//                              on insecure origin (frpc-over-HTTP). Render a
//                              constraint card; no enable button.
//   2. not enabled here yet  — browser supports push, but this device hasn't
//                              subscribed. Render the "Enable on this device"
//                              primary button; list any other subscribed
//                              devices separately.
//   3. enabled               — this browser has a live PushSubscription.
//                              Render the "disable" button + Send test +
//                              device list with per-device revoke.
//
// The server's `GET /api/push/state` gives us the device list; we pair it
// with `navigator.serviceWorker.getRegistration().pushManager.getSubscription()`
// to know whether *this* browser is one of those devices.
// ----------------------------------------------------------------------------

function NotificationsPanel() {
  const [support] = useState(() => detectPushSupport());
  const [permission, setPermission] = useState<NotificationPermission | "unknown">(
    () =>
      typeof window !== "undefined" && "Notification" in window
        ? Notification.permission
        : "unknown",
  );
  const [currentSubscribed, setCurrentSubscribed] = useState<boolean | null>(
    null,
  );
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      if (support === "ready") {
        setCurrentSubscribed(await isCurrentDeviceSubscribed());
      } else {
        setCurrentSubscribed(false);
      }
      const state = await getPushState();
      setDevices(state.devices);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "加载失败");
    }
  }

  useEffect(() => {
    void refresh();
    // We intentionally don't poll — push state only changes on user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function enable() {
    setErr(null);
    setTestMsg(null);
    setBusy(true);
    try {
      await subscribeToPush();
      setPermission(Notification.permission);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "permission_denied") {
        setErr(
          "通知权限已被拒绝。你可以在浏览器针对该来源的网站设置中重新开启,然后再试一次。",
        );
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setErr(null);
    setTestMsg(null);
    setBusy(true);
    try {
      await unsubscribeFromPush();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRevoke(id: string) {
    setErr(null);
    setTestMsg(null);
    setBusy(true);
    try {
      await revokeDevice(id);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doTest() {
    setErr(null);
    setTestMsg(null);
    setBusy(true);
    try {
      const res = await sendTestPush();
      if (res.sent === 0) {
        setTestMsg(
          "没有可用于通知的设备。请先在至少一台设备上开启通知。",
        );
      } else {
        setTestMsg(
          `已发送到 ${res.sent} 台设备${
            res.pruned > 0 ? ` · 清理了 ${res.pruned} 台过时设备` : ""
          }。`,
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canEnable = support === "ready" && currentSubscribed === false;

  return (
    <div className="space-y-5">
      {support !== "ready" && (
        <Card>
          <div className="px-4 py-4 text-ui text-ink-soft">
            {support === "insecure" ? (
              <>
                此浏览器认为当前来源(insecure origin)不安全。推送通知需要 HTTPS —— 请通过 Cloudflare Tunnel、Tailscale 或 Caddy 等 TLS 隧道运行 claudex。纯 HTTP 的 frpc 无法投递推送,在 iOS Safari 上尤其如此。
              </>
            ) : (
              <>
                此浏览器不支持 Web Push 或 Service Worker。在 iOS 上,请先把 claudex 安装到主屏幕(分享 → "添加到主屏幕"),再从那里重新打开 —— 该方式可在 iOS 16.4+ 上开启推送通知。
              </>
            )}
          </div>
        </Card>
      )}

      {support === "ready" && (
        <Card>
          <div className="px-4 sm:px-5 py-4 flex items-center gap-4">
            <div
              className={cn(
                "h-9 w-9 rounded border flex items-center justify-center shrink-0",
                currentSubscribed
                  ? "bg-klein-wash border-klein/20"
                  : "bg-paper border-line",
              )}
            >
              {currentSubscribed ? (
                <Bell className="w-4 h-4 text-klein" />
              ) : (
                <BellOff className="w-4 h-4 text-ink-muted" />
              )}
            </div>
            <div className="min-w-0">
              <div className="display text-ui-heading leading-tight">
                {currentSubscribed
                  ? "此设备已开启通知"
                  : "此设备未开启通知"}
              </div>
              <div className="text-ui text-ink-muted mt-0.5">
                {permission === "denied"
                  ? "浏览器权限已被拒绝。可在该来源的网站设置中重新开启。"
                  : currentSubscribed
                    ? "当有权限请求到达时,Claude 会在此处提醒你。"
                    : "开启后,当 Claude 请求权限时会收到推送提醒。"}
              </div>
            </div>
            <div className="ml-auto shrink-0">
              {currentSubscribed ? (
                <button
                  type="button"
                  onClick={disable}
                  disabled={busy}
                  className="h-9 px-3 rounded border border-line bg-canvas text-ui disabled:opacity-50 hover:bg-paper transition-colors"
                >
                  关闭
                </button>
              ) : (
                <button
                  type="button"
                  onClick={enable}
                  disabled={busy || !canEnable || permission === "denied"}
                  className="h-9 px-3 rounded bg-klein text-canvas text-ui font-medium hover:bg-klein/90 transition-colors disabled:opacity-50"
                >
                  {busy ? "正在开启…" : "在本设备开启通知"}
                </button>
              )}
            </div>
          </div>
          <div className="px-4 sm:px-5 py-3 border-t border-line bg-paper/40 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={doTest}
              disabled={busy || (devices?.length ?? 0) === 0}
              className="h-8 px-3 rounded border border-line bg-canvas text-ui disabled:opacity-50 hover:bg-paper transition-colors"
            >
              发送测试
            </button>
            {testMsg && (
              <span className="text-ui text-ink-muted">{testMsg}</span>
            )}
            {err && (
              <span className="text-ui text-danger bg-danger-wash rounded-sm px-2 py-1 border border-danger/30">
                {err}
              </span>
            )}
          </div>
        </Card>
      )}

      <Card header={`已注册设备 · ${devices?.length ?? 0}`}>
        {devices === null ? (
          <div className="px-4 py-6 text-ui mono text-ink-muted">加载中…</div>
        ) : devices.length === 0 ? (
          <div className="px-4 py-4 text-ui text-ink-muted">
            尚未注册设备。在每台想要接收通知的手机 / 浏览器上打开本页面,然后点击{" "}
            <span className="mono">在本设备开启通知</span>。
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 px-4 py-3 text-ui"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{deviceLabel(d)}</div>
                  <div className="mono text-ui text-ink-muted truncate">
                    添加于 {timeAgoLong(d.createdAt)}
                    {d.lastUsedAt
                      ? ` · 最近提醒于 ${timeAgoLong(d.lastUsedAt)}`
                      : " · 从未提醒过"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => doRevoke(d.id)}
                  disabled={busy}
                  className="h-8 px-2 rounded-sm border border-line bg-canvas text-ui text-ink-soft inline-flex items-center gap-1.5 disabled:opacity-50 hover:bg-paper transition-colors"
                  aria-label="撤销设备"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="text-ui text-ink-muted leading-relaxed">
        你打开 claudex 所用的 URL 需要 HTTPS。纯 HTTP 的 frpc 隧道无法投递推送 —— 浏览器会阻止在不安全来源上注册 Service Worker。在 iOS(16.4+)上,需通过 Safari 的分享面板把 claudex 安装到主屏幕后再从那里打开;桌面版 Safari / Chrome / Firefox 在任意 HTTPS 来源上都能正常工作。
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Appearance — light theme note + disabled affordances (no-op toggles).
// ----------------------------------------------------------------------------

function AppearancePanel() {
  // Global language override for Claude Code's responses. `null` = Auto
  // (defer to the user's own `~/.claude/settings.json` via the SDK's
  // default settingSources). Applies to sessions started *after* the
  // change — live sessions keep their current systemPrompt.
  const [language, setLanguage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { settings } = await api.getAppSettings();
        if (cancelled) return;
        setLanguage(settings.language);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = async (next: string | null) => {
    // Optimistic — snap the picker, roll back on error. The endpoint is
    // cheap and local so the optimism is usually invisible.
    const prev = language;
    setLanguage(next);
    setSaving(true);
    setError(null);
    try {
      const { settings } = await api.updateAppSettings({ language: next });
      setLanguage(settings.language);
    } catch (e) {
      setLanguage(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Row
        label="主题"
        value={
          <div className="inline-flex items-center gap-1 p-1 bg-paper border border-line rounded">
            <span className="px-3 h-7 flex items-center rounded-sm bg-canvas shadow-card border border-line text-ui">
              浅色
            </span>
            <span
              title="尚未实现"
              className="px-3 h-7 flex items-center rounded-sm text-ui text-ink-muted opacity-60"
            >
              深色(即将推出)
            </span>
          </div>
        }
      />
      <Row
        label="语言"
        value={
          <div className="flex flex-col items-start gap-1.5 min-w-0 w-full">
            <LanguageSelect
              value={language}
              disabled={!loaded || saving}
              onPick={(next) => void commit(next)}
            />
            <div className="text-ui text-ink-muted">
              会以"请使用……回应"(Please respond in…)的形式追加到新建会话的系统提示语。已存在的会话保持当前语言,直到下次恢复。
            </div>
            {error && (
              <div className="text-ui text-accent-danger">{error}</div>
            )}
          </div>
        }
      />
      <div className="px-4 py-3 border-t border-line bg-paper/40">
        <div className="caps text-ink-muted mb-2">字号</div>
        <input
          type="range"
          min={0}
          max={2}
          step={1}
          defaultValue={1}
          disabled
          className="w-full accent-ink opacity-60 cursor-not-allowed"
        />
        <div className="text-ui text-ink-muted mt-1">
          动态字号即将推出。目前仍可在移动端用双指缩放。
        </div>
      </div>
    </Card>
  );
}

// Display labels for the language picker. Values match SUPPORTED_LANGUAGES
// (server-side stores these verbatim and uses them in the appended system-
// prompt sentence, so the on-wire form stays English-lowercase).
const LANGUAGE_LABELS: Record<string, string> = {
  chinese: "Chinese (中文)",
  english: "English",
  japanese: "Japanese (日本語)",
  korean: "Korean (한국어)",
  spanish: "Spanish (Español)",
  french: "French (Français)",
  german: "German (Deutsch)",
};

// Custom listbox for the language row. Native <select> was ugly on mobile
// (full-screen iOS picker) and inconsistent with the rest of the app's
// menu styling — same shell as the menus in Chat.tsx / Home.tsx.
function LanguageSelect({
  value,
  disabled,
  onPick,
}: {
  value: string | null;
  disabled: boolean;
  onPick: (next: SupportedLanguage | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const recalc = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 6, width: r.width });
    };
    recalc();
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", recalc);
    window.addEventListener("scroll", recalc, true);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", recalc);
      window.removeEventListener("scroll", recalc, true);
    };
  }, [open]);
  const label = value
    ? (LANGUAGE_LABELS[value] ?? value)
    : "自动(沿用 ~/.claude/settings.json)";
  const pick = (next: SupportedLanguage | null) => {
    setOpen(false);
    onPick(next);
  };
  return (
    <div ref={wrapRef} className="relative w-full max-w-[260px]">
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "h-9 w-full px-2.5 rounded-sm border border-line bg-canvas text-ui text-ink flex items-center justify-between gap-2",
          disabled
            ? "opacity-60 cursor-not-allowed"
            : "hover:bg-paper transition-colors",
        )}
      >
        <span className="truncate text-left">{label}</span>
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 text-ink-muted shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              style={{ left: pos.left, top: pos.top, width: pos.width }}
              className="fixed z-[60] rounded-lg border border-line bg-canvas shadow-lift p-1 max-h-[280px] overflow-auto"
            >
              <LangOption
                label="自动(沿用 ~/.claude/settings.json)"
                active={value === null}
                onClick={() => pick(null)}
              />
              <div className="my-1 h-px bg-line/60" aria-hidden />
              {SUPPORTED_LANGUAGES.map((lang) => (
                <LangOption
                  key={lang}
                  label={LANGUAGE_LABELS[lang] ?? lang}
                  active={value === lang}
                  onClick={() => pick(lang)}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function LangOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-ui",
        active
          ? "bg-klein-wash/40 text-ink"
          : "text-ink-soft hover:bg-paper/60 transition-colors",
      )}
    >
      <Check
        className={cn(
          "w-3.5 h-3.5 shrink-0",
          active ? "text-klein" : "text-transparent",
        )}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ----------------------------------------------------------------------------
// MCP servers — empty state with a nudge toward the Plugins tab (adjacent
// concept, and plugins are the one piece of the Claude env we can surface).
// ----------------------------------------------------------------------------

function McpPanel({ onPlugins }: { onPlugins: () => void }) {
  return (
    <EmptyCard
      icon={Server}
      title="尚未解析。"
      body={
        <>
          一旦解析了 <span className="mono">~/.claude/settings.json#mcpServers</span>{" "}
          中的内容,本面板就会按各自传输方式与命令列出每个已配置的服务器。在此之前的这段时间,你已安装的插件可以在{" "}
          <button
            type="button"
            onClick={onPlugins}
            className="underline underline-offset-2 hover:text-ink transition-colors"
          >
            插件
          </button>
          页面查看。
        </>
      }
    />
  );
}

// ----------------------------------------------------------------------------
// Plugins — existing plugin list from /api/user/env.
// ----------------------------------------------------------------------------

function PluginsPanel() {
  const [env, setEnv] = useState<UserEnvResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUserEnv()
      .then(setEnv)
      .catch((e) => setErr(e instanceof ApiError ? e.code : "load failed"));
  }, []);

  if (err) {
    return (
      <Card>
        <div className="px-4 py-4 text-ui text-danger">{err}</div>
      </Card>
    );
  }

  if (!env) {
    return (
      <Card>
        <div className="px-4 py-6 text-ui mono text-ink-muted">加载中…</div>
      </Card>
    );
  }

  const count = env.plugins.length;
  const enabledCount = env.plugins.filter((p) => p.enabled).length;

  if (count === 0) {
    return (
      <EmptyCard
        icon={Plug}
        title="尚未安装插件。"
        body={
          <>
            claudex 自身不负责安装插件 —— 请在本机运行{" "}
            <span className="mono">claude plugin install …</span>,它们会出现在这里。
          </>
        }
      />
    );
  }

  return (
    <Card
      header={`已启用 ${enabledCount} · 已安装 ${count}`}
    >
      <ul className="divide-y divide-line">
        {env.plugins.map((p) => (
          <li
            key={p.key}
            className="flex items-center gap-3 px-4 py-3 text-ui"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{p.name}</div>
              <div className="mono text-ui text-ink-muted truncate">
                {p.marketplace ?? "—"}
                {p.version ? ` · ${p.version}` : ""}
              </div>
            </div>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border text-ui-sm font-medium uppercase tracking-widest",
                p.enabled
                  ? "border-success/30 bg-success-wash text-success-ink"
                  : "border-line bg-paper text-ink-muted",
              )}
            >
              {p.enabled ? "已启用" : "已停用"}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Environment — read-only dump of a few safe fields from /api/user/env.
// ----------------------------------------------------------------------------

function EnvironmentPanel() {
  const [env, setEnv] = useState<UserEnvResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUserEnv()
      .then(setEnv)
      .catch((e) => setErr(e instanceof ApiError ? e.code : "load failed"));
  }, []);

  if (err) {
    return (
      <Card>
        <div className="px-4 py-4 text-ui text-danger">{err}</div>
      </Card>
    );
  }
  if (!env) {
    return (
      <Card>
        <div className="px-4 py-6 text-ui mono text-ink-muted">加载中…</div>
      </Card>
    );
  }

  return (
    <Card>
      <Row
        label="会话用户"
        value={<span className="mono">{env.user.username}</span>}
      />
      <Row
        label="配置目录"
        value={<span className="mono truncate">{env.claudeDir}</span>}
      />
      <Row
        label="settings.json"
        value={
          env.settingsReadable ? (
            <span className="text-success text-ui">可读</span>
          ) : (
            <span className="text-ink-muted text-ui">缺失</span>
          )
        }
      />
      <div className="px-4 py-3 border-t border-line bg-paper/40 text-ui text-ink-muted">
        claudex 从不写入 <span className="mono">~/.claude/</span>。它自身的所有状态都保存在 <span className="mono">~/.claudex/</span> 下。
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Advanced — Worktrees pruning.
//
// Today when a session is deleted or worktree creation half-fails, stale
// `claude/*` branches + `.claude/worktrees/*` dirs accumulate in user projects.
// This panel surfaces them so the user can clean up. Linked rows (a session
// row still owns them) render with a green dot and no action; orphan rows
// render with a red dot and a Remove button. A bulk "Prune N orphans" action
// sits at the bottom when any orphans exist.
// ----------------------------------------------------------------------------

// Built-in Claude model info (read-only display in the Models panel).
const BUILTIN_MODEL_INFO = [
  { id: "claude-opus-4-8", label: "Opus 4.8", context: "1M tokens" },
  { id: "claude-opus-4-7", label: "Opus 4.7", context: "1M tokens" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", context: "1M tokens" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", context: "200k tokens" },
];

// Context-window input helper. We display the value in a user-friendly unit
// (tokens / k / M) but persist the raw token count. `pickDisplayUnit` picks
// the cleanest unit for a given token count so round values (128000 → 128k,
// 1000000 → 1M) avoid awkward decimal representations.
type CtxUnit = "tokens" | "k" | "M";
const CTX_UNIT_MULTIPLIER: Record<CtxUnit, number> = {
  tokens: 1,
  k: 1_000,
  M: 1_000_000,
};
function pickDisplayUnit(tokens: number): { value: string; unit: CtxUnit } {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return { value: String(tokens / 1_000_000), unit: "M" };
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return { value: String(tokens / 1_000), unit: "k" };
  }
  return { value: String(tokens), unit: "tokens" };
}

// Common presets — tap to fill.
const CTX_PRESETS: Array<{ label: string; tokens: number }> = [
  { label: "128k", tokens: 128_000 },
  { label: "200k", tokens: 200_000 },
  { label: "256k", tokens: 256_000 },
  { label: "1M", tokens: 1_000_000 },
];

const CTX_UNIT_LABEL: Record<CtxUnit, string> = {
  tokens: "tokens",
  k: "k tokens",
  M: "M tokens",
};

// Custom dropdown for the context-window unit selector. Native <select>
// renders differently per platform (iOS especially) — we want the same
// calm-paper look as the rest of the form. Matches the PillPicker pattern
// from Chat.tsx (outside-click + Escape to close).
function CtxUnitDropdown({
  value,
  onChange,
}: {
  value: CtxUnit;
  onChange: (next: CtxUnit) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
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
  const UNITS: CtxUnit[] = ["tokens", "k", "M"];
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-9 px-3 rounded-sm border border-line bg-canvas text-ui flex items-center gap-1.5 hover:bg-paper whitespace-nowrap transition-colors"
      >
        <span>{CTX_UNIT_LABEL[value]}</span>
        <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-30 w-[140px] rounded-lg border border-line bg-canvas shadow-lift p-1"
        >
          {UNITS.map((u) => {
            const active = u === value;
            return (
              <button
                key={u}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(u);
                  setOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-ui",
                  active
                    ? "bg-klein-wash/40 text-ink"
                    : "text-ink-soft hover:bg-paper/60 transition-colors",
                )}
              >
                <span
                  className={cn(
                    "h-3.5 w-3.5 rounded-full border-2 shrink-0 flex items-center justify-center",
                    active
                      ? "border-klein bg-klein text-canvas"
                      : "border-line-strong bg-canvas",
                  )}
                >
                  {active && <Check className="w-2 h-2" />}
                </span>
                <span>{CTX_UNIT_LABEL[u]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModelsPanel() {
  const loadSettings = useAppSettings((s) => s.load);
  const patch = useAppSettings((s) => s.patch);
  const customModels = useCustomModels();
  useEffect(() => { loadSettings(); }, [loadSettings]);

  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    id: string;
    label: string;
    contextWindow: string;
    ctxUnit: CtxUnit;
    baseUrl: string;
    apiKey: string;
  }>({ id: "", label: "", contextWindow: "", ctxUnit: "k", baseUrl: "", apiKey: "" });
  const [err, setErr] = useState<string | null>(null);

  function startAdd() {
    setDraft({ id: "", label: "", contextWindow: "", ctxUnit: "k", baseUrl: "", apiKey: "" });
    setErr(null);
    setAdding(true);
    setEditId(null);
  }

  function startEdit(m: CustomModel) {
    const d = m.contextWindow
      ? pickDisplayUnit(m.contextWindow)
      : { value: "", unit: "k" as CtxUnit };
    setDraft({
      id: m.id,
      label: m.label,
      contextWindow: d.value,
      ctxUnit: d.unit,
      baseUrl: m.baseUrl ?? "",
      apiKey: m.apiKey ?? "",
    });
    setErr(null);
    setEditId(m.id);
    setAdding(false);
  }

  function cancelForm() {
    setAdding(false);
    setEditId(null);
    setErr(null);
  }

  function applyPreset(tokens: number) {
    const d = pickDisplayUnit(tokens);
    setDraft({ ...draft, contextWindow: d.value, ctxUnit: d.unit });
  }

  function save() {
    const id = draft.id.trim();
    const label = draft.label.trim();
    if (!id) return setErr("请填写模型 ID。");
    if (!label) return setErr("请填写名称。");
    // Check for duplicate id (excluding the entry being edited)
    const others = customModels.filter((m) => m.id !== editId);
    if (others.some((m) => m.id === id)) {
      return setErr("已存在使用该 ID 的模型。");
    }
    const ctxRaw = draft.contextWindow.trim();
    let ctxTokens: number | undefined;
    if (ctxRaw) {
      const num = parseFloat(ctxRaw);
      if (!Number.isFinite(num) || num <= 0) {
        return setErr("上下文窗口必须是一个正数。");
      }
      ctxTokens = Math.round(num * CTX_UNIT_MULTIPLIER[draft.ctxUnit]);
    }
    const entry: CustomModel = {
      id,
      label,
      ...(ctxTokens ? { contextWindow: ctxTokens } : {}),
      ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    };
    const next = editId
      ? others.concat(entry)
      : [...customModels, entry];
    patch({ customModels: next });
    setAdding(false);
    setEditId(null);
  }

  function remove(id: string) {
    patch({ customModels: customModels.filter((m) => m.id !== id) });
  }

  const showForm = adding || editId !== null;

  return (
    <div className="space-y-5">
      {/* Built-in models */}
      <div className="rounded-xl border border-line bg-paper/30 overflow-hidden">
        <div className="px-5 py-3 border-b border-line">
          <div className="display text-ui-heading leading-tight">内置模型</div>
          <div className="text-ui text-ink-muted mt-1">随 claudex 一同提供,随时可用。</div>
        </div>
        <div className="divide-y divide-line">
          {BUILTIN_MODEL_INFO.map((m) => (
            <div key={m.id} className="flex items-center justify-between px-5 py-3">
              <div>
                <div className="text-ui-lg font-medium">{m.label}</div>
                <div className="text-ui text-ink-muted font-mono">{m.id} · {m.context}</div>
              </div>
              <span className="text-ui font-medium uppercase tracking-widest text-ink-muted px-2 py-0.5 rounded-xs bg-paper border border-line">内置</span>
            </div>
          ))}
        </div>
      </div>

      {/* Custom models */}
      <div className="rounded-xl border border-line bg-paper/30 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <div>
            <div className="display text-ui-heading leading-tight">自定义模型</div>
            <div className="text-ui text-ink-muted mt-1">来自你自托管 API 代理的模型。</div>
          </div>
          <button
            onClick={startAdd}
            className="h-8 px-3 rounded-sm bg-ink text-canvas text-ui font-medium flex items-center gap-1.5 shrink-0 hover:bg-ink/90 transition-colors"
          >
            + 添加
          </button>
        </div>

        {customModels.length === 0 && !showForm && (
          <div className="px-5 py-6 text-ui text-ink-muted text-center">
            暂无自定义模型。添加一个即可使用来自代理的模型。
          </div>
        )}

        {customModels.length > 0 && (
          <div className="divide-y divide-line">
            {customModels.map((m) => (
              <div key={m.id} className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <div className="text-ui-lg font-medium">{m.label}</div>
                  <div className="text-ui text-ink-muted font-mono truncate">
                    {m.id}{m.contextWindow ? ` · ${(m.contextWindow / 1000).toLocaleString()}k tokens` : ""}{m.baseUrl ? ` · ${m.baseUrl}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <button
                    onClick={() => startEdit(m)}
                    className="h-7 w-7 flex items-center justify-center rounded-xs text-ink-muted hover:bg-paper transition-colors"
                    title="编辑"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => remove(m.id)}
                    className="h-7 w-7 flex items-center justify-center rounded-xs text-danger hover:bg-danger/10 transition-colors"
                    title="移除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {showForm && (
          <div className="px-5 py-4 border-t border-line space-y-3">
            <div>
              <label className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-1 block">模型 ID</label>
              <input
                value={draft.id}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder="例如 gpt-4o、deepseek-chat"
                className="w-full h-9 px-3 bg-canvas border border-line rounded-sm text-ui font-mono"
                disabled={editId !== null}
              />
              <div className="text-ui text-ink-muted mt-1">你的代理所接受的确切模型字符串。</div>
            </div>
            <div>
              <label className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-1 block">名称</label>
              <input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="例如 GPT-4o、DeepSeek Chat"
                className="w-full h-9 px-3 bg-canvas border border-line rounded-sm text-ui"
              />
            </div>
            <div>
              <label className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-1 block">上下文窗口(可选)</label>
              {/* Quick presets — tap to fill with the most common values. */}
              <div className="flex gap-1.5 mb-2 flex-wrap">
                {CTX_PRESETS.map((p) => {
                  const currentTokens =
                    draft.contextWindow.trim() && Number.isFinite(parseFloat(draft.contextWindow))
                      ? Math.round(parseFloat(draft.contextWindow) * CTX_UNIT_MULTIPLIER[draft.ctxUnit])
                      : 0;
                  const active = currentTokens === p.tokens;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => applyPreset(p.tokens)}
                      className={`h-7 px-2.5 rounded-sm text-ui font-medium border ${
                        active
                          ? "border-ink bg-canvas text-ink"
                          : "border-line bg-paper text-ink-muted hover:text-ink transition-colors"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
              {/* Value + unit selector. Value is displayed in the chosen unit
                  and multiplied at save-time. */}
              <div className="flex gap-1.5">
                <input
                  value={draft.contextWindow}
                  onChange={(e) => setDraft({ ...draft, contextWindow: e.target.value })}
                  placeholder="例如 128"
                  type="number"
                  step="any"
                  min="0"
                  className="flex-1 min-w-0 h-9 px-3 bg-canvas border border-line rounded-sm text-ui"
                />
                <CtxUnitDropdown
                  value={draft.ctxUnit}
                  onChange={(u) => setDraft({ ...draft, ctxUnit: u })}
                />
              </div>
              <div className="text-ui text-ink-muted mt-1">用于"上下文占用百分比"环形指示。留空则使用默认的 1M。</div>
            </div>
            <div>
              <label className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-1 block">API 基础 URL(可选)</label>
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="例如 https://api.anthropic.com"
                className="w-full h-9 px-3 bg-canvas border border-line rounded-sm text-ui font-mono"
              />
              <div className="text-ui text-ink-muted mt-1">为此模型覆盖 ANTHROPIC_BASE_URL 环境变量。留空则使用默认值。</div>
            </div>
            <div>
              <label className="text-ui uppercase tracking-[0.14em] text-ink-muted mb-1 block">API 密钥(可选)</label>
              <input
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="sk-ant-..."
                className="w-full h-9 px-3 bg-canvas border border-line rounded-sm text-ui font-mono"
              />
              <div className="text-ui text-ink-muted mt-1">为此模型覆盖 ANTHROPIC_API_KEY 环境变量。留空则使用默认值。</div>
            </div>
            {err && <div className="text-ui text-danger">{err}</div>}
            <div className="flex gap-2">
              <button
                onClick={save}
                className="h-9 px-4 rounded-sm bg-ink text-canvas text-ui font-medium hover:bg-ink/90 transition-colors"
              >
                {editId ? "更新" : "添加"}
              </button>
              <button
                onClick={cancelForm}
                className="h-9 px-4 rounded-sm border border-line text-ui text-ink-muted"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AdvancedPanel() {
  return (
    <div className="space-y-5">
      <AppVersionCard />
      <RestartServerCard />
      <AdvancedWorktreesCard />
      <BackupCard />
    </div>
  );
}

// Bundle version readout + hard-refresh button. The hard-refresh path is
// necessary because claudex runs over plain HTTP through the frpc tunnel,
// and iOS Safari will happily serve a months-old index.html from its HTTP
// cache even after the server ships a new bundle. Server-side we set
// `Cache-Control: no-cache` on index.html (both the fastify-static mount
// and the SPA fallback in server/src/transport/app.ts), so fresh loads
// revalidate — but caches already populated under the old (no-header)
// regime are sticky. This button exists to break that deadlock from the
// UI without making the user dig through Safari → Settings → Website Data.
function AppVersionCard() {
  const [bundleName, setBundleName] = useState<string>("unknown");
  const [isReloading, setIsReloading] = useState(false);

  useEffect(() => {
    // Read the hashed JS filename directly off the live <script> tag so
    // the user can eyeball which bundle is actually running. Not the
    // build-time version — this reflects what the browser loaded, which
    // is the whole point.
    const script = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src*="/assets/"]',
    );
    if (script?.src) {
      const match = script.src.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
      if (match) setBundleName(match[1]);
    }
  }, []);

  async function forceReload() {
    setIsReloading(true);
    await doForceReload();
  }

  return (
    <Card header="应用版本">
      <Row
        label="Bundle"
        value={<span className="mono text-ui">{bundleName}</span>}
      />
      <div className="px-4 sm:px-5 py-3 space-y-2">
        <button
          type="button"
          onClick={forceReload}
          disabled={isReloading}
          className="h-9 px-3.5 rounded-md border border-line bg-canvas hover:bg-paper text-ui font-medium text-ink disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {isReloading ? "正在重新加载…" : "强制刷新(清除缓存)"}
        </button>
        <div className="text-ui text-ink-muted">
          绕过浏览器的 HTTP 缓存以拉取最新版本的资源。若服务器更新后应用仍停留在旧版本,可以点击此按钮。
        </div>
      </div>
    </Card>
  );
}

// Restart-the-running-server button. Delegates to `restartServer` in
// lib/admin-actions — the helper POSTs /api/admin/restart (the server
// spawns a detached worker, replies 200, then SIGTERMs itself), polls
// /api/health until the new process responds, and then hard-reloads the
// page so the UI re-connects to the fresh server. The Home header's
// overflow menu uses the same helper, so behaviour stays consistent
// wherever we expose the button.
function RestartServerCard() {
  const [status, setStatus] = useState<
    "idle" | "confirming" | "restarting" | "waiting" | "done" | "failed"
  >("idle");
  const [err, setErr] = useState<string | null>(null);

  async function triggerRestart() {
    setStatus("restarting");
    setErr(null);
    try {
      await restartServer({ onProgress: () => setStatus("waiting") });
      // `restartServer` only returns after calling `window.location.replace`,
      // so in practice we never hit the next line — but if the reload is
      // blocked for any reason, flipping to "done" avoids a stuck button.
      setStatus("done");
    } catch (e) {
      setStatus("failed");
      setErr(
        e instanceof Error
          ? e.message
          : "等待服务器恢复时超时。",
      );
    }
  }

  const busy = status === "restarting" || status === "waiting";
  const buttonLabel =
    status === "idle"
      ? "重启服务器"
      : status === "confirming"
        ? "确认重启?"
        : status === "restarting"
          ? "正在发送重启指令…"
          : status === "waiting"
            ? "正在等待服务器…"
            : status === "done"
              ? "服务器已恢复"
              : "重启失败";

  return (
    <Card header="重启服务器">
      <div className="px-4 sm:px-5 py-3 space-y-2">
        {status === "confirming" ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={triggerRestart}
              className="h-9 px-3.5 rounded-md bg-danger text-canvas text-ui font-medium hover:opacity-90 transition-opacity"
            >
              是,立即重启
            </button>
            <button
              type="button"
              onClick={() => setStatus("idle")}
              className="h-9 px-3.5 rounded-md border border-line bg-canvas hover:bg-paper text-ui text-ink transition-colors"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setStatus("confirming")}
            disabled={busy}
            className="h-9 px-3.5 rounded-md border border-line bg-canvas hover:bg-paper text-ui font-medium text-ink disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {buttonLabel}
          </button>
        )}
        <div className="text-ui text-ink-muted">
          会就地重新执行{" "}
          <span className="mono">pnpm exec tsx src/index.ts</span>。进行中的会话不受影响 —— 它们的记录都保存在磁盘中 —— 但任何正在进行的工具调用会显示为中断。可在部署后安全执行;如果你正处在终端中且不想触发页面刷新,请改用脚本{" "}
          <span className="mono">scripts/restart.mjs</span>。
        </div>
        {err && (
          <div className="text-ui text-danger mono">{err}</div>
        )}
      </div>
    </Card>
  );
}

function AdvancedWorktreesCard() {
  const [worktrees, setWorktrees] = useState<WorktreeSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setErr(null);
    try {
      const res = await api.listWorktrees();
      setWorktrees(res.worktrees);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "加载失败");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function prune(items: WorktreeSummary[]) {
    if (items.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.pruneWorktrees(
        items.map((w) => ({
          projectId: w.projectId,
          branch: w.branch,
          path: w.path,
        })),
      );
      const firstError = res.results.find((r) => !r.removed)?.error;
      if (firstError) {
        setErr(firstError);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "清理失败");
    } finally {
      setBusy(false);
    }
  }

  const orphans = (worktrees ?? []).filter((w) => w.status === "orphaned");

  // Error wins over loading AND over the "no worktrees" empty state. A failed
  // initial fetch would previously fall through to the empty card — which
  // looks identical to a fresh install with no worktrees, hiding the fact
  // that we never got a response. Render the banner with a retry and bail.
  if (worktrees === null && err) {
    return (
      <Card header="Claudex 管理、散落在各项目中的 git 工作树。">
        <div className="px-4 py-4 flex items-center gap-3">
          <div className="min-w-0 flex-1 rounded border border-danger/30 bg-danger-wash px-3 py-2 text-ui text-danger">
            无法加载工作树: <span className="mono">{err}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 h-8 px-3 rounded border border-danger/40 bg-canvas text-ui text-danger font-mediumhover:bg-danger-wash transition-colors "
          >
            重试
          </button>
        </div>
      </Card>
    );
  }

  if (worktrees !== null && worktrees.length === 0) {
    return (
      <EmptyCard
        icon={FolderOpen}
        title="没有 claudex 管理的工作树。"
        body={
          <>
            当你以{" "}
            <span className="mono">worktree: true</span> 创建会话时,{" "}
            <span className="mono">claude/</span> 下的 git 分支以及{" "}
            <span className="mono">.claude/worktrees/</span> 下的目录会显示在这里,方便你清理遗留的任何内容。
          </>
        }
      />
    );
  }

  return (
    <Card
      header="Claudex 管理、散落在各项目中的 git 工作树。"
    >
      {worktrees === null ? (
        <div className="px-4 py-6 text-ui mono text-ink-muted">
          加载中…
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {worktrees.map((w) => (
            <li
              key={`${w.projectId}:${w.branch}`}
              className="px-4 py-3 flex items-center gap-3"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  w.status === "orphaned" ? "bg-danger" : "bg-success",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="mono text-ui truncate">{w.branch}</div>
                <div className="mono text-ui text-ink-muted truncate">
                  {w.path}
                </div>
                <div className="text-ui text-ink-muted mt-0.5">
                  {w.projectName} · {w.status === "orphaned" ? "孤立" : "已关联"}
                </div>
              </div>
              {w.status === "orphaned" && (
                <button
                  type="button"
                  onClick={() => prune([w])}
                  disabled={busy}
                  className="h-7 px-2 text-ui rounded-xs border border-line text-danger shrink-0 disabled:opacity-50"
                >
                  移除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {orphans.length > 0 && (
        <div className="px-4 py-2 border-t border-line">
          <button
            type="button"
            onClick={() => prune(orphans)}
            disabled={busy}
            className="h-8 px-3 rounded bg-danger/10 border border-danger/40 text-danger text-ui disabled:opacity-50 hover:bg-danger-wash transition-colors"
          >
            清理 {orphans.length} 个孤立项
          </button>
        </div>
      )}
      {err && (
        <div className="px-4 py-2 border-t border-line text-ui text-danger bg-danger-wash">
          {err}
        </div>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Advanced — Full-data backup + restore.
//
// Export goes through a plain <a href="/api/export/all" download> so the
// browser handles the JSON download natively — no Blob juggling. Import
// accepts a drag-drop or file-picker bundle and POSTs it as multipart to
// /api/import/all; on success we show an honest "imported N … skipped M …"
// summary. Secrets are not included in the export (see docs/FEATURES.md) and
// push subscriptions / users / recovery codes are skipped on import.
// ----------------------------------------------------------------------------

function BackupCard() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportAllResponse | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await api.importAll(file);
      setResult(res);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  function onDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    setDragOver(false);
    const file = ev.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  function onPickChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (file) void handleFile(file);
    // Reset so selecting the same file twice fires change again.
    ev.target.value = "";
  }

  const importedTotal = result
    ? result.imported.projects +
      result.imported.sessions +
      result.imported.events +
      result.imported.routines +
      result.imported.queue +
      result.imported.audit
    : 0;

  return (
    <Card header="备份与恢复">
      <div className="px-4 py-4 space-y-2">
        <div className="text-ui text-ink">导出全部数据</div>
        <div className="text-ui text-ink-muted max-w-[65ch]">
          会下载一份包含本机所有项目、会话、事件、例程与排队提示词的 JSON 包。机密信息仍留在本机 —— 哈希、TOTP、推送密钥和 JWT 密钥<em>不会</em>被导出。
        </div>
        <div>
          <a
            href={api.exportAllUrl()}
            download
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-line bg-paper/40 text-ui text-ink hover:bg-paper/70 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            下载数据包
          </a>
        </div>
      </div>
      <div className="px-4 py-4 space-y-2">
        <div className="text-ui text-ink">从数据包导入</div>
        <div className="text-ui text-ink-muted max-w-[65ch]">
          将之前导出的数据包合并进当前实例。路径相同且已存在的项目会被保留;会话及其事件总是以新行的形式加入。推送订阅、授权记录和附件文件会被跳过。
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-line bg-paper/40 text-ui text-ink hover:bg-paper/70 disabled:opacity-50 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            {busy ? "正在导入…" : "上传数据包"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onPickChange}
          />
          <div
            onDragOver={(ev) => {
              ev.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              "flex-1 min-w-[200px] h-10 rounded border border-dashed flex items-center justify-center text-ui",
              dragOver
                ? "border-accent text-accent bg-accent/5"
                : "border-line text-ink-muted",
              busy && "opacity-50 pointer-events-none",
            )}
          >
            {dragOver ? "松开以导入" : "或将 .json 数据包拖放到此处"}
          </div>
        </div>
        {result && (
          <div className="rounded border border-line bg-paper/40 px-3 py-2 text-ui text-ink space-y-0.5">
            <div>
              已导入 {importedTotal} 条:{result.imported.projects} 个项目,{result.imported.sessions} 个会话,{result.imported.events} 条事件,{result.imported.routines} 条例程,{result.imported.queue} 条排队,{result.imported.audit} 条审计记录。
            </div>
            {(result.skipped.projectsByPath > 0 ||
              result.skipped.sessionsBySdkId > 0 ||
              result.skipped.grants > 0 ||
              result.skipped.attachments > 0) && (
              <div className="text-ink-muted">
                已跳过:{result.skipped.projectsByPath} 个已存在项目,{result.skipped.sessionsBySdkId} 个已采纳会话,{result.skipped.grants} 条授权记录,{result.skipped.attachments} 个附件。
              </div>
            )}
            {result.versionMismatch && (
              <div className="text-ink-muted">
                该数据包由不同版本的 claudex 生成;导入已继续进行,但部分字段可能是新增或缺失的。
              </div>
            )}
          </div>
        )}
        {err && (
          <div className="rounded border border-danger/40 bg-danger-wash px-3 py-2 text-ui text-danger">
            {err}
          </div>
        )}
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Small layout atoms
// ----------------------------------------------------------------------------

function Card({
  header,
  children,
}: {
  header?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-canvas overflow-hidden">
      {header && (
        <div className="px-4 sm:px-5 py-3 border-b border-line text-ui text-ink-muted">
          {header}
        </div>
      )}
      <div className="divide-y divide-line">{children}</div>
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
    <div className="flex items-center gap-4 px-4 sm:px-5 py-3 text-ui">
      <div className="text-ink-muted text-ui uppercase tracking-widest w-28 shrink-0">
        {label}
      </div>
      <div className="min-w-0 flex-1 truncate text-ink">{value}</div>
    </div>
  );
}

function EmptyCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof UserIcon;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-paper/30 px-5 py-6 flex items-start gap-4">
      <div className="h-9 w-9 rounded bg-canvas border border-line flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-ink-muted" />
      </div>
      <div className="min-w-0">
        <div className="display text-ui-heading leading-tight">{title}</div>
        <div className="text-ui text-ink-muted mt-1 max-w-[60ch]">
          {body}
        </div>
        <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-line bg-canvas text-ui-sm font-medium uppercase tracking-widest text-ink-muted">
          暂未追踪
        </div>
      </div>
    </div>
  );
}
