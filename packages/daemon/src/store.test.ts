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

  test("finds active managers and reconciles orphaned in-process sessions as interrupted", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-store-reconcile-"));
    const store = new Store(join(dir, "helm.db"));
    const now = new Date().toISOString();

    store.insertSession({
      id: "stopped-manager",
      repo_name: "fixture",
      agent_name: "manager",
      branch: null,
      worktree_path: null,
      workspace_uri: null,
      manager_mode: "approval",
      status: "stopped",
      created_at: now,
      updated_at: now
    });
    store.insertSession({
      id: "running-manager",
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

    expect(store.getActiveManagerSession()?.id).toBe("running-manager");
    store.reconcileInProcessSessions();

    expect(store.getSession("running-manager")?.status).toBe("interrupted");
    expect(store.getSession("stopped-manager")?.status).toBe("stopped");
    expect(store.getActiveManagerSession()?.id).toBe("running-manager");
  });

  test("repairs dangling manager tool-call messages on read", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-store-manager-messages-"));
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
    store.insertManagerMessage("manager", {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_diff", arguments: "{}" } },
        { id: "call-2", type: "function", function: { name: "read_file", arguments: "{}" } }
      ]
    });
    store.insertManagerMessage("manager", { role: "tool", tool_call_id: "call-1", content: JSON.stringify({ ok: true }) });

    const messages = store.listManagerMessages("manager");
    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call-2",
      content: JSON.stringify({ ok: false, errorMessage: "interrupted" })
    });
    store.insertManagerMessage("manager", { role: "user", content: "continue" });
    const persisted = store.listManagerMessages("manager");
    expect(persisted).toHaveLength(5);
    expect(persisted[3]).toEqual({
      role: "tool",
      tool_call_id: "call-2",
      content: JSON.stringify({ ok: false, errorMessage: "interrupted" })
    });
    expect(persisted[4]).toEqual({ role: "user", content: "continue" });
    expect(store.hasManagerMessages("manager")).toBe(true);
  });
});
