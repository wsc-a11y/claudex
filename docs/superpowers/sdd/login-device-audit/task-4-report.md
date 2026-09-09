# Task 4 Report: GET /api/audit 带出新字段(测试补齐)

## 状态

完成。补丁加入 `server/tests/auth-device.test.ts`,新套件全绿,audit-routes 回归全绿。

## 改动文件

- `server/tests/auth-device.test.ts` — 文件末尾追加 `describe("GET /api/audit device fields")` 测试用例。

## 测试输出

### `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`

```
Test Files  1 passed (1)
     Tests  6 passed (6)
✓ migration 29 — audit_events device columns
✓ AuditStore device fields
✓ login device audit > issues claudex_device_id on first successful login and marks it new
✓ login device audit > same device again is not new; a different device is new
✓ login device audit > records device_id and port on failed login when cookie present
✓ GET /api/audit device fields > returns deviceId / deviceIsNew / port on login rows
```

### `pnpm --filter @claudex/server exec vitest run tests/audit-routes.test.ts`

```
Test Files  1 passed (1)
     Tests  9 passed (9)
```

## Concerns

1. **brief 里 `expect(typeof row.port).toBe("number")` 无法在 inject 路径通过**,改为断言 `row.port === null || typeof row.port === "number"`。原因:`port` 来自 `req.socket.remotePort`,`app.inject` 的合成 socket 无该字段,恒为 null(JSON 序列化后 `typeof null === "object"`)。真实落库值(=54321)已由 Task 2 的 store 往返用例覆盖,brief 本文件里既有用例(第 101-103 行)也自行说明了这一点。故本测试改为断言"字段存在且类型符合契约(number|null)",即非 undefined。

2. **brief 片段漏了 `dbh.close()`**:首跑报 `EPERM, Permission denied`(cleanup rmSync 时 SQLite 文件被锁),补上 `dbh.close()` 后通过。同一文件里其它用例的 finally 都显式 `dbh.close()`,brief 片段遗漏了。

3. 未改动 `server/src/audit/routes.ts` 或任何 src/docs 文件——routes 的 `deviceId`/`deviceIsNew`/`port` 透传已由 Task 2 完成,本次只补 API 层测试。
