import type { AgentConfig, RepoConfig, Session, SessionEvent } from "@helm/core";

export const API_BASE = process.env.NEXT_PUBLIC_HELM_API_URL ?? "http://127.0.0.1:7878";

export type SessionDetail = {
  session: Session;
  events: SessionEvent[];
};

export type HelmConfig = {
  repos: RepoConfig[];
  agents: AgentConfig[];
};

/** Reads validated daemon config for repo and agent selectors. */
export async function getConfig(): Promise<HelmConfig> {
  return request("/config");
}

/** Lists sessions from the local Helm daemon. */
export async function listSessions(): Promise<Session[]> {
  return request("/sessions");
}

/** Reads one session and its persisted events. */
export async function getSession(id: string): Promise<SessionDetail> {
  return request(`/sessions/${id}`);
}

/** Creates a new session. */
export async function createSession(repo: string, agent: string, prompt: string): Promise<Session> {
  return request("/sessions", { method: "POST", body: JSON.stringify({ repo, agent, prompt }) });
}

/** Sends a follow-up message. */
export async function sendMessage(id: string, text: string): Promise<Session> {
  return request(`/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
}

/** Stops a running session. */
export async function stopSession(id: string): Promise<Session> {
  return request(`/sessions/${id}/stop`, { method: "POST" });
}

/** Archives a session. */
export async function archiveSession(id: string): Promise<Session> {
  return request(`/sessions/${id}/archive`, { method: "POST" });
}

/** Sends a JSON request to the daemon. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = init.body
    ? {
        "Content-Type": "application/json",
        ...init.headers
      }
    : init.headers;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(value.error ?? `HTTP ${response.status}`);
  }
  return value as T;
}
