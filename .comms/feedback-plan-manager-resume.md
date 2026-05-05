# Feedback on `.context/plan-manager-resume.md`

Reviewer: Claude (Opus 4.7)
Date: 2026-05-04

Overall the plan is well-scoped and the staging is right: introduce the `interrupted` lifecycle state, bolt resume semantics onto the runner contract, persist the manager's conversation, then expose it. A few correctness concerns and ambiguities are flagged below in priority order.

---

## 1. Blocker: assistant tool-call messages can leave the manager log malformed for OpenRouter

Step 3 says:

> Persist assistant messages immediately after receiving an OpenRouter response and before executing tool calls.
> Persist tool result messages immediately after each tool result is produced.

OpenAI/OpenRouter chat APIs require that every `assistant` message containing `tool_calls` be followed *immediately* by `role: "tool"` messages with matching `tool_call_id`s, before any subsequent `user`/`assistant` message. (`packages/daemon/src/runner/manager.ts:189-205` is what produces these turns today.)

If Helm dies between persisting the assistant tool-call message and persisting all of its results, the next request on resume will be `system, …, user, assistant{tool_calls=[A,B]}, user{state snapshot}, …` — which OpenRouter will reject with a 400.

The Considerations note ("If Helm dies mid-batch, resume will include completed tool results and omit incomplete ones; the next manager turn can reason from current child/session state") underestimates this — it isn't a soft loss-of-fidelity, it breaks the next request.

**Suggested fix.** Pick one and write it into Step 3:

- On `loadManagerMessages`, walk the tail. If the last assistant message has unmatched `tool_call_id`s, synthesize a `tool` message for each missing id with `{ ok: false, errorMessage: "interrupted" }` before returning. This is the cheapest fix and matches the existing "denied" tool-result shape.
- Or: persist the assistant message + its tool result batch transactionally (only after all results are available). This loses the ability to recover *partial* batches but keeps the log strictly consistent.

The first is preferable because it also handles approval mode dying mid-await (no result yet for a pending call).

## 2. Blocker: `getActiveManagerSession()` change is required, not optional

Step 1 says singleton-manager checks should include interrupted managers. The current query is in `packages/daemon/src/store.ts:101-103`:

```sql
WHERE manager_mode IS NOT NULL AND status IN ('created', 'running', 'awaiting_input')
```

Without adding `'interrupted'`, the user can create a *second* manager after a daemon restart (because the old one is now `interrupted`, which the query does not match). That violates §7.5 "at most one non-archived manager session" the moment the new state ships. Make this a required edit in Step 1, not a side note in the Behavior bullet.

Same issue applies to `nested_manager_forbidden`/`parent_not_manager` checks on `create()` (`session-manager.ts:88-101`) — they look at the parent's `manager_mode`, which is fine, but the children-of-interrupted-manager case is implicitly covered. Worth a sentence so reviewers don't have to re-derive it.

## 3. Blocker: Codex resume requires a prompt; "idle attach" path is not specified

`packages/daemon/src/runner/codex.ts:36`:

```ts
const cmd = resumeThreadId
  ? [this.opts.command, "exec", "resume", resumeThreadId, "--json", ...this.opts.extraArgs, prompt]
  : [this.opts.command, "exec", "--json", ...this.opts.extraArgs, prompt];
```

`codex exec resume <id> --json ""` will pass an empty positional prompt to the Codex CLI, which is not documented to be a no-op. The Codex docs (developers.openai.com/codex/cli/reference, codex-rs README) describe `codex exec resume <id> --json "<follow-up>"` as a one-shot turn — there is no idle-attach.

Step 2 hand-waves this: "If Codex cannot start a no-op resumed process, `SessionManager.resume()` may recreate a handle object that spawns only on the next `send()`. That handle must still be present in the `handles` map so the dashboard can send."

This is the right answer, but the plan should commit to it explicitly:

- For Codex, `resume()` constructs a `CodexRunnerHandle` *without spawning a process*; it just primes `this.threadId = session.agent_thread_id` and waits for `send()` to call `spawnTurn(text, threadId)`.
- That implies `pid = 0` (or null) on resume — make sure Step 1's "Resume must update `pid` after spawning" reads correctly (i.e. `pid` is updated on the next `send`, not on `resume`).

While here: the existing `pendingFollowUp` path in `codex.ts:54-60` is an awkward second resume mechanism. After this plan lands it's dead code; recommend Step 2 also remove it to keep the adapter readable.

## 4. Caveat: Claude `--resume` + `--input-format stream-json` has a known upstream bug

GitHub issue [`anthropics/claude-code#16712`](https://github.com/anthropics/claude-code/issues/16712) ("Allow providing tool_result via stdin when resuming session with pending tool_use") describes the CLI synthesizing a "No response requested" message when resuming a session whose last persisted state was a pending tool_use. For Helm child sessions this should be rare (we end turns at `type=result`), but it can happen if the daemon dies mid-turn while a tool is still resolving. Step 2's "Verify" and Step 10's real-agent test should cover specifically *resume after mid-turn death*, not just resume after a clean `awaiting_input`.

If that path is unstable, the fallback is the same as Codex: `resume()` builds a handle but does not spawn until `send()`. Worth scoping in Step 2.

## 5. Resume status semantics are ambiguous

Step 4 recommends `awaiting_input` after resume "for simplicity," but Step 9 says `send(id, text)` on `interrupted` should 409. After resume, the session is no longer interrupted, so `send` should work — but the dashboard distinction between "interrupted, click Resume" and "awaiting_input, type a message" depends on this. Two follow-ups:

- Confirm in Step 4 that resumed sessions transition `interrupted -> awaiting_input` (not back to `running`) so the existing UI affordances Just Work.
- Note that for the manager, if it had pending wakes when the daemon died, those are lost on resume by design (Step 7 calls this out for *historical* wakes). That's probably right, but Step 4's "Recommended status after resume" should also say: do not auto-`kick()` the manager loop on resume — wait for either a new user message or a future child lifecycle event.

## 6. The manager's event-bus subscription is reattached at construction — confirm no leak

`ManagerRunnerHandle` constructor subscribes to `ctx.manager.subscribe(...)` (`runner/manager.ts:62`) and unsubscribes only in `stop()`. On resume, `SessionManager.resume()` will construct a fresh handle, which subscribes. Two things to verify in the plan:

- The previous handle's `stop()` was called during normal `interrupted` transition (it wasn't — the daemon died), so its subscription leaked. That leak is inert because the previous `EventBus` instance also died with the process, but worth a sentence saying "no cleanup needed on resume because the prior bus is gone."
- If the user calls `resume()` twice in a row (no-op the second time per the early-return at `if (this.handles.has(id)) return session`), good — but make this explicit in Step 4 since the `Verify` calls don't exercise it.

## 7. Step 3 schema: index column order won't help replay

```sql
CREATE INDEX idx_manager_messages_session_id_id ON manager_messages(session_id, id);
```

This is fine, but since `id INTEGER PRIMARY KEY AUTOINCREMENT` already gives you a B-tree on `id`, and replay reads `WHERE session_id = ? ORDER BY id`, the composite index is the right choice. No change — just noting the rationale should be one line in the plan so it isn't questioned in review.

Also: `payload TEXT NOT NULL` stores the serialized `ManagerChatMessage`. Since `tool_calls` is an array, document the JSON shape in the spec section so future migrations don't have to spelunk through `runner/openrouter.ts`. The plan currently says "load ordered messages and initialize `this.messages` from the stored payloads" — explicit about column → field mapping (`role` column vs. role inside payload — pick one, don't store both) prevents a class of bug.

Recommendation: store the *whole* `ManagerChatMessage` JSON in `payload` and drop the `role` column, or use `role` as the index/filter and treat `payload` as the source. Don't store role twice.

## 8. Resume errors: `409 missing_thread_id` exists today only as an exception string

Step 5's structured error list (`409 missing_thread_id`, `409 missing_worktree`, `409 missing_manager_transcript`) is good, but `server.ts:28-30` currently catches a hard-coded list of error message strings and converts them. The plan should either:

- Keep extending that allowlist (cheap, ugly), or
- Introduce a typed error class similar to `ArchiveSafetyError` (cleaner, fits existing pattern).

Recommend the latter since you're already adding several codes at once.

## 9. Spec drift: `interrupted` needs to land in the `SessionStatus` ASCII diagram in `.specs/local-mvp.md` §5.2

The plan mentions updating `.specs/local-mvp.md` in Steps 1, 3, 5, 8, but it should specifically call out:

- §5.2 status transition diagram (currently lines 192-202) needs an `interrupted` branch and a `interrupted ──user resume──▶ awaiting_input` arrow plus `interrupted ──user dismiss──▶ stopped`.
- §7.4 `RunnerAdapter` contract should describe `resumeThreadId` semantics for *no initial prompt*, since Step 2 changes the contract.
- §11 routes table needs `POST /sessions/:id/resume` and `POST /sessions/:id/dismiss-interruption`.

## 10. Smaller notes

- Step 2 says "Resume should not emit a duplicate `session_started` event." — already true for free, since `session_started` is emitted in `SessionManager.create()` (`session-manager.ts:139-145`), not by adapters. Note this rather than implying adapter changes are needed.
- Step 4's API shape uses `["interrupted", "stopped"].includes(session.status)`. Consider also allowing `awaiting_input` to be a no-op (idempotent) instead of throwing — useful when the dashboard click-spams Resume. The plan's `if (this.handles.has(id))` early return covers this once a handle exists, but not the race window before it.
- Step 6's "Group child sessions under their manager" UX is the right call but adds non-trivial state to the dashboard — flag this as the most expensive piece in this plan and worth a separate spike.
- Step 8: agree with not auto-importing `~/.helm/logs/<id>.jsonl`. The OpenRouter request log embeds full system prompts and file contents, and round-tripping it back into `manager_messages` would silently re-introduce content the user may have wanted purged. Mention this rationale in the spec, not just in the plan.
- Step 9: for `archive(id)` on `interrupted`, the current `archive()` (`session-manager.ts:227-244`) calls `provider.fromSession` and `provider.assertRemoveSafe` — these don't depend on the runner handle, so this should already work. One-liner test rather than implementation.

## 11. Test coverage gap

Step 10 lists fast tests well, but the real-agent regression test only covers Codex/Claude, not the manager. Manager resume is the largest behavior change in this plan; please add at least one test that:

- Seeds a manager with persisted `manager_messages` ending in an unbalanced assistant `tool_calls`,
- Runs `resume()`,
- Asserts the next `send()` produces a valid OpenRouter request body (matches issue (1) above).

A unit test against a fake `ManagerChatClient` that captures the messages array on the first `chatCompletion` call is enough.

---

## Summary

The plan is sound and the layering is right. The three blockers above (manager log well-formedness on partial-batch death, singleton-manager query, Codex idle-attach behavior) are all small fixes once acknowledged but will cause production-visible bugs if shipped as written. The remaining notes are mostly clarifications for the spec and reviewers.

Sources:
- [Codex CLI command-line options](https://developers.openai.com/codex/cli/reference)
- [Codex non-interactive mode docs](https://developers.openai.com/codex/noninteractive)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [`claude-code#16712` — resume + stream-json tool_use bug](https://github.com/anthropics/claude-code/issues/16712)
- [`claude-code#24594` — `--input-format stream-json` undocumented](https://github.com/anthropics/claude-code/issues/24594)
