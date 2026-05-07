"use client";

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import type { PublicSession, PublicSessionEvent, SessionStatus } from "@helm/core";
import {
  ApiError,
  approveToolCall,
  archiveSession,
  createManagerSession,
  createSession,
  denyToolCall,
  getConfig,
  getSession,
  listSessions,
  resumeSession,
  sendMessage,
  stopSession,
  type HelmConfig
} from "../lib/api";
import { useAllSessionsStream, useSessionEvents } from "../lib/sse";
import { useGlobalShortcuts, type ShortcutBinding } from "../lib/shortcuts";
import { ArchiveConfirmDialog } from "../components/ArchiveConfirmDialog";
import { DashboardShell } from "../components/DashboardShell";
import { EmptyState } from "../components/EmptyState";
import { Header } from "../components/Header";
import { InlineNotice } from "../components/InlineNotice";
import { SessionDetail } from "../components/SessionDetail";
import { Sidebar } from "../components/Sidebar";

type ArchiveConflict = {
  sessionId: string;
  details: string;
};

/** Renders the Helm dashboard. */
export default function Page() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<PublicSession[]>([]);
  const [events, setEvents] = useState<PublicSessionEvent[]>([]);
  const [repos, setRepos] = useState<HelmConfig["repos"]>([]);
  const [agents, setAgents] = useState<HelmConfig["agents"]>([]);
  const [repoName, setRepoName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [managerMode, setManagerMode] = useState<"approval" | "autopilot">("approval");
  const [pageError, setPageError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SessionStatus | "all">("all");
  const [showDiff, setShowDiff] = useState(false);
  const [diffRefreshToken, setDiffRefreshToken] = useState(0);
  const [starting, setStarting] = useState(false);
  const [archiveConflict, setArchiveConflict] = useState<ArchiveConflict | null>(null);
  const [forceArchiving, setForceArchiving] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const newComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) ?? null, [selectedId, sessions]);
  const statusOptions = useMemo(() => uniqueStatuses(sessions), [sessions]);
  const visibleSessions = useMemo(
    () => sessions.filter((session) => matchesSearch(session, search) && (statusFilter === "all" || session.status === statusFilter)),
    [search, sessions, statusFilter]
  );

  const mergeSession = useCallback((session: PublicSession) => {
    setSessions((current) => {
      const next = current.filter((entry) => entry.id !== session.id);
      return [session, ...next].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
  }, []);

  const mergeEvent = useCallback((event: PublicSessionEvent) => {
    setEvents((current) => {
      if (current.some((entry) => entry.id === event.id)) {
        return current;
      }
      return [...current, event].sort((a, b) => a.id - b.id);
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const activeId = selectedId;
      const [next, config, detail] = await Promise.all([
        listSessions(),
        getConfig(),
        activeId ? getSession(activeId) : Promise.resolve(null)
      ]);
      setSessions(next);
      setRepos(config.repos);
      setAgents(config.agents);
      setRepoName((current) => current || config.repos[0]?.name || "");
      setAgentName((current) => current || config.agents.find((agent) => agent.name === "codex")?.name || config.agents[0]?.name || "");
      setSelectedId((current) => current ?? next[0]?.id ?? null);
      if (detail) {
        mergeSession(detail.session);
        setEvents(detail.events);
      }
      setPageError(null);
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [mergeSession, selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setShowDiff(false);
    if (!selectedId) {
      setEvents([]);
      return;
    }
    getSession(selectedId)
      .then((detail) => {
        mergeSession(detail.session);
        setEvents(detail.events);
      })
      .catch((cause) => setPageError(cause instanceof Error ? cause.message : String(cause)));
  }, [mergeSession, selectedId]);

  const ignoreGlobalEvent = useCallback(() => undefined, []);
  const markDiffChanged = useCallback(() => setDiffRefreshToken((current) => current + 1), []);
  useAllSessionsStream(mergeSession, ignoreGlobalEvent);
  useSessionEvents(selectedId, mergeSession, mergeEvent, markDiffChanged);

  const selectOffset = useCallback((offset: number) => {
    if (visibleSessions.length === 0) {
      return;
    }
    const index = visibleSessions.findIndex((session) => session.id === selectedId);
    if (index === -1) {
      setSelectedId(offset >= 0 ? visibleSessions[0].id : visibleSessions[visibleSessions.length - 1].id);
      return;
    }
    const next = visibleSessions[(index + offset + visibleSessions.length) % visibleSessions.length];
    setSelectedId(next.id);
  }, [selectedId, visibleSessions]);

  const shortcuts = useMemo<ShortcutBinding[]>(() => archiveConflict ? [] : [
    { key: "/", run: () => searchRef.current?.focus() },
    { key: "n", run: () => newComposerRef.current?.focus() },
    { key: "j", run: () => selectOffset(1) },
    { key: "k", run: () => selectOffset(-1) },
    { key: "ArrowDown", run: () => selectOffset(1) },
    { key: "ArrowUp", run: () => selectOffset(-1) },
    { key: "r", run: () => void refresh() },
    { key: "d", run: () => selected && !selected.manager_mode ? setShowDiff((current) => !current) : undefined },
    { key: "Escape", run: () => setSearch("") }
  ], [archiveConflict, refresh, selectOffset, selected]);
  useGlobalShortcuts(shortcuts);

  /** Creates a new session from the initial prompt. */
  async function onCreate(prompt: string): Promise<void> {
    const repo = repoName.trim();
    const agent = agentName.trim();
    if (!repo || !agent || !prompt.trim()) {
      return;
    }
    setStarting(true);
    try {
      const agentConfig = agents.find((entry) => entry.name === agent);
      const session = agentConfig?.headless_mode === "manager_loop"
        ? await createManagerSession(repo, agent, prompt, managerMode)
        : await createSession(repo, agent, prompt);
      mergeSession(session);
      setSelectedId(session.id);
      setPageError(null);
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

  /** Resumes the selected interrupted session. */
  async function onResume(): Promise<void> {
    if (!selectedId) {
      return;
    }
    try {
      const session = await resumeSession(selectedId);
      mergeSession(session);
      setPageError(null);
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Stops the selected session. */
  async function onStop(): Promise<void> {
    if (!selectedId || selected?.status === "interrupted") {
      return;
    }
    try {
      const session = await stopSession(selectedId);
      mergeSession(session);
      setPageError(null);
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Archives the selected session or opens the safety dialog. */
  async function onArchive(): Promise<void> {
    if (!selectedId) {
      return;
    }
    try {
      const session = await archiveSession(selectedId);
      mergeSession(session);
      setArchiveConflict(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setArchiveConflict({ sessionId: selectedId, details: cause.details ?? cause.message });
        return;
      }
      setPageError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Force archives after the user confirms unsafe removal. */
  async function onForceArchive(): Promise<void> {
    if (!archiveConflict) {
      return;
    }
    setForceArchiving(true);
    try {
      const session = await archiveSession(archiveConflict.sessionId, true);
      mergeSession(session);
      setArchiveConflict(null);
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setForceArchiving(false);
    }
  }

  /** Approves a pending manager tool call. */
  async function onApproveToolCall(toolCallId: string): Promise<void> {
    if (!selectedId) {
      return;
    }
    try {
      await approveToolCall(selectedId, toolCallId);
      setPageError(null);
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Denies a pending manager tool call. */
  async function onDenyToolCall(toolCallId: string): Promise<void> {
    if (!selectedId) {
      return;
    }
    try {
      await denyToolCall(selectedId, toolCallId);
      setPageError(null);
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <>
      <DashboardShell
        sidebar={
          <Sidebar
            sessions={visibleSessions}
            selectedId={selectedId}
            repos={repos}
            agents={agents}
            statusOptions={statusOptions}
            repoName={repoName}
            agentName={agentName}
            managerMode={managerMode}
            starting={starting}
            search={search}
            statusFilter={statusFilter}
            searchRef={searchRef}
            composerRef={newComposerRef}
            onSearchChange={setSearch}
            onStatusFilterChange={setStatusFilter}
            onRepoChange={setRepoName}
            onAgentChange={setAgentName}
            onManagerModeChange={setManagerMode}
            onCreate={onCreate}
            onSelect={setSelectedId}
          />
        }
        detail={
          selected ? (
            <SessionDetail
              session={selected}
              events={events}
              diffRefreshToken={diffRefreshToken}
              showDiff={showDiff}
              onRefresh={refresh}
              onResume={() => void onResume()}
              onSend={onSend}
              onStop={() => void onStop()}
              onArchive={() => void onArchive()}
              onToggleDiff={() => setShowDiff((current) => !current)}
              onSessionUpdate={mergeSession}
              onApproveToolCall={(toolCallId) => void onApproveToolCall(toolCallId)}
              onDenyToolCall={(toolCallId) => void onDenyToolCall(toolCallId)}
            />
          ) : (
            <div className="detail">
              <Header session={null} onRefresh={refresh} onStop={() => undefined} />
              <EmptyState />
            </div>
          )
        }
      />
      {pageError ? <div className="toast-region"><InlineNotice tone="error">{pageError}</InlineNotice></div> : null}
      {archiveConflict ? <ArchiveConfirmDialog details={archiveConflict.details} archiving={forceArchiving} onCancel={() => setArchiveConflict(null)} onConfirm={() => void onForceArchive()} /> : null}
    </>
  );
}

/** Returns statuses present in the current session set. */
function uniqueStatuses(sessions: PublicSession[]): SessionStatus[] {
  return Array.from(new Set(sessions.map((session) => session.status)));
}

/** Checks whether a session matches the sidebar search query. */
function matchesSearch(session: PublicSession, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [session.repo_name, session.agent_name, session.branch, session.status, session.manager_mode ?? ""]
    .filter(Boolean)
    .some((value) => value?.toLowerCase().includes(query));
}
