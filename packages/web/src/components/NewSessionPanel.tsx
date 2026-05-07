"use client";

import { Play } from "lucide-react";
import { type RefObject } from "react";
import type { HelmConfig } from "../lib/api";
import { Composer } from "./Composer";
import { Select } from "./ui/Select";

type NewSessionPanelProps = {
  repos: HelmConfig["repos"];
  agents: HelmConfig["agents"];
  repoName: string;
  agentName: string;
  managerMode: "approval" | "autopilot";
  starting: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onRepoChange: (value: string) => void;
  onAgentChange: (value: string) => void;
  onManagerModeChange: (value: "approval" | "autopilot") => void;
  onCreate: (prompt: string) => Promise<void>;
};

/** Renders controls for starting a new agent session. */
export function NewSessionPanel({
  repos,
  agents,
  repoName,
  agentName,
  managerMode,
  starting,
  composerRef,
  onRepoChange,
  onAgentChange,
  onManagerModeChange,
  onCreate
}: NewSessionPanelProps) {
  const selectedAgent = agents.find((agent) => agent.name === agentName);
  return (
    <section className="new-session-panel" aria-label="New session">
      <div className="new-session-grid">
        <label>
          <span>Repo</span>
          <Select name="repo" value={repoName} onChange={(event) => onRepoChange(event.target.value)}>
            {repos.length === 0 ? <option value="">No repos configured</option> : null}
            {repos.map((repo) => (
              <option key={repo.name} value={repo.name}>{repo.name}</option>
            ))}
          </Select>
        </label>
        <label>
          <span>Agent</span>
          <Select name="agent" value={agentName} onChange={(event) => onAgentChange(event.target.value)}>
            {agents.length === 0 ? <option value="">No agents configured</option> : null}
            {agents.map((agent) => (
              <option key={agent.name} value={agent.name}>{agent.name}</option>
            ))}
          </Select>
        </label>
        {selectedAgent?.headless_mode === "manager_loop" ? (
          <label>
            <span>Mode</span>
            <Select name="manager_mode" value={managerMode} onChange={(event) => onManagerModeChange(event.target.value as "approval" | "autopilot")}>
              <option value="approval">Approval</option>
              <option value="autopilot">Autopilot</option>
            </Select>
          </label>
        ) : null}
      </div>
      <Composer
        ref={composerRef}
        className="new-session-composer"
        disabled={starting || !repoName || !agentName}
        label="Initial prompt"
        onSubmit={onCreate}
        placeholder="Start a session"
        submitIcon={<Play size={15} />}
        submitLabel="Start"
        textareaName="prompt"
      />
    </section>
  );
}
