import { describe, it, expect } from "vitest";
import { summarizePermission } from "../src/sessions/permission-summary.js";

describe("summarizePermission", () => {
  it("Bash shows the command as blast radius", () => {
    const r = summarizePermission("Bash", { command: "ls -la" });
    expect(r.summary).toMatch(/Run shell/i);
    expect(r.blastRadius).toContain("ls -la");
  });

  it("Edit shows the file path", () => {
    const r = summarizePermission("Edit", { file_path: "/x/y.ts" });
    expect(r.summary).toMatch(/Edit/);
    expect(r.blastRadius).toBe("/x/y.ts");
  });

  it("Write distinguishes create vs overwrite", () => {
    const create = summarizePermission("Write", {
      file_path: "/new.ts",
      content: "",
    });
    const overwrite = summarizePermission("Write", {
      file_path: "/new.ts",
      content: "payload",
    });
    expect(create.summary).toMatch(/Create/);
    expect(overwrite.summary).toMatch(/Overwrite/);
  });

  it("MultiEdit counts edits", () => {
    const r = summarizePermission("MultiEdit", {
      file_path: "/a.ts",
      edits: [1, 2, 3],
    });
    expect(r.summary).toMatch(/3 places/);
  });

  it("Read shows path", () => {
    expect(
      summarizePermission("Read", { file_path: "/foo.txt" }).blastRadius,
    ).toBe("/foo.txt");
  });

  it("Glob/Grep show pattern", () => {
    expect(
      summarizePermission("Glob", { pattern: "**/*.ts" }).blastRadius,
    ).toBe("**/*.ts");
    expect(
      summarizePermission("Grep", { pattern: "TODO" }).blastRadius,
    ).toBe("TODO");
  });

  it("WebFetch / WebSearch show URL / query", () => {
    expect(
      summarizePermission("WebFetch", {
        url: "https://example.com",
      }).blastRadius,
    ).toBe("https://example.com");
    expect(
      summarizePermission("WebSearch", { query: "anthropic" }).blastRadius,
    ).toBe("anthropic");
  });

  it("falls back to 'Use <tool>' for unknowns", () => {
    const r = summarizePermission("Custom", { foo: 1 });
    expect(r.summary).toMatch(/Use Custom/);
    expect(r.blastRadius).toBeNull();
  });

  it("handles missing input fields", () => {
    expect(summarizePermission("Bash", {}).blastRadius).toBeNull();
    expect(summarizePermission("Edit", {}).blastRadius).toBeNull();
  });
});
