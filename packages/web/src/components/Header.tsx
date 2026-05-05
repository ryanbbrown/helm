import { ExternalLink, GitCompare, Play, RefreshCw, Square } from "lucide-react";
import type { PublicSession } from "@helm/core";
import { StatusBadge } from "./StatusBadge";

type HeaderProps = {
  session: PublicSession | null;
  onRefresh: () => void;
  onResume?: () => void;
  onStop: () => void;
  showDiff?: boolean;
  onToggleDiff?: () => void;
};

/** Renders the top bar for the active session. */
export function Header({ session, onRefresh, onResume, onStop, showDiff = false, onToggleDiff }: HeaderProps) {
  return (
    <div className="header">
      <div>
        <div className="title">{session ? `${session.manager_mode ? "manager" : session.repo_name} / ${session.agent_name}` : "Helm"}</div>
        <div className="branch">{session?.manager_mode ? `mode: ${session.manager_mode}` : session?.branch ?? "Local coding-agent sessions"}</div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {session?.pull_request_url ? (
          <a className="button-link" href={session.pull_request_url} rel="noreferrer" target="_blank">
            <ExternalLink size={15} />
            PR open
          </a>
        ) : null}
        {session ? <StatusBadge status={session.status} /> : null}
        {session && onToggleDiff ? (
          <button type="button" className={showDiff ? "active-button" : ""} onClick={onToggleDiff}>
            <GitCompare size={15} />
            {showDiff ? "Hide diff" : "Show diff"}
          </button>
        ) : null}
        {session?.status === "interrupted" && onResume ? (
          <button type="button" onClick={onResume}>
            <Play size={15} />
            Resume
          </button>
        ) : null}
        <button className="icon" type="button" title="Refresh" onClick={onRefresh}>
          <RefreshCw size={16} />
        </button>
        <button className="icon" type="button" title="Stop" disabled={!session || session.status === "interrupted"} onClick={onStop}>
          <Square size={15} />
        </button>
      </div>
    </div>
  );
}
