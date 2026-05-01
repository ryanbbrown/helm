const [repoPath, branch = "helm/spike-1", worktreePath = "/tmp/helm-wt-1"] = Bun.argv.slice(2);

/** Runs the git worktree spike. */
async function main(): Promise<void> {
  if (!repoPath) {
    throw new Error("Usage: bun run spikes/worktree.ts <repo-path> [branch] [worktree-path]");
  }
  await Bun.$`git -C ${repoPath} fetch origin`;
  await Bun.$`git -C ${repoPath} worktree add -b ${branch} ${worktreePath} origin/main`;
  console.log(`created ${worktreePath}`);
  await Bun.$`git -C ${repoPath} worktree remove --force ${worktreePath}`;
  await Bun.$`git -C ${repoPath} branch -D ${branch}`.nothrow();
  console.log("removed");
}

await main();
