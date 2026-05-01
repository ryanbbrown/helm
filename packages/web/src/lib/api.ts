import type { Session, SessionEvent } from "@helm/core";

export const API_BASE = process.env.NEXT_PUBLIC_HELM_API_URL ?? "http://127.0.0.1:7878";
let cachedToken: string | null = null;

export type SessionDetail = {
  session: Session;
  events: SessionEvent[];
};

export type HelmConfig = {
  repos: Array<{ name: string }>;
  agents: Array<{ name: string; headless_mode: string }>;
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
export async function archiveSession(id: string, force = false): Promise<Session> {
  return request(`/sessions/${id}/archive${force ? "?force=1" : ""}`, { method: "POST" });
}

export class ApiError extends Error {
  /** Creates an API error from a daemon response. */
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: string
  ) {
    super(message);
  }
}

/** Sends a JSON request to the daemon. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = init.body
    ? {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...init.headers
      }
    : {
        ...authHeaders(),
        ...init.headers
      };
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers
  });
  const value = (await response.json().catch(() => ({}))) as { error?: string; code?: string; details?: string };
  if (!response.ok) {
    throw new ApiError(value.error ?? `HTTP ${response.status}`, response.status, value.code, value.details);
  }
  return value as T;
}

/** Returns daemon auth headers for protected requests. */
function authHeaders(): HeadersInit {
  const token = helmToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Reads the daemon token from the current dashboard URL. */
export function helmToken(): string | null {
  if (cachedToken) {
    return cachedToken;
  }
  if (typeof window === "undefined") {
    return null;
  }
  cachedToken = new URLSearchParams(window.location.search).get("token");
  return cachedToken;
}

/** Adds the daemon token to an SSE URL. */
export function withToken(path: string): string {
  const token = helmToken();
  const separator = path.includes("?") ? "&" : "?";
  return token ? `${path}${separator}token=${encodeURIComponent(token)}` : path;
}
