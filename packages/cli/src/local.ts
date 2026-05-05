import { SessionManager } from "@helm/daemon";
import type { Session, SessionEvent } from "@helm/core";

type LocalManagerOptions = {
  reconcileInProcessSessions?: boolean;
};

/** Creates a local in-process manager. */
export function createLocalManager(options: LocalManagerOptions = {}): SessionManager {
  return new SessionManager({ reconcileInProcessSessions: options.reconcileInProcessSessions ?? false });
}

/** Streams events for a local session manager. */
export async function* streamLocalEvents(manager: SessionManager, sessionId: string): AsyncIterable<SessionEvent> {
  for (const event of manager.listEvents(sessionId)) {
    yield event;
  }
  const queue: SessionEvent[] = [];
  let resolve: (() => void) | null = null;
  const unsubscribe = manager.subscribe((event) => {
    if (event.type === "event" && event.event.session_id === sessionId) {
      queue.push(event.event);
      resolve?.();
      resolve = null;
    }
  });
  try {
    while (true) {
      const value = queue.shift();
      if (value) {
        yield value;
        continue;
      }
      await new Promise<void>((next) => {
        resolve = next;
      });
    }
  } finally {
    unsubscribe();
  }
}

/** Sends a follow-up using an active local manager. */
export async function sendLocal(manager: SessionManager, session: Session, text: string): Promise<Session> {
  return manager.send(session.id, text);
}
