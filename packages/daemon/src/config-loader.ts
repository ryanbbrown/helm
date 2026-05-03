import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { agentsConfigSchema, configPath, reposConfigSchema, type AgentConfig, type RepoConfig } from "@helm/core";
import { detectDefaultBranch, isGitRepository } from "./git";

export type HelmConfig = {
  repos: RepoConfig[];
  agents: AgentConfig[];
};

/** Reads and validates Helm repo and agent config files. */
export async function loadConfig(baseDir?: string): Promise<HelmConfig> {
  const reposPath = baseDir ? `${baseDir}/repos.json` : configPath("repos.json");
  const agentsPath = baseDir ? `${baseDir}/agents.json` : configPath("agents.json");
  const reposRaw = reposConfigSchema.parse(JSON.parse(await readFile(reposPath, "utf8")));
  const agentsRaw = agentsConfigSchema.parse(JSON.parse(await readFile(agentsPath, "utf8")));
  const names = new Set<string>();
  const repos: RepoConfig[] = [];

  for (const repo of reposRaw.repos) {
    if (names.has(repo.name)) {
      throw new Error(`Duplicate repo name: ${repo.name}`);
    }
    names.add(repo.name);
    if (!existsSync(repo.path)) {
      throw new Error(`Repo path does not exist: ${repo.path}`);
    }
    if (!(await isGitRepository(repo.path))) {
      throw new Error(`Repo path is not a git repository: ${repo.path}`);
    }
    repos.push({
      ...repo,
      default_branch: repo.default_branch ?? (await detectDefaultBranch(repo.path))
    });
  }

  const agentNames = new Set<string>();
  for (const agent of agentsRaw.agents) {
    if (agentNames.has(agent.name)) {
      throw new Error(`Duplicate agent name: ${agent.name}`);
    }
    agentNames.add(agent.name);
    if (agent.headless_mode === "manager_loop" && (!agent.model || !agent.api_key_env)) {
      throw new Error(`Manager agent ${agent.name} requires model and api_key_env`);
    }
  }

  return { repos, agents: agentsRaw.agents };
}

/** Finds a configured repo by name. */
export function findRepo(config: HelmConfig, name: string): RepoConfig {
  const repo = config.repos.find((entry) => entry.name === name);
  if (!repo) {
    throw new Error(`Unknown repo: ${name}`);
  }
  return repo;
}

/** Finds a configured agent by name. */
export function findAgent(config: HelmConfig, name: string): AgentConfig {
  const agent = config.agents.find((entry) => entry.name === name);
  if (!agent) {
    throw new Error(`Unknown agent: ${name}`);
  }
  return agent;
}
