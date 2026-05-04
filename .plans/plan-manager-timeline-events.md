# Plan: Manager Timeline Events

Spec: `.specs/local-mvp.md`

Related draft: `.plans/plan-ui-overhaul.md`

## Overview

Improve the manager timeline so approval-mode tool calls and child-session lifecycle updates are understandable without opening raw JSON. This should be a small addendum to the broader dashboard UI overhaul, focused on manager sessions only.

## Steps

### 1. Render manager tool calls as readable summaries

Update `packages/web/src/components/MessageTimeline.tsx` to format `tool_invocation` arguments per tool instead of showing only `Tool pending: <name>`. Keep a collapsible or secondary raw JSON view for debugging, but make the first line human-readable: create child session with repo/agent/source branch/new branch, pass file from source session to target session, send message to child session, read diff, or stop child.

Files likely touched:
- `packages/web/src/components/MessageTimeline.tsx`
- `packages/web/src/app/globals.css`
- optionally `packages/web/src/components/ToolCallSummary.tsx`

**Verify:** Add dashboard e2e coverage with seeded manager events asserting that a `create_child_from_branch` call shows repo, source branch, and new branch, and that `pass_file_content` shows source session, target session, and file path.

### 2. Show child-session completion notices in the manager timeline

Use the existing `child_event` surface for manager-observed lifecycle updates, but make the UI copy explicit and subdued: "Child session <id> reached awaiting input", "Child session <id> failed", or "Child session <id> stopped". If the backend does not currently emit a `child_event` for `turn_complete`, add that normalized manager event where the manager already enqueues wake notices.

Files likely touched:
- `packages/daemon/src/runner/manager.ts`
- `packages/web/src/components/MessageTimeline.tsx`
- `packages/core/src/events.ts` only if a new child event kind is needed

**Verify:** Add a manager-runner unit test with a fake child `turn_complete` event proving the manager emits/persists a visible lifecycle notice, then add dashboard e2e coverage asserting the gray lifecycle row appears before the manager's follow-up assistant message.

## Considerations

Prefer per-tool summary helpers over dumping full JSON into the primary timeline. The raw arguments are still useful, but they should be secondary because the main workflow question is "what is the manager trying to do?" rather than "what exact JSON did the model emit?"

Do not infer child completion from text in the manager assistant message. The UI should render lifecycle events from structured events so it remains accurate even when the manager chooses different wording.
