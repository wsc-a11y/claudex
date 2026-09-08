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
  parseClaudeProcess,
  buildPidSessionMap,
  reconcile,
  newestJsonlSessionId,
} from "../src/cli-sync/process-scanner.js";
import { tempConfig } from "./helpers.js";

/**
 * Process scanner unit + integration tests. No real `claude` processes are
 * spawned — we inject `listProcesses` / `getCwdForPid` deps and drive the
 * scanner's reconciliation synchronously via the returned helper.
 *
 * Separately, the argv parser is a pure function so we cover its edge cases
 * (basename filter, --resume / -r alternation, stale-uuid rejection) directly.
 */

const SDK_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SDK_B = "bbbbbbbb-5555-6666-7777-888888888888";

describe("parseClaudeProcess", () => {
  it("matches plain `claude` invocations", () => {
    expect(parseClaudeProcess("claude")).toEqual({ kind: "plain" });
    expect(parseClaudeProcess("/usr/local/bin/claude")).toEqual({
      kind: "plain",
    });
    expect(parseClaudeProcess("/opt/homebrew/bin/claude  ")).toEqual({
      kind: "plain",
    });
  });

  it("extracts the uuid from --resume / -r", () => {
    expect(parseClaudeProcess(`claude --resume ${SDK_A}`)).toEqual({
      kind: "resume",
      sessionId: SDK_A,
    });
    expect(parseClaudeProcess(`/usr/local/bin/claude -r ${SDK_B}`)).toEqual({
      kind: "resume",
      sessionId: SDK_B,
    });
    // Extra flags around --resume should still match.
    expect(
      parseClaudeProcess(`claude --model opus --resume ${SDK_A} --verbose`),
    ).toEqual({ kind: "resume", sessionId: SDK_A });
  });

  it("rejects non-claude basenames", () => {
    expect(parseClaudeProcess("claudex")).toBeNull();
    expect(parseClaudeProcess("/usr/local/bin/claudex")).toBeNull();
    expect(parseClaudeProcess("claude-code")).toBeNull();
    expect(parseClaudeProcess("node /path/to/claudex/server/dist/index.js")).toBeNull();
    expect(parseClaudeProcess("")).toBeNull();
  });

  it("falls back to plain when --resume is present but uuid is malformed", () => {
    // Malformed uuid → we don't treat it as a resume. Plain-`claude` kind
    // still applies because the basename matches.
    expect(parseClaudeProcess("claude --resume not-a-uuid")).toEqual({
      kind: "plain",
    });
  });
});

describe("newestJsonlSessionId", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("returns the newest jsonl's session id, ignoring non-uuids + non-jsonls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-pscan-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const slug = "-tmp-proj";
    const dir = path.join(root, slug);
    fs.mkdirSync(dir, { recursive: true });
    // Older file
    const older = path.join(dir, `${SDK_A}.jsonl`);
    fs.writeFileSync(older, "x");
    await fsp.utimes(older, new Date("2020-01-01"), new Date("2020-01-01"));
    // Newer file
    const newer = path.join(dir, `${SDK_B}.jsonl`);
    fs.writeFileSync(newer, "x");
    await fsp.utimes(newer, new Date("2024-01-01"), new Date("2024-01-01"));
    // Non-uuid + non-jsonl distractions
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, "garbage.jsonl"), "x");

    const result = await newestJsonlSessionId(root, slug);
    expect(result).toBe(SDK_B);
  });

  it("returns null for a missing slug directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-pscan-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = await newestJsonlSessionId(root, "-does-not-exist");
    expect(result).toBeNull();
  });
});

describe("buildPidSessionMap", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("maps --resume argv directly, and plain claude via cwd→slug→jsonl", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-pscan-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    // Plain-claude worker: pid 222 has cwd /tmp/proj-x → slug `-tmp-proj-x`,
    // newest jsonl under that slug is SDK_B.
    const slug = "-tmp-proj-x";
    fs.mkdirSync(path.join(root, slug), { recursive: true });
    fs.writeFileSync(path.join(root, slug, `${SDK_B}.jsonl`), "x");

    const map = await buildPidSessionMap({
      listProcesses: () => [
        { pid: 111, args: `claude --resume ${SDK_A}` },
        { pid: 222, args: "claude" },
        { pid: 333, args: "claudex" }, // filtered out
        { pid: 444, args: "node /foo/claudex/server" }, // filtered out
      ],
      getCwdForPid: (pid) => (pid === 222 ? "/tmp/proj-x" : null),
      cliProjectsRoot: root,
    });

    expect(map.get(111)).toBe(SDK_A);
    expect(map.get(222)).toBe(SDK_B);
    expect(map.has(333)).toBe(false);
    expect(map.has(444)).toBe(false);
  });

  it("skips plain-claude when cwd lookup fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-pscan-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const map = await buildPidSessionMap({
      listProcesses: () => [{ pid: 222, args: "claude" }],
      getCwdForPid: () => null,
      cliProjectsRoot: root,
    });
    expect(map.size).toBe(0);
  });
});

describe("reconcile (idle ↔ cli_running)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) {
      const c = cleanups.pop()!;
      await c();
    }
  });

  function setup() {
    const { config, log, cleanup } = tempConfig();
    const { db, close } = openDb(config, log);
    const sessions = new SessionStore(db);
    const projects = new ProjectStore(db);

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
      broadcast: (sessionId, event) => {
        broadcasts.push({ sessionId, event });
      },
    });

    cleanups.push(() => {
      close();
      cleanup();
    });

    // Helper: create a session with a chosen sdkSessionId + status.
    const mkSession = (
      title: string,
      sdkId: string | null,
      status:
        | "idle"
        | "running"
        | "cli_running"
        | "awaiting"
        | "archived"
        | "error",
    ) => {
      const project = projects.upsertByPath({
        name: "proj",
        path: "/tmp/proj",
      });
      const s = sessions.create({
        title,
        projectId: project.id,
        model: "claude-opus-4-8",
        mode: "default",
      });
      if (sdkId) sessions.setSdkSessionId(s.id, sdkId);
      if (status !== "idle") sessions.setStatus(s.id, status);
      return sessions.findById(s.id)!;
    };

    return { sessions, projects, manager, broadcasts, mkSession };
  }

  it("promotes idle → cli_running when the session's sdk id is live", () => {
    const ctx = setup();
    const s = ctx.mkSession("a", SDK_A, "idle");
    const result = reconcile(
      ctx.sessions,
      ctx.manager,
      new Set([SDK_A]),
    );
    expect(result.promoted).toEqual([s.id]);
    expect(ctx.sessions.findById(s.id)!.status).toBe("cli_running");
    const statusFrames = ctx.broadcasts.filter(
      (b) => b.event.type === "status",
    );
    expect(statusFrames.length).toBe(1);
    if (statusFrames[0].event.type === "status") {
      expect(statusFrames[0].event.status).toBe("cli_running");
    }
  });

  it("demotes cli_running → idle when the session's sdk id is no longer live", () => {
    const ctx = setup();
    const s = ctx.mkSession("a", SDK_A, "cli_running");
    const result = reconcile(ctx.sessions, ctx.manager, new Set());
    expect(result.demoted).toEqual([s.id]);
    expect(ctx.sessions.findById(s.id)!.status).toBe("idle");
    const statusFrames = ctx.broadcasts.filter(
      (b) => b.event.type === "status",
    );
    expect(statusFrames.length).toBe(1);
    if (statusFrames[0].event.type === "status") {
      expect(statusFrames[0].event.status).toBe("idle");
    }
  });

  it("leaves running / awaiting / error / archived untouched even if live", () => {
    const ctx = setup();
    const running = ctx.mkSession("running", SDK_A, "running");
    const awaiting = ctx.mkSession("awaiting", SDK_B, "awaiting");
    const errored = ctx.mkSession(
      "error",
      "cccccccc-aaaa-bbbb-cccc-dddddddddddd",
      "error",
    );
    const archived = ctx.mkSession(
      "archived",
      "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb",
      "archived",
    );

    const result = reconcile(
      ctx.sessions,
      ctx.manager,
      new Set([
        SDK_A,
        SDK_B,
        "cccccccc-aaaa-bbbb-cccc-dddddddddddd",
        "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb",
      ]),
    );
    expect(result.promoted).toEqual([]);
    expect(result.demoted).toEqual([]);
    expect(ctx.sessions.findById(running.id)!.status).toBe("running");
    expect(ctx.sessions.findById(awaiting.id)!.status).toBe("awaiting");
    expect(ctx.sessions.findById(errored.id)!.status).toBe("error");
    expect(ctx.sessions.findById(archived.id)!.status).toBe("archived");
  });

  it("no-ops for idle sessions without an sdkSessionId", () => {
    const ctx = setup();
    const s = ctx.mkSession("orphan", null, "idle");
    const result = reconcile(ctx.sessions, ctx.manager, new Set([SDK_A]));
    expect(result.promoted).toEqual([]);
    expect(ctx.sessions.findById(s.id)!.status).toBe("idle");
  });
});
