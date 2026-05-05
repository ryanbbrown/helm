import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("SessionManager resume", () => {
  test("rehydrates interrupted Codex sessions without spawning until a send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-resume-codex-"));
    const worktreePath = join(dir, "worktree");
    mkdirSync(worktreePath);
    const store = new Store(join(dir, "helm.db"));
    const now = new Date().toISOString();
    store.insertSession({
      id: "codex-session",
      repo_name: "fixture",
      agent_name: "codex",
      branch: "helm/codex-session",
      worktree_path: worktreePath,
      status: "created",
      created_at: now,
      updated_at: now
    });
    store.updateSession("codex-session", { status: "interrupted", agent_thread_id: "thread-1", pid: null });
    const manager = new SessionManager({
      config: {
        repos: [{ name: "fixture", path: dir, default_branch: "main" }],
        agents: [{ name: "codex", command: join(dir, "missing-codex"), args: [], headless_mode: "codex_exec" }]
      },
      store
    });

    const resumed = await manager.resume("codex-session");
    const resumedAgain = await manager.resume("codex-session");

    expect(resumed.status).toBe("awaiting_input");
    expect(resumedAgain.status).toBe("awaiting_input");
    expect(resumed.pid).toBeNull();
    expect(manager.listEvents("codex-session").at(-1)?.kind).toBe("session_resumed");
  });

  test("rehydrates interrupted Claude sessions without spawning until a send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-resume-claude-"));
    const worktreePath = join(dir, "worktree");
    mkdirSync(worktreePath);
    const store = new Store(join(dir, "helm.db"));
    const now = new Date().toISOString();
    store.insertSession({
      id: "claude-session",
      repo_name: "fixture",
      agent_name: "claude",
      branch: "helm/claude-session",
      worktree_path: worktreePath,
      status: "created",
      created_at: now,
      updated_at: now
    });
    store.updateSession("claude-session", { status: "interrupted", agent_thread_id: "claude-thread-1", pid: null });
    const manager = new SessionManager({
      config: {
        repos: [{ name: "fixture", path: dir, default_branch: "main" }],
        agents: [{ name: "claude", command: join(dir, "missing-claude"), args: [], headless_mode: "claude_stream_json" }]
      },
      store
    });

    const resumed = await manager.resume("claude-session");

    expect(resumed.status).toBe("awaiting_input");
    expect(resumed.pid).toBeNull();
    expect(manager.listEvents("claude-session").at(-1)?.kind).toBe("session_resumed");
  });

  test("rehydrates interrupted manager sessions from stored messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-resume-manager-"));
    const store = new Store(join(dir, "helm.db"));
    const now = new Date().toISOString();
    store.insertSession({
      id: "manager",
      repo_name: "fixture",
      agent_name: "manager",
      branch: null,
      worktree_path: null,
      workspace_uri: null,
      manager_mode: "approval",
      status: "interrupted",
      created_at: now,
      updated_at: now
    });
    store.insertManagerMessage("manager", { role: "system", content: "system" });
    const manager = new SessionManager({
      config: {
        repos: [{ name: "fixture", path: dir, default_branch: "main" }],
        agents: [{ name: "manager", command: "manager", args: [], headless_mode: "manager_loop", model: "test-model", api_key: "test-key" }]
      },
      store
    });

    const resumed = await manager.resume("manager");

    expect(resumed.status).toBe("awaiting_input");
    expect(resumed.pid).toBe(-1);
    expect(manager.listEvents("manager").at(-1)?.kind).toBe("session_resumed");
  });

  test("serializes concurrent resume calls for one manager session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-resume-manager-concurrent-"));
    const store = new Store(join(dir, "helm.db"));
    const now = new Date().toISOString();
    store.insertSession({
      id: "manager",
      repo_name: "fixture",
      agent_name: "manager",
      branch: null,
      worktree_path: null,
      workspace_uri: null,
      manager_mode: "approval",
      status: "interrupted",
      created_at: now,
      updated_at: now
    });
    store.insertManagerMessage("manager", { role: "system", content: "system" });
    const manager = new SessionManager({
      config: {
        repos: [{ name: "fixture", path: dir, default_branch: "main" }],
        agents: [{ name: "manager", command: "manager", args: [], headless_mode: "manager_loop", model: "test-model", api_key: "test-key" }]
      },
      store
    });

    const [first, second] = await Promise.all([manager.resume("manager"), manager.resume("manager")]);

    expect(first.status).toBe("awaiting_input");
    expect(second.status).toBe("awaiting_input");
    expect(manager.listEvents("manager").filter((event) => event.kind === "session_resumed")).toHaveLength(1);
  });

  test("rejects interrupted manager sessions without a persisted transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-resume-missing-manager-"));
    const store = new Store(join(dir, "helm.db"));
    const now = new Date().toISOString();
    store.insertSession({
      id: "manager",
      repo_name: "fixture",
      agent_name: "manager",
      branch: null,
      worktree_path: null,
      workspace_uri: null,
      manager_mode: "approval",
      status: "interrupted",
      created_at: now,
      updated_at: now
    });
    const manager = new SessionManager({
      config: {
        repos: [{ name: "fixture", path: dir, default_branch: "main" }],
        agents: [{ name: "manager", command: "manager", args: [], headless_mode: "manager_loop", model: "test-model", api_key: "test-key" }]
      },
      store
    });

    await expect(manager.resume("manager")).rejects.toThrow("missing_manager_transcript");
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
