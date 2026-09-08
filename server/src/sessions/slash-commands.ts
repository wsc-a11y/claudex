import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SlashBehavior, SlashCommand } from "@claudex/shared";
import { ProjectStore } from "./projects.js";

/**
 * Slash-command listing API. Surfaces the real set of `/` commands the
 * `claude` CLI knows about so the web composer's `/` picker can show more
 * than the four hardcoded tokens we shipped in P2.
 *
 * Four sources, in priority order:
 *   1. Built-in CLI commands — hardcoded below. These ship with `claude`
 *      itself and have no on-disk manifest we can scan, so we keep a
 *      curated list of the common ones. Safer to under-report than to
 *      invent commands that don't exist in the CLI.
 *   2. User commands — `~/.claude/commands/*.md`. File basename (minus
 *      `.md`) is the command name; we parse out a description from
 *      frontmatter or a leading `# …` line.
 *   3. Project commands — `<project.path>/.claude/commands/*.md`, only
 *      when the caller passes a `projectId`.
 *   4. Plugin commands — driven by `~/.claude/plugins/installed_plugins.json`
 *      which lists every installed plugin with its `installPath`. For each
 *      plugin we scan `<installPath>/commands/*.md`. If the manifest is
 *      missing or unparseable, plugin scanning is skipped silently (we
 *      don't guess the versioned cache layout). Commands are de-duplicated
 *      across multiple installed versions of the same plugin — the most
 *      recently updated entry (by `lastUpdated`, else `installedAt`) wins.
 */

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------
//
// These are the user-facing slash commands shipped by the `claude` CLI.
// There is no machine-readable manifest for these — the CLI interprets them
// directly — so we maintain a curated list here. Err on the side of omitting
// rather than inventing: a missing entry is a nuisance; a phantom entry sends
// the CLI a command it doesn't understand.
//
// Sources: `claude --help`, `claude` interactive `/help`, and the public
// Claude Code docs as of May 2026. Review when upgrading the CLI version.
//
// Each entry carries a `behavior` — see `SlashBehavior` in @claudex/shared.
// The honest categorization here is the critical bit: the `claude` CLI's
// built-ins fall into three buckets when driven via @anthropic-ai/claude-agent-sdk:
//
//   1. "native" — the SDK has a first-class code path for it. Only `/compact`
//      today. Evidence: the SDK emits a `compact_boundary` system message
//      subtype (sdk.d.ts L2374) and an `SDKStatus = 'compacting'` (L3356) — so
//      `/compact` actually runs inside the agent loop. Sending `/compact` over
//      the wire works end-to-end.
//
//   2. "claudex-action" — the CLI's REPL surfaces a UI (model picker, usage
//      panel, config editor, …) that has a direct claudex equivalent. Instead
//      of forwarding the token to the SDK (which would return "isn't available
//      in this environment"), the picker short-circuits on the client and
//      opens the native UI. Intercepts do not hit the server at all.
//
//   3. "unsupported" — REPL-only commands whose behavior depends on the
//      interactive TTY and/or local CLI state we can't reach (`/login`,
//      `/logout`, `/doctor`, `/init`, `/continue`, `/resume`, `/bug`,
//      `/add-dir`). The picker dims these and blocks sends; no action is
//      taken. We also default `/review` and `/pr-comments` here: they might
//      be forwarded natively, but we haven't verified they work under the
//      Agent SDK — err on the side of "don't silently blow up".
//
// When in doubt, default to `unsupported`. A missing action is worse than a
// disabled row.
const BEHAVIORS: Record<string, SlashBehavior> = {
  "add-dir": {
    kind: "unsupported",
    reason: "CLI REPL command — not available in the Agent SDK",
  },
  bug: {
    kind: "unsupported",
    reason: "CLI REPL command — not available in the Agent SDK",
  },
  clear: {
    kind: "claudex-action",
    action: "clear-transcript",
  },
  compact: { kind: "native" },
  config: {
    kind: "claudex-action",
    action: "open-session-settings",
  },
  continue: {
    kind: "unsupported",
    reason: "CLI REPL command — use the sessions list in claudex",
  },
  cost: {
    kind: "claudex-action",
    action: "open-usage",
  },
  doctor: {
    kind: "unsupported",
    reason: "CLI REPL command — diagnose the CLI from a terminal",
  },
  help: {
    kind: "claudex-action",
    action: "open-slash-help",
  },
  init: {
    kind: "unsupported",
    reason: "CLI REPL command — run `claude` from a terminal to bootstrap",
  },
  login: {
    kind: "unsupported",
    reason: "CLI REPL command — run `claude login` from a terminal",
  },
  logout: {
    kind: "unsupported",
    reason: "CLI REPL command — run `claude logout` from a terminal",
  },
  mcp: {
    kind: "claudex-action",
    action: "open-plugins-settings",
  },
  model: {
    kind: "claudex-action",
    action: "open-model-picker",
  },
  plugin: {
    kind: "claudex-action",
    action: "open-plugins-settings",
  },
  "pr-comments": {
    kind: "unsupported",
    reason: "CLI REPL command — not verified under the Agent SDK",
  },
  resume: {
    kind: "unsupported",
    reason: "CLI REPL command — use the sessions list in claudex",
  },
  review: {
    kind: "unsupported",
    reason: "CLI REPL command — not verified under the Agent SDK",
  },
  status: {
    kind: "claudex-action",
    action: "open-session-settings",
  },
};

export const BUILT_IN_SLASH_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
  behavior: SlashBehavior;
}> = [
  {
    name: "add-dir",
    description: "Add a working directory to the session",
    behavior: BEHAVIORS["add-dir"],
  },
  {
    name: "bug",
    description: "Report a bug with current context",
    behavior: BEHAVIORS.bug,
  },
  {
    name: "clear",
    description: "Clear the conversation history",
    behavior: BEHAVIORS.clear,
  },
  {
    name: "compact",
    description: "Summarize and free context window",
    behavior: BEHAVIORS.compact,
  },
  {
    name: "config",
    description: "Open the CLI configuration",
    behavior: BEHAVIORS.config,
  },
  {
    name: "continue",
    description: "Resume the most recent conversation",
    behavior: BEHAVIORS.continue,
  },
  {
    name: "cost",
    description: "Show token usage and cost for this session",
    behavior: BEHAVIORS.cost,
  },
  {
    name: "doctor",
    description: "Diagnose the local CLI installation",
    behavior: BEHAVIORS.doctor,
  },
  {
    name: "help",
    description: "List available slash commands",
    behavior: BEHAVIORS.help,
  },
  {
    name: "init",
    description: "Bootstrap a CLAUDE.md for this project",
    behavior: BEHAVIORS.init,
  },
  {
    name: "login",
    description: "Authenticate with Anthropic",
    behavior: BEHAVIORS.login,
  },
  {
    name: "logout",
    description: "Sign out of Anthropic",
    behavior: BEHAVIORS.logout,
  },
  {
    name: "mcp",
    description: "Manage MCP servers",
    behavior: BEHAVIORS.mcp,
  },
  {
    name: "model",
    description: "Switch the active model",
    behavior: BEHAVIORS.model,
  },
  {
    name: "plugin",
    description: "Manage installed plugins",
    behavior: BEHAVIORS.plugin,
  },
  {
    name: "pr-comments",
    description: "Summarize comments on the current PR",
    behavior: BEHAVIORS["pr-comments"],
  },
  {
    name: "review",
    description: "Review the current diff",
    behavior: BEHAVIORS.review,
  },
  {
    name: "resume",
    description: "Resume a previous session by id",
    behavior: BEHAVIORS.resume,
  },
  {
    name: "status",
    description: "Show session, model, and project status",
    behavior: BEHAVIORS.status,
  },
];

// ---------------------------------------------------------------------------
// Markdown scanning
// ---------------------------------------------------------------------------

// Cap how much of each .md we read when extracting a description. The
// description is either in a YAML-ish frontmatter block (`description:`) or
// the first-heading/first-line. Either way it lives at the top — we don't
// need the body.
const DESCRIPTION_SCAN_BYTES = 1024;
const DESCRIPTION_SCAN_LINES = 10;

/**
 * Pull a one-line description out of a command markdown file.
 *
 * Tries, in order:
 *   1. YAML frontmatter `description:` key (first `---`-delimited block).
 *   2. First `# Heading` line — treated as description (minus the `#`s).
 *   3. First non-empty line.
 *
 * Reads at most the first `DESCRIPTION_SCAN_BYTES` bytes so a huge file
 * can't wedge the scan. Returns `null` when nothing usable is found.
 */
export function extractDescription(raw: string): string | null {
  const truncated = raw.slice(0, DESCRIPTION_SCAN_BYTES);
  const lines = truncated.split(/\r?\n/).slice(0, DESCRIPTION_SCAN_LINES);

  // Frontmatter: a `---` on the very first non-empty line opens a block; the
  // next `---` closes it. We only look inside that block for `description:`.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && lines[i].trim() === "---") {
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "---") break;
      const m = line.match(/^\s*description\s*:\s*(.*)$/i);
      if (m) {
        const value = m[1].trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  }

  // First heading / non-empty line.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") continue;
    if (trimmed.startsWith("#")) {
      const cleaned = trimmed.replace(/^#+\s*/, "").trim();
      if (cleaned) return cleaned;
      continue;
    }
    return trimmed;
  }
  return null;
}

/**
 * Scan one `commands/` directory (top-level only) and return a SlashCommand
 * entry per `.md` file. Hidden files (dotfiles) are skipped. All filesystem
 * errors are swallowed — this is best-effort; a missing directory is normal
 * and an unreadable one shouldn't break the API.
 */
async function scanCommandsDir(
  dir: string,
  kind: SlashCommand["kind"],
): Promise<SlashCommand[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    // Only shallow `.md` files. Skip hidden, skip sub-dirs.
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const name = entry.name.slice(0, -3); // strip ".md"
    if (!name) continue;
    const abs = path.join(dir, entry.name);
    let description: string | null = null;
    try {
      const handle = await fsp.open(abs, "r");
      try {
        const buf = Buffer.alloc(DESCRIPTION_SCAN_BYTES);
        const { bytesRead } = await handle.read(
          buf,
          0,
          DESCRIPTION_SCAN_BYTES,
          0,
        );
        description = extractDescription(buf.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await handle.close();
      }
    } catch {
      // EACCES / ENOENT / weird binary file — leave description null.
    }
    out.push({ name, description, kind, source: abs, behavior: { kind: "native" } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plugin scanning
// ---------------------------------------------------------------------------

// Shape of `~/.claude/plugins/installed_plugins.json` (v2). We're intentionally
// permissive: anything we don't recognize is skipped rather than failing hard.
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

/**
 * Pick the "current" install for a plugin when multiple versions appear in
 * the manifest. Strategy: prefer the entry with the most recent
 * `lastUpdated`, falling back to `installedAt`, falling back to the first
 * entry as it appears. Deterministic enough for a stable listing.
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

/**
 * Scan plugin commands off `~/.claude/plugins/installed_plugins.json`.
 * Returns [] on any failure — missing file, bad JSON, unexpected shape, or a
 * plugin whose `installPath` has no `commands/` dir. This is best-effort;
 * the picker should never blow up because the plugin manifest changed
 * shape. De-duplicates across multiple installed versions of the same
 * plugin (keyed on the manifest key, e.g. `skill-creator@marketplace`).
 */
export async function scanPluginCommands(
  userClaudeDir: string,
): Promise<SlashCommand[]> {
  const manifestPath = path.join(
    userClaudeDir,
    "plugins",
    "installed_plugins.json",
  );
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, "utf8");
  } catch {
    return [];
  }
  let parsed: InstalledPluginsFile;
  try {
    parsed = JSON.parse(raw) as InstalledPluginsFile;
  } catch {
    return [];
  }
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const out: SlashCommand[] = [];
  // Iterate deterministically — sort by the manifest key so the output
  // order is stable across runs regardless of JSON iteration quirks.
  const keys = Object.keys(plugins).sort();
  for (const key of keys) {
    const installs = plugins[key];
    if (!Array.isArray(installs)) continue;
    const current = pickCurrentInstall(installs);
    if (!current?.installPath) continue;
    const cmdDir = path.join(current.installPath, "commands");
    const entries = await scanCommandsDir(cmdDir, "plugin");
    for (const e of entries) out.push(e);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ListSlashCommandsOpts {
  /** Absolute path to the user's Claude config dir. Defaults to `~/.claude`. */
  userClaudeDir?: string;
  /** Absolute path to a project root — enables project-scoped scan. */
  projectPath?: string;
}

/**
 * Build the full slash-command list. Pure of HTTP; production wires in
 * `~/.claude/commands/` as the user-commands root, tests pass in a tmp dir.
 *
 * Sort order: built-in first (CLI commands the user almost certainly
 * wants), then user, then project — each bucket alphabetized by `name`.
 * The built-ins list stays in its curated order (it's already alpha).
 */
export async function listSlashCommands(
  opts: ListSlashCommandsOpts = {},
): Promise<SlashCommand[]> {
  const userClaudeDir =
    opts.userClaudeDir ?? path.join(os.homedir(), ".claude");
  const builtIns: SlashCommand[] = BUILT_IN_SLASH_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    kind: "built-in",
    behavior: c.behavior,
  }));

  const userCmds = await scanCommandsDir(
    path.join(userClaudeDir, "commands"),
    "user",
  );
  userCmds.sort((a, b) => a.name.localeCompare(b.name));

  let projectCmds: SlashCommand[] = [];
  if (opts.projectPath) {
    projectCmds = await scanCommandsDir(
      path.join(opts.projectPath, ".claude", "commands"),
      "project",
    );
    projectCmds.sort((a, b) => a.name.localeCompare(b.name));
  }

  const pluginCmds = await scanPluginCommands(userClaudeDir);

  return [...builtIns, ...userCmds, ...projectCmds, ...pluginCmds];
}

// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------

export interface SlashCommandsRoutesDeps {
  db: Database.Database;
  /**
   * Override the Claude config dir used for user-scoped scans. Defaults to
   * `~/.claude`. Tests pass a tmp dir so they don't read the host user's
   * real commands.
   */
  userClaudeDir?: string;
}

export async function registerSlashCommandRoutes(
  app: FastifyInstance,
  deps: SlashCommandsRoutesDeps,
): Promise<void> {
  const projects = new ProjectStore(deps.db);

  app.get(
    "/api/slash-commands",
    { preHandler: app.requireAuth as any },
    async (req) => {
      const q = req.query as { projectId?: string };
      let projectPath: string | undefined;
      if (q?.projectId) {
        const project = projects.findById(q.projectId);
        // Unknown projectId is soft-ignored — the picker still works with
        // the built-in + user commands, which is better UX than a 404 when
        // the client races a project delete.
        if (project) projectPath = project.path;
      }
      const commands = await listSlashCommands({
        userClaudeDir: deps.userClaudeDir,
        projectPath,
      });
      return { commands };
    },
  );
}
