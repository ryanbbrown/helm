# Plan: Helm Phase 5 — Manager Session

Spec: `.specs/local-mvp.md` (post-forward-compat state)
Forward-compat: `.context/forward-compat.md` (assume F2/F9/F8/F3/F5/F6/F4 landed)
Template: `.context/plan-helm-mvp.md`

## Overview

Add a **manager session** to Helm: a meta-session backed by an LLM that can spawn, observe, and steer child coding sessions through the daemon. The user talks to the manager in chat; the manager calls a small set of tools that translate to internal `SessionManager` operations. Child sessions are normal Helm sessions with `parent_session_id` pointing at the manager.

Phase 5 is **local-only**. Same daemon, same machine, no remote control. The manager is implemented as another `RunnerAdapter` so it slots cleanly into the existing session model.

Communication between the manager and its children is **file-based**: children write files in their own worktrees (e.g. `plan.md`, `feedback.md`); the manager reads them via a `read_file` tool and relays content into the next child's prompt. No shared workspaces, no IPC, no peer messaging.

## Decisions (confirmed; do not relitigate)

1. **Manager is a custom agent loop, not a framework.** ~50-100 lines. We own the loop, tool dispatch, and event mapping. No Pydantic AI, LangGraph, Mastra, or Claude Agent SDK.
2. **OpenRouter via the OpenAI SDK is the default LLM gateway.** Model is configured per-manager in `agents.json` (`"anthropic/claude-opus-4.7"`, `"openai/gpt-5"`, etc.). API key from `OPENROUTER_API_KEY`. Adding a non-OpenAI-compatible provider later is a new `headless_mode`, not a rewrite.
3. **Worktrees stay strictly isolated.** No `workspace_from`, no shared trees, no `git worktree --force`. Each session — manager or child — has its own (or none, in the manager's case).
4. **Manager has no worktree.** `WorkspaceProvider` gains a no-op `null` provider used for managers; `worktree_path` / `workspace_uri` is null for manager sessions.
5. **Inter-session communication is file-based.** Manager reads child files via `read_file`; passes content as text in subsequent prompts. Bucket-3 artifact-passing pattern, not IPC.
6. **Six manager tools in v1**: `list_sessions`, `get_session`, `create_child_session`, `send_message`, `stop_child`, `read_file`. No `archive_child`, no `write_file`, no `read_diff` in v1.
7. **`read_file` is read-only, live sessions only, sandboxed to the target session's worktree.** Path traversal (`..`, absolute paths, symlinks escaping the worktree) returns `403`. Archived sessions return `404`.
8. **Manager uses `ManagerRunnerAdapter`.** Implements the existing `RunnerAdapter` contract; backed by the OpenAI SDK pointed at OpenRouter; no subprocess. Tool dispatch calls back into `SessionManager` in-process.
9. **Children appear in the same flat list with a `parent_session_id` badge.** Manager detail view gets a "Children" panel inline. No nested tree view.
10. **Concurrency cap of 5 live (non-archived) children per manager.** Configurable via `HELM_MANAGER_CHILD_CAP`. Manager gets a tool-call error past the cap.
11. **No archive cascade.** Archiving a manager does not archive its children. The user explicitly archives each.
12. **No auto-termination.** Manager session ends only on user `stop` or `archive`. Children completing does not end the manager.
13. **Autonomous tool calls.** No per-call human-in-the-loop confirmation in v1. The cap + explicit `stop_child` are the safeguards.
14. **New normalized event kinds**: `tool_invocation`, `tool_result`, `child_event`. Surfaced to the manager's UI; suppressed in non-manager sessions (they never emit them).
15. **Daemon restart kills the manager along with its children**, consistent with current spec §7.1 ("agents die with the owning Helm process"). Manager conversation is replayable from `session_events` if we ever revisit durability.

## Steps

### Phase 5.0 — Spike (validate the riskiest unknown)

Before touching the codebase, prove the OpenRouter + tool-use loop works end-to-end with a throwaway script.

#### 5.0.1 Spike: OpenRouter agent loop with custom tools

`spikes/manager-loop.ts` — ~80 lines. Uses the `openai` SDK pointed at `https://openrouter.ai/api/v1`. Defines two fake tools (`echo`, `wait`). Streams a conversation: user prompt → assistant tool_call → script executes tool → tool_result → assistant text. Confirms:

- Streaming tool_call deltas can be assembled into a complete tool call before dispatch.
- Multi-turn loop terminates on `finish_reason: "stop"`.
- Switching `model` between `anthropic/claude-opus-4.7` and `openai/gpt-5` works without code changes.
- Cancellation mid-stream is clean (no zombie requests).

**Verify (Phase 5.0):** Two models, two providers, tool calls dispatched, conversation terminates. Script discarded.

---

### Phase 5.1 — Core types + workspace null provider

Tiny phase. Adds the data-model seams the rest of phase 5 depends on. No behavior change visible to users.

#### 5.1.1 `packages/core` additions

| File | Purpose |
|---|---|
| `src/events.ts` | Add `tool_invocation`, `tool_result`, `child_event` kinds + interfaces. Update `NormalizedEvent` and `PublicNormalizedEvent` unions. Update `SessionEventKind`. |
| `src/manager.ts` | New file. Manager-specific shapes: `ManagerToolCall`, `ManagerToolResult`, `ChildEventKind` (`spawned`, `message_sent`, `stopped`, `error`). |
| `src/session.ts` | No change to `Session` row (parent_session_id already in from F6). Confirm `PublicSession` already includes `parent_session_id`. |

New event payloads:

```ts
type ToolInvocationEvent = {
  kind: "tool_invocation";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

type ToolResultEvent = {
  kind: "tool_result";
  toolCallId: string;
  toolName: string;
  ok: boolean;
  result: unknown;       // truncated to N chars in Public projection
  errorMessage?: string;
};

type ChildEvent = {
  kind: "child_event";
  childKind: "spawned" | "message_sent" | "stopped" | "error";
  childId: string;
  detail?: string;
};
```

#### 5.1.2 `packages/daemon` workspace null provider

| File | Purpose |
|---|---|
| `src/workspace/null.ts` | `NullWorkspaceProvider` implementing `WorkspaceProvider`. `create()` returns `{ uri: null, cwd: null, branch: null }`. `assertRemoveSafe` is a no-op. `remove` is a no-op. Used for manager sessions. |
| `src/workspace/types.ts` | Allow `cwd: string \| null` and `branch: string \| null` in `WorkspaceHandle`. Document that file-based runners require non-null `cwd`. |
| `src/session-manager.ts` | `create()` selects `NullWorkspaceProvider` if `agent.headless_mode === "manager_loop"`; otherwise default. Persist `worktree_path: null` for manager rows. |
| `src/store.ts` | Confirm `worktree_path` column is nullable. If not from F5 work, add a migration. |

**Verify (Phase 5.1):**
- `bun run check` passes.
- `bun run test:unit` passes; new event kinds round-trip through `toPublicSession{Event}` helpers.
- A test that creates a session with `agent.headless_mode === "manager_loop"` (no actual runner yet — just the row) succeeds and has `worktree_path: null`.

---

### Phase 5.2 — `ManagerRunnerAdapter`

The bulk of the work. Implement the agent loop, tool dispatch, and `RunnerHandle` plumbing.

#### 5.2.1 OpenRouter client

| File | Purpose |
|---|---|
| `packages/daemon/src/runner/openrouter.ts` | Thin wrapper around `openai` SDK. Constructs client with `baseURL: "https://openrouter.ai/api/v1"` and `apiKey: process.env[apiKeyEnv]`. Exposes `streamChatCompletion({ model, messages, tools, signal })` returning an async iterable of OpenAI-format streaming chunks. |

#### 5.2.2 Manager runner

| File | Purpose |
|---|---|
| `packages/daemon/src/runner/manager.ts` | Implements `RunnerAdapter`. `spawn()` creates a `ManagerHandle` holding conversation state + an `AbortController`. Returns `{ events, send, stop, pid: -1 }`. Pid is `-1` (sentinel — no OS process). |
| `packages/daemon/src/runner/manager-tools.ts` | Tool registry: 6 tools with JSON-Schema definitions for OpenAI tool format. Each tool has an `execute(args, ctx)` function that calls back into a `ManagerToolContext`. |
| `packages/daemon/src/runner/manager-context.ts` | `ManagerToolContext` struct: holds a reference to `SessionManager`, the manager's own session id, the cap config, and the workspace-resolver function for `read_file`. |
| `packages/daemon/src/runner/manager-loop.ts` | The loop: while last assistant message has tool calls, execute them in declaration order, append results, re-call OpenRouter. Emits `assistant_message`, `tool_invocation`, `tool_result`, `child_event`, `turn_complete`, `error` events into the handle's event channel. |

Adapter contract reuse:

- `spawn(opts)` ignores `cwd` (manager has no worktree); `extraArgs` is unused; `initialPrompt` if present runs the first turn immediately; `resumeThreadId` ignored. `logPath` writes the OpenRouter request/response stream as JSONL for debugging — same shape as agent JSONL logs.
- `send(text)` appends `{ role: "user", content: text }` to the conversation, kicks the loop. The same `events` async iterable is used; the loop emits new events as they happen.
- `stop()` calls `AbortController.abort()`; in-flight stream ends; `events` iterable closes; final `exit` event is emitted with `code: 0`.

#### 5.2.3 Tool implementations

Each tool returns `{ ok: boolean, result?: unknown, errorMessage?: string }`. Errors are *not* thrown — the loop turns errors into tool_result events the model can read and react to.

| Tool | Behavior | Errors |
|---|---|---|
| `list_sessions({ includeArchived?: boolean })` | Returns `PublicSession[]`. Excludes the manager's own session by default. | — |
| `get_session({ sessionId })` | Returns `{ session: PublicSession, recentMessages: AssistantMessageEvent[] }` (last N=10 assistant messages). | `not_found` |
| `create_child_session({ repo, agent, prompt })` | Creates child via `SessionManager.create` with `parent_session_id` = manager id. Emits `child_event(spawned)`. | `unknown_repo`, `unknown_agent`, `cap_exceeded` |
| `send_message({ sessionId, text })` | Calls `SessionManager.send`. Requires `parent_session_id` of target equals manager id. Emits `child_event(message_sent)`. | `not_a_child`, `not_running`, `archived` |
| `stop_child({ sessionId })` | Calls `SessionManager.stop`. Requires `parent_session_id` match. Emits `child_event(stopped)`. | `not_a_child`, `already_stopped` |
| `read_file({ sessionId, path })` | Resolves path inside the child's worktree. Path must be relative, no `..`, must resolve to a file inside the worktree (real path check). Returns content (UTF-8) capped at 256 KiB. | `not_a_child`, `archived`, `path_traversal`, `not_a_file`, `too_large`, `read_failed` |

#### 5.2.4 Wiring

| File | Purpose |
|---|---|
| `packages/daemon/src/runner/index.ts` | `createRunnerAdapter` dispatches `manager_loop → ManagerRunnerAdapter` in addition to existing `claude_stream_json` / `codex_exec`. |
| `packages/daemon/src/session-manager.ts` | Pass `parent_session_id` from `CreateSessionInput` through to `Store.insertSession`. Honor null workspace for manager sessions. Inject `ManagerToolContext` into the manager adapter. |
| `packages/core/src/config.ts` | Extend `AgentConfig` zod schema with optional `model` and `api_key_env` fields. Allowed `headless_mode`: add `"manager_loop"`. |
| `packages/daemon/src/config-loader.ts` | Validate that manager agents have `model` and `api_key_env`. |

#### 5.2.5 Tests

| File | Purpose |
|---|---|
| `packages/daemon/src/runner/manager.test.ts` | Unit tests with a fake OpenRouter stream (recorded fixture). Cover: tool call dispatch, multiple tool calls per turn, tool errors propagate as `tool_result(ok: false)`, abort during stream, child cap enforcement. |
| `packages/daemon/src/runner/manager-tools.test.ts` | Each tool tested in isolation against a real `SessionManager` + temp store + temp git repos + `FakeRunnerAdapter` for the children. `read_file` path-traversal test covers `..`, absolute, symlink-escape, file-too-large. |

**Verify (Phase 5.2):**
- `bun run check` and `bun run test:unit` pass.
- Spawn a manager session in a script (no UI yet); send a prompt that asks it to spawn a child and call `list_sessions`; observe the child appears in `helm session list` with `parent_session_id` set.
- Re-run with a prompt that triggers `read_file` against a child's worktree; observe content returned to the model.
- Re-run with a prompt that intentionally tries `path: "../../etc/passwd"`; observe `tool_result(ok: false, errorMessage: "path_traversal")`.

---

### Phase 5.3 — HTTP API + CLI surface

Expose the new agent type through existing routes; add one new route for browser-friendly manager creation.

#### 5.3.1 HTTP

The existing `POST /sessions` route already accepts `{ repo, agent, prompt }`. For manager sessions, `repo` is required by the schema but the manager has no repo. Two options:

- **Option A** (chosen): allow `repo: null` when `agent.headless_mode === "manager_loop"`. Validation runs in `SessionManager.create` based on the resolved agent config.
- Option B: a separate `POST /sessions/manager` route. Rejected — it'd duplicate event/SSE wiring for no real benefit.

`POST /sessions` body becomes `{ repo?: string, agent: string, prompt?: string, parent_session_id?: string }`. Server-side rules:
- `repo` required iff agent is not a manager.
- `parent_session_id` accepted only when called from the manager runner's tool (server-side; HTTP callers cannot set it). Enforced by checking the request originated in-process (existing daemon-internal call path) vs HTTP. The HTTP handler ignores the field if present.

| File | Purpose |
|---|---|
| `packages/daemon/src/server.ts` | Update `/sessions` POST schema; reject `parent_session_id` from external callers. Update `GET /sessions` to optionally filter by `parent_session_id` via query param. |
| `packages/daemon/src/server.ts` (auth) | No change — same token + origin allowlist. |

#### 5.3.2 CLI

| File | Purpose |
|---|---|
| `packages/cli/src/commands/manager-create.ts` | `helm manager create [<manager-agent>] [-p <prompt>]`. Defaults to first agent with `headless_mode: manager_loop`. Streams events to the terminal like `session create`, but renders `tool_invocation` / `tool_result` / `child_event` as compact one-liners. |
| `packages/cli/src/commands/session-list.ts` | Add `--parent <id>` filter. |
| `packages/cli/src/index.ts` | Register `manager` command. |

`helm session create` still works for non-manager agents and is unchanged. Children created by the manager are reachable via `helm session list` and `helm session show <id>`.

**Verify (Phase 5.3):**
- `helm manager create -p "list my repos and start a session"` works against a daemon with the `manager` agent configured.
- `curl POST /sessions` with `{ repo: null, agent: "manager", prompt: "..." }` succeeds.
- `curl POST /sessions` with `{ repo: null, agent: "claude", ... }` fails with a 400.
- `curl POST /sessions` with `{ ..., parent_session_id: "..." }` ignores the field (sets null in DB).
- `helm session list --parent <manager-id>` shows only that manager's children.

---

### Phase 5.4 — Dashboard surface

Make the manager visible in the existing UI without inventing a new layout.

#### 5.4.1 Visual changes

| File | Purpose |
|---|---|
| `packages/web/src/components/SessionList.tsx` | When a session has `parent_session_id`, render a small "↳ managed by <short-id>" badge under the title. Manager sessions render with a distinct icon (no repo). |
| `packages/web/src/components/SessionDetail.tsx` | If session is a manager, render a "Children" panel above the message timeline showing each child's `id`, `repo`, `agent`, `status`, last assistant message snippet. Clicking a child navigates to its detail. |
| `packages/web/src/components/MessageTimeline.tsx` | Render new event kinds: `tool_invocation` (collapsed by default — "called read_file(...)"), `tool_result` (one-line ok/error), `child_event` (one-line "spawned session ABCD" / "stopped session ABCD"). |
| `packages/web/src/components/Composer.tsx` | No change — `send` works on managers identically. |
| `packages/web/src/app/page.tsx` | "New session" dialog gains a "Manager" tab that asks only for prompt + manager agent (no repo picker). |
| `packages/web/src/lib/api.ts` | Type updates for the extended `POST /sessions` schema and new event kinds. |

**Verify (Phase 5.4):**
- Create a manager session from the dashboard with prompt "spawn a session in test-repo-1 with claude that writes plan.md, then read the plan and tell me what it said."
- Manager appears in the list. Detail view shows the manager's chat with `tool_invocation`/`tool_result` lines.
- A child appears in the list within a few seconds, with the "managed by ..." badge.
- Manager's detail Children panel updates live.
- Open child in another tab; see its own session unchanged.
- Stop the manager from the UI; confirm children remain (no cascade).
- Archive the manager; confirm children remain (no cascade); confirm manager disappears from default list.
- Reload the page mid-stream; SSE replay restores correctly.

---

### Phase 5.5 — Real-agent regression test

Add a Playwright case to `tests/e2e/real-agents.spec.ts` so the slow tier catches manager-loop drift.

| File | Purpose |
|---|---|
| `tests/e2e/real-agents.spec.ts` | New test: spawn a manager with `model: "anthropic/claude-haiku-4-5-20251001"` (cheap), prompt it to spawn a child Claude session in a temp repo with the prompt "create plan.md containing the word PLAN", wait for the child to reach `awaiting_input`, then prompt the manager to `read_file` that plan and assert it returns "PLAN" in the assistant text. Stops the manager and the child cleanly. |

This test only runs under `HELM_REAL_AGENT_E2E=1` and additionally requires `OPENROUTER_API_KEY`. CI instructions are updated.

**Verify (Phase 5.5):**
- `HELM_REAL_AGENT_E2E=1 OPENROUTER_API_KEY=... bun run test:agents` passes.
- Without the env vars, the test is skipped, not failed.

---

### Phase 5.6 — Spec update

Drift is the most expensive bug class in this repo. Spec is updated *in the same commit* as the last behavior-affecting change.

| File | Section | Change |
|---|---|---|
| `.specs/local-mvp.md` | §5.1.3 Session | Note that `parent_session_id` is set when a manager spawns a child; null otherwise. |
| §5.1.4 SessionEvent | Add `tool_invocation`, `tool_result`, `child_event` to the `kind` enum. |
| §7.2 Headless Mode Adapters | Add `manager_loop` subsection: OpenRouter via `openai` SDK; configured `model` and `api_key_env`; tool schema; cap of 5; abort semantics. |
| §7.3 Normalized Event Stream | Add the three new kinds to the table. UI contract: surfaced for manager sessions only; suppressed in others (children never emit them). |
| §9 CLI Surface | Add `helm manager create`. Add `--parent` to `session list`. |
| §11 HTTP API | Update `POST /sessions` body schema. Add `?parent=<id>` to `GET /sessions`. |
| §13 Out of Scope | Remove "manager-level chat across sessions" — it is now in scope. |
| §14 Open Questions | Add: should manager conversation persist across daemon restart? (deferred). Should children inherit working knowledge from the manager beyond their initial prompt? (deferred). |

---

## Test Strategy

Lean on the strategy already defined in `.context/plan-helm-mvp.md`. Phase 5 adds:

### 1. Unit tests — manager loop and tool dispatch (fixture-driven)

- **Purpose:** Verify the loop terminates, tool calls dispatch, errors propagate as tool_results, abort cleans up.
- **How:** Recorded OpenRouter streaming fixtures + the real `ManagerRunnerAdapter` against a fake `ManagerToolContext`.
- **Does not:** Validate that real OpenRouter actually responds with the expected shape — that's strategy 4.

### 2. Integration tests — manager tools against a real session manager

- **Purpose:** Verify each tool's effect on `SessionManager` state.
- **How:** `FakeRunnerAdapter` for child sessions + a temp git repo + a temp SQLite store. Drive the tools directly from a test (no LLM in the loop).

### 3. e2e — dashboard manager flow

- **Purpose:** Verify the full surface end to end through the dashboard, with a *fake* manager runner that emits scripted tool calls.
- **How:** A `FakeManagerAdapter` registered as a test-only agent. Playwright drives the dashboard; the fake adapter spawns children, calls `read_file`, etc.

### 4. Slow tier — real OpenRouter manager regression

- **Purpose:** Catch drift in OpenRouter's tool-call protocol or our streaming parser.
- **How:** §5.5. Single test, opt-in.

---

## Spec Coverage Map

| Spec section | Phase 5 step | Strategy |
|---|---|---|
| §5.1.3 (manager / parent_session_id) | 5.1, 5.2 | Strategy 2 |
| §5.1.4 (new event kinds) | 5.1 | Strategy 1 |
| §7.2 (`manager_loop` adapter) | 5.2 | Strategy 1 + 4 |
| §7.3 (event surface contract) | 5.4 | Strategy 3 |
| §9 (`helm manager create`) | 5.3 | Manual + e2e |
| §11 (extended POST /sessions) | 5.3 | Strategy 3 (e2e through CLI-over-HTTP) |
| Tool sandbox (`read_file`) | 5.2.5 | Strategy 2 (path-traversal tests) |
| Cap enforcement | 5.2.5 | Strategy 2 |
| No archive cascade | 5.4 verify | Strategy 3 |

---

## Considerations / Tradeoffs

- **OpenAI tool_call streaming is fiddly.** Tool call args arrive as deltas (`tool_calls[].function.arguments` accumulates string fragments). The loop must buffer until `finish_reason: "tool_calls"` before parsing. Worth carefully isolating in `manager-loop.ts` and covering with a fixture-driven test.
- **Prompt caching is provider-specific.** With OpenRouter we can't rely on Anthropic-style cache_control across models. v1 sends the full conversation each turn; manager sessions are short, so token cost is small. Revisit when conversations regularly exceed ~50k tokens.
- **`read_file` is a real security boundary.** It's the first daemon API that returns file *contents*. The path-resolution function must reject anything that isn't a regular file inside the target worktree's real path. Symlink check uses `fs.realpath` and `path.relative`. The tool itself runs in-process — same trust boundary as the rest of `SessionManager`.
- **Manager has no worktree, but the existing schema has `worktree_path` non-null in some places.** Phase 5.1 makes it nullable in core; F5's introduction of `workspace_uri` should also be nullable. Migration tested per AGENTS.md §2.
- **Cap is a soft guardrail, not a security limit.** The cap protects against runaway manager loops; it is checked only on `create_child_session`, not on send. A misbehaving manager can still spam an existing child with messages — `stop_child` is the exit. Per-child rate limiting is out of scope.
- **No manager-to-manager nesting.** A manager could in theory create another manager as a child. The phase 5 plan does not forbid this — `parent_session_id` chains are allowed. We don't expose nesting in the UI; deeply nested manager trees just appear flat. If this becomes a problem, restrict it later.
- **Cost.** OpenRouter passes through provider pricing + ~5%. A chatty manager that calls tools many times per turn can rack up cost; the user is one developer paying their own bill, so the cap + manual `stop` is sufficient.
- **Adapter contract preserved.** `RunnerHandle` is identical for the manager. Future runner work (e.g. cloud workspace provider, remote control) doesn't have to special-case managers.

## Open questions deferred to Phase 6+

- **Manager durability across daemon restart.** Currently dies with the daemon. Replay from `session_events` is theoretically possible since we persist the conversation; not implemented.
- **Manager-as-orchestrator-of-task-board (Phase 8).** When the task board lands, who owns dispatch — the manager or a separate orchestrator daemon? Symphony separates them; we can revisit.
- **Per-manager system prompt customization in `agents.json`.** v1 ships one system prompt baked in. Allowing user-provided system prompts is one config field away.
- **Multiple manager *types* (planner-critic, code-reviewer, dispatcher).** v1 has a single manager that's good at general orchestration. Specialized manager configs come later.
- **`write_file` tool.** Deferred. Manager can always tell a child "create file X" via `send_message`. Adding write would let the manager seed scaffolding directly; revisit when a use case actually demands it.
- **`read_diff` tool.** Deferred until the daemon has a `GET /sessions/:id/diff` endpoint (forward-compat doc lists this as additive, ~10 lines).
- **Cross-session worktree sharing (P1 in earlier discussion).** Not needed once file-passing is in. Revisit only if a real workflow requires concurrent edits on the same branch.
- **Per-tool-call confirmation gates.** Useful when remote control lands and trust assumptions change.
