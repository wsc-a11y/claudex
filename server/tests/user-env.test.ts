import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapAuthedApp } from "./helpers.js";
import { readUserEnv } from "../src/sessions/user-env.js";

describe("GET /api/user/env", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  function mkTmpDir(prefix: string, cleanup: Array<() => Promise<void>>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanup.push(async () =>
      fs.rmSync(dir, { recursive: true, force: true }),
    );
    return dir;
  }

  it("401s when not logged in", async () => {
    const home = mkTmpDir("claudex-userenv-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/user/env",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns user + empty plugin list when ~/.claude is empty", async () => {
    const home = mkTmpDir("claudex-userenv-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/user/env",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.username).toBe("hao");
    expect(body.settingsReadable).toBe(false);
    expect(body.plugins).toEqual([]);
    expect(body.claudeDir).toBe(path.join(home, ".claude"));
  });

  it("merges enabledPlugins and installed_plugins.json into a plugin list", async () => {
    const home = mkTmpDir("claudex-userenv-home-", disposers);
    const claudeDir = path.join(home, ".claude");
    const pluginsDir = path.join(claudeDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });

    // settings.json with one enabled plugin + one enabled-but-uninstalled key.
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        enabledPlugins: {
          "alpha@mk": true,
          "ghost@mk": true,
        },
      }),
    );
    // installed_plugins.json with alpha (matching enabledPlugins) + beta
    // (installed but not enabled).
    fs.writeFileSync(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "alpha@mk": [
            {
              installPath: "/tmp/ci/alpha",
              version: "1.2.3",
              installedAt: "2026-01-01T00:00:00Z",
            },
          ],
          "beta@mk": [
            {
              installPath: "/tmp/ci/beta",
              version: "0.1.0",
              installedAt: "2026-02-01T00:00:00Z",
            },
          ],
        },
      }),
    );

    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: claudeDir,
    });
    disposers.push(ctx.cleanup);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/user/env",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settingsReadable).toBe(true);

    // Sorted by key. Alpha (enabled + installed), beta (installed, not
    // enabled), ghost (enabled, not installed).
    const byKey = Object.fromEntries(
      body.plugins.map((p: any) => [p.key, p]),
    );
    expect(byKey["alpha@mk"]).toMatchObject({
      name: "alpha",
      marketplace: "mk",
      enabled: true,
      installPath: "/tmp/ci/alpha",
      version: "1.2.3",
    });
    expect(byKey["beta@mk"]).toMatchObject({
      name: "beta",
      marketplace: "mk",
      enabled: false,
      installPath: "/tmp/ci/beta",
    });
    expect(byKey["ghost@mk"]).toMatchObject({
      name: "ghost",
      enabled: true,
      installPath: null,
      version: null,
    });
  });

  it("readUserEnv degrades gracefully when installed_plugins.json is malformed", async () => {
    const home = mkTmpDir("claudex-userenv-home-", disposers);
    const claudeDir = path.join(home, ".claude");
    const pluginsDir = path.join(claudeDir, "plugins");
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, "installed_plugins.json"),
      "{not valid json",
    );
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "only@enabled": true } }),
    );

    const env = await readUserEnv({ userClaudeDir: claudeDir });
    expect(env.settingsReadable).toBe(true);
    // Only the enabled-key survives; malformed install file is swallowed.
    expect(env.plugins.map((p) => p.key)).toEqual(["only@enabled"]);
    expect(env.plugins[0].installPath).toBeNull();
  });
});
