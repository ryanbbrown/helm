# Helm — Agent Working Rules

This file is the canonical guidance for any coding agent (Claude Code, Codex, etc.) making changes to this repo. Read it before opening files; follow it before claiming a change is done.

The rules exist for one reason: **the human user should not have to manually verify functionality.** Tests do the verifying. If you skip a test or weaken one to ship, you've moved the verification burden back to the human.

## 1. Required verification before claiming "done"

Run these commands locally before reporting any code change as complete. All must pass. Do not skip any of them with the assumption that "the change is small."

| Command | Required for |
|---|---|
| `bun run check` | Every change. Typechecks all packages. |
| `bun run test:unit` | Every change. |
| `bun run test:e2e` | Any change in `packages/daemon/`, `packages/cli/`, `packages/web/`, or anything that affects HTTP routes, SSE event shape, the dashboard, or session lifecycle. |
| `bun run test:agents` | Any change in `packages/daemon/src/runner/` (Claude or Codex adapters), or anything that could affect what flags we pass to the agent CLI or how we parse its output. Requires `HELM_REAL_AGENT_E2E=1`. |

If a command fails, fix the underlying issue. Do not `.skip()`, `.only()`, or weaken assertions to make a test pass. If a test is genuinely wrong (rare), fix the test in its own commit with a clear message explaining why.

If the change is type-safe and test-covered but the change you made depends on `~/.helm/state/helm.db` having a particular schema, also delete that database first (`rm ~/.helm/state/helm.db`) and re-run the e2e suite to confirm fresh-install works. Schema migrations are silent footguns; the only way to catch them is to actually try a fresh DB.

## 2. What kind of test does each change need?

Decision table. If you can't find a row that matches your change, add one to this doc as part of the same commit.

| Change | Required test |
|---|---|
| New HTTP route | Unit test of the route handler logic if non-trivial; **e2e test** that exercises it via the dashboard or CLI-over-HTTP. |
| New SSE event name or payload | Unit test for the serializer; e2e test that confirms the dashboard receives and renders (or correctly suppresses) it. |
| New normalized event kind | Unit test in `packages/daemon/src/runner/normalize.test.ts` (or equivalent) covering the parser; e2e test confirming UI surfaces or suppresses it per the spec. |
| New `Session` lifecycle transition | Integration test in `session-manager` using a fake runner adapter; e2e test if the transition is user-triggerable. |
| New CLI subcommand | Unit test for the command's local-mode behavior; if it talks to the daemon, e2e test through the daemon. |
| Change to runner adapter (Claude / Codex) | Update `packages/daemon/src/runner/normalize.test.ts` fixtures; **must** run `test:agents` and confirm both agents still complete a turn. |
| Change to git operations | Integration test against a temp git repo seeded with at least one commit. **Do not mock git.** |
| Change to SQLite schema | Migration test: create a DB at the previous schema version, run the migration, assert columns/rows. |
| Change to auth (token, origin allowlist) | Unit test for accepted vs rejected requests. Cover: missing token, wrong token, disallowed origin, valid token + allowed origin. |
| Workspace provider implementation | Integration test against a real worktree (for local) or a faked backend (for cloud). The provider's `assertRemoveSafe` is its own sub-test (dirty tree, unshared commits, both, neither). |
| Spec change (`.specs/local-mvp.md`) | Spec change must land in the same commit as the code that implements (or removes) the behavior. No drift commits. |
| Forward-compat doc change (`.plans/forward-compat.md`) | No test required, but the doc must be updated when its referenced files or line numbers move. |

## 3. Forbidden test shortcuts

These produce green CI and broken production. Don't do them.

- **Do not mock the database.** Use `mkdtempSync` to spin up a fresh SQLite file per test.
- **Do not mock git.** Tests that touch git operations create a real temp repo with one commit. The `tests/fixtures/` and existing helpers in `tests/e2e/` show the pattern.
- **Do not mock the HTTP layer in e2e tests.** Playwright drives the real daemon.
- **Do not mock the runner adapter's external interface.** Use the `FakeRunnerAdapter` (see §4) when you need deterministic event flow without spawning a real LLM.
- **Do not skip a real-agent test "for now."** If it's flaking, fix the source of flake (timeout, race, ordering). If a real agent's behavior changed, update the test to match the new contract — and update the spec if the change is actually a contract change.
- **Do not write a test that depends on wall-clock time** unless the implementation under test does. Time-based assertions belong inside helpers that can be controlled deterministically.

## 4. The fake runner adapter

For session-manager / lifecycle / event-flow tests that should not depend on a real LLM, use the fake adapter (or write one if it doesn't yet exist) at `packages/daemon/src/runner/fake.ts`. The fake adapter implements `RunnerAdapter` from `runner/types.ts` and emits a scripted sequence of normalized events on demand.

Tests that must depend on a real LLM (the per-agent regression tests in `tests/e2e/real-agents.spec.ts`) are the only place real `claude` / `codex` processes are spawned. Keep that boundary clean.

## 5. Real-agent tests are the regression net for agent CLI drift

`tests/e2e/real-agents.spec.ts` is the only test that catches:

- A new Claude or Codex CLI version changing flag names.
- A new event-stream shape or new event type.
- A new failure mode that our normalizer doesn't handle.
- A regression in our adapter's stdin handling or resume flow.

Therefore:

- Do not weaken the assertions in this file.
- When you add an event kind, transition, or auth path that the real-agent flow exercises, **extend the file with a case that covers it**, even if the fast tier already passes.
- The fast tier (`test:unit` + `test:e2e` against the dashboard with a fake-or-real-but-not-required agent) is necessary but not sufficient. It does not substitute for real-agent regression coverage.

## 6. The "fast tier" vs "slow tier" model

| Tier | Commands | When |
|---|---|---|
| **Fast** | `bun run check` + `bun run test:unit` + `bun run test:e2e` | Every change. CI runs these on every push. |
| **Slow** | `bun run test:agents` (real agents) | Before merging any change touching runners, stream parsing, prompt delivery, or anything that could change what we tell the agent or how we read its output. |

Fast tier should complete in under ~60 s on a developer machine. If it grows past that, split it.

## 7. Commits

- Tests live in the same commit as the change they cover. No "tests will follow" commits.
- Conventional-commits style: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`. Scope optional in parens.
- Every commit's working tree must pass the fast tier. If it doesn't, the change isn't done — it's in progress.

## 8. What NOT to test

- Private methods, internal SQL strings, library internals (Bun, sqlite, Next.js).
- Specific log messages (assert behavior, not phrasing).
- Implementation details that the spec doesn't require (e.g., the exact ULID format).

Test the contract in the spec (`.specs/local-mvp.md`), not the implementation.

## 9. When the rules conflict with the spec

The spec wins. If you find behavior the spec mandates that the code doesn't do, the code is wrong; if you find behavior the code does that the spec doesn't mandate, the spec is incomplete. Either fix the code, or update the spec — in the same commit as the change.

If a change implies a spec update, do not land the code change without updating the spec. Drift is the most expensive bug class in this repo.

## 10. Reference materials

- Spec: `.specs/local-mvp.md` — the authoritative contract.
- `.specs/` is normative; keep only the active contract there, currently `.specs/local-mvp.md`.
- `.plans/` is execution strategy and roadmap material; useful context, but allowed to become stale after implementation.
- `.comms/` is communication artifacts such as reviews, handoffs, and agent-to-agent notes.
- `.context/` is non-normative background such as product briefs, research, comparisons, and evaluations.
- Forward-compat plans: `.plans/forward-compat.md` — what's planned next; obey priority order.
- Reference implementations (read-only):
  - `references/conductor-oss/` — bridge/relay patterns, agent adapters, dashboard idioms.
  - `references/symphony/` — orchestrator daemon, task-board model.
  - `references/code-conductor/` — bash worktree management.
  - `references/1code/`, `references/agent-orchestrator/`, `references/maestro/`, `references/nimbalyst/` — comparable agent orchestration products.

These are submodules. Do not edit them; they are external reference only.
