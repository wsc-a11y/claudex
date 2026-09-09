import type {
  Attachment,
  AuditListResponse,
  BrowseResponse,
  BrowseReadResponse,
  ChangePasswordRequest,
  CliSessionSummary,
  CreateQueuedPromptRequest,
  CreateRoutineRequest,
  CreateSessionRequest,
  CreateSideSessionRequest,
  ForkSessionRequest,
  RewindSessionResult,
  ImportAllResponse,
  PendingDiffsResponse,
  Project,
  QueuedPrompt,
  RecoveryCodesStateResponse,
  RegenerateRecoveryCodesResponse,
  Routine,
  Session,
  SessionEvent,
  SlashCommand,
  ToolGrant,
  TotpBeginResponse,
  TotpConfirmRequest,
  TotpConfirmResponse,
  TotpDisableRequest,
  TotpDisableResponse,
  UpdateProjectRequest,
  UpdateQueuedPromptRequest,
  UpdateRoutineRequest,
  UpdateSessionRequest,
  UsageRangeResponse,
  UsageSummaryResponse,
  UsageTodayResponse,
  UserEnvResponse,
  SearchResponse,
  MemoryResponse,
  StatsResponse,
  MetaResponse,
  LatestReleaseResponse,
  ListSubagentsResponse,
  AlertsListResponse,
  FilesTreeResponse,
  FilesReadResponse,
  FilesStatusResponse,
  SessionDiffResponse,
  AppSettings,
  UpdateAppSettingsRequest,
} from "@claudex/shared";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`api ${status}: ${code}`);
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    ...rest,
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) code = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login(body: { username: string; password: string }) {
    return request<{ requireTotp: boolean; challengeId: string | null }>(
      "/api/auth/login",
      { method: "POST", json: body },
    );
  },
  verifyTotp(body: { challengeId: string; code: string }) {
    return request<{ ok: true }>("/api/auth/verify-totp", {
      method: "POST",
      json: body,
    });
  },
  /**
   * Alternate second-factor path: redeem one of the 10 single-use recovery
   * codes instead of a rolling TOTP. Server validates, flips `used_at` on the
   * matched row, and issues the same session cookie as `verifyTotp`. Returns
   * how many codes remain so the login UI can nag if the user's running low.
   */
  verifyRecoveryCode(body: { challengeId: string; code: string }) {
    return request<{ ok: true; remaining: number }>(
      "/api/auth/verify-recovery-code",
      { method: "POST", json: body },
    );
  },
  logout() {
    return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
  },
  whoami() {
    return request<{ user: import("@claudex/shared").User }>("/api/auth/whoami");
  },
  listProjects() {
    return request<{ projects: Project[] }>("/api/projects");
  },
  createProject(body: { name: string; path: string }) {
    return request<{ project: Project }>("/api/projects", {
      method: "POST",
      json: body,
    });
  },
  updateProject(id: string, body: UpdateProjectRequest) {
    return request<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      json: body,
    });
  },
  deleteProject(id: string) {
    return request<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" });
  },
  /**
   * Bulk-remove every project with zero sessions. Returns the count and the
   * names so the UI can toast a precise summary.
   */
  cleanupEmptyProjects() {
    return request<{ removed: number; removedNames: string[] }>(
      "/api/projects/cleanup-empty",
      { method: "POST" },
    );
  },
  /**
   * Flip the trust bit on a project. `POST /api/sessions` refuses to spawn
   * a session under a project with `trusted === false` and returns
   * `409 project_not_trusted`; the NewSessionSheet's "Trust this folder?"
   * confirm card calls this with `trusted: true` just before creating the
   * session. Settings → Security → Trusted projects calls it both ways.
   */
  trustProject(id: string, trusted: boolean) {
    return request<{ project: Project }>(`/api/projects/${id}/trust`, {
      method: "POST",
      json: { trusted },
    });
  },
  browseHome() {
    return request<{ path: string }>("/api/browse/home");
  },
  browse(absPath: string) {
    return request<BrowseResponse>(
      `/api/browse?path=${encodeURIComponent(absPath)}`,
    );
  },
  browseRead(absPath: string) {
    return request<BrowseReadResponse>(
      `/api/browse/read?path=${encodeURIComponent(absPath)}`,
    );
  },
  listSessions(opts?: { project?: string; archived?: boolean }) {
    const qs = new URLSearchParams();
    if (opts?.project) qs.set("project", opts.project);
    if (opts?.archived) qs.set("archived", "1");
    const q = qs.toString();
    return request<{ sessions: Session[] }>(
      `/api/sessions${q ? `?${q}` : ""}`,
    );
  },
  getSession(id: string) {
    return request<{ session: Session }>(`/api/sessions/${id}`);
  },
  listEvents(
    sessionId: string,
    opts?: { sinceSeq?: number; beforeSeq?: number; limit?: number },
  ) {
    const qs = new URLSearchParams();
    if (opts?.sinceSeq !== undefined) qs.set("sinceSeq", String(opts.sinceSeq));
    if (opts?.beforeSeq !== undefined)
      qs.set("beforeSeq", String(opts.beforeSeq));
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    const q = qs.toString();
    return request<{
      events: SessionEvent[];
      hasMore: boolean;
      oldestSeq: number | null;
    }>(`/api/sessions/${sessionId}/events${q ? `?${q}` : ""}`);
  },
  getUsageSummary(sessionId: string) {
    return request<UsageSummaryResponse>(
      `/api/sessions/${sessionId}/usage-summary`,
    );
  },
  listPendingDiffs(sessionId: string) {
    return request<PendingDiffsResponse>(
      `/api/sessions/${sessionId}/pending-diffs`,
    );
  },
  /** PR-shaped aggregation of every file change in the session. Powers the
   *  /session/:id/session-diff screen (mockup s-15). */
  getSessionDiff(sessionId: string) {
    return request<SessionDiffResponse>(
      `/api/sessions/${sessionId}/session-diff`,
    );
  },
  createSession(body: CreateSessionRequest) {
    return request<{ session: Session }>("/api/sessions", {
      method: "POST",
      json: body,
    });
  },
  archiveSession(id: string) {
    return request<{ ok: true }>(`/api/sessions/${id}/archive`, {
      method: "POST",
    });
  },
  deleteSession(id: string) {
    // 204 No Content — `request` returns `undefined` for 204 by design.
    return request<void>(`/api/sessions/${id}`, { method: "DELETE" });
  },
  /**
   * Escape hatch for sessions stuck in `running` / `error`. The server
   * normally watchdogs silent runners, but a restart wipes the in-memory
   * timers; this endpoint lets the user manually bail out a row so the
   * composer unlocks. Refused with 409 `archived` on archived sessions.
   */
  forceIdleSession(id: string) {
    return request<{ session: Session }>(
      `/api/sessions/${id}/force-idle`,
      { method: "POST" },
    );
  },
  getSideSession(parentId: string) {
    return request<{ session: Session | null }>(
      `/api/sessions/${parentId}/side`,
    );
  },
  createSideSession(parentId: string, body?: CreateSideSessionRequest) {
    return request<{ session: Session }>(
      `/api/sessions/${parentId}/side`,
      { method: "POST", json: body ?? {} },
    );
  },
  updateSession(id: string, body: UpdateSessionRequest) {
    return request<{ session: Session; warnings?: string[] }>(
      `/api/sessions/${id}`,
      { method: "PATCH", json: body },
    );
  },
  /**
   * Rewrite the session's most recent user_message and re-run the assistant
   * turn. Server-side this truncates every event after the edited message,
   * updates its payload (with an `editedAt` stamp), broadcasts a
   * `refresh_transcript` frame so other tabs catch up, and pushes the new
   * text into the SDK's input queue. See the "Typo recovery" row in
   * docs/FEATURES.md for the known CLI-parity caveat.
   *
   * Refused by the server with 409 `not_idle` when a turn is in flight,
   * 400 `no_user_message` when the session has no user turn yet, and 400
   * `has_attachments` when the message carried file attachments (not yet
   * editable).
   */
  editLastUserMessage(id: string, text: string) {
    return request<{ ok: true; seq: number }>(
      `/api/sessions/${id}/edit-last-user-message`,
      { method: "POST", json: { text } },
    );
  },
  /**
   * Fork a session at a specific event into a brand-new session under the
   * same project. The fork inherits `projectId`, `model`, and `mode`, and
   * copies every event with `seq <= upToSeq` verbatim (with a normalized
   * 1..N seq). It does NOT inherit `sdkSessionId` — the fork is a fresh SDK
   * conversation, so the assistant has no memory of being forked.
   *
   * `upToSeq` omitted → fork at the latest event in the source. `title`
   * omitted → `"Fork of <source.title>"`, truncated at 60 chars. Server
   * refuses with 409 `archived` when the source session is archived.
   */
  forkSession(id: string, opts?: Partial<ForkSessionRequest>) {
    return request<{ session: Session }>(`/api/sessions/${id}/fork`, {
      method: "POST",
      json: opts ?? {},
    });
  },
  /**
   * Roll the session's tracked files back to their state at the user message
   * with `upToSeq` (the bundled CLI's checkpoint feature — conversation
   * history is untouched). `dryRun: true` previews without touching disk;
   * omit it to execute. Server errors: 409 `archived` / `no_cli_session`,
   * 422 `anchor_unresolved`, 500 `rewind_failed` — see the route contract.
   */
  rewindSession(
    id: string,
    body: { upToSeq: number; dryRun?: boolean },
  ) {
    return request<RewindSessionResult>(`/api/sessions/${id}/rewind`, {
      method: "POST",
      json: body,
    });
  },
  listGrants(sessionId: string) {
    return request<{ grants: ToolGrant[] }>(
      `/api/sessions/${sessionId}/grants`,
    );
  },
  /**
   * Every tool grant on the machine, flattened. Used by Settings → Security
   * so the user can audit + revoke grants globally without drilling into
   * each session. Global grants come first, then session grants, each
   * group sorted by `createdAt` DESC. Session rows carry `sessionId` +
   * `sessionTitle` so the UI can label which session owns each grant.
   */
  listAllGrants() {
    return request<{ grants: ToolGrant[] }>("/api/grants");
  },
  revokeGrant(grantId: string) {
    return request<{ ok: true }>(`/api/grants/${grantId}`, {
      method: "DELETE",
    });
  },
  listSlashCommands(projectId?: string) {
    const q = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : "";
    return request<{ commands: SlashCommand[] }>(
      `/api/slash-commands${q}`,
    );
  },
  listRoutines() {
    return request<{ routines: Routine[] }>("/api/routines");
  },
  getRoutine(id: string) {
    return request<{ routine: Routine }>(`/api/routines/${id}`);
  },
  createRoutine(body: CreateRoutineRequest) {
    return request<{ routine: Routine }>("/api/routines", {
      method: "POST",
      json: body,
    });
  },
  updateRoutine(id: string, body: UpdateRoutineRequest) {
    return request<{ routine: Routine }>(`/api/routines/${id}`, {
      method: "PATCH",
      json: body,
    });
  },
  deleteRoutine(id: string) {
    return request<{ ok: true }>(`/api/routines/${id}`, { method: "DELETE" });
  },
  runRoutine(id: string) {
    return request<{ sessionId: string }>(`/api/routines/${id}/run`, {
      method: "POST",
    });
  },
  listQueue() {
    return request<{ queue: QueuedPrompt[] }>("/api/queue");
  },
  createQueued(body: CreateQueuedPromptRequest) {
    return request<{ queued: QueuedPrompt }>("/api/queue", {
      method: "POST",
      json: body,
    });
  },
  updateQueued(id: string, body: UpdateQueuedPromptRequest) {
    return request<{ queued: QueuedPrompt }>(`/api/queue/${id}`, {
      method: "PATCH",
      json: body,
    });
  },
  deleteQueued(id: string) {
    return request<{ ok: true }>(`/api/queue/${id}`, { method: "DELETE" });
  },
  reorderQueued(id: string, direction: "up" | "down") {
    return request<{ ok: true; moved: boolean }>(
      `/api/queue/${id}/${direction}`,
      { method: "POST" },
    );
  },
  /**
   * Move a queued row to an absolute index within the queued sub-list.
   * Drives the desktop drag-and-drop reorder on the Queue screen — the
   * server clamps `seq` to the valid range so "drop past the end" is a
   * tolerated no-op rather than a 400.
   */
  moveQueued(id: string, seq: number) {
    return request<{ ok: true; moved: boolean }>(`/api/queue/${id}/move`, {
      method: "POST",
      json: { seq },
    });
  },
  changePassword(body: ChangePasswordRequest) {
    return request<{ ok: true }>("/api/auth/change-password", {
      method: "POST",
      json: body,
    });
  },
  /**
   * How many recovery codes are still unused, and when was the current batch
   * issued. Never returns plaintext codes — only `regenerateRecoveryCodes`
   * ever emits plaintext, exactly once per call.
   */
  getRecoveryCodesState() {
    return request<RecoveryCodesStateResponse>(
      "/api/auth/recovery-codes/state",
    );
  },
  /**
   * Wipe the existing recovery-code batch and issue 10 fresh ones. The
   * plaintext is returned exactly once — display in a one-time modal with
   * copy/download affordances and then forget it. Any previously issued code
   * (used or not) stops working the moment this resolves.
   */
  regenerateRecoveryCodes() {
    return request<RegenerateRecoveryCodesResponse>(
      "/api/auth/recovery-codes/regenerate",
      { method: "POST" },
    );
  },
  /**
   * Mint a fresh TOTP secret + otpauth URI for pairing a new authenticator.
   * The secret is NOT persisted yet — the caller echoes it back via
   * `confirmTotp` along with a current 6-digit code from the new pairing
   * before it lands on the user row.
   */
  beginTotp() {
    return request<TotpBeginResponse>("/api/auth/totp/begin", {
      method: "POST",
    });
  },
  /**
   * Confirm a TOTP pairing started by `beginTotp`. The body must include
   * the new `secret`, a current 6-digit `code` from it, and exactly one of
   * `currentTotp` (if 2FA is currently on — proves the old device) or
   * `password` (if 2FA is currently off — first-time enable).
   */
  confirmTotp(body: TotpConfirmRequest) {
    return request<TotpConfirmResponse>("/api/auth/totp/confirm", {
      method: "POST",
      json: body,
    });
  },
  /**
   * Turn 2FA off. Wipes the stored secret and every recovery-code row.
   * Always password-gated since "disable 2FA" is a permanent downgrade
   * a stolen cookie should not be able to perform on its own.
   */
  disableTotp(body: TotpDisableRequest) {
    return request<TotpDisableResponse>("/api/auth/totp/disable", {
      method: "POST",
      json: body,
    });
  },
  getUserEnv() {
    return request<UserEnvResponse>("/api/user/env");
  },
  listCliSessions() {
    return request<{ sessions: CliSessionSummary[] }>("/api/cli/sessions");
  },
  importCliSessions(sessionIds: string[]) {
    return request<{ imported: Session[] }>("/api/cli/sessions/import", {
      method: "POST",
      json: { sessionIds },
    });
  },
  getUsageToday() {
    return request<UsageTodayResponse>("/api/usage/today");
  },
  getUsageRange(days: number) {
    return request<UsageRangeResponse>(`/api/usage/range?days=${days}`);
  },
  /**
   * Snapshot aggregation backing the Home → Statistics sheet. Single honest
   * SQL pass over sessions + session_events (see `server/src/stats/routes.ts`);
   * returns zeros / nulls / empty arrays on an empty DB rather than 404.
   */
  getStats() {
    return request<StatsResponse>("/api/stats");
  },
  /**
   * Server version, git commit, build time, node + sqlite versions, platform,
   * and uptime. Backs the `/about` screen. Static fields are cached server-
   * side at boot; `uptimeSec` is live per request. `commit` / `commitShort`
   * are null when the server wasn't launched from a git checkout.
   */
  getMeta() {
    return request<MetaResponse>("/api/meta");
  },
  /**
   * Latest GitHub release for `aaravarr/claudex`. Lazily fetched + cached
   * server-side for 1h. Response is a discriminated union: `ok: true` with
   * tag/version/htmlUrl/etc., or `ok: false` with an `error` code (network,
   * timeout, no_release, http_xxx). The About screen uses `updateAvailable`
   * to decide whether to show the "update available" banner.
   */
  getLatestRelease() {
    return request<LatestReleaseResponse>("/api/meta/latest-release");
  },

  // ---------------------------------------------------------------------------
  // Admin — self-restart. Spawns a detached worker that waits for the listen
  // port to drain, then execs the new server. The old server responds 200
  // (or dryRun:true under NODE_ENV=test) and SIGTERMs itself ~150ms later;
  // the TCP connection drops mid-response on a real restart, so the client
  // should treat network errors AFTER the fetch resolved as success.
  //
  // Optional `sessionId` + `toolUseId` carry the id of the in-flight tool
  // call that initiated the restart — the server persists a
  // pending_restart_results row and the next boot's sweep converts it into
  // a synthetic success tool_result so the chat UI shows green instead of
  // a dangling failed tool call. The UI "Restart server" button omits them
  // (there's no triggering tool_use to preserve); Claude's Bash/HTTP path
  // is where they're wired.
  adminRestart(opts?: { sessionId?: string; toolUseId?: string }) {
    const body: Record<string, string> = {};
    if (opts?.sessionId) body.sessionId = opts.sessionId;
    if (opts?.toolUseId) body.toolUseId = opts.toolUseId;
    return request<{ ok: true; dryRun?: boolean }>("/api/admin/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  /** Update to a specific GitHub release tag and restart. The About page's
   *  "Update now" button calls this with the tag from LatestReleaseResponse.
   *  Server spawns a detached worker that git-fetches, checks out the tag,
   *  runs pnpm install, then restarts. */
  adminUpdateAndRestart(tag: string) {
    const body: Record<string, string> = { tag };
    return request<{ ok: true; dryRun?: boolean }>("/api/admin/update-and-restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  // ---------------------------------------------------------------------------
  // Alerts — persistent queue of "needs your attention" rows, keyed on
  // session status transitions. The badge in AppShell and the dedicated
  // /alerts screen both consume this.
  // ---------------------------------------------------------------------------
  listAlerts() {
    return request<AlertsListResponse>("/api/alerts");
  },
  markAlertSeen(id: string) {
    return request<{ ok: true }>(`/api/alerts/${encodeURIComponent(id)}/seen`, {
      method: "POST",
    });
  },
  markAllAlertsSeen() {
    return request<{ ok: true; touched: number }>(`/api/alerts/seen-all`, {
      method: "POST",
    });
  },
  dismissAlert(id: string) {
    return request<{ ok: true }>(
      `/api/alerts/${encodeURIComponent(id)}/dismiss`,
      { method: "POST" },
    );
  },
  // ---------------------------------------------------------------------------
  // Files browser — read-only project file viewer (mockup s-14). All three
  // endpoints are JWT-gated and resolve paths relative to a project root on
  // the host; path-traversal attempts are rejected server-side with 403
  // `traversal_denied`. See server/src/files/routes.ts for the contract.
  // ---------------------------------------------------------------------------
  filesTree(projectId: string, relPath?: string) {
    const qs = new URLSearchParams();
    qs.set("project", projectId);
    if (relPath) qs.set("path", relPath);
    return request<FilesTreeResponse>(`/api/files/tree?${qs.toString()}`);
  },
  filesRead(projectId: string, relPath: string) {
    const qs = new URLSearchParams();
    qs.set("project", projectId);
    qs.set("path", relPath);
    return request<FilesReadResponse>(`/api/files/read?${qs.toString()}`);
  },
  filesStatus(projectId: string) {
    return request<FilesStatusResponse>(
      `/api/files/status?project=${encodeURIComponent(projectId)}`,
    );
  },
  /**
   * Read-only observability feed for subagent tool invocations (the SDK's
   * `Task` / `Agent` / `Explore` family). Backs the `/agents` screen. Scoped
   * via `status=active|done|all` (default `all`); items are `toolUseId`-keyed
   * runs ordered newest first and capped at `limit` (default 100, max 500).
   * The `stats` block is unconditional — the four cards read the same
   * regardless of which filter the caller applied.
   */
  listAgents(opts?: { status?: "active" | "done" | "all"; limit?: number; sessionId?: string }) {
    const qs = new URLSearchParams();
    if (opts?.status && opts.status !== "all") qs.set("status", opts.status);
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.sessionId) qs.set("sessionId", opts.sessionId);
    const q = qs.toString();
    return request<ListSubagentsResponse>(
      `/api/agents${q ? `?${q}` : ""}`,
    );
  },
  /**
   * Full-text search across session titles + message bodies.
   *
   * The server 400s on empty / whitespace-only `q`; callers should
   * short-circuit and skip the request rather than relying on that. See
   * the web GlobalSearchSheet for the concrete debounced-typing flow.
   */
  search(q: string, limit?: number) {
    const qs = new URLSearchParams();
    qs.set("q", q);
    if (limit !== undefined) qs.set("limit", String(limit));
    return request<SearchResponse>(`/api/search?${qs.toString()}`);
  },
  /**
   * Build a `GET /api/sessions/:id/export` URL for a plain anchor download.
   * Returned as a URL rather than a fetch wrapper because the browser's
   * native download flow (anchor click) is what we actually want — wrapping
   * it in fetch would force us to build a Blob for a response we already
   * have on the server with the right Content-Disposition headers.
   */
  exportSessionUrl(id: string, format: "md" | "json") {
    return `/api/sessions/${encodeURIComponent(id)}/export?format=${format}`;
  },
  /**
   * Trigger a browser download for a session's transcript by synthesizing
   * an anchor click. No-ops in non-DOM environments.
   */
  exportSession(id: string, format: "md" | "json") {
    if (typeof document === "undefined") return;
    const a = document.createElement("a");
    a.href = this.exportSessionUrl(id, format);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
  /**
   * Upload a single file to a session's attachment store. Returns the created
   * attachment metadata (id, filename, mime, size, previewUrl for images).
   * The raw bytes are served back via `previewUrl`, which for non-image mime
   * types is undefined (composer uses the filename chip instead of a thumb).
   *
   * Does NOT go through `request()` because we need to post a FormData body
   * without stringifying — `fetch` handles the multipart encoding natively
   * when you omit Content-Type.
   */
  async uploadAttachment(sessionId: string, file: File): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachments`,
      { method: "POST", credentials: "same-origin", body: form },
    );
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) code = body.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as Attachment;
  },
  /** Delete an as-yet-unlinked attachment. 404 after the attachment has been
   * sent with a message. */
  deleteAttachment(id: string) {
    return request<void>(`/api/attachments/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  listAudit(opts?: { limit?: number; since?: string; events?: string[]; before?: string }) {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.since) qs.set("since", opts.since);
    if (opts?.events && opts.events.length > 0)
      qs.set("events", opts.events.join(","));
    if (opts?.before) qs.set("before", opts.before);
    const q = qs.toString();
    return request<AuditListResponse>(`/api/audit${q ? `?${q}` : ""}`);
  },
  // --- Client errors ----------------------------------------------------
  listClientErrors(opts?: {
    status?: "open" | "resolved" | "all";
    limit?: number;
    before?: string;
  }) {
    const qs = new URLSearchParams();
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.before) qs.set("before", opts.before);
    const q = qs.toString();
    return request<
      import("@claudex/shared").ClientErrorListResponse
    >(`/api/client-errors${q ? `?${q}` : ""}`);
  },
  resolveClientError(id: string) {
    return request<{ ok: true }>(
      `/api/client-errors/${encodeURIComponent(id)}/resolve`,
      { method: "POST" },
    );
  },
  reopenClientError(id: string) {
    return request<{ ok: true }>(
      `/api/client-errors/${encodeURIComponent(id)}/reopen`,
      { method: "POST" },
    );
  },
  deleteClientError(id: string) {
    return request<{ ok: true }>(
      `/api/client-errors/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  resolveAllClientErrors() {
    return request<{ ok: true; resolved: number }>(
      "/api/client-errors/resolve-all",
      { method: "POST" },
    );
  },
  deleteResolvedClientErrors() {
    return request<{ ok: true; deleted: number }>(
      "/api/client-errors/resolved",
      { method: "DELETE" },
    );
  },
  /**
   * Read-only CLAUDE.md preview for a project. Backs the "Memory" section in
   * the session settings sheet. Returns an empty `files` array when neither
   * the project nor the user-global CLAUDE.md exists.
   */
  getProjectMemory(projectId: string) {
    return request<MemoryResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/memory`,
    );
  },
  /**
   * List every claudex-managed `claude/*` git worktree across the user's
   * projects, each tagged `linked` (a session row still owns it) or
   * `orphaned` (nothing references it — safe to prune). Powers the Settings
   * "Worktrees" advanced section.
   */
  listWorktrees() {
    return request<{ worktrees: WorktreeSummary[] }>("/api/worktrees");
  },
  /**
   * Bulk-prune one or more orphan worktrees. Each entry carries enough to
   * anchor the prune in a specific project without trusting a free-form
   * path from the client. The server refuses to touch any branch that
   * doesn't start with `claude/`, so you can safely pass a mixed batch.
   */
  pruneWorktrees(
    items: Array<{ projectId: string; branch: string; path: string }>,
  ) {
    return request<{
      results: Array<{
        projectId: string;
        branch: string;
        path: string;
        removed: boolean;
        error?: string;
      }>;
    }>("/api/worktrees/prune", {
      method: "POST",
      json: { worktrees: items },
    });
  },
  /**
   * Full-data backup download. The server returns a JSON bundle
   * (Content-Disposition: attachment) containing every project, session,
   * event, routine, queued prompt, grant, attachment metadata, and the last
   * 1000 audit rows. Secrets (password hashes, TOTP / VAPID / JWT) are never
   * included. We just return the plain download URL here — the UI wires it
   * to an `<a href>` so the browser's native download handling kicks in.
   */
  exportAllUrl(): string {
    return "/api/export/all";
  },
  /**
   * Import a previously-exported bundle. Merges into the current database:
   * projects dedupe on path; sessions are always inserted as new rows;
   * events are re-sequenced per session; grants, attachments, and push
   * subscriptions are skipped. Returns per-table counts + skip reasons so
   * the UI can render an honest success toast.
   */
  async importAll(file: File): Promise<ImportAllResponse> {
    const form = new FormData();
    form.append("bundle", file, file.name);
    const res = await fetch("/api/import/all", {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) code = body.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as ImportAllResponse;
  },

  /**
   * Read the global claudex preferences (language override, etc.) from
   * `/api/app-settings`. `null` on a field means the user hasn't set an
   * override — claudex defers to Claude Code's own settings for that knob.
   */
  getAppSettings() {
    return request<{ settings: AppSettings }>("/api/app-settings");
  },

  /**
   * Patch the global claudex preferences. `null` clears the override for
   * that field (returns to "defer to Claude Code"). Omitting a field leaves
   * it untouched (partial update).
   */
  updateAppSettings(body: UpdateAppSettingsRequest) {
    return request<{ settings: AppSettings }>("/api/app-settings", {
      method: "PATCH",
      json: body,
    });
  },
};

/**
 * One entry returned by `listWorktrees`. Matches the server's `Worktree`
 * struct in `server/src/sessions/worktree-manage.ts`. Declared here rather
 * than `@claudex/shared` because it's a pure diagnostic surface — no WS
 * frames or persisted schema.
 */
export interface WorktreeSummary {
  branch: string;
  path: string;
  sha: string | null;
  projectId: string;
  projectName: string;
  projectPath: string;
  status: "linked" | "orphaned";
  lastModified: string | null;
}
