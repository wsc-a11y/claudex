# Task 3: auth 路由 — 设备号 cookie 与审计行携带 device_id / is_new / port

**Files:**
- Modify: `server/src/auth/routes.ts`
- Test: `server/tests/auth-device.test.ts`(在文件末尾追加 describe)

**Interfaces:**
- Consumes: Task 1 数据库三列(已存在);Task 2 `AuditStore.append` 的 AuditAppendInput 新可选字段(deviceId/deviceIsNew/port,已可用)。
- Produces(均在 `server/src/auth/routes.ts` 内):
  - 模块级常量 `DEVICE_COOKIE = "claudex_device_id"` 与 `DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10`
  - `deviceCookieOpts(req)`:`{ ...cookieOpts(req), httpOnly: false, maxAge: DEVICE_COOKIE_MAX_AGE }`
  - `readDeviceId(req): string | null`
  - `deviceIsNew(db, userId, deviceId): boolean`(模块级,SQL 查询)
  - `registerAuthRoutes` 内 `auditDevice(req, reply, userId)` 闭包 helper,返回 `{ deviceId: string | null; isNewDevice: boolean }`
  - `reqCtx` helper 返回值追加 `port`(所有带 `...reqCtx(req)` 的审计行自动获得)

## Step 1: 在 `server/tests/auth-device.test.ts` 末尾追加登录行为测试

文件顶部 import 已含 vitest 三件套。追加(新 import 合并进顶部:需要 `buildApp`、`loadOrCreateJwtSecret`、`generateTotpSecret`(不用)、`hashPassword`、`UserStore` —— 从 `../src/transport/app.js`、`../src/auth/index.js` 引入):

```ts
import { buildApp } from "../src/transport/app.js";
import {
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";

describe("login device audit", () => {
  async function bootTotpOff() {
    const { config, log, cleanup } = tempConfig();
    const dbh = openDb(config, log);
    const jwtSecret = loadOrCreateJwtSecret(config);
    const { app } = await buildApp({ db: dbh.db, jwtSecret, logger: false, isProduction: false });
    const users = new UserStore(dbh.db);
    users.create({
      username: "no2fa",
      passwordHash: await hashPassword("pw-pw-pw-pw"),
      totpSecret: "", // empty + totpEnabled=false → 2FA 关闭路径
      totpEnabled: false,
    });
    return { app, dbh, cleanup };
  }

  it("issues claudex_device_id on first successful login and marks it new", async () => {
    const { app, dbh, cleanup } = await bootTotpOff();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "no2fa", password: "pw-pw-pw-pw" },
      });
      expect(res.statusCode).toBe(200);
      const deviceCookie = res.cookies.find((c) => c.name === "claudex_device_id");
      expect(deviceCookie).toBeDefined();
      expect(deviceCookie!.httpOnly).toBe(false);

      const row = dbh.db.prepare(
        "SELECT device_id, device_is_new, port FROM audit_events WHERE event = 'login'",
      ).get() as { device_id: string; device_is_new: number; port: number | null };
      expect(row.device_id).toBe(deviceCookie!.value);
      expect(row.device_is_new).toBe(1);
      expect(row.port).not.toBeNull();
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("same device again is not new; a different device is new", async () => {
    const { app, dbh, cleanup } = await bootTotpOff();
    try {
      const payload = { username: "no2fa", password: "pw-pw-pw-pw" };
      const first = await app.inject({ method: "POST", url: "/api/auth/login", payload });
      const deviceId = first.cookies.find((c) => c.name === "claudex_device_id")!.value;

      const second = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload,
        headers: { cookie: `claudex_device_id=${deviceId}` },
      });
      expect(second.cookies.some((c) => c.name === "claudex_device_id")).toBe(false);

      const rows = dbh.db.prepare(
        "SELECT device_id, device_is_new FROM audit_events WHERE event = 'login' ORDER BY rowid",
      ).all() as Array<{ device_id: string; device_is_new: number }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].device_id).toBe(deviceId);
      expect(rows[0].device_is_new).toBe(1);
      expect(rows[1].device_id).toBe(deviceId);
      expect(rows[1].device_is_new).toBe(0);

      const third = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload,
        headers: { cookie: "claudex_device_id=other-device" },
      });
      const row3 = dbh.db.prepare(
        "SELECT device_is_new FROM audit_events WHERE event = 'login' ORDER BY rowid DESC LIMIT 1",
      ).get() as { device_is_new: number };
      expect(third.cookies.find((c) => c.name === "claudex_device_id")?.value).toBe("other-device");
      expect(row3.device_is_new).toBe(1);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("records device_id and port on failed login when cookie present", async () => {
    const { app, dbh, cleanup } = await bootTotpOff();
    try {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "no2fa", password: "pw-pw-pw-pw" },
      });
      const bad = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "no2fa", password: "wrong-pass" },
        headers: { cookie: "claudex_device_id=attacker-dev" },
      });
      expect(bad.statusCode).toBe(401);
      const row = dbh.db.prepare(
        "SELECT device_id, device_is_new, port FROM audit_events WHERE event = 'login_failed' ORDER BY rowid DESC LIMIT 1",
      ).get() as { device_id: string; device_is_new: number; port: number | null };
      expect(row.device_id).toBe("attacker-dev");
      expect(row.device_is_new).toBe(0);
      expect(row.port).not.toBeNull();
    } finally {
      await app.close();
      cleanup();
    }
  });
});
```

## Step 2: 运行测试确认失败

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: 新增 suite FAIL(无 claudex_device_id cookie、审计行 device_id 为 null)。既有 suite(Task 1/2)保持绿。

## Step 3: 模块级常量与 helper

`server/src/auth/routes.ts`:
1. 顶部 import 区加 `import { nanoid } from "nanoid";`
2. 模块级 `isRequestSecure` 之后、`cookieOpts` 之前插入(含 DEVICE cookie 定义;`cookieOpts` 在其后,deviceCookieOpts 放 cookieOpts 定义之后):

```ts
// 登录设备审计(2026-09):浏览器匿名设备号。非 httpOnly——它是标识不是
// 凭据,前端无需读取;浏览器对同源登录请求自动携带,前端零改动。
// 删除/更换 cookie = 新设备,下次登录会以"新设备"醒目记录。
const DEVICE_COOKIE = "claudex_device_id";
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10; // 10 年
```

`cookieOpts` 函数结束后追加:

```ts
function deviceCookieOpts(req: FastifyRequest) {
  return { ...cookieOpts(req), httpOnly: false, maxAge: DEVICE_COOKIE_MAX_AGE };
}

function readDeviceId(req: FastifyRequest): string | null {
  const v = req.cookies?.[DEVICE_COOKIE];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// 该 user+device 组合此前是否登录成功过(login 与 recovery_code_used 都是
// 成功事件——恢复码登录成功的审计事件名是 recovery_code_used 而非 login)。
// 无历史 = 新设备。
function deviceIsNew(
  db: Database.Database,
  userId: string,
  deviceId: string | null,
): boolean {
  if (!deviceId) return false;
  const hit = db
    .prepare(
      `SELECT 1 FROM audit_events
       WHERE user_id = ? AND device_id = ? AND event IN ('login','recovery_code_used')
       LIMIT 1`,
    )
    .get(userId, deviceId);
  return !hit;
}
```

3. `registerAuthRoutes` 内 `reqCtx` helper(现约 120-123 行)替换为(追加 port):

```ts
  const reqCtx = (req: FastifyRequest) => {
    const ctx = getRequestCtx(req);
    return {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      port: (req.socket as { remotePort?: number }).remotePort ?? null,
    };
  };
```

4. `reqCtx` 定义之后、`app.decorate("requireAuth"...)` 之前插入闭包 helper(它引用外层 `deps`):

```ts
  // 登录成功共用:返回本次审计要记录的 deviceId + isNewDevice,并负责首次
  // 发号。全新 cookie 直接视为新设备(免一次查询);已有 cookie 则查历史。
  const auditDevice = (
    req: FastifyRequest,
    reply: FastifyReply,
    userId: string,
  ): { deviceId: string | null; isNewDevice: boolean } => {
    let deviceId = readDeviceId(req);
    let isNewDevice = false;
    if (!deviceId) {
      deviceId = nanoid(16);
      isNewDevice = true;
      reply.setCookie(DEVICE_COOKIE, deviceId, deviceCookieOpts(req));
    } else {
      isNewDevice = deviceIsNew(deps.db, userId, deviceId);
    }
    return { deviceId, isNewDevice };
  };
```

## Step 4: 三个成功点接上发号与审计字段

**2FA-off 成功点**(`if (!row.totp_enabled) {` 块内):在签发 session cookie 之后、`deps.audit.append` 调用改为:

```ts
      const dev = auditDevice(req, reply, row.id);
      deps.audit.append({
        userId: row.id,
        event: "login",
        detail: "password only (2FA disabled)",
        deviceId: dev.deviceId,
        deviceIsNew: dev.isNewDevice,
        ...reqCtx(req),
      });
```

(原 append 无 deviceId/deviceIsNew 两行,补上;块内其他逻辑不动。)

**TOTP 成功点**(`event: "login", detail: "2FA verified"` 的 append):其前置改为在 setCookie 后调用 auditDevice,append 改为:

```ts
    const dev = auditDevice(req, reply, row.id);
    deps.audit.append({
      userId: row.id,
      event: "login",
      detail: "2FA verified",
      deviceId: dev.deviceId,
      deviceIsNew: dev.isNewDevice,
      ...reqCtx(req),
    });
```

**恢复码成功点**(`event: "recovery_code_used"` 的 append,保留 `detail: \`remaining=${remaining}\``):同样插入 `const dev = auditDevice(req, reply, row.id);`,append 加 deviceId/deviceIsNew 两行。

## Step 5: 失败/限流事件带 device_id

凡 `event` 为 `login_failed` / `login_rate_limited` / `totp_failed` / `totp_rate_limited` / `recovery_code_failed` 的 append 调用,在 `...reqCtx(req),` 之前追加一行 `deviceId: readDeviceId(req),`。共 6 处(totp_rate_limited 有两条,其中 recovery 分支的 detail 含 "(recovery)")。`deviceIsNew` 不传。

## Step 6: 运行测试确认通过

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: 全部 suite PASS(含新 3 用例)

## Step 7: 全量 auth 回归

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-routes.test.ts tests/auth.test.ts`
Expected: PASS(helpers.bootstrapAuthedApp 走 2FA 登录路径,新 cookie 不影响 session cookie 查找)

## Step 8: typecheck

Run: `pnpm -r typecheck`
Expected: 全绿
