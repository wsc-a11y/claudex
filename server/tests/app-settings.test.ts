import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import { AppSettingsStore } from "../src/settings/store.js";
import type { AppSettings } from "@claudex/shared";

// -----------------------------------------------------------------------------
// AppSettingsStore (KV-over-sqlite) + /api/app-settings HTTP routes.
//
// Two halves:
//   1. Direct store round-trips: get() before anything is written returns
//      {language: null}; patch() writes, get() reads; patch({language: null})
//      deletes the row (not write-null-string).
//   2. The HTTP surface enforces auth, parses the zod body, and echoes the
//      post-update view.
// -----------------------------------------------------------------------------

describe("app-settings store", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("default get() before any write returns all-null", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AppSettingsStore(ctx.dbh.db);
    expect(store.get()).toEqual({ language: null, customModels: null } satisfies AppSettings);
  });

  it("patch writes a language then reads it back", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AppSettingsStore(ctx.dbh.db);
    const after = store.patch({ language: "chinese" });
    expect(after.language).toBe("chinese");
    expect(store.get().language).toBe("chinese");
  });

  it("patch with null DELETEs the row (returns to undefined/null)", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AppSettingsStore(ctx.dbh.db);
    store.patch({ language: "japanese" });
    const after = store.patch({ language: null });
    expect(after.language).toBeNull();
    // And no leftover row in the underlying table.
    const rows = ctx.dbh.db
      .prepare(`SELECT * FROM app_settings WHERE key = 'language'`)
      .all();
    expect(rows).toEqual([]);
  });

  it("patch without the key is a no-op for that key (partial semantics)", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const store = new AppSettingsStore(ctx.dbh.db);
    store.patch({ language: "english" });
    // Patch with an empty object should not touch `language`.
    const after = store.patch({});
    expect(after.language).toBe("english");
  });
});

describe("app-settings HTTP routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("GET requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({ method: "GET", url: "/api/app-settings" });
    expect(res.statusCode).toBe(401);
  });

  it("PATCH requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/api/app-settings",
      payload: { language: "chinese" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET returns null default, PATCH writes + echoes, GET reads back", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const headers = { cookie: ctx.cookie };

    const first = await ctx.app.inject({
      method: "GET",
      url: "/api/app-settings",
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ settings: { language: null, customModels: null } });

    const patched = await ctx.app.inject({
      method: "PATCH",
      url: "/api/app-settings",
      headers,
      payload: { language: "chinese" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ settings: { language: "chinese", customModels: null } });

    const readBack = await ctx.app.inject({
      method: "GET",
      url: "/api/app-settings",
      headers,
    });
    expect(readBack.json()).toEqual({ settings: { language: "chinese", customModels: null } });
  });

  it("PATCH with null clears the override", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const headers = { cookie: ctx.cookie };
    await ctx.app.inject({
      method: "PATCH",
      url: "/api/app-settings",
      headers,
      payload: { language: "japanese" },
    });
    const cleared = await ctx.app.inject({
      method: "PATCH",
      url: "/api/app-settings",
      headers,
      payload: { language: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ settings: { language: null, customModels: null } });
  });

  it("PATCH rejects a non-string / non-null language", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const headers = { cookie: ctx.cookie };
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/api/app-settings",
      headers,
      payload: { language: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});
