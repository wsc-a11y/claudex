import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import dns from "node:dns";
import { bootstrapAuthedApp } from "./helpers.js";
import type { LinkPreview } from "@claudex/shared";

// ---------------------------------------------------------------------------
// GET /api/link-preview — login-gated URL preview card fetcher.
//
// We stub `fetch` with `vi.stubGlobal` so no test ever hits the real
// network. Each case installs its own stub and asserts the route honors:
//   - auth wall (401 unauth)
//   - URL shape + private-IP blocklist (400)
//   - successful parse of a mocked HTML body
//   - cache hit avoids a second upstream call
//   - failed upstream is cached with 1h TTL (no upstream call within that
//     window, route still returns the right error)
//   - per-user rate limit trips after RATE_LIMIT_MAX
// ---------------------------------------------------------------------------

type Ctx = Awaited<ReturnType<typeof bootstrapAuthedApp>>;

const HTML = `
<!doctype html><html><head>
<meta property="og:title" content="Anthropic">
<meta property="og:description" content="Claude is an AI assistant.">
<meta property="og:image" content="https://example.com/og.png">
<meta property="og:site_name" content="Anthropic">
<title>Anthropic — Fallback</title>
</head><body>ignored</body></html>`;

function okHtml(body = HTML): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("link preview routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    while (disposers.length) await disposers.pop()!();
  });

  beforeEach(() => {
    // Default stub: any test that doesn't replace this gets a predictable
    // failure so we don't accidentally hit the real internet.
    vi.stubGlobal("fetch", async () => {
      throw new Error("no fetch stub installed in test");
    });
  });

  it("401s unauthenticated callers", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/link-preview?url=" + encodeURIComponent("https://example.com"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s on private / non-http URLs", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const bads = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://example.com",
      "http://127.0.0.1",
      "http://localhost:8080/metrics",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1",
      "http://192.168.1.1",
      "http://172.16.0.1",
      "http://[::1]",
      "http://foo.local",
      "not a url at all",
      "",
    ];
    for (const url of bads) {
      const res = await ctx.app.inject({
        method: "GET",
        url:
          "/api/link-preview" +
          (url ? "?url=" + encodeURIComponent(url) : ""),
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode, `expected 400 for ${url}`).toBe(400);
    }
  });

  it("parses og tags from a known HTML response", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    vi.stubGlobal("fetch", vi.fn(async () => okHtml()));

    const res = await ctx.app.inject({
      method: "GET",
      url:
        "/api/link-preview?url=" + encodeURIComponent("https://example.com/x"),
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LinkPreview;
    expect(body.url).toBe("https://example.com/x");
    expect(body.title).toBe("Anthropic");
    expect(body.description).toBe("Claude is an AI assistant.");
    expect(body.image).toBe("https://example.com/og.png");
    expect(body.siteName).toBe("Anthropic");
    expect(typeof body.fetchedAt).toBe("string");
  });

  it("serves a second hit from cache without fetching", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const spy = vi.fn(async () => okHtml());
    vi.stubGlobal("fetch", spy);

    const url =
      "/api/link-preview?url=" + encodeURIComponent("https://example.com/cached");
    const r1 = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: ctx.cookie },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: ctx.cookie },
    });
    expect(r2.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // Same fetchedAt on both — they're the same row.
    expect((r1.json() as LinkPreview).fetchedAt).toBe(
      (r2.json() as LinkPreview).fetchedAt,
    );
  });

  it("caches a failed fetch (negative cache) and does not re-fetch within the TTL", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const spy = vi.fn(
      async () => new Response("nope", { status: 500 }),
    );
    vi.stubGlobal("fetch", spy);

    const url =
      "/api/link-preview?url=" +
      encodeURIComponent("https://example.com/broken");
    const r1 = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: ctx.cookie },
    });
    expect(r1.statusCode).toBe(502);
    const r2 = await ctx.app.inject({
      method: "GET",
      url,
      headers: { cookie: ctx.cookie },
    });
    expect(r2.statusCode).toBe(502);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("trips the rate limit after 60 previews", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    // Always return something uncached so every call hits the limiter.
    vi.stubGlobal("fetch", vi.fn(async () => okHtml()));

    let lastStatus = 0;
    let limited = false;
    for (let i = 0; i < 62; i++) {
      const res = await ctx.app.inject({
        method: "GET",
        url:
          "/api/link-preview?url=" +
          encodeURIComponent(`https://example.com/u${i}`),
        headers: { cookie: ctx.cookie },
      });
      lastStatus = res.statusCode;
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    expect(lastStatus).toBe(429);
  });

  // ---------------------------------------------------------------------
  // SSRF hardening: DNS rebinding + redirect validation.
  //
  // `classifyUrl` only inspects literal IPs, so a hostname like
  // `rebind.example.com` that A-resolves to 127.0.0.1 slips past the sync
  // check. The route now calls `assertPublicHost` before fetching, which
  // does a DNS lookup and rejects any address in the private blocklist.
  //
  // We stub `dns.promises.lookup` via vi.spyOn so the tests don't depend
  // on a real resolver. The literal-IP fast path short-circuits before
  // lookup (no spy hit), so test hostnames are non-literal names.
  // ---------------------------------------------------------------------

  it("400s when DNS resolves the hostname to a loopback address (rebinding)", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    // Install a lookup stub that claims rebind.example → 127.0.0.1.
    const spy = vi
      .spyOn(dns.promises, "lookup")
      .mockImplementation((async () =>
        [{ address: "127.0.0.1", family: 4 }]) as any);
    // fetch should never be called — the guard trips first.
    const fetchSpy = vi.fn(async () => okHtml());
    vi.stubGlobal("fetch", fetchSpy);

    const res = await ctx.app.inject({
      method: "GET",
      url:
        "/api/link-preview?url=" +
        encodeURIComponent("https://rebind.example/"),
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "private_or_invalid_host" });
    expect(fetchSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("blocks a redirect chain whose hop 2 resolves to a private address", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    // hop1.example is public; hop2.internal resolves to 10.0.0.5.
    const lookupSpy = vi
      .spyOn(dns.promises, "lookup")
      .mockImplementation((async (host: string) => {
        if (host === "hop1.example") {
          return [{ address: "93.184.216.34", family: 4 }];
        }
        if (host === "hop2.internal") {
          return [{ address: "10.0.0.5", family: 4 }];
        }
        return [{ address: "93.184.216.34", family: 4 }];
      }) as any);

    // The first fetch on hop1 returns a 302 to hop2.internal. The second
    // fetch must never happen — the guard rejects the redirect target
    // before we issue the next request.
    const fetchSpy = vi.fn(async (input: any) => {
      const href = typeof input === "string" ? input : input.href ?? input.url;
      if (href.startsWith("https://hop1.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://hop2.internal/secret" },
        });
      }
      // Should never be reached for hop2.
      return okHtml();
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/link-preview?url=" + encodeURIComponent("https://hop1.example/"),
      headers: { cookie: ctx.cookie },
    });
    // The route treats the blocked redirect as an upstream failure (502,
    // negatively cached) — the bundle doesn't need a 400 here because the
    // initial URL was legitimately public.
    expect(res.statusCode).toBe(502);
    // We fetched hop1 exactly once; hop2 was blocked by the DNS check.
    const hop2Calls = fetchSpy.mock.calls.filter((c) => {
      const href = typeof c[0] === "string" ? c[0] : (c[0] as any).href;
      return href?.startsWith("https://hop2.internal");
    });
    expect(hop2Calls.length).toBe(0);
    lookupSpy.mockRestore();
  });

  it("follows a normal public→public redirect chain", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    // Both hops resolve to public addresses.
    const lookupSpy = vi
      .spyOn(dns.promises, "lookup")
      .mockImplementation((async () =>
        [{ address: "93.184.216.34", family: 4 }]) as any);
    const fetchSpy = vi.fn(async (input: any) => {
      const href = typeof input === "string" ? input : input.href ?? input.url;
      if (href === "https://start.example/") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://canonical.example/article" },
        });
      }
      return okHtml();
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/link-preview?url=" + encodeURIComponent("https://start.example/"),
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LinkPreview;
    expect(body.title).toBe("Anthropic");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    lookupSpy.mockRestore();
  });
});
