import type { Session, SessionEvent } from "@helm/core";

const DEFAULT_BASE_URL = `http://127.0.0.1:${Bun.env.HELM_PORT ?? "7878"}`;

export type SessionDetail = {
  session: Session;
  events: SessionEvent[];
};

export class DaemonClient {
  /** Creates a daemon HTTP client. */
  constructor(private baseUrl = DEFAULT_BASE_URL) {}

  /** Checks whether the daemon is reachable. */
  async isUp(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/health`).catch(() => null);
    return response?.ok ?? false;
  }

  /** Creates a session through the daemon. */
  async create(repo: string, agent: string, prompt?: string): Promise<Session> {
    return this.request("/sessions", { method: "POST", body: JSON.stringify({ repo, agent, prompt }) });
  }

  /** Lists daemon sessions. */
  async list(): Promise<Session[]> {
    return this.request("/sessions");
  }

  /** Reads one daemon session and its events. */
  async show(id: string): Promise<SessionDetail> {
    return this.request(`/sessions/${id}`);
  }

  /** Sends a follow-up through the daemon. */
  async send(id: string, text: string): Promise<Session> {
    return this.request(`/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  }

  /** Stops a daemon session. */
  async stop(id: string): Promise<Session> {
    return this.request(`/sessions/${id}/stop`, { method: "POST" });
  }

  /** Archives a daemon session. */
  async archive(id: string): Promise<Session> {
    return this.request(`/sessions/${id}/archive`, { method: "POST" });
  }

  /** Streams session events through SSE. */
  async *streamEvents(id: string): AsyncIterable<SessionEvent> {
    const response = await fetch(`${this.baseUrl}/sessions/${id}/events`);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to stream events for ${id}`);
    }
    for await (const event of parseSse(response.body)) {
      if (event.name === "event") {
        yield JSON.parse(event.data) as SessionEvent;
      }
    }
  }

  /** Sends one JSON request to the daemon. */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers
      }
    });
    const value = await response.json();
    if (!response.ok) {
      throw new Error(value.error ?? `HTTP ${response.status}`);
    }
    return value as T;
  }
}

/** Parses a minimal SSE stream. */
async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<{ name: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const raw of events) {
      const lines = raw.split("\n");
      const name = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (data) {
        yield { name, data };
      }
    }
  }
}
