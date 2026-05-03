import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { Store } from "../store";
import { SessionManager } from "../session-manager";
import { executeManagerTool } from "./manager-tools";
import type { HelmConfig } from "../config-loader";

describe("manager tools", () => {
  test("rejects branch children when the requested new branch matches the source branch", async () => {
    const fixture = await createToolFixture("same-branch");
    const result = await executeManagerTool(
      "create_child_from_branch",
      { repo: "fixture", agent: "codex", sourceBranch: "helm/child", newBranchName: "helm/child", prompt: "inspect only" },
      fixture.ctx
    );

    expect(result).toMatchObject({ ok: false, errorMessage: "new_branch_matches_source_branch" });
  });

  test("reads child files inside the worktree and rejects traversal", async () => {
    const fixture = await createToolFixture("read-file");
    writeFileSync(join(fixture.worktreePath, "plan.md"), "PLAN\n");
    writeFileSync(join(fixture.outsidePath, "secret.txt"), "SECRET\n");
    symlinkSync(join(fixture.outsidePath, "secret.txt"), join(fixture.worktreePath, "secret-link"));

    const ok = await executeManagerTool("read_file", { sessionId: fixture.childId, path: "plan.md" }, fixture.ctx);
    expect(ok).toMatchObject({ ok: true, result: { content: "PLAN\n" } });

    await expect(executeManagerTool("read_file", { sessionId: fixture.childId, path: "../secret.txt" }, fixture.ctx)).resolves.toMatchObject({ ok: false, errorMessage: "path_traversal" });
    await expect(executeManagerTool("read_file", { sessionId: fixture.childId, path: join(fixture.outsidePath, "secret.txt") }, fixture.ctx)).resolves.toMatchObject({
      ok: false,
      errorMessage: "path_traversal"
    });
    await expect(executeManagerTool("read_file", { sessionId: fixture.childId, path: "secret-link" }, fixture.ctx)).resolves.toMatchObject({ ok: false, errorMessage: "path_traversal" });
  });

  test("reads compact child diffs through the workspace provider", async () => {
    const fixture = await createToolFixture("read-diff");
    await writeFile(join(fixture.worktreePath, "draft.md"), "diff body\n");

    const result = await executeManagerTool("read_diff", { sessionId: fixture.childId, base: "uncommitted" }, fixture.ctx);

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      base: "uncommitted",
      totalFiles: 1,
      files: [{ path: "draft.md", status: "added" }]
    });
  });
});

describe("manager sessions", () => {
  test("creates manager rows with null workspaces and enforces singleton", async () => {
    const fixture = await createToolFixture("manager-create", false);
    const manager = await fixture.manager.create({ repo: "fixture", agent: "manager" });

    expect(manager.worktree_path).toBeNull();
    expect(manager.workspace_uri).toBeNull();
    expect(manager.branch).toBeNull();
    expect(manager.manager_mode).toBe("approval");
    await expect(fixture.manager.create({ repo: "fixture", agent: "manager" })).rejects.toThrow("manager_exists");
  });
});

type ToolFixture = {
  childId: string;
  ctx: { manager: SessionManager; managerSessionId: string };
  manager: SessionManager;
  outsidePath: string;
  worktreePath: string;
};

/** Creates a temp repo and store with a manager-owned child row. */
async function createToolFixture(name: string, insertChild = true): Promise<ToolFixture> {
  const dir = await mkdtemp(join(tmpdir(), `helm-manager-tools-${name}-`));
  const repoPath = join(dir, "repo");
  const worktreePath = join(dir, "worktree");
  const outsidePath = join(dir, "outside");
  mkdirSync(outsidePath);
  await $`git init -b main ${repoPath}`.quiet();
  await $`git -C ${repoPath} config user.email helm@example.com`.quiet();
  await $`git -C ${repoPath} config user.name Helm`.quiet();
  writeFileSync(join(repoPath, "README.md"), "fixture\n");
  await $`git -C ${repoPath} add README.md`.quiet();
  await $`git -C ${repoPath} commit -m init`.quiet();
  await $`git -C ${repoPath} worktree add -b helm/child ${worktreePath} main`.quiet();

  const store = new Store(join(dir, "helm.db"));
  const now = new Date().toISOString();
  if (insertChild) {
    store.insertSession({
      id: "child",
      repo_name: "fixture",
      agent_name: "codex",
      branch: "helm/child",
      worktree_path: worktreePath,
      parent_session_id: "manager",
      status: "awaiting_input",
      created_at: now,
      updated_at: now
    });
  }
  const config: HelmConfig = {
    repos: [{ name: "fixture", path: repoPath, default_branch: "main" }],
    agents: [
      { name: "codex", command: "codex", args: [], headless_mode: "codex_exec" },
      { name: "manager", command: "manager", args: [], headless_mode: "manager_loop", model: "test-model", api_key_env: "OPENROUTER_API_KEY" }
    ]
  };
  const manager = new SessionManager({ config, store });
  return { childId: "child", ctx: { manager, managerSessionId: "manager" }, manager, outsidePath, worktreePath };
}
