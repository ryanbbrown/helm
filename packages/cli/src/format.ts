import type { PublicSession, PublicSessionEvent, Session, SessionEvent } from "@helm/core";

const SURFACED = new Set(["session_started", "thinking", "assistant_message", "tool_invocation", "tool_call_resolved", "tool_result", "child_event", "error", "exit"]);

/** Formats a session list as a table. */
export function printSessionTable(sessions: Array<Session | PublicSession>): void {
  if (sessions.length === 0) {
    console.log("No sessions.");
    return;
  }
  console.table(
    sessions.map((session) => ({
      id: session.id,
      repo: session.repo_name,
      agent: session.agent_name,
      status: session.status,
      branch: session.branch,
      parent: session.parent_session_id,
      mode: session.manager_mode,
      updated: session.updated_at
    }))
  );
}

/** Prints a session detail. */
export function printSession(session: Session | PublicSession): void {
  console.log(`id: ${session.id}`);
  console.log(`repo: ${session.repo_name}`);
  console.log(`agent: ${session.agent_name}`);
  console.log(`status: ${session.status}`);
  console.log(`branch: ${session.branch}`);
  if (session.parent_session_id) {
    console.log(`parent: ${session.parent_session_id}`);
  }
  if (session.manager_mode) {
    console.log(`manager mode: ${session.manager_mode}`);
  }
  if ("worktree_path" in session) {
    console.log(`worktree: ${session.worktree_path}`);
  }
  if (session.last_assistant_message) {
    console.log("\nlast assistant message:");
    console.log(session.last_assistant_message);
  }
}

/** Prints a surfaced session event. */
export function printEvent(event: SessionEvent | PublicSessionEvent): void {
  if (!SURFACED.has(event.kind)) {
    return;
  }
  if (event.kind === "assistant_message" && "text" in event.payload) {
    console.log(`\nassistant:\n${event.payload.text}\n`);
    return;
  }
  if (event.kind === "thinking") {
    console.log("thinking...");
    return;
  }
  if (event.kind === "error" && "message" in event.payload) {
    console.error(`error: ${event.payload.message}`);
    return;
  }
  if (event.kind === "session_started") {
    console.log(`session started: ${event.session_id}`);
    return;
  }
  if (event.payload.kind === "tool_invocation") {
    console.log(`tool ${event.payload.status}: ${event.payload.toolName} (${event.payload.toolCallId})`);
    return;
  }
  if (event.payload.kind === "tool_result") {
    console.log(`tool result: ${event.payload.toolName} ${event.payload.ok ? "ok" : event.payload.errorMessage ?? "failed"}`);
    return;
  }
  if (event.payload.kind === "tool_call_resolved") {
    console.log(`tool ${event.payload.approved ? "approved" : "denied"}: ${event.payload.toolCallId}`);
    return;
  }
  if (event.payload.kind === "child_event") {
    console.log(`child ${event.payload.childKind}: ${event.payload.childId}${event.payload.detail ? ` ${event.payload.detail}` : ""}`);
  }
}
