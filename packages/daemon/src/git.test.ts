import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { DIFF_FILE_COUNT_LIMIT, DIFF_FILE_SIZE_LIMIT } from "@helm/core";
import { gitDiff } from "./git";

describe("gitDiff", () => {
  test("returns final branch changes plus untracked files", async () => {
    const fixture = await createRemoteFixture("branch");
    writeFileSync(join(fixture.worktreePath, "committed.txt"), "committed\n");
    await $`git -C ${fixture.worktreePath} add committed.txt`.quiet();
    await $`git -C ${fixture.worktreePath} commit -m committed`.quiet();
    writeFileSync(join(fixture.worktreePath, "dirty.txt"), "dirty\n");
    writeFileSync(join(fixture.worktreePath, "untracked.txt"), "untracked\n");

    const diff = await gitDiff(fixture.worktreePath, {
      base: "branch",
      defaultBranch: "main",
      fileCountLimit: DIFF_FILE_COUNT_LIMIT,
      fileSizeLimit: DIFF_FILE_SIZE_LIMIT
    });

    const files = diff.files;
    expect(diff.totalFiles).toBe(3);
    expect(files.map((file) => file.path).sort()).toEqual(["committed.txt", "dirty.txt", "untracked.txt"]);
    expect(files.find((file) => file.path === "untracked.txt")?.patch).toContain("+++ b/untracked.txt");
  });

  test("returns only dirty and untracked files for uncommitted base", async () => {
    const fixture = await createRemoteFixture("uncommitted");
    writeFileSync(join(fixture.worktreePath, "committed.txt"), "committed\n");
    await $`git -C ${fixture.worktreePath} add committed.txt`.quiet();
    await $`git -C ${fixture.worktreePath} commit -m committed`.quiet();
    writeFileSync(join(fixture.worktreePath, "dirty.txt"), "dirty\n");
    writeFileSync(join(fixture.worktreePath, "untracked.txt"), "untracked\n");

    const diff = await gitDiff(fixture.worktreePath, {
      base: "uncommitted",
      defaultBranch: "main",
      fileCountLimit: DIFF_FILE_COUNT_LIMIT,
      fileSizeLimit: DIFF_FILE_SIZE_LIMIT
    });

    expect(diff.totalFiles).toBe(2);
    expect(diff.files.map((file) => file.path).sort()).toEqual(["dirty.txt", "untracked.txt"]);
  });

  test("detects copied files with old path metadata", async () => {
    const fixture = await createRemoteFixture("copy");
    await $`cp ${join(fixture.worktreePath, "README.md")} ${join(fixture.worktreePath, "README-copy.md")}`.quiet();
    await $`git -C ${fixture.worktreePath} add README-copy.md`.quiet();

    const diff = await gitDiff(fixture.worktreePath, {
      base: "branch",
      defaultBranch: "main",
      fileCountLimit: DIFF_FILE_COUNT_LIMIT,
      fileSizeLimit: DIFF_FILE_SIZE_LIMIT
    });

    expect(diff.files).toContainEqual(expect.objectContaining({
      path: "README-copy.md",
      oldPath: "README.md",
      status: "copied"
    }));
  });

  test("limits built file entries while reporting total file count", async () => {
    const fixture = await createRemoteFixture("limit");
    writeFileSync(join(fixture.worktreePath, "a.txt"), "a\n");
    writeFileSync(join(fixture.worktreePath, "b.txt"), "b\n");
    writeFileSync(join(fixture.worktreePath, "c.txt"), "c\n");

    const diff = await gitDiff(fixture.worktreePath, {
      base: "branch",
      defaultBranch: "main",
      fileCountLimit: 1,
      fileSizeLimit: DIFF_FILE_SIZE_LIMIT
    });

    expect(diff.totalFiles).toBe(3);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.patch).toBeTruthy();
  });
});

type RemoteFixture = {
  repoPath: string;
  worktreePath: string;
};

/** Creates a repository with an origin/main ref and a session worktree. */
async function createRemoteFixture(name: string): Promise<RemoteFixture> {
  const dir = mkdtempSync(join(tmpdir(), `helm-git-diff-${name}-`));
  const originPath = join(dir, "origin.git");
  const repoPath = join(dir, "repo");
  const worktreePath = join(dir, "worktree");
  await $`git init --bare ${originPath}`.quiet();
  await $`git clone ${originPath} ${repoPath}`.quiet();
  await $`git -C ${repoPath} switch -c main`.quiet();
  await $`git -C ${repoPath} config user.email helm@example.com`.quiet();
  await $`git -C ${repoPath} config user.name Helm`.quiet();
  writeFileSync(join(repoPath, "README.md"), "fixture\n");
  await $`git -C ${repoPath} add README.md`.quiet();
  await $`git -C ${repoPath} commit -m init`.quiet();
  await $`git -C ${repoPath} push -u origin main`.quiet();
  await $`git -C ${repoPath} worktree add -b helm/${name} ${worktreePath} origin/main`.quiet();
  await $`git -C ${worktreePath} config user.email helm@example.com`.quiet();
  await $`git -C ${worktreePath} config user.name Helm`.quiet();
  return { repoPath, worktreePath };
}
