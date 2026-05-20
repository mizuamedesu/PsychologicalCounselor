CREATE TABLE IF NOT EXISTS world_freezes (
  discord_user_id TEXT PRIMARY KEY,
  frozen INTEGER NOT NULL DEFAULT 0
    CHECK (frozen IN (0, 1)),
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
