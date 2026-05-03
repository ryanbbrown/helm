import type { Session } from "@helm/core";
import type { ManagerToolContext } from "./manager-context";

export type StateSnapshotOptions = {
  wakeNotice?: string;
};

/** Renders an append-only state snapshot for a manager turn boundary. */
export function renderStateSnapshot(ctx: ManagerToolContext, options: StateSnapshotOptions = {}): string {
  const now = new Date().toISOString();
  const sessions = ctx.manager.list(true).filter((session) => session.id !== ctx.managerSessionId);
  const live = sessions.filter((session) => session.status !== "archived" && !["completed", "failed", "stopped"].includes(session.status));
  const terminated = sessions
    .filter((session) => ["completed", "failed", "stopped"].includes(session.status))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 20);
  return [
    `[state snapshot ${now}]`,
    options.wakeNotice ? `wake_notice: ${options.wakeNotice}` : null,
    "live sessions:",
    live.length ? live.map(renderSessionRow).join("\n") : "(none)",
    "recently terminated sessions:",
    terminated.length ? terminated.map(renderSessionRow).join("\n") : "(none)"
  ].filter(Boolean).join("\n");
}

/** Renders one compact session row for manager context. */
function renderSessionRow(session: Session): string {
  const snippet = (session.last_assistant_message ?? "").replace(/\s+/g, " ").slice(0, 160);
  return [
    `- id=${session.id}`,
    `repo=${session.repo_name}`,
    `agent=${session.agent_name}`,
    `parent=${session.parent_session_id ?? "null"}`,
    `status=${session.status}`,
    `started_at=${session.created_at}`,
    `last="${snippet}"`
  ].join(" ");
}
