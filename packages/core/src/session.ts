import type { NormalizedEvent, PublicNormalizedEvent, SessionEventKind } from "./events";

export type SessionStatus =
  | "created"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "stopped"
  | "archived";

export type Session = {
  id: string;
  repo_name: string;
  agent_name: string;
  branch: string;
  worktree_path: string;
  agent_thread_id: string | null;
  pid: number | null;
  status: SessionStatus;
  last_assistant_message: string | null;
  last_event_at: string | null;
  pull_request_url: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicSession = Omit<Session, "worktree_path" | "agent_thread_id" | "pid">;

export type SessionEvent = {
  id: number;
  session_id: string;
  kind: SessionEventKind;
  payload: NormalizedEvent;
  created_at: string;
};

export type PublicSessionEvent = Omit<SessionEvent, "payload"> & {
  payload: PublicNormalizedEvent;
};

/** Removes local-only fields from a session row. */
export function toPublicSession(session: Session): PublicSession {
  return {
    id: session.id,
    repo_name: session.repo_name,
    agent_name: session.agent_name,
    branch: session.branch,
    status: session.status,
    last_assistant_message: session.last_assistant_message,
    last_event_at: session.last_event_at,
    pull_request_url: session.pull_request_url,
    created_at: session.created_at,
    updated_at: session.updated_at
  };
}

/** Removes local-only fields from a session event row. */
export function toPublicSessionEvent(event: SessionEvent): PublicSessionEvent {
  if (event.payload.kind !== "session_started") {
    return event as PublicSessionEvent;
  }
  const { worktreePath: _worktreePath, ...payload } = event.payload;
  return {
    ...event,
    payload
  };
}
