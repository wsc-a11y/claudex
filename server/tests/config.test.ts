import { describe, it, expect } from "vitest";
import { assertSafeBind } from "../src/lib/config.js";

describe("assertSafeBind", () => {
  it("accepts loopback, wildcard and interface hosts", () => {
    expect(() => assertSafeBind("127.0.0.1")).not.toThrow();
    expect(() => assertSafeBind("::1")).not.toThrow();
    expect(() => assertSafeBind("localhost")).not.toThrow();
    // 0.0.0.0 是当前 Windows + Tailscale 直连部署的默认值;绑哪个网卡是
    // 部署者的决定,这里不再做策略拦截(见 src/lib/config.ts 注释)。
    expect(() => assertSafeBind("0.0.0.0")).not.toThrow();
    expect(() => assertSafeBind("::")).not.toThrow();
    expect(() => assertSafeBind("192.168.1.5")).not.toThrow();
  });

  it("refuses empty or malformed hosts", () => {
    expect(() => assertSafeBind("")).toThrow(/invalid host/i);
    expect(() => assertSafeBind("   ")).toThrow(/invalid host/i);
    expect(() => assertSafeBind("a b")).toThrow(/invalid host/i);
    expect(() => assertSafeBind(null as unknown as string)).toThrow(/invalid host/i);
  });
});
