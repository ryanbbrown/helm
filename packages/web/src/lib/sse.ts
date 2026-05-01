"use client";

import { useEffect } from "react";
import type { PublicSession, PublicSessionEvent } from "@helm/core";
import { sseUrl } from "./api";

/** Subscribes to all session and event updates. */
export function useAllSessionsStream(onSession: (session: PublicSession) => void, onEvent: (event: PublicSessionEvent) => void): void {
  useEffect(() => {
    const source = new EventSource(sseUrl("/sessions/events"));
    source.addEventListener("session", (event) => onSession(JSON.parse((event as MessageEvent).data) as PublicSession));
    source.addEventListener("event", (event) => onEvent(JSON.parse((event as MessageEvent).data) as PublicSessionEvent));
    return () => source.close();
  }, [onEvent, onSession]);
}

/** Subscribes to updates for one session. */
export function useSessionEvents(sessionId: string | null, onSession: (session: PublicSession) => void, onEvent: (event: PublicSessionEvent) => void): void {
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const source = new EventSource(sseUrl(`/sessions/${sessionId}/events`));
    source.addEventListener("session", (event) => onSession(JSON.parse((event as MessageEvent).data) as PublicSession));
    source.addEventListener("event", (event) => onEvent(JSON.parse((event as MessageEvent).data) as PublicSessionEvent));
    return () => source.close();
  }, [onEvent, onSession, sessionId]);
}
