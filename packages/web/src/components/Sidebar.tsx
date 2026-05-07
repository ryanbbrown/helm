"use client";

import type { KeyboardEvent, RefObject } from "react";
import type { PublicSession, SessionStatus } from "@helm/core";
import type { HelmConfig } from "../lib/api";
import { NewSessionPanel } from "./NewSessionPanel";
import { SessionList } from "./SessionList";

type SidebarProps = {
  sessions: PublicSession[];
  selectedId: string | null;
  repos: HelmConfig["repos"];
  agents: HelmConfig["agents"];
  statusOptions: SessionStatus[];
  repoName: string;
  agentName: string;
  managerMode: "approval" | "autopilot";
  starting: boolean;
  search: string;
  statusFilter: SessionStatus | "all";
  searchRef: RefObject<HTMLInputElement | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: SessionStatus | "all") => void;
  onRepoChange: (value: string) => void;
  onAgentChange: (value: string) => void;
  onManagerModeChange: (value: "approval" | "autopilot") => void;
  onCreate: (prompt: string) => Promise<void>;
  onSelect: (id: string) => void;
};

/** Renders the dashboard sidebar with session creation and navigation. */
export function Sidebar({
  sessions,
  selectedId,
  repos,
  agents,
  statusOptions,
  repoName,
  agentName,
  managerMode,
  starting,
  search,
  statusFilter,
  searchRef,
  composerRef,
  onSearchChange,
  onStatusFilterChange,
  onRepoChange,
  onAgentChange,
  onManagerModeChange,
  onCreate,
  onSelect
}: SidebarProps) {
  /** Clears sidebar search from inside the editable search box. */
  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onSearchChange("");
      event.currentTarget.blur();
    }
  }

  return (
    <aside className="dashboard-sidebar">
      <div className="sidebar-title">
        <div>
          <div className="app-title">Helm</div>
          <div className="muted">Local sessions</div>
        </div>
      </div>
      <NewSessionPanel
        repos={repos}
        agents={agents}
        repoName={repoName}
        agentName={agentName}
        managerMode={managerMode}
        starting={starting}
        composerRef={composerRef}
        onRepoChange={onRepoChange}
        onAgentChange={onAgentChange}
        onManagerModeChange={onManagerModeChange}
        onCreate={onCreate}
      />
      <div className="session-tools">
        <label className="search-label">
          <span className="sr-only">Search sessions</span>
          <input ref={searchRef} type="search" value={search} onChange={(event) => onSearchChange(event.target.value)} onKeyDown={onSearchKeyDown} placeholder="Search sessions" />
        </label>
        <div className="status-filters" aria-label="Filter sessions by status">
          <button className={statusFilter === "all" ? "active" : ""} type="button" onClick={() => onStatusFilterChange("all")}>All</button>
          {statusOptions.map((status) => (
            <button key={status} className={statusFilter === status ? "active" : ""} type="button" onClick={() => onStatusFilterChange(status)}>
              {status.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>
      <SessionList sessions={sessions} selectedId={selectedId} onSelect={onSelect} />
    </aside>
  );
}
