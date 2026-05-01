"use client";

import { Archive, Play } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { AgentConfig, RepoConfig, Session, SessionEvent } from "@helm/core";
import { archiveSession, createSession, getConfig, getSession, listSessions, sendMessage, stopSession } from "../lib/api";
import { useAllSessionsStream, useSessionEvents } from "../lib/sse";
import { EmptyState } from "../components/EmptyState";
import { Header } from "../components/Header";
import { SessionDetail } from "../components/SessionDetail";
import { SessionList } from "../components/SessionList";

/** Renders the Helm dashboard. */
export default function Page() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [repoName, setRepoName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) ?? null, [selectedId, sessions]);

  const mergeSession = useCallback((session: Session) => {
    setSessions((current) => {
      const next = current.filter((entry) => entry.id !== session.id);
      return [session, ...next].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
  }, []);

  const mergeEvent = useCallback((event: SessionEvent) => {
    setEvents((current) => {
      if (current.some((entry) => entry.id === event.id)) {
        return current;
      }
      return [...current, event].sort((a, b) => a.id - b.id);
    });
  }, []);
  const ignoreGlobalEvent = useCallback(() => undefined, []);

  const refresh = useCallback(async () => {
    try {
      const next = await listSessions();
      const config = await getConfig();
      setSessions(next);
      setRepos(config.repos);
      setAgents(config.agents);
      setRepoName((current) => current || config.repos[0]?.name || "");
      setAgentName((current) => current || config.agents.find((agent) => agent.name === "codex")?.name || config.agents[0]?.name || "");
      setSelectedId((current) => current ?? next[0]?.id ?? null);
      if (selectedId) {
        const detail = await getSession(selectedId);
        mergeSession(detail.session);
        setEvents(detail.events);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [mergeSession, selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      return;
    }
    getSession(selectedId)
      .then((detail) => {
        mergeSession(detail.session);
        setEvents(detail.events);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [mergeSession, selectedId]);

  useAllSessionsStream(mergeSession, ignoreGlobalEvent);
  useSessionEvents(selectedId, mergeSession, mergeEvent);

  /** Creates a new session from form data. */
  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const repo = repoName.trim();
    const agent = agentName.trim();
    const prompt = String(formData.get("prompt") ?? "").trim();
    if (!repo || !agent || !prompt) {
      return;
    }
    setStarting(true);
    try {
      const session = await createSession(repo, agent, prompt);
      mergeSession(session);
      setSelectedId(session.id);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  /** Sends a follow-up to the selected session. */
  async function onSend(text: string): Promise<void> {
    if (!selectedId) {
      return;
    }
    const session = await sendMessage(selectedId, text);
    mergeSession(session);
  }

  /** Stops the selected session. */
  async function onStop(): Promise<void> {
    if (!selectedId) {
      return;
    }
    const session = await stopSession(selectedId);
    mergeSession(session);
  }

  /** Archives the selected session. */
  async function onArchive(): Promise<void> {
    if (!selectedId) {
      return;
    }
    const session = await archiveSession(selectedId);
    mergeSession(session);
  }

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="header">
          <div>
            <div className="title">Helm</div>
            <div className="muted">Local sessions</div>
          </div>
          <button className="icon" type="button" title="Archive selected session" disabled={!selectedId} onClick={onArchive}>
            <Archive size={16} />
          </button>
        </div>
        <form className="new-session" onSubmit={(event) => void onCreate(event)}>
          <select name="repo" value={repoName} onChange={(event) => setRepoName(event.target.value)}>
            {repos.length === 0 ? <option value="">No repos configured</option> : null}
            {repos.map((repo) => (
              <option key={repo.name} value={repo.name}>{repo.name}</option>
            ))}
          </select>
          <select name="agent" value={agentName} onChange={(event) => setAgentName(event.target.value)}>
            {agents.length === 0 ? <option value="">No agents configured</option> : null}
            {agents.map((agent) => (
              <option key={agent.name} value={agent.name}>{agent.name}</option>
            ))}
          </select>
          <textarea name="prompt" placeholder="Initial prompt" />
          <button className="primary" type="submit" disabled={starting || !repoName || !agentName}>
            <Play size={15} />
            {starting ? "Starting" : "Start"}
          </button>
          {error ? <div className="event-line">Error: {error}</div> : null}
        </form>
        <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>
      <section className="main">
        {selected ? (
          <SessionDetail session={selected} events={events} onRefresh={refresh} onSend={onSend} onStop={() => void onStop()} />
        ) : (
          <>
            <Header session={null} onRefresh={refresh} onStop={() => undefined} />
            <EmptyState />
          </>
        )}
      </section>
    </main>
  );
}
