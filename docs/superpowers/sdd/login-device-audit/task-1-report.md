# Task 1 Report: 迁移 29(audit_events 加三列)+ schema 测试

## 状态

DONE_WITH_CONCERNS

## 改动文件清单

1. `server/src/db/index.ts` — 在 `MIGRATIONS` 数组尾部(id=28 `users_totp_enabled` 条目之后)追加 id=29 `audit_events_device_columns` 迁移;未改动任何历史条目。
2. `server/tests/auth-device.test.ts` — 新建的 schema 测试(逐字照抄 brief 的 Step 1 代码)。

## 测试输出

### FAIL 阶段(未实现迁移 29)

命令:
```
pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts
```

关键输出行:
```
FAIL  tests/auth-device.test.ts > migration 29 — audit_events device columns > adds device_id / device_is_new / port columns
Error: EPERM, Permission denied: \\?\C:\Users\80549\AppData\Local\Temp\claudex-test-AvAP4E ...
 ❯ cleanup tests/helpers.ts:49:7
```

### PASS 阶段(实现迁移 29 后)

命令(同上):
```
pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts
```

关键输出行:
```
✓ tests/auth-device.test.ts (1 test) 46ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

补充:`pnpm --filter @claudex/server exec tsc --noEmit` 无报错(server side typecheck clean)。

## 实现位置说明

迁移 29 `audit_events_device_columns` 位于 `server/src/db/index.ts` 第 855 行起(文件末尾 `];` 之前),紧接 id=28 `users_totp_enabled` 条目之后,是 `MIGRATIONS` 数组的最后一个元素。三列定义:
- `device_id TEXT`(NULL)
- `device_is_new INTEGER NOT NULL DEFAULT 0`
- `port INTEGER`(NULL)

## Concerns

1. **Windows 下的 EPERM 掩盖了预期的断言失败。** brief 预期 FAIL 阶段的报错是 `names.has("device_id") false`,但在此 Windows 环境实际报错是 `EPERM, Permission denied` —— 发生在 `cleanup()` 的 `rmSync(stateDir)`(helpers.ts:49),而非 `expect` 断言。根因是 better-sqlite3 在 Windows 上 `db.close()` 后 WAL/SHM 旁路文件的句柄释放存在时序竞态,brief 的逐字测试用 `try/finally` 同步调用 `cleanup()`,与 `openDb` 的 WAL 锁竞争。这是环境性（Windows 特有）、非断言性的 teardown 误差。PASS 阶段同样用了 `cleanup()`,但每次 `✓` 通过(时序恰好命中释放完成),故该 EPERM 是间歇性的。

2. **既有 `server/tests/db.test.ts` 的写法规避了此问题**:它用 `cleanups` 数组 + `afterEach` 将 `close` 与 `cleanup` 推迟到用例结束后顺序执行,4 个用例在 Windows 下全部通过。若后续任务的 auth-device 测试需要稳定跑红(而非被 EPERM 干扰断言),建议后续任务(非本任务,超出资权)将 cleanup 改为 `afterEach` 延迟模式。本任务严格遵守 brief「代码逐字照抄、值不要改」,故保留了原样,并在此记录这一环境差异。

3. **未改历史迁移条目**,仅尾部追加;`MIGRATIONS` 结构的 `up` SQL 块三句 `ALTER TABLE ... ADD COLUMN` 与 brief 逐字一致,含中文注释。

4. 本仓库被任务约束为「非 git 仓库」,全程未执行任何 git 操作。
