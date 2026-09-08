/**
 * A tiny unified-diff builder. Given before/after strings (for Edit) or
 * absent/after (for Write), produce a minimal diff of `DiffLine` objects.
 *
 * We intentionally do NOT pull in a real diff lib (e.g. `diff`) to keep the
 * JS bundle small. Good enough for MVP rendering.
 */

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  kind: "create" | "edit" | "overwrite";
  addCount: number;
  delCount: number;
  hunks: DiffHunk[];
}

/** Build a diff for Write: all new lines are adds; empty input = create. */
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
  // Overwrite: for MVP render as one big deletion + one big addition.
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
    hunks: [
      { header: `@@ ${filePath} — overwrite @@`, lines },
    ],
  };
}

/**
 * Build a diff for Edit: given old_string → new_string. We can't know the
 * line numbers without the full file, so we render a contextless hunk
 * showing the replacement in isolation.
 */
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
    hunks: [
      { header: `@@ ${filePath} @@`, lines },
    ],
  };
}

export function diffForToolCall(
  name: string,
  input: Record<string, unknown>,
): FileDiff | null {
  const filePath = String(input.file_path ?? "");
  if (!filePath) return null;
  switch (name) {
    case "Write":
      return diffForWrite(filePath, String(input.content ?? ""));
    case "Edit":
      return diffForEdit(
        filePath,
        String(input.old_string ?? ""),
        String(input.new_string ?? ""),
      );
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      if (edits.length === 0) return null;
      const hunks: DiffHunk[] = [];
      let add = 0;
      let del = 0;
      for (const e of edits as Array<Record<string, unknown>>) {
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
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  // If the input didn't end with \n, the final split entry is the last line
  // (no trailing empty). If it did end with \n, there's an empty trailing
  // entry we strip to avoid rendering a phantom line.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
