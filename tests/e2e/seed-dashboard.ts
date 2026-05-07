import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyMigrations } from "../../packages/daemon/src/migrations";

const dbPath = process.env.HELM_E2E_DB_PATH ?? join(process.cwd(), "tests/fixtures/helm-home/state/helm.db");

if (Bun.argv[2] === "append-resume-event") {
  appendResumeEvent();
} else {
  seedDashboard();
}

/** Appends one late resume event for refresh backfill assertions. */
function appendResumeEvent(): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  applyMigrations(db);
  insertEvent(db, "dashboard-alpha", "session_resumed", { kind: "session_resumed", sessionId: "dashboard-alpha" }, "2026-05-04T00:10:04.000Z");
  db.close();
}

/** Seeds deterministic dashboard sessions for UI e2e assertions. */
function seedDashboard(): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  applyMigrations(db);
  db.transaction(() => {
    for (const id of ["dashboard-alpha", "dashboard-beta", "dashboard-gamma", "dashboard-interrupted"]) {
      db.query("DELETE FROM session_events WHERE session_id = ?").run(id);
      db.query("DELETE FROM sessions WHERE id = ?").run(id);
    }
    insertSession(db, {
      id: "dashboard-alpha",
      repoName: "test-repo-1",
      agentName: "codex",
      branch: "helm/dashboard-alpha",
      status: "awaiting_input",
      lastAssistantMessage: "Alpha session ready.",
      createdAt: "2026-05-04T00:10:00.000Z",
      updatedAt: "2026-05-04T00:10:03.000Z"
    });
    insertSession(db, {
      id: "dashboard-beta",
      repoName: "test-repo-2",
      agentName: "claude",
      branch: "helm/dashboard-beta",
      status: "stopped",
      lastAssistantMessage: "Beta session stopped.",
      createdAt: "2026-05-04T00:09:00.000Z",
      updatedAt: "2026-05-04T00:09:03.000Z"
    });
    insertSession(db, {
      id: "dashboard-gamma",
      repoName: "test-repo-1",
      agentName: "codex",
      branch: "helm/dashboard-gamma",
      status: "failed",
      lastAssistantMessage: null,
      createdAt: "2026-05-04T00:08:00.000Z",
      updatedAt: "2026-05-04T00:08:03.000Z"
    });
    insertSession(db, {
      id: "dashboard-interrupted",
      repoName: "test-repo-1",
      agentName: "codex",
      branch: "helm/dashboard-interrupted",
      status: "interrupted",
      lastAssistantMessage: "Interrupted session needs resume.",
      agentThreadId: "thread-dashboard-interrupted",
      createdAt: "2026-05-04T00:07:00.000Z",
      updatedAt: "2026-05-04T00:07:03.000Z"
    });
    insertEvent(db, "dashboard-alpha", "session_started", { kind: "session_started", sessionId: "dashboard-alpha", repo: "test-repo-1", branch: "helm/dashboard-alpha", worktreePath: "/tmp/alpha" }, "2026-05-04T00:10:00.000Z");
    insertEvent(db, "dashboard-alpha", "user_message", { kind: "user_message", text: "Implement alpha dashboard fixture." }, "2026-05-04T00:10:01.000Z");
    insertEvent(db, "dashboard-alpha", "assistant_message", { kind: "assistant_message", text: "Alpha session ready." }, "2026-05-04T00:10:02.000Z");
    insertEvent(db, "dashboard-alpha", "turn_complete", { kind: "turn_complete" }, "2026-05-04T00:10:03.000Z");
    insertEvent(db, "dashboard-gamma", "error", { kind: "error", message: "Gamma failed deterministically." }, "2026-05-04T00:08:03.000Z");
  })();
  db.close();
}

type SeedSession = {
  id: string;
  repoName: string;
  agentName: string;
  branch: string;
  status: string;
  lastAssistantMessage: string | null;
  agentThreadId?: string;
  createdAt: string;
  updatedAt: string;
};

/** Inserts one deterministic session row. */
function insertSession(db: Database, session: SeedSession): void {
  db.query(`
    INSERT INTO sessions
      (id, repo_name, agent_name, branch, worktree_path, workspace_uri, parent_session_id, manager_mode, agent_thread_id, pid, status, last_assistant_message, last_event_at, pull_request_url, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, NULL, ?, ?)
  `).run(
    session.id,
    session.repoName,
    session.agentName,
    session.branch,
    `/tmp/${session.id}`,
    `file:///tmp/${session.id}`,
    session.agentThreadId ?? null,
    session.status,
    session.lastAssistantMessage,
    session.updatedAt,
    session.createdAt,
    session.updatedAt
  );
}

/** Inserts one deterministic timeline event row. */
function insertEvent(db: Database, sessionId: string, kind: string, payload: Record<string, unknown>, createdAt: string): void {
  db.query("INSERT INTO session_events (session_id, kind, payload, created_at) VALUES (?, ?, ?, ?)").run(sessionId, kind, JSON.stringify(payload), createdAt);
}
