#!/usr/bin/env node
/**
 * claudex reset-credentials — change the admin username and/or password in
 * place, keeping the TOTP secret intact so the user's authenticator still
 * works. Sister script to `init`, used when someone wants to rename or
 * rotate the password without re-pairing 2FA.
 *
 * Non-interactive only (env vars + flags) — this is a tool you run from
 * the repo, not a routine that asks for input.
 */
import pino from "pino";
import { loadConfig } from "../lib/config.js";
import { openDb } from "../db/index.js";
import { UserStore, hashPassword } from "../auth/index.js";

interface Inputs {
  username?: string;
  password?: string;
  // Match the user to modify by current username. Optional — if only one
  // user exists we modify that one.
  matchUsername?: string;
}

function parseArgs(): Inputs {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  return {
    username: flag("username") ?? process.env.CLAUDEX_RESET_USERNAME,
    password: flag("password") ?? process.env.CLAUDEX_RESET_PASSWORD,
    matchUsername:
      flag("match") ?? process.env.CLAUDEX_RESET_MATCH,
  };
}

async function main() {
  const inputs = parseArgs();
  if (!inputs.username && !inputs.password) {
    process.stderr.write(
      "claudex reset-credentials: nothing to do.\n" +
        "Pass --username=NEW and/or --password=NEW (or use " +
        "CLAUDEX_RESET_USERNAME / CLAUDEX_RESET_PASSWORD env vars).\n" +
        "Optional: --match=OLD_USERNAME if there are multiple users.\n",
    );
    process.exit(1);
  }
  if (inputs.password && inputs.password.length < 8) {
    process.stderr.write(
      "claudex reset-credentials: password must be at least 8 characters.\n",
    );
    process.exit(1);
  }

  const config = loadConfig();
  const log = pino({ level: "silent" }) as any;
  const { db, close } = openDb(config, log);

  const users = new UserStore(db);

  // Pick which user to change.
  const rows = db.prepare("SELECT * FROM users").all() as Array<{
    id: string;
    username: string;
  }>;
  if (rows.length === 0) {
    process.stderr.write(
      "claudex reset-credentials: no admin user exists yet. Run `pnpm run init` first.\n",
    );
    close();
    process.exit(1);
  }
  let target: { id: string; username: string };
  if (inputs.matchUsername) {
    const found = rows.find(
      (r) => r.username === inputs.matchUsername!.toLowerCase(),
    );
    if (!found) {
      process.stderr.write(
        `claudex reset-credentials: no user named "${inputs.matchUsername}".\n`,
      );
      close();
      process.exit(1);
    }
    target = found;
  } else if (rows.length === 1) {
    target = rows[0];
  } else {
    process.stderr.write(
      `claudex reset-credentials: multiple users exist, pass --match=<current-username> to pick one.\n` +
        `  existing: ${rows.map((r) => r.username).join(", ")}\n`,
    );
    close();
    process.exit(1);
  }

  const oldUsername = target.username;
  const changes: string[] = [];

  try {
    if (inputs.username) {
      const normalized = inputs.username.toLowerCase();
      if (normalized !== oldUsername) {
        // Manual uniqueness check so the error message is helpful instead
        // of a SQLite UNIQUE-constraint raw string.
        const clash = users.findByUsername(normalized);
        if (clash && clash.id !== target.id) {
          process.stderr.write(
            `claudex reset-credentials: username "${normalized}" is already taken by a different user.\n`,
          );
          close();
          process.exit(1);
        }
        db.prepare("UPDATE users SET username = ? WHERE id = ?").run(
          normalized,
          target.id,
        );
        changes.push(`username: ${oldUsername} → ${normalized}`);
      }
    }
    if (inputs.password) {
      const hash = await hashPassword(inputs.password);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        hash,
        target.id,
      );
      changes.push("password: updated");
    }
  } finally {
    close();
  }

  if (changes.length === 0) {
    process.stdout.write("claudex reset-credentials: nothing changed.\n");
    return;
  }
  process.stdout.write(
    `✓ Credentials updated for user ${target.id}:\n` +
      changes.map((c) => `  • ${c}`).join("\n") +
      `\n\nTOTP secret is unchanged — your authenticator entry still works.\n` +
      `Existing session cookies stay valid until they expire (30 days) or you sign out.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `claudex reset-credentials failed: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(2);
});
