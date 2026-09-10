import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeSlug,
  encodeCwdToSlug,
  listCliSessions,
  pickTitle,
  readCliSessionTitle,
  resolveSlugToPath,
  truncateTitle,
  type TitleRecords,
} from "../src/sessions/cli-discovery.js";

/**
 * Tests for the CLI session discovery layer. We never poke the developer's
 * real `~/.claude/projects` — every test builds its own tmp tree and passes
 * it in as the `root` argument.
 */

function mkTmp(prefix: string, disposers: Array<() => void>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  disposers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(
  root: string,
  slug: string,
  sessionId: string,
  lines: unknown[],
): void {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("decodeSlug", () => {
  it("reverses the CLI's / → - encoding", () => {
    expect(decodeSlug("-Users-hao-Code-claudex")).toBe(
      "/Users/hao/Code/claudex",
    );
  });

  it("tolerates slugs without a leading dash (nothing really has this, but defensive)", () => {
    expect(decodeSlug("Users-hao")).toBe("/Users/hao");
  });

  it("documents the real-dash ambiguity — my-dir and my/dir collide", () => {
    // Both would slug to the same string; decoding therefore produces /my/dir
    // for either input. Pinning this into a test so a future refactor
    // doesn't silently claim to "fix" it.
    expect(decodeSlug("-my-dir")).toBe("/my/dir");
  });

  it("restores a Windows drive-letter prefix (X-- → X:\\) and keeps body verbatim", () => {
    // The CLI turns `D:\Code\Golang\management-be-go` into a slug where both
    // `:` and `\` become `-`, yielding `D--Code-Golang-management-be-go`.
    // We can't tell separator-dashes from real dashes in the body, so we
    // restore the drive and leave the rest alone — the user knows their path.
    expect(decodeSlug("D--Code-Golang-management-be-go")).toBe(
      "D:\\Code-Golang-management-be-go",
    );
  });

  it("accepts a Windows slug with a leading dash too", () => {
    expect(decodeSlug("-D--Code-Golang-management-be-go")).toBe(
      "D:\\Code-Golang-management-be-go",
    );
  });
});

describe("resolveSlugToPath", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("matches a knownPaths hint exactly, no fs probing", () => {
    // Even when /Users/haowu/Code/AI/kollab/api would also exist on disk in
    // a hypothetical scenario, the known-path hint wins when it round-trips.
    expect(
      resolveSlugToPath("-Users-haowu-Code-AI-kollab-api", {
        knownPaths: ["/Users/haowu/Code/AI/kollab-api"],
      }),
    ).toBe("/Users/haowu/Code/AI/kollab-api");
  });

  it("ignores knownPaths that don't re-encode to the slug", () => {
    expect(
      resolveSlugToPath("-tmp-foo-bar", {
        knownPaths: ["/some/unrelated/path"],
      }),
    ).toBe("/tmp/foo/bar"); // falls through to naive (nothing on disk for this synthetic case)
  });

  it("disambiguates a real-dash directory by probing the filesystem", () => {
    // Build <root>/proj-name on disk; the slug for realDir should resolve
    // to that, not <root>/proj/name. encodeCwdToSlug keeps this test
    // platform-agnostic (the old split("/") construction produced a
    // non-slug on Windows backslash paths, which is why this used to fail
    // there).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-"));
    disposers.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const realDir = path.join(root, "proj-name");
    fs.mkdirSync(realDir);

    const slug = encodeCwdToSlug(realDir);
    expect(resolveSlugToPath(slug)).toBe(realDir);
  });

  it("prefers the all-separators decoding when both candidates exist", () => {
    // /<tmp>/a/b AND /<tmp>/a-b both exist — we pick /<tmp>/a/b because the
    // mask-by-Hamming-weight order tries fewest literal dashes first, and
    // the CLI's most common case is "all dashes are separators".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-"));
    disposers.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(root, "a-b"));

    const slug = encodeCwdToSlug(path.join(root, "a-b"));
    expect(resolveSlugToPath(slug)).toBe(path.join(root, "a", "b"));
  });

  it("falls back to lossy naive decode when nothing exists on disk", () => {
    // No /definitely-not-a-real-path-xyz123, so we get the naive split.
    expect(resolveSlugToPath("-definitely-not-a-real-path-xyz123")).toBe(
      "/definitely/not/a/real/path/xyz123",
    );
  });

  it("preserves Windows drive-letter slugs unchanged", () => {
    expect(resolveSlugToPath("D--Code-Golang-management-be-go")).toBe(
      "D:\\Code-Golang-management-be-go",
    );
  });

  it("resolves a Windows slug to a registered real path via knownPaths", () => {
    // The regression that made forks of adopted CLI sessions unstartable:
    // resolveSlugToPath("C--Users-80549-Desktop-LoongArch") used to return
    // the lossy "C:\Users-80549-Desktop-LoongArch" (a directory that doesn't
    // exist) because encodeCwdToSlug returned Windows paths verbatim, so the
    // knownPaths hint never matched. The hint must now win on every
    // platform.
    expect(
      resolveSlugToPath("C--Users-80549-Desktop-LoongArch", {
        knownPaths: ["C:\\Users\\80549\\Desktop\\LoongArch"],
      }),
    ).toBe("C:\\Users\\80549\\Desktop\\LoongArch");
  });

  it("encodes Windows cwds with the CLI's blanket character rule", () => {
    // Real transcript evidence: c:\Users\80549\Desktop\新建文件夹 (3) lives
    // under slug c--Users-80549-Desktop--------3- (every non-ASCII char —
    // 中文, space, parens — becomes its own '-').
    const real = "c:\\Users\\80549\\Desktop\\新建文件夹 (3)";
    const slug = real.replace(/[^A-Za-z0-9]/g, "-");
    expect(slug).toBe("c--Users-80549-Desktop--------3-");
    expect(resolveSlugToPath("C--Users-80549-Desktop-LoongArch", {
      knownPaths: ["C:\\Users\\80549\\Desktop\\LoongArch", real],
    })).toBe("C:\\Users\\80549\\Desktop\\LoongArch");
  });

  it.skipIf(process.platform !== "win32")(
    "probes the filesystem for a Windows real-dash directory",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rspw-"));
      disposers.push(() => fs.rmSync(root, { recursive: true, force: true }));
      const realDir = path.join(root, "proj-name");
      fs.mkdirSync(realDir);
      // Drive-prefixed slug for realDir, e.g. C--Users-...-rspw-x-proj-name.
      const slug =
        realDir.charAt(0) +
        "--" +
        realDir.slice(3).replace(/[^A-Za-z0-9]/g, "-");
      expect(resolveSlugToPath(slug)).toBe(realDir);
    },
  );
});

describe("truncateTitle", () => {
  it("returns short strings unchanged", () => {
    expect(truncateTitle("hello", 60)).toBe("hello");
  });

  it("collapses whitespace", () => {
    expect(truncateTitle("line one\n\n line two", 60)).toBe(
      "line one line two",
    );
  });

  it("truncates long strings with an ellipsis", () => {
    const out = truncateTitle("a".repeat(100), 60);
    expect(out.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("prefers a word boundary when one exists near the cut", () => {
    const input = "hello world " + "x".repeat(80);
    const out = truncateTitle(input, 20);
    // Should break at a space, not mid-word. Under 20 chars of content.
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(22);
  });
});

describe("listCliSessions", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("returns [] when the root does not exist", async () => {
    const result = await listCliSessions("/nope/does/not/exist");
    expect(result).toEqual([]);
  });

  it("returns [] when the root is empty", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    expect(await listCliSessions(root)).toEqual([]);
  });

  it("summarizes a single session with title from first user message", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    const sessionId = "abc-123";
    writeJsonl(root, "-tmp-proj", sessionId, [
      { type: "queue-operation", operation: "enqueue" },
      {
        type: "user",
        message: { role: "user", content: "build me a blog engine please" },
        sessionId,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: "ok" },
        sessionId,
      },
    ]);

    const result = await listCliSessions(root);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe(sessionId);
    expect(result[0].cwd).toBe("/tmp/proj");
    expect(result[0].firstUserMessage).toBe("build me a blog engine please");
    expect(result[0].title).toBe("build me a blog engine please");
    expect(result[0].fileSize).toBeGreaterThan(0);
    expect(result[0].lineCount).toBeGreaterThanOrEqual(3);
  });

  it("prefers the CLI's own ai-title over the first user message", async () => {
    // The regression that made claudex titles disagree with the VS Code
    // extension: the CLI writes ai-title records and its own session list
    // shows THOSE, not the first message.
    const root = mkTmp("claudex-cli-disc-", disposers);
    const sessionId = "sess-titled";
    writeJsonl(root, "-tmp-proj", sessionId, [
      { type: "user", message: { role: "user", content: "做一个内网隧穿" } },
      { type: "ai-title", sessionId, aiTitle: "配置内网穿透实现外网访问" },
    ]);
    const result = await listCliSessions(root);
    expect(result[0].title).toBe("配置内网穿透实现外网访问");
    // The fallback is still reported — it's what the Import sheet shows as
    // the "first message", independent of the chosen title.
    expect(result[0].firstUserMessage).toBe("做一个内网隧穿");
  });

  it("falls back to last-prompt when there is no ai-title", async () => {
    // Real transcript evidence: ab91b359 has NO ai-title record at all, and
    // the extension titles it from lastPrompt ("我想了解cloudflare免费性能如何").
    const root = mkTmp("claudex-cli-disc-", disposers);
    writeJsonl(root, "-tmp-proj", "sess-lp", [
      { type: "user", message: { role: "user", content: "做一个内网隧穿" } },
      { type: "last-prompt", lastPrompt: "我想了解cloudflare免费性能如何" },
    ]);
    const result = await listCliSessions(root);
    expect(result[0].title).toBe("我想了解cloudflare免费性能如何");
  });

  it("uses the LAST ai-title when the CLI rewrites it mid-session", async () => {
    // ai-title is re-emitted as the conversation evolves; the value that
    // counts is the newest one. Stopping the scan early would surface a
    // stale title.
    const root = mkTmp("claudex-cli-disc-", disposers);
    writeJsonl(root, "-tmp-proj", "sess-rewrite", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "ai-title", aiTitle: "stale title" },
      { type: "last-prompt", lastPrompt: "some later prompt" },
      { type: "ai-title", aiTitle: "fresh title" },
    ]);
    const result = await listCliSessions(root);
    expect(result[0].title).toBe("fresh title");
  });

  it("lets a custom-title stick even when ai-title follows", async () => {
    // The extension locks the scan on the first custom-title: a user rename
    // must survive later AI retitling.
    const root = mkTmp("claudex-cli-disc-", disposers);
    writeJsonl(root, "-tmp-proj", "sess-custom", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "custom-title", customTitle: "我改的名字" },
      { type: "ai-title", aiTitle: "AI 后来又想改的名字" },
    ]);
    const result = await listCliSessions(root);
    expect(result[0].title).toBe("我改的名字");
  });

  it("ignores title records that aren't strings or are blank", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    writeJsonl(root, "-tmp-proj", "sess-blank", [
      { type: "user", message: { role: "user", content: "real message" } },
      { type: "ai-title", aiTitle: "" },
      { type: "ai-title", aiTitle: 42 },
      { type: "last-prompt", lastPrompt: "   " },
    ]);
    const result = await listCliSessions(root);
    expect(result[0].title).toBe("real message");
  });

  it("truncates a long first user message into a title with ellipsis", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    const longMsg = "a".repeat(200);
    writeJsonl(root, "-big-proj", "sess-long", [
      { type: "user", message: { role: "user", content: longMsg } },
    ]);
    const result = await listCliSessions(root);
    expect(result[0].title.length).toBeLessThanOrEqual(61);
    expect(result[0].title.endsWith("…")).toBe(true);
  });

  it("handles content as an array of blocks", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    writeJsonl(root, "-arr-proj", "sess-arr", [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hi from block" }],
        },
      },
    ]);
    const result = await listCliSessions(root);
    expect(result[0].title).toBe("hi from block");
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    const dir = path.join(root, "-bad-proj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sess-bad.jsonl"),
      [
        "not-json",
        JSON.stringify({ type: "queue-operation" }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "survived" },
        }),
      ].join("\n") + "\n",
    );
    const result = await listCliSessions(root);
    expect(result).toHaveLength(1);
    expect(result[0].firstUserMessage).toBe("survived");
  });

  it("falls back to a placeholder title when no user message is found", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    writeJsonl(root, "-empty-proj", "sess-empty", [
      { type: "queue-operation" },
      { type: "assistant", message: { role: "assistant", content: "noop" } },
    ]);
    const result = await listCliSessions(root);
    expect(result[0].firstUserMessage).toBeNull();
    expect(result[0].title).toBe("Untitled CLI session");
  });

  it("orders sessions newest-first by mtime", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    writeJsonl(root, "-proj-a", "older", [
      { type: "user", message: { role: "user", content: "old" } },
    ]);
    // Touch a second session with a newer mtime.
    writeJsonl(root, "-proj-b", "newer", [
      { type: "user", message: { role: "user", content: "new" } },
    ]);
    const olderFile = path.join(root, "-proj-a", "older.jsonl");
    const newerFile = path.join(root, "-proj-b", "newer.jsonl");
    const base = Date.now();
    fs.utimesSync(olderFile, new Date(base - 10_000), new Date(base - 10_000));
    fs.utimesSync(newerFile, new Date(base), new Date(base));

    const result = await listCliSessions(root);
    expect(result.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });

  it("ignores non-jsonl files under a project dir", async () => {
    const root = mkTmp("claudex-cli-disc-", disposers);
    const dir = path.join(root, "-mixed-proj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.md"), "# scratch");
    writeJsonl(root, "-mixed-proj", "sess-real", [
      { type: "user", message: { role: "user", content: "hello" } },
    ]);
    const result = await listCliSessions(root);
    expect(result.map((s) => s.sessionId)).toEqual(["sess-real"]);
  });
});

describe("pickTitle", () => {
  const empty: TitleRecords = {
    customTitle: null,
    aiTitle: null,
    lastPrompt: null,
    summary: null,
  };

  it("applies the extension's precedence order", () => {
    expect(
      pickTitle(
        {
          customTitle: "custom",
          aiTitle: "ai",
          lastPrompt: "last",
          summary: "summary",
        },
        "first msg",
      ),
    ).toBe("custom");
    expect(
      pickTitle({ ...empty, aiTitle: "ai", lastPrompt: "last" }, "first msg"),
    ).toBe("ai");
    expect(pickTitle({ ...empty, lastPrompt: "last" }, "first msg")).toBe(
      "last",
    );
    expect(pickTitle({ ...empty, summary: "summary" }, "first msg")).toBe(
      "summary",
    );
  });

  it("falls back to the first user message, then null", () => {
    expect(pickTitle(empty, "first msg")).toBe("first msg");
    expect(pickTitle(empty, null)).toBeNull();
    expect(pickTitle(empty, "")).toBeNull();
  });

  it("treats whitespace-only records as absent", () => {
    // A blank ai-title must not shadow a perfectly good first message.
    expect(pickTitle({ ...empty, aiTitle: "   " }, "first msg")).toBe(
      "first msg",
    );
  });

  it("truncates to 60 chars with an ellipsis", () => {
    const out = pickTitle(empty, "a".repeat(200));
    expect(out!.length).toBeLessThanOrEqual(61);
    expect(out!.endsWith("…")).toBe(true);
  });
});

describe("readCliSessionTitle", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("reads ai-title from a JSONL file on disk", async () => {
    const root = mkTmp("claudex-cli-title-", disposers);
    writeJsonl(root, "-p", "sess", [
      { type: "user", message: { role: "user", content: "ask" } },
      { type: "ai-title", aiTitle: "派生标题" },
    ]);
    const title = await readCliSessionTitle(
      path.join(root, "-p", "sess.jsonl"),
    );
    expect(title).toBe("派生标题");
  });

  it("returns the placeholder when the transcript has nothing usable", async () => {
    const root = mkTmp("claudex-cli-title-", disposers);
    writeJsonl(root, "-p", "sess-empty", [{ type: "queue-operation" }]);
    const title = await readCliSessionTitle(
      path.join(root, "-p", "sess-empty.jsonl"),
    );
    expect(title).toBe("Untitled CLI session");
  });

  it("survives malformed lines without throwing", async () => {
    const root = mkTmp("claudex-cli-title-", disposers);
    const dir = path.join(root, "-p");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sess-bad.jsonl"),
      [
        "not json at all",
        JSON.stringify({ type: "user", message: { role: "user", content: "ok" } }),
        "{ broken",
        JSON.stringify({ type: "ai-title", aiTitle: "还是拿到了" }),
      ].join("\n") + "\n",
    );
    const title = await readCliSessionTitle(path.join(dir, "sess-bad.jsonl"));
    expect(title).toBe("还是拿到了");
  });
});
