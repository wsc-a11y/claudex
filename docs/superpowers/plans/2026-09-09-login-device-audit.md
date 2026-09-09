# 登录设备审计(方案 A)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次真实登录(密码/TOTP/恢复码)在 `audit_events` 里记录来源端口与浏览器设备号,首次出现的设备号标为"新设备",并在现有 Audit log 句子中展示。

**Architecture:** 迁移 29 给 `audit_events` 加 `device_id / device_is_new / port` 三列;登录成功时若请求没带 `claudex_device_id` cookie 则签发(非 httpOnly、10 年,浏览器同源自动携带,前端零改动);auth 路由在 append 审计行前用 SQL 查该 user+device 是否曾登录成功来判定新设备;`GET /api/audit` 带出新列;web 只增强 `renderAuditDetail` 三个 case 的句子,不新增界面。

**Tech Stack:** better-sqlite3、Fastify + @fastify/cookie、nanoid、vitest、TypeScript(zod 在 shared)。

**Spec:** `docs/superpowers/specs/2026-09-09-login-audit-device-design.md`(用户已批准)

## Global Constraints

- **非 git 仓库**:本 checkout(`d:\claudex`)没有 git。**没有 commit/push 步骤**,每步的验证=测试/typecheck 通过。
- 数据库迁移只能**追加**(MIGRATIONS 数组尾部,id=29),不许改写历史迁移;执行器在 `server/src/db/index.ts` 的 `openDb`。
- 设备号 cookie **必须 `httpOnly:false`**(匿名标识,非凭据),其余属性复用现有 `cookieOpts` 判定(secure 随 `isRequestSecure`)。
- 只在**登录成功**路径签发/重签设备号;失败与限流事件只读带 cookie(没有就不记 device_id)。
- 新设备判定查询必须含 `event IN ('login','recovery_code_used')`(恢复码成功登录的事件名不是 'login')。
- 不信任任何转发头;来源一律 `req.ip` / `req.socket.remotePort`。
- web 侧:不新增界面,不触碰 secure-context API;文案中文与现有 `renderAuditDetail` 风格一致;端口缺失时优雅降级。
- shared 类型先行:AuditEvent 新字段放 `shared/src/models.ts`,server/web 都从 `@claudex/shared` import。
- 每任务验证命令:`pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`(逐步扩展)与 `pnpm -r typecheck`。

---

### Task 1: 迁移 29(audit_events 加三列)+ schema 测试

**Files:**
- Modify: `server/src/db/index.ts`(MIGRATIONS 数组尾部,id=28 条目之后)
- Test: `tests/auth-device.test.ts`(新建,本任务只放 schema 用例)

**Interfaces:**
- Produces: 数据库 `audit_events` 新列 `device_id TEXT NULL`、`device_is_new INTEGER NOT NULL DEFAULT 0`、`port INTEGER NULL`。后续任务的 INSERT/SELECT 全部依赖这三列。

- [ ] **Step 1: 写失败的迁移测试**

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

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: FAIL(`names.has("device_id")` false)

- [ ] **Step 3: 实现迁移 29**

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

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: PASS

---

### Task 2: shared AuditEvent 新字段 + AuditStore 读写三列

**Files:**
- Modify: `shared/src/models.ts`(AuditEvent zod,当前 1281-1294 行)
- Modify: `server/src/audit/store.ts`
- Test: `server/tests/auth-device.test.ts`(追加 describe)

**Interfaces:**
- Consumes: Task 1 的三列。
- Produces:
  - `AuditEvent`(shared):新增 `deviceId: z.string().nullable()`、`deviceIsNew: z.boolean()`、`port: z.number().int().nullable()`。
  - `AuditStore.append(input: AuditAppendInput)`:`AuditAppendInput` 新增可选 `deviceId?: string | null`、`deviceIsNew?: boolean`、`port?: number | null`(缺省分别 null/0/null)。
  - `AuditStore.list()` 返回的 `AuditRow` 新增 `deviceId: string | null`、`deviceIsNew: boolean`、`port: number | null`。Task 4 的 /api/audit 直接消费这些字段。

- [ ] **Step 1: 写失败的 store 测试**

在 `server/tests/auth-device.test.ts` 追加:

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

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: 类型/断言失败(rows[0].deviceId undefined)

- [ ] **Step 3: shared models 增加字段**

`shared/src/models.ts` AuditEvent(z 对象)加三行(保持注释风格,插在 `userAgent` 与 `createdAt` 之间或 `user` 之前均可,保持语义注释):

```ts
  // 登录设备审计(2026-09):deviceId = 浏览器设备号 claudex_device_id;
  // deviceIsNew = 该设备号对该用户首次登录成功(仅成功事件为 true);
  // port = TCP 源端口。旧行 deviceId/port 为 null,deviceIsNew 为 false。
  deviceId: z.string().nullable(),
  deviceIsNew: z.boolean(),
  port: z.number().int().nullable(),
```

- [ ] **Step 4: AuditStore 扩展**

`server/src/audit/store.ts`:
1. `AuditRow` interface 追加 `deviceId: string | null; deviceIsNew: boolean; port: number | null;`
2. `DbRow` interface 追加 `device_id: string | null; device_is_new: number; port: number | null;`
3. `toRow` 追加映射:`deviceId: r.device_id, deviceIsNew: r.device_is_new === 1, port: r.port,`
4. `AuditAppendInput` 追加可选字段:`deviceId?: string | null; deviceIsNew?: boolean; port?: number | null;`
5. `append()` 的 row 对象与 INSERT 语句扩展:

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

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: PASS(两 suite 全绿)

---

### Task 3: auth 路由 — 设备号 cookie 与审计行携带 device_id / is_new / port

**Files:**
- Modify: `server/src/auth/routes.ts`
- Test: `server/tests/auth-device.test.ts`(追加 describe)

**Interfaces:**
- Consumes: Task 1 列、Task 2 `AuditAppendInput` 新字段。
- Produces(均在 `registerAuthRoutes` 内新增/扩展):
  - `DEVICE_COOKIE = "claudex_device_id"`(模块级常量,放 `ACCESS_COOKIE_NAME` 附近——`ACCESS_COOKIE_NAME` 从 `./index.js` 导入,DEVICE_COOKIE 定义在本文件即可)
  - `readDeviceId(req): string | null` — 从 `req.cookies?.[DEVICE_COOKIE]` 读
  - `deviceCookieOpts(req)` — `{ ...cookieOpts(req), httpOnly: false, maxAge: 60*60*24*365*10 }`
  - `deviceIsNew(db, userId, deviceId): boolean` — SQL 查库
  - `reqCtx` 返回值追加 `port`(所有带 `...reqCtx(req)` 的审计行自动获得 port,无需改每个落点)

- [ ] **Step 1: 写失败的登录行为测试**

在 `server/tests/auth-device.test.ts` 追加(测试内 2FA-off 用户用 `totpEnabled: false` 构造,走 login 一步成功路径):

```ts
import { buildApp } from "../src/transport/app.js";
import { generateTotpSecret, hashPassword, UserStore } from "../src/auth/index.js";
import { loadOrCreateJwtSecret } from "../src/auth/index.js";

describe("login device audit", () => {
  async function bootTotpOff() {
    const { config, log, cleanup } = tempConfig();
    const dbh = openDb(config, log);
    const jwtSecret = loadOrCreateJwtSecret(config);
    const { app } = await buildApp({ db: dbh.db, jwtSecret, logger: false, isProduction: false });
    const users = new UserStore(dbh.db);
    await users.create({
      username: "no2fa",
      passwordHash: await hashPassword("pw-pw-pw-pw"),
      totpSecret: "", // empty + default totpEnabled=false
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

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: FAIL(无 claudex_device_id cookie、审计行 device_id 为 null)

- [ ] **Step 3: 模块级常量与 helper**

`server/src/auth/routes.ts`,在 import 块之后(`import { getRequestCtx } from "../lib/req.js";` 后)与 `isRequestSecure` 定义之间插入:

```ts
import { nanoid } from "nanoid"; // 加到顶部 import(现有 import 无 nanoid)
```

`reqCtx` helper(registerAuthRoutes 内,现 120-123 行)改为追加 port:

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

`cookieOpts` 之后新增(模块级):

```ts
// 登录设备审计(2026-09):浏览器匿名设备号。非 httpOnly——它是标识不是
// 凭据,前端无需读取;浏览器对同源登录请求自动携带,前端零改动。
// 删除/更换 cookie = 新设备,下次登录会以"新设备"醒目记录。
const DEVICE_COOKIE = "claudex_device_id";
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10; // 10 年

function deviceCookieOpts(req: FastifyRequest) {
  return { ...cookieOpts(req), httpOnly: false, maxAge: DEVICE_COOKIE_MAX_AGE };
}

function readDeviceId(req: FastifyRequest): string | null {
  const v = req.cookies?.[DEVICE_COOKIE];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// 该 user+device 组合此前是否登录成功过(login 与 recovery_code_used 都是
// 成功事件)。无历史 = 新设备。
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

`registerAuthRoutes` 内、登录路由前插入一次性的"确保发号"逻辑做不成 helper(需 reply),改为在三个成功点内联小段(见 Step 4-6)。为避免三处重复,新增闭包 helper:

```ts
  // 登录成功共用:返回本次审计要记录的 deviceId + isNewDevice,并负责首次
  // 发号。判断"见过"必须在 append login 行之前查库,否则首次永远是 false。
  const auditDevice = (
    req: FastifyRequest,
    reply: FastifyReply,
    userId: string,
  ): { deviceId: string | null; isNewDevice: boolean } => {
    let deviceId = readDeviceId(req);
    let isNewDevice = false;
    if (!deviceId) {
      deviceId = nanoid(16);
      isNewDevice = true; // 全新 cookie → 必定新设备,免一次查询
      reply.setCookie(DEVICE_COOKIE, deviceId, deviceCookieOpts(req));
    } else {
      isNewDevice = deviceIsNew(deps.db, userId, deviceId);
    }
    return { deviceId, isNewDevice };
  };
```

- [ ] **Step 4: 三个成功点接上发号与审计字段**

**2FA-off 成功点**(现 191-205 行,锚文本 `if (!row.totp_enabled) {` 块内,`deps.audit.append({...})` 之前插入发号):

```ts
    if (!row.totp_enabled) {
      const token = await signAccessToken(deps.jwtSecret, row.id);
      reply.setCookie(ACCESS_COOKIE_NAME, token, {
        ...cookieOpts(req),
        maxAge: 60 * 60 * 24 * 30,
      });
      const dev = auditDevice(req, reply, row.id);
      deps.audit.append({
        userId: row.id,
        event: "login",
        detail: "password only (2FA disabled)",
        deviceId: dev.deviceId,
        deviceIsNew: dev.isNewDevice,
        ...reqCtx(req),
      });
      const body: LoginResponse = { requireTotp: false, challengeId: null };
      return reply.send(body);
    }
```

**TOTP 成功点**(现 265-277 行,`deps.audit.append({ userId: row.id, event: "login", ...})` 处):

```ts
    const token = await signAccessToken(deps.jwtSecret, row.id);
    reply.setCookie(ACCESS_COOKIE_NAME, token, {
      ...cookieOpts(req),
      maxAge: 60 * 60 * 24 * 30,
    });
    // Audit: successful login lands here; the bcrypt/TOTP pair both cleared.
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

**恢复码成功点**(现 336-346 行,`event: "recovery_code_used"` 处;保留 `detail: remaining`):

```ts
    const remaining = users.countRemainingRecoveryCodes(row.id);
    const dev = auditDevice(req, reply, row.id);
    deps.audit.append({
      userId: row.id,
      event: "recovery_code_used",
      detail: `remaining=${remaining}`,
      deviceId: dev.deviceId,
      deviceIsNew: dev.isNewDevice,
      ...reqCtx(req),
    });
```

- [ ] **Step 5: 失败/限流事件带 device_id**

凡 `event` 为 `login_failed` / `login_rate_limited` / `totp_failed` / `totp_rate_limited` / `recovery_code_failed` 的 append 调用,追加一行 `deviceId: readDeviceId(req),`(紧挨 `...reqCtx(req),` 之前)。共 6 处(routes.ts 152/175/226/254/301/325 附近;恢复码限流那条 detail 含 "(recovery)" 也在内)。`deviceIsNew` 不传(恒 false)。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: PASS(5 suite 全绿,含 Task 1/2)

- [ ] **Step 7: 全量 auth 回归(helpers.bootstrapAuthedApp 走 2FA 登录,不应被新 cookie 影响)**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-routes.test.ts tests/auth.test.ts`
Expected: PASS

---

### Task 4: GET /api/audit 带出新字段

**Files:**
- Modify: `server/src/audit/routes.ts`(map 输出,现 77-86 行)
- Test: `server/tests/auth-device.test.ts`(追加 describe)

**Interfaces:**
- Consumes: Task 2 `AuditRow.deviceId / deviceIsNew / port`、shared `AuditEvent` 三新字段。
- Produces: `GET /api/audit` 响应中每行含 `deviceId: string|null / deviceIsNew: boolean / port: number|null`。Task 5 的 web 渲染消费这些字段。

- [ ] **Step 1: 写失败测试**

在 `server/tests/auth-device.test.ts` 追加(复用 Task 3 的 2FA-off boot 或直接走 helpers 的完整登录;此处直接造行 + 一次登录后 GET):

```ts
describe("GET /api/audit device fields", () => {
  it("returns deviceId / deviceIsNew / port on login rows", async () => {
    const { config, log, cleanup } = tempConfig();
    const dbh = openDb(config, log);
    const jwtSecret = loadOrCreateJwtSecret(config);
    const { app } = await buildApp({ db: dbh.db, jwtSecret, logger: false, isProduction: false });
    try {
      const users = new UserStore(dbh.db);
      await users.create({
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

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: FAIL(deviceId undefined)

- [ ] **Step 3: audit 路由 map 扩展**

`server/src/audit/routes.ts` 的 out map(现 77-86 行)追加三行:

```ts
        deviceId: r.deviceId,
        deviceIsNew: r.deviceIsNew,
        port: r.port,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @claudex/server exec vitest run tests/auth-device.test.ts`
Expected: PASS

- [ ] **Step 5: 旧行兼容回归(旧行三列为 NULL,API 不炸)**

Run: `pnpm --filter @claudex/server exec vitest run tests/audit-routes.test.ts`
Expected: PASS(该套件断言的行多为旧结构;响应字段新增不破坏其断言——若某断言逐字匹配对象则需更新,按报错修)

---

### Task 5: web — renderAuditDetail 登录句子增强

**Files:**
- Modify: `web/src/screens/Settings.tsx`(`renderAuditDetail`,现 1671-1711 行)

**Interfaces:**
- Consumes: Task 4 的响应字段(`row.deviceId / row.deviceIsNew / row.port`,类型来自 shared AuditEvent)。
- Produces: 人类可读句子含来源 IP:端口 与"新设备"标记。

- [ ] **Step 1: 改 login / login_failed / totp_failed 三个 case**

`web/src/screens/Settings.tsx` `renderAuditDetail`,把三个 case 替换为:

```ts
  // IP 与源端口拼成 "1.2.3.4:54321";缺 IP 时返回 null,由调用方降级
  const addrText = (row: AuditEvent) =>
    row.ip ? `${row.ip}${row.port != null ? `:${row.port}` : ""}` : null;
  switch (row.event) {
    case "login": {
      const parts = [`来自 ${uaLabel(row.userAgent)} 的登录已通过双重验证`];
      const addr = addrText(row);
      if (addr) parts.push(`来源 ${addr}`);
      if (row.deviceIsNew) parts.push("新设备");
      return parts.join(" · ");
    }
    case "login_failed":
      return `登录失败尝试,来源 ${addrText(row) ?? "未知 IP"}`;
```

`totp_failed` case 同理:`return \`双重验证码错误,来源 ${addrText(row) ?? "未知 IP"}\`;`(替换原 `row.ip ?? "未知 IP"`)。

- [ ] **Step 2: typecheck**

Run: `pnpm -r typecheck`
Expected: 全绿(web 若无类型错误)

- [ ] **Step 3: 人工验收清单(记录在交付说明里,不自动执行)**

1. 手机/电脑任一浏览器首次登录 → 设置→安全→Audit log 顶部应出现:"来自 {浏览器} 的登录已通过双重验证 · 来源 100.x.x.x:端口 · 新设备"
2. 同浏览器再登一次 → 新行无"新设备"字样
3. 换浏览器/隐身窗口登录 → 新行带"新设备"
4. 输错密码 → "登录失败尝试,来源 IP:端口"

---

### Task 6: FEATURES.md 更新 + 全量回归

**Files:**
- Modify: `docs/FEATURES.md`

- [ ] **Step 1: 更新 FEATURES.md**

Run: `grep -n "audit" docs/FEATURES.md | head -20` 定位 Security/Audit 相关行(约 353-354 行区域,描述 `audit_events` 表结构的那条)。在其后补一句登录审计增强描述,沿用现有 ✅/表格风格,示例:

```markdown
| ✅ | 登录审计含来源端口与设备号 | 迁移 29:`audit_events` 加 `device_id`(claudex_device_id cookie)/`device_is_new`(新设备标记)/`port`(源端口);成功登录发号并判定新设备,失败与限流事件带 device_id;Audit log 句子显示 IP:端口与新设备标记 |
```

(若该区是段落式而非表格,则用同风格的句子追加到 audit_events 描述段落。)

- [ ] **Step 2: 全量回归**

Run: `pnpm -r typecheck`
Expected: 全绿

Run: `pnpm --filter @claudex/server test`
Expected: 除本机既有的 5 个 Windows 环境类失败(pty/worktree/resolveSlugToPath)外全绿;本次新增的 auth-device suite 全过。

- [ ] **Step 3: 交付说明**

向用户报告:改动文件清单、新增测试数、部署动作 = 重启服务(dev-manager → 重启服务;若产物未过期会秒开);提醒用户首次登录验证"新设备"标记与 Audit log 句子。

---

## Self-Review 记录

**1. Spec 覆盖检查:**
- 设备号 cookie 签发/读取/10 年/非 httpOnly → Task 3 ✓
- 迁移三列 → Task 1 ✓;shared AuditEvent 三字段 → Task 2 ✓
- 成功 3 点(login-2fa-off/TOTP/恢复码)发号 + isNewDevice 判定 → Task 3 Step 4 ✓(判定 SQL 含 recovery_code_used,spec 修正已同步)
- 失败/限流 6 点带 device_id → Task 3 Step 5 ✓
- port 进所有 reqCtx 审计行 → Task 3 Step 3(reqCtx 扩展)✓
- GET /api/audit 带出 → Task 4 ✓
- UI 只增强 renderAuditDetail 三个 case → Task 5 ✓
- 不新增界面/不提醒/不防伪 → 无对应任务,Global Constraints 与 spec 非目标一致 ✓
- FEATURES.md → Task 6 ✓

**2. 占位符扫描:** 无 TBD/待补;每个实现步含完整代码。Task 5 的 totp_failed 用文字描述了与 login_failed 相同的替换(简短、无歧义)。Task 6 FEATURES 行位置靠 grep 定位(文档行号会漂移,给出两种格式的适配说明)。

**3. 类型一致性:**
- `deviceIsNew` 在 shared/API/store 均为 boolean,DB 为 0/1;UI 判 `row.deviceIsNew` 直接为 true(API 恒发 boolean)→ 一致 ✓
- `AuditAppendInput.deviceId` 可选;失败点只传 deviceId 不传 deviceIsNew(默认 false)→ 与 Task 2 Step 4 缺省逻辑一致 ✓
- `readDeviceId/deviceCookieOpts/deviceIsNew/auditDevice` 在 Task 3 定义并只在本文件使用 ✓
- store `list()` SELECT * → 自动带新列 ✓
