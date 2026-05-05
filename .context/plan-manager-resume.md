# Plan: Durable Session Resume

Spec: `.specs/local-mvp.md`

## Overview

Add first-class recovery for daemon interruptions so Helm can distinguish user-stopped sessions from sessions that lost their in-memory runner handle, offer the user an explicit resume choice in the dashboard, and resume Codex, Claude, and manager sessions from persisted conversation state.

The core model is: child agents resume from their CLI-owned transcript ids stored in `sessions.agent_thread_id`, while manager sessions resume from a new Helm-owned append-only conversation log keyed by the manager session id.

## Steps

### 1. Model `interrupted` As A Real Lifecycle State

Extend the session status type and spec so daemon-owned sessions that were live when Helm stopped become `interrupted`, not `stopped`.

Files:
- `.specs/local-mvp.md`
- `packages/core/src/session.ts`
- `packages/daemon/src/store.ts`
- `packages/daemon/src/store.test.ts`
- Any dashboard status display helpers in `packages/web/src/components/`

Behavior:
- `created`, `running`, and `awaiting_input` rows reconciled at daemon startup become `interrupted`, with `pid = null`.
- User-initiated `stop()` still sets `stopped`.
- Archive behavior remains unchanged.
- `getActiveManagerSession()` MUST include interrupted managers as non-archived managers so creating a second manager is still rejected until the old one is resumed, stopped, or archived.
- Parent validation for child creation can continue to use `manager_mode`; children of an interrupted manager are still children of a manager, but creating more children requires resuming the manager first because the manager handle is unavailable.

Reference change:

```ts
export type SessionStatus =
  | "created"
  | "running"
  | "awaiting_input"
  | "interrupted"
  | "completed"
  | "failed"
  | "stopped"
  | "archived";
```

```ts
/** Marks sessions that lost their in-memory runner handle after daemon restart as interrupted. */
reconcileInProcessSessions(): void {
  this.db
    .query("UPDATE sessions SET status = 'interrupted', pid = NULL, updated_at = ? WHERE status IN ('created', 'running', 'awaiting_input')")
    .run(new Date().toISOString());
}
```

**Verify:** Unit test creates rows in each live status, constructs a `SessionManager` with reconciliation enabled, and asserts only live rows changed to `interrupted`; a manually stopped row stays `stopped`.

### 2. Add Runner-Level Resume Semantics

Make resume an explicit spawn mode instead of relying on `send()` paths that only work after a handle already exists.

Files:
- `packages/daemon/src/runner/types.ts`
- `packages/daemon/src/runner/codex.ts`
- `packages/daemon/src/runner/claude.ts`
- `packages/daemon/src/runner/manager.ts`
- `packages/daemon/src/runner/index.ts`
- `packages/daemon/src/runner/normalize.test.ts`
- Existing or new runner adapter tests

Contract:
- `RunnerSpawnOptions.resumeThreadId?: string` already exists; use it in all adapters that can resume.
- A resumed handle should start idle and ready to accept `send()` unless an initial resume prompt is provided.
- Resume should not emit a duplicate `session_started` event; this is owned by `SessionManager.create()`, not adapters.
- Resume only updates `pid` when a process is actually spawned. Lazy resume handles may leave `pid = null` until the next `send()`.

Codex:
- Already has the important command path:

```ts
[command, "exec", "resume", resumeThreadId, "--json", ...extraArgs, prompt]
```

- Ensure `spawn()` passes `opts.resumeThreadId` through and does not accidentally create a new Codex thread when no resume prompt is present.
- Codex resume MUST be lazy when no resume prompt is provided. `SessionManager.resume()` constructs a `CodexRunnerHandle` primed with `session.agent_thread_id`, stores it in `handles`, sets the session to `awaiting_input`, and does not spawn `codex exec resume` until the next `send(text)`.
- Remove the old `pendingFollowUp` path after lazy resume exists; the adapter should have one clear way to handle “thread id known later.”

Claude:
- Update the spawn command to include `--resume <sessionId>` when `opts.resumeThreadId` is set.
- Preserve the existing stream-json mode:

```ts
[
  command,
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--resume",
  resumeThreadId,
  ...extraArgs
]
```

- Keep stdin open for follow-ups exactly as the current adapter does.
- If real-agent tests show Claude `--resume` with `--input-format stream-json` is unstable after mid-turn death, use the same lazy resume shape as Codex: rehydrate the handle, set `awaiting_input`, and spawn Claude only when the next user message arrives.

Manager:
- Resume does not use `agent_thread_id`.
- Resume uses persisted manager messages from Step 3.

**Verify:** Runner tests assert Codex lazy resume does not spawn until `send(text)`, then uses `exec resume <threadId> --json ... <text>`. Claude tests assert exact resume command arrays when eager resume is supported. Missing resume ids fail at the session-manager layer before reaching the adapter.

### 3. Persist Manager Conversation Messages

Add a durable, append-only manager message log in SQLite. This is the manager equivalent of Codex and Claude transcript JSONL files.

Files:
- `packages/daemon/src/migrations.ts`
- `packages/daemon/src/migrations.test.ts`
- `packages/daemon/src/store.ts`
- `packages/daemon/src/runner/manager.ts`
- `packages/daemon/src/runner/openrouter.ts`
- `.specs/local-mvp.md`

Schema:

```sql
CREATE TABLE IF NOT EXISTS manager_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_manager_messages_session_id_id
  ON manager_messages(session_id, id);
```

Store API:

```ts
export type ManagerMessageRow = {
  id: number;
  session_id: string;
  payload: string;
  created_at: string;
};

insertManagerMessage(sessionId: string, message: ManagerChatMessage): void;
listManagerMessages(sessionId: string): ManagerChatMessage[];
hasManagerMessages(sessionId: string): boolean;
```

Persistence rules:
- Persist the system message when a new manager handle is created.
- Persist each explicit user message before kicking the turn.
- Persist each rendered state snapshot user message when it is appended.
- Persist assistant messages immediately after receiving an OpenRouter response and before executing tool calls.
- Persist tool result messages immediately after each tool result is produced.
- Do not rely on `~/.helm/logs/<session>.jsonl` as resume source; keep that as raw request/response trace only.
- `payload` stores the full OpenAI-compatible `ManagerChatMessage` JSON, including `role`, `content`, `tool_calls`, `tool_call_id`, and `name` when present. Do not duplicate `role` in a separate column; replay only needs `WHERE session_id = ? ORDER BY id`.
- The composite `(session_id, id)` index is intentional because replay reads one session's messages in insertion order.
- `listManagerMessages()` MUST repair malformed tails before returning messages to the manager. If the last assistant message has `tool_calls` without matching subsequent `tool` messages, synthesize one tool result per missing `tool_call_id` with `{ ok: false, errorMessage: "interrupted" }` so the next OpenRouter request remains valid.

Implementation shape:
- Pass a `ManagerConversationStore` or small callback object into `ManagerRunnerHandle` instead of reaching into SQLite directly from the runner.
- The handle should use one helper for mutation:

```ts
private appendMessage(message: ManagerChatMessage): void {
  this.messages.push(message);
  this.conversation?.append(this.opts.sessionId, message);
}
```

- On new manager spawn, initialize with the rendered system prompt and append it.
- On manager resume, load ordered messages and initialize `this.messages` from the stored payloads.

**Verify:** Unit test starts a manager with a fake OpenRouter client that returns a tool call, approves it, and asserts the stored sequence is system, user prompt, state snapshot, assistant tool-call message, tool result message, final assistant message.

**Verify:** Unit test seeds manager messages ending in an assistant message with unmatched `tool_calls`, calls `resume()`, sends a message, and asserts the fake OpenRouter client receives a valid message array with synthetic interrupted tool results before the next user/state message.

### 4. Add `SessionManager.resume()`

Add one central method that rehydrates an interrupted session into an in-memory handle.

Files:
- `packages/core/src/events.ts`
- `packages/daemon/src/session-manager.ts`
- `packages/daemon/src/session-manager.test.ts`
- `packages/daemon/src/server.ts`
- `packages/cli/src/client.ts`
- `packages/cli/src/index.ts`

API shape:

```ts
/** Recreates an in-memory runner handle for an interrupted session. */
async resume(id: string): Promise<Session> {
  const session = this.getRequired(id);
  if (session.status !== "interrupted") {
    throw new Error("not_resumable");
  }
  if (this.handles.has(id)) {
    return session;
  }
  // load config, agent, workspace, thread/message state, spawn, patch status
}
```

Validation:
- Archived sessions return `409 archived`.
- Stopped, completed, failed, and awaiting-input sessions return `409 not_resumable` unless the spec explicitly decides later to support “restart from transcript.” `stopped` means the user intentionally stopped it, so it should not appear in the interruption recovery flow.
- Codex and Claude require `worktree_path` and `agent_thread_id`.
- Manager sessions require `manager_mode` and at least one persisted manager message; if an older manager lacks persisted messages, return `409 missing_manager_transcript` with a clear message.
- Child sessions must still have their worktree path on disk.
- A resumed manager must respect singleton manager constraints.
- Resume is idempotent while a handle exists: if `this.handles.has(id)`, return the current session without creating a second process or subscription.

Spawn behavior:
- For child agents, call the existing adapter factory with `resumeThreadId: session.agent_thread_id`.
- For manager, call the manager adapter with `resumeThreadId` unset and a manager conversation loader.
- Put the handle in `this.handles` and set `status = "awaiting_input"`. Patch `pid` only when an adapter actually starts a process.
- After inserting into `this.handles`, start `this.consumeEvents(id, handle)` exactly as `create()` does (`session-manager.ts:167`); without it, status flips on `turn_complete` and SSE event delivery break for resumed sessions.

Recommended status after resume:
- Use `awaiting_input` for handles that are rehydrated idle and waiting for the next dashboard send.
- `send()` flips the session back to `running` when the user provides the next message.
- Do not auto-kick a manager on resume. Any pending wake notices from before daemon death are lost by design; the manager waits for a new user message or future child lifecycle event.
- No cleanup is needed for the old manager event-bus subscription after daemon death because the prior `EventBus` instance died with the process.

Events:
- Persist a new normalized event kind, `session_resumed`, with `{ sessionId }`. Add the variant to the `SessionEventKind` union and the `NormalizedEvent` discriminated union in `packages/core/src/events.ts`.
- Publish a session update over SSE after status changes.
- Do not write a synthetic user message during resume.

**Verify:** Integration tests seed interrupted Codex, Claude, and manager sessions, call `resume()`, assert handle presence indirectly by calling `send()` and observing status/events.

### 5. Expose Resume Over HTTP And CLI

Add explicit user-facing controls.

Files:
- `packages/daemon/src/server.ts`
- `packages/cli/src/client.ts`
- `packages/cli/src/index.ts`
- `packages/core/src/events.ts`
- `.specs/local-mvp.md`

HTTP:
- `POST /sessions/:id/resume` resumes one session.
- `POST /sessions/:id/dismiss-interruption` converts `interrupted -> stopped` without spawning.
- Optional but useful: `GET /sessions?status=interrupted` or `GET /sessions/interrupted` if dashboard filtering becomes awkward.

CLI:
- `helm session resume <id>`
- `helm session dismiss-interruption <id>`
- `helm manager resume` resumes the singleton manager if it is interrupted.

Errors:
- `409 not_resumable`
- `409 missing_thread_id`
- `409 missing_worktree`
- `409 missing_manager_transcript`
- `409 manager_exists`
- `410 archived`

Implementation:
- Add a typed lifecycle error class, e.g. `SessionLifecycleError`, rather than extending the existing hard-coded `server.ts` string allowlist for every new resume error.

**Verify:** Server route tests cover success and each structured error; CLI tests cover request paths and printed session status.

### 6. Build Dashboard Interruption Recovery UX

When the dashboard opens and any visible sessions are `interrupted`, prompt the user to resume or dismiss them.

Files:
- `packages/web/src/app/page.tsx`
- `packages/web/src/lib/api.ts`
- `packages/web/src/components/SessionList.tsx`
- `packages/web/src/components/SessionDetail.tsx`
- New component, e.g. `packages/web/src/components/InterruptedSessionsPanel.tsx`
- CSS in the existing web stylesheet

UX:
- On load, compute interrupted sessions from `listSessions()`.
- Show a compact panel/banner above the main content or in the sidebar.
- Text should be direct: “Helm stopped while sessions were active.”
- Use a flat list for the first implementation. Include a small parent id label for child sessions when useful, but do not build a nested manager tree yet.
- Actions:
  - Resume all
  - Resume selected
  - Leave stopped
- `Leave stopped` calls dismiss for selected sessions and changes status to `stopped`; it does not archive or delete worktrees.

Rules:
- Manager sessions should be visually prominent because child coordination depends on them.
- Child sessions with missing thread ids should show as “Cannot resume; worktree kept” and remain selectable for diff/PR/archive.
- Resume failures should be shown inline per session, not as a single global error that hides which session failed.
- Do not automatically resume on page load; the user should opt in after seeing what will happen.

**Verify:** E2E seed creates an interrupted manager with interrupted children, dashboard shows the recovery panel, clicking “Resume selected” calls the route, sessions update through SSE or local merge, and the normal composer works afterward.

### 7. Resume Manager And Children As A Group

Make manager recovery coherent without silently doing too much.

Files:
- `packages/daemon/src/session-manager.ts`
- `packages/daemon/src/runner/manager-state.ts`
- `packages/daemon/src/runner/manager.ts`
- Dashboard component from Step 6

Group behavior:
- Resuming a manager rehydrates only the manager handle.
- Resuming a child rehydrates only that child.
- “Resume all” in the flat recovery panel should resume interrupted manager sessions first, then resumable interrupted child sessions.
- A nested “resume all under manager” tree can be added later if multiple interrupted manager groups make the flat list hard to scan.
- The manager state snapshot should include interrupted children and their resumability metadata so the manager can reason about what needs user action.

Manager wake behavior:
- Do not enqueue wake notices for historical child interruptions during manager resume.
- Do enqueue normal future child lifecycle notices after the manager handle is rehydrated.
- If a child is resumed and then reaches `awaiting_input`, the manager receives the same wake path it uses today.

**Verify:** Manager integration test resumes a manager, resumes a child, emits a child `turn_complete`, and asserts the manager receives exactly one lifecycle wake for the new transition.

### 8. Migration And Backward Compatibility

Add a DB migration for the manager message table and decide how old manager sessions behave.

Files:
- `packages/daemon/src/migrations.ts`
- `packages/daemon/src/migrations.test.ts`
- `packages/daemon/src/store.ts`
- `.specs/local-mvp.md`

Migration:
- Add `manager_messages` table and index.
- No destructive rewrite of existing sessions.
- Existing interrupted child sessions with `agent_thread_id` are resumable.
- Existing manager sessions that predate the table are not resumable unless a deliberate one-time import from `~/.helm/logs/<session>.jsonl` is added.

Recommendation:
- Do not import manager messages from existing raw logs in the main migration. The raw log shape is a debug trace and can include sensitive model request content; importing it automatically is surprising.
- Existing manager sessions created before `manager_messages` exists are not resumable as managers. The UI should say “Cannot resume; no manager transcript was persisted” and keep children/worktrees accessible.
- Provide a separate developer-only repair script later if recovering old manager sessions becomes critical, but do not make it part of normal startup.

**Verify:** Migration test creates a DB at the previous schema version, runs migrations, asserts `manager_messages` exists and existing sessions/events remain unchanged.

### 9. Tighten Send, Stop, And Archive Semantics Around Interrupted Sessions

Make lifecycle operations predictable once `interrupted` exists.

Files:
- `packages/daemon/src/session-manager.ts`
- `packages/daemon/src/server.ts`
- `packages/web/src/components/SessionDetail.tsx`

Rules:
- `send(id, text)` on `interrupted` should return `409 session_interrupted` with guidance to resume first.
- `stop(id)` on `interrupted` should convert it to `stopped` without requiring a handle.
- `archive(id)` on `interrupted` should use the same dirty/unshared safety checks as stopped sessions.
- `approveToolCall` and `denyToolCall` on interrupted manager sessions should return `409 session_interrupted`; pending approvals are not valid across daemon death unless they are later persisted explicitly.
- `resume(id)` on `stopped` should return `409 not_resumable` for now.

**Verify:** Unit tests cover each route/method behavior and assert dashboard action availability matches the status.

### 10. Update Tests And Real-Agent Regression Coverage

Cover the durable resume contract at the same layers that currently protect session lifecycle.

Fast tests:
- `packages/daemon/src/store.test.ts`: reconciliation to interrupted.
- `packages/daemon/src/migrations.test.ts`: manager message schema migration.
- `packages/daemon/src/session-manager.test.ts`: resume validation, status transitions, handle recreation.
- `packages/daemon/src/runner/manager.test.ts`: message persistence and resume from persisted messages.
- `packages/daemon/src/runner/normalize.test.ts`: any new event parser expectations.
- `packages/daemon/src/server.test.ts`: resume/dismiss routes and structured errors.
- `packages/web` component or e2e tests: recovery prompt and actions.

E2E:
- Seed interrupted sessions directly in the DB and verify dashboard recovery.
- Use fake runner behavior for deterministic resume.

Real-agent tests:
- Extend `tests/e2e/real-agents.spec.ts` or add a focused test to:
  - start a Codex session, wait for `agent_thread_id`, simulate daemon restart by creating a new `SessionManager` with reconciliation, resume, send a follow-up, and assert the turn completes.
  - do the equivalent for Claude, including a case that resumes after mid-turn death if stream-json resume proves stable enough.

Manager resume tests:
- Seed a manager with persisted `manager_messages` ending in an unbalanced assistant `tool_calls` message.
- Run `resume()`.
- Send a follow-up.
- Assert the fake OpenRouter client receives a valid repaired message body with synthetic interrupted tool results.

Required commands:

```bash
bun run check
bun run test:unit
bun run test:e2e
HELM_REAL_AGENT_E2E=1 bun run test:agents
```

**Verify:** Fast tier passes for every commit; real-agent tier passes before merging because runner adapter behavior changes.

## Considerations

- **Manager transcript authority:** `manager_messages` should be the authoritative manager conversation state. OpenRouter JSONL logs remain useful for debugging but should not be parsed for normal resume.
- **Mid-tool death:** Persist assistant tool-call messages before executing tools and persist each tool result as soon as it completes. If Helm dies mid-batch, resume must repair any unmatched tool calls with synthetic interrupted tool results before the next manager turn.
- **Tool-call repair:** Because OpenAI-compatible chat APIs require every assistant `tool_calls` message to be immediately followed by matching tool-result messages, manager resume must repair unmatched tail tool calls with synthetic interrupted tool results before sending the next request.
- **Pending approvals:** Approval futures are in-memory today. Do not try to resume a pending approval in the first full implementation unless approval requests are also persisted with explicit pending/resolved state.
- **Security:** Manager messages may contain sensitive prompt, file, and tool result data. Keep them in the private local DB only and do not expose raw manager messages through dashboard APIs.
- **Status naming:** `interrupted` is intentionally different from `stopped`; it means “Helm lost the process,” not “the user chose to stop.”
- **Resume without sending:** Some adapters may not support an idle attach process. The session manager can still recreate a logical handle that starts the CLI on the next `send()`; this is enough for dashboard resume semantics as long as status and errors are clear.
- **Old manager sessions:** Existing manager sessions from before this plan are likely not resumable. That is acceptable if the UI says “Cannot resume; no manager transcript was persisted” and keeps children/worktrees accessible.
- **Stopped sessions:** Do not prompt for or resume stopped sessions in this implementation. A future “restart from transcript” feature should be designed separately from interruption recovery.
- **Spec drift:** Update `.specs/local-mvp.md` in the same implementation commit as the lifecycle, schema, API, and dashboard behavior changes. Specifically update the §5.2 status diagram, §7.4 runner resume contract, §7.5 manager transcript behavior, and §11 route table for resume and dismiss-interruption.
