# Task 2: shared AuditEvent 新字段 + AuditStore 读写三列

**Files:**
- Modify: `shared/src/models.ts`(AuditEvent zod,当前 1281-1294 行)
- Modify: `server/src/audit/store.ts`
- Test: `server/tests/auth-device.test.ts`(在现有文件末尾追加 describe)

**Interfaces:**
- Consumes: Task 1 的三列(已存在数据库 schema,本任务前先跑一次 Task 1 的测试确认迁移已就绪)。
- Produces:
  - `AuditEvent`(shared):新增 `deviceId: z.string().nullable()`、`deviceIsNew: z.boolean()`、`port: z.number().int().nullable()`。
  - `AuditStore.append(input: AuditAppendInput)`:`AuditAppendInput` 新增可选 `deviceId?: string | null`、`deviceIsNew?: boolean`、`port?: number | null`(缺省分别 null/0/null)。
  - `AuditStore.list()` 返回的 `AuditRow` 新增 `deviceId: string | null`、`deviceIsNew: boolean`、`port: number | null`。Task 4 的 /api/audit 直接消费这些字段。

## Step 1: 在 `server/tests/auth-device.test.ts` 末尾追加 store 测试

在文件末尾追加(import 放文件顶部合并到现有 import 区):

```ts
import { AuditStore } from "../src/audit/store.js";

describe("AuditStore device fields", () => {
  it("round-trips device_id / device_is_new / port through append + list", () => {
    const { config, log, cleanup } = tempConfig();
    try {
      const dbh = openDb(config, log);
      const audit = new AuditStore(dbh.db);
      audit.append({
        userId: "u1",
        event: "login",
        detail: "2FA verified",
        ip: "100.64.0.1",
        userAgent: "curl/8",
        deviceId: "dev-abc",
        deviceIsNew: true,
        port: 54321,
      });
      const rows = audit.list({ events: ["login"] });
      expect(rows[0].deviceId).toBe("dev-abc");
      expect(rows[0].deviceIsNew).toBe(true);
      expect(rows[0].port).toBe(54321);

      // 缺省:不传新字段 → 行内 null/false/null(旧调用点不受影响)
      audit.append({ event: "logout" });
      const out = audit.list({ events: ["logout"] });
      expect(out[0].deviceId).toBeNull();
      expect(out[0].deviceIsNew).toBe(false);
      expect(out[0].port).toBeNull();
      dbh.close();
    } finally {
      cleanup();
    }
  });
});
```

注意:现有文件已有 `import { describe, it, expect } from "vitest";`、`openDb`、`tempConfig`。需要追加的只有 AuditStore import。

## Step 2: 运行测试确认失败

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: FAIL(类型错误或 rows[0].deviceId undefined)

## Step 3: shared models 增加字段

`shared/src/models.ts` 的 AuditEvent z 对象(约 1281-1294 行,含 `id/event/target/detail/ip/userAgent/createdAt/user` 字段)新增三行(保持现有注释风格):

```ts
  // 登录设备审计(2026-09):deviceId = 浏览器设备号 claudex_device_id;
  // deviceIsNew = 该设备号对该用户首次登录成功(仅成功事件为 true);
  // port = TCP 源端口。旧行 deviceId/port 为 null,deviceIsNew 为 false。
  deviceId: z.string().nullable(),
  deviceIsNew: z.boolean(),
  port: z.number().int().nullable(),
```

## Step 4: `server/src/audit/store.ts` 扩展

1. `AuditRow` interface(约 16-25 行)追加:`deviceId: string | null; deviceIsNew: boolean; port: number | null;`
2. `DbRow` interface(约 27-36 行)追加:`device_id: string | null; device_is_new: number; port: number | null;`
3. `toRow`(约 38-49 行)映射追加:`deviceId: r.device_id, deviceIsNew: r.device_is_new === 1, port: r.port,`
4. `AuditAppendInput`(约 51-58 行)追加可选字段:`deviceId?: string | null; deviceIsNew?: boolean; port?: number | null;`
5. `append()`(约 119-149 行)的 row 对象与 INSERT 语句替换为:

```ts
      const row = {
        id: nanoid(16),
        user_id: input.userId ?? null,
        event: input.event,
        target: clip(input.target, TARGET_MAX),
        detail: clip(input.detail, DETAIL_MAX),
        ip: clip(input.ip, 64),
        user_agent: clip(input.userAgent, UA_MAX),
        device_id: clip(input.deviceId ?? null, 32),
        device_is_new: input.deviceIsNew ? 1 : 0,
        port: Number.isInteger(input.port) ? input.port : null,
        created_at: new Date().toISOString(),
      };
      this.lazyStmt(
        "insert",
        `INSERT INTO audit_events
           (id, user_id, event, target, detail, ip, user_agent,
            device_id, device_is_new, port, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.user_id,
        row.event,
        row.target,
        row.detail,
        row.ip,
        row.user_agent,
        row.device_id,
        row.device_is_new,
        row.port,
        row.created_at,
      );
```

(原 INSERT 列清单为 `(id, user_id, event, target, detail, ip, user_agent, created_at)`,8 列 8 占位——整体替换成上面的 11 列版本。)

## Step 5: 运行测试确认通过

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: PASS(全部 suite 绿,含 Task 1 的)

## Step 6: typecheck

Run: `pnpm -r typecheck`
Expected: 全绿(shared 变更影响 server/web 类型;若 web 有未用字段错误不会发生——AuditEvent 新增字段为可选消费)
