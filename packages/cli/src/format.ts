import type { Session, SessionEvent } from "@helm/core";

const SURFACED = new Set(["session_started", "thinking", "assistant_message", "error", "exit"]);

/** Formats a session list as a table. */
export function printSessionTable(sessions: Session[]): void {
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
      updated: session.updated_at
    }))
  );
}

/** Prints a session detail. */
export function printSession(session: Session): void {
  console.log(`id: ${session.id}`);
  console.log(`repo: ${session.repo_name}`);
  console.log(`agent: ${session.agent_name}`);
  console.log(`status: ${session.status}`);
  console.log(`branch: ${session.branch}`);
  console.log(`worktree: ${session.worktree_path}`);
  if (session.last_assistant_message) {
    console.log("\nlast assistant message:");
    console.log(session.last_assistant_message);
  }
}

/** Prints a surfaced session event. */
export function printEvent(event: SessionEvent): void {
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
  }
}
