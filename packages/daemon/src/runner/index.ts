import type { AgentConfig } from "@helm/core";
import { ClaudeRunnerAdapter } from "./claude";
import { CodexRunnerAdapter } from "./codex";
import type { RunnerAdapter } from "./types";

/** Creates the runner adapter for an agent config. */
export function createRunnerAdapter(agent: AgentConfig): RunnerAdapter {
  if (agent.headless_mode === "claude_stream_json") {
    return new ClaudeRunnerAdapter();
  }
  if (agent.headless_mode === "codex_exec") {
    return new CodexRunnerAdapter();
  }
  throw new Error(`Unsupported headless mode: ${agent.headless_mode}`);
}
