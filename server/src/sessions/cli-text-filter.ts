/**
 * Filter for Claude Code harness-injected pseudo-messages that show up in CLI
 * JSONL transcripts as `type:"user"` records. They are NOT user turns — they
 * are strings the harness stuffs into the prompt so the model can see
 * background events, slash-command echoes, skill hints, etc.
 *
 * When claudex imports a CLI session we must strip these so the UI does not
 * render them as user bubbles. The detection is intentionally conservative:
 * we only match a fixed set of well-known XML-ish tags the harness emits.
 * We do NOT do any content heuristics — anything that is not one of these
 * tags is treated as real typed text.
 *
 * Tags stripped:
 *   - <task-notification>...</task-notification>
 *       background Agent/Bash completions
 *   - <system-reminder>...</system-reminder>
 *       gentle reminders, task-list dumps, skill hints
 *   - <command-message>...</command-message>
 *   - <command-name>...</command-name>
 *   - <local-command-stdout>...</local-command-stdout>
 *       slash command echoes (the three usually travel together)
 *   - <user-prompt-submit-hook>...</user-prompt-submit-hook>
 *       hook outputs that leak into prompts
 */

const HARNESS_TAGS = [
  "task-notification",
  "system-reminder",
  "command-message",
  "command-name",
  "local-command-stdout",
  "user-prompt-submit-hook",
] as const;

// Build one regex per tag. The outer flag `g` is required so `replace` hits
// every occurrence; we do non-greedy matching so adjacent blocks don't merge.
// `[\s\S]` replaces the missing DOTALL flag in JS regex.
const HARNESS_REGEXES: RegExp[] = HARNESS_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "g"),
);

/**
 * Remove every top-level harness pseudo-tag block from `text` and return
 * whatever remains. If the returned string is empty (or whitespace only) the
 * caller should DROP the whole event — there is no user turn here.
 *
 * Idempotent: running the filter twice yields the same output as once.
 */
export function stripHarnessNoise(text: string): string {
  if (!text) return "";
  let out = text;
  for (const rx of HARNESS_REGEXES) {
    out = out.replace(rx, "");
  }
  return out.trim();
}
