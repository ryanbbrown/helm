import { z } from "zod";
import { DEFAULT_MANAGER_LIMITS } from "./manager";

export const repoConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/),
  path: z.string().min(1),
  default_branch: z.string().min(1).optional()
});

export const reposConfigSchema = z.object({
  repos: z.array(repoConfigSchema)
});

export const agentConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  headless_mode: z.enum(["claude_stream_json", "codex_exec", "manager_loop"]),
  model: z.string().min(1).optional(),
  api_key: z.string().min(1).optional(),
  system_prompt_path: z.string().min(1).optional(),
  manager_limits: z.object({
    max_tool_iterations_per_turn: z.number().int().positive().default(DEFAULT_MANAGER_LIMITS.max_tool_iterations_per_turn),
    max_tool_calls_per_batch: z.number().int().positive().default(DEFAULT_MANAGER_LIMITS.max_tool_calls_per_batch),
    max_queued_wakes_per_turn: z.number().int().positive().default(DEFAULT_MANAGER_LIMITS.max_queued_wakes_per_turn),
    max_live_children: z.number().int().positive().default(DEFAULT_MANAGER_LIMITS.max_live_children)
  }).partial().optional()
});

export const agentsConfigSchema = z.object({
  agents: z.array(agentConfigSchema)
});

export type RepoConfig = z.infer<typeof repoConfigSchema> & {
  default_branch: string;
};

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export type ReposConfig = {
  repos: RepoConfig[];
};

export type AgentsConfig = z.infer<typeof agentsConfigSchema>;
