// ---------------------------------------------------------------------------
// Per-tool short summary for folded tool-call chips + the TasksList rail.
//
// We prefer the most user-facing field for each tool — usually the model-
// authored `description` one-liner — and fall back to the first meaningful
// candidate. The output is a single short string with no leading spaces,
// truncated at 120 chars with `…`. Callers style the surrounding span (mono
// font, truncate, etc.); this helper only produces the text.
// ---------------------------------------------------------------------------

import {
  Bot,
  FilePlus,
  FileSearch2,
  FileText,
  Globe2,
  ListChecks,
  NotebookPen,
  PencilLine,
  Search,
  SearchCheck,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const MAX_LEN = 120;

/** Clamp to MAX_LEN chars with a trailing ellipsis. Handles null / undefined /
 * empty input by returning the empty string (callers decide what to render
 * in that case). */
function truncate(s: string): string {
  if (!s) return "";
  const trimmed = s.replace(/^\s+/, "");
  if (trimmed.length <= MAX_LEN) return trimmed;
  return trimmed.slice(0, MAX_LEN - 1) + "…";
}

/** Best-effort string extractor. Returns the trimmed (leading) value if
 * `v` is a non-empty string, otherwise null. */
function asString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/^\s+/, "");
  return t.length > 0 ? t : null;
}

/** Same as asString but tolerates numbers (e.g. shell_id) by coercing. */
function asScalar(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.replace(/^\s+/, "");
    return t.length > 0 ? t : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Tool names the SDK uses for agent-spawning / explore calls. Kept in sync
 * with SUBAGENT_TOOLS in TasksList.tsx — these always prefer `description`
 * over `prompt`. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent", "Explore"]);

/** Generic candidate fields for unknown tools. Order matters: `description`
 * first because it's the model's own one-liner. */
const FALLBACK_CANDIDATES = [
  "description",
  "command",
  "query",
  "pattern",
  "url",
  "path",
  "file_path",
];

/** One-line human-readable summary of a tool call for the folded chip. */
export function summarizeToolCall(
  name: string,
  input: Record<string, unknown> | null | undefined,
): string {
  if (!input || typeof input !== "object") return "";

  // Sub-agent invocations — prefer description, fall back to the prompt head.
  if (SUBAGENT_TOOLS.has(name)) {
    const desc = asString(input.description);
    if (desc) return truncate(desc);
    const prompt = asString(input.prompt);
    if (prompt) return truncate(prompt.slice(0, 100));
    return "";
  }

  switch (name) {
    case "Bash": {
      const desc = asString(input.description);
      if (desc) return truncate(desc);
      const cmd = asString(input.command);
      if (cmd) return truncate(cmd);
      return "";
    }
    case "Read": {
      const fp = asString(input.file_path);
      return fp ? truncate(`read ${fp}`) : "";
    }
    case "Write": {
      const fp = asString(input.file_path);
      return fp ? truncate(`write ${fp}`) : "";
    }
    case "Edit": {
      const fp = asString(input.file_path);
      return fp ? truncate(`edit ${fp}`) : "";
    }
    case "MultiEdit": {
      const fp = asString(input.file_path);
      return fp ? truncate(`edit ${fp}`) : "";
    }
    case "NotebookEdit": {
      const fp = asString(input.notebook_path) ?? asString(input.file_path);
      return fp ? truncate(`notebook-edit ${fp}`) : "";
    }
    case "Glob": {
      const pattern = asString(input.pattern);
      if (!pattern) return "";
      const path = asString(input.path);
      return truncate(path ? `${pattern} in ${path}` : pattern);
    }
    case "Grep": {
      const pattern = asString(input.pattern);
      if (!pattern) return "";
      const path = asString(input.path);
      return truncate(path ? `${pattern} in ${path}` : pattern);
    }
    case "WebFetch": {
      const url = asString(input.url);
      return url ? truncate(url) : "";
    }
    case "WebSearch": {
      const q = asString(input.query);
      return q ? truncate(q) : "";
    }
    case "TodoWrite": {
      const todos = input.todos;
      if (Array.isArray(todos)) {
        const n = todos.length;
        return `${n} todo${n === 1 ? "" : "s"}`;
      }
      return "";
    }
    case "SlashCommand": {
      const cmd = asString(input.command);
      if (!cmd) return "";
      return truncate(cmd.startsWith("/") ? cmd : `/${cmd}`);
    }
    case "Skill": {
      const skill = asString(input.skill);
      return skill ? truncate(skill) : "";
    }
    case "KillShell":
    case "KillBash":
    case "BashOutput": {
      const id =
        asScalar(input.shell_id) ??
        asScalar(input.bash_id) ??
        asScalar(input.id);
      return id ? truncate(id) : "";
    }
    default: {
      // Unknown tool — try each candidate in order.
      for (const key of FALLBACK_CANDIDATES) {
        const v = asString((input as Record<string, unknown>)[key]);
        if (v) return truncate(v);
      }
      try {
        const s = JSON.stringify(input);
        if (!s || s === "{}") return "";
        return truncate(s);
      } catch {
        return "";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-tool lucide icon map. Used as a leading glyph on the folded tool-call
// chip in Chat.tsx and the TasksList rail. Unknown tools fall back to
// `Wrench`. All icons are from lucide-react; keep the set narrow so the
// bundle doesn't bloat.
// ---------------------------------------------------------------------------
export function toolIcon(name: string): LucideIcon {
  if (SUBAGENT_TOOLS.has(name)) return Bot;
  switch (name) {
    case "Bash":
    case "SlashCommand":
    case "KillShell":
    case "KillBash":
    case "BashOutput":
      return Terminal;
    case "Read":
      return FileText;
    case "Write":
      return FilePlus;
    case "Edit":
    case "MultiEdit":
      return PencilLine;
    case "NotebookEdit":
      return NotebookPen;
    case "Glob":
      return FileSearch2;
    case "Grep":
      return Search;
    case "WebFetch":
      return Globe2;
    case "WebSearch":
      return SearchCheck;
    case "TodoWrite":
      return ListChecks;
    default:
      return Wrench;
  }
}
