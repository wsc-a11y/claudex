import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import type { LatestReleaseResponse, MetaResponse } from "@claudex/shared";
import {
  _resetReleaseCacheForTests,
  compareVersions,
} from "../src/meta/routes.js";

// ---------------------------------------------------------------------------
// Meta route — powers the About screen. Thin surface; test that auth is
// enforced and that the shape returned is what `@claudex/shared::MetaResponse`
// claims (string version, nullable commit fields, numeric uptime, sqlite
// version actually looks like a sqlite version).
// ---------------------------------------------------------------------------

describe("meta routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/meta",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns version, platform, sqlite, node, and uptime", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/meta",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MetaResponse;

    // Version — `@claudex/server/package.json#version`. We don't pin the
    // value (it bumps with releases) but insist on the shape.
    expect(typeof body.version).toBe("string");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);

    // Commit fields are either both null or both non-null; commitShort is
    // the first 7 chars of commit when present.
    if (body.commit === null) {
      expect(body.commitShort).toBeNull();
    } else {
      expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(body.commitShort).toBe(body.commit.slice(0, 7));
    }

    // buildTime is always ISO-ish. Node's Date constructor round-trips.
    expect(typeof body.buildTime).toBe("string");
    expect(Number.isNaN(Date.parse(body.buildTime))).toBe(false);

    // nodeVersion should match process.versions.node exactly — no `v` prefix.
    expect(body.nodeVersion).toBe(process.versions.node);

    // sqliteVersion is dotted semver-ish.
    expect(body.sqliteVersion).toMatch(/^\d+\.\d+\.\d+/);

    // platform has the form `${os.platform()} ${os.arch()}`.
    expect(body.platform.split(" ")).toHaveLength(2);

    // uptimeSec is a non-negative integer. Tests boot quickly, so it should
    // be < 60 on a sane CI — but we only enforce non-negativity here, since
    // the ≥ bound is what actually matters for the shape.
    expect(Number.isFinite(body.uptimeSec)).toBe(true);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// `/api/meta/latest-release` — GitHub release lookup. We stub `fetch` to
// avoid hitting api.github.com and assert the contract (auth gate, ok-true
// shape with updateAvailable bit, ok-false shape on network/HTTP failures,
// in-process cache shares one upstream call across concurrent hits).
// ---------------------------------------------------------------------------

describe("meta /latest-release route", () => {
  const disposers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    _resetReleaseCacheForTests();
    // Default: any test that forgets to install its own stub fails loudly
    // rather than silently calling the real upstream.
    vi.stubGlobal("fetch", async () => {
      throw new Error("no fetch stub installed in test");
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    _resetReleaseCacheForTests();
    while (disposers.length) await disposers.pop()!();
  });

  it("requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/meta/latest-release",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns ok=true with tag, htmlUrl, and updateAvailable on success", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    // Pick a tag that's clearly newer than the package version (which lives
    // in claudex's `0.0.x` range today). 99.0.0 is enough to force
    // updateAvailable=true regardless of how the running package.json drifts.
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: "v99.0.0",
            name: "v99.0.0 — the future",
            html_url:
              "https://github.com/aaravarr/claudex/releases/tag/v99.0.0",
            published_at: "2030-01-01T00:00:00Z",
            body: "release notes go here",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/meta/latest-release",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LatestReleaseResponse;
    if (!body.ok) throw new Error(`expected ok=true, got ${body.error}`);
    expect(body.tag).toBe("v99.0.0");
    expect(body.version).toBe("99.0.0");
    expect(body.name).toBe("v99.0.0 — the future");
    expect(body.htmlUrl).toContain("/releases/tag/v99.0.0");
    expect(body.publishedAt).toBe("2030-01-01T00:00:00Z");
    expect(body.body).toBe("release notes go here");
    expect(body.updateAvailable).toBe(true);
    expect(typeof body.currentVersion).toBe("string");
    expect(typeof body.fetchedAt).toBe("string");

    // Verify we called the github releases endpoint with a UA header (so
    // GitHub doesn't 403 us for being a bare fetch client).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.github.com");
    expect(url).toContain("releases/latest");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(
      "claudex",
    );
  });

  it("returns ok=false on HTTP errors", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/meta/latest-release",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LatestReleaseResponse;
    if (body.ok) throw new Error("expected ok=false on 404");
    expect(body.error).toBe("no_release");
    expect(typeof body.currentVersion).toBe("string");
  });

  it("returns ok=false on network failure", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("ECONNREFUSED");
      }),
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/meta/latest-release",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LatestReleaseResponse;
    if (body.ok) throw new Error("expected ok=false on network failure");
    expect(body.error).toBe("network");
  });

  it("caches successful responses across calls", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tag_name: "v0.0.1",
            html_url:
              "https://github.com/aaravarr/claudex/releases/tag/v0.0.1",
            published_at: "2026-01-01T00:00:00Z",
            body: "",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", spy);

    // Two back-to-back hits should share one upstream call.
    await ctx.app.inject({
      method: "GET",
      url: "/api/meta/latest-release",
      headers: { cookie: ctx.cookie },
    });
    await ctx.app.inject({
      method: "GET",
      url: "/api/meta/latest-release",
      headers: { cookie: ctx.cookie },
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Pure unit test for the version comparator. Lives next to the route
// because the comparator is exported from `../src/meta/routes.ts` for this
// reason — it's the only piece of release-fetching logic that's worth
// covering in isolation, since the rest is just network plumbing.
// ---------------------------------------------------------------------------

describe("compareVersions", () => {
  it("orders numeric parts numerically", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1); // not lexicographic
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });
  it("treats prereleases as lower than the matching release", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });
  it("treats missing trailing parts as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });
});
