import type { PublicSessionEvent } from "@helm/core";

type MessageTimelineProps = {
  events: PublicSessionEvent[];
  onApproveToolCall?: (toolCallId: string) => void;
  onDenyToolCall?: (toolCallId: string) => void;
};

/** Renders the surfaced message timeline for a session. */
export function MessageTimeline({ events, onApproveToolCall, onDenyToolCall }: MessageTimelineProps) {
  const resolvedToolCalls = new Set(events.flatMap((event) => event.payload.kind === "tool_call_resolved" ? [event.payload.toolCallId] : []));
  const visible = events.filter((event) =>
    ["session_started", "user_message", "thinking", "assistant_message", "tool_invocation", "tool_call_resolved", "tool_result", "child_event", "error", "exit"].includes(event.kind)
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
        if (event.payload.kind === "tool_invocation") {
          const payload = event.payload;
          return (
            <div className="event-line" key={event.id}>
              Tool {payload.status}: {payload.toolName}
              {payload.status === "pending" && !resolvedToolCalls.has(payload.toolCallId) ? (
                <span style={{ display: "inline-flex", gap: 6, marginLeft: 8 }}>
                  <button type="button" onClick={() => onApproveToolCall?.(payload.toolCallId)}>Approve</button>
                  <button type="button" onClick={() => onDenyToolCall?.(payload.toolCallId)}>Deny</button>
                </span>
              ) : null}
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
          return <div className="event-line" key={event.id}>Child {event.payload.childKind}: {event.payload.childId}</div>;
        }
        return <div className="event-line" key={event.id}>{event.kind}</div>;
      })}
    </div>
  );
}
