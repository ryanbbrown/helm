import { homedir } from "node:os";
import { join } from "node:path";

/** Returns the root Helm state directory. */
export function helmHome(): string {
  if (typeof Bun !== "undefined" && Bun.env.HELM_HOME) {
    return Bun.env.HELM_HOME;
  }
  return join(homedir(), ".helm");
}

/** Returns the Helm config directory. */
export function configDir(): string {
  return join(helmHome(), "config");
}

/** Returns the Helm state directory. */
export function stateDir(): string {
  return join(helmHome(), "state");
}

/** Returns the Helm logs directory. */
export function logsDir(): string {
  return join(helmHome(), "logs");
}

/** Returns the Helm worktrees directory. */
export function worktreesDir(): string {
  return join(helmHome(), "worktrees");
}

/** Returns a config file path below ~/.helm/config. */
export function configPath(fileName: string): string {
  return join(configDir(), fileName);
}

/** Returns the SQLite database path. */
export function databasePath(): string {
  return join(stateDir(), "helm.db");
}

/** Returns the raw JSONL log path for a session. */
export function logPath(sessionId: string): string {
  return join(logsDir(), `${sessionId}.jsonl`);
}

/** Returns the worktree path for a repo/session pair. */
export function worktreePath(repoName: string, sessionId: string): string {
  return join(worktreesDir(), repoName, sessionId);
}
