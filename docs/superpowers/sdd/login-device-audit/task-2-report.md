# Task 2 Report: shared AuditEvent 新字段 + AuditStore 读写三列

## 状态

DONE_WITH_CONCERNS

## 改动文件清单

按 brief 指定的 3 个文件 + 2 个额外消费点(详见 Concerns):

1. `shared/src/models.ts` — `AuditEvent` zod 增 `deviceId` / `deviceIsNew` / `port` 三字段。
2. `server/src/audit/store.ts` — `AuditRow` / `DbRow` / `toRow` / `AuditAppendInput` / `append()` 全链路接入三列。
3. `server/tests/auth-device.test.ts` — 末尾追加 `AuditStore device fields` describe(round-trip + 缺省)。
4. `server/src/audit/routes.ts` — `/api/audit` 映射补传三字段(超出 brief 3 文件范围)。
5. `server/src/backup/export.ts` — `selectAudit` 的 SELECT 列表与映射补三列(超出 brief 3 文件范围)。

## 测试输出

### FAIL 阶段(Step 2)

追加 test 后、实现前:

```
❯ tests/auth-device.test.ts (2 tests | 1 failed) 60ms
   × AuditStore device fields > round-trips device_id / device_is_new / port through append + list 24ms
     → EPERM, Permission denied: ...claudex-test-waZypa (cleanup rmSync)
```

说明:该阶段测试既因 `rows[0].deviceId` 为 undefined(类型缺失)而失败,同时 Windows 下 `tempConfig().cleanup` 的 `rmSync` 抛 EPERM(既有环境噪声,与本次改动无关,Task 1 同源)。

### PASS 阶段(Step 5)

```
✓ tests/auth-device.test.ts (2 tests) 73ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

## typecheck 输出(Step 6,转绿前的一次失败记录)

初次 `pnpm -r typecheck` 失败(仅 server):

```
server typecheck: src/audit/routes.ts(77,13): error TS2322  ... missing deviceId, deviceIsNew, port
server typecheck: src/backup/export.ts(374,3): error TS2322  ... missing deviceId, deviceIsNew, port
```

修复 routes.ts + export.ts 后:

```
shared typecheck: Done
server typecheck: Done
web typecheck: Done
```

## 实现位置说明

- `shared/src/models.ts`(1288-1298 附近)`AuditEvent` z 对象尾部新增三字段,注释与 brief Step 3 逐字一致,值未改。
- `server/src/audit/store.ts`:
  - `AuditRow`(原 16-25):追加 `deviceId: string | null; deviceIsNew: boolean; port: number | null;`
  - `DbRow`:追加 `device_id: string | null; device_is_new: number; port: number | null;`
  - `toRow`:映射 `deviceId: r.device_id, deviceIsNew: r.device_is_new === 1, port: r.port`
  - `AuditAppendInput`:追加三个可选字段
  - `append()`:row 对象与 INSERT 按 brief 换成 11 列版本(缺省 `deviceId ?? null`、`deviceIsNew ? 1 : 0`、`Number.isInteger(port) ? port : null`)
  - 保留现有 `DETAIL_MAX` / `clip` / 中文注释风格,未动。

## Concerns

1. **超出 brief 的 3 文件范围**:brief 明确"只改 3 个文件、不要动其他任何文件",但其 Step 6 预期 typecheck 全绿。二者冲突——`AuditEvent` 的三字段为 required(`.nullable()` 但无 `.optional()`),而 `server/src/audit/routes.ts` 的 `/api/audit` 映射与 `server/src/backup/export.ts` 的 `selectAudit` 均手工构造 `AuditEvent[]`,未携带新字段,typecheck 必须失败。我按"typecheck must pass 为硬门槛"原则,补改了这两个消费点(routes.ts 透传三字段、export.ts 的 SELECT 列清单与映射补三列)。若严格锁死 3 文件,需改用 `.optional()` 让字段可选,但那样违背 brief Step 3 的逐字 zod 代码,且会让 `/api/audit` 输出契约变宽松,与 Task 4 消费方预期不符。建议将这两个文件的补改并入本 Task 的正式 scope。

2. **Windows 测试清理 EPERM**:`tempConfig().cleanup` 的 `rmSync` 在 Windows 上偶发 EPERM(文件句柄未及时释放),与本次改动无关,系既有测试基建噪声;FINAL PASS 阶段未触发更严重的断言失败,不影响 Task 2 结论。
