# Task 4: GET /api/audit 带出新字段(测试补齐)

**Files:**
- Test: `server/tests/auth-device.test.ts`(在文件末尾追加 describe)

**重要背景**:原计划中本任务要改 `server/src/audit/routes.ts` 的响应 map——该改动已被 Task 2 提前完成并通过审查(`deviceId: r.deviceId, deviceIsNew: r.deviceIsNew, port: r.port` 透传,audit/routes.ts 约 77-89 行)。**本任务不再改 routes.ts**,只补 API 层测试并验证既有实现。

**Interfaces:**
- Consumes: Task 2 的 routes.ts map 透传 + shared AuditEvent 三字段 + Task 3 的 2FA-off 登录路径(登录时已带 device cookie 与 is_new 标记)。

## Step 1: 在 `server/tests/auth-device.test.ts` 末尾追加 API 测试

在文件末尾追加(import 已在顶部——本文件已有 `buildApp`、`loadOrCreateJwtSecret`、`hashPassword`、`UserStore`,因为 Task 3 加过;若缺则合并进顶部 import):

```ts
describe("GET /api/audit device fields", () => {
  it("returns deviceId / deviceIsNew / port on login rows", async () => {
    const { config, log, cleanup } = tempConfig();
    const dbh = openDb(config, log);
    const jwtSecret = loadOrCreateJwtSecret(config);
    const { app } = await buildApp({ db: dbh.db, jwtSecret, logger: false, isProduction: false });
    try {
      const users = new UserStore(dbh.db);
      users.create({
        username: "no2fa",
        passwordHash: await hashPassword("pw-pw-pw-pw"),
        totpSecret: "",
        totpEnabled: false,
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "no2fa", password: "pw-pw-pw-pw" },
      });
      const sessionCookie = login.cookies.find((c) => c.name === "claudex_session")!;
      const res = await app.inject({
        method: "GET",
        url: "/api/audit?events=login",
        headers: { cookie: `claudex_session=${sessionCookie.value}` },
      });
      expect(res.statusCode).toBe(200);
      const row = res.json().events[0];
      expect(row.deviceId).toBe(login.cookies.find((c) => c.name === "claudex_device_id")!.value);
      expect(row.deviceIsNew).toBe(true);
      expect(typeof row.port).toBe("number");
    } finally {
      await app.close();
      cleanup();
    }
  });
});
```

## Step 2: 运行测试确认通过(实现已存在,预期直接绿)

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: 全部 suite PASS(含新 API 用例;该用例断言 deviceId/deviceIsNew/port 在 API 响应中存在且正确)

## Step 3: 旧行兼容回归

Run: `pnpm --filter @claudex/server exec vitest run tests/audit-routes.test.ts`
Expected: PASS(该套件原有断言应不受响应新增字段影响;若有逐字匹配对象断言失败,报告并说明,不要自行改该套件断言)
