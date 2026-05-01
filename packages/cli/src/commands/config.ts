import { loadConfig } from "@helm/daemon";

/** Validates Helm config files. */
export async function validateConfig(): Promise<void> {
  const config = await loadConfig();
  console.log(`valid: ${config.repos.length} repos, ${config.agents.length} agents`);
}
