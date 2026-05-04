# Helm — forward-compat items for remote / cloud / orchestration

## Current recommendation

This document is directionally useful, but it should not be treated as "implement every item immediately." The items have different confidence levels and different blast radius.

Recommended order:

1. **Do next:** F5 `workspace_uri`, and probably F6 `parent_session_id`.
2. **Think briefly before implementing:** F4 `target`. The concept is useful, but the enum name/values can fossilize early assumptions about whether future execution is `cloud`, `ssh`, `container`, `devcontainer`, `relay`, etc.

Already done (in commit `4df7869 fix: harden daemon session handling`):

- F1 — daemon accepts both `Authorization: Bearer <token>` and `?token=<token>`; SSE uses query-string auth; daemon rejects unauthenticated requests and non-allowlisted browser origins.
- F2 — dashboard API base URL and token are runtime-configurable via URL params, `localStorage`, env fallback, and localhost default.
- F3 — `SessionManager` delegates workspace creation/removal and archive-safety checks to `WorkspaceProvider`; local git behavior lives in `LocalWorktreeProvider`.
- F8 — SQLite bootstraps a `schema_migrations` table, records schema version 1, and includes an additive-column helper for future migrations.
- F9 — HTTP and SSE responses serialize sessions through `PublicSession` and sanitize `session_started` events so browser-facing payloads no longer include absolute local worktree paths, pids, or agent thread ids.

Context: three future capabilities are planned but not yet built:

1. **Remote control** — phone or other device accesses the dashboard and steers sessions running on the user's laptop.
2. **Cloud execution** — sessions run in cloud workspaces (containers / VMs), not on the user's local machine.
3. **Manager session + task board** — a meta-session that spawns and steers children; eventually a Symphony-style task board where tasks auto-dispatch sessions.

This file is **standalone** — the fixes-before-phase-5 batch is done; everything still outstanding lives here. None of these are bug fixes; they're forward-compat insurance plus a few near-term items that didn't land with the previous batch.

References used to derive these:
- Conductor OSS bridge/relay: `references/conductor-oss/docs/PRD-CONDUCTOR-BRIDGE-v2.md`, `references/conductor-oss/bridge-cmd/`, `references/conductor-oss/crates/conductor-relay/`.
- Symphony orchestrator: `references/symphony/SPEC.md`, `references/symphony/elixir/lib/symphony_elixir/orchestrator.ex`, `agent_runner.ex`, `workspace.ex`.

## Priority — do these alongside or right after the current fixes batch

### F1. Token auth via bearer header AND query string

**Status:** Done in `fix: harden daemon session handling` (commit `4df7869`).

**File:** `packages/daemon/src/server.ts` (auth middleware).

**Why:** SSE consumers use `EventSource`, which cannot set headers. The dashboard SSE streams (`/sessions/:id/events`, `/sessions/events`) need the token via query string (`?token=<token>`). The HTTP routes use header. Conductor does the same — see `bridge-cmd/main.go` for the pattern.

This is also the difference between "auth that only works locally" and "auth that carries to a remote relay later." If we lock auth to `Origin` header alone, remote control breaks because the dashboard origin will be different.

**Action:** No further action right now. Current daemon auth accepts both `Authorization: Bearer <token>` and `?token=<token>` on authenticated routes. Origin allowlist is defense-in-depth, not auth.

### F2. Make the dashboard's API base URL runtime-configurable, not just env-var

**Status:** Done.

**File:** `packages/web/src/lib/api.ts:3` — currently `process.env.NEXT_PUBLIC_HELM_API_URL ?? "http://127.0.0.1:7878"` (build-time).

**Why:** Today the URL is baked into the build. For remote control, the same Next.js bundle needs to point at:
- `http://127.0.0.1:7878` (local dev today)
- `https://relay.example.com/<device>` (remote control later)
- A cloud daemon URL (full cloud later)

Build-time env vars force per-deployment rebuilds and prevent runtime device-switching. Runtime config is also what lets a paired phone "remember" its device by URL.

**Action:**
- Add a small config bootstrap on first dashboard load: read API base + token from URL params (e.g. `?api=...&token=...`), fall back to `localStorage`, fall back to `process.env.NEXT_PUBLIC_HELM_API_URL`, fall back to `http://127.0.0.1:7878`.
- All `request()` calls in `api.ts` and the SSE hooks in `lib/sse.ts` read from this resolved value at call time, not module init.
- Keep `process.env` as the dev default so `bun run web` still just works.

### F3. Introduce a `WorkspaceProvider` interface and move git calls behind it

**Status:** Done.

**Files:**
- New: `packages/daemon/src/workspace/types.ts`, `packages/daemon/src/workspace/local.ts`.
- Modified: `packages/daemon/src/session-manager.ts:39-90` (`create()`), lines around 134-148 (`archive()`).
- Existing helpers: `packages/daemon/src/git.ts` (calls move into the local provider).

**Why:** This was the single biggest cloud-blocker. To run a session in a cloud workspace later, the workspace setup must be delegated to a backend that returns an opaque workspace handle (path or URI), not hard-coded to local git.

The same abstraction lets you support Symphony's SSH-worker model (cloud workspace on a remote host) without further refactor.

The provider owns more than just create/remove. The archive-safety logic (`worktreeStatus()`, `unsharedCommits()`, and `ArchiveSafetyError`) is local-git knowledge that does not generalize. A cloud workspace would have entirely different removal preconditions. F3 moved that logic into `LocalWorktreeProvider.assertRemoveSafe`, so `SessionManager` is not coupled to local git after the abstraction.

This was the largest item in the doc. Landing it before diff/commit/push/inspect endpoints keeps future lifecycle code behind the workspace provider boundary.

**Action — sketch:**

```ts
// packages/daemon/src/workspace/types.ts
export type WorkspaceHandle = {
  uri: string;          // e.g. "file:///Users/.../helm/worktrees/<repo>/<id>"
  cwd: string;          // path the runner adapter cd's into; for local == file:// path
  branch: string;       // for local: the helm branch name. For cloud: backend-defined.
};

export interface WorkspaceProvider {
  create(opts: {
    repo: RepoConfig;
    sessionId: string;
  }): Promise<WorkspaceHandle>;

  remove(handle: WorkspaceHandle, opts: { force: boolean }): Promise<void>;

  /**
   * Throws an `ArchiveSafetyError` (or provider-specific equivalent) if removing
   * the workspace would lose work — dirty tree, unshared commits, etc.
   * For local-worktree provider, this absorbs the existing dirty-worktree +
   * unshared-commits checks in session-manager.ts:272-274.
   */
  assertRemoveSafe(handle: WorkspaceHandle): Promise<void>;

  // Future: status(handle), diff(handle), commit(handle), push(handle), etc.
}
```

```ts
// packages/daemon/src/workspace/local.ts
export class LocalWorktreeProvider implements WorkspaceProvider {
  async create({ repo, sessionId }): Promise<WorkspaceHandle> {
    const branch = `helm/${sessionId}`;
    const path = worktreePath(repo.name, sessionId);
    await fetchOrigin(repo.path);
    await createWorktree(repo.path, branch, path, repo.default_branch);
    return { uri: `file://${path}`, cwd: path, branch };
  }
  async remove(handle, { force }): Promise<void> { /* current archive logic */ }
}
```

`SessionManager` constructor takes a `WorkspaceProvider` (default `LocalWorktreeProvider`). `create()` calls `this.workspace.create({...})` and uses the returned `cwd` to spawn the runner. `archive()` calls `this.workspace.assertRemoveSafe(handle)` (unless `force: true`) and then `this.workspace.remove(handle, {force})`. The `worktreeStatus()` and `unsharedCommits()` helpers move out of `session-manager.ts` and `git.ts` into `LocalWorktreeProvider`.

This change is a refactor — no schema change, no behavior change, existing tests should pass against the local provider unchanged.

### F4. Add `Session.target` enum column, default `"local"`

**Status:** Consider, but do not rush before the execution-target model is clearer.

**Files:** `packages/core/src/session.ts:11-24`, `packages/daemon/src/migrations.ts:2-15`, `packages/daemon/src/store.ts` (insert + parse).

**Why:** Every session is implicitly local today. Adding the column now (defaulting to `"local"`) means cloud sessions can be added later without a data migration on existing rows. The dashboard can also start filtering / badging by target without API changes.

**Action:**
- Add `target` to `Session` type, values `"local"` for now. Reserve room for `"cloud"` and other backends.
- Migration: `ALTER TABLE sessions ADD COLUMN target TEXT NOT NULL DEFAULT 'local'` if you want to run on existing DBs; otherwise just add to the `CREATE TABLE` statement and bump a schema version.
- `SessionManager.create()` accepts `target` in its input (default `"local"`); `WorkspaceProvider` selection is keyed off it.

Concern: `target` may be too coarse. Future backends might be better modeled as a workspace provider id (`local`, `ssh`, `container`, `devcontainer`, `relay`, etc.) rather than a local/cloud enum. Decide that naming before adding the column.

### F5. Add `Session.workspace_uri` alongside `worktree_path`

**Status:** Ready after F8; do when adding the workspace URI data-model transition.

**Files:** `packages/core/src/session.ts:16`, migrations, store.

**Why:** Local sessions correctly populate `worktree_path` with a filesystem path. Cloud sessions don't have one — their workspace might be `helm-cloud://workspace-id` or a backend-specific identifier. Adding `workspace_uri` as the canonical location field, with `worktree_path` kept for local convenience, lets the data model represent both.

**Action:**
- Add `workspace_uri: string` (nullable for now, or default to `"file://" + worktree_path` for new local sessions).
- Migration: `ALTER TABLE sessions ADD COLUMN workspace_uri TEXT`.
- `LocalWorktreeProvider.create()` returns it; `SessionManager.create()` writes it.
- Don't remove `worktree_path` yet — keep both during transition.

Recommendation: make `workspace_uri` the canonical internal field over time, and treat `worktree_path` as local-provider compatibility data. Browser-facing APIs should eventually avoid exposing either absolute local paths or raw local file URIs unless the user explicitly needs them.

### F6. Add `Session.parent_session_id` nullable column

**Status:** Ready after F8; probably do next, but keep it nullable and unused until manager sessions exist.

**Files:** `packages/core/src/session.ts`, migrations, store.

**Why:** The future manager session spawns child sessions. Without a parent reference, you'd need a join table or denormalized list to express "session B was spawned by session A." Adding the column now makes it a foreign-key reference and unlocks `WHERE parent_session_id = ?` queries cheaply.

If we never build the manager UI, the column costs us nothing. If we build it, retrofitting is a migration + every code path that creates sessions.

Concern: a single parent pointer is probably enough for "manager session spawned child session," but a future task board may also want task/session relationships. Do not overload this field for every orchestration relationship; add task-specific tables when the task board is designed.

**Action:**
- Add `parent_session_id: string | null` to `Session`.
- Migration: `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id)`.
- `CreateSessionInput` accepts `parent_session_id?` (default null); pass through to insert.
- No UI work required; the field just sits there until needed.

### F7. Confirm `SessionEventKind` stays open

**Status:** Mostly true at the SQLite layer, not true at the TypeScript layer.

**File:** `packages/core/src/events.ts:1-10`, `packages/daemon/src/migrations.ts:17-24`.

**Why:** The manager session and task board will introduce new event kinds (e.g. `session_spawn`, `task_dispatched`, `child_message_relay`). The SQL `kind TEXT NOT NULL` has no CHECK constraint, which is good. The TypeScript `NormalizedEvent` union is intentionally closed today, so adding new event kinds still requires code changes.

**Action:** No immediate change. Keep this in mind: do not add a SQL CHECK constraint or rigid runtime allowlist on event kinds. If task-board events need to be plugin-like or provider-defined, add an explicit generic extension event shape later rather than pretending the current union is open.

### F8. Add idempotent schema migrations before additive columns

**Status:** Done.

**Files:** `packages/daemon/src/migrations.ts`, `packages/daemon/src/store.ts`.

**Why:** The current database bootstrap creates tables with `CREATE TABLE IF NOT EXISTS`, but it does not add new columns to existing user databases. Adding `target`, `workspace_uri`, or `parent_session_id` only to the `CREATE TABLE` statement will work for fresh installs and silently fail for existing installs.

**Action:**
- Add a small migrations table, e.g. `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`.
- Keep the initial schema as version 1.
- Add idempotent migration helpers for additive columns, either by tracking versions or checking `PRAGMA table_info(sessions)`.
- Only then add F4-F6.

### F9. Stop exposing absolute filesystem paths to the browser

**Status:** Done.

**Files:**
- `packages/daemon/src/server.ts:50-70` (`GET /sessions`, `GET /sessions/:id`, SSE handlers).
- `packages/daemon/src/server.ts:144-200` (SSE publishes `event.session` rows wholesale via `send("session", ...)`).
- `packages/core/src/session.ts` (Session shape).
- `packages/web/src/lib/api.ts` (browser-facing types).

**Why:** `Session` rows include `worktree_path` (an absolute local path like `/Users/ryanbrown/.helm/worktrees/...`). All browser-facing surfaces ship the full row:

- `GET /sessions` returns `Session[]`.
- `GET /sessions/:id` returns `{session: Session, events: ...}`.
- SSE `/sessions/events` and `/sessions/:id/events` publish `event.session` updates with the full row.

The dashboard does not use `worktree_path` for anything (verify with a grep), so it's pure leak. Same problem class as the `/config` payload that was trimmed in fix 1.5 — but that fix only addressed config, not sessions. It also gets worse once F5 lands and `workspace_uri` is also a `file://...` string.

The right fix is a `PublicSession` DTO that the daemon serializes for HTTP/SSE endpoints by default, distinct from the internal `Session` row. The CLI should also receive `PublicSession` when it talks to the daemon over HTTP. If a future CLI command needs local-only fields, add a separate explicit local/admin path or perform the operation daemon-side rather than broadening the browser-facing DTO.

**Action:**
- Add a `PublicSession` type in `@helm/core` that omits `worktree_path` and any future local-only fields (e.g. `pid`, `agent_thread_id`). Keep `id`, `repo_name`, `agent_name`, `branch`, `status`, `last_assistant_message`, `last_event_at`, `created_at`, `updated_at`, `parent_session_id` (when added).
- Add a `toPublicSession(session: Session): PublicSession` helper next to the type definition.
- In `server.ts`, every place that serializes a `Session` to an HTTP response or SSE `data:` payload routes through `toPublicSession`.
- Update `web/src/lib/api.ts` types: replace `Session` with `PublicSession` for browser DTOs.
- Verify `bun run test:e2e` still passes (the dashboard shouldn't render anything that depends on the trimmed fields).
- CLI-over-HTTP uses the same `PublicSession` shape. If a later CLI feature needs local paths, add a clearly named local/admin endpoint such as `/internal/sessions/:id`, protect it intentionally, and do not reuse it from the browser dashboard.

This also slots into F5 cleanly: once `workspace_uri` exists, decide whether `PublicSession` exposes a *non-absolute* identifier (e.g. just the session id, or a sanitized scheme like `helm://session/<id>`) or omits the URI entirely from browser responses. Almost certainly omit.

## Things deliberately NOT in this batch

These are real future work but should NOT be done now:

- **Bridge daemon for remote control** — additive, do when we actually want phone access. Conductor's `bridge-cmd/` is the model.
- **Relay service** — same.
- **Cloud execution backend** — needs its own design pass; depends on F3 being done first.
- **Manager session adapter** — implement when we want it; F6 is the only data-model prep.
- **Task board entity + dispatcher loop** — Symphony's orchestrator is the model. Pure addition.
- **Diff endpoint** (`GET /sessions/:id/diff`) — additive, ~10 lines, do when needed.
- **Multi-tenant / multi-user** — out of scope.
- **Conductor's terminal-tunnel + back-pressure protocol** — Helm's headless-only model means we don't need it, ever. **Do not** add a terminal-stream surface "just in case." The whole point of headless is that we never have one.

## Validation

After F5-F6 land:

- `bun run test:unit` and `bun run test:e2e` still pass — these are pure refactors / additive columns.
- A session created via the existing flow has `target = "local"`, `workspace_uri` populated to `file://...`, `parent_session_id = null`.
- Existing SQLite databases migrate cleanly and preserve existing sessions.

After F1-F2:
- `helm daemon start` still works for local-only use.
- The Next.js dashboard, when loaded with `?api=...&token=...`, uses those values for all subsequent requests.
- An SSE connection succeeds with `?token=<token>` and fails without it.

After F9:
- `GET /sessions` and `GET /sessions/:id` no longer include `worktree_path` (or `pid`, `agent_thread_id`) in their response bodies.
- SSE session updates published to the browser also exclude those fields.
- `bun run test:e2e` still passes — the dashboard does not depend on any trimmed field.
- Internal in-process callers and daemon tests can still see the full `Session` row via `SessionManager.get()` / `.list()`.
- CLI-over-HTTP receives `PublicSession`; path-sensitive CLI commands should use an explicit local/admin mechanism if and when they exist.

## Notes for the implementer

- Order suggestion: F5/F6 → F4 if the target model is clear. F1-F3 and F8-F9 are already done.
- Each item is a separate commit (`feat`, `refactor`, `chore` as appropriate).
- F4-F6 are not just type edits; existing databases are now migration-ready, but the target/workspace naming still needs a short design decision.
- Do not add new dependencies. The entire batch is achievable with existing packages.
