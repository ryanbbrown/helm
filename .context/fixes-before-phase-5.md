# Helm — fixes to land before phase 5

Context: phases 0-4 of `.context/plan-helm-mvp.md` are implemented. This file lists issues identified during a review of that implementation that should be fixed **before** building further on top, either because they are hard to reverse later or because they will produce confusing bugs during real-world testing.

Spec: `.specs/local-mvp.md`. Plan: `.context/plan-helm-mvp.md`.

## Priority 1 — hard-to-reverse design issues

### 1.1 Split `stop` and `archive` into distinct statuses

**Files:** `packages/daemon/src/session-manager.ts:120-148`, `packages/core/src/session.ts:3-9`, `packages/daemon/src/store.ts:71`, `packages/web/src/app/page.tsx` (anywhere status is rendered/filtered).

**Problem:** Both `stop()` and `archive()` set `status: "archived"`. The list endpoint hides archived sessions, so a stopped session disappears from the dashboard. There's no way to see "agent is no longer running but I might want to revisit / resume" vs "remove from view permanently."

This contradicts spec §5.2 and §6.2-6.4 which treat `stop` as ending execution while keeping the session visible (worktree intact), and `archive` as the explicit "remove" that also tears down the worktree.

**Fix:**
- Add `"stopped"` to the `SessionStatus` union in `core/src/session.ts`.
- `SessionManager.stop()` → `status: "stopped"`, keep worktree.
- `SessionManager.archive()` → `status: "archived"`, remove worktree + branch (already does this).
- `Store.listSessions(includeArchived)` filters out only `archived`; stopped sessions remain visible.
- Update the dashboard so a stopped session can be archived from the UI without first being something else.

**Why now:** UI logic and downstream tooling will accumulate "if status === archived" branches. Splitting later means a DB migration plus UI sweep.

### 1.2 Encapsulate `Store` and `EventBus` inside `SessionManager`

**Files:** `packages/daemon/src/session-manager.ts:25-26` (the public `readonly store` and `readonly bus`), `packages/daemon/src/server.ts:54,94,104,108,111` (consumers).

**Problem:** The HTTP server reaches directly into SQLite (`manager.store.listEvents(...)`) and the in-memory bus (`manager.bus.subscribe(...)`). This couples the transport layer to the persistence and pub/sub internals. Replacing SQLite, adding a durable event log, or running multiple daemon instances later all require touching the server.

**Fix:**
- Add `listEvents(sessionId: string, afterId?: number): SessionEvent[]` to `SessionManager`.
- Add `listAllEvents(afterId?: number): SessionEvent[]` to `SessionManager`.
- Add `subscribe(listener: (event: BusEvent) => void): () => void` to `SessionManager`.
- Make `store` and `bus` `private`.
- Update `server.ts` to call manager methods only.

This is a small, mechanical refactor (~30 lines of moves) but it locks in a clean boundary before more endpoints get added.

### 1.3 Authenticate the daemon and remove wildcard CORS

**File:** `packages/daemon/src/server.ts:83-89` (CORS), `packages/daemon/src/server.ts:7-21` (request router has no auth at all).

**Problem:** This is the most serious issue in the codebase. The daemon is a **local code-execution control plane** — it can spawn arbitrary configured agents (`claude --dangerously-skip-permissions`, `codex --yolo`) inside the user's repos. The router has no authentication, and `Access-Control-Allow-Origin: *` is set on every response. Because the daemon binds to `127.0.0.1:7878`, network attackers can't reach it — but **any webpage open in the user's browser can**. Any tab the user visits can:
- `POST /sessions` to start a coding agent against any configured repo with any prompt.
- Read `/config` to enumerate repos and agents (and absolute filesystem paths — see 1.4).
- Stream `/sessions/:id/events` to read agent output.
- `POST /sessions/:id/stop` and `/archive` to tamper with running work (and 1.5 makes archive destructive).

Loopback binding does not protect against this: browsers happily make CORS requests to `localhost:7878`, and the wildcard explicitly allows them. This is functionally equivalent to a remote code execution surface for any malicious or compromised webpage.

**Fix:**
- Generate a per-daemon-startup secret token (e.g. 32 random bytes hex). Store it at `~/.helm/state/token` with `0600` perms.
- Require the token on every endpoint except `/health`. Accept it via `Authorization: Bearer <token>` header **or** a `?token=<token>` query string (needed for `EventSource` SSE which can't set headers).
- The dashboard reads the token from a daemon-served bootstrap that requires same-origin only (or, simpler: have `helm daemon start` print the dashboard URL with `?token=...` already embedded, and have the Next.js app read it from `window.location` on first load and stash in memory).
- Replace `Access-Control-Allow-Origin: *` with an explicit allowlist (default `http://localhost:3000`, configurable via env). Reject requests whose `Origin` is not on the allowlist.
- The CLI's `DaemonClient` reads the token from `~/.helm/state/token` and includes it on every request.
- `OPTIONS` preflight: respond with allowlisted methods/headers; do not echo arbitrary `Origin` back.

This is more involved than just changing the CORS header, but the daemon's blast radius makes a token mandatory before anything ships.

### 1.4 Make `archive` non-destructive by default

**Files:** `packages/daemon/src/git.ts:25-33` (`removeWorktree` and `deleteBranch`), `packages/daemon/src/session-manager.ts:135-148` (`archive`), `packages/web/src/app/page.tsx` (the archive button has no confirm dialog).

**Problem:** `archive()` calls `git worktree remove --force` followed by `git branch -D`. There is **no check for**:
- Uncommitted/unstaged changes in the worktree (`git status --porcelain`).
- Commits on the session's branch that are not reachable from any other branch (i.e. would be lost on `branch -D`).
- Whether the branch has been pushed upstream.

In this product the worktree contents *are* the agent's output — the entire reason to use Helm. A normal "archive" click on a session whose work hasn't been merged or pushed permanently destroys that work, with no recovery path. The dashboard archive button has no confirmation dialog, so this is a single-click data-loss surface.

**Fix:**
- Before destructive operations in `archive()`, run safety checks:
  - `git -C <worktree> status --porcelain` → if non-empty, refuse without explicit `force: true`.
  - `git -C <repo> log <branch> --not --branches --not --remotes --oneline` → if any commits are unreachable from other refs, refuse without explicit `force: true`.
- Extend the `archive(id)` API to accept `{ force?: boolean }`. The daemon route accepts `?force=1`. The CLI grows `helm session archive <id> --force`. The dashboard prompts when the safety check fails and only sets `force=true` after a confirm dialog that names what will be lost.
- Default UI affordance: the archive button issues `archive(id)` without force; if the daemon rejects with a structured `409 dirty_worktree` / `409 unpushed_commits` response, the UI shows a confirm dialog with the specifics.
- Tests: add cases for dirty-worktree and unpushed-commit refusal, and for force-archive removing them only when explicitly requested.

### 1.5 Stop sending absolute filesystem paths to the browser

**Files:** `packages/daemon/src/server.ts:34-36`, `packages/daemon/src/session-manager.ts:93-95` (`getConfig`), `packages/web/src/lib/api.ts:10-18`, `packages/web/src/app/page.tsx:48-51`.

**Problem:** The `/config` endpoint returns the full `HelmConfig` including each repo's absolute `path`. The dashboard only uses `name`. Sending `path` is an unnecessary information leak (paths reveal the user's directory structure and username) and once the dashboard starts depending on `path`, trimming it later becomes a breaking change.

**Fix:**
- In the server's `/config` route (or in a new `getPublicConfig()` method on `SessionManager`), return only `{ repos: [{name}], agents: [{name, headless_mode}] }` — drop `path`, `default_branch`, `command`, `args`.
- Update `web/src/lib/api.ts` `HelmConfig` type to match the trimmed shape.
- Confirm the dashboard still renders selectors correctly.

## Priority 2 — reliability bugs that will surface during real testing

These are not architecturally hard to fix later, but they will produce confusing failures during normal use, so doing them now saves debugging time.

### 2.1 JSONL parser dies on a single bad line

**File:** `packages/daemon/src/runner/jsonl.ts:33-38`.

**Problem:** `JSON.parse(trimmed)` throws on any non-JSON line. The throw rejects the outer promise in `readJsonLines`, which is caught and pushed as a single `error` event. The for-await loop then exits, so no further events are processed for that session — even though the agent process is still running and emitting valid lines after the bad one.

Real agents will eventually emit a non-JSON line (a debug print, a partial line at process exit, a stderr-ish message that ended up on stdout).

**Fix:**
```ts
function parseLine(line: string, onValue: JsonLineHandler): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  try {
    onValue(JSON.parse(trimmed));
  } catch {
    // Log and skip; do not kill the stream.
    console.warn(`helm: skipped non-JSON agent output: ${trimmed.slice(0, 200)}`);
  }
}
```

### 2.2 SSE replay-then-subscribe race

**File:** `packages/daemon/src/server.ts:91-115` (both `sessionEventsStream` and `sessionStream`).

**Problem:** The server first replays events from the store, then subscribes to the bus. An event published between those two operations is missed by this connection.

```ts
// Current order — racy:
for (const event of manager.store.listEvents(sessionId, afterId)) send("event", event);
return manager.bus.subscribe(...)
```

**Fix:** subscribe first into a buffer, then replay, then drain the buffer (deduping against replay's last id):

```ts
function sessionStream(manager, sessionId, afterId) {
  return sse((send) => {
    const buffer: SessionEvent[] = [];
    let replaying = true;
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === "event" && event.event.session_id === sessionId) {
        if (replaying) buffer.push(event.event);
        else send("event", event.event);
      }
      if (event.type === "session" && event.session.id === sessionId) {
        send("session", event.session);
      }
    });
    let lastSentId = afterId;
    for (const event of manager.listEvents(sessionId, afterId)) {
      send("event", event);
      lastSentId = event.id;
    }
    replaying = false;
    for (const event of buffer) if (event.id > lastSentId) send("event", event);
    return unsubscribe;
  });
}
```

Apply the same pattern to `sessionEventsStream`.

### 2.3 `pid` is cleared on `turn_complete`, but Claude's process is still alive

**File:** `packages/daemon/src/session-manager.ts:177-178`.

**Problem:** `turn_complete` sets `pid: null`. For Codex this is correct (the exec process exits after the turn). For Claude the process stays alive across turns waiting for stdin — clearing pid is misleading and breaks any future logic that uses pid as a liveness signal.

**Fix:**
```ts
} else if (event.kind === "turn_complete") {
  this.patch(id, { status: "awaiting_input" });
  // Do not clear pid; clear it on `exit` only.
}
```

The existing `handleExit` already nulls pid on actual exit (lines 188-200), so this change is safe.

### 2.4 Codex `send()` throws if `thread.started` hasn't arrived yet

**File:** `packages/daemon/src/runner/codex.ts:52-58`.

**Problem:** A user follow-up arriving before the first `thread.started` event throws `"Codex thread id is not available yet"`. Unlikely but possible during fast turns or if upstream Codex changes ordering.

**Fix:** queue the pending follow-up until threadId is available:

```ts
private pendingFollowUp: string | null = null;

async send(userText: string): Promise<void> {
  const threadId = this.threadId ?? this.opts.resumeThreadId;
  if (!threadId) {
    this.pendingFollowUp = userText;
    return;
  }
  this.spawnTurn(userText, threadId);
}

// In handleEvent, when thread.started captures threadId:
if (event.type === "thread.started" && threadId) {
  this.threadId = threadId;
  this.opts.onThreadId?.(threadId);
  if (this.pendingFollowUp) {
    const text = this.pendingFollowUp;
    this.pendingFollowUp = null;
    this.spawnTurn(text, threadId);
  }
  return;
}
```

### 2.5 Stray `thinking` events from empty Claude assistant blocks

**File:** `packages/daemon/src/runner/claude.ts:79-87`.

**Problem:** When Claude emits an `assistant` event whose content is only a `tool_use` block (no text), `extractClaudeAssistantText` returns `""`. The current code then pushes a `thinking` event if `!emittedAssistantThisTurn`. But mid-turn, after we've already emitted real assistant text, an empty block can still trigger `thinking` because the `else if` is gated only on `emittedAssistantThisTurn` (which is true) — wait, re-check: actually the `else if (!this.emittedAssistantThisTurn)` does correctly suppress it once we've emitted. The real issue is the *first* empty block of a turn always pushes `thinking`, even if the agent is mid-tool-use after the user prompt. That's mostly fine but produces a `thinking` indicator that flickers in the UI.

**Fix:** only emit `thinking` once per turn (track separately), and only on the *first* event of a turn rather than on any empty-text assistant block.

```ts
private emittedThinkingThisTurn = false;
// ...
if (event.type === "assistant") {
  const text = extractClaudeAssistantText(value).trim();
  if (text) {
    this.queue.push({ kind: "assistant_message", text });
    this.emittedAssistantThisTurn = true;
  }
  return;
}
// Move thinking to a one-shot per turn, e.g., emit on first non-system event after a user send.
```

If this turns out to be tricky to get right, the safest minimal fix is: emit `thinking` exactly once per turn, on the first `assistant` event regardless of content, then never again until `result`.

### 2.6 Remove unused event kinds from the union

**File:** `packages/core/src/events.ts:35-44`, `packages/core/src/events.ts:1-10`.

**Problem:** `tool_use` and `tool_result` are declared in `SessionEventKind` and `NormalizedEvent`, but no runner emits them and no UI surface consumes them. Dead surface area.

**Fix:** delete the `ToolUseEvent` and `ToolResultEvent` types and remove `tool_use`/`tool_result` from `SessionEventKind`. Verify with `bun run check` that nothing references them.

## Out of scope for this batch (defer)

These are flagged but should NOT be done as part of this work — keep changes contained.

- Tmux durability (sessions surviving daemon restarts).
- Agent CLI version pinning + drift detection.
- Auto-archive policy for completed sessions.
- Branch push on archive.
- Manager-level chat across sessions.
- Multi-session detail / dashboard layouts.

## Validation after fixes

Required:
- `bun run test:unit` passes.
- `bun run test:e2e` passes.
- Manually drive one session per agent against `test-repo-1`:
  - Create with an initial prompt, see assistant message stream.
  - Send a follow-up, see second assistant message.
  - Stop → status = `stopped`, session still visible in list.
  - Archive on a clean session → status = `archived`, worktree gone, session hidden.
  - Archive on a dirty worktree → daemon refuses without `--force`; with `--force` (and confirm dialog), it proceeds.
  - Archive on a branch with unpushed commits → daemon refuses without `--force`.
- Confirm a request to the daemon from a non-allowlisted origin (e.g. `curl -H "Origin: https://evil.example" http://127.0.0.1:7878/sessions`) is rejected, and a request without the auth token is rejected.
- Open dashboard in two tabs simultaneously, confirm both receive live updates and no events are missed during reconnect.

Optional but recommended:
- Run `HELM_REAL_AGENT_E2E=1 bun run test:agents` to confirm both agents still complete an end-to-end turn after the changes.

## Notes for the implementer

- Several fixes touch `SessionManager`'s public surface (1.2) and the events union (2.6). Land 1.2 first so subsequent changes are made against the encapsulated API.
- Order suggestion: 1.3 → 1.4 → 1.2 → 1.1 → 1.5 → 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6. Auth and archive-safety go first because they're the two highest-severity issues (data loss + open-to-the-browser RCE-equivalent surface).
- Each fix should be a separate commit with a conventional-commit message (e.g. `fix(daemon): split stop and archive statuses`, `refactor(daemon): encapsulate store and bus inside SessionManager`).
- Do not introduce new dependencies or new files unless strictly necessary; all fixes can be made within existing files.
