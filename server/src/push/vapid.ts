import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";

// -----------------------------------------------------------------------------
// VAPID keys
//
// `web-push` needs a stable VAPID keypair to sign push requests; the browser
// needs the public half to subscribe. We generate once on first boot and
// persist to `~/.claudex/vapid.json` (mode 0600). Rotating would invalidate
// every existing subscription — same shape of damage as rotating the JWT
// secret — so we keep it stable across restarts.
//
// The `subject` is what Apple / Mozilla / Google use as the "contact" if
// pushes misbehave. We have no real email for a self-hosted install, so we
// use the conventional `mailto:claudex@localhost`.
// -----------------------------------------------------------------------------

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const DEFAULT_SUBJECT = "mailto:claudex@localhost";

export function vapidFilePath(config: Config): string {
  return path.join(config.stateDir, "vapid.json");
}

export function loadOrCreateVapidKeys(
  config: Config,
  log: Logger,
): VapidKeys {
  const file = vapidFilePath(config);
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<VapidKeys>;
      if (
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
          subject:
            typeof parsed.subject === "string" && parsed.subject.length > 0
              ? parsed.subject
              : DEFAULT_SUBJECT,
        };
      }
      log.warn(
        { file },
        "vapid.json malformed — regenerating keys (existing subscriptions will stop working)",
      );
    } catch (err) {
      log.warn(
        { err, file },
        "failed to read vapid.json — regenerating keys",
      );
    }
  }

  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey,
    privateKey,
    subject: DEFAULT_SUBJECT,
  };
  fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort on platforms that don't enforce POSIX perms; not worth
    // crashing the boot over.
  }
  log.info({ file }, "generated VAPID keypair");
  return keys;
}

/**
 * Configure `web-push` with the given keys. Safe to call more than once;
 * `web-push` just stashes the values on a module-level config.
 */
export function configureWebPush(keys: VapidKeys): void {
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
}
