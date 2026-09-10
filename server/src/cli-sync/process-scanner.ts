import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Session } from "@claudex/shared";
import type { SessionStore } from "../sessions/store.js";
import type { SessionManager } from "../sessions/manager.js";
import {
  defaultCliProjectsRoot,
  encodeCwdToSlug,
} from "../sessions/cli-discovery.js";

/**
 * CLI process scanner — periodically enumerates live `claude` CLI processes on
 * the host and maps each one to a claudex session via its SDK session id, so
 * idle claudex rows whose external CLI is currently alive can be surfaced as
 * `cli_running` ("被占用"). The composer locks on that status: two writers
 * on one transcript is what made claudex's interrupt feel dead (it only
 * reaches claudex's own child, not the external process that's actually
 * talking).
 *
 * Design:
 *   - `ps -axo pid,args` gives us every process + its argv (macOS + Linux
 *     compatible; no `/proc`, no `fanotify`).
 *   - Rows whose executable basename is exactly `claude` (filter out our own
 *     `claudex` node process, subagent `claude-code` variants, etc.) are
 *     candidates.
 *   - `claude --resume <uuid>` → sessionId pulled straight from argv.
 *   - Plain `claude` (no --resume) → `lsof -p <pid> -a -d cwd -Fn` gives us
 *     the process's cwd; we map that to `~/.claude/projects/<slug>/` using
 *     `encodeCwdToSlug` (shared with the rest of cli-sync), then pick the
 *     newest-mtime `*.jsonl` in that directory as the active session.
 *   - Every 5s we rebuild the pid→sessionId map and reconcile:
 *       - for each claudex session currently `idle` whose sdkSessionId is
 *         present in the map → flip to `cli_running` + broadcast
 *       - for each claudex session currently `cli_running` whose sdkSessionId
 *         is NOT in the map → flip back to `idle` + broadcast
 *     All other statuses (running / awaiting / error / archived) are left
 *     untouched — claudex's own state wins.
 *
 * Honest limits:
 *   - A 5s scan means an idle → cli_running flip can lag up to 5s; acceptable.
 *   - `lsof` / `ps` aren't free, but 20+ claude processes + a handful of
 *     lsof calls is still <100ms per tick on typical Macs.
 *   - Process-has-stale-argv-uuid (`claude --resume <uuid>` where uuid isn't
 *     in our sessions table) is skipped — we never synthesize sessions here;
 *     the filesystem watcher owns adoption.
 */

export interface ProcessScannerDeps {
  sessions: SessionStore;
  manager: SessionManager;
  /** Override `~/.claude/projects`; tests pass a tmp root. */
  cliProjectsRoot?: string;
  /**
   * Injectable process-list source for tests. Returns `{pid, args}` rows.
   * Defaults to `ps -axo pid,args` via `execFileSync`.
   */
  listProcesses?: () => Array<{ pid: number; args: string }>;
  /**
   * Injectable cwd lookup for tests. Returns null if the process is gone or
   * its cwd cannot be read. Defaults to `lsof -p <pid> -a -d cwd -Fn`.
   */
  getCwdForPid?: (pid: number) => string | null;
  logger?: {
    debug?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
  /** Tick interval in ms. Defaults to 5000. */
  intervalMs?: number;
}

export interface ProcessScanner {
  /** Stop the interval and release resources. Safe to call multiple times. */
  stop(): void;
  /** Run one reconciliation tick synchronously — for tests / explicit pokes. */
  tickNow(): Promise<void>;
}

const SDK_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Default `ps` runner. Lists every process's pid + argv. macOS + Linux
 * compatible. Returns [] on failure rather than throwing — the scanner is
 * best-effort supervision; an unexpected `ps` failure must never crash the
 * server.
 *
 * Windows takes a different path: `ps` in Git Bash only sees MSYS processes
 * (and dev-manager-launched servers have no `ps` on PATH at all), so we
 * enumerate via WMI with a focused `Name='claude.exe'` filter — the query
 * runs provider-side and comes back as one JSON array. The `claude.exe`
 * filter intentionally excludes `Claude.exe` (Desktop app) and every other
 * process, so no basename triage happens here; `parseClaudeProcess` still
 * re-checks the basename defensively.
 */
function defaultListProcesses(): Array<{ pid: number; args: string }> {
  if (process.platform === "win32") {
    return listWindowsClaudeProcesses();
  }
  try {
    const out = execFileSync("ps", ["-axo", "pid=,args="], {
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows: Array<{ pid: number; args: string }> = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trimStart();
      if (!trimmed) continue;
      // First token is pid, rest is argv (possibly with spaces).
      const firstSpace = trimmed.indexOf(" ");
      if (firstSpace === -1) continue;
      const pid = Number.parseInt(trimmed.slice(0, firstSpace), 10);
      if (!Number.isFinite(pid)) continue;
      const args = trimmed.slice(firstSpace + 1);
      rows.push({ pid, args });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * PowerShell one-liner the Windows lister runs. Filter is WMI-provider-side
 * so the cold-start cost (~500ms) dominates. `[Console]::OutputEncoding`
 * forces UTF-8 on the pipe — without it, paths with non-ASCII chars (the
 * user has 中文 directory names) come back in the OEM code page and break
 * JSON parsing. `ConvertTo-Json -Compress` gives us a parseable array even
 * when a single process matches (no `-NoEnumerate` pitfalls since we wrap
 * each row in an object).
 */
const WINDOWS_PROCESS_QUERY =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
  "ForEach-Object { @{ pid = $_.ProcessId; cmd = $_.CommandLine } } | " +
  "ConvertTo-Json -Compress";

/** Default executor for the Windows lister; injectable in tests. */
function defaultPowershellExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

/**
 * Enumerate live `claude.exe` processes via WMI. Returns [] on any failure —
 * same best-effort contract as the POSIX path.
 */
export function listWindowsClaudeProcesses(
  exec: (cmd: string, args: string[]) => string = defaultPowershellExec,
): Array<{ pid: number; args: string }> {
  // Absolute path first: the server may run under a launcher (dev-manager)
  // with a trimmed PATH. Fall back to bare `powershell.exe` for any host
  // where SystemRoot is unset (shouldn't happen on real Windows).
  const sysroot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const candidates = [
    ...(sysroot
      ? [path.join(sysroot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
      : []),
    "powershell.exe",
  ];
  const args = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY];
  for (const exe of candidates) {
    try {
      return parseWindowsProcessList(exec(exe, args));
    } catch {
      // try the next candidate
    }
  }
  return [];
}

/**
 * Parse the PowerShell `ConvertTo-Json` output into `{pid, args}` rows.
 * Pure — unit-tested against a captured fixture. An empty result set comes
 * back as an empty string; a single match arrives as a bare object, not an
 * array, so both shapes are normalized.
 */
export function parseWindowsProcessList(
  json: string,
): Array<{ pid: number; args: string }> {
  const trimmed = json.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const rows: Array<{ pid: number; args: string }> = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const { pid, cmd } = item as { pid?: unknown; cmd?: unknown };
    if (typeof pid !== "number" || typeof cmd !== "string") continue;
    rows.push({ pid, args: cmd });
  }
  return rows;
}

/**
 * Default cwd lookup via `lsof`. The `-Fn` output prefixes each field with a
 * one-letter tag; the line starting with `n` carries the path. Works the
 * same on macOS and Linux. Returns null on any failure (process gone,
 * permission denied, etc.).
 *
 * Windows: no equivalent of `lsof -d cwd` without heavyweight P/Invoke, so
 * plain `claude.exe` (no `--resume` in argv) is NOT resolvable on Windows.
 * Accepted limit: the VSCode extension — the case this scanner exists for —
 * always passes `--resume <uuid>`, and a terminal `claude` without it is a
 * fresh session the fs watcher will adopt as a new row anyway.
 */
function defaultGetCwdForPid(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync(
      "lsof",
      ["-p", String(pid), "-a", "-d", "cwd", "-Fn"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 512 * 1024,
      },
    );
    for (const line of out.split("\n")) {
      if (line.startsWith("n") && line.length > 1) {
        return line.slice(1).trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse one `ps` row into a `{kind, sessionId?}` shape. Returns null when
 * this process is not a claude CLI candidate. Pure — unit-tested directly.
 */
export function parseClaudeProcess(args: string):
  | { kind: "resume"; sessionId: string }
  | { kind: "plain" }
  | null {
  const trimmed = args.trim();
  if (!trimmed) return null;

  // First whitespace-separated token is the executable (path + name).
  const firstSpace = trimmed.search(/\s/);
  const exe = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);

  // Basename must be exactly `claude` (POSIX) or `claude.exe` (Windows
  // native binary — VSCode extension, SDK bundle, npm global). Case-
  // sensitive on purpose: `Claude` / `Claude.exe` (Desktop GUI app) is
  // rejected. Also rejects `claudex`, `claude-code`, `claudexd`. We use
  // simple path.basename rather than a regex because argv paths can include
  // any character.
  const base = path.basename(exe);
  if (base !== "claude" && base !== "claude.exe") return null;

  // `claude --resume <uuid>` → pick the uuid out of argv. Tolerate extra
  // flags before/after (`-d`, `--model foo`, etc.) by scanning for the
  // first `--resume`/`-r` that's followed by a well-formed uuid.
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "--resume" || tokens[i] === "-r") {
      const next = tokens[i + 1];
      if (SDK_ID_RE.test(next)) {
        return { kind: "resume", sessionId: next };
      }
    }
  }

  return { kind: "plain" };
}

/**
 * Find the newest-mtime `*.jsonl` under `<root>/<slug>/` and return its
 * session id (the filename stem, a uuid). Returns null when the directory
 * doesn't exist or has no valid jsonls. Used for plain `claude` processes
 * whose argv doesn't carry the session id.
 */
export async function newestJsonlSessionId(
  root: string,
  slug: string,
): Promise<string | null> {
  const dir = path.join(root, slug);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  let best: { sessionId: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!SDK_ID_RE.test(sessionId)) continue;
    try {
      const stat = await fsp.stat(path.join(dir, name));
      if (!best || stat.mtimeMs > best.mtime) {
        best = { sessionId, mtime: stat.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return best?.sessionId ?? null;
}

/**
 * Build the pid→sessionId map for the current process list. `sessionId` is
 * an SDK session uuid (matches `sessions.sdkSessionId`). The map is many-
 * processes-to-one-session in principle (two terminals resuming the same
 * session), but reconciliation only cares about set membership anyway.
 */
export async function buildPidSessionMap(deps: {
  listProcesses: () => Array<{ pid: number; args: string }>;
  getCwdForPid: (pid: number) => string | null;
  cliProjectsRoot: string;
}): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const row of deps.listProcesses()) {
    const parsed = parseClaudeProcess(row.args);
    if (!parsed) continue;
    if (parsed.kind === "resume") {
      out.set(row.pid, parsed.sessionId);
      continue;
    }
    // plain — look up cwd, compute slug, pick newest jsonl in the slug dir.
    const cwd = deps.getCwdForPid(row.pid);
    if (!cwd) continue;
    const slug = encodeCwdToSlug(cwd);
    const sessionId = await newestJsonlSessionId(deps.cliProjectsRoot, slug);
    if (sessionId) out.set(row.pid, sessionId);
  }
  return out;
}

/**
 * Reconcile one scan's pid→session map against the claudex `sessions` table.
 * Only `idle` rows get promoted to `cli_running`; only `cli_running` rows
 * get demoted back to `idle` when their sdkSessionId is no longer present.
 * All other statuses pass through untouched — claudex's own state wins.
 *
 * Broadcasts a synthesized `session_update` for each flip via
 * `SessionManager.broadcastStatus` so every subscribed tab sees the dot
 * move without waiting for the next runner event.
 *
 * Returns the set of sessions whose status changed this tick — used by
 * tests and the info log.
 */
export function reconcile(
  sessions: SessionStore,
  manager: SessionManager,
  liveSessionIds: Set<string>,
  logger?: ProcessScannerDeps["logger"],
): { promoted: string[]; demoted: string[] } {
  const promoted: string[] = [];
  const demoted: string[] = [];

  // Candidate demotions: every row currently `cli_running` that's no longer
  // in the live set.
  const cliRunning = sessions.listByStatuses(["cli_running"]);
  for (const row of cliRunning) {
    const sdkId = row.sdkSessionId;
    if (!sdkId || !liveSessionIds.has(sdkId)) {
      demoteToIdle(sessions, manager, row, logger);
      demoted.push(row.id);
    }
  }

  // Candidate promotions: every idle row whose sdkSessionId is live. We
  // intersect against the `idle` status list because that's the only
  // allowed source state per the user's priority rule.
  if (liveSessionIds.size > 0) {
    const idleRows = sessions.listByStatuses(["idle"]);
    for (const row of idleRows) {
      const sdkId = row.sdkSessionId;
      if (!sdkId) continue;
      if (!liveSessionIds.has(sdkId)) continue;
      // claudex-managed sessions have a live AgentRunner attached; the
      // claude subprocess the SDK spawns for them WILL show up in `ps`
      // and its JSONL path matches this row's sdkSessionId. That's our
      // own subprocess, not an external CLI attach — skip it so sessions
      // the user is actively talking to through claudex don't briefly
      // flash into cli_running right after the turn finishes while the
      // subprocess is still winding down.
      if (manager.hasRunner(row.id)) continue;
      promoteToCliRunning(sessions, manager, row, logger);
      promoted.push(row.id);
    }
  }

  return { promoted, demoted };
}

function promoteToCliRunning(
  sessions: SessionStore,
  manager: SessionManager,
  row: Session,
  logger?: ProcessScannerDeps["logger"],
): void {
  logger?.info?.(
    { sessionId: row.id, from: row.status, to: "cli_running", reason: "process_scanner_seen" },
    "session status transition",
  );
  sessions.setStatus(row.id, "cli_running");
  // Broadcast so Chat / Home / the sessions rail update instantly. We pass
  // the status literal through even though the WS bridge only knows the
  // runner-event vocabulary — `broadcastStatus` accepts a widened type and
  // the transport layer forwards the raw status to the client.
  manager.broadcastStatus(row.id, "cli_running");
}

function demoteToIdle(
  sessions: SessionStore,
  manager: SessionManager,
  row: Session,
  logger?: ProcessScannerDeps["logger"],
): void {
  logger?.info?.(
    { sessionId: row.id, from: row.status, to: "idle", reason: "process_scanner_gone" },
    "session status transition",
  );
  sessions.setStatus(row.id, "idle");
  manager.broadcastStatus(row.id, "idle");
}

/**
 * Start a long-running scanner. Call `.stop()` to cancel. Safe to call from
 * `server/src/index.ts` at boot; does nothing surprising if the host has no
 * `claude` CLI processes (the tick just finds an empty map and reconciles
 * nothing). The first tick runs on the next event-loop turn so that boot
 * completes without blocking on process enumeration.
 */
export function startProcessScanner(deps: ProcessScannerDeps): ProcessScanner {
  // Windows ticks are pricier: each scan is a fresh PowerShell cold start
  // (~500ms measured), so the default interval is 3x the POSIX one. The
  // flip still lands within 15s, which is fine for an observability signal
  // on a machine where the user is usually looking at the other window.
  const interval =
    deps.intervalMs ?? (process.platform === "win32" ? 15_000 : 5_000);
  const cliProjectsRoot = deps.cliProjectsRoot ?? defaultCliProjectsRoot();
  const listProcesses = deps.listProcesses ?? defaultListProcesses;
  const getCwdForPid = deps.getCwdForPid ?? defaultGetCwdForPid;
  const logger = deps.logger;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running) return; // skip overlapping ticks — a slow `lsof` shouldn't fan out
    running = true;
    try {
      const map = await buildPidSessionMap({
        listProcesses,
        getCwdForPid,
        cliProjectsRoot,
      });
      const liveSessionIds = new Set(map.values());
      const { promoted, demoted } = reconcile(
        deps.sessions,
        deps.manager,
        liveSessionIds,
        logger,
      );
      if (promoted.length > 0 || demoted.length > 0) {
        logger?.debug?.(
          { promoted, demoted, livePids: map.size },
          "process-scanner: reconciled",
        );
      }
    } catch (err) {
      logger?.warn?.({ err }, "process-scanner: tick failed");
    } finally {
      running = false;
    }
  };

  // Kick off the first tick on the next turn so boot isn't blocked on ps/lsof.
  const kick = setTimeout(() => void tick(), 0);
  if (typeof kick.unref === "function") kick.unref();

  timer = setInterval(() => void tick(), interval);
  if (timer && typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tickNow: tick,
  };
}

// Re-export for tests.
export { defaultListProcesses, defaultGetCwdForPid };
// Silence "execFile declared but never used" in some toolchains where the
// async form is unused; kept import for documentation of available API.
void execFile;
void fs;
