CREATE TABLE IF NOT EXISTS conversation_states (
  discord_user_id TEXT PRIMARY KEY,
  channel_id TEXT,
  reply_cadence TEXT NOT NULL DEFAULT 'normal'
    CHECK (reply_cadence IN ('fast', 'normal', 'slow')),
  reply_delay_min_ms INTEGER NOT NULL DEFAULT 25000,
  reply_delay_max_ms INTEGER NOT NULL DEFAULT 160000,
  proactive_enabled INTEGER NOT NULL DEFAULT 1,
  proactive_interval_min_ms INTEGER NOT NULL DEFAULT 14400000,
  proactive_interval_max_ms INTEGER NOT NULL DEFAULT 36000000,
  last_user_message_at INTEGER,
  last_assistant_message_at INTEGER,
  next_proactive_at INTEGER,
  last_proactive_at INTEGER,
  cadence_reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_states_next_proactive
  ON conversation_states (proactive_enabled, next_proactive_at);
