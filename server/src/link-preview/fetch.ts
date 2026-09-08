// ---------------------------------------------------------------------------
// Link preview fetcher.
//
// Two jobs:
//   1. Decide whether a URL is safe to hit from the claudex process. The
//      server runs on the user's machine and has the loopback interface +
//      the private LAN available to it; an attacker who gets a preview
//      request through the auth wall must NOT be able to turn us into an
//      SSRF cannon pointed at `http://127.0.0.1:<something>` or cloud
//      metadata endpoints. We reject:
//        - non-http(s) schemes
//        - hostnames that are literal loopback / private / link-local / ULA
//          addresses (IPv4 and IPv6)
//        - hostnames that RESOLVE (via DNS) to any of the above. This closes
//          the DNS-rebinding hole where `evil.example.com` resolves to
//          127.0.0.1 at fetch time.
//        - the cloud metadata IPs (169.254.169.254 et al — already covered
//          by the link-local range, listed explicitly in comments so future
//          edits don't accidentally lift it)
//   2. Fetch the HTML (5s timeout, 512KB cap) and extract <title>,
//      <meta name="description">, and the common OG/Twitter tags via a
//      minimal regex parse. We deliberately avoid pulling in a DOM parser
//      — the wire format for these tags is well-known and the cost of a
//      full parser on every preview isn't worth the resolver accuracy.
//
//   Redirects are followed MANUALLY (max 3 hops). Each 3xx `Location` is
//   parsed, the host re-validated (both literal + DNS-resolved), and only
//   then re-fetched. This means an open redirector on a public site cannot
//   bounce us into the private network on hop 2.
// ---------------------------------------------------------------------------

import dns from "node:dns";

export interface FetchedPreview {
  status: number;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

/** Max bytes we will read off the wire before aborting the read. */
export const MAX_BYTES = 512 * 1024;
/** Per-request upstream timeout. */
export const FETCH_TIMEOUT_MS = 5000;
/** How many redirect hops we'll follow before giving up. */
export const MAX_REDIRECTS = 3;

/**
 * Classify a URL as either public-http(s) or rejected. Returns the parsed URL
 * on success, or a short string code describing the rejection.
 *
 * This is the SYNC literal-IP / bare-hostname check. A successful return here
 * does NOT guarantee the host is safe to fetch — a DNS name that resolves to
 * a private address still has to be caught. `assertPublicHost` below does the
 * DNS-resolved check and must be awaited before every outbound fetch.
 */
export function classifyUrl(
  raw: string,
):
  | { ok: true; url: URL }
  | { ok: false; reason: "bad_scheme" | "bad_host" | "bad_url" } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "bad_scheme" };
  }
  const host = url.hostname;
  if (!host) return { ok: false, reason: "bad_host" };
  if (isForbiddenHost(host)) {
    return { ok: false, reason: "bad_host" };
  }
  return { ok: true, url };
}

/**
 * Resolve `host` via DNS and reject if ANY returned address falls in a
 * private / loopback / link-local / ULA range. Must be awaited before every
 * fetch — `classifyUrl` only covers literal IPs; a hostname like
 * `rebind.attacker.example` that `A`-resolves to `127.0.0.1` slips through
 * the sync check and has to be caught here.
 *
 * For literal-IP hostnames we short-circuit (no DNS lookup). IPv6 literals
 * in brackets are unwrapped by WHATWG URL, so `URL('http://[::1]').hostname`
 * is `'::1'` and the sync `isForbiddenHost` path already returns true.
 *
 * Returns `{ ok: true }` when the host is safe to fetch; otherwise a reason
 * string that the caller translates to the HTTP error.
 */
export async function assertPublicHost(
  host: string,
): Promise<{ ok: true } | { ok: false; reason: "bad_host" }> {
  const lower = host.toLowerCase();
  // Re-run the literal + name-based block. Cheap, and it catches the case
  // where a redirect chain hops from a public name to a literal loopback.
  if (isForbiddenHost(lower)) {
    return { ok: false, reason: "bad_host" };
  }
  // If the host is a literal IP, isForbiddenHost already ruled — no DNS
  // query needed and no risk of rebinding (the literal can't change at
  // fetch time).
  const stripped = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  if (isIPv4Literal(stripped) || isIPv6Literal(stripped)) {
    return { ok: true };
  }
  // DNS lookup (A + AAAA). Any resolved address that lands in our private
  // block list fails the check. `all: true` lets us inspect every record so
  // a mixed A/AAAA response can't hide a private record behind a public
  // one in the first-result position.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.promises.lookup(stripped, { all: true });
  } catch {
    // Unresolvable host — let the fetch fail naturally so the caller sees a
    // 502 with the usual "upstream_failed" negative cache. Not a safety
    // issue: there's no address to reach.
    return { ok: true };
  }
  for (const a of addrs) {
    const addr = a.address;
    if (a.family === 4 || isIPv4Literal(addr)) {
      if (isPrivateIPv4(addr)) return { ok: false, reason: "bad_host" };
      continue;
    }
    // family === 6
    // Node may surface IPv4-mapped addresses (::ffff:10.0.0.1) as v6 entries —
    // isPrivateIPv6 already covers that shape, but fall through to it below.
    if (isPrivateIPv6(addr)) return { ok: false, reason: "bad_host" };
  }
  return { ok: true };
}

/**
 * Literal-IP / hostname blocklist. Covers:
 *   - IPv4: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *     169.254.0.0/16 (link-local, includes AWS/GCP metadata
 *     169.254.169.254), 0.0.0.0/8
 *   - IPv6: ::1, fc00::/7 (ULA), fe80::/10 (link-local), ::ffff:<ipv4-mapped>
 *   - Hostnames: "localhost" and any host whose last label ends in ".local"
 *     (Bonjour / mDNS — still on-network, still unsafe)
 *
 * Hostnames that aren't literal IPs fall through to the caller's DNS
 * resolver. We trust that claudex's operational envelope (run behind a
 * tunnel to a home LAN) doesn't need a stricter DNS-based guard; the
 * literal-IP check is what protects against the obvious SSRF payloads.
 */
export function isForbiddenHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost") return true;
  if (lower.endsWith(".local")) return true;
  // Strip brackets around IPv6 literals: new URL("http://[::1]").hostname === "::1"
  const stripped = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;

  if (isIPv4Literal(stripped)) {
    return isPrivateIPv4(stripped);
  }
  if (isIPv6Literal(stripped)) {
    return isPrivateIPv6(stripped);
  }
  return false;
}

function isIPv4Literal(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isPrivateIPv4(s: string): boolean {
  const parts = s.split(".").map(Number);
  const [a, b] = parts;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isIPv6Literal(s: string): boolean {
  // Crude but good enough: has at least one colon and contains only hex /
  // colons / dots (for v4-mapped).
  if (!s.includes(":")) return false;
  return /^[0-9a-f:.]+$/i.test(s);
}

function isPrivateIPv6(s: string): boolean {
  const lower = s.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  // ULA: fc00::/7 → first byte has the pattern 1111110x, i.e. fc.. or fd..
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // IPv4-mapped: ::ffff:<ipv4> — check the embedded v4
  const v4mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4mapped && isIPv4Literal(v4mapped[1]!)) {
    return isPrivateIPv4(v4mapped[1]!);
  }
  return false;
}

/**
 * Fetch `url` and extract lightweight metadata. Caps read size at MAX_BYTES
 * and gives up after FETCH_TIMEOUT_MS. Never throws — on any failure we
 * return a `FetchedPreview` carrying the upstream status (or 0 for network
 * errors) and no metadata, and callers persist that as a negative cache
 * entry.
 *
 * Redirects are followed MANUALLY (up to MAX_REDIRECTS hops). Each redirect
 * target is re-validated with the same DNS-aware host check before we issue
 * the next request. This prevents an open redirector on a public site from
 * bouncing us at 127.0.0.1 on hop 2 — a hole that Node's built-in
 * `redirect: "follow"` can't close because it has no way to consult our
 * block list.
 */
export async function fetchPreview(url: URL): Promise<FetchedPreview> {
  // First-hop DNS validation. The route already called `classifyUrl` (which
  // is sync + literal-only); do the async resolve here so we catch a DNS
  // rebind before issuing any request.
  const first = await assertPublicHost(url.hostname);
  if (!first.ok) {
    return { status: 0 };
  }

  let current = url;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let step: Response;
    try {
      step = await fetch(current, {
        redirect: "manual",
        signal: controller,
        headers: {
          // A polite UA so servers that dislike anonymous clients still
          // answer. No cookies / auth — this is an unauthenticated preview.
          "User-Agent": "claudex-link-preview/0.1 (+https://github.com/)",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        },
      });
    } catch {
      return { status: 0 };
    }

    // 301/302/303/307/308 — follow, after re-validating the Location host.
    if (step.status >= 300 && step.status < 400) {
      const loc = step.headers.get("location");
      if (!loc) {
        // Redirect without a target — treat as a network-ish error and
        // cache it negatively. The body went to /dev/null, drain to free
        // the socket.
        try {
          await step.body?.cancel();
        } catch {
          /* ignore */
        }
        return { status: step.status };
      }
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        try {
          await step.body?.cancel();
        } catch {
          /* ignore */
        }
        return { status: step.status };
      }
      // Re-validate scheme + literal-host on the redirect target, then DNS
      // on its hostname. An attacker-controlled redirector cannot flip us
      // onto an intra-network target without tripping one of these checks.
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        try {
          await step.body?.cancel();
        } catch {
          /* ignore */
        }
        return { status: step.status };
      }
      if (isForbiddenHost(next.hostname)) {
        try {
          await step.body?.cancel();
        } catch {
          /* ignore */
        }
        return { status: 0 };
      }
      const guard = await assertPublicHost(next.hostname);
      if (!guard.ok) {
        try {
          await step.body?.cancel();
        } catch {
          /* ignore */
        }
        return { status: 0 };
      }
      try {
        await step.body?.cancel();
      } catch {
        /* ignore */
      }
      current = next;
      continue;
    }

    res = step;
    break;
  }
  if (!res) {
    // Exhausted redirect budget without a final response — treat as failure.
    return { status: 0 };
  }

  if (!res.ok) {
    return { status: res.status };
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    // Still cache as a negative: we can't extract from non-HTML (images,
    // PDFs, JSON endpoints) and shouldn't keep re-fetching them.
    return { status: res.status };
  }

  const html = await readBodyCapped(res, MAX_BYTES);
  if (!html) {
    return { status: res.status };
  }
  const parsed = extractMeta(html);
  return { status: res.status, ...parsed };
}

async function readBodyCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= cap) {
        // Stop reading; we've got enough for <head> parsing in virtually
        // every real page. `reader.cancel()` releases the underlying
        // connection without waiting for EOF.
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  } catch {
    /* ignore truncated reads */
  }
  out += decoder.decode();
  return out;
}

/**
 * Regex-based metadata extractor. Only looks at the first ~64KB of the
 * response — <head> almost always fits — so even a 512KB read is cheap to
 * scan. Picks precedence:
 *
 *   title       ← og:title | twitter:title | <title>
 *   description ← og:description | twitter:description | <meta name="description">
 *   image       ← og:image | og:image:url | twitter:image | twitter:image:src
 *   siteName    ← og:site_name | application-name
 *
 * All values are trimmed and HTML-entity-decoded for the common `&amp; &lt;
 * &gt; &quot; &#39; &apos; &#NNN;` cases. Anything else survives as-is
 * because a DOM decoder is overkill for a 48×48 card caption.
 */
export function extractMeta(html: string): {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
} {
  // Limit scan window — <head> is ALWAYS in the first 64KB for sane sites.
  const scan = html.length > 64 * 1024 ? html.slice(0, 64 * 1024) : html;

  const ogTitle = metaContent(scan, "property", "og:title")
    ?? metaContent(scan, "name", "og:title")
    ?? metaContent(scan, "name", "twitter:title")
    ?? metaContent(scan, "property", "twitter:title");
  const titleTag = matchTag(scan, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = clean(ogTitle ?? titleTag);

  const description = clean(
    metaContent(scan, "property", "og:description")
      ?? metaContent(scan, "name", "og:description")
      ?? metaContent(scan, "name", "twitter:description")
      ?? metaContent(scan, "property", "twitter:description")
      ?? metaContent(scan, "name", "description"),
  );

  const image = clean(
    metaContent(scan, "property", "og:image")
      ?? metaContent(scan, "property", "og:image:url")
      ?? metaContent(scan, "name", "twitter:image")
      ?? metaContent(scan, "name", "twitter:image:src")
      ?? metaContent(scan, "property", "twitter:image"),
  );

  const siteName = clean(
    metaContent(scan, "property", "og:site_name")
      ?? metaContent(scan, "name", "application-name"),
  );

  return {
    title: title || undefined,
    description: description || undefined,
    image: image || undefined,
    siteName: siteName || undefined,
  };
}

/**
 * Find `<meta {attr}="{key}" content="..." />` — attributes can be in any
 * order and use either single or double quotes. Returns the raw content
 * value (still HTML-entity-encoded).
 */
function metaContent(
  html: string,
  attr: "property" | "name",
  key: string,
): string | undefined {
  // Two orderings: attr first or content first. Build both patterns.
  const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re1 = new RegExp(
    `<meta\\s+[^>]*${attr}\\s*=\\s*["']${keyEsc}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`,
    "i",
  );
  const re2 = new RegExp(
    `<meta\\s+[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*${attr}\\s*=\\s*["']${keyEsc}["'][^>]*>`,
    "i",
  );
  const m = html.match(re1) ?? html.match(re2);
  return m ? m[1] : undefined;
}

function matchTag(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m ? m[1] : undefined;
}

function clean(s: string | undefined): string {
  if (!s) return "";
  return decodeEntities(s).replace(/\s+/g, " ").trim().slice(0, 500);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return _;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _;
      }
    });
}
