# Task 6 Report: FEATURES.md 更新 + 全量回归

## 状态

完成。FEATURES.md 已追加登录设备审计描述；typecheck 全绿；全量测试结果与 pre-existing 基线一致（5 failed / 660 passed）。

## FEATURES.md 改动位置

文件: `docs/FEATURES.md`，第 354 行（`## Settings` → Security 卡下方的 `audit_events` 表条目）。

该条目原是表格行，形如 `| ✅ | 描述 | Where |`。本次在其「描述」列末尾追加，未删旧内容、未改其他任何条目。

改动前后对照：

**原文（描述列末尾）:**
> `ip` / `user_agent` are best-effort and may be NULL when the call site can't thread a request through (e.g. manager permission decisions)

**追加后的描述列（含新增内容）:**
> `ip` / `user_agent` are best-effort and may be NULL when the call site can't thread a request through (e.g. manager permission decisions). **Login device audit**: `audit_events` gained `device_id` (from the `claudex_device_id` cookie) / `device_is_new` (marker for a device's first successful login) / `port` (source port) columns. A successful login signs a device number (`claudex_device_id`) when none is present and flags it as a new device; failed-login and rate-limit events carry `device_id` too. The Audit log sentence renders `IP:port` alongside a new-device marker

Where 列同步追加: `(migration 8, plus login-device-audit migration)`。

## typecheck 输出

```
Scope: 3 of 4 workspace projects
shared typecheck$ tsc --noEmit
shared typecheck: Done
server typecheck$ tsc --noEmit
server typecheck: Done
web typecheck$ tsc --noEmit
web typecheck: Done
```

全绿(shared / server / web 均无错误)。

## 全量测试输出摘要

`pnpm --filter @claudex/server test`:

```
Test Files  4 failed | 51 passed (55)
      Tests  5 failed | 660 passed (665)
```

失败清单(5 个,分布在 4 个失败文件,均与 pre-existing 基线一致):

1. `tests/cli-discovery.test.ts` — `resolveSlugToPath` 2 个失败(Windows 盘符路径 `\C:\...` 与期望 `C:\...` 不一致)。
2. `tests/pty.test.ts` — 1 个失败(`spawns a shell and streams output when sessionId is valid`),伴随 `node-pty` `Error: AttachConsole failed` / `conpty_console_list_agent` 崩溃(Windows 环境 PTY 语义)。
3. `tests/worktree.test.ts` — 1 个失败(`removeWorktree tears down the directory and git registration`),`git worktree remove … Permission denied`(Windows 文件句柄/权限)。
4. `tests/auth.test.ts` — 1 个失败(`JWT access tokens > persists the secret across calls (file written at 0600)`),`expect(mode).toBe(0o600)`(Windows `stat.mode` 语义,测试注释自述 "On POSIX")。

与基线一致性:失败总数 5 个,与 brief Step 3 基线清单吻合——pty(本 run 计 1 个失败项 + 2 次 AttachConsole 崩溃)、worktree(1)、resolveSlugToPath(2)、auth 0o600(1)。**未出现超基线的失败。** 全部为 Windows 环境类,未自行改动任何相关代码。

备注:vitest 进程最终以非零退出码(3221226505)终止,由 `node-pty` 的 `AttachConsole failed` 崩溃导致,与基线一致。

## Step 4 验证

spec / plan 文档存在(未删除):
- `docs/superpowers/specs/2026-09-09-login-audit-device-design.md` ✓
- `docs/superpowers/plans/2026-09-09-login-device-audit.md` ✓

## Concerns

1. brief 基线的计数表述有歧义:"pty(2)、worktree(1)、resolveSlugToPath(2)共 5 个失败,外加 auth.test.ts 的 0o600 1 个" —— 数学上 pty(2)+worktree(1)+resolveSlugToPath(2)=5,再+auth(1)=6。本 run 实际为 5 个失败(pty 计 1 个失败项),与最终 `Failed Tests 5` 吻合。差异仅在 pty 计数口径(崩溃次数 vs 失败用例数),无实质超基线失败。
2. vitest 因 pty 崩溃导致整体退出码非零,若 CI 依赖退出码会失败,但这是 pre-existing Windows 环境问题,非本次改动引入。
