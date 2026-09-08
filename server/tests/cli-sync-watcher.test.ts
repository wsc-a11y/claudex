import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.js";
import { SessionStore } from "../src/sessions/store.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import { SessionManager } from "../src/sessions/manager.js";
import type { RunnerEvent } from "../src/sessions/runner.js";
import {
  startCliSyncWatcher,
  deriveCliStatus,
} from "../src/cli-sync/watcher.js";
import { tempConfig } from "./helpers.js";

/**
 * CLI live-sync watcher — uses a tmp dir as a fake `~/.claude/projects` and
 * drives the watcher directly. We exercise the handler via the `__handleForTest`
 * escape hatch rather than relying on chokidar's async event pump (which is
 * brittle under vitest concurrency and wall-clock-sensitive).
 *
 * The "new JSONL gets adopted" and "append triggers resync" cases are the
 * contract we actually care about — those are where we'd regress if the
 * watcher-to-import wiring broke. Status-derivation is tested independently
 * via `deriveCliStatus`.
 */

function setup() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const sessions = new SessionStore(db);
  const projects = new ProjectStore(db);

  const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-watcher-"));

  // Capture broadcasts made via the SessionManager. We pass a noop runner
  // factory — the watcher never calls `getOrCreate`.
  const broadcasts: Array<{ sessionId: string; event: RunnerEvent }> = [];
  const manager = new SessionManager({
    sessions,
    projects,
    grants: new ToolGrantStore(db),
    runnerFactory: {
      create: () => {
        throw new Error("not used");
      },
    },
    broadcast: (sessionId: string, event: RunnerEvent) => {
      broadcasts.push({ sessionId, event });
    },
  });

  const watcher = startCliSyncWatcher({
    sessions,
    projects,
    manager,
    cliProjectsRoot: cliRoot,
  });

  return {
    sessions,
    projects,
    manager,
    watcher,
    broadcasts,
    cliRoot,
    writeJsonl(sdkId: string, slug: string, records: unknown[]) {
      const dir = path.join(cliRoot, slug);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${sdkId}.jsonl`);
      const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      fs.writeFileSync(filePath, body);
      return filePath;
    },
    appendJsonl(sdkId: string, slug: string, records: unknown[]) {
      const filePath = path.join(cliRoot, slug, `${sdkId}.jsonl`);
      const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      fs.appendFileSync(filePath, body);
      return filePath;
    },
    cleanup: async () => {
      await watcher.close();
      fs.rmSync(cliRoot, { recursive: true, force: true });
      close();
      cleanup();
    },
  };
}

const SDK_ID = "7a4f3e2d-aaaa-bbbb-cccc-111122223333";
const SLUG = "-Users-hao-demo";

describe("cli-sync watcher", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it("adopts a brand-new JSONL and broadcasts a refresh_transcript", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    const filePath = ctx.writeJsonl(SDK_ID, SLUG, [
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
        },
      },
    ]);

    await ctx.watcher.__handleForTest("add", filePath);

    // A claudex session row exists now, stamped with sdkSessionId and the
    // imported events.
    const row = ctx.sessions.findBySdkSessionId(SDK_ID);
    expect(row).not.toBeNull();
    expect(row!.sdkSessionId).toBe(SDK_ID);
    expect(ctx.sessions.countEvents(row!.id)).toBeGreaterThan(0);
    expect(ctx.sessions.getCliJsonlSeq(row!.id)).toBe(2);

    // Broadcast fired — at least one refresh_transcript for the new session.
    const refreshes = ctx.broadcasts.filter(
      (b) => b.sessionId === row!.id && b.event.type === "refresh_transcript",
    );
    expect(refreshes.length).toBeGreaterThan(0);
  });

  it("resyncs on change to an already-adopted JSONL", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    const filePath = ctx.writeJsonl(SDK_ID, SLUG, [
      { type: "user", message: { role: "user", content: "turn 1" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "reply 1" }],
          stop_reason: "end_turn",
        },
      },
    ]);

    // First pass: adopt.
    await ctx.watcher.__handleForTest("add", filePath);
    const row = ctx.sessions.findBySdkSessionId(SDK_ID)!;
    const countAfterAdopt = ctx.sessions.countEvents(row.id);
    ctx.broadcasts.length = 0;

    // CLI appends more turns.
    ctx.appendJsonl(SDK_ID, SLUG, [
      { type: "user", message: { role: "user", content: "turn 2" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "reply 2" }],
          stop_reason: "end_turn",
        },
      },
    ]);

    await ctx.watcher.__handleForTest("change", filePath);

    const countAfterResync = ctx.sessions.countEvents(row.id);
    expect(countAfterResync).toBeGreaterThan(countAfterAdopt);
    // cli_jsonl_seq keeps pace with non-empty lines (4 total).
    expect(ctx.sessions.getCliJsonlSeq(row.id)).toBe(4);
    // A refresh_transcript went out.
    const refreshes = ctx.broadcasts.filter(
      (b) => b.sessionId === row.id && b.event.type === "refresh_transcript",
    );
    expect(refreshes.length).toBeGreaterThan(0);
  });

  it("deduplicates concurrent events for the same session", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    const filePath = ctx.writeJsonl(SDK_ID, SLUG, [
      { type: "user", message: { role: "user", content: "hi" } },
    ]);
    // Fire two handlers back-to-back. The second should no-op because
    // inflight is already set.
    await Promise.all([
      ctx.watcher.__handleForTest("add", filePath),
      ctx.watcher.__handleForTest("add", filePath),
    ]);
    const row = ctx.sessions.findBySdkSessionId(SDK_ID);
    expect(row).not.toBeNull();
    // Only one session row (idempotent).
    const all = ctx.sessions.list({ includeArchived: true });
    expect(all.filter((s) => s.sdkSessionId === SDK_ID)).toHaveLength(1);
  });

  it("ignores non-jsonl files and non-UUID filenames", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    const dir = path.join(ctx.cliRoot, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    const junk = path.join(dir, "not-a-session.txt");
    fs.writeFileSync(junk, "nope");
    const badJsonl = path.join(dir, "not-a-uuid.jsonl");
    fs.writeFileSync(badJsonl, "");
    await ctx.watcher.__handleForTest("add", junk);
    await ctx.watcher.__handleForTest("add", badJsonl);
    // No session rows were created.
    expect(ctx.sessions.list({ includeArchived: true })).toHaveLength(0);
  });
});

describe("deriveCliStatus", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function writeJsonl(lines: unknown[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-derive-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "test.jsonl");
    fs.writeFileSync(
      filePath,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    return filePath;
  }

  const baseSession = {
    id: "s1",
    title: "x",
    projectId: "p1",
    branch: null,
    worktreePath: null,
    status: "idle" as const,
    model: "claude-opus-4-8" as const,
    mode: "default" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessageAt: null,
    archivedAt: null,
    sdkSessionId: SDK_ID,
    parentSessionId: null,
    cliJsonlSeq: 0,
    stats: {
      messages: 0,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      contextPct: 0,
    },
  };

  it("returns running when mtime < 20s AND tail has a recent in-flight assistant record", async () => {
    const filePath = writeJsonl([
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "thinking..." }],
          // no stop_reason — mid-turn
        },
      },
    ]);
    const next = await deriveCliStatus(baseSession, filePath);
    expect(next).toBe("running");
  });

  it("returns idle when mtime < 20s but last assistant has stop_reason", async () => {
    const filePath = writeJsonl([
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        },
      },
    ]);
    const runningRow = { ...baseSession, status: "running" as const };
    const next = await deriveCliStatus(runningRow, filePath);
    expect(next).toBe("idle");
  });

  it("returns idle when the last line is a user record with no following assistant (awaiting user)", async () => {
    // CLI is paused waiting for the user's reply — no assistant after the
    // last user line. Should NOT classify as running just because the file
    // mtime is fresh.
    const filePath = writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        },
      },
      { type: "user", message: { role: "user", content: "quick q" } },
    ]);
    // Fresh mtime (file was just written) — this is the exact case that
    // used to mis-classify as running under the old heuristic.
    const next = await deriveCliStatus(baseSession, filePath);
    expect(next).toBe("idle");
  });

  it("is idle when tail only contains a user prompt (no assistant ever)", async () => {
    // Very new session: the user typed something, no assistant replied yet.
    // Previously this flipped to running because "fresh mtime + no
    // stop_reason". Now it's idle.
    const filePath = writeJsonl([
      { type: "user", message: { role: "user", content: "start me up" } },
    ]);
    const next = await deriveCliStatus(baseSession, filePath);
    expect(next).toBe("idle");
  });

  it("returns idle when mtime is stale (> 60s) regardless of tail", async () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          // no stop_reason, but mtime is stale
        },
      },
    ]);
    const old = Date.now() / 1000 - 600;
    await fsp.utimes(filePath, old, old);
    const runningRow = { ...baseSession, status: "running" as const };
    const next = await deriveCliStatus(runningRow, filePath);
    expect(next).toBe("idle");
  });

  it("mtime > 20s but < 60s: errs on idle, not running", async () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "still thinking" }],
        },
      },
    ]);
    // 30s old — inside the old 60s window but outside our new 20s one.
    const old = Date.now() / 1000 - 30;
    await fsp.utimes(filePath, old, old);
    const runningRow = { ...baseSession, status: "running" as const };
    const next = await deriveCliStatus(runningRow, filePath);
    expect(next).toBe("idle");
  });

  it("flips a stale running → idle when tail has stop_reason", async () => {
    const filePath = writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        },
      },
    ]);
    const old = Date.now() / 1000 - 600;
    await fsp.utimes(filePath, old, old);
    const runningRow = { ...baseSession, status: "running" as const };
    const next = await deriveCliStatus(runningRow, filePath);
    expect(next).toBe("idle");
  });
});
