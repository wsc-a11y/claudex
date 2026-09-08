import type { UIPiece } from "@/state/sessions";

/**
 * Shape of a single todo item as written by Claude's `TodoWrite` tool call.
 * Not imported from `@claudex/shared` because the server treats the tool
 * input opaquely — there's no server-side aggregation or validation. We
 * narrow the shape at the UI boundary and tolerate drift (unknown status,
 * missing activeForm) rather than throwing.
 */
export interface TodoItem {
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanSnapshot {
  /** Latest todos, in author-specified order. Empty when the session has
   *  never called `TodoWrite`. Consumers should hide all surfaces when
   *  `items.length === 0` — an empty plan is indistinguishable from "no
   *  plan yet" and the strip/card should collapse. */
  items: TodoItem[];
  /** Count of items with status === "completed". */
  done: number;
  /** Total items. */
  total: number;
  /** 0..1 completion ratio. Defined as `done / total` with total === 0
   *  collapsing to 0 so callers don't need to guard NaN. */
  ratio: number;
  /** Seq of the `TodoWrite` tool_use piece this snapshot was derived from,
   *  or null if the piece had no seq yet (optimistic / pre-ack). Used by
   *  the lightweight chat pointer to build a `data-event-seq` link back. */
  sourceSeq: number | null;
  /** ISO timestamp of the `TodoWrite` tool_use piece, if it was persisted.
   *  Null for optimistic echoes. */
  updatedAt: string | null;
  /** The in-progress item, if any — cached so the strip doesn't re-walk
   *  on every render. */
  current: TodoItem | null;
}

const EMPTY_SNAPSHOT: PlanSnapshot = {
  items: [],
  done: 0,
  total: 0,
  ratio: 0,
  sourceSeq: null,
  updatedAt: null,
  current: null,
};

/**
 * Walk the transcript back-to-front and pull out the most recent
 * `TodoWrite` tool_use — that's the authoritative current plan. Earlier
 * `TodoWrite` calls are superseded by later ones (the agent rewrites the
 * whole list every time). Returns `EMPTY_SNAPSHOT` when no plan exists
 * or the latest call has a malformed/empty `todos` array.
 *
 * Safe to call on every render — it's O(n) worst-case but the scan is a
 * tight loop over raw objects. Wrap in `useMemo(() => selectLatestTodos(pieces), [pieces])`
 * to avoid the walk when the transcript hasn't grown.
 */
export function selectLatestTodos(pieces: UIPiece[]): PlanSnapshot {
  // Walk backwards — the latest TodoWrite is always the truth.
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const p = pieces[i];
    if (p.kind !== "tool_use") continue;
    if (p.name !== "TodoWrite") continue;
    // Skip subagent-owned TodoWrite calls — a subagent has its own plan
    // that must not override the main agent's plan surface. Each
    // subagent's plan lives inside its own run panel/page.
    if (p.parentToolUseId) continue;
    const todos = (p.input as Record<string, unknown>).todos;
    if (!Array.isArray(todos)) continue;
    const items = todos
      .map(normalizeTodo)
      .filter((t): t is TodoItem => t !== null);
    if (items.length === 0) continue;
    const done = items.reduce(
      (acc, it) => acc + (it.status === "completed" ? 1 : 0),
      0,
    );
    return {
      items,
      done,
      total: items.length,
      ratio: items.length > 0 ? done / items.length : 0,
      sourceSeq: typeof p.seq === "number" ? p.seq : null,
      updatedAt: p.createdAt ?? null,
      current: items.find((it) => it.status === "in_progress") ?? null,
    };
  }
  return EMPTY_SNAPSHOT;
}

/**
 * Count `TodoWrite` calls in the transcript. Used to number the
 * lightweight chat pointers ("Plan updated · rev 3"). Cheap single pass.
 */
export function countTodoWriteRevisions(pieces: UIPiece[]): number {
  let n = 0;
  for (const p of pieces) {
    if (p.kind === "tool_use" && p.name === "TodoWrite" && !p.parentToolUseId) {
      n += 1;
    }
  }
  return n;
}

/**
 * Given a tool_use piece at index `i`, return its 1-based revision number
 * among all `TodoWrite` calls in the transcript, or null if this piece
 * isn't a TodoWrite. Used by the inline lightweight pointer to render a
 * stable "Plan · rev N" label without having to thread revision state
 * through the Piece switch.
 */
export function todoRevisionAt(
  pieces: UIPiece[],
  targetIndex: number,
): number | null {
  const target = pieces[targetIndex];
  if (!target || target.kind !== "tool_use" || target.name !== "TodoWrite") {
    return null;
  }
  // Subagent-owned TodoWrite tool_uses aren't counted in the main plan
  // revision history — they belong to the subagent's own plan.
  if (target.parentToolUseId) return null;
  let n = 0;
  for (let i = 0; i <= targetIndex; i += 1) {
    const p = pieces[i];
    if (p.kind === "tool_use" && p.name === "TodoWrite" && !p.parentToolUseId) {
      n += 1;
    }
  }
  return n;
}

function normalizeTodo(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const content = typeof r.content === "string" ? r.content : null;
  if (!content) return null;
  const rawStatus = typeof r.status === "string" ? r.status : "pending";
  const status: TodoItem["status"] =
    rawStatus === "completed" || rawStatus === "in_progress"
      ? rawStatus
      : "pending";
  const activeForm =
    typeof r.activeForm === "string" && r.activeForm.length > 0
      ? r.activeForm
      : undefined;
  return { content, status, activeForm };
}
