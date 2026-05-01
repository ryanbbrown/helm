import type { DiffChangedHint, Session, SessionEvent } from "@helm/core";

export type BusEvent =
  | { type: "session"; session: Session }
  | { type: "event"; event: SessionEvent }
  | { type: "hint"; hint: DiffChangedHint };

type Listener = (event: BusEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  /** Publishes an event to current subscribers. */
  publish(event: BusEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Subscribes to bus events and returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
