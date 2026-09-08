import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UserEnvPlugin, UserEnvResponse } from "@claudex/shared";
import { UserStore } from "../auth/index.js";

/**
 * Read-only reflection of the user's Claude CLI environment for the
 * settings screen. The settings page doesn't mutate any of this — the
 * `claude` CLI owns `~/.claude/` — we just surface what's there so the
 * user can eyeball which plugins are installed and which are enabled.
 *
 * We consult two files:
 *   - `<claudeDir>/settings.json` — the CLI's user-level settings, which
 *     carries an `enabledPlugins` map keyed by "<plugin>@<marketplace>".
 *   - `<claudeDir>/plugins/installed_plugins.json` — the authoritative
 *     inventory of installed plugins, each with its `installPath` and
 *     `version`.
 *
 * Either file may be missing on a fresh install; we degrade gracefully
 * (settingsReadable=false / plugins=[]) rather than 500-ing.
 */

interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
}
interface InstalledPluginEntry {
  scope?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
}
interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<string, InstalledPluginEntry[]>;
}

async function readJsonSafe<T>(absPath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(absPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Split a plugin key of the form `name@marketplace` into its two parts.
 * Keys without `@` are returned with a null marketplace (the CLI allows
 * this, though it's uncommon in practice).
 */
function splitPluginKey(key: string): {
  name: string;
  marketplace: string | null;
} {
  const at = key.indexOf("@");
  if (at <= 0) return { name: key, marketplace: null };
  return {
    name: key.slice(0, at),
    marketplace: key.slice(at + 1),
  };
}

/**
 * Pick the newest install for a plugin — same rule as slash-commands plugin
 * scanning so the settings panel and the `/` picker stay aligned.
 */
function pickCurrentInstall(
  installs: InstalledPluginEntry[],
): InstalledPluginEntry | null {
  if (installs.length === 0) return null;
  const withTime = installs.map((e) => ({
    entry: e,
    t: Date.parse(e.lastUpdated ?? e.installedAt ?? "") || 0,
  }));
  withTime.sort((a, b) => b.t - a.t);
  return withTime[0].entry;
}

export interface ReadUserEnvOpts {
  userClaudeDir: string;
}

export async function readUserEnv(
  opts: ReadUserEnvOpts,
): Promise<{
  settingsReadable: boolean;
  claudeDir: string;
  plugins: UserEnvPlugin[];
}> {
  const claudeDir = opts.userClaudeDir;
  const settings = await readJsonSafe<ClaudeSettings>(
    path.join(claudeDir, "settings.json"),
  );
  const installed = await readJsonSafe<InstalledPluginsFile>(
    path.join(claudeDir, "plugins", "installed_plugins.json"),
  );

  const enabledMap = (settings?.enabledPlugins ?? {}) as Record<
    string,
    boolean
  >;
  const installedMap = (installed?.plugins ?? {}) as Record<
    string,
    InstalledPluginEntry[]
  >;

  // Union of keys from both sources — an installed plugin with no
  // enabledPlugins entry is treated as disabled; an enabled entry with no
  // install is still surfaced (the CLI may re-fetch it next run).
  const keys = new Set<string>([
    ...Object.keys(installedMap),
    ...Object.keys(enabledMap),
  ]);
  const plugins: UserEnvPlugin[] = [];
  for (const key of Array.from(keys).sort()) {
    const { name, marketplace } = splitPluginKey(key);
    const installs = installedMap[key] ?? [];
    const current = pickCurrentInstall(installs);
    plugins.push({
      key,
      name,
      marketplace,
      version: current?.version ?? null,
      installPath: current?.installPath ?? null,
      enabled: Boolean(enabledMap[key]),
    });
  }

  return {
    settingsReadable: settings !== null,
    claudeDir,
    plugins,
  };
}

export interface UserEnvRoutesDeps {
  db: Database.Database;
  /** Override for tests; defaults to `~/.claude`. */
  userClaudeDir?: string;
}

export async function registerUserEnvRoutes(
  app: FastifyInstance,
  deps: UserEnvRoutesDeps,
): Promise<void> {
  const users = new UserStore(deps.db);
  const claudeDir = deps.userClaudeDir ?? path.join(os.homedir(), ".claude");

  app.get(
    "/api/user/env",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const row = users.findById(req.userId!);
      if (!row) return reply.code(401).send({ error: "user_gone" });
      const env = await readUserEnv({ userClaudeDir: claudeDir });
      const body: UserEnvResponse = {
        user: {
          id: row.id,
          username: row.username,
          createdAt: row.created_at,
          twoFactorEnabled: true,
        },
        claudeDir: env.claudeDir,
        settingsReadable: env.settingsReadable,
        plugins: env.plugins,
      };
      return reply.send(body);
    },
  );
}
