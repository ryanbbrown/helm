# Codex Adversarial Review - 2026-05-04

**Target:** uncommitted working tree diff for durable session resume
**Verdict:** needs-attention

This review focuses on failure modes around resume correctness, manager transcript validity, and runner lifecycle races. `bun run check` and `bun run test:unit` passed, so the concerns below are behavioral gaps rather than typecheck failures.

## Findings

### [high] Manager user messages can be persisted in an invalid OpenRouter order

**Location:** `packages/daemon/src/runner/manager.ts:83-85`, `packages/daemon/src/runner/manager.ts:157-207`

`send()` now appends the explicit user message to `this.messages` immediately, before the manager turn queue drains it. If the manager is already inside `runOneTurn()`, especially while waiting on approval for assistant tool calls, a user message can be inserted between an assistant message with `tool_calls` and the required following `tool` messages.

OpenAI-compatible chat APIs require assistant tool-call messages to be followed by matching tool result messages before any later user or assistant message. This race can make the next OpenRouter request invalid even though the persisted transcript looks append-only.

**Recommendation:** Queue explicit user text in `send()`, but append it to `this.messages` only inside `runTurnQueue()` when `userMessages` are drained. Preserve the current durable persistence behavior by appending each drained user message just before the state snapshot for that turn. Add a test where a manager is waiting on an approval-mode tool call, `send()` is called before approval, and the final message order remains `assistant(tool_calls)`, `tool`, then later `user`.

### [high] Repaired manager tool-call tails are not persisted

**Location:** `packages/daemon/src/store.ts:127-133`, `packages/daemon/src/store.ts:162-187`

`listManagerMessages()` repairs a dangling assistant tool-call tail in memory by appending synthetic `{ ok: false, errorMessage: "interrupted" }` tool messages. That protects the first resumed request, but those synthetic tool messages are never written back to `manager_messages`.

After resume appends new user/state/assistant rows, a later resume can encounter the same dangling assistant tool-call message followed by non-tool messages. At that point `repairManagerMessageTail()` returns the transcript unchanged because `following.some((message) => message.role !== "tool")` is true, leaving the durable transcript invalid.

**Recommendation:** Make repair durable before any resumed manager appends new messages. One simple shape is a store method that loads messages, inserts missing synthetic tool rows when needed, then returns the repaired list. Add a regression test for resume, send, stop or restart, and resume again with the same transcript.

### [medium] Codex follow-up sends can fail before `thread.started`

**Location:** `packages/daemon/src/runner/codex.ts:53-59`, `packages/daemon/src/session-manager.ts:250-257`

The prior `pendingFollowUp` behavior was removed. Now `CodexRunnerHandle.send()` throws `missing_resume_thread` if the user sends a follow-up before Codex emits `thread.started` and `agent_thread_id` is captured.

That race can happen immediately after creating a Codex session. `SessionManager.send()` persists a `user_message` before calling `handle.send()`, so the failed follow-up remains in the visible timeline even though it was not delivered to Codex.

**Recommendation:** Restore a single pending-send path for the "thread id not known yet" case, or block sends until the session has an `agent_thread_id`. If the latter is chosen, avoid persisting the user message until delivery is possible. Add a Codex adapter test for send-before-thread-start.

### [medium] Resumed child sessions are not tested through the next send

**Location:** `packages/daemon/src/session-manager.test.ts:34-69`

The Codex resume test verifies lazy handle creation and `session_resumed`, but it does not call `send()` after resume or assert that the command becomes `codex exec resume <thread> --json ... <text>`. That leaves the primary resume contract untested.

Claude resume also changed command construction, but there is no command-level test asserting `--resume <thread>` placement, and no real-agent coverage is shown here despite runner adapter changes falling under the repo's slow-tier requirement.

**Recommendation:** Add adapter-level tests that capture Codex and Claude spawn command arrays for resumed turns. For this change set, run `HELM_REAL_AGENT_E2E=1 bun run test:agents` before claiming the runner behavior is done.

### [medium] Claude resume eagerly starts a process with no resume prompt

**Location:** `packages/daemon/src/runner/claude.ts:7-22`, `packages/daemon/src/session-manager.ts:212-225`

Codex resume is lazy when no prompt is present, but Claude resume starts immediately with `--resume <thread>` and no stdin message. If Claude exits quickly, blocks oddly, or mishandles stream-json resume after a mid-turn interruption, Helm will still patch the session to `awaiting_input` with a handle that may already be dead or unreliable.

**Recommendation:** Either verify this exact flow in real-agent tests, including mid-turn interruption, or make Claude resume lazy like Codex: rehydrate the handle, set `awaiting_input`, and spawn only when the next user message arrives.

## Cleanups

- Consider replacing the hard-coded error string allowlist in `packages/daemon/src/server.ts` with a typed route error for resume errors. The current list is getting long and makes status mapping easy to drift.
- Consider exposing a narrow store method for manager transcript repair rather than hiding mutation-relevant behavior behind a method named `listManagerMessages()`.
- Remove the unused return value from `executeToolBatch()` if callers never consume the accumulated result messages.

## Verification Run

- `bun run check` - passed
- `bun run test:unit` - passed

## Next Steps

1. Fix manager message ordering and durable tail repair first; those are the highest-risk correctness bugs.
2. Restore or replace Codex's send-before-thread-start behavior.
3. Add resumed-send tests for Codex and Claude command construction.
4. Run the slow real-agent suite for the runner adapter changes.
