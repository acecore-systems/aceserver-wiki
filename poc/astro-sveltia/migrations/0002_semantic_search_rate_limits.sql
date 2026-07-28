CREATE TABLE IF NOT EXISTS semantic_search_rate_limits (
  limiter_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (limiter_key, window_start)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_semantic_search_rate_limits_expires_at
ON semantic_search_rate_limits (expires_at);
