import type { NormalizedEvent, PublicNormalizedEvent, SessionEventKind } from "./events";
import type { ManagerMode } from "./manager";

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
  branch: string | null;
  worktree_path: string | null;
  workspace_uri: string | null;
  parent_session_id: string | null;
  manager_mode: ManagerMode | null;
  agent_thread_id: string | null;
  pid: number | null;
  status: SessionStatus;
  last_assistant_message: string | null;
  last_event_at: string | null;
  pull_request_url: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicSession = Omit<Session, "worktree_path" | "workspace_uri" | "agent_thread_id" | "pid">;

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
    parent_session_id: session.parent_session_id,
    manager_mode: session.manager_mode,
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
  if (event.payload.kind === "tool_result") {
    return {
      ...event,
      payload: {
        ...event.payload,
        result: truncatePublicPayload(event.payload.result)
      }
    };
  }
  if (event.payload.kind !== "session_started") {
    return event as PublicSessionEvent;
  }
  const { worktreePath: _worktreePath, ...payload } = event.payload;
  return {
    ...event,
    payload
  };
}

/** Truncates large public event payload fields. */
function truncatePublicPayload(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 4096 ? `${value.slice(0, 4096)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.map(truncatePublicPayload);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, truncatePublicPayload(entry)]));
  }
  return value;
}
