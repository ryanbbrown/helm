"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ChildEvent, PublicSessionEvent, ToolInvocationEvent } from "@helm/core";
import { Button } from "./ui/Button";

type MessageTimelineProps = {
  sessionId: string;
  events: PublicSessionEvent[];
  onApproveToolCall?: (toolCallId: string) => void;
  onDenyToolCall?: (toolCallId: string) => void;
};

const VISIBLE_EVENT_KINDS = ["session_started", "session_resumed", "user_message", "thinking", "assistant_message", "tool_invocation", "tool_call_resolved", "tool_result", "child_event", "error", "exit"];

/** Renders the surfaced message timeline for a session. */
export function MessageTimeline({ sessionId, events, onApproveToolCall, onDenyToolCall }: MessageTimelineProps) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottom = useRef(true);
  const resolvedToolCalls = useMemo(() => new Set(events.flatMap((event) => event.payload.kind === "tool_call_resolved" ? [event.payload.toolCallId] : [])), [events]);
  const visible = useMemo(() => events.filter((event) => VISIBLE_EVENT_KINDS.includes(event.kind)), [events]);
  const lastVisibleId = visible.at(-1)?.id;

  useEffect(() => {
    shouldStickToBottom.current = true;
    const node = timelineRef.current;
    node?.scrollTo({ top: node.scrollHeight });
  }, [sessionId]);

  useEffect(() => {
    if (!shouldStickToBottom.current) {
      return;
    }
    const node = timelineRef.current;
    node?.scrollTo({ top: node.scrollHeight });
  }, [lastVisibleId]);

  /** Tracks whether new events should keep the timeline pinned. */
  function onScroll(): void {
    const node = timelineRef.current;
    if (!node) {
      return;
    }
    shouldStickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }

  return (
    <div className="timeline" ref={timelineRef} onScroll={onScroll}>
      {visible.length === 0 ? <div className="timeline-empty">No surfaced events yet.</div> : null}
      {visible.map((event) => renderTimelineEvent(event, resolvedToolCalls, onApproveToolCall, onDenyToolCall))}
    </div>
  );
}

/** Renders one timeline event row. */
function renderTimelineEvent(
  event: PublicSessionEvent,
  resolvedToolCalls: Set<string>,
  onApproveToolCall?: (toolCallId: string) => void,
  onDenyToolCall?: (toolCallId: string) => void
) {
  if (event.kind === "user_message" && event.payload.kind === "user_message") {
    return <MessageBubble event={event} key={event.id} role="user" text={event.payload.text} />;
  }
  if (event.kind === "assistant_message" && event.payload.kind === "assistant_message") {
    return <MessageBubble event={event} key={event.id} role="assistant" text={event.payload.text} />;
  }
  if (event.kind === "error" && event.payload.kind === "error") {
    return <EventLine event={event} key={event.id} tone="error" text={`Error: ${event.payload.message}`} />;
  }
  if (event.kind === "thinking") {
    return <EventLine event={event} key={event.id} text="Thinking..." />;
  }
  if (event.kind === "session_started") {
    return <EventLine event={event} key={event.id} text="Session started." />;
  }
  if (event.kind === "session_resumed") {
    return <EventLine event={event} key={event.id} text="Session resumed." />;
  }
  if (event.kind === "exit" && event.payload.kind === "exit") {
    return <EventLine event={event} key={event.id} tone={event.payload.code === 0 ? "muted" : "error"} text={`Exited with code ${event.payload.code ?? "unknown"}.`} />;
  }
  if (event.payload.kind === "tool_invocation") {
    const payload = event.payload;
    return (
      <div className="event-line tool-call" key={event.id}>
        <div className="event-meta">{formatTime(event.created_at)} · tool</div>
        <div>Tool {payload.status}: {toolCallSummary(payload)}</div>
        {payload.status === "pending" && !resolvedToolCalls.has(payload.toolCallId) ? (
          <span className="tool-call-actions">
            <Button size="sm" type="button" onClick={() => onApproveToolCall?.(payload.toolCallId)}>Approve</Button>
            <Button size="sm" type="button" onClick={() => onDenyToolCall?.(payload.toolCallId)}>Deny</Button>
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
    return <EventLine event={event} key={event.id} text={`Tool ${event.payload.approved ? "approved" : "denied"}.`} />;
  }
  if (event.payload.kind === "tool_result") {
    return <EventLine event={event} key={event.id} text={`Tool result: ${event.payload.toolName} ${event.payload.ok ? "ok" : event.payload.errorMessage}`} />;
  }
  if (event.payload.kind === "child_event") {
    return <EventLine event={event} key={event.id} testId="child-lifecycle" text={childEventText(event.payload)} />;
  }
  return <EventLine event={event} key={event.id} text={event.kind} />;
}

/** Renders one chat message bubble. */
function MessageBubble({ event, role, text }: { event: PublicSessionEvent; role: "assistant" | "user"; text: string }) {
  return (
    <article className={`message ${role}`} data-testid={`${role}-message`}>
      <div className="message-meta">{role} · {formatTime(event.created_at)}</div>
      <div>{text}</div>
    </article>
  );
}

/** Renders one compact operational event row. */
function EventLine({ event, text, tone = "muted", testId }: { event: PublicSessionEvent; text: string; tone?: "muted" | "error"; testId?: string }) {
  return (
    <div className={`event-line event-line-${tone}`} data-testid={testId}>
      <span className="event-meta">{formatTime(event.created_at)}</span>
      <span>{text}</span>
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

/** Formats an event timestamp for dense display. */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
