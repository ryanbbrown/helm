import type { AgentConfig } from "@helm/core";
import { ClaudeRunnerAdapter } from "./claude";
import { CodexRunnerAdapter } from "./codex";
import { ManagerRunnerAdapter } from "./manager";
import type { ManagerToolContext } from "./manager-context";
import type { RunnerAdapter } from "./types";

export type RunnerAdapterOptions = {
  managerContext?: ManagerToolContext;
};

/** Creates the runner adapter for an agent config. */
export function createRunnerAdapter(agent: AgentConfig, options: RunnerAdapterOptions = {}): RunnerAdapter {
  if (agent.headless_mode === "claude_stream_json") {
    return new ClaudeRunnerAdapter();
  }
  if (agent.headless_mode === "codex_exec") {
    return new CodexRunnerAdapter();
  }
  if (agent.headless_mode === "manager_loop") {
    if (!options.managerContext) {
      throw new Error("manager_loop requires manager context");
    }
    return new ManagerRunnerAdapter(agent, options.managerContext);
  }
  throw new Error(`Unsupported headless mode: ${agent.headless_mode}`);
}
