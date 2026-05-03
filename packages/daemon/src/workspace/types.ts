import type { DiffBase, DiffResult, PullRequestError, PullRequestResult, RepoConfig, Session } from "@helm/core";

export type LocalWorkspaceHandle = {
  kind: "local";
  uri: string;
  cwd: string;
  branch: string;
};

export type NullWorkspaceHandle = {
  kind: "none";
  uri: null;
  cwd: null;
  branch: null;
};

export type WorkspaceHandle = LocalWorkspaceHandle | NullWorkspaceHandle;

export type WorkspaceCreateOptions = {
  repo: RepoConfig;
  sessionId: string;
  branchName?: string;
  sourceRef?: string;
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

export type WorkspaceDiffOptions = {
  repo: RepoConfig;
  base: DiffBase;
  fileSizeLimit: number;
  fileCountLimit: number;
};

export type WorkspacePullRequestOptions = {
  repo: RepoConfig;
  title: string;
  body: string;
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

  /** Reads a structured diff for the workspace. */
  diff(handle: WorkspaceHandle, options: WorkspaceDiffOptions): Promise<DiffResult>;

  /** Pushes the workspace branch and opens a pull request. */
  createPullRequest(handle: WorkspaceHandle, options: WorkspacePullRequestOptions): Promise<PullRequestResult>;
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

export class PullRequestPreconditionError extends Error {
  /** Creates a structured pull request precondition error. */
  constructor(readonly error: PullRequestError) {
    super(error.code);
  }

  /** Returns the public error code. */
  get code(): PullRequestError["code"] {
    return this.error.code;
  }

  /** Returns public details for the error. */
  get details(): string | undefined {
    return this.error.details;
  }
}
