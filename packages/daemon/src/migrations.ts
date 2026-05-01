import type { Database } from "bun:sqlite";

const schemaVersion = 1;

type Migration = {
  version: number;
  apply: (db: Database) => void;
};

export const schemaSql = `
CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_session_events_session_id_id
  ON session_events(session_id, id);
`;

const migrationTableSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

const migrations: Migration[] = [];

/** Applies the current schema and all unapplied migrations. */
export function applyMigrations(db: Database): void {
  db.exec(schemaSql);
  db.exec(migrationTableSql);
  markApplied(db, schemaVersion);
  for (const migration of migrations) {
    if (!isApplied(db, migration.version)) {
      migration.apply(db);
      markApplied(db, migration.version);
    }
  }
}

/** Adds a column only when an existing table does not already have it. */
export function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Checks whether a table already has a column. */
function hasColumn(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

/** Checks whether a schema migration version has already run. */
function isApplied(db: Database, version: number): boolean {
  return Boolean(db.query<{ version: number }, [number]>("SELECT version FROM schema_migrations WHERE version = ?").get(version));
}

/** Records a schema migration version if it is not already recorded. */
function markApplied(db: Database, version: number): void {
  if (!isApplied(db, version)) {
    db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
  }
}
