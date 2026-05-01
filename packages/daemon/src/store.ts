import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { databasePath, type NormalizedEvent, type Session, type SessionEvent, type SessionStatus } from "@helm/core";
import { applyMigrations } from "./migrations";

type SessionRow = Omit<Session, "pid"> & { pid: number | null };
type EventRow = Omit<SessionEvent, "payload"> & { payload: string };

export type NewSession = Pick<Session, "id" | "repo_name" | "agent_name" | "branch" | "worktree_path" | "status" | "created_at" | "updated_at">;

export class Store {
  private db: Database;

  /** Opens the SQLite store and applies migrations. */
  constructor(path = databasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    applyMigrations(this.db);
  }

  /** Inserts a new session row. */
  insertSession(session: NewSession): void {
    this.db
      .query(
        `INSERT INTO sessions
         (id, repo_name, agent_name, branch, worktree_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.repo_name,
        session.agent_name,
        session.branch,
        session.worktree_path,
        session.status,
        session.created_at,
        session.updated_at
      );
  }

  /** Updates mutable session fields. */
  updateSession(id: string, patch: Partial<Pick<Session, "agent_thread_id" | "pid" | "status" | "last_assistant_message" | "last_event_at">>): void {
    this.updateSessionFields(id, patch);
  }

  /** Persists the GitHub pull request URL for a session. */
  updatePullRequestUrl(id: string, url: string): void {
    this.updateSessionFields(id, { pull_request_url: url });
  }

  /** Updates mutable session columns and bumps updated_at. */
  private updateSessionFields(id: string, patch: Partial<Pick<Session, "agent_thread_id" | "pid" | "status" | "last_assistant_message" | "last_event_at" | "pull_request_url">>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return;
    }
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.query(`UPDATE sessions SET ${assignments}, updated_at = ? WHERE id = ?`).run(
      ...entries.map(([, value]) => value),
      new Date().toISOString(),
      id
    );
  }

  /** Appends a normalized event to a session. */
  appendEvent(sessionId: string, event: NormalizedEvent): SessionEvent {
    const createdAt = new Date().toISOString();
    const result = this.db
      .query("INSERT INTO session_events (session_id, kind, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, event.kind, JSON.stringify(event), createdAt);
    const row = this.db.query<EventRow, [number]>("SELECT * FROM session_events WHERE id = ?").get(Number(result.lastInsertRowid));
    if (!row) {
      throw new Error("Failed to read inserted event");
    }
    return parseEvent(row);
  }

  /** Lists all non-archived sessions newest first. */
  listSessions(includeArchived = false): Session[] {
    const sql = includeArchived ? "SELECT * FROM sessions ORDER BY created_at DESC" : "SELECT * FROM sessions WHERE status != 'archived' ORDER BY created_at DESC";
    return this.db.query<SessionRow, []>(sql).all().map(parseSession);
  }

  /** Reads one session by id. */
  getSession(id: string): Session | null {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? parseSession(row) : null;
  }

  /** Reads events for a session after an optional event id. */
  listEvents(sessionId: string, afterId = 0): SessionEvent[] {
    return this.db
      .query<EventRow, [string, number]>("SELECT * FROM session_events WHERE session_id = ? AND id > ? ORDER BY id ASC")
      .all(sessionId, afterId)
      .map(parseEvent);
  }

  /** Reads every event after an optional event id. */
  listAllEvents(afterId = 0): SessionEvent[] {
    return this.db.query<EventRow, [number]>("SELECT * FROM session_events WHERE id > ? ORDER BY id ASC").all(afterId).map(parseEvent);
  }
}

/** Parses a persisted session row. */
function parseSession(row: SessionRow): Session {
  return row;
}

/** Parses a persisted event row. */
function parseEvent(row: EventRow): SessionEvent {
  return {
    ...row,
    payload: JSON.parse(row.payload) as NormalizedEvent
  };
}
