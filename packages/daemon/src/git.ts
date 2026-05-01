import { $ } from "bun";

/** Checks whether a path is a git work tree. */
export async function isGitRepository(path: string): Promise<boolean> {
  const result = await $`git -C ${path} rev-parse --is-inside-work-tree`.quiet().nothrow();
  return result.exitCode === 0 && result.stdout.toString().trim() === "true";
}

/** Fetches origin for a repository without changing the current checkout. */
export async function fetchOrigin(repoPath: string): Promise<void> {
  await $`git -C ${repoPath} fetch origin`.quiet();
}

/** Detects the default remote branch name for a repository. */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const result = await $`git -C ${repoPath} symbolic-ref --short refs/remotes/origin/HEAD`.quiet();
  return result.stdout.toString().trim().replace(/^origin\//, "");
}

/** Creates a named branch worktree from the remote default branch. */
export async function createWorktree(repoPath: string, branch: string, path: string, defaultBranch: string): Promise<void> {
  await $`git -C ${repoPath} worktree add -b ${branch} ${path} ${`origin/${defaultBranch}`}`.quiet();
}

/** Removes a worktree forcefully from its owning repository. */
export async function removeWorktree(repoPath: string, path: string): Promise<void> {
  await $`git -C ${repoPath} worktree remove --force ${path}`.quiet();
  await $`git -C ${repoPath} worktree prune`.quiet();
}

/** Deletes a local branch if it exists. */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await $`git -C ${repoPath} branch -D ${branch}`.quiet().nothrow();
}

/** Reads uncommitted changes in a worktree. */
export async function worktreeStatus(path: string): Promise<string> {
  const result = await $`git -C ${path} status --porcelain`.quiet();
  return result.stdout.toString().trim();
}

/** Reads commits reachable only from the session branch. */
export async function unsharedCommits(repoPath: string, branch: string): Promise<string> {
  const format = "%(refname)";
  const refsResult = await $`git -C ${repoPath} for-each-ref --format=${format} refs/heads refs/remotes`.quiet();
  const refs = refsResult.stdout
    .toString()
    .split("\n")
    .map((ref) => ref.trim())
    .filter((ref) => ref && ref !== `refs/heads/${branch}`);
  const result = refs.length === 0
    ? await $`git -C ${repoPath} log ${branch} --oneline`.quiet()
    : await $`git -C ${repoPath} log ${branch} --not ${refs} --oneline`.quiet();
  return result.stdout.toString().trim();
}
