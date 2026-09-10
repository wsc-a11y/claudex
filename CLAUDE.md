# claudex

> Remote Control for Claude Code — a browser front-end for the `claude` CLI on your own machine, designed mobile-first.

## What this project is (and isn't)

- **Is**: a self-hosted web service that runs on the same machine as your `claude` CLI and exposes it over HTTP + WebSocket so you can drive it from a phone. Mirrors the Claude Desktop *Code* tab in spirit; the goal is P0 parity — sessions, diffs, permission prompts, view modes, basic usage panel.
- **Is not**: a reimplementation of the Claude agent runtime. We **do not** call the Anthropic API directly. We spawn the user's `claude` CLI as a subprocess via `@anthropic-ai/claude-agent-sdk`, which gives us all the user's existing config (`~/.claude/`, MCP servers, skills, plugins, CLAUDE.md, OAuth tokens) for free.

If you find yourself reaching for the `@anthropic-ai/sdk` (Anthropic API client), stop — that's the wrong surface for this project. The right surface is `@anthropic-ai/claude-agent-sdk`.

## Repo layout

```
claudex/
├── mockup/       # static HTML mockup — design reference, not shipped
├── server/       # Node + TS backend  (@claudex/server)
├── web/          # React + TS frontend (@claudex/web)
├── shared/       # zod schemas + types shared by both (@claudex/shared)
├── pnpm-workspace.yaml
└── CLAUDE.md
```

`shared/` is the contract. If you add a field to a WS message, a session object, or an API response, it goes in `shared/` first and is imported by both sides. Do not duplicate type definitions across `server/` and `web/`.

## Tech stack

- **Backend**: Node 20 + TypeScript, Fastify + @fastify/websocket, better-sqlite3, bcrypt + otplib (TOTP) + jose (JWT), `@anthropic-ai/claude-agent-sdk`, pino
- **Frontend**: React 18 + TypeScript + Vite + Tailwind + Zustand + React Router v6
- **Package manager**: pnpm workspaces (pnpm 9+)

## Boundaries & conventions

- **Server bind host is deployer's call.** 默认绑 `0.0.0.0`(Windows + Tailscale 直连部署,手机经 Tailscale 直连 5179;2026-09 用户拍板)。Mac/frpc 或隧道前置形态请设 `CLAUDEX_HOST=127.0.0.1` 收紧回环。Public exposure is the user's responsibility (Tailscale / Cloudflare Tunnel / Caddy / frpc). Don't ship a one-click tunnel.
- **All state lives under `~/.claudex/`** — SQLite DB, logs, runtime config. Never pollute `~/.claude/`.
- **Auth is mandatory from day one** — no dev-mode backdoor. Username + password + TOTP; JWT in httpOnly cookie; WS handshake checks the cookie.
- **Mobile-first UI.** Every screen is designed for a 390px viewport first; desktop is an adaptive expansion.
- **Dark side of WS**: every message is a discriminated union with `type` as the tag, defined in `shared/src/protocol.ts` with zod. No ad-hoc JSON on the wire.

## Feature ledger — keep `docs/FEATURES.md` honest

`docs/FEATURES.md` is the source of truth for *what claudex actually does today*. Three tiers: ✅ ready, 🟡 partial (backend exists, UI missing or thin), ⬜ planned.

**Hard rule: every commit that changes user-visible behavior, adds an API surface, or promotes/demotes something between tiers must update `docs/FEATURES.md` in the same commit.** If you add a server capability but choose not to expose it in the UI yet, file it as 🟡 with a one-line note on what's missing — that's how we stop future agents from either re-implementing it or leaving the last 10% forever.

Before you start a task: read `docs/FEATURES.md` first. It'll tell you whether the thing you're about to build already exists as a backend-only 🟡 that just needs wiring, rather than a fresh build.

## Deployment reality (read this before editing anything)

The user runs claudex on their own Mac and accesses it from their phone over
**HTTP through an frpc tunnel**. Two facts flow from this:

1. **The site is NOT a secure context.** `crypto.randomUUID`,
   `navigator.clipboard.writeText`, `PushManager`, `Notification`,
   `crypto.subtle`, `ServiceWorker` — all are either unavailable or silently
   broken. Any code that touches them needs a runtime-detect fallback:
   ```ts
   const id =
     typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
       ? crypto.randomUUID()
       : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
   ```
   Same shape for clipboard (fall back to hidden `<textarea>` + `document.execCommand("copy")`).
2. **The server process is the live product.** `pnpm dev` is not running —
   the user connects to a built + restarted server. If you ship code and
   don't rebuild + restart, the user sees stale behavior (or worse, broken
   schema mismatches between old server and new client). See "Iteration loop"
   below.

There is always an `frpc` process running that tunnels port 5179 to the
public URL. **Never kill frpc.** Only kill the node server when restarting.

## Iteration loop — every batch, in order

This is how you close a batch of changes. **No shortcuts, no reordering.**
Even for a one-line fix, walk the whole list — the one time you skip step 3
is the time a Vite-side type elision breaks the server build.

**Automation rule, memorize this:** steps 1–6 (typecheck, test, build,
docs, commit, merge-to-main + push) run **automatically with no user
confirmation** — this is durable pre-authorization from the user.
**Only step 7 (server restart) is gated** and requires an explicit
"restart" / "重启" / "go". Do not ask before committing, merging, or
pushing — the user will tell you if they want something held back. The
one exception is the preflight checks inside step 6 (dirty main
checkout, main on a non-main branch, merge conflict) — those are
exceptional cases where you STOP and report instead of powering
through, because plowing on would destroy sibling-session work.

**Steps 4, 5, 6 are not optional.** A "done" batch is one that is
typechecked, tested, built, documented in `docs/FEATURES.md`, committed,
and pushed. Anything short of that is "in progress" and **must not be left
that way** — see "Working with agents" below for why: the user runs
multiple agents in parallel, and an uncommitted working tree from one
session is what makes another session walk into a mess of unfamiliar
unstaged files, unmerged index entries, and no clue what's theirs vs. a
sibling's. If you think "I'll commit after the next round of feedback,"
you are creating that mess. Commit and push now; iterate on top.

1. **`pnpm -r typecheck`** — shared + server + web all green.
2. **`pnpm --filter @claudex/server test`** — all green. `.skip` is allowed
   but call it out in the commit message.
3. **`pnpm --filter @claudex/web build`** — Vite build must succeed. This
   catches things typecheck misses (CSS, imports, bundle-only errors).
4. **Update `docs/FEATURES.md` if behavior changed** (see "Feature ledger"
   above). This is part of the commit, not a follow-up.
5. **Commit.** Message describes what changed, not how many agents ran.
   You do this yourself — do not ask first. If you're in a worktree
   session (the default — see "Worktree-per-session is the default"
   below), the commit lands on the session's `claude/<slug>` branch,
   not on main.
6. **Merge into local main, then push main. Auto-executes — do not
   ask for approval.** The user no longer edits main directly — every
   batch reaches main via a worktree → rebase → fast-forward → push
   chain. Worktree branches are **never pushed to origin**. Full
   procedure (clean-checkout preconditions, fast-forward merge,
   **batch commit message policy**, conflict handling) is in "Merging
   a worktree session back into main" below; read it once, then from
   each worktree session run these commands unprompted right after
   the commit lands. We rebase onto main first so the merge is always
   a fast-forward — main stays linear, no merge commits, each batch
   appears exactly once in the history:
   ```sh
   ROOT="$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')"
   BRANCH="$(git rev-parse --abbrev-ref HEAD)"
   git rebase main                          # no-op if already on tip
   git -C "$ROOT" merge --ff-only "$BRANCH"
   git -C "$ROOT" push origin main
   ```
   If the session is NOT on a worktree (rare — only when the user
   explicitly opted out), the old flow applies: `git commit` lands
   directly on main and a single `git push origin main` closes the
   batch.

   **Do NOT push through a proxy.** The local proxy ports (7890, 7897)
   are dead on this machine, and `git config http.proxy` still points at
   7897 — so a bare `git push` dies with `Failed to connect to 127.0.0.1
   port 7897`. Push **direct**: bypass the stale config rather than
   exporting proxy env vars:
   ```sh
   https_proxy= http_proxy= all_proxy= HTTP_PROXY= HTTPS_PROXY= \
     git -c http.proxy= -c https.proxy= push origin main
   ```
   Direct connections to github.com are occasionally reset; retry the
   same command a few times with a short sleep before reporting failure.
   Never "fix" this by re-enabling the proxy — it is not running.
7. **Wait for the user's go-ahead, then restart the server.** Restart is
   gated: after pushing, report the batch is ready and stop. Only when
   the user explicitly says to restart (e.g. "restart", "重启", "go") do
   you run the restart sequence below. This is because the user is
   driving live on mobile and picks the moment — an unsolicited restart
   can cut them off mid-task.

   When the user gives the word: **kill only the node process — leave
   frpc alone.** Use the restart script. It spawns a fully detached
   worker (Node `spawn({ detached: true, stdio: 'ignore' })`,
   cross-platform — works on macOS/Linux/Windows without `setsid`/`nohup`
   tricks) that waits for port 5179 to free up, then starts the new
   server. The worker is NOT a child of your shell / Claude / the old
   server, so killing the old server cannot cascade-kill the restart.
   ```sh
   SRV=$(lsof -ti :5179 -sTCP:LISTEN | head -1)
   node scripts/restart.mjs 5179   # detaches the relaunch worker, then returns
   kill $SRV                        # worker sees the port free and starts new server
   ```
   If you're logged in and the server is already up, you can instead hit
   the HTTP endpoint — it runs the same launcher internally and returns
   before exiting: `curl -b cookies.txt -X POST http://127.0.0.1:5179/api/admin/restart`.
   This is what claudex itself uses when Claude needs to restart the
   server it's running under (the old `kill + nohup` shell sequence
   deadlocked because Claude is a child of the server — killing the
   server killed Claude mid-command before `nohup ... &` finished
   detaching).

   **When Claude is the one triggering the restart** (mid-tool-call, because
   code just changed and the session needs the new server), the plain
   endpoint above is fine but leaves the triggering tool call rendering as
   a dangling "failed" in the chat transcript — the server dies before it
   can emit the `tool_result`. To avoid that, pass the current session id
   and tool_use id in the request body:
   ```sh
   curl -b cookies.txt -X POST http://127.0.0.1:5179/api/admin/restart \
     -H 'Content-Type: application/json' \
     -d '{"sessionId":"<claudex-session-id>","toolUseId":"<this-tool-use-id>"}'
   ```
   The server persists a `pending_restart_results` row before SIGTERMing
   itself. On the next boot, a sweep turns that row into a synthetic
   success `tool_result` event for the same `toolUseId`, force-idles the
   session, and deletes the row — so the chat UI shows a green tool result
   instead of a dangling one.

   For the Bash-path equivalent (same pattern, no cookie plumbing — reads
   `~/.claudex/cookies.txt` internally, falls back to plain restart.mjs if
   the HTTP call fails):
   ```sh
   node scripts/restart-self.mjs 5179 \
     --session-id <claudex-session-id> \
     --tool-use-id <this-tool-use-id>
   ```

   Then verify three things:
   - new pid listening on 5179: `lsof -ti :5179 -sTCP:LISTEN`
   - frpc pid unchanged: `pgrep -f 'frpc -c'` (remember it from before)
   - health 200: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5179/api/health`

Do not do any of: skip typecheck because "the change was small", push
without commit, restart without build, restart without the user's
explicit say-so, or leave the web bundle stale ("it'll pick it up next
time"). The user is driving this live — stale dist/ on a live server →
prod mismatch the moment they restart.

## Working with agents

The user prefers delegating implementation to sub-agents (Agent tool)
rather than direct edits. Pattern:

- **Lanes.** Assign each agent a file/dir lane with an explicit "Don't
  touch" list so parallel agents don't overwrite each other.
- **Paste the mockup inline.** If a change references `mockup/<file>.html`,
  paste the HTML snippet verbatim into the prompt. Do not assume the
  agent will read it carefully.
- **Paste the migration id.** If it's a DB change, `grep "id:"
  server/src/db/index.ts` first and write the next id into the prompt.
- **Remind agents about secure context.** Any agent writing frontend code
  that touches nonces, clipboard, crypto, or notifications should get the
  "HTTP not HTTPS" warning in their prompt.
- **Close the prompt with:** "typecheck / test / build must pass. Do NOT
  commit, push, or restart the server — I'll handle commit + push after
  reviewing, and the user gates restart." Sub-agents never touch git or
  the running server, even though the main Claude session does.
- **Side-branch QA agents don't block.** Spawn them in parallel with
  dev agents; their feedback rolls into the next batch, not this one.

### Parallel Claude sessions — you are not alone on this repo

The user routinely runs **multiple top-level Claude sessions against this
same checkout in parallel** (different phone tabs, different terminals,
different agents delegated from each). The preferred way to keep them
from stepping on each other is **one git worktree per session**, not a
shared cwd — see "Worktree-per-session is the default" below.

Even with worktrees in play, you may occasionally see unstaged changes,
untracked files, or unmerged index entries in the main checkout that
**you have not touched in this session** (e.g. a pre-worktree session,
or a session deliberately spawned without one). This is normal. It is
almost always a sibling session, not corruption.

The rule: **stay in your lane.**

- If `git status` shows modifications to files outside your current task,
  do NOT `git add` them, do NOT stash them away, do NOT `git checkout --`
  to "clean up", do NOT resolve conflicts in them. They belong to another
  session and overwriting them is destroying that session's work.
- If `git commit` / `git push` is blocked by someone else's dirty state
  (unmerged index entries, unstaged changes colliding with the push),
  **stop immediately** and report to the user. Do not try to force the
  commit through by stashing / resetting / checking out other files.
  The user will tell you whether to wait, whether to save your diff as a
  patch, or whether the sibling session is done and you can proceed.
- If you see unmerged entries (`git ls-files -u` non-empty) with no
  `.git/MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REBASE_HEAD`, that's a
  sibling's half-finished merge that the user paused. Leave it alone.
- When you stage files for commit, **name them explicitly** — `git add
  path/to/file1 path/to/file2`. Never `git add -A` or `git add .`; that
  is what sweeps sibling sessions' work into your commit and causes the
  cross-contamination the user is trying to avoid.

This is also why step 5+6 of the iteration loop ("commit" and "push") are
non-negotiable: every session that leaves its work uncommitted is leaving
a landmine for the next session. Close your batches.

### Worktree-per-session is the default

Because the user runs several agents in parallel, **claudex sessions on
this repo should be spawned with `worktree: true`** unless there's a
specific reason not to. Each session gets its own checkout under
`<project>/.claude/worktrees/<sessionId>` on a fresh `claude/<slug>`
branch, so:

- Agent A's half-finished edits never show up in Agent B's `git status`.
- Each agent can commit and push independently without "stay in your
  lane" concerns in its own branch.
- The main checkout stays clean for the user's own local work.

Both entry points (Home → New session sheet, and the Chat rail's inline
`+ New session` quick-create) now expose a **Use git worktree** toggle
that defaults to ON when the target project is a git repo. If you (as
the top-level Claude) are asked to spawn peer sessions via the API on
the user's behalf, pass `worktree: true` by default — the server will
400 `not_a_git_repo` if the project isn't a repo, at which point fall
back to `worktree: false` only for that specific project.

Reference notes on a worktree's lifecycle:
- The branch is `claude/<slug>-<suffix>` — find it with
  `git branch --list 'claude/*'` in the project root.
- Archiving a session removes the worktree dir but **leaves the branch**
  for manual disposition. After a successful merge (see below) the
  branch has served its purpose; it's safe to leave or prune via
  Settings → Advanced → Worktrees.
- Settings → Advanced → Worktrees lists every claudex-managed worktree
  with linked/orphaned classification and a Prune action for stale ones.

### Merging a worktree session back into main

The user does **not** edit the local `main` branch directly anymore.
Every batch of changes lands on a `claude/<slug>` worktree branch first,
then gets merged into the local main, then main gets pushed. Worktree
branches are **never pushed to origin** — `git push origin claude/...`
is always the wrong call. This is how step 6 of the iteration loop
actually executes inside a worktree session.

**This entire procedure runs automatically** right after step 5's
commit — do not pause to ask the user. The three preflight checks
below are exceptional-case bailouts (the merge would destroy someone
else's work), not a gate. In the normal case — main checkout clean,
on main branch, no conflict — merge and push fire back-to-back
without any "should I merge now?" prompt.

Before merging, verify three preconditions in this order. If any fails,
**stop and report to the user** — do not "clean up" the main checkout
yourself, it's either sibling-session state or the user's in-progress
work:

1. You're in a worktree session. Inside the worktree,
   `git rev-parse --show-toplevel` and
   `git worktree list --porcelain | awk '/^worktree / {print $2; exit}'`
   disagree — the latter is the main checkout, the former is your
   `.claude/worktrees/<sessionId>` dir. If they agree, you're NOT in a
   worktree and the merge step doesn't apply; fall back to the plain
   commit-on-main flow.
2. The main checkout is clean.
   `git -C "$ROOT" status --porcelain` empty, or STOP. Don't `git stash`,
   don't `git checkout --`, don't `git reset` — any of those can
   annihilate another session's work.
3. The main checkout is on `main`.
   `git -C "$ROOT" rev-parse --abbrev-ref HEAD` prints `main`, or STOP
   and ask. The user may be mid-something on another branch; a silent
   branch-switch breaks their mental model.

The merge itself — always fast-forward (`--ff-only`) so main stays
linear and each batch appears exactly once. Rebase the worktree branch
onto main first, so the FF merge works even if a sibling session has
since advanced main:
```sh
ROOT="$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"   # claude/<slug>-<suffix>
git rebase main                               # no-op if already on tip
git -C "$ROOT" merge --ff-only "$BRANCH"
```

**Why FF-only, not `--no-ff`.** An earlier policy used `--no-ff` so the
merge commit would record "this batch came from a worktree" for
bisecting later. In practice that value never materialized, and the
cost did: every batch showed up twice in `git log --oneline` (once as
the worktree commit, once as the merge commit reusing its message),
which made main's history confusing to read. Clean linear history wins;
dropped the merge commits.

**Batch commit message policy.** With FF-only, the worktree branch's
commit lands **directly on main** — whatever message you wrote in step
5 is what users see in `git log --oneline` forever. Treat it as a
public commit: one-line imperative subject, optional body, no "wip" /
"fix up" / "address feedback" phrasing. If the batch ended up as
multiple commits on the worktree branch (rare — only when you
intentionally split the work mid-batch), each of those commits will
also land on main as-is, so each one needs to stand on its own. If any
of them is a fixup/squash candidate, rebase-squash it into its parent
on the worktree branch **before** this merge step.

If `git rebase main` or `git merge --ff-only` exits non-zero,
**abort and stop**:
```sh
git rebase --abort 2>/dev/null || true        # if the rebase is the one that failed
```
Then report to the user. Do NOT try to resolve conflicts across two
checkouts — the tooling is confusing, the blast radius is large, and
the user has better context on which side should win. They'll tell you
whether to re-run the rebase with manual resolution, merge main into
the worktree for local resolution, or hand-edit from there.

After the merge succeeds, push main — direct, never through a proxy
(see "Do NOT push through a proxy" in step 6 for why and for the retry
policy):
```sh
https_proxy= http_proxy= all_proxy= HTTP_PROXY= HTTPS_PROXY= \
  git -C "$ROOT" -c http.proxy= -c https.proxy= push origin main
```

**Never** run `git push origin "$BRANCH"` for a `claude/*` worktree
branch. It's a local staging surface — once main carries the commits,
the branch has no reason to exist on origin, and pushing one would
clutter origin with dozens of one-shot session branches. Leaving the
branch locally is fine (user can prune via Settings → Advanced →
Worktrees when they want); deleting it here is also fine via
`git -C "$ROOT" branch -D "$BRANCH"` but not required.

## MVP scope (done)

P0–P3 are shipped. claudex now has auth + sessions + streaming + permission
prompts + diff rendering + most of P4/P5 (routines, queue, tags, search,
export, forking, terminal, …). Track current scope in `docs/FEATURES.md`,
not here — this section will drift.

## Releases

**Releases are never created proactively.** Only cut a GitHub release when the
user explicitly asks for one (e.g. "发个 release", "create a release"). If it's
ambiguous — ask, don't assume.

### Release procedure

1. **Pick a version.** Tag format is `vMAJOR.MINOR.PATCH` (semver, no leading
   zero). The About screen's `GET /api/meta/latest-release` endpoint hits
   `https://api.github.com/repos/aaravarr/claudex/releases/latest` (5s
   timeout, 1h TTL), strips the `v` prefix, and compares it against
   `server/package.json#version` with a dotted-numeric comparator — so the
   tag and the package.json version must agree.

2. **Bump all `package.json` files** that carry a version field — root,
   `server/`, `web/`, `shared/` — to the chosen version. Run the standard
   iteration-loop steps before committing: `pnpm -r typecheck`, `pnpm
   --filter @claudex/server test`, `pnpm --filter @claudex/web build`.

3. **Commit** the version bump with `chore(release): bump version to X.Y.Z`,
   merge into main, push main.

4. **Write release notes** as a temporary file (e.g. `/tmp/claudex-vX.Y.Z-notes.md`).
   Write them by hand — skim `git log` for `feat`/`fix`/`docs` commits since
   the last tag and group highlights by feature area. Don't use
   `--generate-notes`.

5. **Create the release** via `gh` — direct, never through a proxy (same
   rule as pushing; see step 6 of the iteration loop):
   ```sh
   https_proxy= http_proxy= all_proxy= HTTP_PROXY= HTTPS_PROXY= \
     gh release create vX.Y.Z \
       --title "vX.Y.Z — <short summary>" \
       --latest \
       --notes-file /tmp/claudex-vX.Y.Z-notes.md \
       --target main
   ```
   Use `--latest` for normal releases; only use `--prerelease` if the user
   explicitly asks for a prerelease.

6. **Verify:** `gh release view vX.Y.Z --json tagName,isDraft,isPrerelease,url`
   should show `isDraft: false` and the expected tag.

### What not to do

- Don't create a release without an explicit user ask.
- Don't push the `v*` tag from a worktree — the tag must point at a commit on
  `main`. `gh release create --target main` handles this.
- Don't use `--generate-notes` — the user prefers hand-written notes grouped by
  feature area.

## Don'ts

- Don't introduce Prisma / Drizzle / a full ORM — hand-written SQL +
  better-sqlite3 is fine and faster to iterate.
- Don't add TLS in-process. The user terminates TLS outside.
- Don't add telemetry/analytics.
- Don't silently truncate messages, diffs, or file content.
- **Don't use secure-context-only Web APIs without a fallback** (see
  "Deployment reality" above). This is the single most common regression
  agents introduce.
- **Don't write to `~/.claude/`.** That belongs to the CLI. claudex state
  is `~/.claudex/`, period. Reading `~/.claude/projects/*.jsonl` or
  `~/.claude/CLAUDE.md` is fine; writing is not.
- **Bind host 随部署形态**(默认已放开 `0.0.0.0` 给 Windows + Tailscale
  直连,见上方 Boundaries 条目;隧道前置形态记得 `CLAUDEX_HOST=127.0.0.1`)。
  不新增"一键公网暴露"类 helper;Public exposure is the user's
  responsibility (frpc, Cloudflare Tunnel, Tailscale, Caddy in front).
- **Don't persist state only in process memory** for anything that should
  survive a restart. Watchdog timers, queue state, session status — all
  of these need a SQLite row so the boot sweep can re-arm them.
- **Don't bypass `shared/`.** A new WS frame or API field goes in
  `shared/src/protocol.ts` first (with zod), then both sides import it.
