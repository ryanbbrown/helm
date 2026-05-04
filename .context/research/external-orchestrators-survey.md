# External Orchestrator Tools — Survey & Learnings

Captured from a long evaluation session on 2026-05-03. We compared Helm against three external multi-agent orchestrator tools to decide whether any of them would be a better base, a useful reference, or irrelevant. The evaluation also surfaced a few architectural questions worth thinking about for Helm regardless of whether we adopt anything.

This file is a reference for the future, not a binding plan. If we want details on any tool, the cloned source is local — paths below.

## TL;DR

- **None of the three tools is a viable fork base for Helm.** Helm already has the harder primitives (programmatic-first manager loop, structured tool calls, HTTP+SSE control plane, public/private DTO sanitization, per-session worktree, lifecycle state machine).
- **Three references worth borrowing patterns from**, in priority order:
  1. **Nimbalyst's `TeammateManager`** — uses the Claude Agent SDK in-process via `query()` / `streamInput()` instead of CLI subprocess, and intercepts the SDK's `Task` tool to spawn child sessions in-process rather than via subprocess. This *would* sidestep keystroke fragility entirely, but Helm doesn't use tmux/keystroke injection today (it uses `codex exec resume` for Codex), so the upside is less obvious. **Worth deeper evaluation — see open questions.**
  2. **Maestro's URL-token + Cloudflare named tunnel** for off-LAN mobile access without requiring Tailscale as a prerequisite. Pattern: `/{TOKEN}/...` everywhere; Cloudflare tunnel exposes the daemon publicly with one-click auth.
  3. **Maestro's `AgentCapabilities` 23-flag matrix + normalized output parser** — useful shape for when Helm adds a third agent runtime beyond claude-code and codex.
- **The PR-shaped lifecycle in AO is the wrong model for Helm.** AO assumes spawn-on-issue → worker-opens-PR → AO-watches-CI/reviews. Helm's writer→reviewer→writer iteration is task-shaped, not PR-shaped. AO's lifecycle states are hardcoded in core (not pluggable).

## Tools surveyed

### 1. Agent Orchestrator (AO) — `ComposioHQ/agent-orchestrator`

**Status**: dismissed as a base. Significant overlap with Helm but worse fit.

**Local clone**: `~/code/agent-orchestrator/`

**What it is**: Node CLI + Next.js dashboard for orchestrating multi-agent worktree sessions, GitHub-issues-driven workflow.

**Plumbing parity with Helm**: very high. Both have worktree-per-session, multi-runtime adapters, HTTP+SSE control, web dashboard, lifecycle state machine, plugin architecture.

**Lifecycle shape mismatch**: AO's `CanonicalSessionState`, `CanonicalPRState`, `CanonicalPRReason` are hardcoded for the GitHub-issue → worker-PR → merge/close flow. Reactions only fire on `ci-failed`, `changes-requested`, `approved-and-green`, `agent-stuck`. **Plugins cannot redefine lifecycle states.** Lifecycle Manager is explicitly marked "core, not pluggable" in `packages/core/src/types.ts`.

**Real bugs we hit**:
- **Wrapped storageKey resolver bug** in npm 0.3.0: `tmux-utils.js`'s session resolver only handles bare-hash storage keys (`{12-hex}-{sessionId}`), not wrapped form (`{12-hex}-{projectName}-{sessionId}`). Source on `main` has the fix (`findStorageKeysForSession`), but it wasn't published. Symptom: dashboard terminal connects but typing doesn't reach tmux pane.
- **`ao doctor` packaging bug** (#1252) — published CLI calls `ao-doctor.sh` which isn't shipped in the npm tarball. Filed as critical, marked closed, still reproduces on 0.3.0.
- **#1358** — SSE `controller.enqueue()` after close → unhandled rejection. We suspected this was Node-22-specific death; turned out the issue itself is just log noise on any Node version, and the actual user-visible symptom was a different bug entirely. (Lesson: don't accept handoff theory without reading source.)
- **PR enrichment caching bug** (#1358 Issue 1) — ETag Guard mishandles HTTP 304 from `gh` CLI; entire caching layer defeated, dashboard shows stale `+0/-0` diffs.

**Files worth reading**:
- `packages/core/src/types.ts` — lifecycle state model (read this if curious about how *not* to shape Helm's states)
- `packages/core/src/session-manager.ts` — session spawn / restore / reconciliation logic (~3000 lines)
- `packages/web/server/tmux-utils.ts` — the wrapped-storageKey resolver fix on main
- `packages/web/server/mux-websocket.ts` — terminal mux server; shows how their dashboard talks to live tmux panes
- `packages/plugins/terminal-iterm2/` and `packages/plugins/terminal-web/` — terminal plugin slot, mostly orthogonal
- README.md, SETUP.md, AGENTS.md — surface docs

**Worth borrowing**: nothing structural. Maybe their "reactions" config schema (`reactions:` block in yaml) as a UX shape if Helm wants user-configurable event reactions later. Not now.

### 2. Maestro — `RunMaestro/Maestro`

**Status**: AGPL-3.0 (sticky for any commercial play); not cloned locally. Reference value only.

**What it is**: Cross-platform Electron desktop app. Per-session dual subprocess (PTY via `node-pty` + agent child_process). Token-auth HTTP+WS API. Cloudflare tunnel for off-LAN mobile. PWA mobile client (no native iOS/Android).

**Why it's not a fork base**:
- AGPL-3.0 license — viral copyleft.
- **No public `POST /sessions` endpoint** — session creation only flows through the Electron renderer via IPC. Driving Maestro from a custom external manager is impossible without patching their API.

**Worth borrowing as patterns**:
- **URL-token + Cloudflare named tunnel** for off-LAN mobile. Cleaner than requiring Tailscale. `/{TOKEN}/...` for every URL. `apps/desktop/src/main/web-server/` is where this lives in their repo (review on GitHub if needed).
- **`AgentCapabilities` matrix** — 23 boolean flags per agent (supports streaming? supports resume? has tool calls? etc.) with CI-enforced completeness via `agent-completeness.test.ts`. Useful shape for Helm if/when we go beyond claude-code + codex.
- **Normalized agent output parser** — single event taxonomy across all agents: `init | text | tool_use | result | error | usage | system`. Helm currently parses Claude stream-json directly; if we add OpenCode or others, this normalization shape would help.

**Files worth reading on GitHub** (not cloned locally):
- `apps/desktop/src/main/agents/definitions.ts` and `capabilities.ts` — the registry pattern
- `apps/desktop/src/main/agents/parsers/` — the per-agent output parser implementations
- `apps/desktop/src/main/web-server/apiRoutes.ts` — Fastify HTTP routes (note the gap: no spawn route)

### 3. Nimbalyst — `Nimbalyst/nimbalyst`

**Status**: dismissed as a base (different product shape — editor-first Electron monolith). High reference value.

**Local clone**: `~/code/nimbalyst/`

**What it is**: Electron desktop app + native iOS + native Android. WYSIWYG editors (markdown/Mermaid/Excalidraw/Monaco), Kanban session board, in-process agent SDK calls, PGLite (Postgres-in-WASM) state, Cloudflare-Workers + Durable Objects mobile relay.

**Why it's not a fork base**: fundamentally different shape. Electron monolith with ~80 main-process services and a heavy editor stack we don't need. The architectural pivot is too large.

**The big finding — `TeammateManager`**:

Nimbalyst doesn't run Claude Code as a subprocess. It loads `@anthropic-ai/claude-agent-sdk` in-process and calls `query()` / `streamInput()` directly. Then in `packages/runtime/src/ai/server/providers/TeammateManager.ts` (~1.7k LOC) it intercepts the SDK's `Task` tool via a `PreToolUse` hook, denies the SDK's subprocess spawn, and instead spawns another in-process `query()` it can pipe input to and observe output from directly. Inter-agent messaging becomes function calls and stream pipes — no PTY, no keystroke injection, no `tmux send-keys`.

**Codex equivalent**: `@openai/codex-sdk` exists; Nimbalyst uses it the same way (`OpenAICodexProvider`).

**Caveat for Helm**: Helm's current state is *not* keystroke injection either. We use `codex exec resume <thread-id>` per turn for Codex (re-spawn-per-turn pattern in `packages/daemon/src/runner/codex.ts`), and Claude Code's stream-json over stdin in `packages/daemon/src/runner/claude.ts`. Both are programmatic, not PTY-based. So the "SDK avoids keystroke fragility" framing is less compelling for Helm than it is for tools that do drive PTYs (AO, Maestro). **The remaining question is whether the SDK is meaningfully better even when CLI is already programmatic.** See open questions section.

**Mobile architecture (CollabV3)**:
- `packages/collabv3/` is **AGPL-3.0** (the rest of Nimbalyst is MIT). Self-hostable on Cloudflare Workers + Durable Objects.
- Native iOS app (`packages/ios/`) is real SwiftUI + GRDB/SQLite + AES-256-GCM E2E encryption + Stytch auth. Same shape on Android.
- Both desktop and mobile are peers writing into per-session DO storage. **No LAN/Tailscale path** — both endpoints connect outbound to the same Cloudflare service.
- Mobile commands flow back as `SessionControlMessage` (cancel, prompt, prompt_response covering AskUserQuestion / ExitPlanMode / ToolPermission / GitCommit).

**Files worth reading**:
- `packages/runtime/src/ai/server/providers/TeammateManager.ts` — the SDK-in-process + PreToolUse-intercept pattern. **Read this in detail if evaluating an SDK migration.**
- `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts` — SDK adapter shape, hook factories (`createPreToolUseHook`, `createPostToolUseHook`)
- `packages/runtime/src/ai/server/providers/OpenAICodexProvider.ts` — Codex SDK adapter
- `packages/electron/src/main/services/MetaAgentService.ts` and `packages/electron/src/main/mcp/metaAgentServer.ts` — manager-loop tools (`spawn_session`, `send_prompt`, `respond_to_prompt`, etc.) exposed via MCP. Compare to Helm's manager loop tools.
- `packages/electron/src/main/services/GitWorktreeService.ts` and `packages/electron/src/main/file/GitRefWatcher.ts` — event-driven git integration via filesystem watches on `.git/refs/heads/*`. Cleaner than poll loops.
- `packages/collabv3/` — AGPL self-hostable mobile relay if/when we want to copy this pattern
- `packages/extension-sdk/` — editor extension SDK; mostly orthogonal to Helm
- `docs/CLAUDECODEPROVIDER_REFACTORING.md` — provider architecture notes
- `docs/TEAMMATE_IMPLEMENTATION.md` — design notes for the TeammateManager pattern
- `docs/IPC_GUIDE.md` — Electron IPC event taxonomy (rich event names worth scanning)

**Notable absences in Nimbalyst**:
- No external HTTP/REST/WS API for general orchestration. Localhost MCP servers exist (for in-app agents to call), but they're not "external orchestrator API." Driving Nimbalyst from outside means speaking MCP.
- Extensions are editor- and panel-focused (`EditorHost` contract); they cannot intercept agent sessions or register PreToolUse hooks. A Helm-style manager loop is *not* something an extension could implement.
- No `read_diff` / `pass_file_content` MCP primitives — file passing between sessions is not a first-class concept (Helm has this).
- No `.claude/settings.json` hook injection — SDK in-process hooks instead. So if you want hooks observable across out-of-process CLI runs, this pattern doesn't help.

## Cross-cutting learnings

### Lifecycle state model

Three different shapes among the four tools (counting Helm):

| Tool | Lifecycle shape | Where defined |
|---|---|---|
| AO | PR-shaped (created → spawning → working → idle/pr_created → idle/pr_merged → done) | `packages/core/src/types.ts` (hardcoded, "core not pluggable") |
| Maestro | Flat: `idle | busy | error | connecting` | Per-session, no PR coupling |
| Nimbalyst | TeammateManager has 3-state (running/idle/completed) | `TeammateManager.ts`; agent processes are managed in-proc |
| Helm | Agent-CLI-shaped (created → running → awaiting_input ⇄ running → completed/failed/stopped → archived) | `packages/daemon/src/session-manager.ts` |

Helm's shape is closest to Maestro's (decoupled from PR/issue tracker) and Nimbalyst's (decoupled from PR but with manager-loop primitives). **Helm's choice to keep the lifecycle agent-shaped, not PR-shaped, is correct for the writer↔reviewer↔writer flow.**

### Hook injection vs in-process SDK hooks vs keystroke injection

Spectrum of approaches across the surveyed tools:

| Approach | Tool example | Keystroke fragility? | Programmatic observability? |
|---|---|---|---|
| Pure keystroke (`tmux send-keys`) | AO's bare path | Yes (fragile) | None |
| Wrapped keystroke (`ao send` with retry/sanitization) | AO's recommended path | Yes (still keystroke-shaped) | Partial — exit-code based |
| `.claude/settings.json` hook injection | AO's PostToolUse hook for metadata writes | No | Out-of-process via shell |
| In-process SDK hooks (`PreToolUse`/`PostToolUse` callbacks) | Nimbalyst's `TeammateManager` | No | Yes — first-class function callbacks |
| Programmatic CLI (stream-json over stdin, `--resume`) | Helm today | No | Yes — parsed structured output |

Helm is already in the "programmatic CLI" tier, which is meaningfully better than keystroke. The question is whether the SDK tier is meaningfully better than programmatic CLI — that's the open question for the next handoff.

### Mobile bridge patterns

Two reference architectures:

- **Maestro pattern** (Cloudflare named tunnel + URL-token + PWA): days of work, no native app, no native push. 70% of value at 10% of cost.
- **Nimbalyst pattern** (CollabV3 Durable Objects + native iOS/Android + APNs/FCM + E2E encryption + Stytch auth): weeks of work, polished, swipe-to-approve diff gestures.

Helm has neither today. F2 in `forward-compat.md` (runtime API base for phone access) is done; the bridge itself is on the to-do list.

## Open questions for Helm

1. **SDK migration vs CLI subprocess**: Helm's `runner/claude.ts` uses Claude stream-json over stdin; `runner/codex.ts` uses `codex exec resume`. Both programmatic. Switching to `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` would give us in-process `PreToolUse`/`PostToolUse` callbacks (richer than parsing stream-json output) and the TeammateManager spawn-child-in-proc pattern. But: it changes Helm's process model (agents become in-proc, not direct child processes), introduces SDK as a runtime dependency, and may not survive daemon restart any better than the current CLI children. **Defer this question to a Codex session for an independent take.**

2. **Mobile bridge shape**: PWA-via-Cloudflare-tunnel (Maestro shape) is cheap and ships fast; native iOS/Android (Nimbalyst shape) is polished and slow. Pick after the daemon/control-plane work stabilizes.

3. **Lifecycle generalization**: AO's mistake was to bake PR shape into core. Maestro's win was to keep it flat. Nimbalyst layers manager-loop semantics on top of flat per-process states. Helm's current shape is closest to Nimbalyst — confirm we're not accidentally drifting toward PR coupling as we grow.

4. **`AgentCapabilities` matrix**: should we adopt this shape now (preemptively for OpenCode/Aider/Droid) or wait until a third runtime forces our hand? Probably wait, but worth knowing the pattern exists.

## What we definitively learned not to do

- Don't fork AO. (Lifecycle wrong for Helm; npm package has critical resolver bug; Composio's release cadence is too fast for fork sync.)
- Don't fork Maestro. (AGPL-3.0; no public spawn API.)
- Don't fork Nimbalyst. (Wrong product shape; Electron monolith.)
- Don't try to bridge AO's lifecycle into a writer↔reviewer flow. The reactions config doesn't have hooks for non-PR events; lifecycle states aren't pluggable.
- Don't trust handoff documents without reading the source they cite. The previous AO debugging handoff fabricated three claims (Node 22 doom, `terminal: web` config field, source-clone state). Always verify.
