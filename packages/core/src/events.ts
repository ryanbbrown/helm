export type SessionEventKind =
  | "session_started"
  | "session_resumed"
  | "user_message"
  | "thinking"
  | "assistant_message"
  | "tool_invocation"
  | "tool_call_resolved"
  | "tool_result"
  | "child_event"
  | "turn_complete"
  | "error"
  | "exit";

export type SessionStartedEvent = {
  kind: "session_started";
  sessionId: string;
  repo: string;
  branch: string | null;
  worktreePath: string | null;
};

export type SessionResumedEvent = {
  kind: "session_resumed";
  sessionId: string;
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

export type ToolInvocationEvent = {
  kind: "tool_invocation";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: "auto" | "pending";
};

export type ToolCallResolvedEvent = {
  kind: "tool_call_resolved";
  toolCallId: string;
  approved: boolean;
  resolvedBy: "user";
};

export type ToolResultEvent = {
  kind: "tool_result";
  toolCallId: string;
  toolName: string;
  ok: boolean;
  result: unknown;
  errorMessage?: string;
};

export type ChildEventKind = "spawned" | "message_sent" | "awaiting_input" | "completed" | "failed" | "stopped" | "error" | "notice";

export type ChildEvent = {
  kind: "child_event";
  childKind: ChildEventKind;
  childId: string;
  detail?: string;
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
  | SessionResumedEvent
  | UserMessageEvent
  | ThinkingEvent
  | AssistantMessageEvent
  | ToolInvocationEvent
  | ToolCallResolvedEvent
  | ToolResultEvent
  | ChildEvent
  | TurnCompleteEvent
  | ErrorEvent
  | ExitEvent;

export type PublicSessionStartedEvent = Omit<SessionStartedEvent, "worktreePath">;

export type PublicNormalizedEvent =
  | PublicSessionStartedEvent
  | SessionResumedEvent
  | UserMessageEvent
  | ThinkingEvent
  | AssistantMessageEvent
  | ToolInvocationEvent
  | ToolCallResolvedEvent
  | ToolResultEvent
  | ChildEvent
  | TurnCompleteEvent
  | ErrorEvent
  | ExitEvent;
