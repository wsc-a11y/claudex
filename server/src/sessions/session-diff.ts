import type {
  DiffHunk,
  Session,
  SessionDiffApproval,
  SessionDiffFile,
  SessionDiffFileStatus,
  SessionDiffResponse,
  SessionDiffTimelineEntry,
  SessionEvent,
} from "@claudex/shared";
import { diffForToolCall } from "./diffs.js";

// -----------------------------------------------------------------------------
// Whole-session diff aggregation.
//
// Unlike `aggregatePendingDiffs` in diffs.ts (which only surfaces diffs
// currently awaiting the user or in-flight), this walks every file-mutating
// tool call in the event log and stitches them per-file. Output is the
// PR-shaped `SessionDiffResponse` that powers mockup s-15.
//
// Algorithm:
//   1. Walk events; index permission requests + decisions by toolUseId.
//   2. Walk again; for each Edit / Write / MultiEdit tool_use, compute
//      approval status and re-use diffForToolCall to build a per-call
//      FileDiff.
//   3. Per file path, accumulate hunks + add/del counts. A Write on a
//      path never seen before starts as status=A; subsequent edits on
//      that path, or any Edit/MultiEdit on an already-seen path, mark
//      it as M.
//   4. Build the timeline in original event order.
//   5. Compute totals + session metadata.
//
// This is a pure recompute on every request. Sessions are bounded, so the
// cost is acceptable. If it ever shows up in a flamegraph we can cache by
// the session's max seq.
// -----------------------------------------------------------------------------

/** Severity rank — highest wins when merging per-file. "pending" is the
 *  most interesting because it tells the user "you still have something
 *  to do", so it floats to the top. */
function approvalRank(a: SessionDiffApproval): number {
  switch (a) {
    case "pending":
      return 3;
    case "auto":
      return 2;
    case "accepted":
      return 1;
    case "rejected":
      return 0;
  }
}

function mergeApproval(
  a: SessionDiffApproval,
  b: SessionDiffApproval,
): SessionDiffApproval {
  return approvalRank(a) >= approvalRank(b) ? a : b;
}

interface FileAccum {
  path: string;
  status: SessionDiffFileStatus;
  addCount: number;
  delCount: number;
  hunks: DiffHunk[];
  approval: SessionDiffApproval;
}

export function aggregateSessionDiff(
  events: SessionEvent[],
  session: Session,
): SessionDiffResponse {
  // Pass 1: permission requests + decisions indexed by toolUseId.
  const permRequested = new Set<string>();
  const permDecided = new Map<string, "accepted" | "rejected">();
  let userMessageCount = 0;

  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    if (ev.kind === "permission_request") {
      const id = String(p.toolUseId ?? "");
      if (id) permRequested.add(id);
    } else if (ev.kind === "permission_decision") {
      const id = String(p.toolUseId ?? "");
      if (!id) continue;
      const raw = String(p.decision ?? "");
      if (raw === "deny") permDecided.set(id, "rejected");
      else if (raw === "allow_once" || raw === "allow_always")
        permDecided.set(id, "accepted");
    } else if (ev.kind === "user_message") {
      userMessageCount += 1;
    }
  }

  function classifyApproval(toolUseId: string): SessionDiffApproval {
    const d = permDecided.get(toolUseId);
    if (d) return d;
    if (permRequested.has(toolUseId)) return "pending";
    return "auto";
  }

  // Pass 2: walk tool_use events in order, accumulating per-file.
  const fileMap = new Map<string, FileAccum>();
  const timeline: SessionDiffTimelineEntry[] = [];

  for (const ev of events) {
    if (ev.kind !== "tool_use") continue;
    const p = ev.payload as Record<string, unknown>;
    const name = String(p.name ?? "");
    const toolUseId = String(p.toolUseId ?? "");
    if (!toolUseId) continue;
    if (name !== "Edit" && name !== "Write" && name !== "MultiEdit") continue;

    const input = (p.input as Record<string, unknown>) ?? {};
    const diff = diffForToolCall(name, input);
    if (!diff) continue;

    const approval = classifyApproval(toolUseId);
    const filePath = diff.path;
    const existing = fileMap.get(filePath);

    if (existing) {
      existing.hunks.push(...diff.hunks);
      existing.addCount += diff.addCount;
      existing.delCount += diff.delCount;
      existing.approval = mergeApproval(existing.approval, approval);
      // Once we've touched a file more than once, it's effectively an
      // M regardless of whether the first op was a Write (create) —
      // subsequent edits imply the file continued to exist.
      existing.status = "M";
    } else {
      // Fresh entry. Write with diff.kind === "create" → A, anything
      // else → M.
      const status: SessionDiffFileStatus =
        name === "Write" && diff.kind === "create" ? "A" : "M";
      fileMap.set(filePath, {
        path: filePath,
        status,
        addCount: diff.addCount,
        delCount: diff.delCount,
        hunks: [...diff.hunks],
        approval,
      });
    }

    const action: SessionDiffTimelineEntry["action"] =
      name === "Edit" ? "edit" : name === "Write" ? "write" : "multiedit";
    timeline.push({
      toolUseId,
      action,
      filePath,
      addCount: diff.addCount,
      delCount: diff.delCount,
      createdAt: ev.createdAt,
      approval,
    });
  }

  const files: SessionDiffFile[] = Array.from(fileMap.values()).map((f) => ({
    path: f.path,
    status: f.status,
    addCount: f.addCount,
    delCount: f.delCount,
    hunks: f.hunks,
    hunkCount: f.hunks.length,
    approval: f.approval,
  }));

  const totals = {
    additions: files.reduce((n, f) => n + f.addCount, 0),
    deletions: files.reduce((n, f) => n + f.delCount, 0),
    filesChanged: files.length,
  };

  return {
    files,
    timeline,
    totals,
    sessionTitle: session.title,
    branch: session.branch,
    model: session.model,
    status: session.status,
    messageCount: userMessageCount,
  };
}
