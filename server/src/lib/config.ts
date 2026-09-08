import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface Config {
  host: string;
  port: number;
  stateDir: string; // ~/.claudex
  dbPath: string; // ~/.claudex/claudex.db
  logDir: string; // ~/.claudex/logs
  jwtSecretPath: string; // ~/.claudex/jwt.secret
  nodeEnv: "development" | "production";
}

function resolveStateDir(): string {
  const override = process.env.CLAUDEX_STATE_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".claudex");
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  const stateDir = resolveStateDir();
  ensureDir(stateDir);
  const logDir = path.join(stateDir, "logs");
  ensureDir(logDir);

  const nodeEnv =
    process.env.NODE_ENV === "production" ? "production" : "development";

  return {
    // 默认绑所有网卡:本机(Windows + Tailscale 直连)部署下手机经 Tailscale
    // 直连 5179。若走 frpc / 隧道前置,设 CLAUDEX_HOST=127.0.0.1 收紧回环。
    host: process.env.CLAUDEX_HOST ?? "0.0.0.0",
    port: Number(process.env.CLAUDEX_PORT ?? 5179),
    stateDir,
    dbPath: path.join(stateDir, "claudex.db"),
    logDir,
    jwtSecretPath: path.join(stateDir, "jwt.secret"),
    nodeEnv,
  };
}

// Bind-host sanity check (not a policy wall). 历史上 claudex 只允许绑回环
// (Mac + frpc 前置);本机 Windows + Tailscale 直连部署改为默认 0.0.0.0,
// 绑什么网卡是部署者的决定(见 CLAUDE.md),这里只拦空值/垃圾输入。
export function assertSafeBind(host: string): void {
  const h = (host ?? "").trim();
  if (!h || /[\s,]/.test(h)) {
    throw new Error(
      `Refusing to bind to invalid host: "${host}". ` +
        `Set CLAUDEX_HOST to an interface address (e.g. 0.0.0.0) or loopback (127.0.0.1).`,
    );
  }
}
