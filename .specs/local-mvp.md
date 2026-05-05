# Helm — Local MVP System Specification

Status: Draft v1
Scope: Local-only execution. No cloud/remote runtimes. No direct GitHub API integration; PR creation uses the local `gh` CLI. Includes a singleton manager session for local orchestration.

## Normative Language

`MUST`, `SHOULD`, `MAY` per RFC 2119, used sparingly.

## 1. Goal

Run, observe, and steer multiple coding-agent sessions across local repos through a single durable substrate, so the user manages many concurrent agents from one place rather than juggling terminals.

The MVP includes:

- A **CLI** (`helm`) for command-line use.
- A **daemon** that owns session lifecycle and exposes an authenticated HTTP/SSE API.
- A **dashboard** (Next.js) that consumes that API for browser-based use.

Each session runs in an isolated git worktree, against a configured agent (`claude` or `codex`), with stream-json output normalized into structured events the UI surfaces selectively. The user does not interact with raw agent terminals.

## 2. System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        helm daemon                           │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │   config     │   │   sqlite     │   │  session manager │  │
│  │  loader      │   │   store      │   │                  │  │
│  └──────────────┘   └──────────────┘   └────────┬─────────┘  │
│                                                 │            │
│  ┌──────────────────────────────────────────────▼──────────┐ │
│  │                  agent runner                           │ │
│  │  spawns: agent as direct child process                  │ │
│  │  reads:  agent stdout (stream-json)                     │ │
│  │  writes: agent stdin  (claude) or re-spawn (codex)      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐                         │
│  │  http + sse  │   │   git ops    │  fetch / worktree       │
│  │  (auth-gated)│   │              │                         │
│  └──────┬───────┘   └──────────────┘                         │
└─────────┼────────────────────────────────────────────────────┘
          │
          │  HTTP + SSE on 127.0.0.1:7878 (token-authenticated)
          ▼
   ┌─────────────┐         ┌─────────────────────┐
   │  helm CLI   │         │  next.js dashboard  │
   └─────────────┘         └─────────────────────┘
```

### 2.1 Components

1. **Config Loader** — reads `repos.json` and `agents.json`, validates, exposes typed accessors.
2. **Store** — SQLite database persisting sessions and events.
3. **Session Manager** — owns session lifecycle and state transitions.
4. **Agent Runner** — process supervision for one running agent, plus stdout JSON parsing and stdin writing.
5. **Git Operations** — fetch, worktree create, worktree remove, dirty/unshared-commit checks.
6. **HTTP/SSE Server** — token-authenticated local API serving CLI and dashboard (§11, §12).

## 3. Filesystem Layout

```
~/.helm/
  config/
    repos.json
    agents.json
  state/
    helm.db                  # SQLite
  worktrees/
    <repo-name>/
      <session-id>/          # one git worktree per session
  logs/
    <session-id>.jsonl       # raw agent stream (append-only)
```

Worktrees live outside the user's repo to avoid polluting `git status` of the main checkout.

`<session-id>` is a short ULID (e.g. `01HZX7K2J9...`).

## 4. Configuration Files

### 4.1 `repos.json`

```jsonc
{
  "repos": [
    {
      "name": "helm",                          // unique slug, used in paths
      "path": "/Users/ryanbrown/code/helm",    // absolute path to local clone
      "default_branch": "main"                 // optional; auto-detected if omitted
    }
  ]
}
```

Validation:
- `path` MUST exist and be a git repository.
- `name` MUST be unique and match `[a-z0-9_-]+`.
- If `default_branch` is omitted, the loader resolves it via `git symbolic-ref refs/remotes/origin/HEAD`.

### 4.2 `agents.json`

```jsonc
{
  "agents": [
    {
      "name": "claude",
      "command": "claude",
      "args": ["--dangerously-skip-permissions"],
      "headless_mode": "claude_stream_json"   // see §7.2
    },
    {
      "name": "codex",
      "command": "codex",
      "args": ["--yolo"],
      "headless_mode": "codex_exec"
    }
  ]
}
```

`headless_mode` selects the runner adapter. The full command at spawn time is:
```
<command> <headless_mode_flags> <args> -- <prompt>
```
The runner adapter owns the headless flags (see §7.2).

### 4.3 Optional Runtime Tools

`gh` is optional for normal session execution. It is required only for the dashboard Create PR flow; when missing or unauthenticated, the daemon returns a structured `gh_unavailable` error.

## 5. Data Model

### 5.1 Entities

#### 5.1.1 `Repo` (in-memory only; sourced from `repos.json`)

| Field | Type | Notes |
|---|---|---|
| `name` | string | Slug |
| `path` | string | Absolute path |
| `default_branch` | string | e.g. `main` |

#### 5.1.2 `Agent` (in-memory only; sourced from `agents.json`)

| Field | Type | Notes |
|---|---|---|
| `name` | string | Slug |
| `command` | string | Executable name or path |
| `args` | string[] | Extra flags passed after headless flags |
| `headless_mode` | enum | `claude_stream_json` \| `codex_exec` \| `manager_loop` |
| `model` | string? | Required for `manager_loop`; OpenRouter model id |
| `api_key` | string? | Required for `manager_loop`; OpenRouter API key stored in private local config |
| `system_prompt_path` | string? | Optional markdown file appended to the built-in manager system prompt |
| `manager_limits` | object? | Optional caps for manager loop iterations, tool calls, queued wakes, and live children |

#### 5.1.3 `Session` (persisted in SQLite)

| Field | Type | Notes |
|---|---|---|
| `id` | text PK | ULID |
| `repo_name` | text | FK to `repos.json` entry |
| `agent_name` | text | FK to `agents.json` entry |
| `branch` | text? | e.g. `helm/<id>`; null for manager sessions |
| `worktree_path` | text? | Absolute path; null for manager sessions |
| `workspace_uri` | text? | Provider workspace URI; null for manager sessions |
| `parent_session_id` | text? | Set when a manager spawns a child; null otherwise |
| `manager_mode` | enum? | null for normal sessions; `approval` or `autopilot` for manager sessions, default `approval` |
| `agent_thread_id` | text? | Adapter-supplied thread/session id used for resume (e.g. Claude SDK `session_id`, Codex `thread.id`) |
| `pid` | int? | Agent process pid (null when not running) |
| `status` | enum | `created` \| `running` \| `awaiting_input` \| `interrupted` \| `completed` \| `failed` \| `stopped` \| `archived` |
| `last_assistant_message` | text? | Most recent final assistant message |
| `last_event_at` | timestamp? | Time of most recent event ingestion |
| `pull_request_url` | text? | GitHub PR URL created for the session branch via `gh` |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

#### 5.1.4 `SessionEvent` (persisted in SQLite, append-only)

| Field | Type | Notes |
|---|---|---|
| `id` | int PK | Autoincrement |
| `session_id` | text | FK |
| `kind` | enum | See §7.3 |
| `payload` | json | Normalized event |
| `created_at` | timestamp | |

#### 5.1.5 `ManagerMessage` (persisted in SQLite, append-only)

| Field | Type | Notes |
|---|---|---|
| `id` | int PK | Autoincrement |
| `session_id` | text | FK to the manager session |
| `payload` | json | Full OpenAI-compatible `ManagerChatMessage` JSON, including `role`, `content`, `tool_calls`, `tool_call_id`, and `name` when present |
| `created_at` | timestamp | |

Replay reads one manager session with `WHERE session_id = ? ORDER BY id`, so the store maintains a composite `(session_id, id)` index. The `role` lives only inside `payload`; it is not duplicated in a separate column.

### 5.2 Status Transitions

```
created ──start──▶ running ──final assistant msg──▶ awaiting_input
                      │                                    │
                      │                                    └──user msg──▶ running
                      │
                      ├──daemon restart──▶ interrupted ──user resume──▶ awaiting_input
                      ├──exit 0──▶ completed
                      ├──exit !=0─▶ failed
                      └──user stop─▶ stopped ──user archive──▶ archived

awaiting_input ──daemon restart──▶ interrupted

awaiting_input / interrupted / completed / failed / stopped ──user archive──▶ archived
```

`interrupted` means the daemon lost the in-memory runner handle during restart. `stopped` means the user intentionally stopped the session. Both keep the worktree on disk and the session visible in default listings; `archived` removes the worktree + branch and hides the session.

## 6. Session Lifecycle

### 6.1 `create_session(repo, agent, prompt)`

1. Resolve `repo` and `agent` from config. Reject unknown names.
2. `git -C <repo.path> fetch origin` (always; never modifies working tree).
3. Generate `session_id` = ULID. Compute:
   - `branch` = `helm/<session_id>`
   - `worktree_path` = `~/.helm/worktrees/<repo.name>/<session_id>/`
4. `git -C <repo.path> worktree add -b <branch> <worktree_path> origin/<repo.default_branch>`.
5. Insert `Session` row with status=`created`.
6. Spawn agent (§7.1). Status → `running`.
7. Return `session_id`.

The user's main checkout is never modified — no `git pull`, no branch switching, no stash.

### 6.2 `stop_session(id)`

1. Send SIGTERM to the runner (graceful first, SIGKILL after 5s).
2. Status → `stopped`.
3. Worktree and branch are preserved. The session remains visible in `helm session list`.

`stop` is non-destructive. Removal is a separate, explicit `archive` action (§6.4).

### 6.3 `send_message(id, text)`

Only valid in `awaiting_input` or `running` state. Status → `running` if not already.

The runner adapter chooses how to deliver the message:
- For long-running stdin-driven agents (Claude), the adapter writes a user event to the agent's stdin.
- For one-shot-per-turn agents (Codex), the adapter spawns a new resume process keyed on the persisted `agent_thread_id`.

`session_manager` does not need to know which mode is in use.

### 6.4 `archive_session(id, { force })`

Permanently removes the worktree and the local branch and marks the session `archived`. Archive is destructive and is the only operation in the spec that can lose user-visible work, so it has explicit safety rules.

Preconditions (checked server-side, in order):

1. **Dirty worktree.** `git -C <worktree> status --porcelain` MUST be empty. If non-empty, the daemon refuses with `409 dirty_worktree` and lists the dirty paths in the error payload.
2. **Unshared commits.** `git -C <repo> log <branch> --not --branches --not --remotes --oneline` MUST be empty. If non-empty, the daemon refuses with `409 unshared_commits` and lists the at-risk shas.

`force: true` skips both checks. The caller MUST surface the specifics from the structured error to the user (e.g. a confirm dialog naming what will be lost) before retrying with `force: true`.

PR creation is a separate `gh`-based operation, not part of `archive_session`, and it does not change session status. After a successful PR, the session row carries `pull_request_url`; unshared-commit archive checks then pass naturally because the branch is on origin.

After preconditions pass:

1. Stop the runner if it is still running (§6.2 transition first).
2. `git -C <repo> worktree remove --force <worktree>`.
3. `git -C <repo> branch -D <branch>`.
4. Status → `archived`.

## 7. Agent Runner

### 7.1 Process Model

In the MVP, agents run as direct child processes of whatever Helm process owns the session — the CLI in phases 1-2, the long-running daemon in phase 3. Each runner adapter holds the child's stdio handles, parses stdout into normalized events, and either writes follow-ups to stdin (Claude) or re-spawns a resume process (Codex).

For each running agent the adapter MUST:
1. Capture stdout to `~/.helm/logs/<session_id>.jsonl` (append-only, raw bytes).
2. Stream parsed events to the session manager.
3. Expose `send(text)`, `stop()`, and an `events` async iterable (see §7.4).

When the daemon starts, sessions that were `created`, `running`, or `awaiting_input` are reconciled to `interrupted` with `pid = null`. User-initiated stop remains `stopped`. Interrupted sessions are visible recovery candidates and can be resumed explicitly; stopped sessions are not resumed because stop is an intentional user action.

### 7.2 Headless Mode Adapters

#### `claude_stream_json`

Spawn:
```
claude --print --input-format stream-json --output-format stream-json \
       --include-partial-messages --verbose <user-args>
```

Claude resume is lazy. Rehydrating an interrupted Claude session restores an in-memory handle from `sessions.agent_thread_id`, sets status to `awaiting_input`, and does not spawn `claude --resume <session_id>` until the next user message.

Stdin: newline-delimited JSON, one event per line:
```jsonc
{"type":"user","message":{"role":"user","content":"<prompt>"}}
```

Stdout: newline-delimited JSON. Events the runner cares about:
- `type=system`, `subtype=init`: contains `session_id` for SDK-side resume; capture once.
- `type=assistant`: streamed deltas; aggregate text content.
- `type=result`: final result + usage. Marks end-of-turn.
- `type=user` (tool result): ignored for surfacing; logged.

#### `codex_exec`

First turn:
```
codex exec --json <user-args> "<prompt>"
```

Follow-up turns (one process per turn):
```
codex exec resume <thread_id> --json <user-args> "<follow-up>"
```

Codex resume is lazy. Rehydrating an interrupted Codex session restores an in-memory handle from `sessions.agent_thread_id`, sets status to `awaiting_input`, and does not spawn `codex exec resume` until the next user message.

Stdout: newline-delimited JSON events. Events the runner cares about:
- `thread.started`: contains `thread.id`. Capture and persist as `agent_thread_id` for resume.
- `turn.started`: marks beginning of an agent turn (used to flip status to `running`/emit `thinking`).
- `item.*` with item type `agent_message`: assistant text content.
- `turn.completed`: end-of-turn — process will exit shortly after. Triggers `running → awaiting_input`.
- `turn.failed`, `error`: failure paths.
- Other `item.*` (`reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `plan_update`): logged, not surfaced.

Stdin: not used. Codex does not accept follow-ups via stdin; the adapter spawns a new resume process for each follow-up.

### 7.3 Normalized Event Stream

The runner translates adapter-specific events into a shared `SessionEvent` shape stored in SQLite:

| `kind` | Surfaced to UI? | Notes |
|---|---|---|
| `session_started` | ✓ | Includes session id, repo, branch, worktree path |
| `session_resumed` | ✓ | Explicit recovery of an interrupted session |
| `user_message` | ✓ | Initial prompt and follow-up messages sent by the user |
| `thinking` | ✓ (as indicator) | Emitted on first non-result delta after a user msg |
| `assistant_message` | ✓ | Final, post-turn assistant text. Only this is shown. |
| `tool_invocation` | ✓ for manager sessions | Manager tool call requested; `status` is `pending` in approval mode or `auto` in autopilot |
| `tool_call_resolved` | ✓ for manager sessions | User approved or denied a pending manager tool call |
| `tool_result` | ✓ for manager sessions | Result returned to the manager LLM for a tool call |
| `child_event` | ✓ for manager sessions | Manager-observed child spawn/message/stop/notice/error |
| `turn_complete` | ✓ (status flip) | Triggers `running → awaiting_input` |
| `error` | ✓ | Surfaces failure to UI |
| `exit` | ✓ | Process exited |

The MVP UI contract is: **show `session_started`, `session_resumed`, `user_message`, `thinking`, `assistant_message`, manager tool events, `child_event`, `error`, and `exit`. Suppress everything else.** Intermediate streamed deltas and adapter-specific tool events are kept in the raw JSONL log, not persisted as normalized timeline events; only the final assistant message of each turn is surfaced.

`diff_changed` is a live-only SSE hint that tells the UI the worktree diff for a session may have changed. It carries no payload beyond `{ kind: "diff_changed", sessionId }`, is not persisted as a normalized event, and is not replayed from SQLite.

### 7.4 Runner Adapter Contract

Each adapter implements:

```ts
interface RunnerAdapter {
  spawn(opts: {
    cwd: string;             // worktree path
    extraArgs: string[];     // from agents.json
    initialPrompt?: string;
    resumeThreadId?: string; // CLI-owned transcript id for resumed child agents
  }): RunnerHandle;
}

interface RunnerHandle {
  events: AsyncIterable<NormalizedEvent>;
  send(userText: string): Promise<void>;  // claude: write stdin; codex: re-spawn with resume
  stop(): Promise<void>;
  pid: number | null;
}
```

The session manager consumes `events`, persists them, and never branches on which agent is running.

### 7.5 `manager_loop` Adapter

`manager_loop` is an in-process `RunnerAdapter` backed by the OpenAI SDK pointed at OpenRouter (`https://openrouter.ai/api/v1`). It is configured by an agent entry with `model`, `api_key`, optional `system_prompt_path`, and optional `manager_limits`. The `api_key` stays in private local config and is never returned by the dashboard-safe config endpoint. When `system_prompt_path` is set, Helm reads that markdown file and appends it to the built-in manager tool contract.

There is at most one non-archived manager session. Manager sessions have no worktree (`branch`, `worktree_path`, and `workspace_uri` are null). Children are normal sessions with `parent_session_id` set to the manager id; child sessions cannot use `manager_loop`.

The manager uses a static system prompt and append-only user-role state snapshots at turn boundaries. Snapshots include live sessions, recently terminated sessions, and any wake notice. Child `turn_complete` and terminal status transitions enqueue wake notices through the daemon event bus. Wakes are serialized and coalesced; if a wake produces no assistant text and no tool calls, the visible empty turn is suppressed.

Manager sessions persist their OpenAI-compatible chat messages in the `manager_messages` table. New managers append the rendered system prompt, every explicit user message, every rendered state snapshot, assistant responses, and tool result messages. Resumed managers load messages ordered by insertion id and wait for a new user message or future child lifecycle event; resume does not auto-kick the manager loop. If the stored transcript ends after an assistant tool-call batch with missing tool results, Helm synthesizes `{ ok: false, errorMessage: "interrupted" }` tool messages before replay so the next OpenRouter request is valid.

Manager tools:

| Tool | Purpose |
|---|---|
| `create_child_session` | Spawn a manager-owned child session |
| `create_child_from_session` | Spawn a manager-owned child from another child session's current branch HEAD |
| `create_child_from_branch` | Spawn a manager-owned child from a named local branch or ref using `sourceBranch`; optional `newBranchName` must be a different new branch |
| `send_message` | Send a follow-up to a manager-owned child |
| `stop_child` | Stop a manager-owned child |
| `read_file` | Read a UTF-8 file from a live child worktree, capped at 256 KiB |
| `pass_file_content` | Pass a file from one child to another without returning the bytes to the manager LLM |
| `read_diff` | Read the same structured diff contract used by `GET /sessions/:id/diff` |

File tools reject archived sessions, absolute paths, `..` traversal, and symlinks that resolve outside the child worktree. `pass_file_content` returns only metadata to the manager; the file body is sent directly to the target child as a user message. Review sessions should be created with `create_child_from_session` so reviewers see the writer branch HEAD instead of a fresh branch from `main`. Use `create_child_from_branch` to adopt work started outside Helm or to fork multiple experiments from a named branch. Its `sourceBranch` is the existing branch/ref to copy from; `newBranchName` is optional and must not equal `sourceBranch`.

Manager mode defaults to `approval`. In approval mode a full batch of tool calls is emitted as pending, and the loop waits until each call is approved or denied. Denial produces a `tool_result` with `errorMessage: "denied_by_user"`. In `autopilot`, tool calls execute immediately. Mode changes affect the next loop iteration; pending calls keep their existing gate.

## 8. Git Operations

| Op | Command |
|---|---|
| Fetch | `git -C <repo.path> fetch origin` |
| Detect default branch | `git -C <repo.path> symbolic-ref refs/remotes/origin/HEAD` |
| Create worktree | `git -C <repo.path> worktree add -b <branch> <wt-path> origin/<default>` |
| Remove worktree | `git -C <repo.path> worktree remove --force <wt-path>` |
| List session worktrees | `git -C <repo.path> worktree list --porcelain` |

The MVP never touches the user's checked-out main branch — fetch is read-only, worktree create branches off `origin/<default>` directly.

### 8.1 Structured worktree diff

`GET /sessions/:id/diff` returns a `DiffResult` computed by the daemon from the session worktree. It is read-only and never mutates the worktree or session row.

Diff bases:
- `base=branch` (default) diffs the final worktree state against `git merge-base origin/<default_branch> HEAD`, so it represents the session's contribution relative to the remote default branch.
- `base=uncommitted` diffs the current worktree against `HEAD`, so it represents only staged, unstaged, and untracked work not yet committed.

Tracked files are enumerated with git diff name/status and numstat using rename and copy detection (`-M -C --find-copies-harder`). Untracked, non-ignored files are appended as synthetic `added` entries. Each file entry includes `path`, `status`, optional `oldPath`, additions/deletions, binary flag, optional old/new byte sizes, too-large flag, and optional patch text.

Patch text is omitted for binary files and for files or patches over `DIFF_FILE_SIZE_LIMIT` (500,000 bytes); those entries remain in the summary with `isBinary` or `isTooLarge` set. The response includes at most `DIFF_FILE_COUNT_LIMIT` (200) file entries, sets `truncated: true` when more files exist, and keeps `totalFiles` as the full count before truncation. Archived sessions do not have live worktree diffs and return `410 archived`.

### 8.2 Create PR

`POST /sessions/:id/pull-request` creates or records one GitHub pull request for the session branch. It is a separate operation from archive and does not change session status. Archived sessions return `409 archived`.

Preconditions:
- The worktree MUST be clean; otherwise the daemon returns `409 dirty_worktree` with dirty paths.
- `origin` MUST point to GitHub using SSH scp-like, HTTPS, or `ssh://git@github.com/...` syntax; otherwise the daemon returns `409 non_github_remote`.
- `gh` MUST be installed and authenticated; otherwise the daemon returns `409 gh_unavailable`.
- The session branch MUST have commits ahead of `origin/<default_branch>`; otherwise the daemon returns `409 no_commits_ahead`.

On success, Helm fetches origin, pushes `helm/<id>` to origin with upstream tracking, and runs `gh pr create --base <default_branch> --head helm/<id> --title <title> --body <body>`. If `gh pr create` reports that a PR already exists for the head branch, Helm looks up an open PR for that head branch and treats the found URL as success. The resulting URL is persisted to `sessions.pull_request_url` and returned in the `PublicSession`. If `pull_request_url` is already set, the route is idempotent and returns the current public session without pushing or invoking `gh`.

## 9. CLI Surface (MVP)

| Command | Purpose |
|---|---|
| `helm config validate` | Lint `repos.json` + `agents.json` |
| `helm daemon start` | Start the HTTP/SSE daemon in the foreground |
| `helm daemon status` | Report whether the daemon is reachable |
| `helm daemon stop` | Print stop guidance (Ctrl-C the foreground daemon) |
| `helm session create <repo> <agent> [-p <prompt>]` | Create + start a session. `-p` is an optional initial prompt. |
| `helm session list [--parent <id>]` | List sessions with status (excludes `archived`) |
| `helm session show <id>` | Print session metadata + last assistant message |
| `helm session send <id> <text>` | Send follow-up message |
| `helm session resume <id>` | Resume an interrupted session |
| `helm session stop <id>` | Stop running agent (status → `stopped`); worktree preserved |
| `helm session archive <id> [--force]` | Remove worktree + branch (status → `archived`). Requires `--force` if worktree is dirty or has unshared commits. |
| `helm manager create <repo> <agent> [-p <prompt>] [--mode approval\|autopilot]` | Create the singleton manager |
| `helm manager show` | Print the current manager session |
| `helm manager send <text>` | Send a message to the manager |
| `helm manager mode <approval\|autopilot>` | Change manager mode |
| `helm manager approve <toolCallId>` | Approve a pending tool call |
| `helm manager deny <toolCallId>` | Deny a pending tool call |

If the daemon is reachable, every `session ...` command issues an authenticated HTTP request against it; otherwise the CLI imports `@helm/daemon` and runs the operation in-process. CLI-over-HTTP receives the browser-facing DTO; in-process callers see the full `Session` row.

## 10. Persistence

SQLite at `~/.helm/state/helm.db`. The domain schema is `sessions` and `session_events` per §5.1.3 and §5.1.4, with a `schema_migrations` table for additive migrations.

Append-only `~/.helm/logs/<id>.jsonl` is the raw agent stream — both for debugging and as the source of truth for replay if the SQLite events table is rebuilt.

`manager_messages` is the durable manager conversation log. Each row stores one full OpenAI-compatible message JSON payload for a manager session and is replayed by `session_id, id` order when resuming an interrupted manager.

## 11. HTTP / SSE API

The daemon listens on `127.0.0.1:7878` (configurable via `HELM_PORT`). All routes except `/health` and the OPTIONS preflight require authentication (§12).

### 11.1 Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check. Unauthenticated. |
| `GET` | `/auth/check` | Returns 200 iff the request's token is valid. |
| `GET` | `/config` | Returns the public projection of `repos.json` and `agents.json` (names only; no absolute paths or commands). |
| `GET` | `/manager` | Returns the singleton non-archived manager session or 404. |
| `GET` | `/sessions` | Lists sessions. Excludes `archived` by default; pass `?archived=1` to include them or `?parent=<id>` to list children. |
| `POST` | `/sessions` | Creates a session. Body: `{ repo, agent, prompt?, parent_session_id?, manager_mode?, source_session_id?, source_branch?, branch_name? }`; returns `409 manager_exists` for duplicate managers. |
| `GET` | `/sessions/events` | SSE stream of all session/event updates (for the dashboard list). `?after=<id>` resumes after a given event id. |
| `GET` | `/sessions/:id` | Returns `{ session, events }` for one session. |
| `GET` | `/sessions/:id/diff?base=branch\|uncommitted` | Returns the daemon-computed structured worktree diff for a non-archived session. Defaults to `branch`; returns `400 invalid_base`, `404` for unknown sessions, or `410 archived`. |
| `GET` | `/sessions/:id/events` | SSE stream scoped to one session. `?after=<id>` resumes. |
| `POST` | `/sessions/:id/messages` | Sends a follow-up. Body: `{ text }`. |
| `POST` | `/sessions/:id/resume` | Rehydrates an `interrupted` session and returns the updated session. Returns `409 archived`, `manager_exists`, `not_resumable`, `missing_resume_thread`, `missing_worktree`, or `missing_manager_transcript` when recovery is invalid. |
| `PATCH` | `/sessions/:id/manager-mode` | Updates a manager's mode. Body: `{ manager_mode: "approval" \| "autopilot" }`. |
| `POST` | `/sessions/:id/tool-calls/:toolCallId/approve` | Approves a pending manager tool call. |
| `POST` | `/sessions/:id/tool-calls/:toolCallId/deny` | Denies a pending manager tool call. |
| `POST` | `/sessions/:id/stop` | Stops the running agent (status → `stopped`). |
| `POST` | `/sessions/:id/archive` | Archives the session (status → `archived`). Body: `{ force? }`. Returns 409 with `code: "dirty_worktree"` or `"unshared_commits"` when preconditions fail without `force`. |
| `POST` | `/sessions/:id/pull-request` | Pushes the session branch and creates a GitHub PR via `gh`. Body: `{ title?, body? }`. Returns the updated `PublicSession` with `pull_request_url`, `404` for unknown sessions, or `409` with `dirty_worktree`, `no_commits_ahead`, `gh_unavailable`, `non_github_remote`, `gh_failed`, or `archived`. |

### 11.2 SSE event names

Live SSE payloads use named events, plus a keep-alive comment frame:

- `event: session` — payload is a `Session` DTO. Emitted whenever a session row mutates.
- `event: event` — payload is a `SessionEvent`. Emitted whenever a normalized event is appended.
- `event: diff_changed` — live-only hint payload `{ kind: "diff_changed", sessionId }`; not persisted and not replayed.
- `: ping` — keep-alive comment frames every 15 s.

Replay-on-connect: each SSE response first emits any persisted events with `id > after`, then attaches to the live bus. Implementations MUST NOT lose events that arrive between the snapshot and the live attach (subscribe before replay, dedupe by id).

### 11.3 Browser-facing DTO

All HTTP and SSE responses serialize sessions through a `PublicSession` projection that omits server-internal fields (absolute paths, runtime pids, adapter-specific thread ids). The full `Session` row is reachable only via direct in-process import of `@helm/daemon`. CLI-over-HTTP receives the public DTO. If a future operation legitimately requires server-internal fields, it MUST be served from a separately-named admin route, not by widening the public DTO.

## 12. Authentication and Origin Allowlisting

The daemon is a local code-execution surface (it spawns coding agents inside user repos with permissive flags). It MUST be protected against unauthorized access from the user's own browser tabs and from local processes that don't hold the token.

### 12.1 Token

On startup, the daemon ensures a per-installation secret token exists at `~/.helm/state/token` with mode `0600`. The daemon and any authorized CLI/dashboard read it from that path.

Every authenticated route accepts the token via either:

- `Authorization: Bearer <token>` header (HTTP requests).
- `?token=<token>` query string (SSE; `EventSource` cannot set headers).

Requests without a valid token return `401`.

### 12.2 Origin allowlist

For requests carrying an `Origin` header (i.e. browsers), the daemon checks that origin against an allowlist before token validation. The default allowlist is `http://localhost:3000` and `http://127.0.0.1:3000`; it can be replaced via `HELM_ALLOWED_ORIGINS` (comma-separated). Origins outside the allowlist are rejected with `403`.

CORS responses echo only the matching allowed origin — never `*`.

The allowlist is defense-in-depth; the token is the actual auth boundary.

## 13. Out of Scope (MVP)

- Remote / cloud execution targets.
- Direct GitHub API automation, including issue linking. PR creation is supported only through the local `gh` CLI.
- Native desktop shell packaging. The browser dashboard is in scope for the MVP.
- Multi-user / multi-tenant.
- Approval gates / pause-resume.
- Adapters beyond `claude` and `codex`.
- Tmux-based session durability (deferred; agents die with the owning Helm process).
- `helm session attach` — depended on tmux; not in MVP.

## 14. Open Questions

- Worktree retention policy: auto-archive `stopped` or `completed` sessions after N days?
- Branch push policy on `archive` — push `helm/<id>` to origin first, or just delete locally?
- Should `helm session send` work while agent is mid-turn, or only in `awaiting_input`?
- Concurrency cap on running sessions per repo (worktree creation is fine; CPU/disk pressure is the real limit).
- Daemon restart durability: should sessions survive `helm daemon` restart? Currently agents die with the owning Helm process. Tmux or a process supervisor would address this.
