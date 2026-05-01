import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Store } from "./store";

describe("Store", () => {
  test("persists sessions and events with positional bindings", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-store-"));
    const store = new Store(join(dir, "helm.db"));
    const now = new Date().toISOString();

    store.insertSession({
      id: "session-1",
      repo_name: "test-repo-1",
      agent_name: "codex",
      branch: "helm/session-1",
      worktree_path: join(dir, "worktree"),
      status: "created",
      created_at: now,
      updated_at: now
    });
    store.updateSession("session-1", {
      status: "running",
      pid: 123,
      agent_thread_id: "thread-1"
    });
    store.appendEvent("session-1", {
      kind: "assistant_message",
      text: "hello"
    });

    const session = store.getSession("session-1");
    expect(session?.repo_name).toBe("test-repo-1");
    expect(session?.agent_name).toBe("codex");
    expect(session?.status).toBe("running");
    expect(session?.pid).toBe(123);
    expect(session?.agent_thread_id).toBe("thread-1");
    expect(session?.pull_request_url).toBeNull();
    expect(store.listEvents("session-1")[0]?.payload).toEqual({
      kind: "assistant_message",
      text: "hello"
    });
  });

  test("persists pull request URLs on existing session rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-store-pr-"));
    const store = new Store(join(dir, "helm.db"));
    const now = new Date().toISOString();

    store.insertSession({
      id: "session-1",
      repo_name: "test-repo-1",
      agent_name: "codex",
      branch: "helm/session-1",
      worktree_path: join(dir, "worktree"),
      status: "created",
      created_at: now,
      updated_at: now
    });
    store.updatePullRequestUrl("session-1", "https://github.com/example/repo/pull/1");

    expect(store.getSession("session-1")?.pull_request_url).toBe("https://github.com/example/repo/pull/1");
  });
});
