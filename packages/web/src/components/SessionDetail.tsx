import type { Session, SessionEvent } from "@helm/core";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { MessageTimeline } from "./MessageTimeline";

type SessionDetailProps = {
  session: Session;
  events: SessionEvent[];
  onRefresh: () => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
};

/** Renders the selected session detail pane. */
export function SessionDetail({ session, events, onRefresh, onSend, onStop }: SessionDetailProps) {
  return (
    <div className="detail">
      <Header session={session} onRefresh={onRefresh} onStop={onStop} />
      <MessageTimeline events={events} />
      <Composer disabled={session.status === "archived" || session.status === "failed"} onSend={onSend} />
    </div>
  );
}
