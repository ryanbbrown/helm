# Plan: Dashboard UI Overhaul

Spec: `.specs/local-mvp.md`

Source baseline: committed `HEAD` only. The current uncommitted manager-session work is intentionally not used as a dependency for this plan; when it lands, reconcile only the shared navigation/session-list surfaces.

## Overview

Overhaul the Next.js dashboard from a functional MVP into a keyboard-friendly operations surface for managing many local agent sessions. The work keeps the existing daemon API and SSE model, but replaces the ad hoc form and layout behavior with reusable UI primitives, a shared composer, predictable shortcuts, stronger empty/loading/error states, and Playwright coverage for the workflows the user should not have to manually verify.

## Steps

### 1. Capture the dashboard UX contract before changing components

Define the expected dashboard behavior in the spec or a short adjacent section so the implementation has an objective target: Enter sends messages, Shift+Enter inserts a newline, Cmd/Ctrl+Enter also sends from multiline text, Escape clears transient UI, slash focuses search or the active composer, bracket/arrow shortcuts move between sessions, and destructive actions remain explicit.

Files to modify:
- `.specs/local-mvp.md`
- `tests/e2e/dashboard.spec.ts`

Add Playwright coverage first for the currently missing core behaviors, even if tests fail before implementation:

```ts
test("composer sends with Enter and keeps Shift+Enter as newline", async ({ page }) => {
  await page.goto(`/?token=${await readE2eToken()}`);
  await page.getByRole("textbox", { name: /follow-up/i }).fill("first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await expect(page.getByRole("textbox", { name: /follow-up/i })).toHaveValue("first line\nsecond line");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: /follow-up/i })).toHaveValue("");
});
```

Use deterministic fake-agent/session setup for e2e instead of real LLMs. The current `tests/e2e/dashboard.spec.ts` only proves config selectors render; the UI overhaul needs tests for creation, follow-up sending, selection, diff toggle, and keyboard shortcuts.

**Verify:** The new tests are present and initially describe the desired contract. After later phases, `bun run test:e2e` covers the workflows without manual clicking.

### 2. Introduce small UI primitives and design tokens

Replace page-level CSS conventions with a small local component layer, keeping dependencies conservative: use existing React, CSS, and `lucide-react`; do not add a full design-system package unless a specific primitive is too expensive to build well.

Files to create or modify:
- `packages/web/src/components/ui/Button.tsx`
- `packages/web/src/components/ui/IconButton.tsx`
- `packages/web/src/components/ui/Textarea.tsx`
- `packages/web/src/components/ui/Select.tsx`
- `packages/web/src/components/ui/StatusPill.tsx`
- `packages/web/src/components/ui/Tooltip.tsx` if icon-only actions need labels beyond `title`
- `packages/web/src/app/globals.css`
- `packages/web/src/components/StatusBadge.tsx`

Keep the primitives intentionally thin. This avoids spreading raw button/input/select styling across feature components while preserving the current no-framework setup.

```tsx
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
};

/** Renders a styled dashboard button. */
export function Button({ variant = "secondary", size = "md", className = "", ...props }: ButtonProps) {
  return <button className={`ui-button ${variant} ${size} ${className}`.trim()} {...props} />;
}
```

Refresh the CSS tokens around dense operational UI rather than a decorative landing-page aesthetic: restrained neutrals, one accent, semantic status colors, stable heights, visible focus rings, and no page-level card nesting. Disable freeform textarea resizing by default; controlled autosize should decide height.

**Verify:** `bun run check` passes, existing dashboard still loads, and no feature behavior changes except visual consistency. Run `bun run test:e2e` to catch selector regressions.

### 3. Rebuild the app shell for many sessions

Split `packages/web/src/app/page.tsx` into a stateful dashboard shell and focused panels. Keep data fetching in one place for now, but remove layout and form details from the page root.

Files to create or modify:
- `packages/web/src/app/page.tsx`
- `packages/web/src/components/DashboardShell.tsx`
- `packages/web/src/components/Sidebar.tsx`
- `packages/web/src/components/NewSessionPanel.tsx`
- `packages/web/src/components/SessionList.tsx`
- `packages/web/src/components/Header.tsx`
- `packages/web/src/components/EmptyState.tsx`

Recommended shell shape:

```tsx
/** Renders dashboard layout around session navigation and details. */
export function DashboardShell(props: DashboardShellProps) {
  return (
    <main className="dashboard-shell">
      <Sidebar {...props.sidebar} />
      <section className="dashboard-main">{props.detail}</section>
    </main>
  );
}
```

The sidebar should support scanning many sessions: search/filter, status filter chips, compact rows with repo/branch/agent/status, selected row focus state, and clear empty states when no sessions match. The header should stop using inline styles and should expose only actions relevant to the selected session.

The current manager-session work may eventually add a manager/task-board navigation mode. Do not block this phase on it; just keep the shell boundaries clean so a future top-level nav can slot in without rewriting the composer or timeline.

**Verify:** Dashboard still selects the latest session on load, preserves selected session while SSE updates arrive, and remains usable at desktop and narrow widths. Add e2e assertions for selecting sessions by keyboard and mouse.

### 4. Replace prompt and follow-up textareas with a shared autosizing composer

Build one composer component used by both new-session creation and follow-up messages. This directly fixes the current problems: textareas can be manually resized, Enter does not send follow-ups, the initial prompt form and follow-up composer behave differently, and send is only discoverable through a button click.

Files to create or modify:
- `packages/web/src/components/Composer.tsx`
- `packages/web/src/components/NewSessionPanel.tsx`
- `packages/web/src/components/SessionDetail.tsx`
- `packages/web/src/app/globals.css`

Core behavior:
- Enter sends when the composer is non-empty.
- Shift+Enter inserts a newline.
- Cmd+Enter and Ctrl+Enter send from any line.
- Escape clears the composer if it has draft text.
- The send button remains available and uses a lucide send icon.
- Autosize grows to a capped height, then scrolls internally.
- Disable send while a request is in flight, but keep draft text if the request fails.

```tsx
/** Handles composer keyboard shortcuts. */
function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
  const wantsSend = event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey);
  if (!wantsSend) {
    return;
  }
  event.preventDefault();
  void submit();
}
```

Use a real `<form>` for both create and send paths so keyboard and button submission share the same code. The textarea should have an accessible label, even if visually hidden.

**Verify:** Unit-level coverage is not necessary if Playwright drives the real UI. Add e2e cases for Enter, Shift+Enter, send failure preserving draft text, disabled archived/stopped/failed sessions, and initial prompt creation through Enter.

### 5. Add global and scoped keyboard shortcuts

Create a small shortcut hook rather than sprinkling `window.addEventListener("keydown")` across components. It should ignore events from editable fields except for composer-owned shortcuts.

Files to create or modify:
- `packages/web/src/lib/shortcuts.ts`
- `packages/web/src/components/DashboardShell.tsx`
- `packages/web/src/components/SessionList.tsx`
- `packages/web/src/components/SessionDetail.tsx`
- `packages/web/src/components/SessionDiff.tsx`

Suggested shortcuts:
- `/` focuses the session search when focus is not in an editable field.
- `n` focuses the new-session prompt.
- `j` / `k` or ArrowDown / ArrowUp moves through sessions when the list is focused.
- `Enter` opens/selects the focused session row.
- `r` refreshes the selected session.
- `d` toggles the diff panel.
- `s` stops the selected session only after focus is on the stop button or through an explicit confirmation pattern; avoid accidental destructive actions.
- `Escape` closes dialogs, clears search, or returns focus to the selected session row depending on context.

```ts
/** Returns true when a keyboard event started inside editable content. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}
```

Keep shortcuts discoverable through tooltips and button labels where useful; do not add a large help overlay in the first pass unless tests show shortcut conflicts.

**Verify:** Playwright covers search focus, session navigation, diff toggle, refresh, and that shortcuts do not fire while typing in textareas.

### 6. Improve the timeline as an operational log and conversation

Make `MessageTimeline` easier to read during long sessions. The current implementation filters events and renders simple bubbles, but it lacks timestamps, turn grouping, scroll anchoring, visible error severity, and loading/empty states.

Files to create or modify:
- `packages/web/src/components/MessageTimeline.tsx`
- `packages/web/src/components/TimelineEvent.tsx`
- `packages/web/src/components/SessionDetail.tsx`
- `packages/web/src/app/globals.css`

Add:
- Auto-scroll to newest events while the user is already near the bottom; preserve scroll position when reviewing older messages.
- Compact event rows for `session_started`, `thinking`, `turn_complete`, `error`, and `exit`.
- Message metadata: role, time, and status for long-running turns.
- Better empty state for a newly created session with no assistant response yet.
- Clear error affordances that do not look like ordinary muted log lines.

The UI contract in `.specs/local-mvp.md` says only surfaced normalized events should show. Keep that filter intact; do not start showing raw tool events unless the spec changes.

**Verify:** E2E covers live event append without duplicate rows, auto-scroll after a new assistant message, and error rendering from a fake event. Run `bun run test:e2e` because this touches SSE-driven dashboard behavior.

### 7. Rework diff and PR actions into a coherent detail toolbar

The committed diff work is functional, but the controls are scattered: top header has "Show diff", diff panel has branch/uncommitted, refresh, PR, and split resizing. Move session-level actions into a consistent toolbar and keep the diff panel focused on review.

Files to modify:
- `packages/web/src/components/Header.tsx`
- `packages/web/src/components/SessionDetail.tsx`
- `packages/web/src/components/SessionDiff.tsx`
- `packages/web/src/components/ResizableSplit.tsx`
- `packages/web/src/components/CreatePRDialog.tsx`

Recommended shape:
- Header: selected session identity, status, refresh, stop, archive, PR link if present.
- Detail tabs or segmented control: `Chat` and `Diff`, with `d` toggling Diff.
- Diff toolbar: base toggle, refresh diff, create/view PR.
- Split pane: stable min/max widths and keyboard-resizable separator with visible focus.
- Mobile: stack chat and diff; composer stays reachable without overlapping content.

Do not remove the existing `@pierre/diffs` lazy-loading. Keep the renderer client-only and hidden until the user opens Diff.

**Verify:** Existing diff e2e coverage, if present, still passes. Add checks for keyboard resizing of the split, base toggle persistence, and create-PR dialog focus trap/escape close.

### 8. Add robust feedback states and recoverability

The page currently stores one `error` string near the new-session form, which makes API errors feel detached from the action that caused them. Move errors next to the operation and add consistent pending states.

Files to create or modify:
- `packages/web/src/components/ToastRegion.tsx` or `InlineNotice.tsx`
- `packages/web/src/components/NewSessionPanel.tsx`
- `packages/web/src/components/Composer.tsx`
- `packages/web/src/components/SessionDiff.tsx`
- `packages/web/src/components/CreatePRDialog.tsx`
- `packages/web/src/app/page.tsx`

Patterns:
- New-session errors appear inside the new-session panel.
- Follow-up send errors appear above the active composer and preserve the draft.
- Archive safety errors use a custom confirmation dialog instead of `window.confirm`, showing dirty paths or unshared commits from `ApiError.details`.
- SSE disconnected state is visible but not catastrophic; manual refresh remains available.
- Unauthorized token clears local token as today, but the dashboard should show a compact reconnect/setup state instead of a generic error line.

**Verify:** E2E covers dirty archive confirmation with mocked/fake daemon response, send failure preserving text, and unauthorized state. Run `bun run test:e2e`.

### 9. Responsive and accessibility pass

Make the dashboard usable on laptop and narrow browser widths without turning it into a landing page. This is an operational tool, so prioritize density, predictable focus order, and text that never overlaps controls.

Files to modify:
- `packages/web/src/app/globals.css`
- All feature components touched above
- `tests/e2e/dashboard.spec.ts`

Requirements:
- Sidebar collapses or stacks cleanly below 760px without hiding the active composer.
- All icon buttons have accessible names and focus-visible states.
- Dialogs trap focus and restore it on close.
- Session rows expose selected state through `aria-current` or equivalent.
- Resizable split separator has `role="separator"`, keyboard support, and sane `aria-valuenow` metadata if practical.
- Text in buttons, rows, and badges truncates or wraps intentionally.

Add Playwright viewport coverage for at least desktop and mobile widths. Use assertions for visibility and lack of overlapping critical controls where practical.

**Verify:** `bun run test:e2e` at configured viewports, plus one manual screenshot review after implementation. The repo rules still require `bun run check` and `bun run test:unit` for any code change.

### 10. Final integration and test hardening

Once the UI phases are in place, remove any obsolete CSS and ensure all dashboard behavior is covered by the fast tier.

Files to modify:
- `packages/web/src/app/globals.css`
- `tests/e2e/dashboard.spec.ts`
- Potentially new focused e2e files such as `tests/e2e/dashboard-keyboard.spec.ts` and `tests/e2e/dashboard-diff.spec.ts`

Final verification commands for the implementation:

```bash
bun run check
bun run test:unit
bun run test:e2e
```

If any phase touches `packages/daemon/`, `packages/cli/`, HTTP route behavior, SSE event shape, dashboard session lifecycle, or diff/PR behavior, `bun run test:e2e` remains required. If the manager-session work lands and runner adapter behavior is touched while implementing this UI, also evaluate `bun run test:agents` per `AGENTS.md`.

**Verify:** The full fast tier passes. The dashboard can be driven through keyboard alone for create, select, send, refresh, diff toggle, and non-destructive dialogs.

## Considerations

- The implementation should preserve the daemon API and SSE contracts unless a specific UX need requires a server change. Most of this is frontend work.
- Do not depend on the in-progress manager session. Keep top-level layout and session-list boundaries clean so manager/task-board navigation can be added later without undoing the composer, timeline, or primitive work.
- Avoid adopting Tailwind, Radix, or shadcn by default. The current app is small; local primitives plus CSS are enough unless dialog focus trapping or tooltips become too costly to maintain.
- The current `Header` uses inline styles and mixed responsibilities. Treat it as a likely rewrite, not as a styling tweak.
- The shared composer is the highest-value change. It fixes Enter-to-send, manual resize, draft preservation, and inconsistent create/follow-up behavior in one place.
- Keyboard shortcuts must not hijack typing. Centralize editable-target checks and cover them in Playwright.
- Keep destructive operations explicit. Keyboard shortcuts may focus archive/stop controls, but should not force archive or stop without confirmation.
- Plan for many sessions but do not build a full task board here. Search/filter/sort is enough until the manager-session branch defines the orchestration model.
- Any implementation PR should keep tests in the same commit as behavior changes and avoid weakening the existing E2E checks.
