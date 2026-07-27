CREATE TABLE oidc_authorization_requests (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
  access_state TEXT NOT NULL CHECK (length(access_state) BETWEEN 16 AND 2048),
  access_redirect_uri TEXT NOT NULL,
  nonce TEXT,
  scope TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL CHECK (length(pkce_challenge) = 43),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX oidc_authorization_requests_expiry
  ON oidc_authorization_requests (expires_at);

CREATE TABLE oidc_authorization_codes (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  access_redirect_uri TEXT NOT NULL,
  nonce TEXT,
  scope TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL CHECK (length(pkce_challenge) = 43),
  discord_id TEXT NOT NULL,
  email TEXT NOT NULL,
  authenticated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX oidc_authorization_codes_expiry
  ON oidc_authorization_codes (expires_at);

CREATE TABLE oidc_rate_limits (
  bucket_hash TEXT NOT NULL CHECK (length(bucket_hash) = 64),
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_hash, window_start)
) STRICT, WITHOUT ROWID;

CREATE INDEX oidc_rate_limits_expiry ON oidc_rate_limits (expires_at);
