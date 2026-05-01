export type SessionEventKind =
  | "session_started"
  | "user_message"
  | "thinking"
  | "assistant_message"
  | "turn_complete"
  | "error"
  | "exit";

export type SessionStartedEvent = {
  kind: "session_started";
  sessionId: string;
  repo: string;
  branch: string;
  worktreePath: string;
};

export type ThinkingEvent = {
  kind: "thinking";
  message?: string;
};

export type UserMessageEvent = {
  kind: "user_message";
  text: string;
};

export type AssistantMessageEvent = {
  kind: "assistant_message";
  text: string;
};

export type TurnCompleteEvent = {
  kind: "turn_complete";
};

export type ErrorEvent = {
  kind: "error";
  message: string;
  payload?: unknown;
};

export type ExitEvent = {
  kind: "exit";
  code: number | null;
};

export type NormalizedEvent =
  | SessionStartedEvent
  | UserMessageEvent
  | ThinkingEvent
  | AssistantMessageEvent
  | TurnCompleteEvent
  | ErrorEvent
  | ExitEvent;

export type PublicSessionStartedEvent = Omit<SessionStartedEvent, "worktreePath">;

export type PublicNormalizedEvent =
  | PublicSessionStartedEvent
  | UserMessageEvent
  | ThinkingEvent
  | AssistantMessageEvent
  | TurnCompleteEvent
  | ErrorEvent
  | ExitEvent;
