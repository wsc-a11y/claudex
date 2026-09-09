# Task 1: 迁移 29(audit_events 加三列)+ schema 测试

**Files:**
- Modify: `server/src/db/index.ts`(MIGRATIONS 数组尾部,id=28 条目之后)
- Test: `tests/auth-device.test.ts`(新建,本任务只放 schema 用例)

**Interfaces:**
- Produces: 数据库 `audit_events` 新列 `device_id TEXT NULL`、`device_is_new INTEGER NOT NULL DEFAULT 0`、`port INTEGER NULL`。后续任务的 INSERT/SELECT 全部依赖这三列。

## Step 1: 写失败的迁移测试

创建 `server/tests/auth-device.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { tempConfig } from "./helpers.js";

describe("migration 29 — audit_events device columns", () => {
  it("adds device_id / device_is_new / port columns", () => {
    const { config, log, cleanup } = tempConfig();
    try {
      const dbh = openDb(config, log);
      const cols = dbh.db
        .prepare("PRAGMA table_info(audit_events)")
        .all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      expect(names.has("device_id")).toBe(true);
      expect(names.has("device_is_new")).toBe(true);
      expect(names.has("port")).toBe(true);
      dbh.close();
    } finally {
      cleanup();
    }
  });
});
```

## Step 2: 运行测试确认失败

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: FAIL(`names.has("device_id")` false)

## Step 3: 实现迁移 29

在 `server/src/db/index.ts` 的 `MIGRATIONS` 末尾、id=28 条目之后追加:

```ts
{
  id: 29,
  name: "audit_events_device_columns",
  // 登录审计增强(2026-09):device_id = 浏览器设备号 cookie
  // (claudex_device_id,非 httpOnly 匿名标识),device_is_new = 该设备对
  // 该用户是否首次登录成功(仅成功事件计算),port = TCP 源端口(配合
  // 路由器 NAT/DHCP 会话表取证)。旧行三列 NULL/0,不做 backfill。
  up: `
    ALTER TABLE audit_events ADD COLUMN device_id TEXT;
    ALTER TABLE audit_events ADD COLUMN device_is_new INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE audit_events ADD COLUMN port INTEGER;
  `,
},
```

## Step 4: 运行测试确认通过

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: PASS
