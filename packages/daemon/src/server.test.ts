import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { startServer } from "./server";
import { SessionManager } from "./session-manager";
import { Store } from "./store";
import type {
  WorkspaceCreateOptions,
  WorkspaceDiffOptions,
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspacePullRequestOptions,
  WorkspaceRemoveOptions,
  WorkspaceSafetyOptions,
  WorkspaceSessionOptions
} from "./workspace/types";
import type { HelmConfig } from "./config-loader";
import type { DiffResult, PullRequestResult, PublicSession } from "@helm/core";

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

describe("daemon diff route", () => {
  test("returns uncommitted diff JSON and refuses archived sessions", async () => {
    const fixture = await createArchiveFixture("diff");
    writeFileSync(join(fixture.worktreePath, "draft.md"), "uncommitted\n");
    const server = startServer(0, token, fixture.manager);
    try {
      const diff = await fetch(`http://${server.hostname}:${server.port}/sessions/${fixture.sessionId}/diff?base=uncommitted`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(diff.status).toBe(200);
      expect(await diff.json()).toMatchObject({
        base: "uncommitted",
        files: [{ path: "draft.md", status: "added" }],
        truncated: false
      });

      const invalid = await fetch(`http://${server.hostname}:${server.port}/sessions/${fixture.sessionId}/diff?base=bogus`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "invalid_base" });

      await archive(server, fixture.sessionId, { body: JSON.stringify({ force: true }), headers: { "Content-Type": "application/json" } });
      const archived = await fetch(`http://${server.hostname}:${server.port}/sessions/${fixture.sessionId}/diff`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(archived.status).toBe(410);
      expect(await archived.json()).toMatchObject({ code: "archived" });
    } finally {
      server.stop(true);
    }
  });
});

describe("daemon pull request route", () => {
  test("creates a pull request, persists the URL, and is idempotent", async () => {
    const fixture = createPullRequestFixture("pr-create");
    const server = startServer(0, token, fixture.manager);
    try {
      const first = await createPullRequest(server, fixture.sessionId, { title: "Review me", body: "Body" });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ pull_request_url: fixture.workspace.url });
      expect(fixture.workspace.createPullRequestCalls).toBe(1);
      expect(fixture.workspace.lastPullRequestOptions).toMatchObject({ title: "Review me", body: "Body" });
      expect(fixture.store.getSession(fixture.sessionId)?.pull_request_url).toBe(fixture.workspace.url);

      const second = await createPullRequest(server, fixture.sessionId, { title: "Again", body: "Again" });
      expect(second.status).toBe(200);
      expect((await second.json() as PublicSession).pull_request_url).toBe(fixture.workspace.url);
      expect(fixture.workspace.createPullRequestCalls).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("returns route errors for missing and archived sessions", async () => {
    const fixture = createPullRequestFixture("pr-archived", "archived");
    const server = startServer(0, token, fixture.manager);
    try {
      const missing = await createPullRequest(server, "missing", {});
      expect(missing.status).toBe(404);

      const archived = await createPullRequest(server, fixture.sessionId, {});
      expect(archived.status).toBe(409);
      expect(await archived.json()).toMatchObject({ code: "archived" });
      expect(fixture.workspace.createPullRequestCalls).toBe(0);
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

type PullRequestFixture = {
  manager: SessionManager;
  sessionId: string;
  store: Store;
  workspace: FakeWorkspaceProvider;
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

/** Posts to the pull request route on a test server. */
function createPullRequest(server: Bun.Server<unknown>, sessionId: string, body: { title?: string; body?: string }): Promise<Response> {
  return fetch(`http://${server.hostname}:${server.port}/sessions/${sessionId}/pull-request`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
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

/** Creates a session manager with a fake workspace provider for PR route tests. */
function createPullRequestFixture(name: string, status: "created" | "archived" = "created"): PullRequestFixture {
  const dir = mkdtempSync(join(tmpdir(), `helm-server-pr-${name}-`));
  const store = new Store(join(dir, "helm.db"));
  const workspace = new FakeWorkspaceProvider();
  const sessionId = `session-${name}`;
  const now = new Date().toISOString();
  store.insertSession({
    id: sessionId,
    repo_name: "fixture",
    agent_name: "codex",
    branch: `helm/${sessionId}`,
    worktree_path: join(dir, "worktree"),
    status,
    created_at: now,
    updated_at: now
  });
  const config: HelmConfig = {
    repos: [{ name: "fixture", path: join(dir, "repo"), default_branch: "main" }],
    agents: [{ name: "codex", command: "codex", args: [], headless_mode: "codex_exec" }]
  };
  return { manager: new SessionManager({ config, store, workspace }), sessionId, store, workspace };
}

class FakeWorkspaceProvider implements WorkspaceProvider {
  url = "https://github.com/example/repo/pull/1";
  createPullRequestCalls = 0;
  lastPullRequestOptions: WorkspacePullRequestOptions | null = null;

  /** Creates an unused fake workspace. */
  async create(_options: WorkspaceCreateOptions): Promise<WorkspaceHandle> {
    return { uri: "file:///tmp/fake", cwd: "/tmp/fake", branch: "helm/fake" };
  }

  /** Reconstructs a fake workspace from the session row. */
  fromSession({ session }: WorkspaceSessionOptions): WorkspaceHandle {
    return { uri: `file://${session.worktree_path}`, cwd: session.worktree_path, branch: session.branch };
  }

  /** Removes an unused fake workspace. */
  async remove(_handle: WorkspaceHandle, _options: WorkspaceRemoveOptions): Promise<void> {}

  /** Accepts fake workspace removal. */
  async assertRemoveSafe(_handle: WorkspaceHandle, _options: WorkspaceSafetyOptions): Promise<void> {}

  /** Returns an empty fake diff. */
  async diff(_handle: WorkspaceHandle, options: WorkspaceDiffOptions): Promise<DiffResult> {
    return {
      base: options.base,
      generatedAt: new Date().toISOString(),
      files: [],
      truncated: false,
      fileLimit: options.fileCountLimit,
      totalFiles: 0
    };
  }

  /** Records pull request creation and returns a fake URL. */
  async createPullRequest(_handle: WorkspaceHandle, options: WorkspacePullRequestOptions): Promise<PullRequestResult> {
    this.createPullRequestCalls += 1;
    this.lastPullRequestOptions = options;
    return { url: this.url };
  }
}
