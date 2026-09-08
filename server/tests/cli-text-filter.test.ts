import { describe, it, expect } from "vitest";
import { stripHarnessNoise } from "../src/sessions/cli-text-filter.js";

/**
 * Unit tests for the harness-injection stripper. We pin exact behavior on the
 * tag set that appears in real CLI JSONL transcripts, plus the one-liner
 * "still typed content" case that must NOT be touched.
 */
describe("stripHarnessNoise", () => {
  it("returns empty when the whole text is a task-notification", () => {
    const text = [
      "<task-notification>",
      "<task-id>b3opplgac</task-id>",
      "<tool-use-id>toolu_abc</tool-use-id>",
      "<status>completed</status>",
      '<summary>Background command "foo" completed</summary>',
      "</task-notification>",
    ].join("\n");
    expect(stripHarnessNoise(text)).toBe("");
  });

  it("returns empty when the whole text is a system-reminder", () => {
    const text =
      "<system-reminder>\nYou have skills X, Y, Z available.\n</system-reminder>";
    expect(stripHarnessNoise(text)).toBe("");
  });

  it("returns empty for the slash-command echo triplet", () => {
    const text = [
      "<command-message>claude-api</command-message>",
      "<command-name>/claude-api</command-name>",
      "<local-command-stdout>ok</local-command-stdout>",
    ].join("\n");
    expect(stripHarnessNoise(text)).toBe("");
  });

  it("returns empty for a user-prompt-submit-hook block", () => {
    const text =
      "<user-prompt-submit-hook>auto-injected context\nline2</user-prompt-submit-hook>";
    expect(stripHarnessNoise(text)).toBe("");
  });

  it("keeps real user text when mixed with a task-notification", () => {
    const text = [
      "<task-notification>",
      "<status>completed</status>",
      "</task-notification>",
      "",
      "Now please fix the bug in routes.ts.",
    ].join("\n");
    expect(stripHarnessNoise(text)).toBe(
      "Now please fix the bug in routes.ts.",
    );
  });

  it("keeps real user text when mixed with a system-reminder", () => {
    const text = [
      "hi there — quick question:",
      "<system-reminder>remember the coding style</system-reminder>",
      "can you explain this function?",
    ].join("\n");
    const out = stripHarnessNoise(text);
    expect(out).toContain("hi there");
    expect(out).toContain("can you explain this function?");
    expect(out).not.toContain("<system-reminder>");
    expect(out).not.toContain("remember the coding style");
  });

  it("leaves plain typed text unchanged", () => {
    expect(stripHarnessNoise("hi")).toBe("hi");
    expect(stripHarnessNoise("  fix the bug please  ")).toBe(
      "fix the bug please",
    );
  });

  it("leaves text with unrelated angle-bracket content alone", () => {
    // Code snippets in user prompts must not be mangled.
    const text = "Does <div>hello</div> render correctly?";
    expect(stripHarnessNoise(text)).toBe(text);
  });

  it("is idempotent: running twice matches running once", () => {
    const text = [
      "<system-reminder>foo</system-reminder>",
      "real content",
      "<task-notification><status>ok</status></task-notification>",
    ].join("\n");
    const once = stripHarnessNoise(text);
    const twice = stripHarnessNoise(once);
    expect(twice).toBe(once);
    expect(once).toBe("real content");
  });

  it("strips multiple task-notifications in one payload", () => {
    const text = [
      "<task-notification><status>completed</status></task-notification>",
      "<task-notification><status>completed</status></task-notification>",
    ].join("\n");
    expect(stripHarnessNoise(text)).toBe("");
  });

  it("handles the empty string", () => {
    expect(stripHarnessNoise("")).toBe("");
  });
});
