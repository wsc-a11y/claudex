import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import {
  backfillCliSessionTitles,
  refreshCliSessionTitle,
} from "../src/sessions/backfill-cli-titles.js";
import { encodeCwdToSlug } from "../src/sessions/cli-discovery.js";
import { tempConfig } from "./helpers.js";

function setup(disposers: Array<() => void>) {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cli-bf-"));
  const projectPath = path.join(root, "proj");
  const project = projects.create({
    name: "proj",
    path: projectPath,
    trusted: true,
  });
  disposers.push(() => {
    close();
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { projects, sessions, project, root, projectPath };
}

/** Write a CLI transcript at the path claudex will look for, i.e.
 *  <root>/<encodeCwdToSlug(projectPath)>/<sdkId>.jsonl. */
function writeTranscript(
  root: string,
  projectPath: string,
  sdkId: string,
  lines: unknown[],
): string {
  const dir = path.join(root, encodeCwdToSlug(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sdkId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

/** Create an adopted session whose stored title is the pre-fix derivation
 *  (the truncated first user message), which is what makes the backfill
 *  consider it a candidate. */
function adoptedSession(
  s: ReturnType<typeof setup>,
  opts: { sdkId: string; title: string; firstUserText?: string },
) {
  const session = s.sessions.create({
    title: opts.title,
    projectId: s.project.id,
    model: "claude-opus-4-8",
    mode: "default",
  });
  s.sessions.setSdkSessionId(session.id, opts.sdkId);
  s.sessions.setAdoptedFromCli(session.id, true);
  if (opts.firstUserText !== undefined) {
    s.sessions.appendEvent({
      sessionId: session.id,
      kind: "user_message",
      payload: { text: opts.firstUserText },
    });
  }
  return session;
}

describe("backfillCliSessionTitles", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("retitles an adopted session from the CLI's ai-title", async () => {
    const s = setup(disposers);
    const session = adoptedSession(s, {
      sdkId: "sdk-1",
      title: "做一个内网隧穿",
      firstUserText: "做一个内网隧穿",
    });
    writeTranscript(s.root, s.projectPath, "sdk-1", [
      { type: "user", message: { role: "user", content: "做一个内网隧穿" } },
      { type: "ai-title", aiTitle: "配置内网穿透实现外网访问" },
    ]);

    const res = await backfillCliSessionTitles({
      sessions: s.sessions,
      projects: s.projects,
      cliProjectsRoot: s.root,
    });

    expect(res.retitled).toBe(1);
    expect(s.sessions.findById(session.id)?.title).toBe(
      "配置内网穿透实现外网访问",
    );
  });

  it("leaves a hand-renamed title alone", async () => {
    // The stored title does NOT match the old derivation, so we must treat
    // it as user-chosen and never clobber it.
    const s = setup(disposers);
    const session = adoptedSession(s, {
      sdkId: "sdk-2",
      title: "我自己起的名字",
      firstUserText: "做一个内网隧穿",
    });
    writeTranscript(s.root, s.projectPath, "sdk-2", [
      { type: "user", message: { role: "user", content: "做一个内网隧穿" } },
      { type: "ai-title", aiTitle: "CLI 想改成的名字" },
    ]);

    const res = await backfillCliSessionTitles({
      sessions: s.sessions,
      projects: s.projects,
      cliProjectsRoot: s.root,
    });

    expect(res.retitled).toBe(0);
    expect(s.sessions.findById(session.id)?.title).toBe("我自己起的名字");
  });

  it("skips native (non-adopted) sessions entirely", async () => {
    const s = setup(disposers);
    const native = s.sessions.create({
      title: "hello",
      projectId: s.project.id,
      model: "claude-opus-4-8",
      mode: "default",
    });
    s.sessions.appendEvent({
      sessionId: native.id,
      kind: "user_message",
      payload: { text: "hello" },
    });

    const res = await backfillCliSessionTitles({
      sessions: s.sessions,
      projects: s.projects,
      cliProjectsRoot: s.root,
    });

    expect(res.retitled).toBe(0);
    expect(s.sessions.findById(native.id)?.title).toBe("hello");
  });

  it("skips adopted sessions whose transcript is missing", async () => {
    const s = setup(disposers);
    const session = adoptedSession(s, {
      sdkId: "sdk-missing",
      title: "hi",
      firstUserText: "hi",
    });

    const res = await backfillCliSessionTitles({
      sessions: s.sessions,
      projects: s.projects,
      cliProjectsRoot: s.root,
    });

    expect(res.retitled).toBe(0);
    expect(s.sessions.findById(session.id)?.title).toBe("hi");
  });

  it("is idempotent — a second run changes nothing", async () => {
    const s = setup(disposers);
    const session = adoptedSession(s, {
      sdkId: "sdk-3",
      title: "第一句",
      firstUserText: "第一句",
    });
    writeTranscript(s.root, s.projectPath, "sdk-3", [
      { type: "user", message: { role: "user", content: "第一句" } },
      { type: "ai-title", aiTitle: "AI 标题" },
    ]);

    const first = await backfillCliSessionTitles({
      sessions: s.sessions,
      projects: s.projects,
      cliProjectsRoot: s.root,
    });
    expect(first.retitled).toBe(1);

    const second = await backfillCliSessionTitles({
      sessions: s.sessions,
      projects: s.projects,
      cliProjectsRoot: s.root,
    });
    expect(second.retitled).toBe(0);
    expect(s.sessions.findById(session.id)?.title).toBe("AI 标题");
  });
});

describe("refreshCliSessionTitle", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("writes the new title and returns it when the transcript renamed", async () => {
    const s = setup(disposers);
    const session = adoptedSession(s, {
      sdkId: "sdk-r1",
      title: "旧标题",
      firstUserText: "hi",
    });
    const file = writeTranscript(s.root, s.projectPath, "sdk-r1", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "ai-title", aiTitle: "新标题" },
    ]);

    const out = await refreshCliSessionTitle({
      sessions: s.sessions,
      sessionId: session.id,
      currentTitle: "旧标题",
      jsonlPath: file,
    });

    expect(out).toBe("新标题");
    expect(s.sessions.findById(session.id)?.title).toBe("新标题");
  });

  it("returns null and writes nothing when the title is unchanged", async () => {
    const s = setup(disposers);
    const session = adoptedSession(s, {
      sdkId: "sdk-r2",
      title: "同一个标题",
      firstUserText: "hi",
    });
    const file = writeTranscript(s.root, s.projectPath, "sdk-r2", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "ai-title", aiTitle: "同一个标题" },
    ]);

    const out = await refreshCliSessionTitle({
      sessions: s.sessions,
      sessionId: session.id,
      currentTitle: "同一个标题",
      jsonlPath: file,
    });

    expect(out).toBeNull();
    expect(s.sessions.findById(session.id)?.title).toBe("同一个标题");
  });

  it("returns null instead of throwing when the transcript is unreadable", async () => {
    const s = setup(disposers);
    const session = adoptedSession(s, {
      sdkId: "sdk-r3",
      title: "keep me",
      firstUserText: "hi",
    });

    const out = await refreshCliSessionTitle({
      sessions: s.sessions,
      sessionId: session.id,
      currentTitle: "keep me",
      jsonlPath: path.join(s.root, "does-not-exist.jsonl"),
    });

    expect(out).toBeNull();
    expect(s.sessions.findById(session.id)?.title).toBe("keep me");
  });
});
