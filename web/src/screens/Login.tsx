import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, User as UserIcon } from "lucide-react";
import { useAuth } from "@/state/auth";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/cn";

/**
 * Login screen — mockup s-01.
 *
 * Two-step flow (no pairing QR, since claudex is single-user):
 *   1. Sign in — username + password
 *   2. Verify  — six-digit TOTP (or recovery code fallback)
 *
 * Desktop (≥md): a 1.05fr / 1fr two-column split. The left column is a calm
 * hero panel with the wordmark + tagline + host chips (purely decorative — no
 * pairing action lives there); the right column carries the stepper + form.
 *
 * Mobile: single column, form only. The decorative left panel collapses out
 * entirely because a 390-wide viewport has no room for both.
 */
export function LoginScreen() {
  const navigate = useNavigate();
  const { login, verifyTotp, verifyRecoveryCode, challengeId, error, clearError, user } =
    useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  // On the TOTP step, swap the six-digit input for a recovery-code input.
  // Reset whenever the challenge changes (so going back to credentials and
  // logging in fresh defaults to TOTP again).
  const [useRecovery, setUseRecovery] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    if (!challengeId) {
      setUseRecovery(false);
      setCode("");
      setRecoveryCode("");
    }
  }, [challengeId]);

  const onCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(username, password);
    } catch {
      /* error in store */
    } finally {
      setBusy(false);
    }
  };

  const onCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await verifyTotp(code);
    } catch {
      // Wrong code: clear the input so the user can tap in the next one
      // without having to delete six digits first.
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const onRecovery = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await verifyRecoveryCode(recoveryCode);
    } catch {
      setRecoveryCode("");
    } finally {
      setBusy(false);
    }
  };

  const step = challengeId ? "totp" : "credentials";
  const displayName = username.trim().length > 0 ? username.trim() : null;

  const header =
    step === "credentials"
      ? {
          title: displayName ? `欢迎回来,${displayName}。` : "欢迎回来。",
          sub: "登录到此 claudex 实例。",
        }
      : useRecovery
        ? {
            title: "使用恢复码。",
            sub: "粘贴安装时保存的其中一个一次性恢复码。",
          }
        : {
            title: "还差一步 — 2FA 验证码。",
            sub: "输入验证器 App 中的六位动态码。",
          };

  return (
    <main className="min-h-[100dvh] bg-canvas">
      <div className="min-h-[100dvh] grid md:grid-cols-[1.05fr_1fr]">
        {/* Left panel — decorative, desktop only */}
        <aside className="relative hidden md:flex border-r border-line bg-paper overflow-hidden">
          <div
            aria-hidden
            className="absolute inset-0 opacity-70"
            style={{
              backgroundImage:
                "linear-gradient(rgb(var(--c-ink)/0.05) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--c-ink)/0.05) 1px, transparent 1px)",
              backgroundSize: "32px 32px",
            }}
          />
          <div className="relative z-10 w-full p-10 flex flex-col">
            <div className="flex items-center gap-2">
              <Logo className="w-6 h-6" />
              <span className="mono text-ui font-bold">Claudex</span>
              <span className="ml-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-klein/30 bg-klein-wash text-klein-ink text-ui-sm font-medium uppercase tracking-[0.12em]">
                <span className="h-1.5 w-1.5 rounded-full bg-klein" />
                自托管
              </span>
            </div>
            <div className="mt-auto">
              <h1 className="display text-[2.5rem] xl:text-[3rem] leading-[0.98] max-w-[16ch]">
                远程操控你自有机器上运行的{" "}
                <em className="not-italic text-klein">claude</em>。
              </h1>
              <p className="mt-5 max-w-[46ch] text-ink-muted text-ui-lg leading-[1.55]">
                你的文件、你的提交、你的开发服务器 — 原封不动。claudex
                只是让你在手机上也多一双眼睛盯着它们,无论你身在何处。
              </p>
            </div>
          </div>
        </aside>

        {/* Right panel — form */}
        <section className="flex items-center justify-center px-5 py-10 md:p-10">
          <div className="w-full max-w-[420px] md:bg-canvas md:border md:border-line md:shadow-raised md:rounded-xl md:p-8">
            {/* Compact mobile wordmark — desktop gets it in the left panel */}
            <div className="flex items-center gap-2 mb-8 md:hidden">
              <Logo className="w-6 h-6" />
              <span className="mono text-ui font-bold">Claudex</span>
            </div>

            <Stepper current={step === "credentials" ? 0 : 1} />

            <h2 className="display text-ui-display-xl leading-tight mt-8">
              {header.title}
            </h2>
            <p className="mt-2 text-ink-muted text-ui-lg">{header.sub}</p>

            <div className="mt-6">
              {step === "credentials" ? (
                <form onSubmit={onCredentials} className="space-y-4">
                  <LabeledInput
                    label="用户名"
                    icon={<UserIcon className="w-4 h-4" />}
                    value={username}
                    onChange={(v) => {
                      clearError();
                      setUsername(v);
                    }}
                    autoFocus
                    autoComplete="username"
                  />
                  <LabeledInput
                    label="密码"
                    icon={<Lock className="w-4 h-4" />}
                    type="password"
                    value={password}
                    onChange={(v) => {
                      clearError();
                      setPassword(v);
                    }}
                    autoComplete="current-password"
                  />
                  <div className="flex items-center justify-between text-ui pt-1">
                    <label className="flex items-center gap-2 text-ink-soft cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                        className="sr-only peer"
                      />
                      <span
                        className={cn(
                          "h-4 w-4 rounded-xs border bg-canvas flex items-center justify-center transition-colors",
                          remember
                            ? "border-klein"
                            : "border-line-strong",
                        )}
                      >
                        {remember && (
                          <span className="h-2 w-2 bg-klein rounded-[1px]" />
                        )}
                      </span>
                      此浏览器 30 天内免登录
                    </label>
                  </div>
                  <button
                    type="submit"
                    disabled={busy || !username || password.length < 1}
                    className={cn(
                      "w-full h-12 rounded bg-ink text-canvas font-medium border border-ink transition-opacity",
                      "disabled:opacity-50 disabled:pointer-events-none",
                    )}
                  >
                    {busy ? "登录中…" : "继续"}
                  </button>
                  {error && <InlineError>{formatError(error)}</InlineError>}
                </form>
              ) : useRecovery ? (
                <form onSubmit={onRecovery} className="space-y-4">
                  <RecoveryCodeInput
                    value={recoveryCode}
                    onChange={(v) => {
                      clearError();
                      setRecoveryCode(v);
                    }}
                  />
                  <button
                    type="submit"
                    disabled={
                      busy || recoveryCode.replace(/[\s-]/g, "").length < 16
                    }
                    className={cn(
                      "w-full h-12 rounded bg-ink text-canvas font-medium border border-ink transition-opacity",
                      "disabled:opacity-50 disabled:pointer-events-none",
                    )}
                  >
                    {busy ? "验证中…" : "解锁"}
                  </button>
                  {error && <InlineError>{formatError(error)}</InlineError>}
                  <div className="flex items-center justify-between text-ui pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        clearError();
                        setUseRecovery(false);
                        setRecoveryCode("");
                      }}
                      className="text-klein-ink underline underline-offset-2 hover:text-ink transition-colors"
                    >
                      返回动态码登录
                    </button>
                    <span className="text-ink-muted">每个恢复码仅能使用一次。</span>
                  </div>
                </form>
              ) : (
                <form onSubmit={onCode} className="space-y-4">
                  <TotpInput value={code} onChange={setCode} />
                  <button
                    type="submit"
                    disabled={busy || code.length !== 6}
                    className={cn(
                      "w-full h-12 rounded bg-ink text-canvas font-medium border border-ink transition-opacity",
                      "disabled:opacity-50 disabled:pointer-events-none",
                    )}
                  >
                    {busy ? "验证中…" : "解锁"}
                  </button>
                  {error && <InlineError>{formatError(error)}</InlineError>}
                  <div className="flex items-center justify-between text-ui pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        clearError();
                        setUseRecovery(true);
                        setCode("");
                      }}
                      className="text-klein-ink underline underline-offset-2 hover:text-ink transition-colors"
                    >
                      改用恢复码
                    </button>
                    <span className="text-ink-muted">
                      验证码每 30 秒刷新。
                    </span>
                  </div>
                </form>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * The store normalises common codes to friendly Chinese copy. Anything it
 * doesn't recognise (`rate_limited`, raw `http_500`, etc.) leaks through as a
 * bare code — intercept those here so the surfaced copy stays readable.
 */
function formatError(error: string): string {
  if (error === "rate_limited") return "尝试次数过多，请稍后再试";
  if (error === "missing_challenge") return "登录会话已过期，请重新登录";
  if (error.startsWith("http_")) return "网络异常，请稍后再试";
  return error;
}

function Stepper({ current }: { current: 0 | 1 }) {
  const labels = ["登录", "验证"];
  return (
    <div className="flex items-center gap-2 text-ui text-ink-muted">
      {labels.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={cn(
              "mono h-5 w-5 inline-flex items-center justify-center rounded-full border",
              current === i
                ? "bg-klein text-canvas border-klein"
                : i < current
                  ? "bg-canvas text-ink border-line-strong"
                  : "bg-canvas border-line-strong text-ink-muted",
            )}
          >
            {i + 1}
          </span>
          <span
            className={cn(
              "uppercase tracking-[0.14em]",
              current === i ? "text-ink" : "",
            )}
          >
            {label}
          </span>
          {i < labels.length - 1 && (
            <span className="h-px w-8 bg-line-strong mx-1" />
          )}
        </div>
      ))}
    </div>
  );
}

function LabeledInput({
  label,
  icon,
  value,
  onChange,
  type = "text",
  autoFocus,
  autoComplete,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoFocus?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <div className="text-ui font-medium mb-1.5 text-ink-soft">{label}</div>
      <div className="flex items-center gap-2 px-3 h-10 bg-canvas border border-line rounded focus-within:border-klein focus-within:shadow-[0_0_0_3px_rgb(var(--c-klein)/0.22)] transition-shadow">
        <span className="text-ink-muted">{icon}</span>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          className="flex-1 bg-transparent outline-none text-ui-lg"
        />
      </div>
    </label>
  );
}

/**
 * The real input is a single `<input type="text">` kept offscreen so that
 * iOS's SMS autofill bar, 1Password, and keyboard nav behave as users expect.
 * Visually we project each typed character into its own slot; the first empty
 * slot shows a klein ring + blinking caret.
 */
function TotpInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const digits = value.padEnd(6).split("").slice(0, 6);
  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className="cursor-text"
    >
      <div className="text-ui font-medium mb-1.5 text-ink-soft">
        验证器动态码
      </div>
      <input
        ref={inputRef}
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        autoFocus
        autoComplete="one-time-code"
        value={value}
        onChange={(e) =>
          onChange(e.target.value.replace(/\D/g, "").slice(0, 6))
        }
        className="sr-only"
        id="totp-hidden"
      />
      <div className="grid grid-cols-6 gap-2 mono">
        {digits.map((d, i) => {
          const filled = d.trim().length > 0;
          const isNext = !filled && value.length === i;
          return (
            <div
              key={i}
              className={cn(
                "h-12 rounded border bg-canvas flex items-center justify-center text-ui-display transition-shadow",
                filled
                  ? "border-line-strong"
                  : isNext
                    ? "border-klein shadow-[0_0_0_3px_rgb(var(--c-klein)/0.18)]"
                    : "border-line",
              )}
            >
              {d.trim() ? (
                d
              ) : isNext ? (
                <span className="text-klein animate-pulse">|</span>
              ) : (
                ""
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecoveryCodeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="text-ui font-medium mb-1.5 text-ink-soft">
        恢复码
      </div>
      <div className="flex items-center gap-2 px-3 h-10 bg-canvas border border-line rounded focus-within:border-klein focus-within:shadow-[0_0_0_3px_rgb(var(--c-klein)/0.22)] transition-shadow">
        <Lock className="w-4 h-4 text-ink-muted" />
        <input
          type="text"
          inputMode="text"
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="xxxx-xxxx-xxxx-xxxx"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-transparent outline-none text-ui-lg mono tracking-wide"
        />
      </div>
      <div className="text-ui text-ink-muted mt-1.5">
        16 位字符,短横线可省略,每个恢复码仅能使用一次。
      </div>
    </div>
  );
}

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="text-danger text-ui mt-2">
      {children}
    </div>
  );
}
