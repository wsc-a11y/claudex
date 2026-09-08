import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractDescription,
  listSlashCommands,
  scanPluginCommands,
  BUILT_IN_SLASH_COMMANDS,
} from "../src/sessions/slash-commands.js";
import { bootstrapAuthedApp } from "./helpers.js";

describe("slash-commands scanner", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    disposers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  describe("BUILT_IN_SLASH_COMMANDS behavior triage", () => {
    // Guardrail for the table in slash-commands.ts: every built-in must
    // declare a behavior, and the load-bearing categorizations — the ones
    // the UI keys off — must match what we shipped.
    it("every built-in carries a behavior", () => {
      for (const c of BUILT_IN_SLASH_COMMANDS) {
        expect(c.behavior, `behavior missing for /${c.name}`).toBeDefined();
        expect(
          ["native", "claudex-action", "unsupported"].includes(c.behavior.kind),
        ).toBe(true);
      }
    });

    it("categorizes REPL-only commands as unsupported", () => {
      const replOnly = [
        "add-dir",
        "bug",
        "continue",
        "doctor",
        "init",
        "login",
        "logout",
        "resume",
      ];
      for (const name of replOnly) {
        const c = BUILT_IN_SLASH_COMMANDS.find((x) => x.name === name);
        expect(c, `/${name} missing from built-ins`).toBeDefined();
        expect(c!.behavior.kind).toBe("unsupported");
        if (c!.behavior.kind === "unsupported") {
          expect(c!.behavior.reason.length).toBeGreaterThan(0);
        }
      }
    });

    it("maps UI-backed commands to the right claudex-action", () => {
      const expected: Record<string, string> = {
        model: "open-model-picker",
        config: "open-session-settings",
        status: "open-session-settings",
        cost: "open-usage",
        mcp: "open-plugins-settings",
        plugin: "open-plugins-settings",
        help: "open-slash-help",
        clear: "clear-transcript",
      };
      for (const [name, action] of Object.entries(expected)) {
        const c = BUILT_IN_SLASH_COMMANDS.find((x) => x.name === name);
        expect(c, `/${name} missing from built-ins`).toBeDefined();
        expect(c!.behavior.kind).toBe("claudex-action");
        if (c!.behavior.kind === "claudex-action") {
          expect(c!.behavior.action).toBe(action);
        }
      }
    });

    it("flags /compact as native (SDK forwards it end-to-end)", () => {
      const c = BUILT_IN_SLASH_COMMANDS.find((x) => x.name === "compact");
      expect(c).toBeDefined();
      expect(c!.behavior.kind).toBe("native");
    });

    it("listSlashCommands propagates behavior onto the response", async () => {
      const home = mkTmp("claudex-slash-home-");
      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
      });
      const model = out.find((c) => c.name === "model");
      expect(model).toBeDefined();
      expect(model!.behavior.kind).toBe("claudex-action");
      const login = out.find((c) => c.name === "login");
      expect(login!.behavior.kind).toBe("unsupported");
    });
  });

  describe("extractDescription", () => {
    it("prefers YAML frontmatter description", () => {
      const raw = [
        "---",
        "name: foo",
        "description: Does the foo thing",
        "---",
        "",
        "# Heading shouldn't win",
        "body",
      ].join("\n");
      expect(extractDescription(raw)).toBe("Does the foo thing");
    });

    it("strips surrounding quotes on the frontmatter value", () => {
      const raw = ["---", 'description: "Quoted thing"', "---"].join("\n");
      expect(extractDescription(raw)).toBe("Quoted thing");
    });

    it("falls back to a leading `# Heading` line", () => {
      const raw = "# Review the current diff\n\nsome body";
      expect(extractDescription(raw)).toBe("Review the current diff");
    });

    it("falls back to the first non-empty line", () => {
      const raw = "\n\nJust a prose description.\nMore body.\n";
      expect(extractDescription(raw)).toBe("Just a prose description.");
    });

    it("returns null when the file is empty", () => {
      expect(extractDescription("")).toBeNull();
      expect(extractDescription("\n\n  \n")).toBeNull();
    });
  });

  describe("listSlashCommands", () => {
    it("returns only built-ins when the user commands dir is absent", async () => {
      const home = mkTmp("claudex-slash-home-");
      // intentionally do NOT create home/.claude/commands
      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
      });
      expect(out).toHaveLength(BUILT_IN_SLASH_COMMANDS.length);
      expect(out.every((c) => c.kind === "built-in")).toBe(true);
      // Spot-check: the most common commands are present.
      const names = out.map((c) => c.name);
      expect(names).toContain("help");
      expect(names).toContain("clear");
      expect(names).toContain("compact");
      expect(names).toContain("review");
    });

    it("scans user commands and parses frontmatter + heading descriptions", async () => {
      const home = mkTmp("claudex-slash-home-");
      const cmdsDir = path.join(home, ".claude", "commands");
      fs.mkdirSync(cmdsDir, { recursive: true });
      fs.writeFileSync(
        path.join(cmdsDir, "deploy.md"),
        ["---", "description: Deploy the app", "---", "body"].join("\n"),
      );
      fs.writeFileSync(
        path.join(cmdsDir, "refactor.md"),
        "# Refactor this module\n\nBody.\n",
      );
      fs.writeFileSync(
        path.join(cmdsDir, "zzz-blank.md"),
        "", // no description at all
      );
      // Skips: hidden, non-md, subdirectory.
      fs.writeFileSync(path.join(cmdsDir, ".hidden.md"), "# nope");
      fs.writeFileSync(path.join(cmdsDir, "notes.txt"), "not a command");
      fs.mkdirSync(path.join(cmdsDir, "nested"));

      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
      });
      const userCmds = out.filter((c) => c.kind === "user");
      expect(userCmds.map((c) => c.name)).toEqual([
        "deploy",
        "refactor",
        "zzz-blank",
      ]);
      const deploy = userCmds.find((c) => c.name === "deploy")!;
      expect(deploy.description).toBe("Deploy the app");
      expect(deploy.source).toBe(path.join(cmdsDir, "deploy.md"));
      expect(deploy.behavior.kind).toBe("native");
      const refactor = userCmds.find((c) => c.name === "refactor")!;
      expect(refactor.description).toBe("Refactor this module");
      const blank = userCmds.find((c) => c.name === "zzz-blank")!;
      expect(blank.description).toBeNull();
    });

    it("includes project commands when projectPath is given", async () => {
      const home = mkTmp("claudex-slash-home-");
      const projRoot = mkTmp("claudex-slash-proj-");
      const projCmds = path.join(projRoot, ".claude", "commands");
      fs.mkdirSync(projCmds, { recursive: true });
      fs.writeFileSync(
        path.join(projCmds, "bench.md"),
        "# Run benchmarks\n",
      );

      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
        projectPath: projRoot,
      });
      const projOut = out.filter((c) => c.kind === "project");
      expect(projOut).toHaveLength(1);
      expect(projOut[0].name).toBe("bench");
      expect(projOut[0].description).toBe("Run benchmarks");
      expect(projOut[0].source).toBe(path.join(projCmds, "bench.md"));

      // Bucket order: built-in first, then project (no user cmds here).
      const firstProjectIdx = out.findIndex((c) => c.kind === "project");
      const lastBuiltinIdx = out.reduce(
        (acc, c, i) => (c.kind === "built-in" ? i : acc),
        -1,
      );
      expect(firstProjectIdx).toBeGreaterThan(lastBuiltinIdx);
    });

    it("omits project commands when projectPath is not given", async () => {
      const home = mkTmp("claudex-slash-home-");
      const projRoot = mkTmp("claudex-slash-proj-");
      const projCmds = path.join(projRoot, ".claude", "commands");
      fs.mkdirSync(projCmds, { recursive: true });
      fs.writeFileSync(path.join(projCmds, "bench.md"), "# Run benches\n");

      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
      });
      expect(out.some((c) => c.kind === "project")).toBe(false);
    });
  });

  describe("scanPluginCommands", () => {
    it("returns [] when installed_plugins.json is absent", async () => {
      const home = mkTmp("claudex-slash-home-");
      // No plugins/ dir at all.
      const out = await scanPluginCommands(path.join(home, ".claude"));
      expect(out).toEqual([]);
    });

    it("returns [] when installed_plugins.json is malformed", async () => {
      const home = mkTmp("claudex-slash-home-");
      const pluginsDir = path.join(home, ".claude", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginsDir, "installed_plugins.json"),
        "{not valid json",
      );
      const out = await scanPluginCommands(path.join(home, ".claude"));
      expect(out).toEqual([]);
    });

    it("scans commands for each installed plugin via installPath", async () => {
      const home = mkTmp("claudex-slash-home-");
      const pluginsDir = path.join(home, ".claude", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });

      // Build two fake plugin installs off a cache/-style layout.
      const installA = path.join(
        pluginsDir,
        "cache",
        "mk-a",
        "alpha",
        "v1",
      );
      fs.mkdirSync(path.join(installA, "commands"), { recursive: true });
      fs.writeFileSync(
        path.join(installA, "commands", "alpha-cmd.md"),
        ["---", "description: Alpha does things", "---"].join("\n"),
      );

      const installB = path.join(
        pluginsDir,
        "cache",
        "mk-b",
        "beta",
        "v1",
      );
      fs.mkdirSync(path.join(installB, "commands"), { recursive: true });
      fs.writeFileSync(
        path.join(installB, "commands", "beta-cmd.md"),
        "# Beta makes it go\n",
      );

      fs.writeFileSync(
        path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "alpha@mk-a": [
              {
                scope: "user",
                installPath: installA,
                version: "v1",
                installedAt: "2026-01-01T00:00:00Z",
              },
            ],
            "beta@mk-b": [
              {
                scope: "user",
                installPath: installB,
                version: "v1",
                installedAt: "2026-02-01T00:00:00Z",
              },
            ],
          },
        }),
      );

      const out = await scanPluginCommands(path.join(home, ".claude"));
      const names = out.map((c) => c.name);
      expect(names).toEqual(["alpha-cmd", "beta-cmd"]);
      const alpha = out.find((c) => c.name === "alpha-cmd")!;
      expect(alpha.kind).toBe("plugin");
      expect(alpha.description).toBe("Alpha does things");
      expect(alpha.source).toBe(
        path.join(installA, "commands", "alpha-cmd.md"),
      );
    });

    it("de-duplicates across multiple installed versions, picking the newest by lastUpdated", async () => {
      const home = mkTmp("claudex-slash-home-");
      const pluginsDir = path.join(home, ".claude", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });

      const installV1 = path.join(
        pluginsDir,
        "cache",
        "mk",
        "plug",
        "v1",
      );
      const installV2 = path.join(
        pluginsDir,
        "cache",
        "mk",
        "plug",
        "v2",
      );
      fs.mkdirSync(path.join(installV1, "commands"), { recursive: true });
      fs.mkdirSync(path.join(installV2, "commands"), { recursive: true });
      fs.writeFileSync(
        path.join(installV1, "commands", "plug-cmd.md"),
        ["---", "description: v1 description", "---"].join("\n"),
      );
      fs.writeFileSync(
        path.join(installV2, "commands", "plug-cmd.md"),
        ["---", "description: v2 description", "---"].join("\n"),
      );

      fs.writeFileSync(
        path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "plug@mk": [
              {
                installPath: installV1,
                installedAt: "2026-01-01T00:00:00Z",
                lastUpdated: "2026-01-01T00:00:00Z",
              },
              {
                installPath: installV2,
                installedAt: "2026-01-15T00:00:00Z",
                lastUpdated: "2026-04-01T00:00:00Z",
              },
            ],
          },
        }),
      );

      const out = await scanPluginCommands(path.join(home, ".claude"));
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe("plug-cmd");
      expect(out[0].description).toBe("v2 description");
      expect(out[0].source).toBe(
        path.join(installV2, "commands", "plug-cmd.md"),
      );
    });

    it("listSlashCommands merges plugin entries into the full list", async () => {
      const home = mkTmp("claudex-slash-home-");
      const pluginsDir = path.join(home, ".claude", "plugins");
      fs.mkdirSync(pluginsDir, { recursive: true });
      const install = path.join(pluginsDir, "cache", "mk", "plug", "v1");
      fs.mkdirSync(path.join(install, "commands"), { recursive: true });
      fs.writeFileSync(
        path.join(install, "commands", "plug-cmd.md"),
        "# Plug it in\n",
      );
      fs.writeFileSync(
        path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "plug@mk": [{ installPath: install }],
          },
        }),
      );

      const out = await listSlashCommands({
        userClaudeDir: path.join(home, ".claude"),
      });
      const plugin = out.filter((c) => c.kind === "plugin");
      expect(plugin).toHaveLength(1);
      expect(plugin[0].name).toBe("plug-cmd");
      // Bucket order: built-in first, then user (none), then project (none),
      // then plugin.
      const firstPluginIdx = out.findIndex((c) => c.kind === "plugin");
      const lastBuiltinIdx = out.reduce(
        (acc, c, i) => (c.kind === "built-in" ? i : acc),
        -1,
      );
      expect(firstPluginIdx).toBeGreaterThan(lastBuiltinIdx);
    });
  });
});

describe("GET /api/slash-commands", () => {
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

  it("requires auth", async () => {
    // Point userClaudeDir at an empty tmp so the production ~/.claude isn't
    // read even if the auth gate regresses.
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/slash-commands",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns built-ins only when the user commands dir is absent", async () => {
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/slash-commands",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commands: Array<{ kind: string }> };
    expect(body.commands.length).toBe(BUILT_IN_SLASH_COMMANDS.length);
    expect(body.commands.every((c) => c.kind === "built-in")).toBe(true);
  });

  it("returns user commands when the commands dir has .md files", async () => {
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const cmdsDir = path.join(home, ".claude", "commands");
    fs.mkdirSync(cmdsDir, { recursive: true });
    fs.writeFileSync(
      path.join(cmdsDir, "ship.md"),
      ["---", "description: Ship it", "---"].join("\n"),
    );

    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/slash-commands",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      commands: Array<{ name: string; kind: string; description: string | null }>;
    };
    const ship = body.commands.find((c) => c.name === "ship");
    expect(ship).toBeDefined();
    expect(ship!.kind).toBe("user");
    expect(ship!.description).toBe("Ship it");
  });

  it("includes project commands when projectId is given", async () => {
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);

    // The tmpDir that bootstrap gives us is a fine project root.
    const projCmds = path.join(ctx.tmpDir, ".claude", "commands");
    fs.mkdirSync(projCmds, { recursive: true });
    fs.writeFileSync(path.join(projCmds, "bench.md"), "# Run benchmarks\n");

    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "proj", path: ctx.tmpDir },
    });
    expect(createRes.statusCode).toBe(200);
    const projId = createRes.json().project.id as string;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/slash-commands?projectId=${encodeURIComponent(projId)}`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      commands: Array<{ name: string; kind: string }>;
    };
    const bench = body.commands.find((c) => c.name === "bench");
    expect(bench).toBeDefined();
    expect(bench!.kind).toBe("project");
  });

  it("soft-ignores an unknown projectId — still returns built-ins", async () => {
    const home = mkTmpDir("claudex-slash-home-", disposers);
    const ctx = await bootstrapAuthedApp(undefined, {
      userClaudeDir: path.join(home, ".claude"),
    });
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/slash-commands?projectId=does-not-exist",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commands: Array<{ kind: string }> };
    expect(body.commands.length).toBe(BUILT_IN_SLASH_COMMANDS.length);
    expect(body.commands.every((c) => c.kind === "built-in")).toBe(true);
  });
});
