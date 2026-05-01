import { z } from "zod";

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
  headless_mode: z.enum(["claude_stream_json", "codex_exec"])
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
