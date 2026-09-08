import { describe, it, expect } from "vitest";
import {
  aggregatePendingDiffs,
  diffForEdit,
  diffForToolCall,
  diffForWrite,
} from "../src/sessions/diffs.js";
import type { SessionEvent } from "@claudex/shared";

// ---------------------------------------------------------------------------
// Pure diff-building helpers
// ---------------------------------------------------------------------------

describe("diffForToolCall", () => {
  it("builds a single-hunk diff for an Edit", () => {
    const d = diffForToolCall("Edit", {
      file_path: "/repo/src/a.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;\nconst y = 3;",
    });
    expect(d).not.toBeNull();
    expect(d!.path).toBe("/repo/src/a.ts");
    expect(d!.kind).toBe("edit");
    expect(d!.addCount).toBe(2);
    expect(d!.delCount).toBe(1);
    expect(d!.hunks).toHaveLength(1);
    const lines = d!.hunks[0].lines;
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "add")).toHaveLength(2);
  });

  it("builds an all-additions diff for a Write to a new file", () => {
    const d = diffForToolCall("Write", {
      file_path: "/repo/NEW.md",
      content: "hello\nworld\n",
    });
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("create");
    expect(d!.addCount).toBe(2);
    expect(d!.delCount).toBe(0);
    expect(d!.hunks[0].lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("builds a multi-hunk diff for MultiEdit with two edits", () => {
    const d = diffForToolCall("MultiEdit", {
      file_path: "/repo/src/b.ts",
      edits: [
        { old_string: "a", new_string: "b\nc" },
        { old_string: "d\ne", new_string: "f" },
      ],
    });
    expect(d).not.toBeNull();
    expect(d!.hunks).toHaveLength(2);
    expect(d!.addCount).toBe(3); // 2 + 1
    expect(d!.delCount).toBe(3); // 1 + 2
  });

  it("returns null for an unknown tool name", () => {
    const d = diffForToolCall("Bash", {
      file_path: "/repo/x",
      command: "ls",
    });
    expect(d).toBeNull();
  });

  it("returns null when file_path is missing", () => {
    expect(diffForToolCall("Edit", {})).toBeNull();
    expect(diffForToolCall("Write", { content: "x" })).toBeNull();
    expect(diffForToolCall("MultiEdit", { edits: [] })).toBeNull();
  });

  it("tolerates malformed MultiEdit entries without throwing", () => {
    const d = diffForToolCall("MultiEdit", {
      file_path: "/repo/x",
      edits: [
        null, // skipped
        { old_string: "old", new_string: "new" },
      ],
    });
    expect(d).not.toBeNull();
    expect(d!.hunks).toHaveLength(1);
    expect(d!.addCount).toBe(1);
    expect(d!.delCount).toBe(1);
  });

  it("handles null / undefined / non-object input defensively", () => {
    expect(diffForToolCall("Edit", null as any)).toBeNull();
    expect(diffForToolCall("Edit", undefined as any)).toBeNull();
  });
});

describe("diffForWrite / diffForEdit direct call", () => {
  it("diffForWrite with previous content produces an overwrite", () => {
    const d = diffForWrite("/f", "new one\nnew two", "old one");
    expect(d.kind).toBe("overwrite");
    expect(d.addCount).toBe(2);
    expect(d.delCount).toBe(1);
  });

  it("diffForEdit preserves line numbers starting at 1", () => {
    const d = diffForEdit("/f", "x\ny", "a");
    const dels = d.hunks[0].lines.filter((l) => l.kind === "del");
    expect(dels.map((l) => l.oldNum)).toEqual([1, 2]);
    const adds = d.hunks[0].lines.filter((l) => l.kind === "add");
    expect(adds.map((l) => l.newNum)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// aggregatePendingDiffs — the real aggregator over a session event log.
// ---------------------------------------------------------------------------

function ev(
  partial: Partial<SessionEvent> & {
    kind: SessionEvent["kind"];
    payload: Record<string, unknown>;
  },
): SessionEvent {
  return {
    id: partial.id ?? `ev-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: partial.sessionId ?? "sess1",
    seq: partial.seq ?? 0,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    kind: partial.kind,
    payload: partial.payload,
  };
}

describe("aggregatePendingDiffs", () => {
  it("returns [] when the session has no diff-producing events", () => {
    const events: SessionEvent[] = [
      ev({
        kind: "user_message",
        payload: { text: "hi" },
      }),
      ev({
        kind: "assistant_text",
        payload: { text: "hello" },
      }),
    ];
    expect(aggregatePendingDiffs(events)).toEqual([]);
  });

  it("surfaces a pending permission_request as a diff with approvalId set", () => {
    const events: SessionEvent[] = [
      ev({
        kind: "permission_request",
        payload: {
          toolUseId: "tu-1",
          toolName: "Edit",
          input: {
            file_path: "/repo/a.ts",
            old_string: "a",
            new_string: "b",
          },
          title: "Edit file",
        },
      }),
    ];
    const out = aggregatePendingDiffs(events);
    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe("tu-1");
    expect(out[0].approvalId).toBe("tu-1");
    expect(out[0].kind).toBe("edit");
    expect(out[0].title).toBe("Edit file");
    expect(out[0].filePath).toBe("/repo/a.ts");
    expect(out[0].addCount).toBeGreaterThan(0);
  });

  it("drops a permission_request that already has a decision", () => {
    const events: SessionEvent[] = [
      ev({
        kind: "permission_request",
        payload: {
          toolUseId: "tu-1",
          toolName: "Edit",
          input: {
            file_path: "/repo/a.ts",
            old_string: "a",
            new_string: "b",
          },
          title: "Edit file",
        },
      }),
      ev({
        kind: "permission_decision",
        payload: { toolUseId: "tu-1", decision: "allow_once" },
      }),
    ];
    expect(aggregatePendingDiffs(events)).toEqual([]);
  });

  it("surfaces an in-flight tool_use (no tool_result) without approvalId", () => {
    const events: SessionEvent[] = [
      ev({
        kind: "tool_use",
        payload: {
          toolUseId: "tu-2",
          name: "Write",
          input: { file_path: "/repo/NEW.md", content: "hi" },
        },
      }),
    ];
    const out = aggregatePendingDiffs(events);
    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe("tu-2");
    expect(out[0].approvalId).toBeUndefined();
    expect(out[0].kind).toBe("write");
    expect(out[0].title).toBeNull();
  });

  it("drops a tool_use once its tool_result has been seen", () => {
    const events: SessionEvent[] = [
      ev({
        kind: "tool_use",
        payload: {
          toolUseId: "tu-3",
          name: "Edit",
          input: {
            file_path: "/repo/a.ts",
            old_string: "a",
            new_string: "b",
          },
        },
      }),
      ev({
        kind: "tool_result",
        payload: { toolUseId: "tu-3", content: "ok", isError: false },
      }),
    ];
    expect(aggregatePendingDiffs(events)).toEqual([]);
  });

  it("ignores Bash / Read / non-diff tools even when pending", () => {
    const events: SessionEvent[] = [
      ev({
        kind: "permission_request",
        payload: {
          toolUseId: "tu-4",
          toolName: "Bash",
          input: { command: "ls -la" },
          title: "Run shell command",
        },
      }),
      ev({
        kind: "tool_use",
        payload: {
          toolUseId: "tu-5",
          name: "Read",
          input: { file_path: "/repo/readme.md" },
        },
      }),
    ];
    expect(aggregatePendingDiffs(events)).toEqual([]);
  });

  it("does not double-count a permission_request and its own tool_use", () => {
    // When the SDK asks for permission, there's only a permission_request
    // event — no tool_use event yet. But tests sometimes synthesize both;
    // confirm the permission bucket wins so we don't emit two entries for
    // the same toolUseId.
    const events: SessionEvent[] = [
      ev({
        kind: "permission_request",
        payload: {
          toolUseId: "tu-6",
          toolName: "Edit",
          input: {
            file_path: "/repo/x.ts",
            old_string: "a",
            new_string: "b",
          },
          title: "Edit file",
        },
      }),
      ev({
        kind: "tool_use",
        payload: {
          toolUseId: "tu-6",
          name: "Edit",
          input: {
            file_path: "/repo/x.ts",
            old_string: "a",
            new_string: "b",
          },
        },
      }),
    ];
    const out = aggregatePendingDiffs(events);
    expect(out).toHaveLength(1);
    expect(out[0].approvalId).toBe("tu-6");
  });

  it("silently skips malformed payloads", () => {
    const events: SessionEvent[] = [
      ev({
        kind: "permission_request",
        payload: {
          toolUseId: "tu-bad",
          toolName: "Edit",
          input: {}, // no file_path
          title: "Edit file",
        },
      }),
      ev({
        kind: "tool_use",
        payload: {
          toolUseId: "tu-bad-2",
          name: "MultiEdit",
          input: { file_path: "/f", edits: [] },
        },
      }),
    ];
    expect(aggregatePendingDiffs(events)).toEqual([]);
  });
});
