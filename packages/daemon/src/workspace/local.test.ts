import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { gitRefExists } from "../git";
import { isGitHubRemote, LocalWorktreeProvider } from "./local";

describe("isGitHubRemote", () => {
  test("accepts common GitHub remote formats", () => {
    expect(isGitHubRemote("git@github.com:owner/repo.git")).toBe(true);
    expect(isGitHubRemote("https://github.com/owner/repo.git")).toBe(true);
    expect(isGitHubRemote("ssh://git@github.com/owner/repo.git")).toBe(true);
  });

  test("rejects non-GitHub remotes", () => {
    expect(isGitHubRemote("git@gitlab.com:owner/repo.git")).toBe(false);
    expect(isGitHubRemote("https://example.com/owner/repo.git")).toBe(false);
  });
});

describe("LocalWorktreeProvider", () => {
  test("creates a review worktree from a source branch head", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-local-source-"));
    const originPath = join(dir, "origin.git");
    const repoPath = join(dir, "repo");
    await $`git init --bare ${originPath}`.quiet();
    await $`git clone ${originPath} ${repoPath}`.quiet();
    await $`git -C ${repoPath} checkout -b main`.quiet();
    await $`git -C ${repoPath} config user.email helm@example.com`.quiet();
    await $`git -C ${repoPath} config user.name Helm`.quiet();
    writeFileSync(join(repoPath, "README.md"), "main\n");
    await $`git -C ${repoPath} add README.md`.quiet();
    await $`git -C ${repoPath} commit -m init`.quiet();
    await $`git -C ${repoPath} push -u origin main`.quiet();
    await $`git -C ${repoPath} checkout -b agent/refactor-auth`.quiet();
    writeFileSync(join(repoPath, "auth.md"), "writer change\n");
    await $`git -C ${repoPath} add auth.md`.quiet();
    await $`git -C ${repoPath} commit -m auth-change`.quiet();

    const sessionId = `review-${Date.now()}`;
    const handle = await new LocalWorktreeProvider().create({
      repo: { name: `fixture-${sessionId}`, path: repoPath, default_branch: "main" },
      sessionId,
      branchName: "review/refactor-auth-1",
      sourceRef: "agent/refactor-auth"
    });

    expect(handle.kind).toBe("local");
    if (handle.kind !== "local") {
      throw new Error("Expected local workspace");
    }
    expect(handle.branch).toBe("review/refactor-auth-1");
    expect(existsSync(join(handle.cwd, "auth.md"))).toBe(true);
  });

  test("checks source refs before creating branch-based sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-ref-exists-"));
    await $`git init -b main ${dir}`.quiet();
    await $`git -C ${dir} config user.email helm@example.com`.quiet();
    await $`git -C ${dir} config user.name Helm`.quiet();
    writeFileSync(join(dir, "README.md"), "main\n");
    await $`git -C ${dir} add README.md`.quiet();
    await $`git -C ${dir} commit -m init`.quiet();
    await $`git -C ${dir} checkout -b agent/refactor-auth`.quiet();

    expect(await gitRefExists(dir, "agent/refactor-auth")).toBe(true);
    expect(await gitRefExists(dir, "missing/ref")).toBe(false);
  });
});
