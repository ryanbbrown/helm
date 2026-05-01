import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { Store } from "./store";
import { ArchiveSafetyError, SessionManager } from "./session-manager";
import type { HelmConfig } from "./config-loader";

describe("SessionManager archive safety", () => {
  test("refuses to archive a dirty worktree without force", async () => {
    const fixture = await createArchiveFixture("dirty");
    writeFileSync(join(fixture.worktreePath, "draft.md"), "uncommitted\n");

    await expect(fixture.manager.archive(fixture.sessionId)).rejects.toBeInstanceOf(ArchiveSafetyError);
    expect(fixture.manager.getRequired(fixture.sessionId).status).toBe("created");

    const archived = await fixture.manager.archive(fixture.sessionId, { force: true });
    expect(archived.status).toBe("archived");
  });

  test("refuses to archive unshared commits without force", async () => {
    const fixture = await createArchiveFixture("commit");
    writeFileSync(join(fixture.worktreePath, "finished.md"), "committed\n");
    await $`git -C ${fixture.worktreePath} add finished.md`.quiet();
    await $`git -C ${fixture.worktreePath} commit -m add-finished`.quiet();

    await expect(fixture.manager.archive(fixture.sessionId)).rejects.toBeInstanceOf(ArchiveSafetyError);
    expect(await branchExists(fixture.repoPath, fixture.branch)).toBe(true);

    const archived = await fixture.manager.archive(fixture.sessionId, { force: true });
    expect(archived.status).toBe("archived");
    expect(await branchExists(fixture.repoPath, fixture.branch)).toBe(false);
  });
});

type ArchiveFixture = {
  branch: string;
  manager: SessionManager;
  repoPath: string;
  sessionId: string;
  worktreePath: string;
};

/** Creates a repo, session row, and branch worktree for archive tests. */
async function createArchiveFixture(name: string): Promise<ArchiveFixture> {
  const dir = mkdtempSync(join(tmpdir(), `helm-archive-${name}-`));
  const repoPath = join(dir, "repo");
  const worktreePath = join(dir, "worktree");
  const sessionId = `session-${name}`;
  const branch = `helm/${sessionId}`;
  await $`git init -b main ${repoPath}`.quiet();
  await $`git -C ${repoPath} config user.email helm@example.com`.quiet();
  await $`git -C ${repoPath} config user.name Helm`.quiet();
  writeFileSync(join(repoPath, "README.md"), "fixture\n");
  await $`git -C ${repoPath} add README.md`.quiet();
  await $`git -C ${repoPath} commit -m init`.quiet();
  await $`git -C ${repoPath} worktree add -b ${branch} ${worktreePath} main`.quiet();

  const store = new Store(join(dir, "helm.db"));
  const now = new Date().toISOString();
  store.insertSession({
    id: sessionId,
    repo_name: "fixture",
    agent_name: "codex",
    branch,
    worktree_path: worktreePath,
    status: "created",
    created_at: now,
    updated_at: now
  });
  const config: HelmConfig = {
    repos: [{ name: "fixture", path: repoPath, default_branch: "main" }],
    agents: [{ name: "codex", command: "codex", args: [], headless_mode: "codex_exec" }]
  };
  return { branch, manager: new SessionManager({ config, store }), repoPath, sessionId, worktreePath };
}

/** Checks whether a local branch exists. */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const result = await $`git -C ${repoPath} rev-parse --verify ${branch}`.quiet().nothrow();
  return result.exitCode === 0;
}
