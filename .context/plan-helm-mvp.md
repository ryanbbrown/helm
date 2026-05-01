# Plan: Helm Local MVP

Spec: `.specs/local-mvp.md`
Brief: `.specs/gpt-prod-brief.md`

## Overview

Build the Helm engine + CLI + minimal web dashboard in a Bun TypeScript monorepo.
The engine is a small library (config, sqlite, git ops, agent runner adapters, session manager) used first by a thin CLI and later by an HTTP+SSE daemon that the Next.js dashboard talks to.

## Decisions (confirmed)

1. **No tmux in MVP.** Agents are direct child processes of whatever Helm process owns the session — CLI in phases 1-2, daemon in phase 3+. Tradeoff accepted: when the owning process exits, running agents die. SQLite + JSONL log preserve every observed event. Tmux durability revisited post-MVP.
2. **CLI imports the engine in-process for phases 1-2.** No daemon, no IPC, no port to manage. Phase 3 introduces a long-running daemon and refactors CLI commands to talk over HTTP.
3. **SSE for live event delivery to the UI.** One-way server→client; follow-ups go via plain HTTP POST.
4. **`bun:sqlite`.** Zero install friction (built into Bun, no native deps); perf delta vs `better-sqlite3` is irrelevant for our workload.
5. **Codex `exec` mode.** Spawn `codex exec --json "<prompt>"` for the first turn; spawn `codex exec resume <thread_id> --json "<follow-up>"` for follow-ups. One process per turn. The runner adapter contract accommodates this — `RunnerAdapter.send()` re-spawns under the hood for Codex; the session manager doesn't have to know.

These are settled; do not re-litigate during build.

## Steps

### Phase 0 — Spikes (validate the riskiest unknowns before building infra)

Before committing to the architecture, prove out the two interfaces everything else hangs on. Each spike is a single ~50-line `.ts` script under `spikes/` that we throw away after.

#### 0.1 Seed test repos

Both `test-repo-1` and `test-repo-2` are empty on GitHub. They need a real `main` branch with at least one commit so `git fetch origin` + `git worktree add ... origin/main` works.

```bash
# For each repo:
cd /Users/ryanbrown/code/test-repo-1
echo "# test-repo-1" > README.md
git add README.md && git commit -m "init"
git branch -M main
git push -u origin main
```

**Verify:** `git ls-remote origin main` returns a sha for both repos.

#### 0.2 Spike: Claude Code stream-json

`spikes/claude-stream.ts` — spawn `claude --print --input-format stream-json --output-format stream-json --include-partial-messages --verbose` via `Bun.spawn`, write a single user event to stdin, parse stdout JSONL, log every event type seen, send a follow-up after the first `result` event, capture the second `result`, exit cleanly.

**Verify:** Run against any directory; confirm we see `system`, `assistant`, `result` events; confirm the follow-up actually generates a second turn; confirm we can extract just the assistant text we'd surface to the UI.

#### 0.3 Spike: Codex `exec` + resume

`spikes/codex-exec.ts` — spawn `codex exec --json "<prompt>"` via `Bun.spawn`, parse the newline-delimited JSON event stream, capture `thread.started.thread.id`, extract assistant text from `item.*` events with item type `agent_message`, observe `turn.completed`, then immediately spawn `codex exec resume <thread_id> --json "<follow-up>"` and confirm a second `turn.completed` arrives.

**Verify:** Both turns finish end-to-end. We have: the exact event-type names emitted, the assistant text extracted, and confirmation that resume actually continues the same logical session (Codex remembers context).

#### 0.4 Spike: git worktree from origin

`spikes/worktree.ts` — given a repo path, run `git fetch origin` + `git worktree add -b helm/spike-1 /tmp/wt-1 origin/main`, then `git worktree remove`.

**Verify:** Worktree appears at `/tmp/wt-1` on a real branch with `origin/main`'s tip; remove cleans up. The user's checked-out branch in the source repo never changes.

**Phase 0 deliverable:** three throwaway scripts + answers to "exactly what flags do we spawn each agent with, and what JSON shape comes back."

---

### Phase 1 — Engine + programmatic test (no CLI, no UI)

Goal: from a Node script, do `await sessionManager.create({ repo: 'test-repo-1', agent: 'claude' })`, see it create a worktree, spawn the agent, ingest events, store them in SQLite, and surface the final assistant message.

#### 1.1 Workspace bootstrap

| File | Purpose |
|---|---|
| `package.json` | Root workspace; `workspaces: ["packages/*"]` |
| `tsconfig.base.json` | Shared TS config (strict, ESNext, NodeNext) |
| `bunfig.toml` | Bun runtime config |
| `.gitignore` | Standard Node ignores + `~/.helm/` not relevant |

#### 1.2 `packages/core`

Pure-types package, no runtime dependencies.

| File | Purpose |
|---|---|
| `package.json` | Name `@helm/core` |
| `src/index.ts` | Re-exports |
| `src/config.ts` | `RepoConfig`, `AgentConfig` types + zod schemas for `repos.json` / `agents.json` |
| `src/session.ts` | `Session`, `SessionEvent`, `SessionStatus` enum |
| `src/events.ts` | Normalized event union (`SessionStartedEvent`, `ThinkingEvent`, `AssistantMessageEvent`, etc. per spec §7.3) |
| `src/paths.ts` | Helpers for `~/.helm/...` paths |
| `src/ulid.ts` | ULID generation (single function; use `ulid` package) |

#### 1.3 `packages/daemon`

The engine itself. Despite the name, in phases 1-2 it's just a library imported by the CLI.

| File | Purpose |
|---|---|
| `package.json` | Name `@helm/daemon`, deps on `@helm/core` |
| `src/config-loader.ts` | Read + validate `repos.json` / `agents.json` against zod schemas |
| `src/store.ts` | `bun:sqlite` wrapper: `insertSession`, `updateSession`, `appendEvent`, `listSessions`, `getSession` |
| `src/migrations.ts` | Single SQL file for the two tables in spec §5.1 |
| `src/git.ts` | `fetch(repo)`, `createWorktree(repo, branch, path)`, `removeWorktree(path)`, `detectDefaultBranch(repo)` — all via `Bun.$` |
| `src/runner/types.ts` | `RunnerAdapter` interface: `spawn(opts)`, returns `{ events: AsyncIterable, send(text), stop() }` |
| `src/runner/claude.ts` | Implements adapter using `--print --output-format stream-json` per spike 0.2 |
| `src/runner/codex.ts` | Implements adapter using `codex exec` + `codex exec resume` per spike 0.3; persists `agent_thread_id` after `thread.started`; `send()` re-spawns with `resume <thread_id>` |
| `src/runner/normalize.ts` | Adapter-specific event → normalized `SessionEvent` |
| `src/session-manager.ts` | `create()`, `stop()`, `send()`, `archive()`, `list()`, `get()` per spec §6 |
| `src/index.ts` | Public exports |

Key shape — runner adapter contract (matches spec §7.4):

```ts
interface RunnerAdapter {
  spawn(opts: {
    cwd: string;
    extraArgs: string[];
    initialPrompt?: string;
    resumeThreadId?: string;  // for codex follow-ups
  }): RunnerHandle;
}
interface RunnerHandle {
  events: AsyncIterable<NormalizedEvent>;
  send(userText: string): Promise<void>;
  stop(): Promise<void>;
  pid: number;
}
```

For Claude, `send()` writes a JSON user event to the live child's stdin. For Codex, `send()` spawns a fresh `codex exec resume <thread_id> ...` process and replaces the current handle's event stream with the new process's output. The session manager just calls `handle.send(text)` and consumes `handle.events` — it doesn't branch on agent type.

#### 1.4 Programmatic smoke test

`packages/daemon/test/smoke.ts` — manual script (not under test runner) that:
1. Reads a sample `repos.json` + `agents.json` from `test/fixtures/`.
2. Creates a session against `test-repo-1` with `claude`.
3. Logs every normalized event.
4. After the first `assistant_message`, sends "ok thanks now do the opposite", waits for next `assistant_message`, exits.

**Verify (Phase 1):** `bun run packages/daemon/test/smoke.ts` works against the seeded test repo, creates a worktree under `~/.helm/worktrees/test-repo-1/<id>/`, surfaces the final assistant message text in the console, follow-up triggers a second turn, SQLite has rows, raw JSONL log has entries.

---

### Phase 2 — CLI

Thin layer over the engine. Each command is ~10 lines.

#### 2.1 `packages/cli`

| File | Purpose |
|---|---|
| `package.json` | Name `@helm/cli`, bin `helm`, deps on `@helm/daemon` + a small CLI lib (commander or citty) |
| `src/index.ts` | Entry, dispatches subcommands |
| `src/commands/config.ts` | `helm config validate` |
| `src/commands/session-create.ts` | `helm session create <repo> <agent> [-p <prompt>]` |
| `src/commands/session-list.ts` | `helm session list` (table output) |
| `src/commands/session-show.ts` | `helm session show <id>` |
| `src/commands/session-send.ts` | `helm session send <id> <text>` |
| `src/commands/session-stop.ts` | `helm session stop <id>` |
| `src/commands/session-archive.ts` | `helm session archive <id>` |


`session create` is interactive: it streams normalized events to the console (filtered to the surface-able set per spec §7.3) until the agent reaches `awaiting_input`, then prompts for follow-ups via stdin readline. `Ctrl-C` stops the agent and exits.

**Verify (Phase 2):**
```
bun link  # makes `helm` available globally
helm config validate
helm session create test-repo-1 claude -p "add a test file with the current date"
# → see assistant message stream, get prompt, send follow-ups, stop with ^C
helm session list
helm session show <id>
```

The user can drive a real coding-agent session from the terminal end-to-end after this phase.

---

### Phase 3 — Long-running daemon (HTTP + SSE), tmux durability

Phase 1-2 ran sessions synchronously inside the CLI process. To support the web UI and survive between commands, we need a long-running daemon and durable session processes.

#### 3.1 HTTP daemon

`packages/daemon/src/server.ts` — Bun HTTP server.

Routes (minimal MVP set):
- `GET  /sessions` → list
- `GET  /sessions/:id` → detail
- `POST /sessions` → create (body: `{repo, agent, prompt?}`)
- `POST /sessions/:id/messages` → follow-up (body: `{text}`)
- `POST /sessions/:id/stop`
- `POST /sessions/:id/archive`
- `GET  /sessions/:id/events` → SSE stream of new events as they happen
- `GET  /sessions/events` → SSE stream of cross-session status updates (for dashboard list)

CLI commands in phase 2 are refactored to **prefer the running daemon if present** (HTTP at `127.0.0.1:<port>`); fall back to in-process import if the daemon isn't running. Daemon lifecycle: `helm daemon start`, `helm daemon stop`, `helm daemon status`.

#### 3.2 Session durability

Now that the daemon is long-lived, session processes need to survive **CLI command exits**, but they can still be children of the daemon. Tmux is only required if we want them to survive **daemon restarts** — that's a stretch goal for phase 3.

| File | Purpose |
|---|---|
| `packages/daemon/src/server.ts` | HTTP + SSE |
| `packages/daemon/src/event-bus.ts` | In-process pub/sub for SSE fanout |
| `packages/daemon/src/process-supervisor.ts` | Tracks running runners across the daemon's lifetime |
| `packages/cli/src/client.ts` | HTTP client for the daemon (used by all commands when daemon is up) |
| `packages/cli/src/commands/daemon-*.ts` | start/stop/status |

**Verify (Phase 3):**
```
helm daemon start
curl http://127.0.0.1:7878/sessions          # empty
helm session create test-repo-2 codex -p "init a basic node project"
curl http://127.0.0.1:7878/sessions          # one session
curl -N http://127.0.0.1:7878/sessions/<id>/events  # SSE stream
```

Two terminals: in one, watch the SSE stream; in another, send a follow-up via `helm session send`. Confirm event flows live.

---

### Phase 4 — Next.js dashboard

Goal: in-browser UI showing all sessions and one detail pane per session, live-updating, surfacing only the events spec §7.3 says to surface.

#### 4.1 `packages/web` scaffold

| File | Purpose |
|---|---|
| `package.json` | Next.js 16, Tailwind, shadcn-style Radix primitives (mirroring conductor-oss minus the kitchen sink) |
| `tailwind.config.ts`, `postcss.config.mjs` | Tailwind setup, copy palette/typography choices from `references/conductor-oss/packages/web/tailwind.config.*` |
| `src/app/layout.tsx`, `src/app/page.tsx` | App-router root |
| `src/lib/api.ts` | Typed client for daemon HTTP API; uses generated types from `@helm/core` |
| `src/lib/sse.ts` | Hook: `useSessionEvents(id)` and `useAllSessionsStream()` over native EventSource |

#### 4.2 Components (Helm-specific, visually informed by conductor-oss)

| File | Purpose |
|---|---|
| `src/components/SessionList.tsx` | Left pane — list with status badges |
| `src/components/SessionDetail.tsx` | Center pane — header (repo/branch/status) + message timeline |
| `src/components/MessageTimeline.tsx` | Renders `assistant_message` and `thinking` indicator only |
| `src/components/Composer.tsx` | Bottom bar — textarea + send for follow-up |
| `src/components/StatusBadge.tsx` | Small visual styled like conductor-oss's session status pills |
| `src/components/EmptyState.tsx`, `src/components/Header.tsx` | Trim |

For visual fidelity, lift Tailwind tokens, color choices, and the structure of `SessionList` / `SessionTerminal` / status pill components from `references/conductor-oss/packages/web/src/components/` — but rebuild them around Helm's data model. Do not import their code.

**Verify (Phase 4):**
- `helm daemon start` + `bun run --cwd packages/web dev` → http://localhost:3000.
- Click "New session", pick repo + agent, type prompt → session appears in list, navigates to detail view, message streams live.
- Open a second browser tab → both tabs see the same SSE updates.
- Refresh during a running turn → state restores from the SSE replay.

---

## Test Strategy

Engine logic is integration-heavy (real subprocesses, real git, real sqlite). Pure unit tests would mock everything important. The strategy is to lean on integration tests that exercise the real interfaces, and use unit tests only for pure transforms.

### 1. Unit tests for normalization + parsing

- **Purpose:** Verify adapter-specific event blobs translate to normalized events correctly (the surface-vs-suppress decision is here).
- **Tests:** Each `runner/<agent>.ts` parser given recorded fixture stream → expected `NormalizedEvent[]`. Schema validation rejects malformed configs.
- **How:** `bun test` with hand-recorded fixture JSONL captured during phase 0 spikes.
- **DOES NOT:** Validate that we spawn the agent correctly or that real agents produce these events — that's strategy 2.

### 2. Engine integration tests against a fake agent

- **Purpose:** Verify session manager + git + sqlite + runner integration works end-to-end without depending on a real LLM call.
- **Tests:** Session lifecycle (create → message → stop → archive), worktree creation and removal, SQLite state matches normalized events, follow-up messages reach the agent.
- **How:** A fake adapter (`runner/fake.ts`, used only in tests) registered as agent `fake` via test fixtures; emits scripted events and accepts stdin. Test suite drives the public `sessionManager` API and asserts on store state.
- **Manual check:** No — fully automated.
- **DOES NOT:** Prove Claude or Codex specifically work; that's strategy 3.

### 3. Per-agent smoke tests against real subprocesses

- **Purpose:** Catch CLI flag drift, protocol changes, or framing bugs in the real `claude` / `codex` adapters.
- **Tests:** One smoke per agent: spawn against a temp git repo, send a trivial prompt ("respond with the word OK"), assert at least one `assistant_message` arrives and `result`/`turn_complete` fires.
- **How:** `bun test --tag smoke` (gated, opt-in; not in default CI). Locally before each release.
- **Manual check:** Yes — eyeball that the expected message text actually came through.
- **Likely misses:** Real-world long sessions, tool-use heavy turns, error states (partial mitigation: capture and replay long sessions as fixtures for strategy 1 over time).

### 4. Manual UI verification (phase 4 only)

- **Purpose:** SSE wiring, layout, status badge correctness — no good automated harness for this scope.
- **How:** Manual checklist after each meaningful UI change: create session → events stream → follow-up works → second tab syncs → refresh restores.

## Spec Coverage Map

- §5 Data Model → strategy 2 (round-trip writes/reads via session manager).
- §6 Session Lifecycle (create, stop, send, archive) → strategy 2.
- §7.1 Process Model — direct child process (no tmux); covered by strategy 2.
- §7.2 Headless Mode Adapters (`claude_stream_json`, `codex_exec`) → strategy 1 (parsers) + strategy 3 (real spawn). Codex resume flow specifically covered by strategy 3.
- §7.4 Runner Adapter Contract → strategy 2 (fake adapter implements the same interface).
- §7.3 Normalized Event Stream → strategy 1.
- §8 Git Operations → strategy 2 (worktree create/remove via real git in tests).
- §9 CLI Surface → manual check during phase 2 (small surface, low ROI on automation).
- §10 Persistence → strategy 2.

No spec gaps remain — spec was updated to remove tmux and switch Codex to `codex_exec`.

## Considerations

- **Codex resume in the runner adapter** is the subtlest piece: `RunnerHandle.events` is a single async iterable, but Codex backs it with a sequence of short-lived processes. The adapter has to splice each new `resume` process's output into the existing iterable so the session manager sees one continuous stream. Worth building this carefully — get the splicing right in the spike before phase 1.
- **Direct in-process CLI** in phases 1-2 means session-create is a foreground command — you can't background it and start a second one. That's intentional for the engine MVP. The "many concurrent sessions" UX arrives in phase 3.
- **Two test repos cloned but empty** — seed step (0.1) must happen before any worktree code can be tested. Don't skip it.
- **`@helm/core` types as the single source of truth** — daemon and web both import from it, so no shape drift between server and client.
- **Not building**: `helm session attach`, terminal embedding, kanban, GitHub integration, manager chat, mobile UI, tmux durability. All explicitly out of MVP scope.
- **What could go wrong**: Claude or Codex CLI flags could drift between versions and silently break the parser. Mitigation: pin agent CLI versions in `agents.json` validation and fail loudly if `--version` mismatches what we tested against (defer the implementation, but call it out).
