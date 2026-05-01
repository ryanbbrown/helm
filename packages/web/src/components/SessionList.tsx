import type { PublicSession } from "@helm/core";
import { StatusBadge } from "./StatusBadge";

type SessionListProps = {
  sessions: PublicSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

/** Renders the session navigation list. */
export function SessionList({ sessions, selectedId, onSelect }: SessionListProps) {
  return (
    <div className="session-list">
      {sessions.length === 0 ? <div className="muted" style={{ padding: 8 }}>No sessions yet.</div> : null}
      {sessions.map((session) => (
        <button key={session.id} className={`session-row ${selectedId === session.id ? "active" : ""}`} type="button" onClick={() => onSelect(session.id)}>
          <div className="row-top">
            <strong>{session.repo_name}</strong>
            <StatusBadge status={session.status} />
          </div>
          <div className="branch">{session.branch}</div>
          <div className="muted">{session.agent_name}</div>
        </button>
      ))}
    </div>
  );
}
