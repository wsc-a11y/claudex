#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import QRCode from "qrcode";
import pino from "pino";
import { loadConfig } from "../lib/config.js";
import { openDb } from "../db/index.js";
import {
  UserStore,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  totpUri,
} from "../auth/index.js";
import {
  generateRecoveryCodes,
  hashRecoveryCodes,
  RECOVERY_CODE_BATCH_SIZE,
} from "../auth/recovery-codes.js";

interface InitInputs {
  username: string;
  password: string;
  // When true, skip TOTP enrollment entirely. The user row lands with
  // `totp_enabled = 0` and an empty `totp_secret`, and login short-circuits
  // straight to a session cookie after bcrypt. They can opt back in later
  // from Settings → Security.
  skipTotp: boolean;
}

/**
 * Collect credentials. Precedence:
 *   1. CLI flags: --username=... --password=... [--skip-totp]
 *   2. Env vars: CLAUDEX_INIT_USERNAME / CLAUDEX_INIT_PASSWORD /
 *      CLAUDEX_INIT_SKIP_TOTP
 *   3. Interactive prompts on stdin.
 *
 * Non-interactive paths exist so tests and automation don't have to juggle
 * pipes and pseudo-ttys.
 */
async function collectInputs(): Promise<InitInputs> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const hasBareFlag = (name: string): boolean =>
    argv.includes(`--${name}`);
  const username = flag("username") ?? process.env.CLAUDEX_INIT_USERNAME;
  const password = flag("password") ?? process.env.CLAUDEX_INIT_PASSWORD;
  const skipTotpEnv = process.env.CLAUDEX_INIT_SKIP_TOTP;
  const skipTotp =
    hasBareFlag("skip-totp") ||
    flag("skip-totp") === "1" ||
    flag("skip-totp") === "true" ||
    skipTotpEnv === "1" ||
    skipTotpEnv === "true";
  if (username && password) {
    return { username, password, skipTotp };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "non-interactive stdin: provide --username=... --password=... or " +
        "CLAUDEX_INIT_USERNAME / CLAUDEX_INIT_PASSWORD env vars.",
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    let u = username;
    while (!u) {
      const v = (await rl.question("Username: ")).trim();
      if (v) u = v;
    }
    let p = password ?? "";
    while (p.length < 8) {
      p = await rl.question(
        "Password (>= 8 chars, will be visible while typing): ",
      );
      if (p.length < 8) output.write("Too short.\n");
    }
    const confirm = await rl.question("Confirm password: ");
    if (p !== confirm) {
      throw new Error("passwords did not match");
    }
    return { username: u, password: p, skipTotp };
  } finally {
    rl.close();
  }
}

async function main() {
  const config = loadConfig();
  // Silent logger — the init flow prints its own human-friendly output and
  // we don't want pino frames mixed with readline prompts on stdout.
  const log = pino({ level: "silent" }) as any;
  const { db, close } = openDb(config, log);
  loadOrCreateJwtSecret(config);

  const users = new UserStore(db);
  if (users.count() > 0) {
    process.stderr.write(
      `claudex: an admin already exists in ${config.dbPath}.\n` +
        `To start over, delete the database file manually and run \`claudex init\` again.\n`,
    );
    close();
    process.exit(1);
  }

  let inputs: InitInputs;
  try {
    inputs = await collectInputs();
  } catch (err) {
    process.stderr.write(
      `claudex init: ${err instanceof Error ? err.message : err}\n`,
    );
    close();
    process.exit(1);
  }

  if (inputs.password.length < 8) {
    process.stderr.write("password must be at least 8 characters\n");
    close();
    process.exit(1);
  }

  const passwordHash = await hashPassword(inputs.password);

  if (inputs.skipTotp) {
    // 2FA-off install: empty secret, flag=0. Recovery codes are not seeded
    // either — they protect against a lost authenticator that this install
    // doesn't have.
    const user = users.create({
      username: inputs.username,
      passwordHash,
      totpSecret: "",
      totpEnabled: false,
    });
    output.write(`\n✓ Admin user "${inputs.username}" created (without 2FA).\n`);
    output.write(`  State directory: ${config.stateDir}\n`);
    output.write(`  DB: ${config.dbPath}\n`);
    output.write(
      `\n  Two-factor authentication is OFF. You can enable it later from\n` +
        `  Settings → Security after logging in.\n`,
    );
    output.write(`\nNext: run \`pnpm dev\` and visit http://127.0.0.1:5173/.\n`);
    void user;
    close();
    return;
  }

  const totpSecret = generateTotpSecret();
  const uri = totpUri(totpSecret, inputs.username.toLowerCase());
  const qr = await QRCode.toString(uri, { type: "terminal", small: true });

  const user = users.create({
    username: inputs.username,
    passwordHash,
    totpSecret,
    totpEnabled: true,
  });

  output.write(`\nScan this QR code with your authenticator app:\n\n`);
  output.write(qr);
  output.write(`\nOr enter this secret manually: ${totpSecret}\n`);
  output.write(`Issuer / account: claudex / ${inputs.username.toLowerCase()}\n`);
  output.write(`\n✓ Admin user "${inputs.username}" created.\n`);
  output.write(`  State directory: ${config.stateDir}\n`);
  output.write(`  DB: ${config.dbPath}\n`);

  // Recovery codes: generate-then-print-then-persist. The old order (persist
  // before print) meant a Ctrl-C between the two would leave the user with a
  // working 2FA whose recovery codes they never saw. We now only write the
  // hashes after the user has had a chance to copy the plaintext — and in the
  // interactive path, after they've pressed Enter to confirm.
  //
  // Trade-off on Ctrl-C: if the user aborts the confirmation prompt, TOTP
  // setup is already complete (user row + totp_secret persisted above) but
  // the recovery-code hashes are NOT written. They can log in, and can mint a
  // fresh batch later from Settings → Security via the Regenerate flow (or
  // re-run `pnpm reset-credentials` + `claudex init` semantics in the
  // future). We accept that over the current silent footgun.
  const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_BATCH_SIZE);
  output.write(
    `\n⚠ Save these recovery codes — shown once, never again.\n` +
      `  Each one works ONCE if you lose your authenticator app.\n\n`,
  );
  for (const code of recoveryCodes) {
    output.write(`  ${code}\n`);
  }
  output.write(
    `\nYou can regenerate these later from Settings → Security (this invalidates\n` +
      `the current batch).\n`,
  );

  // Force-flush before we block on the prompt (or bail in the non-interactive
  // path) so the codes actually hit the terminal/pipe even if stdout is
  // buffered.
  await flushStdout();

  // Decide whether to prompt. We only prompt when BOTH stdin is a TTY (we can
  // actually read a keypress) AND we were running interactively to begin with
  // (no env-var / flag overrides). In the non-interactive path we print and
  // immediately persist — the operator has no way to press Enter anyway, and
  // the caller (automation, tests) expects the run to finish without input.
  const nonInteractive =
    !!(process.env.CLAUDEX_INIT_USERNAME || process.env.CLAUDEX_INIT_PASSWORD) ||
    process.argv.slice(2).some((a) => a.startsWith("--username=") || a.startsWith("--password="));
  const canPrompt = process.stdin.isTTY && process.stdout.isTTY && !nonInteractive;

  if (canPrompt) {
    const rl = readline.createInterface({ input, output });
    // Ctrl-C during readline raises SIGINT which, left to default, kills the
    // process with exit(130) before we touch the DB. That's exactly the
    // desired "abort without persisting" behavior — we just want to emit a
    // clean-ish line first so the terminal doesn't stop mid-sentence.
    const onSigint = () => {
      output.write(
        `\n\nAborted before recovery codes were persisted. TOTP setup is complete;\n` +
          `log in and regenerate recovery codes from Settings → Security when ready.\n`,
      );
      close();
      process.exit(130);
    };
    process.once("SIGINT", onSigint);
    try {
      await rl.question(
        `\nPress Enter once you've saved the codes above to finish setup...`,
      );
    } finally {
      process.removeListener("SIGINT", onSigint);
      rl.close();
    }
  }

  // Only now do we hash and persist. A failure here (disk full, DB locked,
  // etc.) is surfaced to the user — we do NOT swallow it, because the
  // alternative is a TOTP-only account with no recovery path and no warning.
  const recoveryHashes = await hashRecoveryCodes(recoveryCodes);
  users.setRecoveryCodeHashes(user.id, recoveryHashes);

  output.write(`\nNext: run \`pnpm dev\` and visit http://127.0.0.1:5173/.\n`);
  close();
}

/**
 * Wait for stdout's kernel buffer to drain. Matters when stdout is a pipe
 * (e.g. `claudex init | tee setup.log`) — without this the process can exit
 * before the recovery codes are actually delivered downstream.
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    if (output.writableNeedDrain) {
      output.once("drain", () => resolve());
    } else {
      resolve();
    }
  });
}

main().catch((err) => {
  process.stderr.write(
    `claudex init failed: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(2);
});
