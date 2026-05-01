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
