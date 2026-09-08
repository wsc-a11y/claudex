/**
 * Server-side port of `web/src/lib/diff.ts`.
 *
 * The web bundle already has a tiny unified-diff builder that turns an Edit /
 * Write / MultiEdit tool call into a list of `{ kind, oldNum, newNum, text }`
 * lines. The full-screen Diff Review page (mockup s-06) wants the same shape
 * server-side so a single HTTP request can return every pending diff for a
 * session without the client having to replay `session_events` and recompute
 * them.
 *
 * Port rules:
 *   - Pure functions, no IO. Caller does the DB work.
 *   - Output shape (`FileDiff`) is identical to the web copy so the shared
 *     zod schema pins both ends to the same JSON.
 *   - Unknown tool names / malformed input return `null` — let the caller
 *     decide whether to skip quietly or surface it.
 *
 * We intentionally do NOT import `web/src/lib/diff.ts` — that lives in a
 * different package and would bring React/Vite build concerns into the
 * server. Duplication is cheap and the shape is frozen by the shared schema.
 */
import type {
  DiffHunk,
  DiffKind,
  DiffLine,
  FileDiff,
  PendingDiffEntry,
} from "@claudex/shared";
import type { SessionEvent } from "@claudex/shared";

export function diffForWrite(
  filePath: string,
  content: string,
  previousContent?: string,
): FileDiff {
  if (previousContent == null || previousContent.length === 0) {
    const lines = splitLines(content);
    return {
      path: filePath,
      kind: "create",
      addCount: lines.length,
      delCount: 0,
      hunks: [
        {
          header: `@@ ${filePath} — new file @@`,
          lines: lines.map((t, i) => ({
            kind: "add",
            oldNum: null,
            newNum: i + 1,
            text: t,
          })),
        },
      ],
    };
  }
  const oldLines = splitLines(previousContent);
  const newLines = splitLines(content);
  const lines: DiffLine[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    lines.push({ kind: "del", oldNum: i + 1, newNum: null, text: oldLines[i] });
  }
  for (let i = 0; i < newLines.length; i++) {
    lines.push({ kind: "add", oldNum: null, newNum: i + 1, text: newLines[i] });
  }
  return {
    path: filePath,
    kind: "overwrite",
    addCount: newLines.length,
    delCount: oldLines.length,
    hunks: [{ header: `@@ ${filePath} — overwrite @@`, lines }],
  };
}

export function diffForEdit(
  filePath: string,
  oldString: string,
  newString: string,
): FileDiff {
  const oldLines = splitLines(oldString);
  const newLines = splitLines(newString);
  const lines: DiffLine[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    lines.push({ kind: "del", oldNum: i + 1, newNum: null, text: oldLines[i] });
  }
  for (let i = 0; i < newLines.length; i++) {
    lines.push({ kind: "add", oldNum: null, newNum: i + 1, text: newLines[i] });
  }
  return {
    path: filePath,
    kind: "edit",
    addCount: newLines.length,
    delCount: oldLines.length,
    hunks: [{ header: `@@ ${filePath} @@`, lines }],
  };
}

/**
 * Turn a tool_use (`Edit` / `Write` / `MultiEdit`) into a `FileDiff`.
 * Returns null for unknown tools, missing `file_path`, or a MultiEdit
 * with no edits. Malformed input is coerced via `String(...)` where
 * possible — we'd rather show an empty diff than crash the whole
 * pending-diffs aggregation because one tool call had a bad shape.
 */
export function diffForToolCall(
  name: string,
  input: Record<string, unknown> | null | undefined,
): FileDiff | null {
  if (!input || typeof input !== "object") return null;
  const filePath = String((input as Record<string, unknown>).file_path ?? "");
  if (!filePath) return null;
  try {
    switch (name) {
      case "Write":
        return diffForWrite(
          filePath,
          String((input as Record<string, unknown>).content ?? ""),
        );
      case "Edit":
        return diffForEdit(
          filePath,
          String((input as Record<string, unknown>).old_string ?? ""),
          String((input as Record<string, unknown>).new_string ?? ""),
        );
      case "MultiEdit": {
        const rawEdits = (input as Record<string, unknown>).edits;
        const edits = Array.isArray(rawEdits) ? rawEdits : [];
        if (edits.length === 0) return null;
        const hunks: DiffHunk[] = [];
        let add = 0;
        let del = 0;
        for (const e of edits as Array<Record<string, unknown>>) {
          if (!e || typeof e !== "object") continue;
          const oldLines = splitLines(String(e.old_string ?? ""));
          const newLines = splitLines(String(e.new_string ?? ""));
          const lines: DiffLine[] = [];
          for (let i = 0; i < oldLines.length; i++) {
            lines.push({
              kind: "del",
              oldNum: i + 1,
              newNum: null,
              text: oldLines[i],
            });
          }
          for (let i = 0; i < newLines.length; i++) {
            lines.push({
              kind: "add",
              oldNum: null,
              newNum: i + 1,
              text: newLines[i],
            });
          }
          del += oldLines.length;
          add += newLines.length;
          hunks.push({ header: `@@ ${filePath} @@`, lines });
        }
        return {
          path: filePath,
          kind: "edit",
          addCount: add,
          delCount: del,
          hunks,
        };
      }
      default:
        return null;
    }
  } catch {
    // Defensive — any per-call failure shouldn't sink the whole
    // aggregation. Surface as "no diff for this call".
    return null;
  }
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Aggregation over a session's event log
// ---------------------------------------------------------------------------

/**
 * Kind tag matching the PendingDiffEntry discriminator. `MultiEdit` has its
 * own bucket because the UI labels it distinctly; Write collapses create /
 * overwrite into one.
 */
function kindTagForTool(name: string): PendingDiffEntry["kind"] | null {
  switch (name) {
    case "Edit":
      return "edit";
    case "Write":
      return "write";
    case "MultiEdit":
      return "multiedit";
    default:
      return null;
  }
}

/**
 * Scope (per spec): diffs from tool_use events in this session that are
 * *either* still pending a UI approval or in-flight (tool_use without a
 * matching tool_result). Archived tool calls that already succeeded don't
 * belong on the Review page — those are past.
 *
 * Strategy:
 *   1. Index every `permission_request` event by toolUseId. The flow is that
 *      the permission_request corresponds to a tool call the SDK hasn't
 *      actually executed yet — the diff is derived from its `input`.
 *   2. Index every `permission_decision` event by toolUseId. A decided
 *      request is no longer "pending approval" — drop it.
 *   3. Index every `tool_use` event by toolUseId, and every `tool_result`
 *      event by its `toolUseId`. An unmatched tool_use is "in flight".
 *   4. Collect:
 *        a) permission_requests with no matching decision → approvalId set
 *        b) tool_uses with no matching tool_result AND not already counted
 *           via (a) → approvalId = undefined (in-flight, no UI prompt)
 *   5. Only keep Edit/Write/MultiEdit — those are the diff-producing tools.
 */
export function aggregatePendingDiffs(
  events: SessionEvent[],
): PendingDiffEntry[] {
  const decisions = new Set<string>();
  const toolResults = new Set<string>();
  const permRequests = new Map<
    string,
    { toolName: string; input: Record<string, unknown>; title: string }
  >();
  const toolUses = new Map<
    string,
    { toolName: string; input: Record<string, unknown> }
  >();

  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    switch (ev.kind) {
      case "permission_request": {
        const id = String(p.toolUseId ?? "");
        if (!id) continue;
        permRequests.set(id, {
          toolName: String(p.toolName ?? ""),
          input: (p.input as Record<string, unknown>) ?? {},
          title: String(p.title ?? ""),
        });
        break;
      }
      case "permission_decision": {
        const id = String(p.toolUseId ?? "");
        if (id) decisions.add(id);
        break;
      }
      case "tool_use": {
        const id = String(p.toolUseId ?? "");
        if (!id) continue;
        toolUses.set(id, {
          toolName: String(p.name ?? ""),
          input: (p.input as Record<string, unknown>) ?? {},
        });
        break;
      }
      case "tool_result": {
        const id = String(p.toolUseId ?? "");
        if (id) toolResults.add(id);
        break;
      }
      default:
        break;
    }
  }

  const out: PendingDiffEntry[] = [];
  const seen = new Set<string>();

  // Bucket (a): pending permission requests that haven't been decided.
  for (const [id, pr] of permRequests) {
    if (decisions.has(id)) continue;
    const kindTag = kindTagForTool(pr.toolName);
    if (!kindTag) continue;
    const diff = diffForToolCall(pr.toolName, pr.input);
    if (!diff) continue;
    out.push({
      toolUseId: id,
      filePath: diff.path,
      kind: kindTag,
      addCount: diff.addCount,
      delCount: diff.delCount,
      hunks: diff.hunks,
      approvalId: id,
      title: pr.title || null,
    });
    seen.add(id);
  }

  // Bucket (b): tool_use events with no matching tool_result (in-flight).
  // Skip anything we already counted via the permission bucket.
  for (const [id, tu] of toolUses) {
    if (seen.has(id)) continue;
    if (toolResults.has(id)) continue;
    const kindTag = kindTagForTool(tu.toolName);
    if (!kindTag) continue;
    const diff = diffForToolCall(tu.toolName, tu.input);
    if (!diff) continue;
    out.push({
      toolUseId: id,
      filePath: diff.path,
      kind: kindTag,
      addCount: diff.addCount,
      delCount: diff.delCount,
      hunks: diff.hunks,
      approvalId: undefined,
      title: null,
    });
  }

  return out;
}
