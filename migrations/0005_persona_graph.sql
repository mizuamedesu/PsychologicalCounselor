CREATE TABLE IF NOT EXISTS persona_profiles (
  discord_user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'needs_seed'
    CHECK (status IN ('needs_seed', 'active')),
  display_name TEXT,
  seed_text TEXT,
  summary TEXT,
  style_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_expanded_at INTEGER,
  next_expand_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_persona_profiles_next_expand
  ON persona_profiles (status, next_expand_at);

CREATE TABLE IF NOT EXISTS persona_nodes (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_persona_nodes_user_type
  ON persona_nodes (discord_user_id, node_type);

CREATE TABLE IF NOT EXISTS persona_edges (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_persona_edges_source
  ON persona_edges (discord_user_id, source_id);

CREATE INDEX IF NOT EXISTS idx_persona_edges_target
  ON persona_edges (discord_user_id, target_id);

CREATE TABLE IF NOT EXISTS persona_events (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_persona_events_user_created
  ON persona_events (discord_user_id, created_at DESC);
