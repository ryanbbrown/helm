# Plan: Helm Diff Viewer

Spec: `.specs/local-mvp.md`
Library: [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) (Shiki-based React diff component, also used by conductor-oss).

**Spec changes this work makes (in the same commit as the code that implements them):**
- §11 HTTP API → adds `GET /sessions/:id/diff?base=...`, `POST /sessions/:id/pull-request`, and a transient SSE hint event named `diff_changed`.
- §13 Out of Scope → remove "Diff review flows" from the list.
- §7.3 Normalized Event Stream → note that `diff_changed` is not a persisted normalized event; it is a live-only SSE hint with no replay guarantee.
- §5.1.3 Session schema → add `pull_request_url TEXT` column (nullable). Idempotent migration via the F8 additive helper.
- §3 Dependencies (or wherever external CLI tooling is documented) → add `gh` as an optional runtime dep, required for the Create PR flow. Helpful error when missing.

## Overview

Add a per-session diff view to the dashboard so the user can see what each session's agent has changed in its worktree. The diff is computed daemon-side from the local worktree, served over the existing authenticated HTTP surface, and rendered in the dashboard inside `SessionDetail` as a resizable side panel that auto-refreshes when the agent finishes a turn.

Strict v1: local worktrees only, no annotations, no per-commit history view, no archived-session snapshots. The diff review surface is read-only; the "Create PR" action is allowed because it acts on the whole session branch rather than editing or annotating the diff.

## Decisions (confirmed)

1. **Library:** `@pierre/diffs`. Already approved. Shiki-based, SSR-friendly, used by conductor-oss for the same use case. Lazy-loaded on the diff panel so Shiki + language grammars don't bloat the initial bundle.
2. **What to show:** both **uncommitted only** and **full session-branch vs `origin/<default_branch>`**, with a UI toggle. Default = full-branch (matches "what did my agent do across this session"). No per-commit history view in v1.
3. **Where it lives:** **resizable split inside `SessionDetail`** — messages on the left, diff on the right, draggable divider. Diff is hidden behind a "Show diff" toggle in the session header; when shown, the divider position is remembered per-session in `localStorage`. Not a separate route; not a modal.
4. **Refresh:** **SSE-pushed `diff_changed` hint event**. Daemon emits one transient hint per session whenever an assistant turn completes; dashboard refetches the diff for the open session. This is not a persisted timeline event and is not replayed from SQLite. No polling, no file watcher. Manual "Refresh" button is also present as a fallback.
5. **Large diffs:** per-file collapse-by-default; per-file ceiling (e.g. >500 KB or >5 000 lines → "file too large to render" placeholder); whole-diff file-count ceiling (e.g. >200 files → "too many files; showing first N of M"). No virtualization in v1.
6. **Binary files:** daemon detects binary entries, sets `isBinary: true`, includes `oldSize` / `newSize` when available, and omits patch text; UI shows `(binary file changed, X bytes)` placeholder. Not rendered through Pierre.
7. **Archived sessions:** worktree is gone after archive (§6.4). Diff panel shows a static "Diff unavailable — session archived" placeholder. No snapshotting in v1; if the user wants post-mortem review later, that becomes its own phase.
8. **Diff review is read-only:** no per-line comments, no accept/reject hunks, no "send hunk back to agent as message" flow in v1. Pierre supports all of this as a follow-up phase if and when desired.
9. **Auth:** existing token + origin allowlist (§12) inherits — no new auth surface.
10. **Placement on F3 abstraction:** `WorkspaceProvider` (already landed) grows a `diff(handle, options): Promise<DiffResult>` method **and** a `createPullRequest(handle, options): Promise<{ url: string }>` method. `LocalWorktreeProvider` implements both via existing git plumbing + `gh`. Cloud workspace providers later implement the same methods against their own backend. The HTTP routes in `server.ts` are thin wrappers.
11. **Create PR flow:** "Create PR" button at the top of the diff panel. Daemon fetches `origin/<default>` to refresh the local ref, then runs `git push -u origin helm/<id>` followed by `gh pr create --base <default> --head helm/<id> --title <prompt-derived> --body <generated>`. Refuses with structured `409` errors on:
    - **dirty_worktree** — `git status --porcelain` non-empty (mirrors archive-safety check).
    - **no_commits_ahead** — branch has zero commits beyond `origin/<default_branch>` (after fetch).
    - **gh_unavailable** — `gh` CLI missing or unauthenticated.
    - **non_github_remote** — repo's `origin` is not a GitHub URL; v1 only supports GitHub PRs.
    If `pull_request_url` is already present, the route returns the existing session without invoking `git push` or `gh pr create` again. If `gh pr create` reports an existing PR for the same head branch (i.e. the user manually pushed and opened one earlier), persist that URL and treat it as success rather than failing. On first success, persists `pull_request_url` on the session row and returns it to the caller. The button stays visible after PR creation but flips to a "View PR" link. Button is disabled only for archived sessions and sessions currently `running` — all other refusal conditions surface as modal errors after submit, not as pre-disabled UI.

These are settled; do not relitigate during build.

## Steps

### Phase A — Daemon: `WorkspaceProvider.diff` + HTTP route + spec update

Goal: `curl -H "Authorization: Bearer $HELM_TOKEN" "http://127.0.0.1:7878/sessions/<id>/diff?base=branch"` returns a structured JSON diff for any non-archived session, computed from the on-disk worktree. Archived sessions return `410 archived`.

#### A.1 Shared types in `@helm/core`

| File | Purpose |
|---|---|
| `packages/core/src/diff.ts` | New. Defines `DiffBase = "uncommitted" \| "branch"`, `DiffFileEntry` (path, status, oldPath?, additions, deletions, isBinary, oldSize?, newSize?, isTooLarge, patch?), `DiffResult` (base, generatedAt, files, truncated, fileLimit, totalFiles), `DiffChangedHint { kind: "diff_changed", sessionId }`, and PR result/error types. One zod schema per type so the HTTP route validates response shape in dev. |
| `packages/core/src/events.ts` | No `diff_changed` addition here. `NormalizedEvent` / `PublicNormalizedEvent` remain persisted timeline events only; `diff_changed` travels on the transient SSE hint path. |
| `packages/core/src/index.ts` | Re-export. |

#### A.2 Workspace-provider diff method

| File | Purpose |
|---|---|
| `packages/daemon/src/workspace/types.ts` | Extend `WorkspaceProvider` interface with `diff(handle, options: { repo: RepoConfig; base: DiffBase; fileSizeLimit: number; fileCountLimit: number }): Promise<DiffResult>`. |
| `packages/daemon/src/workspace/local.ts` | Implement `diff()` for `LocalWorktreeProvider`. Internals call the existing `Bun.$` git wrappers in `git.ts`. |
| `packages/daemon/src/git.ts` | Add `gitMergeBase()`, `gitDiffStatus()`, `gitDiffPatch()`, and `gitUntrackedFiles()` helpers. For `base = "uncommitted"`: enumerate tracked staged/unstaged changes with `git -C <worktree> diff HEAD --numstat --raw -z`, then add untracked files from `git ls-files --others --exclude-standard -z` as synthetic `"added"` entries. For `base = "branch"`: compute `mergeBase = git merge-base origin/<default_branch> HEAD`, enumerate the final worktree state with `git -C <worktree> diff <mergeBase> --numstat --raw -z`, then add untracked files the same way. Do not build this by merging a committed diff with a second dirty diff; one final-state diff avoids duplicate/confusing entries for files changed both before and after a commit. Apply `fileSizeLimit` (skip patch text, mark `isTooLarge: true`) and `fileCountLimit` (truncate the file list, set `truncated: true`, keep `totalFiles` for UI copy). Detect binary via `--numstat`'s `-` markers; emit `isBinary: true`, include available size metadata, and skip patch text. |

Defaults at the call site: `fileSizeLimit = 500_000` bytes, `fileCountLimit = 200`. Constants live in `packages/core/src/diff.ts` so the dashboard can echo the same numbers in placeholder copy.

#### A.3 HTTP route

| File | Purpose |
|---|---|
| `packages/daemon/src/server.ts` | Register `GET /sessions/:id/diff?base=uncommitted\|branch` (default `branch`). Returns `400 invalid_base` for invalid base values, `404` for unknown sessions, and `410 archived` if `status === "archived"`. Otherwise calls `sessionManager.diff(id, { base })` and returns the JSON `DiffResult`. Auth + origin behave like any existing route. |
| `packages/daemon/src/session-manager.ts` | New `diff(id, opts)` method. Loads the session, builds the `WorkspaceHandle` via `provider.fromSession(...)`, calls `provider.diff(handle, ...)`. No state mutation. |

#### A.4 Emit `diff_changed` on assistant turn completion

| File | Purpose |
|---|---|
| `packages/daemon/src/event-bus.ts` | Add a third bus event shape for live hints, e.g. `{ type: "hint"; hint: DiffChangedHint }`. This is separate from `{ type: "event"; event: SessionEvent }`, because `SessionEvent` rows are persisted and replayed from SQLite. |
| `packages/daemon/src/session-manager.ts` | When a turn-completion runner event arrives (today this is what flips status to `awaiting_input` / `completed`), publish `{ type: "hint", hint: { kind: "diff_changed", sessionId: id } }`. **Do not persist** to `session_events`. |
| `packages/daemon/src/server.ts` | Per-session SSE handler (`GET /sessions/:id/events`) and the global stream both forward live hints as SSE event name `diff_changed` with payload `{ kind: "diff_changed", sessionId }`. Replay remains limited to persisted timeline events. |

#### A.5 Spec update

In the same commit as the rest of Phase A:
- `.specs/local-mvp.md` §11.1 — add the `GET /sessions/:id/diff` route row.
- §7.3 — note that `diff_changed` is a live-only SSE hint ("UI hint that the worktree diff has changed; no payload beyond session id; not persisted; not replayed").
- §13 — strike "Diff review flows".

#### A.6 Verify

```bash
helm daemon start
helm session create test-repo-1 claude -p "add a file foo.txt with the date"
# wait for assistant to finish

curl -sH "Authorization: Bearer $HELM_TOKEN" \
  "http://127.0.0.1:7878/sessions/<id>/diff?base=branch" | jq .
# expect: { base: "branch", files: [{ path: "foo.txt", status: "added", additions: 1, deletions: 0, ... }], truncated: false, ... }

curl -sH "Authorization: Bearer $HELM_TOKEN" \
  "http://127.0.0.1:7878/sessions/<id>/diff?base=uncommitted" | jq .
# expect: empty file list if the agent committed; else just the dirty paths.

# After archive:
helm session archive <id>
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $HELM_TOKEN" \
  "http://127.0.0.1:7878/sessions/<id>/diff"
# expect: 410
```

Plus: open the per-session SSE stream and confirm a `diff_changed` event lands when the agent finishes a turn.

---

### Phase B — Web: minimal diff panel, manual refresh

Goal: in the dashboard, click "Show diff" on an active session and see the rendered diff via Pierre. Manual refresh button only — no auto-refresh yet (that's Phase C). No resizable split yet either — fixed-width side panel. Smallest possible cut that proves the wire is end-to-end.

#### B.1 Dependencies

| File | Purpose |
|---|---|
| `packages/web/package.json` | Add `@pierre/diffs` (latest). Confirm React major version is compatible (current dashboard is Next 16 / React 19; check `peerDependencies` of `@pierre/diffs` first commit of this phase and pin if needed). |

#### B.2 API client

| File | Purpose |
|---|---|
| `packages/web/src/lib/api.ts` | `getSessionDiff(id, base): Promise<DiffResult>` — calls `GET /sessions/:id/diff?base=...`, returns the typed shape from `@helm/core`. Same `request()` plumbing as existing calls, so token + origin are inherited. |

#### B.3 Diff panel component

| File | Purpose |
|---|---|
| `packages/web/src/components/SessionDiff.tsx` | New. Lazy-loads `@pierre/diffs/react` via `next/dynamic` with `ssr: false` (Pierre's worker pool is client-only per its docs). Wraps content in `WorkerPoolContextProvider`. Renders one `<FileDiff>` per non-binary, non-too-large entry; collapsed by default with a click-to-expand row showing `path + additions/deletions`. Renders binary entries as `(binary file changed, X→Y bytes)`. Renders too-large entries as `(file too large to render — showing summary only)`. Renders truncated whole-diff with a banner: "showing first N of M files". Includes a "Refresh" button that re-calls `getSessionDiff`. |
| `packages/web/src/components/SessionDetail.tsx` | Add a `Show diff` toggle button to the session header; when toggled on, render `<SessionDiff>` to the right of the message timeline (fixed split for now — Phase C makes it resizable). When the session is archived, render the `Diff unavailable — session archived` placeholder instead of fetching. |

#### B.4 Verify

- Start daemon + dashboard, create a session that modifies one file, finish the turn.
- Click "Show diff" — diff appears within ~1s, file is collapsed, click expands the patch with syntax highlighting.
- Click Refresh after a follow-up turn — diff updates.
- Network tab: bundle size for the route loads only after toggle (lazy-load works).
- Archive the session — refresh dashboard, "Show diff" shows the archived placeholder; no network call hits the diff route.

---

### Phase C — Resizable split, base toggle, SSE auto-refresh

Goal: the things that take Phase B from "MVP-of-MVP" to "actually pleasant." Closes out the *review* half of the v1 experience.

#### C.1 Resizable split inside `SessionDetail`

| File | Purpose |
|---|---|
| `packages/web/src/components/ResizableSplit.tsx` | New. Two children, draggable vertical divider, min/max widths, mouse + touch + keyboard. ~80 lines of plain React; no new dependency. Persists the divider position to `localStorage` keyed by session id. |
| `packages/web/src/components/SessionDetail.tsx` | Wrap messages + `<SessionDiff>` in `<ResizableSplit>` when the diff is open. When closed, messages take the full width. |

#### C.2 Base toggle

| File | Purpose |
|---|---|
| `packages/web/src/components/SessionDiff.tsx` | Add a small segmented control: `Branch · Uncommitted`, defaulting to Branch. Refetches via `getSessionDiff(id, base)` when toggled. Selection persisted to `localStorage`. |

#### C.3 SSE auto-refresh

| File | Purpose |
|---|---|
| `packages/web/src/lib/sse.ts` | Surface the live `diff_changed` SSE event separately from persisted timeline events, either by adding an optional `onDiffChanged` callback to `useSessionEvents(id, ...)` or by adding a small `useDiffChanged(sessionId, onHint)` hook. |
| `packages/web/src/components/SessionDiff.tsx` | Subscribe to `diff_changed` for the current session id; on receipt, debounce 250ms and refetch with the currently-selected base. The Manual Refresh button stays as a fallback. |

#### C.4 Verify

- With diff panel open, drag the divider — width updates smoothly, persists across reload.
- Toggle base to Uncommitted, send a follow-up that leaves a dirty file — the panel updates without user interaction.
- Verify in the network tab that the refetch is triggered by the SSE event (one fetch per assistant turn complete, debounced).
- Disable the daemon, refresh the page — diff panel shows a fetch-error state (existing `ApiError` plumbing) without breaking the messages timeline.

---

### Phase D — Create PR (push + `gh pr create`)

Goal: reviewing the diff turns into shipping. "Create PR" button at the top of the diff panel pushes the session branch to origin and opens a GitHub PR via `gh`. Closes out the *act* half of the v1 experience.

#### D.1 Schema + types

| File | Purpose |
|---|---|
| `packages/core/src/session.ts` | Add `pull_request_url: string \| null` to `Session` and `PublicSession`. Update `toPublicSession` to pass it through. |
| `packages/daemon/src/migrations.ts` | Additive migration for `sessions.pull_request_url TEXT` via the existing F8 helper. Bump schema version. |
| `packages/daemon/src/store.ts` | Read + write the new column. Add an `updatePullRequestUrl(id, url)` mutation. |
| `packages/core/src/diff.ts` | Add `PullRequestResult { url: string }` and `PullRequestError` discriminated union (`{ code: "dirty_worktree" | "no_commits_ahead" | "gh_unavailable" | "non_github_remote" | "gh_failed"; details?: string }`). |

#### D.2 Workspace provider — `createPullRequest`

| File | Purpose |
|---|---|
| `packages/daemon/src/workspace/types.ts` | Extend `WorkspaceProvider` with `createPullRequest(handle, opts: { repo: RepoConfig; title: string; body: string }): Promise<{ url: string }>`. |
| `packages/daemon/src/workspace/local.ts` | Implement on `LocalWorktreeProvider`: <br>1. Run the existing dirty-worktree check (reuse archive-safety logic). Throws structured error on dirty. Uncommitted and untracked files are intentionally not part of PR creation. <br>2. Check `origin` URL via `git -C <worktree> remote get-url origin`; if it does not match a GitHub URL pattern (`github.com[:/]<owner>/<repo>` over https or ssh), throw `non_github_remote`. <br>3. `which gh` or attempt `gh auth status`; throw `gh_unavailable` with helpful message if missing. <br>4. `git -C <worktree> fetch origin` to refresh the remote-tracking refs so the commits-ahead check is accurate. <br>5. Check `git rev-list origin/<default>..HEAD --count`; throw `no_commits_ahead` if 0. <br>6. `git push -u origin <branch>` from the worktree. <br>7. `gh pr create --base <default> --head <branch> --title ... --body ...` from the worktree (so `gh` infers the repo from the remote). Capture the URL from stdout. If `gh` reports an existing PR for this head (stderr typically contains "a pull request for branch ... already exists"), recover by calling `gh pr view <branch> --json url -q .url` and treat the returned URL as success. <br>8. Return `{ url }`. |
| `packages/daemon/src/git.ts` | Helpers: `commitsAheadOf(repoOrWorktree, base)`, `pushBranch(worktree, branch)`, `fetchBranch(repoOrWorktree, remote, branch)`, `originUrl(repoOrWorktree)`. All `Bun.$` thin wrappers. |

#### D.3 HTTP route

| File | Purpose |
|---|---|
| `packages/daemon/src/server.ts` | `POST /sessions/:id/pull-request` — body `{ title?: string, body?: string }`. Loads session, refuses with `404` if unknown and `409 archived` if archived. Calls `sessionManager.createPullRequest(id, { title, body })`. On structured precondition errors, returns `409` with the error code in the JSON body (mirrors archive-safety pattern). On success, returns the updated `PublicSession` (now with `pull_request_url`). |
| `packages/daemon/src/session-manager.ts` | New `createPullRequest(id, { title, body })` method. Resolves session + handle. If `session.pull_request_url` is already set, return the current public session without pushing or calling `gh`. Otherwise call `provider.createPullRequest(...)`, on success call `store.updatePullRequestUrl(id, url)`, publish a `session` event so SSE consumers refetch the session row, and return the updated `PublicSession`. |

#### D.4 Web UI

| File | Purpose |
|---|---|
| `packages/web/src/lib/api.ts` | `createPullRequest(id, { title, body }): Promise<PublicSession>` — POSTs to the new route. |
| `packages/web/src/components/CreatePRDialog.tsx` | New. Small modal: title (defaults to a truncated form of the session's first user message), body (defaults to a generated stub: `"Created from Helm session <id>."`). "Create PR" button. Inline error messaging when preconditions fail after submit. |
| `packages/web/src/components/SessionDiff.tsx` | Add a `Create PR` button at the top-right of the panel header. Disabled only when the session is archived or currently `running` — *not* gated on the loaded `DiffResult`'s file count. The user can be viewing the `Uncommitted` base while the `Branch` base has shippable commits; gating on the loaded diff would wrongly disable the button. All other refusal reasons (dirty worktree, no commits ahead, gh missing, non-GitHub remote) surface as inline errors in the dialog after submit. On click → opens `<CreatePRDialog>`. After success, the button flips to `View PR` linking to `pull_request_url`. |
| `packages/web/src/components/SessionDetail.tsx` | If `session.pull_request_url` is non-null, also render a small "PR open" link in the session header so it's visible without expanding the diff panel. |

Title default heuristic: take the first user message (the session's initial prompt), trim to ~72 chars, ellipsis if longer. Falls back to `Helm session <id>` if no prompt is recorded. Body default: a one-line note linking back to the session. Both editable in the dialog.

#### D.5 Spec update

Same commit as the rest of Phase D:
- §5.1.3 — `pull_request_url TEXT` column added.
- §11.1 — `POST /sessions/:id/pull-request` row added.
- §3 (or wherever) — `gh` listed as required for the PR flow, optional otherwise.
- §6 — note that `gh`-based PR creation is a separate operation; it is not part of `archive_session` and does not change session status. After a successful PR, the session row carries `pull_request_url` and unshared-commits archive checks pass naturally because the branch is now on origin.

#### D.6 Verify

```bash
# Active session, agent committed at least one file
curl -X POST -H "Authorization: Bearer $HELM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "test PR from helm", "body": "ok"}' \
  "http://127.0.0.1:7878/sessions/<id>/pull-request"
# expect: 200 with PublicSession including pull_request_url

# Dirty worktree
echo "x" >> ~/.helm/worktrees/<repo>/<id>/foo.txt
curl -X POST ... "/sessions/<id>/pull-request"
# expect: 409 { code: "dirty_worktree", ... }

# Branch with no commits ahead (clean branch with no committed session work)
curl -X POST ... "/sessions/<id>/pull-request"
# expect: 409 { code: "no_commits_ahead", ... }

# Without gh installed
PATH= curl -X POST ... "/sessions/<id>/pull-request"
# expect: 409 { code: "gh_unavailable", ... }

# Repo with non-GitHub origin (e.g. gitlab.com)
curl -X POST ... "/sessions/<id>/pull-request"
# expect: 409 { code: "non_github_remote", ... }

# Second click after PR already created (idempotent)
curl -X POST ... "/sessions/<id>/pull-request"
# expect: 200 with the same pull_request_url, no second push, no second gh call
```

In the dashboard: agent runs to completion → click "Create PR" → modal opens → submit → button flips to "View PR" → click navigates to GitHub. Subsequent `archive` succeeds because the unshared-commits check passes.

---

## Test Strategy

Same tiering as the existing engine plan (§Test Strategy of `plan-helm-mvp.md`). Diff-specific coverage:

### 1. Unit tests for diff parsing/normalization

- **Purpose:** Verify the `git diff` raw output → `DiffResult` transform handles renames, binary, large-file truncation, and the file-count cap.
- **How:** `bun test` over hand-recorded `git diff --raw` / `git diff --numstat` fixtures in `packages/daemon/test/fixtures/diffs/`. One fixture per case: trivial added file, modified, deleted, renamed, binary, too-large, >limit file count.
- **DOES NOT:** Test the HTTP layer or that real git produces these outputs (strategy 2).

### 2. Engine integration test against real git + workspace provider

- **Purpose:** Verify `LocalWorktreeProvider.diff()` produces correct output against a real worktree.
- **How:** A test creates a temp git repo and real worktree, writes a known set of committed, modified, deleted, renamed, binary, and untracked files, then asserts the resulting `DiffResult`. This does not require a runner adapter. If a fake runner adapter is added later, it can cover session lifecycle around the same provider behavior, but the diff provider test should stay focused on real git.

### 3. HTTP integration test for the diff and PR routes

- **Purpose:** Verify auth, origin, archived → 410, base param, and that the routes return the same shapes their providers returned.
- **How:** Add to the existing daemon-server integration suite. Diff cases: active session (200 + body), invalid base (400), unknown session (404), archived session (410), and one auth-fail case. PR cases: unknown session (404), archived session (409 archived), already has `pull_request_url` (200 without invoking provider), dirty worktree (409 dirty_worktree), no commits ahead (409 no_commits_ahead), missing `gh` (409 gh_unavailable, exercised by stubbing the spawn), non-GitHub origin (409 non_github_remote, exercised by setting the origin URL to a gitlab/bitbucket URL on the temp repo). The happy-path `gh pr create` is **not** exercised here — that's strategy 5.

### 4. Fast Playwright e2e (dashboard)

- **Purpose:** UI wiring — toggle reveals panel, base switch refetches, SSE auto-refresh fires, archived state renders, "Create PR" button enable/disable transitions correctly.
- **How:** Add `tests/e2e/diff.spec.ts` to the normal `bun run test:e2e` suite. Use the real daemon plus deterministic temp repo/session setup, not a real LLM turn. Assert the file path is visible in the diff panel, click Branch / Uncommitted, assert the panel updates, emit or trigger a `diff_changed` hint and assert one refetch, archive the session and assert the placeholder. The PR-button enabled/disabled state is asserted, but the actual PR-creation click is not triggered to avoid creating real PRs from CI.

### 4b. Slow real-agent regression

- **Purpose:** Confirm a real Claude/Codex session produces changes that the diff endpoint and UI can surface.
- **How:** Extend `tests/e2e/real-agents.spec.ts` with one minimal diff assertion behind `HELM_REAL_AGENT_E2E=1`: after the agent creates a file, open the diff panel and assert that file appears. Keep this small because the fast dashboard suite already owns the UI matrix.

### 5. Manual smoke for the PR flow

- **Purpose:** The one path that automation can't safely exercise. `gh pr create` against a real GitHub repo creates a real PR.
- **How:** Manual checklist before each release: with `gh` authed, run a Helm session that commits a file, click Create PR, verify the PR exists on GitHub, verify `pull_request_url` is persisted, verify subsequent archive succeeds. Use a throwaway test repo.

### 6. Manual UI checks

- **Purpose:** Things automation is bad at — divider drag feel, syntax-highlight quality on real-world languages, perceived load time on a "realistic large diff" (~50 files / ~10 KLOC), Create PR dialog ergonomics.
- **How:** Manual checklist after Phase C and Phase D land.

## Spec Coverage Map

- §5.1.3 Session schema — `pull_request_url` column added in Phase D; verified by store integration tests + migration smoke.
- §6.4 archive_session — Phase A returns 410 for archived sessions; Phase B renders the placeholder. Phase D's PR success indirectly unblocks the unshared-commits archive precondition. Verified by HTTP integration test + e2e archived case + the Phase D archive-after-PR manual check.
- §7.3 Normalized Event Stream — `diff_changed` documented as a transient, non-persisted SSE hint; verified by the per-session SSE check in Phase A and by the Playwright auto-refresh test in Phase C.
- §11.1 HTTP API — new `GET /sessions/:id/diff` route (Phase A) and `POST /sessions/:id/pull-request` route (Phase D); verified by HTTP integration tests.
- §12 Authentication — diff and PR routes use the existing middleware; verified by auth-fail cases.
- §13 Out of Scope — "Diff review flows" removed in the same commit as Phase A.

No spec gaps remain after this work.

## Considerations

- **Pierre's bundle size.** Shiki + each language grammar isn't tiny. Lazy-loading on the diff panel means users who never open a diff don't pay. Worth measuring once it's in: if the lazy chunk is over ~1 MB gzipped, scope the language set explicitly via Pierre's render options rather than letting it auto-load everything.
- **Diff for `branch` base when `origin/<default_branch>` has moved.** We use `merge-base origin/<default> HEAD` so the diff is "what the session contributed", not "what changed since the user's main moved on." The branch view includes final tracked worktree state plus synthetic added entries for untracked files; the PR flow still requires a clean worktree before pushing. Document this in the spec change.
- **`diff_changed` granularity.** The hint fires per-turn-complete, not per-file-change-during-tool-use. That is intentional — refetching the full diff on every tool call is wasteful, and the user wants the diff *after* the agent says it's done. If users complain about staleness during a long turn, add a manual refresh which already exists.
- **Per-session `localStorage` keys.** Divider position and base preference are keyed by session id, so they don't bleed across sessions. Eviction is a non-issue at MVP scale — `localStorage` is reset infrequently and these are kilobytes.
- **Cloud workspace later.** The provider abstraction is the whole point of putting `diff()` on `WorkspaceProvider`. A cloud provider implements `diff()` against its own backend (likely an internal API call instead of `git`). The HTTP route, the SSE event, and the dashboard component don't need to change.
- **Forward-compat with annotations.** Pierre supports per-line annotations + accept/reject-hunk APIs. The chosen layout (resizable split, no full-screen takeover) accommodates a future "send hunk back to agent" workflow. Worth doing a focused spike when that phase is scoped.
- **`gh` as a dependency.** The PR flow requires `gh` installed and authenticated. We don't bundle it. Missing `gh` surfaces as a `gh_unavailable` error in the dialog after the user submits, not as a pre-disabled button — the dashboard doesn't have a way to know `gh` status without asking the daemon, so we let the daemon answer authoritatively per click. Don't fall back to API-token-based GitHub calls in v1; let `gh` own auth.
- **GitHub-only in v1.** `gh` only works against GitHub remotes. The provider does an explicit GitHub URL pre-check so non-GitHub repos get a clear `non_github_remote` error instead of confusing `gh` stderr. Other forges (GitLab, Gitea, Bitbucket) are out of scope for v1; future work could add a forge-aware abstraction (e.g. `glab pr create`, REST calls) behind the same `WorkspaceProvider.createPullRequest` interface.
- **PR creation idempotency.** The API checks `pull_request_url` before invoking `git push` or `gh pr create`, and the UI disables the submit button while the request is in flight. If two requests race before the URL is stored, GitHub usually rejects the duplicate head-branch PR. The provider recovers by calling `gh pr view <branch>` to retrieve the existing URL and treating that as success, which also covers the case where the user manually pushed and opened a PR before clicking Create PR. A per-session lock could replace this if races become common; not needed for v1.
- **Branch already on origin.** If `helm/<id>` was manually pushed earlier, `git push -u origin <branch>` is still safe (fast-forward) and `gh pr create` either succeeds or returns the "already exists" path described above. No additional handling needed.
- **Stale `origin/<default>` ref.** The provider runs `git fetch origin` before the commits-ahead check so the count reflects the live remote tip, not whatever was cached at session-create time. One network round-trip per PR creation; cheap.
- **Agent commit behavior.** The PR flow only works if the agent committed its changes. Today, nothing instructs the agent to do so. Captured in `.context/agent-prompting.md` as a follow-up; the prompt-layer work is its own future phase. Until then, users will occasionally hit `dirty_worktree` and need to commit the agent's changes manually before clicking Create PR.
- **What we are explicitly NOT doing in v1:** archived-session snapshots, per-commit history view, line annotations, hunk acceptance/rejection, virtualization for huge diffs, file-watcher-based refresh, auto-commit on the agent's behalf, custom PR templates beyond the dialog defaults, multi-PR-per-session, non-GitHub forges. Each is a separate, additive phase later.

## Open Questions / Future Phases

- **Snapshots at archive time.** If "I archived too quickly and want to see what the agent did" becomes a real complaint, add a `~/.helm/diffs/<session-id>.json` cache written during `archive_session` before worktree removal. Costs a `diff` call inside the archive flow. Decide based on real usage.
- **Comments + send-back-to-agent.** The natural next phase after v1. Scope: annotation UI in `SessionDiff`, a daemon-side "diff comment" persistence model, a way to serialize the comment + hunk into a follow-up message. Worth its own design pass.
- **Per-commit history view.** Useful when the agent makes ten commits and you want to scrub through them. Probably a tab inside the diff panel: `Branch · Uncommitted · By commit`. Defer until users ask.
- **Manager session interaction.** The manager session (Phase 5, planned in a separate session) will want to read child diffs as one of its tools. The endpoint built here (`GET /sessions/:id/diff?base=branch`) is exactly what that tool calls. No changes needed for manager-session consumption — verify when that work begins.
- **Agent prompting layer.** Captured in `.context/agent-prompting.md`. The most relevant item to this plan: telling agents to always commit when they finish a unit of work, so the Create PR flow has commits to push. Worth its own phase (a session-instructions injection point) once we feel the friction. Not required for shipping the diff/PR work, just makes it more reliable.
