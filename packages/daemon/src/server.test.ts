import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { startServer } from "./server";
import { SessionManager } from "./session-manager";
import { Store } from "./store";
import type { HelmConfig } from "./config-loader";

const token = "test-token";

describe("daemon archive route", () => {
  test("refuses dirty archive without force and accepts JSON body force", async () => {
    const fixture = await createArchiveFixture("body-force");
    writeFileSync(join(fixture.worktreePath, "draft.md"), "uncommitted\n");
    const server = startServer(0, token, fixture.manager);
    try {
      const refused = await archive(server, fixture.sessionId);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "dirty_worktree" });

      const archived = await archive(server, fixture.sessionId, { body: JSON.stringify({ force: true }), headers: { "Content-Type": "application/json" } });
      expect(archived.status).toBe(200);
      expect((await archived.json()) as { status: string }).toMatchObject({ status: "archived" });
    } finally {
      server.stop(true);
    }
  });

  test("accepts legacy query string force", async () => {
    const fixture = await createArchiveFixture("query-force");
    writeFileSync(join(fixture.worktreePath, "draft.md"), "uncommitted\n");
    const server = startServer(0, token, fixture.manager);
    try {
      const archived = await archive(server, fixture.sessionId, { pathSuffix: "?force=1" });
      expect(archived.status).toBe(200);
      expect((await archived.json()) as { status: string }).toMatchObject({ status: "archived" });
    } finally {
      server.stop(true);
    }
  });
});

type ArchiveFixture = {
  manager: SessionManager;
  sessionId: string;
  worktreePath: string;
};

type ArchiveRequestOptions = {
  body?: BodyInit;
  headers?: HeadersInit;
  pathSuffix?: string;
};

/** Posts to the archive route on a test server. */
function archive(server: Bun.Server<unknown>, sessionId: string, options: ArchiveRequestOptions = {}): Promise<Response> {
  return fetch(`http://${server.hostname}:${server.port}/sessions/${sessionId}/archive${options.pathSuffix ?? ""}`, {
    body: options.body,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers
    },
    method: "POST"
  });
}

/** Creates a repo, dirty-able worktree, and session row for server archive tests. */
async function createArchiveFixture(name: string): Promise<ArchiveFixture> {
  const dir = mkdtempSync(join(tmpdir(), `helm-server-archive-${name}-`));
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
  return { manager: new SessionManager({ config, store }), sessionId, worktreePath };
}
