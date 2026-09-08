import type Database from "better-sqlite3";
import type { AppSettings, CustomModel } from "@claudex/shared";

// -----------------------------------------------------------------------------
// AppSettingsStore — global (singleton) user preferences for claudex itself.
//
// Unlike per-session config (which lives on the `sessions` row), these are
// knobs that should feel "app-level" — e.g. the default output language to
// nudge Claude toward on every new session, or user-defined custom models.
//
// Storage shape is a key-value table (`app_settings`, migration 24). A KV
// store rather than a single-row typed table so future additions (theme /
// text size / etc.) don't need a new migration per field.
//
// Semantics:
//   - `null` / `undefined` in the typed `AppSettings` view means "no override"
//     — for `language` this means defer to Claude Code's own `~/.claude/
//     settings.json` `language` field (picked up by the SDK's default
//     `settingSources`), which matches the pre-feature behavior.
//   - Writing a `null` via `patch()` DELETEs the key rather than writing the
//     string "null". Get-after-delete returns `null` and the runner simply
//     omits `systemPrompt` on session start.
//   - `customModels` is stored as a JSON string under the `custom_models` key.
//     `null` → no custom models (empty array on read).
// -----------------------------------------------------------------------------

// Keys we persist in `app_settings`. Kept as a literal tuple so the store
// knows which rows to SELECT back into the typed view — unknown keys in the
// table are ignored (future-proof for partial migrations).
const KNOWN_KEYS = ["language", "custom_models"] as const;
type KnownKey = (typeof KNOWN_KEYS)[number];

export class AppSettingsStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Read all known settings. Missing rows surface as `null`, matching the
   * zod schema's `.nullable()` contract. Cheap enough (single-digit rows) to
   * call on every session start without caching.
   */
  get(): AppSettings {
    const rows = this.db
      .prepare(
        `SELECT key, value FROM app_settings WHERE key IN (${KNOWN_KEYS.map(() => "?").join(",")})`,
      )
      .all(...KNOWN_KEYS) as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));

    let customModels: CustomModel[] | null = null;
    const raw = map.get("custom_models");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          customModels = parsed as CustomModel[];
        }
      } catch {
        // corrupted JSON — treat as no custom models
      }
    }

    return {
      language: map.get("language") ?? null,
      customModels,
    };
  }

  /**
   * Partial update. `null` values DELETE the key (= restore "no override").
   * Unknown keys are rejected — this is the single server-side guard against
   * a typo flooding the table with dead rows.
   */
  patch(partial: Partial<AppSettings>): AppSettings {
    const tx = this.db.transaction((entries: Array<[KnownKey, string | null]>) => {
      for (const [key, value] of entries) {
        if (value === null) {
          this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
        } else {
          this.db
            .prepare(
              `INSERT INTO app_settings (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .run(key, value);
        }
      }
    });
    const entries: Array<[KnownKey, string | null]> = [];
    if ("language" in partial) {
      entries.push(["language", partial.language ?? null]);
    }
    if ("customModels" in partial) {
      const val = partial.customModels;
      entries.push([
        "custom_models",
        val === null ? null : JSON.stringify(val),
      ]);
    }
    tx(entries);
    return this.get();
  }
}
