import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../../../daemon/src/store";
import { resumeSession } from "./session-resume";

const previousHelmHome = Bun.env.HELM_HOME;
const previousHelmPort = Bun.env.HELM_PORT;

afterEach(() => {
  if (previousHelmHome === undefined) {
    delete Bun.env.HELM_HOME;
  } else {
    Bun.env.HELM_HOME = previousHelmHome;
  }
  if (previousHelmPort === undefined) {
    delete Bun.env.HELM_PORT;
  } else {
    Bun.env.HELM_PORT = previousHelmPort;
  }
});

describe("session resume command", () => {
  test("reconciles orphaned local sessions before resuming", async () => {
    const fixture = await createLocalResumeFixture();

    await resumeSession("manager");

    expect(fixture.store.getSession("manager")?.status).toBe("awaiting_input");
    expect(fixture.store.listEvents("manager").filter((event) => event.kind === "session_resumed")).toHaveLength(1);
  });
});

type LocalResumeFixture = {
  store: Store;
};

/** Creates a local HELM_HOME with a stale running manager session. */
async function createLocalResumeFixture(): Promise<LocalResumeFixture> {
  const dir = mkdtempSync(join(tmpdir(), "helm-cli-resume-"));
  Bun.env.HELM_HOME = dir;
  Bun.env.HELM_PORT = "65530";
  const configDir = join(dir, "config");
  const stateDir = join(dir, "state");
  const repoPath = join(dir, "repo");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  await $`git init -b main ${repoPath}`.quiet();
  await $`git -C ${repoPath} config user.email helm@example.com`.quiet();
  await $`git -C ${repoPath} config user.name Helm`.quiet();
  writeFileSync(join(repoPath, "README.md"), "fixture\n");
  await $`git -C ${repoPath} add README.md`.quiet();
  await $`git -C ${repoPath} commit -m init`.quiet();
  writeFileSync(join(configDir, "repos.json"), JSON.stringify({ repos: [{ name: "fixture", path: repoPath, default_branch: "main" }] }));
  writeFileSync(join(configDir, "agents.json"), JSON.stringify({
    agents: [{ name: "manager", command: "manager", args: [], headless_mode: "manager_loop", model: "test-model", api_key: "test-key" }]
  }));
  writeFileSync(join(stateDir, "token"), "unused-token");

  const store = new Store(join(stateDir, "helm.db"));
  const now = new Date().toISOString();
  store.insertSession({
    id: "manager",
    repo_name: "fixture",
    agent_name: "manager",
    branch: null,
    worktree_path: null,
    workspace_uri: null,
    manager_mode: "approval",
    status: "running",
    created_at: now,
    updated_at: now
  });
  store.insertManagerMessage("manager", { role: "system", content: "system" });
  return { store };
}
