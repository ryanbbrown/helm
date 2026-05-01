import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyMigrations } from "./migrations";

describe("migrations", () => {
  test("adds pull_request_url to existing version 1 databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-migrations-"));
    const db = new Database(join(dir, "helm.db"));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        repo_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        agent_thread_id TEXT,
        pid INTEGER,
        status TEXT NOT NULL,
        last_assistant_message TEXT,
        last_event_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');
    `);

    applyMigrations(db);

    const columns = db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map((row) => row.name);
    expect(columns).toContain("pull_request_url");
    expect(db.query<{ version: number }, []>("SELECT version FROM schema_migrations WHERE version = 2").get()?.version).toBe(2);
  });
});
