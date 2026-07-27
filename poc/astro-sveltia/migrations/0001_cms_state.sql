CREATE TABLE IF NOT EXISTS cms_bans (
  discord_id TEXT PRIMARY KEY
    CHECK (
      discord_id NOT GLOB '*[^0-9]*'
      AND length(discord_id) BETWEEN 17 AND 20
    ),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100)
);

CREATE TABLE IF NOT EXISTS cms_rate_limits (
  scope TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hit_count INTEGER NOT NULL CHECK (hit_count > 0),
  PRIMARY KEY (scope, actor_id, window_start)
);

CREATE INDEX IF NOT EXISTS cms_rate_limits_window_idx
  ON cms_rate_limits (window_start);

CREATE TABLE IF NOT EXISTS cms_mutation_rate_limits (
  scope TEXT NOT NULL CHECK (scope IN ('user', 'global')),
  actor_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  mutation_count INTEGER NOT NULL CHECK (mutation_count >= 0),
  addition_bytes INTEGER NOT NULL CHECK (addition_bytes >= 0),
  max_mutation_count INTEGER NOT NULL CHECK (max_mutation_count > 0),
  max_addition_bytes INTEGER NOT NULL CHECK (max_addition_bytes > 0),
  last_reservation_id TEXT NOT NULL,
  CHECK (mutation_count <= max_mutation_count),
  CHECK (addition_bytes <= max_addition_bytes),
  PRIMARY KEY (scope, actor_id, window_start)
);

CREATE INDEX IF NOT EXISTS cms_mutation_rate_limits_window_idx
  ON cms_mutation_rate_limits (window_start);

CREATE TABLE IF NOT EXISTS cms_mutations (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) = 64),
  actor_discord_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('processing', 'unknown', 'succeeded', 'failed')),
  response_json TEXT,
  http_status INTEGER,
  lease_expires_at INTEGER,
  publication_branch TEXT NOT NULL,
  commit_marker TEXT NOT NULL,
  expected_head_oid TEXT NOT NULL CHECK (length(expected_head_oid) = 40),
  commit_oid TEXT CHECK (commit_oid IS NULL OR length(commit_oid) = 40),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS cms_mutations_actor_idx
  ON cms_mutations (actor_discord_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cms_mutations_state_updated_at_idx
  ON cms_mutations (state, updated_at);

CREATE TABLE IF NOT EXISTS cms_audit_events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  actor_discord_id TEXT NOT NULL,
  discord_role_ids_json TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'mutation'),
  status TEXT NOT NULL
    CHECK (status IN ('attempted', 'unknown', 'succeeded', 'failed')),
  paths_json TEXT NOT NULL,
  branch TEXT,
  commit_oid TEXT,
  http_status INTEGER,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS cms_audit_events_actor_idx
  ON cms_audit_events (actor_discord_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS cms_audit_events_status_idx
  ON cms_audit_events (status, occurred_at DESC);
