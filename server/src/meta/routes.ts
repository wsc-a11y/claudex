import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LatestReleaseResponse, MetaResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// GET /api/meta
//
// Backs the `/about` screen. Everything except `uptimeSec` is sampled once at
// boot — cheap, and nothing on this list changes between server restarts:
//
//   - `version`      — server `package.json#version`
//   - `commit`       — `git rev-parse HEAD` at the repo root; null when not a
//                      git checkout (Docker, archive extract) or git isn't on
//                      PATH
//   - `buildTime`    — `__BUILD_TIME__` (define-substituted at build time) if
//                      present, else the moment this module was imported
//                      (i.e. "server boot time")
//   - `nodeVersion`  — `process.versions.node`
//   - `sqliteVersion`— `SELECT sqlite_version()` (better-sqlite3 has no
//                      exported constant; the SQL is the only stable API)
//   - `platform`     — `${os.platform()} ${os.arch()}` (e.g. "darwin arm64")
//
// `uptimeSec` is `process.uptime()` at request time so the About screen
// can render "running for 23m".
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// The build-time define is declared via `declare const __BUILD_TIME__: string`
// in build setups that want to bake a real timestamp in. When unset we fall
// back to boot time — see `bootTimeIso` below.
declare const __BUILD_TIME__: string | undefined;

const bootTimeIso = new Date().toISOString();

/**
 * Locate the server package.json. We don't bake in a relative path because the
 * file can be imported from `src/` via tsx (dev/tests) or `dist/` (built
 * bundle). `fileURLToPath(import.meta.url)` gives us whichever the runtime
 * chose, and we walk up until we find a `package.json` with the
 * `@claudex/server` name stamped on it.
 */
function resolveServerPackageJson(): {
  version: string;
  rootDir: string;
} {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  // Safety cap on the walk so a misconfigured module path can't loop forever.
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (raw?.name === "@claudex/server" && typeof raw.version === "string") {
          return { version: raw.version, rootDir: cur };
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Last resort: an honest "unknown". Better than crashing the route for a
  // misplaced install layout.
  return { version: "0.0.0", rootDir: here };
}

const { version: serverVersion, rootDir: serverRootDir } =
  resolveServerPackageJson();

// Git commit — resolved once at boot, cached forever. Using `execFile`
// (no shell) with the repo root as cwd, and swallowing any error (non-repo,
// no git on PATH, detached filesystem) as `null`.
let cachedCommit: string | null = null;
let cachedCommitShort: string | null = null;
let commitResolved = false;
const commitPromise: Promise<void> = (async () => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: serverRootDir, timeout: 1500 },
    );
    const sha = stdout.trim();
    if (/^[0-9a-f]{40}$/.test(sha)) {
      cachedCommit = sha;
      cachedCommitShort = sha.slice(0, 7);
    }
  } catch {
    /* not a git checkout — leave null */
  } finally {
    commitResolved = true;
  }
})();

function resolveBuildTime(): string {
  try {
    // Guard the `typeof` check so bundlers that don't define the symbol still
    // work — a bare reference to `__BUILD_TIME__` would ReferenceError.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maybe = (globalThis as any).__BUILD_TIME__ as string | undefined;
    if (typeof maybe === "string" && maybe.length > 0) return maybe;
    if (typeof __BUILD_TIME__ === "string" && __BUILD_TIME__.length > 0) {
      return __BUILD_TIME__;
    }
  } catch {
    /* reference error on __BUILD_TIME__ when not defined — fall through */
  }
  return bootTimeIso;
}

const cachedBuildTime = resolveBuildTime();
const cachedPlatform = `${os.platform()} ${os.arch()}`;
const cachedNodeVersion = process.versions.node;

export interface MetaRoutesDeps {
  db: Database.Database;
}

export async function registerMetaRoutes(
  app: FastifyInstance,
  deps: MetaRoutesDeps,
): Promise<void> {
  // Sample SQLite once — better-sqlite3 compiles a fixed sqlite amalgamation
  // into the native binding, so the version can't change at runtime. We still
  // prepare it lazily (not at module import) so tests that mock the db in
  // exotic ways don't trip on a top-level query.
  let cachedSqliteVersion: string | null = null;
  const getSqliteVersion = (): string => {
    if (cachedSqliteVersion !== null) return cachedSqliteVersion;
    try {
      const row = deps.db
        .prepare("SELECT sqlite_version() AS v")
        .get() as { v?: unknown } | undefined;
      const v = row?.v;
      cachedSqliteVersion = typeof v === "string" ? v : "unknown";
    } catch {
      cachedSqliteVersion = "unknown";
    }
    return cachedSqliteVersion;
  };

  app.get(
    "/api/meta",
    { preHandler: app.requireAuth as any },
    async (): Promise<MetaResponse> => {
      // Ensure the git lookup finished — the async probe takes <100ms in the
      // common case. If someone hits `/api/meta` within the first few ms of
      // boot we want the real value, not a transient null.
      if (!commitResolved) {
        try {
          await commitPromise;
        } catch {
          /* already swallowed above */
        }
      }
      return {
        version: serverVersion,
        commit: cachedCommit,
        commitShort: cachedCommitShort,
        buildTime: cachedBuildTime,
        nodeVersion: cachedNodeVersion,
        sqliteVersion: getSqliteVersion(),
        platform: cachedPlatform,
        uptimeSec: Math.max(0, Math.floor(process.uptime())),
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/meta/latest-release — lazy + TTL-cached lookup of the most
  // recent GitHub release for `aaravarr/claudex`. The About screen uses it
  // to surface "you're up to date" / "v0.0.2 available" without making the
  // baseline `/api/meta` call slower (or coupling its uptime to a network
  // hop). Cache lives 1h in-process; an unreachable GitHub yields an
  // `ok: false` row that's still cached briefly so we don't hammer the
  // upstream when it's down.
  // -------------------------------------------------------------------------
  app.get(
    "/api/meta/latest-release",
    { preHandler: app.requireAuth as any },
    async (): Promise<LatestReleaseResponse> => {
      return getLatestReleaseCached(serverVersion);
    },
  );
}

// ---------------------------------------------------------------------------
// GitHub release fetcher.
//
// We hit `https://api.github.com/repos/<owner>/<repo>/releases/latest`, which
// returns the most recent NON-prerelease, NON-draft release. No auth header —
// unauthenticated calls have a 60/hour rate limit per IP, which is plenty
// for an About screen behind a 1h TTL.
//
// Failure modes that get folded into the `ok: false` branch:
//   - network errors / DNS failures (offline machine)
//   - HTTP non-2xx (rate limit, 404 if no release published)
//   - body that doesn't parse or is missing `tag_name`
//
// Cache is stored as a Promise so concurrent requests during the first miss
// share the same in-flight call. TTL is 1h on success, 5min on failure so
// a transient outage doesn't pin the muted state for an hour.
// ---------------------------------------------------------------------------

const GITHUB_RELEASE_URL =
  "https://api.github.com/repos/aaravarr/claudex/releases/latest";
const RELEASE_CACHE_OK_MS = 60 * 60 * 1000; // 1h on success
const RELEASE_CACHE_ERR_MS = 5 * 60 * 1000; // 5min on failure
const RELEASE_FETCH_TIMEOUT_MS = 5000;

interface ReleaseCache {
  expiresAt: number;
  promise: Promise<LatestReleaseResponse>;
}
let releaseCache: ReleaseCache | null = null;

function getLatestReleaseCached(
  currentVersion: string,
): Promise<LatestReleaseResponse> {
  const now = Date.now();
  if (releaseCache && releaseCache.expiresAt > now) {
    return releaseCache.promise;
  }
  const promise = fetchLatestRelease(currentVersion).then((res) => {
    // Re-rewrite the cache TTL based on the eventual outcome — `fetchLatestRelease`
    // doesn't know about the cache. Failure rows expire faster so an outage
    // self-heals on the next request after 5min instead of being pinned for 1h.
    if (releaseCache && releaseCache.promise === promise) {
      releaseCache.expiresAt =
        Date.now() + (res.ok ? RELEASE_CACHE_OK_MS : RELEASE_CACHE_ERR_MS);
    }
    return res;
  });
  releaseCache = { expiresAt: now + RELEASE_CACHE_OK_MS, promise };
  return promise;
}

async function fetchLatestRelease(
  currentVersion: string,
): Promise<LatestReleaseResponse> {
  const fetchedAt = new Date().toISOString();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), RELEASE_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(GITHUB_RELEASE_URL, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "claudex",
          "x-github-api-version": "2022-11-28",
        },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      // 404 = no release ever published; we still cache the negative result.
      return {
        ok: false,
        error: res.status === 404 ? "no_release" : `http_${res.status}`,
        currentVersion,
        fetchedAt,
      };
    }
    const data = (await res.json()) as {
      tag_name?: unknown;
      name?: unknown;
      html_url?: unknown;
      published_at?: unknown;
      body?: unknown;
    };
    const tag = typeof data.tag_name === "string" ? data.tag_name : "";
    if (!tag) {
      return { ok: false, error: "bad_payload", currentVersion, fetchedAt };
    }
    const version = tag.replace(/^v/, "");
    const name = typeof data.name === "string" && data.name.length > 0
      ? data.name
      : tag;
    const htmlUrl =
      typeof data.html_url === "string"
        ? data.html_url
        : `https://github.com/aaravarr/claudex/releases/tag/${encodeURIComponent(tag)}`;
    const publishedAt =
      typeof data.published_at === "string" ? data.published_at : fetchedAt;
    const body =
      typeof data.body === "string" ? data.body.slice(0, 2048) : "";
    return {
      ok: true,
      tag,
      name,
      version,
      htmlUrl,
      publishedAt,
      body,
      currentVersion,
      updateAvailable: compareVersions(version, currentVersion) > 0,
      fetchedAt,
    };
  } catch (err) {
    const code =
      (err as { name?: string } | null)?.name === "AbortError"
        ? "timeout"
        : "network";
    return { ok: false, error: code, currentVersion, fetchedAt };
  }
}

/**
 * Compare two semver-ish strings. Returns 1 if `a > b`, -1 if `a < b`, 0 if
 * equal. Designed for the narrow case at hand: claudex tags are `vMAJOR.MINOR.PATCH`
 * with optional `-prerelease` suffix. We compare numeric parts numerically;
 * any prerelease suffix makes the version "less than" its release counterpart
 * (consistent with semver), and within prerelease we string-compare.
 */
export function compareVersions(a: string, b: string): number {
  const [aBase, aPre = ""] = a.split("-", 2);
  const [bBase, bPre = ""] = b.split("-", 2);
  const aParts = aBase.split(".").map((p) => parseInt(p, 10) || 0);
  const bParts = bBase.split(".").map((p) => parseInt(p, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai !== bi) return ai > bi ? 1 : -1;
  }
  // Numeric parts equal — a prerelease loses to a release.
  if (aPre === bPre) return 0;
  if (aPre === "") return 1; // a is release, b is prerelease
  if (bPre === "") return -1;
  return aPre > bPre ? 1 : -1;
}

/** Test-only — drop the cache so a unit test can re-arm the fetcher. */
export function _resetReleaseCacheForTests(): void {
  releaseCache = null;
}
