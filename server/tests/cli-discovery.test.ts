import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeSlug,
  listCliSessions,
  resolveSlugToPath,
  truncateTitle,
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
    // Build /<tmp>/proj-name on disk; the slug -<tmp>-proj-name should
    // resolve to that, not /<tmp>/proj/name.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-"));
    disposers.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const realDir = path.join(root, "proj-name");
    fs.mkdirSync(realDir);

    // Build the slug for realDir (every "/" → "-").
    const slug = realDir.split("/").join("-");
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

    const slug = (root + "/a-b").split("/").join("-");
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
