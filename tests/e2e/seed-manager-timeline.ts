import { Database } from "bun:sqlite";
import { join } from "node:path";
import { applyMigrations } from "../../packages/daemon/src/migrations";

const dbPath = process.env.HELM_E2E_DB_PATH ?? join(process.cwd(), "tests/fixtures/helm-home/state/helm.db");

/** Seeds deterministic manager timeline rows for dashboard e2e assertions. */
function seedManagerTimeline(): void {
  const db = new Database(dbPath);
  applyMigrations(db);
  const now = {
    manager: "2026-05-04T00:00:00.000Z",
    source: "2026-05-04T00:00:01.000Z",
    target: "2026-05-04T00:00:02.000Z",
    createCall: "2026-05-04T00:00:03.000Z",
    passCall: "2026-05-04T00:00:04.000Z",
    childEvent: "2026-05-04T00:00:05.000Z",
    assistant: "2026-05-04T00:00:06.000Z",
    complete: "2026-05-04T00:00:07.000Z"
  };

  db.transaction(() => {
    for (const id of ["manager-e2e-timeline", "child-source-e2e", "child-target-e2e"]) {
      db.query("DELETE FROM session_events WHERE session_id = ?").run(id);
      db.query("DELETE FROM sessions WHERE id = ?").run(id);
    }

    insertSession(db, {
      id: "manager-e2e-timeline",
      repoName: "test-repo-1",
      agentName: "manager",
      branch: null,
      worktreePath: null,
      workspaceUri: null,
      parentSessionId: null,
      managerMode: "approval",
      status: "awaiting_input",
      lastAssistantMessage: "Reviewing child output now.",
      lastEventAt: now.complete,
      createdAt: now.manager,
      updatedAt: now.complete
    });
    insertSession(db, {
      id: "child-source-e2e",
      repoName: "test-repo-1",
      agentName: "codex",
      branch: "helm/child-source-e2e",
      worktreePath: "/tmp/helm-e2e/source",
      workspaceUri: "file:///tmp/helm-e2e/source",
      parentSessionId: "manager-e2e-timeline",
      managerMode: null,
      status: "awaiting_input",
      lastAssistantMessage: null,
      lastEventAt: null,
      createdAt: now.source,
      updatedAt: now.source
    });
    insertSession(db, {
      id: "child-target-e2e",
      repoName: "test-repo-1",
      agentName: "codex",
      branch: "helm/child-target-e2e",
      worktreePath: "/tmp/helm-e2e/target",
      workspaceUri: "file:///tmp/helm-e2e/target",
      parentSessionId: "manager-e2e-timeline",
      managerMode: null,
      status: "awaiting_input",
      lastAssistantMessage: null,
      lastEventAt: null,
      createdAt: now.target,
      updatedAt: now.target
    });

    insertEvent(db, "manager-e2e-timeline", "session_started", {
      kind: "session_started",
      sessionId: "manager-e2e-timeline",
      repo: "test-repo-1",
      branch: null,
      worktreePath: null
    }, now.manager);
    insertEvent(db, "manager-e2e-timeline", "tool_invocation", {
      kind: "tool_invocation",
      toolCallId: "call-create-e2e",
      toolName: "create_child_from_branch",
      arguments: {
        repo: "test-repo-1",
        agent: "codex",
        sourceBranch: "origin/main",
        newBranchName: "helm/e2e-child-branch",
        prompt: "Implement timeline e2e fixture."
      },
      status: "pending"
    }, now.createCall);
    insertEvent(db, "manager-e2e-timeline", "tool_invocation", {
      kind: "tool_invocation",
      toolCallId: "call-pass-e2e",
      toolName: "pass_file_content",
      arguments: {
        fromSessionId: "child-source-e2e",
        toSessionId: "child-target-e2e",
        path: "src/app.ts"
      },
      status: "pending"
    }, now.passCall);
    insertEvent(db, "manager-e2e-timeline", "child_event", {
      kind: "child_event",
      childKind: "awaiting_input",
      childId: "child-target-e2e"
    }, now.childEvent);
    insertEvent(db, "manager-e2e-timeline", "assistant_message", {
      kind: "assistant_message",
      text: "Reviewing child output now."
    }, now.assistant);
    insertEvent(db, "manager-e2e-timeline", "turn_complete", { kind: "turn_complete" }, now.complete);
  })();
  db.close();
}

type SeedSession = {
  id: string;
  repoName: string;
  agentName: string;
  branch: string | null;
  worktreePath: string | null;
  workspaceUri: string | null;
  parentSessionId: string | null;
  managerMode: string | null;
  status: string;
  lastAssistantMessage: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Inserts one deterministic session row. */
function insertSession(db: Database, session: SeedSession): void {
  db.query(`
    INSERT INTO sessions
      (id, repo_name, agent_name, branch, worktree_path, workspace_uri, parent_session_id, manager_mode, agent_thread_id, pid, status, last_assistant_message, last_event_at, pull_request_url, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?)
  `).run(
    session.id,
    session.repoName,
    session.agentName,
    session.branch,
    session.worktreePath,
    session.workspaceUri,
    session.parentSessionId,
    session.managerMode,
    session.status,
    session.lastAssistantMessage,
    session.lastEventAt,
    session.createdAt,
    session.updatedAt
  );
}

/** Inserts one deterministic timeline event row. */
function insertEvent(db: Database, sessionId: string, kind: string, payload: Record<string, unknown>, createdAt: string): void {
  db.query("INSERT INTO session_events (session_id, kind, payload, created_at) VALUES (?, ?, ?, ?)").run(
    sessionId,
    kind,
    JSON.stringify(payload),
    createdAt
  );
}

seedManagerTimeline();
