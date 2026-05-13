CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  channel_id TEXT,
  interaction_id TEXT,
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_date TEXT NOT NULL,
  date_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  discord_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_date TEXT NOT NULL,
  date_path TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_user_created
  ON memory_items (discord_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_user_date_path
  ON memory_items (discord_user_id, date_path);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_events_user_created
  ON memory_events (discord_user_id, created_at DESC);
