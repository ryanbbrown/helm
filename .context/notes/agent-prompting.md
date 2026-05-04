# Agent prompting — behaviors to instruct coding agents on

Running notes on prompts/instructions Helm should bake into its agent sessions. Not a spec; a scratchpad so we don't forget these when we get around to designing the prompt layer.

## Always commit when done with a turn

Coding agents (Claude, Codex, etc.) should be told, as part of their session-level instructions, that they should commit their changes whenever they finish making a coherent unit of work.

**Why this matters for Helm:**
- The "Create PR" flow refuses to act on a dirty worktree (uncommitted changes) and on an empty branch diff. If the agent leaves changes uncommitted, the user can't ship the work without manually committing first.
- The diff view's `branch` base shows commits + uncommitted on top — uncommitted changes are visually noisier and harder to review than commits.
- Codex Cloud (and similar managed agent products) hide the concept of commits from the user entirely — the agent always commits, and "the diff" is just what's on the branch. We should match that ergonomics.

**Framing for the agent prompt** (rough — refine when we actually wire it in):
> When you finish a coherent unit of work, commit it. The branch you're working on is a disposable feature branch — review and merge happen separately via pull request, not at the commit level. Do not be hesitant to commit; small frequent commits are fine. Do not stash, do not leave work uncommitted at the end of a turn unless you're explicitly mid-step.

## Other behaviors to capture later

Add to this doc as we encounter them. Candidates so far:

- Commit message style — should we instruct agents to follow conventional commits to match the repo convention?
- Telling agents not to push, not to open PRs themselves, not to merge — those flows belong to the user via Helm.
- Telling agents the worktree is isolated — they cannot affect the user's main checkout, branches, or stash, so they don't need to be defensive about git state.
- Disallowing destructive ops on git history (`git reset --hard`, `git rebase -i`, force-pushing) without explicit user instruction.

## Where this gets implemented

Eventually: a session-instructions layer at `packages/daemon/src/runner/instructions.ts` (or similar) that prepends a Helm-controlled system block to every agent's first turn. Keep per-agent variants if Claude vs. Codex want different framing. For now this is just notes.
