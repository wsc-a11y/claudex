/**
 * shell-env.ts
 *
 * claudex is often launched as a child of Claude Desktop, which injects its
 * own ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY into process.env before claudex
 * even starts.  Those values override whatever the user set in their shell
 * profile (~/.zshrc / ~/.bashrc / ~/.profile), so the runner ends up hitting
 * the official Anthropic API even when the user configured a proxy.
 *
 * This module sources the user's login shell once at startup to recover the
 * "real" shell environment, then patches process.env with any Anthropic-
 * related variables found there — but only when the current process.env value
 * looks like a Claude Desktop placeholder (empty API key, or the default
 * https://api.anthropic.com base URL).
 *
 * Call `patchAnthropicEnvFromShell()` once, early in server startup, before
 * any runners are created.
 */

import { execFileSync } from "node:child_process";
import os from "node:os";

/** Keys we care about syncing from the login shell. */
const ANTHROPIC_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

/** Proxy-related keys that detached workers (update-restart-worker) need for
 *  outbound git/pnpm access.  We patch these into process.env alongside the
 *  Anthropic keys so that `spawn({ env: process.env })` inherits them. */
const PROXY_KEYS = [
  "http_proxy", "https_proxy", "all_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
] as const;

/**
 * Returns true when the current value of `key` in process.env looks like a
 * Claude Desktop placeholder that should be overridden by the user's shell.
 */
function isPlaceholder(key: string): boolean {
  const val = process.env[key];
  if (val === undefined || val === "") return true;
  if (key === "ANTHROPIC_BASE_URL" && val === "https://api.anthropic.com")
    return true;
  return false;
}

/**
 * Spawn the user's login shell and ask it to print its environment.
 * Returns a key=value map, or null if the shell couldn't be interrogated.
 *
 * We use `-l` (login) so ~/.zshrc / ~/.bash_profile / ~/.profile are sourced.
 * stdout is the output of `env`, one KEY=VALUE line per variable (values may
 * contain `=` signs — we split on the *first* `=` only).
 */
function readLoginShellEnv(): Map<string, string> | null {
  const shell = process.env.SHELL ?? "/bin/zsh";
  try {
    const raw = execFileSync(shell, ["-l", "-c", "env"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: os.homedir(),
    });
    const map = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      map.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Patch process.env with Anthropic-related variables from the user's login
 * shell, but only for keys whose current value looks like a Claude Desktop
 * placeholder.  Safe to call multiple times (idempotent after the first call).
 *
 * @param logger  Optional pino-shaped logger for diagnostic output.
 */
export function patchAnthropicEnvFromShell(logger?: {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}): void {
  // Fast path: if none of the keys look like placeholders, nothing to do.
  const needsPatch = ANTHROPIC_KEYS.some(isPlaceholder);
  if (!needsPatch) return;

  const shellEnv = readLoginShellEnv();
  if (!shellEnv) {
    logger?.warn(
      { shell: process.env.SHELL },
      "shell-env: could not read login shell environment; using inherited env",
    );
    return;
  }

  const patched: string[] = [];
  for (const key of [...ANTHROPIC_KEYS, ...PROXY_KEYS]) {
    if (!isPlaceholder(key)) continue;
    const shellVal = shellEnv.get(key);
    if (shellVal === undefined || shellVal === "") continue;
    process.env[key] = shellVal;
    patched.push(key);
  }

  if (patched.length > 0) {
    logger?.info(
      { patched },
      "shell-env: patched process.env from login shell",
    );
  }
}
