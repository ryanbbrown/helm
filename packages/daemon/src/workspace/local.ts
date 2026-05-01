import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { worktreePath } from "@helm/core";
import { createWorktree, deleteBranch, fetchOrigin, removeWorktree, unsharedCommits, worktreeStatus } from "../git";
import {
  ArchiveSafetyError,
  type WorkspaceCreateOptions,
  type WorkspaceHandle,
  type WorkspaceProvider,
  type WorkspaceRemoveOptions,
  type WorkspaceSafetyOptions,
  type WorkspaceSessionOptions
} from "./types";

export class LocalWorktreeProvider implements WorkspaceProvider {
  /** Creates a local git worktree for a new session. */
  async create({ repo, sessionId }: WorkspaceCreateOptions): Promise<WorkspaceHandle> {
    const branch = `helm/${sessionId}`;
    const path = worktreePath(repo.name, sessionId);
    await fetchOrigin(repo.path);
    mkdirSync(dirname(path), { recursive: true });
    await createWorktree(repo.path, branch, path, repo.default_branch);
    return { uri: `file://${path}`, cwd: path, branch };
  }

  /** Reconstructs a local worktree handle from a persisted session. */
  fromSession({ session }: WorkspaceSessionOptions): WorkspaceHandle {
    return { uri: `file://${session.worktree_path}`, cwd: session.worktree_path, branch: session.branch };
  }

  /** Removes a local worktree and its local branch. */
  async remove(handle: WorkspaceHandle, { repo }: WorkspaceRemoveOptions): Promise<void> {
    await removeWorktree(repo.path, handle.cwd);
    await deleteBranch(repo.path, handle.branch);
  }

  /** Refuses removal if the local worktree has dirty or unshared work. */
  async assertRemoveSafe(handle: WorkspaceHandle, { repo }: WorkspaceSafetyOptions): Promise<void> {
    const dirty = await worktreeStatus(handle.cwd);
    if (dirty) {
      throw new ArchiveSafetyError("dirty_worktree", dirty);
    }
    const commits = await unsharedCommits(repo.path, handle.branch);
    if (commits) {
      throw new ArchiveSafetyError("unshared_commits", commits);
    }
  }
}
