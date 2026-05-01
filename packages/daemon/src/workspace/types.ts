import type { RepoConfig, Session } from "@helm/core";

export type WorkspaceHandle = {
  uri: string;
  cwd: string;
  branch: string;
};

export type WorkspaceCreateOptions = {
  repo: RepoConfig;
  sessionId: string;
};

export type WorkspaceSessionOptions = {
  repo: RepoConfig;
  session: Session;
};

export type WorkspaceRemoveOptions = {
  repo: RepoConfig;
  force: boolean;
};

export type WorkspaceSafetyOptions = {
  repo: RepoConfig;
};

export interface WorkspaceProvider {
  /** Creates a workspace for a new session. */
  create(options: WorkspaceCreateOptions): Promise<WorkspaceHandle>;

  /** Reconstructs a workspace handle from a persisted session row. */
  fromSession(options: WorkspaceSessionOptions): WorkspaceHandle;

  /** Removes an existing workspace. */
  remove(handle: WorkspaceHandle, options: WorkspaceRemoveOptions): Promise<void>;

  /** Refuses removal when provider-specific work would be lost. */
  assertRemoveSafe(handle: WorkspaceHandle, options: WorkspaceSafetyOptions): Promise<void>;
}

export class ArchiveSafetyError extends Error {
  /** Creates an archive safety error. */
  constructor(
    readonly code: "dirty_worktree" | "unshared_commits",
    readonly details: string
  ) {
    super(code);
  }
}
