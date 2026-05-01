# Helm — Local MVP System Specification

Status: Draft v1
Scope: Local-only execution. No cloud/remote runtimes. No GitHub API integration. No manager-level chat.

## Normative Language

`MUST`, `SHOULD`, `MAY` per RFC 2119, used sparingly.

## 1. Goal

Provide a single command — `helm session create <repo> <agent>` — that produces a durable, isolated coding-agent session whose meaningful output (final assistant messages, status, artifacts) can be surfaced to a desktop UI without the user touching the terminal.

The MVP does not include the desktop UI itself. It produces the structured event stream and persistent session state that a UI layer will consume.

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
│  │  spawns: tmux new-session -d -s helm-<id> '<command>'   │ │
│  │  reads:  agent stdout (stream-json)                     │ │
│  │  writes: agent stdin  (user messages)                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────┐                                 │
│  │   git operations        │  fetch / worktree / branch      │
│  └─────────────────────────┘                                 │
└──────────────────────────────────────────────────────────────┘
                       │
                       │  IPC (Unix socket; protocol TBD)
                       ▼
                ┌─────────────┐
                │  desktop UI │  (separate, out of MVP scope)
                └─────────────┘
```

### 2.1 Components

1. **Config Loader** — reads `repos.json` and `agents.json`, validates, exposes typed accessors.
2. **Store** — SQLite database persisting sessions and events.
3. **Session Manager** — owns session lifecycle and state transitions.
4. **Agent Runner** — process supervision for one running agent, plus stdout JSON parsing and stdin writing.
5. **Git Operations** — fetch, worktree create, worktree remove.

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
| `headless_mode` | enum | `claude_stream_json` \| `codex_exec` |

#### 5.1.3 `Session` (persisted in SQLite)

| Field | Type | Notes |
|---|---|---|
| `id` | text PK | ULID |
| `repo_name` | text | FK to `repos.json` entry |
| `agent_name` | text | FK to `agents.json` entry |
| `branch` | text | e.g. `helm/<id>` |
| `worktree_path` | text | Absolute path |
| `agent_thread_id` | text? | Adapter-supplied thread/session id used for resume (e.g. Claude SDK `session_id`, Codex `thread.id`) |
| `pid` | int? | Agent process pid (null when not running) |
| `status` | enum | `created` \| `running` \| `awaiting_input` \| `completed` \| `failed` \| `archived` |
| `last_assistant_message` | text? | Most recent final assistant message |
| `last_event_at` | timestamp? | Time of most recent event ingestion |
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

### 5.2 Status Transitions

```
created ──start──▶ running ──final assistant msg──▶ awaiting_input
                      │                                    │
                      │                                    └──user msg──▶ running
                      │
                      ├──exit 0──▶ completed
                      ├──exit !=0─▶ failed
                      └──user stop─▶ archived
```

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
2. Status → `archived`.
3. Worktree is **not** removed automatically (user may have unpushed commits).

### 6.3 `send_message(id, text)`

Only valid in `awaiting_input` or `running` state. Status → `running` if not already.

The runner adapter chooses how to deliver the message:
- For long-running stdin-driven agents (Claude), the adapter writes a user event to the agent's stdin.
- For one-shot-per-turn agents (Codex), the adapter spawns a new resume process keyed on the persisted `agent_thread_id`.

`session_manager` does not need to know which mode is in use.

### 6.4 `archive_session(id)`

Removes the worktree (`git worktree remove --force`), deletes the branch, marks `archived`. Caller MUST confirm clean working tree first.

## 7. Agent Runner

### 7.1 Process Model

In the MVP, agents run as direct child processes of whatever Helm process owns the session — the CLI in phases 1-2, the long-running daemon in phase 3. Each runner adapter holds the child's stdio handles, parses stdout into normalized events, and either writes follow-ups to stdin (Claude) or re-spawns a resume process (Codex).

For each running agent the adapter MUST:
1. Capture stdout to `~/.helm/logs/<session_id>.jsonl` (append-only, raw bytes).
2. Stream parsed events to the session manager.
3. Expose `send(text)`, `stop()`, and an `events` async iterable (see §7.4).

**Tmux is deferred.** The spec originally required tmux + fifos for survival across daemon restarts; the MVP drops this for simplicity. Trade-off: when the owning Helm process exits, running agents die. SQLite + the JSONL log preserve every observed event up to that point. Reintroducing tmux durability is a phase 3+ concern (see plan).

### 7.2 Headless Mode Adapters

#### `claude_stream_json`

Spawn:
```
claude --print --input-format stream-json --output-format stream-json \
       --include-partial-messages --verbose <user-args>
```

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
| `thinking` | ✓ (as indicator) | Emitted on first non-result delta after a user msg |
| `assistant_message` | ✓ | Final, post-turn assistant text. Only this is shown. |
| `tool_use` | ✗ | Logged for transcript / debugging |
| `tool_result` | ✗ | Logged for transcript / debugging |
| `turn_complete` | ✓ (status flip) | Triggers `running → awaiting_input` |
| `error` | ✓ | Surfaces failure to UI |
| `exit` | ✓ | Process exited |

The MVP UI contract is: **show `session_started`, `thinking`, `assistant_message`, `error`, and `exit`. Suppress everything else.** Intermediate streamed deltas are coalesced; only the final assistant message of each turn is surfaced.

### 7.4 Runner Adapter Contract

Each adapter implements:

```ts
interface RunnerAdapter {
  spawn(opts: {
    cwd: string;             // worktree path
    extraArgs: string[];     // from agents.json
    initialPrompt?: string;
    resumeThreadId?: string; // present iff this is a follow-up
  }): RunnerHandle;
}

interface RunnerHandle {
  events: AsyncIterable<NormalizedEvent>;
  send(userText: string): Promise<void>;  // claude: write stdin; codex: re-spawn with resume
  stop(): Promise<void>;
  pid: number;
}
```

The session manager consumes `events`, persists them, and never branches on which agent is running.

## 8. Git Operations

| Op | Command |
|---|---|
| Fetch | `git -C <repo.path> fetch origin` |
| Detect default branch | `git -C <repo.path> symbolic-ref refs/remotes/origin/HEAD` |
| Create worktree | `git -C <repo.path> worktree add -b <branch> <wt-path> origin/<default>` |
| Remove worktree | `git -C <repo.path> worktree remove --force <wt-path>` |
| List session worktrees | `git -C <repo.path> worktree list --porcelain` |

The MVP never touches the user's checked-out main branch — fetch is read-only, worktree create branches off `origin/<default>` directly.

## 9. CLI Surface (MVP)

| Command | Purpose |
|---|---|
| `helm config validate` | Lint `repos.json` + `agents.json` |
| `helm session create <repo> <agent> [-p <prompt>]` | Create + start a session. `-p` is optional initial prompt. |
| `helm session list` | List sessions with status |
| `helm session show <id>` | Print session metadata + last assistant message |
| `helm session send <id> <text>` | Send follow-up message |
| `helm session stop <id>` | Stop running agent |
| `helm session archive <id>` | Remove worktree + branch |

## 10. Persistence

SQLite at `~/.helm/state/helm.db`. Schema is two tables (`sessions`, `session_events`) per §5.1.3 and §5.1.4.

Append-only `~/.helm/logs/<id>.jsonl` is the raw agent stream — both for debugging and as the source of truth for replay if the SQLite events table is rebuilt.

## 11. Out of Scope (MVP)

- Remote / cloud execution targets.
- GitHub API: PR creation, issue linking, push automation.
- The desktop UI itself (this spec produces the substrate it consumes).
- A manager-level chat across sessions.
- Multi-user / multi-tenant.
- Approval gates / pause-resume.
- Diff review flows.
- Adapters beyond `claude` and `codex`.
- Tmux-based session durability (deferred; agents die with the owning Helm process).
- `helm session attach` — depended on tmux; not in MVP.

## 12. Open Questions

- IPC between daemon and desktop UI: HTTP+SSE over a local port (the plan's default) vs Unix-socket framing.
- Worktree retention policy: auto-archive `completed` sessions after N days?
- Branch push policy on `archive` — push `helm/<id>` to origin first, or just delete locally?
- Should `helm session send` work while agent is mid-turn, or only in `awaiting_input`?
- Concurrency cap on running sessions per repo (worktree creation is fine; CPU/disk pressure is the real limit).
