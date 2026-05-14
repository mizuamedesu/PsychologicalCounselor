CREATE TABLE IF NOT EXISTS bot_life_states (
  discord_user_id TEXT PRIMARY KEY,
  activity TEXT NOT NULL,
  activity_detail TEXT NOT NULL DEFAULT '',
  availability_mode TEXT NOT NULL DEFAULT 'normal',
  attention_score REAL NOT NULL DEFAULT 0.5,
  energy_score REAL NOT NULL DEFAULT 0.6,
  mood TEXT NOT NULL DEFAULT 'steady',
  started_at INTEGER NOT NULL,
  until_at INTEGER NOT NULL,
  last_tick_at INTEGER NOT NULL,
  next_tick_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_life_states_next_tick
  ON bot_life_states (next_tick_at);

CREATE TABLE IF NOT EXISTS bot_life_events (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_life_events_user_created
  ON bot_life_events (discord_user_id, created_at DESC);
