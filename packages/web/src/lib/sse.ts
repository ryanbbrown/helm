"use client";

import { useEffect } from "react";
import type { Session, SessionEvent } from "@helm/core";
import { API_BASE } from "./api";

/** Subscribes to all session and event updates. */
export function useAllSessionsStream(onSession: (session: Session) => void, onEvent: (event: SessionEvent) => void): void {
  useEffect(() => {
    const source = new EventSource(`${API_BASE}/sessions/events`);
    source.addEventListener("session", (event) => onSession(JSON.parse((event as MessageEvent).data) as Session));
    source.addEventListener("event", (event) => onEvent(JSON.parse((event as MessageEvent).data) as SessionEvent));
    return () => source.close();
  }, [onEvent, onSession]);
}

/** Subscribes to updates for one session. */
export function useSessionEvents(sessionId: string | null, onSession: (session: Session) => void, onEvent: (event: SessionEvent) => void): void {
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const source = new EventSource(`${API_BASE}/sessions/${sessionId}/events`);
    source.addEventListener("session", (event) => onSession(JSON.parse((event as MessageEvent).data) as Session));
    source.addEventListener("event", (event) => onEvent(JSON.parse((event as MessageEvent).data) as SessionEvent));
    return () => source.close();
  }, [onEvent, onSession, sessionId]);
}
