import type { NormalizedEvent, SessionEventKind } from "./events";

export type SessionStatus =
  | "created"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
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
  created_at: string;
  updated_at: string;
};

export type SessionEvent = {
  id: number;
  session_id: string;
  kind: SessionEventKind;
  payload: NormalizedEvent;
  created_at: string;
};
