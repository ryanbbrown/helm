"use client";

import type { PublicSession, PublicSessionEvent } from "@helm/core";
import { useState } from "react";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { MessageTimeline } from "./MessageTimeline";
import { ResizableSplit } from "./ResizableSplit";
import { SessionDiff } from "./SessionDiff";

type SessionDetailProps = {
  session: PublicSession;
  events: PublicSessionEvent[];
  diffRefreshToken: number;
  onRefresh: () => void;
  onResume: () => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onSessionUpdate: (session: PublicSession) => void;
  onApproveToolCall: (toolCallId: string) => void;
  onDenyToolCall: (toolCallId: string) => void;
};

/** Renders the selected session detail pane. */
export function SessionDetail({ session, events, diffRefreshToken, onRefresh, onResume, onSend, onStop, onSessionUpdate, onApproveToolCall, onDenyToolCall }: SessionDetailProps) {
  const [showDiff, setShowDiff] = useState(false);
  const timeline = <MessageTimeline events={events} onApproveToolCall={onApproveToolCall} onDenyToolCall={onDenyToolCall} />;
  const canShowDiff = !session.manager_mode;
  return (
    <div className="detail">
      <Header session={session} showDiff={showDiff} onRefresh={onRefresh} onResume={onResume} onStop={onStop} onToggleDiff={canShowDiff ? () => setShowDiff((current) => !current) : undefined} />
      {showDiff && canShowDiff ? (
        <ResizableSplit
          storageKey={`helm.diffSplit.${session.id}`}
          left={timeline}
          right={<SessionDiff session={session} events={events} diffRefreshToken={diffRefreshToken} onSessionUpdate={onSessionUpdate} />}
        />
      ) : timeline}
      <Composer disabled={["archived", "failed", "interrupted", "stopped"].includes(session.status)} onSend={onSend} />
    </div>
  );
}
