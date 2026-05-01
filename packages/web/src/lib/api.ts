import type { PublicSession, PublicSessionEvent } from "@helm/core";

const DEFAULT_API_BASE = "http://127.0.0.1:7878";
const API_STORAGE_KEY = "helm.apiBase";
const TOKEN_STORAGE_KEY = "helm.token";
let cachedToken: string | null = null;
let cachedApiBase: string | null = null;

export type SessionDetail = {
  session: PublicSession;
  events: PublicSessionEvent[];
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
export async function listSessions(): Promise<PublicSession[]> {
  return request("/sessions");
}

/** Reads one session and its persisted events. */
export async function getSession(id: string): Promise<SessionDetail> {
  return request(`/sessions/${id}`);
}

/** Creates a new session. */
export async function createSession(repo: string, agent: string, prompt: string): Promise<PublicSession> {
  return request("/sessions", { method: "POST", body: JSON.stringify({ repo, agent, prompt }) });
}

/** Sends a follow-up message. */
export async function sendMessage(id: string, text: string): Promise<PublicSession> {
  return request(`/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
}

/** Stops a running session. */
export async function stopSession(id: string): Promise<PublicSession> {
  return request(`/sessions/${id}/stop`, { method: "POST" });
}

/** Archives a session. */
export async function archiveSession(id: string, force = false): Promise<PublicSession> {
  return request(`/sessions/${id}/archive`, { method: "POST", body: JSON.stringify({ force }) });
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
  const response = await fetch(apiUrl(path), {
    ...init,
    headers
  });
  const value = (await response.json().catch(() => ({}))) as { error?: string; code?: string; details?: string };
  if (!response.ok) {
    if (response.status === 401 || value.code === "unauthorized") {
      clearHelmToken();
    }
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
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token");
  if (urlToken) {
    cachedToken = urlToken;
    window.localStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
    return cachedToken;
  }
  if (cachedToken) {
    return cachedToken;
  }
  cachedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  if (cachedToken) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, cachedToken);
  }
  return cachedToken;
}

/** Resolves the daemon API base URL at call time. */
export function apiBase(): string {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const urlApi = params.get("api");
    if (urlApi) {
      cachedApiBase = trimTrailingSlash(urlApi);
      window.localStorage.setItem(API_STORAGE_KEY, cachedApiBase);
      return cachedApiBase;
    }
    if (cachedApiBase) {
      return cachedApiBase;
    }
    cachedApiBase = trimTrailingSlash(window.localStorage.getItem(API_STORAGE_KEY) ?? process.env.NEXT_PUBLIC_HELM_API_URL ?? DEFAULT_API_BASE);
    window.localStorage.setItem(API_STORAGE_KEY, cachedApiBase);
    return cachedApiBase;
  }
  return trimTrailingSlash(process.env.NEXT_PUBLIC_HELM_API_URL ?? DEFAULT_API_BASE);
}

/** Builds a daemon API URL for HTTP requests. */
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

/** Builds a daemon API URL for EventSource requests. */
export function sseUrl(path: string): string {
  const token = helmToken();
  const separator = path.includes("?") ? "&" : "?";
  const pathWithToken = token ? `${path}${separator}token=${encodeURIComponent(token)}` : path;
  return apiUrl(pathWithToken);
}

/** Removes a trailing slash from a base URL. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Clears stale daemon auth after an unauthorized response. */
function clearHelmToken(): void {
  cachedToken = null;
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}
