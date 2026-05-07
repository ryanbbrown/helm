import { Archive, ExternalLink, Play, RefreshCw, Square } from "lucide-react";
import type { PublicSession } from "@helm/core";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";

type HeaderProps = {
  session: PublicSession | null;
  onRefresh: () => void;
  onResume?: () => void;
  onStop: () => void;
  onArchive?: () => void;
};

/** Renders the top bar for the active session. */
export function Header({ session, onRefresh, onResume, onStop, onArchive }: HeaderProps) {
  return (
    <div className="detail-header">
      <div className="detail-heading">
        <div className="title">{session ? `${session.manager_mode ? "manager" : session.repo_name} / ${session.agent_name}` : "Helm"}</div>
        <div className="branch">{session?.manager_mode ? `mode: ${session.manager_mode}` : session?.branch ?? "Local coding-agent sessions"}</div>
      </div>
      <div className="detail-actions">
        {session?.pull_request_url ? (
          <a className="button-link" href={session.pull_request_url} rel="noreferrer" target="_blank">
            <ExternalLink size={15} />
            PR open
          </a>
        ) : null}
        {session ? <StatusBadge status={session.status} /> : null}
        {session?.status === "interrupted" && onResume ? (
          <Button variant="primary" type="button" onClick={onResume}>
            <Play size={15} />
            Resume
          </Button>
        ) : null}
        <IconButton label="Refresh session" onClick={onRefresh}>
          <RefreshCw size={16} />
        </IconButton>
        <IconButton label="Stop session" disabled={!session || ["archived", "failed", "interrupted", "stopped"].includes(session.status)} onClick={onStop}>
          <Square size={15} />
        </IconButton>
        {onArchive ? (
          <Button variant="ghost" type="button" disabled={!session || session.status === "archived"} onClick={onArchive}>
            <Archive size={15} />
            Archive
          </Button>
        ) : null}
      </div>
    </div>
  );
}
