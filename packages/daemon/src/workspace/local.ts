import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DiffResultSchema, worktreePath } from "@helm/core";
import {
  assertGhAvailable,
  commitsAheadOf,
  createGitHubPullRequest,
  createWorktree,
  deleteBranch,
  fetchBranch,
  fetchOrigin,
  gitDiff,
  originUrl,
  pushBranch,
  removeWorktree,
  unsharedCommits,
  worktreeStatus
} from "../git";
import {
  ArchiveSafetyError,
  PullRequestPreconditionError,
  type WorkspaceCreateOptions,
  type WorkspaceDiffOptions,
  type WorkspaceHandle,
  type WorkspacePullRequestOptions,
  type WorkspaceProvider,
  type WorkspaceRemoveOptions,
  type WorkspaceSafetyOptions,
  type WorkspaceSessionOptions
} from "./types";

export class LocalWorktreeProvider implements WorkspaceProvider {
  /** Creates a local git worktree for a new session. */
  async create({ repo, sessionId, branchName, sourceRef }: WorkspaceCreateOptions): Promise<WorkspaceHandle> {
    const branch = branchName ?? `helm/${sessionId}`;
    const path = worktreePath(repo.name, sessionId);
    await fetchOrigin(repo.path);
    mkdirSync(dirname(path), { recursive: true });
    await createWorktree(repo.path, branch, path, sourceRef ?? `origin/${repo.default_branch}`);
    return { kind: "local", uri: `file://${path}`, cwd: path, branch };
  }

  /** Reconstructs a local worktree handle from a persisted session. */
  fromSession({ session }: WorkspaceSessionOptions): WorkspaceHandle {
    if (!session.worktree_path || !session.branch) {
      throw new Error(`Session has no local workspace: ${session.id}`);
    }
    return { kind: "local", uri: session.workspace_uri ?? `file://${session.worktree_path}`, cwd: session.worktree_path, branch: session.branch };
  }

  /** Removes a local worktree and its local branch. */
  async remove(handle: WorkspaceHandle, { repo }: WorkspaceRemoveOptions): Promise<void> {
    assertLocalHandle(handle);
    await removeWorktree(repo.path, handle.cwd);
    await deleteBranch(repo.path, handle.branch);
  }

  /** Refuses removal if the local worktree has dirty or unshared work. */
  async assertRemoveSafe(handle: WorkspaceHandle, { repo }: WorkspaceSafetyOptions): Promise<void> {
    assertLocalHandle(handle);
    const dirty = await worktreeStatus(handle.cwd);
    if (dirty) {
      throw new ArchiveSafetyError("dirty_worktree", dirty);
    }
    const commits = await unsharedCommits(repo.path, handle.branch);
    if (commits) {
      throw new ArchiveSafetyError("unshared_commits", commits);
    }
  }

  /** Reads the current worktree diff for a session. */
  async diff(handle: WorkspaceHandle, { repo, base, fileSizeLimit, fileCountLimit }: WorkspaceDiffOptions) {
    assertLocalHandle(handle);
    const diff = await gitDiff(handle.cwd, { base, defaultBranch: repo.default_branch, fileSizeLimit, fileCountLimit });
    const result = {
      base,
      generatedAt: new Date().toISOString(),
      files: diff.files,
      truncated: diff.totalFiles > fileCountLimit,
      fileLimit: fileCountLimit,
      totalFiles: diff.totalFiles
    };
    return DiffResultSchema.parse(result);
  }

  /** Pushes the session branch and opens a GitHub pull request. */
  async createPullRequest(handle: WorkspaceHandle, { repo, title, body }: WorkspacePullRequestOptions) {
    assertLocalHandle(handle);
    const dirty = await worktreeStatus(handle.cwd);
    if (dirty) {
      throw new PullRequestPreconditionError({ code: "dirty_worktree", details: dirty });
    }
    const remote = await originUrl(handle.cwd);
    if (!isGitHubRemote(remote)) {
      throw new PullRequestPreconditionError({ code: "non_github_remote", details: remote });
    }
    try {
      await assertGhAvailable(handle.cwd);
    } catch (error) {
      throw new PullRequestPreconditionError({ code: "gh_unavailable", details: error instanceof Error ? error.message : String(error) });
    }
    await fetchBranch(handle.cwd);
    if (await commitsAheadOf(handle.cwd, repo.default_branch) === 0) {
      throw new PullRequestPreconditionError({ code: "no_commits_ahead", details: `No commits ahead of origin/${repo.default_branch}` });
    }
    await pushBranch(handle.cwd, handle.branch);
    try {
      return { url: await createGitHubPullRequest(handle.cwd, handle.branch, repo.default_branch, title, body) };
    } catch (error) {
      throw new PullRequestPreconditionError({ code: "gh_failed", details: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Narrows a workspace handle to a local git worktree. */
function assertLocalHandle(handle: WorkspaceHandle): asserts handle is Extract<WorkspaceHandle, { kind: "local" }> {
  if (handle.kind !== "local") {
    throw new Error("Local workspace required");
  }
}

/** Checks whether a git remote points at GitHub. */
export function isGitHubRemote(remote: string): boolean {
  return /^git@github\.com:[^/]+\/[^/]+(?:\.git)?$/.test(remote)
    || /^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(remote)
    || /^ssh:\/\/git@github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(remote);
}
