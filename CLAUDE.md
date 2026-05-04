# CLAUDE.md

This file is read automatically by Claude Code at the start of every session in this repo.

**Read `AGENTS.md` before making any change.** It contains the canonical working rules — required verification commands, what tests each kind of change needs, forbidden shortcuts, and how the spec relates to code.

## Quick reference

Before claiming any change is done, run:

```bash
bun run check
bun run test:unit
bun run test:e2e
```

If your change touches `packages/daemon/src/runner/` or anything that affects what we send to or parse from the agent CLI, also run:

```bash
HELM_REAL_AGENT_E2E=1 bun run test:agents
```

## Where things live

- `.specs/` is normative; keep only the active contract there, currently `.specs/local-mvp.md`.
- `.plans/` is execution strategy and roadmap material; useful context, but allowed to become stale after implementation.
- `.comms/` is communication artifacts such as reviews, handoffs, and agent-to-agent notes.
- `.context/` is non-normative background such as product briefs, research, comparisons, and evaluations.
- `.plans/forward-compat.md` — planned upcoming work; obey the priority order.
- `packages/core/` — types and schemas shared by daemon, CLI, and web.
- `packages/daemon/` — session manager, runner adapters, store, HTTP/SSE server.
- `packages/cli/` — `helm` CLI; talks to the daemon over HTTP when one is running, otherwise imports `@helm/daemon` in-process.
- `packages/web/` — Next.js dashboard.
- `tests/e2e/` — Playwright e2e suite, including the opt-in real-agent regression tests.
- `references/` — read-only submodules of comparable agent orchestration projects.

## Repo conventions

- Bun + Bun workspaces. Do not introduce npm or pnpm.
- TypeScript strict mode. No `any` without a written justification.
- Commit messages: conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`). Subject line is one short sentence.
- Each commit's working tree must pass the fast tier (see `AGENTS.md` §6).
