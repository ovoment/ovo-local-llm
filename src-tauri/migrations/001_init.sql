-- Phase R · multi-session chat + context management
-- Frontend (tauri-plugin-sql) opens this DB at $APPDATA/chats.sqlite.
-- All timestamps are epoch milliseconds (INTEGER). Booleans are 0/1.

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  model_ref        TEXT,
  system_prompt    TEXT,
  compact_strategy TEXT NOT NULL DEFAULT 'auto' CHECK (compact_strategy IN ('auto', 'manual', 'warn_only')),
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  context_tokens   INTEGER NOT NULL DEFAULT 0,
  compacting       INTEGER NOT NULL DEFAULT 0 CHECK (compacting IN (0, 1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned  ON sessions(pinned DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role               TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'summary')),
  content            TEXT NOT NULL,
  attachments_json   TEXT,
  prompt_tokens      INTEGER,
  generation_tokens  INTEGER,
  compacted          INTEGER NOT NULL DEFAULT 0 CHECK (compacted IN (0, 1)),
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_live    ON messages(session_id, compacted, created_at ASC);

CREATE TABLE IF NOT EXISTS model_context_overrides (
  repo_id          TEXT PRIMARY KEY,
  max_context      INTEGER NOT NULL,
  warn_threshold   REAL NOT NULL DEFAULT 0.75,
  updated_at       INTEGER NOT NULL
);
