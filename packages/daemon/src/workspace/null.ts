import type {
  WorkspaceCreateOptions,
  WorkspaceDiffOptions,
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspacePullRequestOptions,
  WorkspaceRemoveOptions,
  WorkspaceSafetyOptions,
  WorkspaceSessionOptions
} from "./types";

export class NullWorkspaceProvider implements WorkspaceProvider {
  /** Creates a null workspace for a manager session. */
  async create(_options: WorkspaceCreateOptions): Promise<WorkspaceHandle> {
    return { kind: "none", uri: null, cwd: null, branch: null };
  }

  /** Reconstructs a null workspace from a manager session. */
  fromSession(_options: WorkspaceSessionOptions): WorkspaceHandle {
    return { kind: "none", uri: null, cwd: null, branch: null };
  }

  /** Removes nothing for null workspaces. */
  async remove(_handle: WorkspaceHandle, _options: WorkspaceRemoveOptions): Promise<void> {}

  /** Accepts null workspace removal. */
  async assertRemoveSafe(_handle: WorkspaceHandle, _options: WorkspaceSafetyOptions): Promise<void> {}

  /** Refuses diff reads for null workspaces. */
  async diff(_handle: WorkspaceHandle, _options: WorkspaceDiffOptions): Promise<never> {
    throw new Error("Null workspace has no diff");
  }

  /** Refuses pull request creation for null workspaces. */
  async createPullRequest(_handle: WorkspaceHandle, _options: WorkspacePullRequestOptions): Promise<never> {
    throw new Error("Null workspace has no pull request");
  }
}
