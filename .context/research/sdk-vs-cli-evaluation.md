# SDK vs CLI Evaluation

Date: 2026-05-03

## Executive summary

Recommendation: **do not migrate Helm from programmatic CLI runners to Claude/Codex SDK runners now.**

Helm's current approach is not the fragile PTY/tmux pattern used by some orchestrators. It already drives agents programmatically:

- Claude: long-lived `claude --print --input-format stream-json --output-format stream-json` subprocess over stdin/stdout.
- Codex: `codex exec --json` plus `codex exec resume <thread-id> --json` per follow-up.

The SDKs are not enough of an upgrade for Helm's current architecture. The most important correction is that "SDK" does not mean "no subprocess." The Codex TypeScript SDK explicitly wraps the `codex` CLI and exchanges JSONL over stdin/stdout. The Claude Agent SDK is a nicer in-process TypeScript control surface, but its own docs expose executable/process options and bundled native Claude Code binaries. So the actual choice is not "subprocess vs in-process"; it is "direct CLI protocol vs vendor library/protocol wrapper."

What Helm has now is actually fine. It is simple, inspectable, testable, and compatible with adding more runtimes. The burden of proof is on migration, and the current SDKs do not clear it.

## Sources checked

Local Helm:

- `packages/daemon/src/runner/claude.ts`
- `packages/daemon/src/runner/codex.ts`
- `packages/daemon/src/runner/manager.ts`
- `packages/daemon/src/runner/types.ts`
- `packages/daemon/src/session-manager.ts`
- `packages/daemon/src/event-bus.ts`
- `.specs/local-mvp.md`
- `.context/research/external-orchestrators-survey.md`
- `.plans/forward-compat.md`

Local Nimbalyst reference:

- `~/code/nimbalyst/packages/runtime/src/ai/server/providers/TeammateManager.ts`
- `~/code/nimbalyst/packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts`
- `~/code/nimbalyst/packages/runtime/src/ai/server/providers/OpenAICodexProvider.ts`
- `~/code/nimbalyst/packages/runtime/src/ai/server/protocols/CodexSDKProtocol.ts`

External primary docs:

- Anthropic Claude Agent SDK TypeScript reference: <https://platform.claude.com/docs/en/agent-sdk/typescript>
- Anthropic Claude Agent SDK V2 preview: <https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview>
- OpenAI Codex App Server engineering writeup: <https://openai.com/index/unlocking-the-codex-harness/>
- OpenAI Codex App Server README: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- OpenAI Codex TypeScript SDK README: <https://github.com/openai/codex/blob/main/sdk/typescript/README.md>
- Factory Droid exec docs: <https://docs.factory.ai/cli/droid-exec/overview>
- OpenCode SDK docs: <https://opencode.ai/docs/sdk/>
- Aider scripting docs: <https://aider.chat/docs/scripting.html>

## SDK availability survey

| Runtime | Programmatic surface | Migration implication for Helm |
|---|---|---|
| Claude Code | TypeScript/Python Agent SDK, `query()`, streaming input, resume, hooks, `canUseTool`, session helpers. V2 session API exists but is explicitly unstable preview. | Best SDK story. It offers richer callbacks than Helm parses today, but adopting it would make Claude different from other runners. |
| Codex | TypeScript SDK exists, but the README says it wraps `codex` CLI and exchanges JSONL over stdin/stdout. It supports `startThread`, `resumeThread`, `run`, `runStreamed`. | Not a process-model upgrade over Helm. It is a typed wrapper around the same basic substrate, with a smaller surface than App Server. |
| Codex App Server | JSON-RPC app-server process, thread/turn/item primitives, resume/fork/archive, approvals, rich UI events, schema generation. | More relevant than Codex SDK if Helm wants a richer Codex surface. It is still a child process, just a long-lived protocol server. |
| Factory Droid | CLI `droid exec`; supports `stream-json` and `stream-jsonrpc` for multi-turn SDK-style integration. | Fits Helm's existing runner-adapter model well. No need for a vendor SDK path. |
| OpenCode | Official JS/TS SDK for an OpenCode server; `createOpencode()` starts server + client, or connect to an existing server. | Similar to Codex App Server: server/client protocol, not a direct in-process agent loop. |
| Aider | CLI scripting and a Python `Coder` API, but docs say the Python scripting API is not officially supported and may change without backward compatibility. | Treat as CLI-first if added. Do not build Helm architecture around this API. |

Conclusion: SDK/server surfaces are appearing, but not as a single standard. The portable abstraction is still Helm's `RunnerAdapter`: spawn/control a runtime, normalize events, persist state, expose `send()` and `stop()`.

## Codex desktop app architecture finding

The user's suspicion is right: Codex Desktop is not best understood as using `@openai/codex-sdk`.

OpenAI's App Server writeup says the VS Code extension and Desktop App ship a platform-specific Codex binary pinned to a tested version, launch it as a long-running child process, and speak bidirectional JSON-RPC over stdio. The same writeup distinguishes Codex SDK as a smaller TypeScript library surface that shipped earlier and supports fewer languages and less harness surface than App Server.

The open-source App Server README also says `codex app-server` is the interface used to power rich interfaces, with thread, turn, and item primitives. It supports `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, and streaming item notifications.

So if Helm wants to follow Codex's own rich-client direction, the comparison is not current CLI vs `@openai/codex-sdk`. It is current `codex exec --json` runner vs `codex app-server` JSON-RPC runner.

## Helm current-state assessment

Helm's current `RunnerAdapter` is intentionally small:

- `spawn(opts): RunnerHandle`
- `events: AsyncIterable<NormalizedEvent>`
- `send(text)`
- `stop()`
- `pid`

`SessionManager` persists normalized events, updates lifecycle state, and owns process handles in memory. The spec explicitly says agents are direct children of the Helm process and die with it. SQLite and JSONL logs preserve observed state, not live agent continuity.

The manager loop already gets structured coordination through Helm tools:

- `create_child_session`
- `create_child_from_session`
- `create_child_from_branch`
- `send_message`
- `stop_child`
- `read_file`
- `pass_file_content`
- `read_diff`

That means Nimbalyst's central trick, intercepting Claude's `Task` tool and spawning teammates via in-process `query()`, does not map cleanly onto Helm. Helm already has an explicit manager tool layer for child sessions. The manager does not need to rely on Claude's built-in `Task` tool to create workers.

## Tradeoffs

### Process model

CLI today:

- Each user-facing agent is an OS child process with a pid.
- Helm can capture stdout/stderr, kill the process, set cwd/env/args per spawn, and inspect it with normal OS tools.
- Codex follow-ups are simple re-spawns against a persisted thread id.

SDK:

- Claude SDK gives a library control surface, but still has a Claude Code executable/process boundary under it.
- Codex SDK explicitly spawns the Codex CLI.
- App Server is also a subprocess, just long-lived and JSON-RPC-shaped.

Verdict: SDK migration does not eliminate subprocess management. It mostly moves some subprocess protocol handling into vendor code.

### Daemon restart survival

No meaningful advantage either way.

Helm's spec intentionally says live agents die with the owning daemon. Claude SDK resume and Codex SDK/App Server resume can reconstruct a conversation after restart, but Helm already persists `agent_thread_id` and Codex already uses `exec resume`. Adopting SDKs would not make live work continue through daemon death unless Helm also adopts a separate durable runtime process and reconnect protocol.

If durable reconnect becomes a requirement, Codex App Server is more relevant than Codex SDK.

### Observability

SDKs can improve observability, but the gain is uneven:

- Claude SDK exposes rich `SDKMessage` types, hook callbacks, `canUseTool`, partial messages, status/task/hook/rate-limit message types, and session helper APIs.
- Codex SDK streams the same family of structured `item.*` and `turn.*` events Helm can already parse from `codex exec --json`, though the typed wrapper is more ergonomic.
- Codex App Server has the richest Codex surface: explicit thread/turn/item lifecycle, deltas, approvals, diffs, fork, archive, config/auth, and generated schemas.

For Helm specifically, the useful observability gap is not "SDK vs CLI." It is that Helm's current normalizers are intentionally minimal:

- Claude currently emits only `thinking`, `assistant_message`, `turn_complete`, `exit`, and errors.
- Codex currently emits `thinking`, `assistant_message`, `turn_complete`, thread id, `exit`, and errors.

Before migrating runtimes, Helm should decide which extra normalized events it actually needs: tool invocation, tool result, usage, rate limit, hook status, approval request, file edit, command execution. Those can be added behind the current runner shape.

### Streaming model

Claude SDK `streamInput()` is convenient for bidirectional in-process control. But Helm already has two turn-shaped patterns that work:

- Claude: write JSON user messages to stdin.
- Codex: re-spawn `exec resume` for the next turn.

For Helm's manager loop, turns are the natural unit. The manager waits for child `turn_complete` or terminal status, reads diffs/files, and sends another message. It does not need sub-token bidirectional steering for the current workflow.

If Helm later wants live steering mid-turn, interactive approvals, or continuous background messaging into a still-running child, then SDK/App Server surfaces become more compelling. That is not the MVP shape.

### Resume semantics

Claude SDK supports `resume` and V2 preview has `resumeSession()`, but the V2 API is explicitly unstable and lacks some V1 features.

Codex SDK supports `resumeThread()`, matching Helm's current concept. But the SDK README also confirms threads live under `~/.codex/sessions`, which is exactly the persisted local CLI state Helm is already relying on via `codex exec resume`.

Codex App Server goes further with `thread/resume` and `thread/fork`. Forking is important: an open GitHub issue noted the TypeScript SDK only exposed `startThread`, `resumeThread`, `run`, and `runStreamed`, while CLI/App Server had richer fork/backtrack behavior. If Helm needs Codex thread forking, App Server is the likely path.

### Dependency footprint

CLI today:

- Helm depends on Bun/TypeScript packages it already owns.
- Users install agent CLIs separately.
- Runtime upgrades happen outside Helm, which is both a risk and a feature: real-agent tests catch drift without Helm bundling every vendor runtime.

SDK migration:

- `@anthropic-ai/claude-agent-sdk` currently depends on `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and optional native packages for every supported platform.
- `@openai/codex-sdk` currently depends on `@openai/codex`.
- Nimbalyst has packaging code specifically to handle bundled Claude SDK binaries in Electron.

For Helm, adding these as runtime deps is a real cost. It increases install size, platform packaging concerns, and version-pinning responsibility without removing the need to handle CLI/protocol drift.

### Multi-runtime ecosystem

SDK migration forks the implementation strategy:

- Claude gets SDK hooks.
- Codex gets either SDK wrapper or App Server.
- Droid fits stream-jsonrpc CLI.
- OpenCode wants server/client SDK.
- Aider is CLI/Python-internals and not stable as an SDK.

That is manageable eventually, but premature now. Helm benefits from a uniform adapter shape where each runtime can be direct CLI, app-server, or SDK internally without changing the session manager.

### Control and failure handling

CLI/process control is boring in a useful way:

- `pid` is real.
- `kill()` is real.
- stderr can be captured.
- env/cwd/args are explicit.
- crashes are isolated to the child process.

SDK wrappers can make common flows nicer, but they also hide process boundaries and add their own failure modes: loader resolution, binary packaging, version mismatch between wrapper and binary, callback semantics, and long-lived in-memory objects that need cleanup.

For a local daemon like Helm, boring process control is a good default.

## Is what Helm has now actually fine?

Yes.

The current approach is a solid MVP architecture:

- It is programmatic, not keystroke-driven.
- It matches Helm's spec: direct daemon children, no tmux durability.
- It keeps lifecycle ownership in `SessionManager`.
- It keeps manager/child coordination in Helm's own tools instead of vendor-specific subagent semantics.
- It leaves room for more runtimes without forcing every runtime into Claude/Codex-specific APIs.

The current weak spot is not the process model. The weak spot is the narrow normalized event vocabulary. If Helm needs better dashboards or a stronger manager loop, extend the normalized events before swapping runner substrates.

## What should Helm do instead?

1. Keep `RunnerAdapter` as the stable boundary.

2. Add a runtime capability matrix only when adding the next runtime forces it. Useful fields might include `supports_resume`, `supports_streaming_input`, `supports_tool_events`, `supports_usage_events`, `supports_thread_fork`, `supports_approval_events`, and `protocol`.

3. Enrich normalizers incrementally:

   - tool invocation/result
   - command execution
   - file edit
   - usage/cost
   - approval request
   - rate-limit/status

4. For Claude, consider using CLI hooks or SDK-style hook semantics only if Helm needs to intercept tools before execution. Do not migrate just to get the same assistant text and turn-complete events.

5. For Codex, evaluate App Server before Codex SDK if Helm needs a richer Codex integration. App Server is the first-class rich-client protocol and is closer to what Desktop/IDE use.

6. Keep mobile-control work independent. A PWA/Cloudflare tunnel can steer Helm's daemon through the existing HTTP/SSE API regardless of CLI vs SDK. SDK migration does not unlock mobile control.

7. Keep real-agent regression tests as the guardrail. Whether the backend is CLI, SDK, or app-server, Helm needs tests that catch vendor protocol drift.

## Trigger for revisiting migration

Revisit this decision when at least one of these becomes true:

- Helm needs mid-turn steering, approvals, or user questions that cannot be represented cleanly through the current JSON streams.
- Helm needs Codex thread fork/backtrack, live rejoin, app/plugin/skill UI events, or Desktop-like rich thread semantics. That points to Codex App Server, not Codex SDK.
- Claude SDK hooks become necessary for pre-tool enforcement that CLI hooks cannot provide cleanly.
- A second or third runtime has a stable server/SDK surface and Helm needs a capability matrix anyway.
- Helm decides live sessions should survive daemon restart. That is a broader process-supervision/reconnect design, not just an SDK swap.

Rough effort if revisited:

- Claude SDK runner spike: 1-2 days for parity, 3-5 days with tests and hook event mapping.
- Codex SDK runner spike: 1 day, but low expected value because it wraps CLI.
- Codex App Server runner spike: 3-5 days for basic thread/turn parity, 1-2 weeks if Helm maps approvals, fork, item lifecycle, schema generation, and reconnection behavior.
- Full multi-runtime capability matrix plus richer normalized events: 1-2 weeks depending on UI changes.

## Final recommendation

Do not migrate now. Helm's current programmatic CLI approach is the right default for its current product shape.

The useful lesson from Nimbalyst is not "use SDKs." It is "own the orchestration protocol and intercept/normalize agent runtime events at the boundary." Helm already owns the orchestration protocol. The next practical step is to make the boundary richer, not replace it.
