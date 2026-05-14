ALTER TABLE conversation_states ADD COLUMN active_until INTEGER;
ALTER TABLE conversation_states ADD COLUMN availability_mode TEXT DEFAULT 'normal';
ALTER TABLE conversation_states ADD COLUMN attention_score REAL DEFAULT 0.5;
ALTER TABLE conversation_states ADD COLUMN energy_score REAL DEFAULT 0.7;
ALTER TABLE conversation_states ADD COLUMN pending_reply_after INTEGER;
ALTER TABLE conversation_states ADD COLUMN pending_reply_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_states ADD COLUMN timing_reason TEXT;

CREATE TABLE IF NOT EXISTS dm_pending_messages (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_pending_message_unique
  ON dm_pending_messages (discord_user_id, message_id);

CREATE INDEX IF NOT EXISTS idx_dm_pending_user_channel_created
  ON dm_pending_messages (discord_user_id, channel_id, responded_at, created_at);

CREATE INDEX IF NOT EXISTS idx_conversation_states_pending_reply
  ON conversation_states (pending_reply_after);
