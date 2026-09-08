#!/usr/bin/env node
/**
 * claudex status — quick read-only diagnostic for operators who don't want
 * to open the web UI just to check whether the daemon is up, how big the DB
 * has grown, or how many sessions are alive.
 *
 * Pure READ surface: opens the SQLite DB with `readonly: true` (no migration
 * lock, no writes), probes port 5179 over TCP to decide running/stopped,
 * and shells out to `pgrep` to surface a sibling `frpc` if one happens to
 * be running. Never starts a server, never touches ~/.claude, never mutates
 * anything under ~/.claudex. Safe to run while the server is up.
 *
 * Output uses plain ANSI — a handful of colors and a couple of box glyphs.
 * pino is deliberately not involved; this is user-facing CLI text, not logs.
 */
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { loadConfig } from "../lib/config.js";

// ---------------------------------------------------------------------------
// Styling — tiny ANSI helper, no deps. Respects NO_COLOR and non-TTY stdout.
// ---------------------------------------------------------------------------

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function paint(code: string, s: string): string {
  if (!useColor) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);
const cyan = (s: string) => paint("36", s);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function tildify(abs: string): string {
  const home = os.homedir();
  if (abs === home) return "~";
  if (abs.startsWith(home + path.sep)) return "~" + abs.slice(home.length);
  return abs;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "in the future"; // clock skew
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

// Pad-right to visual width (approximate — ANSI sequences are invisible).
function padRight(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - visible.length);
  return s + " ".repeat(pad);
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * TCP connect-probe. A successful connect means *something* is listening on
 * that loopback port — we don't try to speak HTTP, that would require starting
 * a WS / fetch client for marginal extra certainty. Good enough for the
 * "is the daemon up?" question this command answers.
 */
async function probePort(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Best-effort frpc detection. `pgrep -f "frpc -c"` catches the common
 * `frpc -c /path/to/frpc.toml` invocation. If pgrep isn't on PATH (shipped on
 * macOS and most Linux distros, but not universal) we just don't surface the
 * section. No sudo, no cross-user visibility guarantees — this is a hint.
 */
function detectFrpc(): { pid: number } | null {
  try {
    const r = spawnSync("pgrep", ["-f", "frpc -c"], {
      encoding: "utf8",
      timeout: 500,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const first = r.stdout
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (!first) return null;
    const pid = Number(first);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return { pid };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB aggregates — readonly. All queries are defensive against missing tables
// (a brand-new install that never ran the server has no migrations applied;
// we still want `status` to produce useful output instead of throwing).
// ---------------------------------------------------------------------------

interface DbSnapshot {
  sizeBytes: number;
  migrationsApplied: number;
  sessionTotal: number;
  sessionByStatus: Record<string, number>;
  eventsTotal: number;
  lastMessageAt: string | null;
  queuedWaiting: number;
  queuedRunning: number;
  queuedFailedToday: number;
  pushDevices: number;
  pushLatest: { userAgent: string | null; lastUsedAt: string | null } | null;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { x: number } | undefined;
  return !!row;
}

function readDb(dbPath: string): DbSnapshot | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    return null;
  }
  const snap: DbSnapshot = {
    sizeBytes: stat.size,
    migrationsApplied: 0,
    sessionTotal: 0,
    sessionByStatus: {},
    eventsTotal: 0,
    lastMessageAt: null,
    queuedWaiting: 0,
    queuedRunning: 0,
    queuedFailedToday: 0,
    pushDevices: 0,
    pushLatest: null,
  };

  // `readonly: true` + `fileMustExist: true` means we never touch the file,
  // never race the running server's migrations, never take a write lock.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (tableExists(db, "_migrations")) {
      const r = db.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as {
        n: number;
      };
      snap.migrationsApplied = r.n ?? 0;
    }
    if (tableExists(db, "sessions")) {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS n FROM sessions GROUP BY status")
        .all() as { status: string; n: number }[];
      for (const r of rows) {
        snap.sessionByStatus[r.status] = r.n;
        snap.sessionTotal += r.n;
      }
    }
    if (tableExists(db, "session_events")) {
      const r1 = db
        .prepare("SELECT COUNT(*) AS n FROM session_events")
        .get() as { n: number };
      snap.eventsTotal = r1.n ?? 0;
      const r2 = db
        .prepare("SELECT MAX(created_at) AS t FROM session_events")
        .get() as { t: string | null };
      snap.lastMessageAt = r2.t ?? null;
    }
    if (tableExists(db, "queued_prompts")) {
      const rows = db
        .prepare(
          "SELECT status, COUNT(*) AS n FROM queued_prompts GROUP BY status",
        )
        .all() as { status: string; n: number }[];
      for (const r of rows) {
        if (r.status === "queued") snap.queuedWaiting = r.n;
        else if (r.status === "running") snap.queuedRunning = r.n;
      }
      // "Failed today" = finished_at within the last 24h with status='failed'.
      // We use finished_at (not created_at) because the meaningful event is
      // the failure itself, not when the prompt was enqueued.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const r2 = db
        .prepare(
          "SELECT COUNT(*) AS n FROM queued_prompts WHERE status='failed' AND finished_at IS NOT NULL AND finished_at >= ?",
        )
        .get(since) as { n: number };
      snap.queuedFailedToday = r2.n ?? 0;
    }
    if (tableExists(db, "push_subscriptions")) {
      const r1 = db
        .prepare("SELECT COUNT(*) AS n FROM push_subscriptions")
        .get() as { n: number };
      snap.pushDevices = r1.n ?? 0;
      if (snap.pushDevices > 0) {
        const r2 = db
          .prepare(
            "SELECT user_agent, last_used_at FROM push_subscriptions ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1",
          )
          .get() as
          | { user_agent: string | null; last_used_at: string | null }
          | undefined;
        if (r2) {
          snap.pushLatest = {
            userAgent: r2.user_agent,
            lastUsedAt: r2.last_used_at,
          };
        }
      }
    }
  } finally {
    db.close();
  }
  return snap;
}

// Clip a long user-agent to something that fits on one line.
function shortUserAgent(ua: string | null): string {
  if (!ua) return "unknown device";
  // Pull out the first Mozilla token or obvious device marker if present;
  // otherwise just truncate.
  const m = ua.match(/\(([^;)]+)[;)]/);
  if (m && m[1]) return m[1].trim();
  return ua.length > 40 ? ua.slice(0, 37) + "…" : ua;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 10;

function row(label: string, value: string, extra?: string): string {
  const lhs = padRight(label, LABEL_WIDTH);
  const main = value;
  const tail = extra ? "  " + dim(extra) : "";
  return `    ${lhs}${main}${tail}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const out = process.stdout;

  // --- header -------------------------------------------------------------
  out.write(bold("Claudex") + dim(" · ") + "status\n");
  out.write(dim("━".repeat(32)) + "\n\n");

  // --- server -------------------------------------------------------------
  const running = await probePort(config.host, config.port);
  const logFile = path.join(config.logDir, "server.log");
  const statusCell = running
    ? green("● running")
    : red("○ stopped");
  // We intentionally skip a PID column. Reliable attribution needs a PID
  // file written at startup (not currently wired), and grepping lsof/ps is
  // noisy and OS-specific. The TCP probe answers the only question most
  // operators actually have: "is it up?"
  out.write("  " + bold("Server") + "\n");
  out.write(row("status", statusCell) + "\n");
  out.write(row("port", `${config.host}:${config.port}`) + "\n");
  out.write(row("logs", tildify(logFile)) + "\n");
  out.write("\n");

  // --- database -----------------------------------------------------------
  out.write("  " + bold("Database") + "\n");
  let snap: DbSnapshot | null = null;
  try {
    snap = readDb(config.dbPath);
  } catch (err) {
    out.write(
      row(
        "path",
        tildify(config.dbPath),
        `error: ${err instanceof Error ? err.message : String(err)}`,
      ) + "\n\n",
    );
  }
  if (snap) {
    out.write(row("path", tildify(config.dbPath)) + "\n");
    out.write(
      row(
        "size",
        `${formatBytes(snap.sizeBytes)} ${dim("·")} ${formatInt(snap.migrationsApplied)} migrations applied`,
      ) + "\n",
    );
    out.write("\n");

    // --- sessions ---------------------------------------------------------
    const s = snap.sessionByStatus;
    const sessionBreakdown =
      `${formatInt(s.running ?? 0)} running · ` +
      `${formatInt(s.cli_running ?? 0)} cli_running · ` +
      `${formatInt(s.awaiting ?? 0)} awaiting · ` +
      `${formatInt(s.idle ?? 0)} idle · ` +
      `${formatInt(s.archived ?? 0)} archived` +
      (s.error ? ` · ${formatInt(s.error)} error` : "");
    out.write("  " + bold("Sessions") + "\n");
    out.write(
      row("total", padRight(formatInt(snap.sessionTotal), 11), `(${sessionBreakdown})`) + "\n",
    );
    const eventsExtra =
      snap.eventsTotal > 0
        ? `(last message ${formatRelative(snap.lastMessageAt)})`
        : "(no messages yet)";
    out.write(
      row("events", padRight(formatInt(snap.eventsTotal), 11), eventsExtra) + "\n",
    );
    out.write("\n");

    // --- queue ------------------------------------------------------------
    out.write("  " + bold("Queue") + "\n");
    const queuedCell =
      snap.queuedWaiting > 0
        ? cyan(`${formatInt(snap.queuedWaiting)} waiting`)
        : dim("0 waiting");
    out.write(row("queued", queuedCell) + "\n");
    out.write(row("running", formatInt(snap.queuedRunning)) + "\n");
    const failedCell =
      snap.queuedFailedToday > 0
        ? yellow(`${formatInt(snap.queuedFailedToday)} today`)
        : `${formatInt(snap.queuedFailedToday)} today`;
    out.write(row("failed", failedCell) + "\n");
    out.write("\n");

    // --- push -------------------------------------------------------------
    out.write("  " + bold("Push") + "\n");
    if (snap.pushDevices === 0) {
      out.write(row("devices", dim("none registered")) + "\n");
    } else {
      const latest = snap.pushLatest;
      const label =
        latest && (latest.userAgent || latest.lastUsedAt)
          ? `(${shortUserAgent(latest.userAgent)} · ${formatRelative(latest.lastUsedAt)})`
          : "";
      out.write(
        row("devices", `${formatInt(snap.pushDevices)} registered`, label || undefined) +
          "\n",
      );
    }
    out.write("\n");
  }

  // --- frpc ---------------------------------------------------------------
  const frpc = detectFrpc();
  if (frpc) {
    out.write("  " + bold("frpc") + "\n");
    out.write(
      row("pid", String(frpc.pid), "(not managed by claudex)") + "\n",
    );
    out.write("\n");
  }
}

main().catch((err) => {
  process.stderr.write(
    `claudex status failed: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(2);
});
