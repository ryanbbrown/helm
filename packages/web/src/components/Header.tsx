import { RefreshCw, Square } from "lucide-react";
import type { Session } from "@helm/core";
import { StatusBadge } from "./StatusBadge";

type HeaderProps = {
  session: Session | null;
  onRefresh: () => void;
  onStop: () => void;
};

/** Renders the top bar for the active session. */
export function Header({ session, onRefresh, onStop }: HeaderProps) {
  return (
    <div className="header">
      <div>
        <div className="title">{session ? `${session.repo_name} / ${session.agent_name}` : "Helm"}</div>
        <div className="branch">{session?.branch ?? "Local coding-agent sessions"}</div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {session ? <StatusBadge status={session.status} /> : null}
        <button className="icon" type="button" title="Refresh" onClick={onRefresh}>
          <RefreshCw size={16} />
        </button>
        <button className="icon" type="button" title="Stop" disabled={!session} onClick={onStop}>
          <Square size={15} />
        </button>
      </div>
    </div>
  );
}
