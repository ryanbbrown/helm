import { useEffect, useRef } from "react";
import type { PublicSession } from "@helm/core";
import { StatusBadge } from "./StatusBadge";

type SessionListProps = {
  sessions: PublicSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

/** Renders the session navigation list. */
export function SessionList({ sessions, selectedId, onSelect }: SessionListProps) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <div className="session-list" role="list">
      {sessions.length === 0 ? <div className="empty-list">No matching sessions.</div> : null}
      {sessions.map((session) => (
        <button
          aria-current={selectedId === session.id ? "page" : undefined}
          key={session.id}
          ref={selectedId === session.id ? selectedRef : undefined}
          className="session-row"
          type="button"
          onClick={() => onSelect(session.id)}
        >
          <div className="row-top">
            <strong>{session.manager_mode ? "manager" : session.repo_name}</strong>
            <StatusBadge status={session.status} />
          </div>
          <div className="branch">{session.branch ?? (session.manager_mode ? `mode: ${session.manager_mode}` : "no branch")}</div>
          <div className="row-meta">
            <span>{session.agent_name}</span>
            {session.parent_session_id ? <span>child</span> : null}
            {session.last_assistant_message ? <span>{session.last_assistant_message}</span> : null}
          </div>
        </button>
      ))}
    </div>
  );
}
