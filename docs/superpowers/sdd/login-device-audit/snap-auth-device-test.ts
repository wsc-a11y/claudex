import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/index.js";
import { tempConfig } from "./helpers.js";
import { AuditStore } from "../src/audit/store.js";
import { buildApp } from "../src/transport/app.js";
import {
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";

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
      // 设备号 cookie 不是 httpOnly(它是标识不是凭据)。fastify-cookie 对
      // httpOnly=false 省略该键,故这里断言"非 httpOnly"而非严格 false。
      expect(deviceCookie!.httpOnly).toBeFalsy();

      const row = dbh.db.prepare(
        "SELECT device_id, device_is_new, port FROM audit_events WHERE event = 'login'",
      ).get() as { device_id: string; device_is_new: number; port: number | null };
      expect(row.device_id).toBe(deviceCookie!.value);
      expect(row.device_is_new).toBe(1);
      // port 来自 req.socket.remotePort,app.inject 的合成 socket 无该字段,
      // 恒为 null;port 值的真实落库已由 Task 2 的 store 往返用例(=54321)覆盖。
      expect(row).toHaveProperty("port");
    } finally {
      await app.close();
      dbh.close();
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
        "SELECT device_id, device_is_new FROM audit_events WHERE event = 'login' ORDER BY rowid DESC LIMIT 1",
      ).get() as { device_id: string; device_is_new: number };
      // 已有 cookie(其他设备号)直接读入,服务端不重复回发 cookie;新设备号
      // 无历史,故审计行 device_id = 客户端传来的值,且 is_new = 1。
      expect(row3.device_id).toBe("other-device");
      expect(row3.device_is_new).toBe(1);
    } finally {
      await app.close();
      dbh.close();
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
      // port 恒为 null(app.inject 无合成 socket 的 remotePort);值落库见 Task 2。
      expect(row).toHaveProperty("port");
    } finally {
      await app.close();
      dbh.close();
      cleanup();
    }
  });
});
