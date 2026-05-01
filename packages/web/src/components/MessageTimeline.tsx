import type { PublicSessionEvent } from "@helm/core";

/** Renders the surfaced message timeline for a session. */
export function MessageTimeline({ events }: { events: PublicSessionEvent[] }) {
  const visible = events.filter((event) => ["session_started", "user_message", "thinking", "assistant_message", "error", "exit"].includes(event.kind));
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
        return <div className="event-line" key={event.id}>{event.kind}</div>;
      })}
    </div>
  );
}
