import type { ChildEvent, PublicSessionEvent, ToolInvocationEvent } from "@helm/core";

type MessageTimelineProps = {
  events: PublicSessionEvent[];
  onApproveToolCall?: (toolCallId: string) => void;
  onDenyToolCall?: (toolCallId: string) => void;
};

/** Renders the surfaced message timeline for a session. */
export function MessageTimeline({ events, onApproveToolCall, onDenyToolCall }: MessageTimelineProps) {
  const resolvedToolCalls = new Set(events.flatMap((event) => event.payload.kind === "tool_call_resolved" ? [event.payload.toolCallId] : []));
  const visible = events.filter((event) =>
    ["session_started", "session_resumed", "user_message", "thinking", "assistant_message", "tool_invocation", "tool_call_resolved", "tool_result", "child_event", "error", "exit"].includes(event.kind)
  );
  return (
    <div className="timeline">
      {visible.map((event) => {
        if (event.kind === "user_message" && "text" in event.payload) {
          return <div className="message user" data-testid="user-message" key={event.id}>{event.payload.text}</div>;
        }
        if (event.kind === "assistant_message" && "text" in event.payload) {
          return <div className="message assistant" data-testid="assistant-message" key={event.id}>{event.payload.text}</div>;
        }
        if (event.kind === "error" && "message" in event.payload) {
          return <div className="event-line" key={event.id}>Error: {event.payload.message}</div>;
        }
        if (event.kind === "thinking") {
          return <div className="event-line" key={event.id}>Thinking...</div>;
        }
        if (event.kind === "session_started") {
          return <div className="event-line" key={event.id}>Session started.</div>;
        }
        if (event.kind === "session_resumed") {
          return <div className="event-line" key={event.id}>Session resumed.</div>;
        }
        if (event.payload.kind === "tool_invocation") {
          const payload = event.payload;
          return (
            <div className="event-line tool-call" key={event.id}>
              <div>
                Tool {payload.status}: {toolCallSummary(payload)}
              </div>
              {payload.status === "pending" && !resolvedToolCalls.has(payload.toolCallId) ? (
                <span className="tool-call-actions">
                  <button type="button" onClick={() => onApproveToolCall?.(payload.toolCallId)}>Approve</button>
                  <button type="button" onClick={() => onDenyToolCall?.(payload.toolCallId)}>Deny</button>
                </span>
              ) : null}
              <details className="tool-call-raw">
                <summary>Raw arguments</summary>
                <pre>{JSON.stringify(payload.arguments, null, 2)}</pre>
              </details>
            </div>
          );
        }
        if (event.payload.kind === "tool_call_resolved") {
          return <div className="event-line" key={event.id}>Tool {event.payload.approved ? "approved" : "denied"}.</div>;
        }
        if (event.payload.kind === "tool_result") {
          return <div className="event-line" key={event.id}>Tool result: {event.payload.toolName} {event.payload.ok ? "ok" : event.payload.errorMessage}</div>;
        }
        if (event.payload.kind === "child_event") {
          return <div className="event-line child-lifecycle" data-testid="child-lifecycle" key={event.id}>{childEventText(event.payload)}</div>;
        }
        return <div className="event-line" key={event.id}>{event.kind}</div>;
      })}
    </div>
  );
}

/** Formats a manager tool invocation as a readable one-line summary. */
function toolCallSummary(payload: ToolInvocationEvent): string {
  const args = payload.arguments;
  if (payload.toolName === "create_child_session") {
    return `create child session in ${value(args.repo)} with ${value(args.agent)}`;
  }
  if (payload.toolName === "create_child_from_session") {
    return `create child from session ${value(args.sourceSessionId)} with ${value(args.agent)}, new branch ${value(args.branchName, "auto")}`;
  }
  if (payload.toolName === "create_child_from_branch") {
    return `create child from branch ${value(args.sourceBranch ?? args.branch)} in ${value(args.repo)} with ${value(args.agent)}, new branch ${value(args.newBranchName ?? args.branchName, "auto")}`;
  }
  if (payload.toolName === "pass_file_content") {
    return `pass ${value(args.path)} from ${value(args.fromSessionId)} to ${value(args.toSessionId)}`;
  }
  if (payload.toolName === "send_message") {
    return `send message to child ${value(args.sessionId)}`;
  }
  if (payload.toolName === "read_diff") {
    return `read ${value(args.base, "branch")} diff from child ${value(args.sessionId)}`;
  }
  if (payload.toolName === "stop_child") {
    return `stop child ${value(args.sessionId)}`;
  }
  if (payload.toolName === "read_file") {
    return `read ${value(args.path)} from child ${value(args.sessionId)}`;
  }
  return payload.toolName;
}

/** Formats a manager-observed child event for the timeline. */
function childEventText(event: ChildEvent): string {
  if (event.childKind === "awaiting_input") {
    return `Child session ${event.childId} reached awaiting input`;
  }
  if (event.childKind === "failed") {
    return `Child session ${event.childId} failed`;
  }
  if (event.childKind === "stopped") {
    return `Child session ${event.childId} stopped`;
  }
  if (event.childKind === "completed") {
    return `Child session ${event.childId} completed`;
  }
  if (event.childKind === "spawned") {
    return `Child session ${event.childId} spawned${event.detail ? `: ${event.detail}` : ""}`;
  }
  if (event.childKind === "message_sent") {
    return `Message sent to child session ${event.childId}${event.detail ? `: ${event.detail}` : ""}`;
  }
  if (event.childKind === "error") {
    return `Child session ${event.childId} error${event.detail ? `: ${event.detail}` : ""}`;
  }
  return `Child session ${event.childId}${event.detail ? `: ${event.detail}` : ""}`;
}

/** Coerces a tool argument into compact display text. */
function value(input: unknown, fallback = "unknown"): string {
  return typeof input === "string" && input.trim() ? input : fallback;
}
