import { readFileSync } from "node:fs";
import { tokenPath } from "@helm/core";
import type { PublicSession, PublicSessionEvent } from "@helm/core";

const DEFAULT_PORT = "7878";

export type SessionDetail = {
  session: PublicSession;
  events: PublicSessionEvent[];
};

export class DaemonClient {
  /** Creates a daemon HTTP client. */
  constructor(private baseUrl = `http://127.0.0.1:${Bun.env.HELM_PORT ?? DEFAULT_PORT}`) {}

  /** Checks whether the daemon is reachable. */
  async isUp(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/health`).catch(() => null);
    return response?.ok ?? false;
  }

  /** Creates a session through the daemon. */
  async create(repo: string, agent: string, prompt?: string, options: { manager_mode?: "approval" | "autopilot"; parent_session_id?: string } = {}): Promise<PublicSession> {
    return this.request("/sessions", { method: "POST", body: JSON.stringify({ repo, agent, prompt, ...options }) });
  }

  /** Lists daemon sessions. */
  async list(parent?: string): Promise<PublicSession[]> {
    return this.request(parent ? `/sessions?parent=${encodeURIComponent(parent)}` : "/sessions");
  }

  /** Reads the singleton manager session. */
  async manager(): Promise<PublicSession> {
    return this.request("/manager");
  }

  /** Reads one daemon session and its events. */
  async show(id: string): Promise<SessionDetail> {
    return this.request(`/sessions/${id}`);
  }

  /** Sends a follow-up through the daemon. */
  async send(id: string, text: string): Promise<PublicSession> {
    return this.request(`/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  }

  /** Resumes an interrupted daemon session. */
  async resume(id: string): Promise<PublicSession> {
    return this.request(`/sessions/${id}/resume`, { method: "POST" });
  }

  /** Stops a daemon session. */
  async stop(id: string): Promise<PublicSession> {
    return this.request(`/sessions/${id}/stop`, { method: "POST" });
  }

  /** Archives a daemon session. */
  async archive(id: string, force = false): Promise<PublicSession> {
    return this.request(`/sessions/${id}/archive`, { method: "POST", body: JSON.stringify({ force }) });
  }

  /** Updates a manager's operating mode. */
  async setManagerMode(id: string, manager_mode: "approval" | "autopilot"): Promise<PublicSession> {
    return this.request(`/sessions/${id}/manager-mode`, { method: "PATCH", body: JSON.stringify({ manager_mode }) });
  }

  /** Approves one manager tool call. */
  async approveToolCall(id: string, toolCallId: string): Promise<void> {
    await this.request(`/sessions/${id}/tool-calls/${toolCallId}/approve`, { method: "POST" });
  }

  /** Denies one manager tool call. */
  async denyToolCall(id: string, toolCallId: string): Promise<void> {
    await this.request(`/sessions/${id}/tool-calls/${toolCallId}/deny`, { method: "POST" });
  }

  /** Streams session events through SSE. */
  async *streamEvents(id: string): AsyncIterable<PublicSessionEvent> {
    const response = await fetch(`${this.baseUrl}/sessions/${id}/events`, {
      headers: this.authHeaders()
    });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to stream events for ${id}`);
    }
    for await (const event of parseSse(response.body)) {
      if (event.name === "event") {
        yield JSON.parse(event.data) as PublicSessionEvent;
      }
    }
  }

  /** Sends one JSON request to the daemon. */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
        ...init.headers
      }
    });
    const value = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new Error(value.error ?? `HTTP ${response.status}`);
    }
    return value as T;
  }

  /** Returns daemon auth headers for protected endpoints. */
  private authHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${readFileSync(tokenPath(), "utf8").trim()}`
    };
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
