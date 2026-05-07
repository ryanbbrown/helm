"use client";

import { GitCompare, MessageSquare } from "lucide-react";
import type { PublicSession, PublicSessionEvent } from "@helm/core";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { MessageTimeline } from "./MessageTimeline";
import { ResizableSplit } from "./ResizableSplit";
import { SessionDiff } from "./SessionDiff";

type SessionDetailProps = {
  session: PublicSession;
  events: PublicSessionEvent[];
  diffRefreshToken: number;
  showDiff: boolean;
  onRefresh: () => void;
  onResume: () => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onArchive: () => void;
  onToggleDiff: () => void;
  onSessionUpdate: (session: PublicSession) => void;
  onApproveToolCall: (toolCallId: string) => void;
  onDenyToolCall: (toolCallId: string) => void;
};

/** Renders the selected session detail pane. */
export function SessionDetail({
  session,
  events,
  diffRefreshToken,
  showDiff,
  onRefresh,
  onResume,
  onSend,
  onStop,
  onArchive,
  onToggleDiff,
  onSessionUpdate,
  onApproveToolCall,
  onDenyToolCall
}: SessionDetailProps) {
  const timeline = <MessageTimeline sessionId={session.id} events={events} onApproveToolCall={onApproveToolCall} onDenyToolCall={onDenyToolCall} />;
  const canShowDiff = !session.manager_mode;
  return (
    <div className="detail">
      <Header session={session} onRefresh={onRefresh} onResume={onResume} onStop={onStop} onArchive={onArchive} />
      <div className="detail-tabs" role="tablist" aria-label="Session views">
        <button aria-selected={!showDiff} className={!showDiff ? "active" : ""} type="button" onClick={showDiff ? onToggleDiff : undefined}>
          <MessageSquare size={15} />
          Chat
        </button>
        {canShowDiff ? (
          <button aria-selected={showDiff} className={showDiff ? "active" : ""} type="button" onClick={showDiff ? undefined : onToggleDiff}>
            <GitCompare size={15} />
            Diff
          </button>
        ) : null}
      </div>
      <div className="detail-body">
        {showDiff && canShowDiff ? (
          <ResizableSplit
            storageKey={`helm.diffSplit.${session.id}`}
            left={timeline}
            right={<SessionDiff session={session} events={events} diffRefreshToken={diffRefreshToken} onSessionUpdate={onSessionUpdate} />}
          />
        ) : timeline}
      </div>
      <Composer disabled={["archived", "failed", "interrupted", "stopped"].includes(session.status)} label="Follow-up message" onSubmit={onSend} placeholder="Send a follow-up" />
    </div>
  );
}
