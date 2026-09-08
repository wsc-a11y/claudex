/**
 * Slash command type + filter helpers for the composer's `/` picker.
 *
 * The authoritative list is fetched at runtime from the server
 * (`GET /api/slash-commands`) so we can reflect the user's actual
 * `~/.claude/commands/*.md` files and per-project commands alongside the
 * `claude` CLI's built-ins. The fallback below is a tiny hardcoded set used
 * only when the API call fails (network / server down) — it keeps the
 * composer usable instead of silently empty.
 *
 * We never execute anything ourselves: selecting a command just inserts
 * `/<name>` into the composer text. The spawned `claude` CLI is what
 * actually interprets `/review`, `/compact`, etc.
 */

import type { SlashCommand as SharedSlashCommand } from "@claudex/shared";

export type SlashCommand = SharedSlashCommand;

/**
 * Offline fallback — shown only when `/api/slash-commands` fails. Keep tiny
 * and uncontroversial; the server has the real list.
 *
 * Behaviors mirror the server-side triage: `/help` has no SDK-backed impl
 * yet so we point it at a claudex action (no-op hint today), and `/clear`,
 * `/compact`, `/review` get their true categorization so the picker doesn't
 * briefly lie before the real list arrives.
 */
export const BUILTIN_FALLBACK_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    description: "List available slash commands",
    kind: "built-in",
    behavior: { kind: "claudex-action", action: "open-slash-help" },
  },
  {
    name: "clear",
    description: "Clear the conversation history",
    kind: "built-in",
    behavior: { kind: "claudex-action", action: "clear-transcript" },
  },
  {
    name: "compact",
    description: "Summarize and free context window",
    kind: "built-in",
    behavior: { kind: "native" },
  },
  {
    name: "review",
    description: "Review the current diff",
    kind: "built-in",
    behavior: {
      kind: "unsupported",
      reason: "CLI REPL command — not verified under the Agent SDK",
    },
  },
];

/**
 * Filter commands by a substring of the user's typed query (post-`/`).
 * Case-insensitive match against both `name` and `description`.
 */
export function filterSlashCommands(
  query: string,
  commands: SlashCommand[],
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.description ?? "").toLowerCase().includes(q),
  );
}
